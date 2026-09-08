// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/app-runtime-ipc.js — 受管 Node runtime 内连接宿主私有 IPC（connectAppRuntime）
//
// 契约（spec §7 + app-contract/runtime-client.d.ts）：宿主启动 runtime: "node" 时以
// stdio ["ignore","pipe","pipe","ipc"] 建立父进程拥有的 IPC 通道，并在父侧 handle
// "app.domain.call"。client 只有 tasks / models / network.fetch / close()——没有宿主
// cordis context、没有任意 bus、没有 runtime 管理、没有 provider 凭据；每条调用由持有
// fd 的父进程绑定到本 App。
//
// 解析顺序（为什么不是单纯 import）：
//   ① 官方 SDK：`await import("@hana/app-sdk")`——Node 的 ESM 解析从本入口文件向上找
//      node_modules，App 包内自带 node_modules/@hana/app-sdk 时命中（探针实证：0.930.1
//      宿主不向 runtime 注入 NODE_PATH/loader，argv 只有 [node, entry, ...args]，所以
//      SDK 必须在包内或依赖区内）；
//   ② 依赖区解析：dataDir/runtime/node_modules 内若安装了 @hana/app-sdk 也能命中
//      （createRequire 从 runtime 声明出发，宿主将来把 SDK 发到 registry 时即生效）；
//   ③ 内置实现：与 SDK dist/app-contract/runtime-client.js 同协议的最小客户端
//      （jsonrpc 2.0 over process.send + app.domain.call + http.body.read/cancel）。
// 三条路都在日志里如实标注（source 字段），不静默降级：宿主升级协议时先看日志再定。
//
// 关闭纪律（spec §7）：进程退出前 hana.close()；不要在拿到流式 Response 后立即 close
// （会取消仍在消费的流）。

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_PENDING = 128;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const HTTP_READ = "http.body.read";
const HTTP_CANCEL = "http.body.cancel";
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
const STREAM_READ_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkedJsonBytes(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    throw Object.assign(new Error("Managed runtime IPC message is not JSON serializable"), {
      code: "APP_RUNTIME_IPC_INVALID",
    });
  }
  if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) {
    throw Object.assign(new Error("Managed runtime IPC message exceeds the 32 MiB limit"), {
      code: "APP_RUNTIME_IPC_TOO_LARGE",
    });
  }
}

function restoreError(error) {
  const result = new Error(
    typeof error?.message === "string" ? error.message : "Managed runtime host call failed",
  );
  if (typeof error?.data?.name === "string") result.name = error.data.name;
  if (typeof error?.data?.code === "string") result.code = error.data.code;
  return result;
}

function isWireResponse(value) {
  return (
    isRecord(value) &&
    typeof value.status === "number" &&
    Array.isArray(value.headers) &&
    (typeof value.bodyBase64 === "string" || typeof value.bodyStreamId === "string")
  );
}

class RuntimeIpcClient {
  nextId = 1;
  clientId = randomUUID();
  pending = new Map();
  activeBodyIds = new Set();
  closed = false;
  onMessageBound = (message) => this.onMessage(message);
  onDisconnectBound = () => this.close("Managed runtime IPC disconnected");

  constructor() {
    if (typeof process.send !== "function") {
      throw Object.assign(
        new Error("connectAppRuntime() is available only inside a Node managed runtime"),
        { code: "APP_RUNTIME_IPC_UNAVAILABLE" },
      );
    }
    process.on("message", this.onMessageBound);
    process.once("disconnect", this.onDisconnectBound);
  }

  call(method, params, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, signal) {
    if (this.closed) return Promise.reject(new Error("Managed runtime IPC is closed"));
    if (this.pending.size >= MAX_PENDING) {
      return Promise.reject(
        Object.assign(new Error("Managed runtime IPC concurrency limit reached"), {
          code: "APP_RUNTIME_IPC_BUSY",
        }),
      );
    }
    const id = this.clientId + ":" + this.nextId++;
    const packet = { jsonrpc: "2.0", id, method, params };
    try {
      checkedJsonBytes(packet);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.signal?.removeEventListener("abort", pending.abort);
        reject(
          Object.assign(
            new Error("Managed runtime IPC " + method + " timed out after " + timeoutMs + "ms"),
            { code: "APP_RUNTIME_IPC_TIMEOUT" },
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.signal?.removeEventListener("abort", pending.abort);
        reject(
          Object.assign(new Error("Managed runtime IPC " + method + " was cancelled"), {
            code: "APP_RUNTIME_IPC_CANCELLED",
          }),
        );
      };
      this.pending.set(id, { resolve, reject, timer, signal, abort });
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      try {
        process.send?.(packet);
      } catch (error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (pending) {
          clearTimeout(pending.timer);
          pending.signal?.removeEventListener("abort", pending.abort);
        }
        reject(error);
      }
    });
  }

  registerBody(id) {
    this.activeBodyIds.add(id);
  }

  releaseBody(id, notifyHost) {
    if (!this.activeBodyIds.delete(id) || !notifyHost || this.closed) return;
    this.notify(HTTP_CANCEL, { id });
  }

