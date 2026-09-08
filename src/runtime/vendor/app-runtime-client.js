// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 deepseek / Hana App SDK authors — vendored source.
//
// @hana/app-sdk 0.930.0（宿主 0.930.1 自带）→ dist/app-contract/runtime-client.js 的运行时
// 实现原样引入（含源文件头注释压缩形态；仅移除 sourceMappingURL 行）。Apache-2.0 许可，
// 版权与许可文本见仓库 NOTICE（vendored components 段），勿改动 IPC 协议语义——宿主侧按
// 此协议应答（process.send JSON-RPC over 父进程 IPC fd，见迁移指南 §7 / SDK runtime.d.ts）。
//
// 为什么随包 vendor 而不是依赖 @hana/app-sdk 包：受管 runtime 子进程（entry = App 安装目录
// 内 runtime/dsh-host.mjs）在运行时只能解析 App 自带路径（dataDir 依赖区与安装目录），不保证
// 能解析到宿主 node_modules 的 @hana/app-sdk；且该 client 仅 import node:crypto，单文件即完整
// 实现（tasks/models/network.fetch/close，无流式响应不得提前 close——消费完流才可 close()）。
// 打包时经 rspack 打进 dist/runtime/dsh-host.mjs（见 src/runtime/rspack.config.mjs）。

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
    }
    catch {
        throw Object.assign(new Error("Managed runtime IPC message is not JSON serializable"), { code: "APP_RUNTIME_IPC_INVALID" });
    }
    if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) {
        throw Object.assign(new Error("Managed runtime IPC message exceeds the 32 MiB limit"), { code: "APP_RUNTIME_IPC_TOO_LARGE" });
    }
}
function restoreError(error) {
    const result = new Error(typeof error.message === "string" ? error.message : "Managed runtime host call failed");
    if (typeof error.data?.name === "string")
        result.name = error.data.name;
    if (typeof error.data?.code === "string")
        result.code = error.data.code;
    return result;
}
function isWireResponse(value) {
    return isRecord(value)
        && typeof value.status === "number"
        && Array.isArray(value.headers)
        && (typeof value.bodyBase64 === "string" || typeof value.bodyStreamId === "string");
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
            throw Object.assign(new Error("connectAppRuntime() is available only inside a Node managed runtime"), { code: "APP_RUNTIME_IPC_UNAVAILABLE" });
        }
        process.on("message", this.onMessageBound);
        process.once("disconnect", this.onDisconnectBound);
    }
    call(method, params, timeoutMs = DEFAULT_CALL_TIMEOUT_MS, signal) {
        if (this.closed)
            return Promise.reject(new Error("Managed runtime IPC is closed"));
        if (this.pending.size >= MAX_PENDING) {
            return Promise.reject(Object.assign(new Error("Managed runtime IPC concurrency limit reached"), { code: "APP_RUNTIME_IPC_BUSY" }));
        }
        const id = `${this.clientId}:${this.nextId++}`;
        const packet = { jsonrpc: "2.0", id, method, params };
        try {
            checkedJsonBytes(packet);
        }
        catch (error) {
            return Promise.reject(error);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this.pending.get(id);
                this.pending.delete(id);
                pending?.signal?.removeEventListener("abort", pending.abort);
                reject(Object.assign(new Error(`Managed runtime IPC ${method} timed out after ${timeoutMs}ms`), { code: "APP_RUNTIME_IPC_TIMEOUT" }));
            }, timeoutMs);
            timer.unref?.();
            const abort = () => {
                const pending = this.pending.get(id);
                if (!pending)
                    return;
                this.pending.delete(id);
                clearTimeout(pending.timer);
                pending.signal?.removeEventListener("abort", pending.abort);
                reject(Object.assign(new Error(`Managed runtime IPC ${method} was cancelled`), { code: "APP_RUNTIME_IPC_CANCELLED" }));
            };
            this.pending.set(id, { resolve, reject, timer, signal, abort });
            if (signal?.aborted) {
                abort();
                return;
            }
            signal?.addEventListener("abort", abort, { once: true });
            try {
                process.send?.(packet);
            }
            catch (error) {
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
    registerBody(id) { this.activeBodyIds.add(id); }
    releaseBody(id, notifyHost) {
        if (!this.activeBodyIds.delete(id) || !notifyHost || this.closed)
            return;
        this.notify(HTTP_CANCEL, { id });
    }
    close(reason = "Managed runtime IPC closed") {
        if (this.closed)
            return;
        // Send cancellation notifications while the fd is still usable; these do
        // not create pending replies and therefore cannot hold shutdown open.
        for (const id of [...this.activeBodyIds])
            this.releaseBody(id, true);
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
        if (this.closed || !isRecord(raw) || raw.jsonrpc !== "2.0")
            return;
        try {
            checkedJsonBytes(raw);
        }
        catch {
            this.close("Managed runtime IPC received an invalid message");
            return;
        }
        if (typeof raw.id !== "string")
            return;
        const pending = this.pending.get(raw.id);
        if (!pending)
            return;
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
        }
        catch {
            // Shutdown must not leave a local exception after best-effort cleanup.
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
    const body = new ReadableStream({
        async pull(controller) {
            if (ended)
                return;
            try {
                readAbort = new AbortController();
                const next = await client.call(HTTP_READ, { id: streamId }, STREAM_READ_TIMEOUT_MS, readAbort.signal);
                readAbort = null;
                if (next.done === true) {
                    ended = true;
                    client.releaseBody(streamId, false);
                    controller.close();
                    return;
                }
                if (typeof next.bytes !== "string")
                    throw new Error("Invalid managed runtime HTTP stream chunk");
                const bytes = Buffer.from(next.bytes, "base64");
                if (bytes.byteLength > 64 * 1024)
                    throw new Error("Managed runtime HTTP stream chunk exceeds 64 KiB");
                controller.enqueue(bytes);
            }
            catch (error) {
                readAbort = null;
                ended = true;
                client.releaseBody(streamId, true);
                controller.error(error);
            }
        },
        async cancel() {
            if (ended)
                return;
            ended = true;
            readAbort?.abort();
            client.releaseBody(streamId, true);
        },
    }, { highWaterMark: 0 });
    return new Response(body, { status: wire.status, statusText: wire.statusText, headers: [...wire.headers] });
}
/** Connect to the parent-owned IPC channel from inside `runtime: "node"` only. */
export function connectAppRuntime() {
    const client = new RuntimeIpcClient();
    const call = (domain, method, args) => client.call("app.domain.call", { domain, method, args });
    const response = async (domain, method, args) => {
        const result = await call(domain, method, args);
        if (!isWireResponse(result))
            throw new Error(`Managed runtime ${domain}.${method} did not return an HTTP response`);
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