  close(reason = "Managed runtime IPC closed") {
    if (this.closed) return;
    for (const id of [...this.activeBodyIds]) this.releaseBody(id, true);
    this.closed = true;
    process.off("message", this.onMessageBound);
    process.off("disconnect", this.onDisconnectBound);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.abort);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  onMessage(raw) {
    if (this.closed || !isRecord(raw) || raw.jsonrpc !== "2.0") return;
    try {
      checkedJsonBytes(raw);
    } catch {
      this.close("Managed runtime IPC received an invalid message");
      return;
    }
    if (typeof raw.id !== "string") return;
    const pending = this.pending.get(raw.id);
    if (!pending) return;
    this.pending.delete(raw.id);
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.abort);
    if (isRecord(raw.error)) {
      pending.reject(restoreError(raw.error));
      return;
    }
    pending.resolve(raw.result);
  }

  notify(method, params) {
    const packet = { jsonrpc: "2.0", method, params };
    try {
      checkedJsonBytes(packet);
      process.send?.(packet);
    } catch {
      /* 关闭路径尽力而为：不再抛出 */
    }
  }
}

function responseFromWire(client, wire) {
  if (!wire.bodyStreamId) {
    return new Response(wire.bodyBase64 ? Buffer.from(wire.bodyBase64, "base64") : null, {
      status: wire.status,
      statusText: wire.statusText,
      headers: [...wire.headers],
    });
  }
  let ended = false;
  let readAbort = null;
  const streamId = wire.bodyStreamId;
  client.registerBody(streamId);
  const body = new ReadableStream(
    {
      async pull(controller) {
        if (ended) return;
        try {
          readAbort = new AbortController();
          const next = await client.call(
            HTTP_READ,
            { id: streamId },
            STREAM_READ_TIMEOUT_MS,
            readAbort.signal,
          );
          readAbort = null;
          if (next.done === true) {
            ended = true;
            client.releaseBody(streamId, false);
            controller.close();
            return;
          }
          if (typeof next.bytes !== "string") {
            throw new Error("Invalid managed runtime HTTP stream chunk");
          }
          const bytes = Buffer.from(next.bytes, "base64");
          if (bytes.byteLength > 64 * 1024) {
            throw new Error("Managed runtime HTTP stream chunk exceeds 64 KiB");
          }
          controller.enqueue(bytes);
        } catch (error) {
          readAbort = null;
          ended = true;
          client.releaseBody(streamId, true);
          controller.error(error);
        }
      },
      cancel() {
        if (ended) return;
        ended = true;
        readAbort?.abort();
        client.releaseBody(streamId, true);
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: wire.status,
    statusText: wire.statusText,
    headers: [...wire.headers],
  });
}

/** 内置实现（与 SDK runtime-client 同协议；SDK 不可解析时的兜底）。 */
function connectInline() {
  const client = new RuntimeIpcClient();
  const call = (domain, method, args) =>
    client.call("app.domain.call", { domain, method, args });
  const response = async (domain, method, args) => {
    const result = await call(domain, method, args);
    if (!isWireResponse(result)) {
      throw new Error("Managed runtime " + domain + "." + method + " did not return an HTTP response");
    }
    return responseFromWire(client, result);
  };
  return {
    tasks: {
      create: (input) => call("tasks", "create", [input]),
      get: (taskId) => call("tasks", "get", [taskId]),
      list: () => call("tasks", "list", []),
      update: (taskId, patch) => call("tasks", "update", [taskId, patch]),
      complete: (taskId, result) => call("tasks", "complete", [taskId, result]),
      fail: (taskId, error) => call("tasks", "fail", [taskId, error]),
      cancel: (taskId, reason) => call("tasks", "cancel", [taskId, reason]),
      requestApproval: (input) => call("tasks", "requestApproval", [input]),
      respondApproval: (input) => call("tasks", "respondApproval", [input]),
      watch: (taskId) => response("tasks", "watch", [taskId]),
    },
    models: {
      list: () => call("models", "list", []),
      stream: (input) => response("models", "stream", [input]),
      cancel: (requestId) => call("models", "cancel", [requestId]),
    },
    network: { fetch: (url, init) => response("network", "fetch", [url, init]) },
    close: () => client.close(),
  };
}

async function importSdk(spec, log) {
  try {
    const mod = await import(/* webpackIgnore: true */ spec);
    if (typeof mod?.connectAppRuntime === "function") return mod;
  } catch (e) {
    log?.(1, "SDK 解析失败（" + spec + "）：" + (e?.message || e));
  }
  return null;
}

/**
 * 连接宿主私有 IPC。
 * opts: { depsRoot?, log? }——depsRoot = dataDir/runtime（解析 @hana/app-sdk 的兜底基点）。
 * 返回 { client, source: "sdk" | "sdk-deps" | "inline" }；不可用时抛（调用方决定是否降级）。
 */
export async function connectAppRuntime({ depsRoot, log } = {}) {
  const emit = (level, msg) => log?.(level, msg);
  const sdk = await importSdk("@hana/app-sdk", emit);
  if (sdk) {
    return { client: sdk.connectAppRuntime(), source: "sdk" };
  }
  if (depsRoot) {
    try {
      const req = createRequire(join(depsRoot, "package.json"));
      const resolved = req.resolve("@hana/app-sdk");
      const mod = await importSdk(pathToFileURL(resolved).href, emit);
      if (mod) return { client: mod.connectAppRuntime(), source: "sdk-deps" };
    } catch (e) {
      emit(1, "依赖区 SDK 解析失败：" + (e?.message || e));
    }
  }
  return { client: connectInline(), source: "inline" };
}
