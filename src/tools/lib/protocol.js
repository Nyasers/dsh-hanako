// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/protocol.js — dsh web /api 网关协议层共用模块（lib 提取）
// 从 tools/dsh-run.js 剥离的协议/纯函数：总线 RPC 客户端（指令面收敛进 dshana.bus）、
// HTTP RPC 兜底、事件流（WS mux）、文本提取。dsh-run.js 与 dsh-session.js 静态 import。
//
// 归类说明：callUnary / callUnaryBus / nextRpcId / openMux 是 dsh web host /api 网关的
// 传输协议（Unary RPC + WebSocket 事件流）。v0.23.x 起 Unary RPC 指令面（session.create /
// prompt / selectModel / cancel + respond 审批应答）经 dshana.bus 总线收发（callUnaryBus，
// 总线优先、HTTP 兜底）；events.mux 事件流保持直连（流式高吞吐 + 实时审批帧不适合事件
// 通道，见收敛边界注释）。textFromChunk / textFromMessageBlocks 是同一网关事件帧的
// 文本提取面（assistant/chunk、assistant/message 的载荷提取）。两者同属"与 dsh web
// 通信的线上协议"一条线，收敛在一个 protocol.js 里（若拆 format.js 反而让 callUnary
// 与它消费的事件帧解析分处两文件，语义更散）。
//
// 消费方：tools/dsh-run.js submitTask（事件循环 / session.create / session.prompt /
// session.selectModel / session.cancel 全经此层）+ tools/dsh-cancel.js / tools/dsh-approve.js
// （callUnaryBus）+ tools/dsh-session.js（get 模式 textFromMessageBlocks 提取会话最终结论）。
// routes/card.js 另有一份独立 openMux 事件流实现，但它不 import 本模块（是独立实现，
// 见 dsh-run.js 头注释），不在此归并。

import { getSingleton } from "./state.js";

// ---- HTTP RPC 客户端（dsh web /api 网关，fetch 载波）----
// Unary：POST /api/<method>，body = { type:"client-request", rpcId, method, payload }
// 响应 ServerResponse：rpcId 回显 + result.ok/value 或 result.ok=false + error。
function nextRpcId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function callUnary(base, method, payload, signal, meta) {
  const rpcId = nextRpcId();
  const res = await fetch(`${base}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
    signal,
  });
  if (!res.ok) throw new Error(`dsh /api/${method} HTTP ${res.status}`);
  const full = await res.json();
  if (!full || full.rpcId !== rpcId)
    throw new Error(`dsh /api/${method} rpcId 不匹配`);
  if (!full.result || !full.result.ok) {
    const e = full.result?.error || {};
    throw new Error(
      `dsh ${method} 失败：${e.code || "unknown"} ${e.message || ""}`,
    );
  }
  // meta.rpcId 回传：会话 jsonl 的 user/message 事件 data.source.rpcId 与此相同，
  // 供 op 快照记录后用 sessionId+rpcId 从 jsonl 精确恢复（重启不丢、零映射文件）
  if (meta && typeof meta === "object") meta.rpcId = rpcId;
  return full.result.value;
}

// ---- 总线 RPC（dshana.bus，Unary RPC 指令面收敛）----
// v0.23.x 起 Unary RPC 指令面（session.create / prompt / selectModel / cancel + respond 审批
// 应答）经 dshana.bus 总线收发：宿主 emit rpc.request（payload = { reqId, method, payload }），
// dsh 进程内 @dsh-hanako/bridge 翻译器自环调 /api/<method> 后回投 rpc.result（payload =
// { reqId, ok, value? } 或 { reqId, ok:false, error }），宿主按 reqId 配对等待。
// 总线优先、HTTP 兜底：总线未连接（emit 返回 false 或 dshanaBus 未就绪）时降级回退
// callUnary（HTTP），保可用性并 appendLog 记录降级（events.mux 事件流仍直连，不进总线）。
// 收敛边界：数据面（events.mux 流式 chunk/审批帧/终态）与 /api/host.describe 就绪探测
// （发生在 connectBus 之前的鸡生蛋）保留 HTTP 直连，见 lifecycle.js 注释。
const BUS_RPC_TIMEOUT_MS = 60000; // 总线 RPC 默认超时（响应丢失/桥接异常兜底，防 pending 挂死）

// callUnaryBus 的 pending 表（reqId → { resolve, reject, timer, method }）与 rpc.result
// 订阅（模块级惰性接线一次，宿主侧 bus.js 的 on 是裸 EventEmitter 分发，无 ch: 前缀）
const rpcPending = new Map();
let rpcResultWired = false;

function wireRpcResult() {
  if (rpcResultWired) return;
  const g = getSingleton();
  const bus = g?.dshanaBus;
  if (!bus || typeof bus.on !== "function") return;
  rpcResultWired = true;
  bus.on("rpc.result", (payload) => {
    if (!payload || typeof payload !== "object" || typeof payload.reqId !== "string") return;
    const entry = rpcPending.get(payload.reqId);
    if (!entry) return; // 未知 reqId（已超时清理/垃圾帧）：忽略
    // 清理（clearTimeout/delete/移除 abort 监听）统一在 settle 内做——
    // 不能在 resolve/reject 前先 delete，否则 settle 的 pending 校验会误判已 settle 而跳过。
    if (payload.ok) {
      // meta.rpcId 回传与 callUnary 同语义：会话 jsonl data.source.rpcId == reqId
      if (entry.meta && typeof entry.meta === "object") entry.meta.rpcId = payload.reqId;
      entry.resolve(payload.value);
    } else {
      const e = payload.error || {};
      entry.reject(
        new Error("dsh " + entry.method + " 失败：" + (e.code || "unknown") + " " + (e.message || "")),
      );
    }
  });
}

// 降级路径的 base 来源：web host 单例（调用方通常已 ensureWebHost / hostBase 校验就绪）
function rpcBusBase(g) {
  const web = g?.web;
  if (web?.ready && web.port) return "http://127.0.0.1:" + web.port;
  throw new Error("DSH web host 未就绪（callUnaryBus 降级路径）");
}

// 总线 Unary RPC：method/payload 同 callUnary；signal 支持中止（总线路径下
// AbortError 语义与 fetch 一致）；meta 成功时回传 rpcId（与 callUnary 同）。
async function callUnaryBus(method, payload, signal, meta) {
  const reqId = nextRpcId();
  const g = getSingleton();
  const bus = g?.dshanaBus;
  // 总线优先：dshanaBus 就绪且 emit 送达（bus.js sendFrame 排队成功才 true——
  // 未连接/未握手返回 false）才走总线；否则降级 HTTP 兜底（保可用性）。
  let queued = false;
  if (bus && typeof bus.emit === "function") {
    try {
      wireRpcResult(); // 先接线再发（响应经 WS 异步到达，接线必先于回投）
      queued = bus.emit("rpc.request", { reqId, method, payload });
    } catch {
      queued = false;
    }
  }
  if (!queued) {
    // 降级路径：总线未连接/未握手 → 回退现 callUnary（HTTP），错误语义与直连一致
    try {
      g?.appendLog?.(
        "hana",
        "[dshana.bus] rpc.request 未送达（总线未连接），" + method + " 降级走 HTTP",
      );
    } catch {
      /* 日志失败不阻断 */
    }
    return callUnary(rpcBusBase(g), method, payload, signal, meta);
  }
  // 总线路径：pending 配对等待 rpc.result（超时/中止清理防泄漏）
  return new Promise((resolve, reject) => {
    const settle = (fn, value) => {
      if (rpcPending.get(reqId) !== entry) return; // 已 settle：忽略迟到事件
      clearTimeout(entry.timer);
      rpcPending.delete(reqId);
      signal?.removeEventListener("abort", onAbort);
      fn(value);
    };
    const onAbort = () => {
      settle(
        reject,
        Object.assign(new Error("已取消"), { name: "AbortError" }),
      );
    };
    const entry = {
      method,
      meta,
      resolve: (value) => settle(resolve, value),
      reject: (err) => settle(reject, err),
      timer: null,
    };
    entry.timer = setTimeout(() => {
      settle(
        reject,
        new Error("dsh " + method + " 总线 RPC 超时（" + BUS_RPC_TIMEOUT_MS / 1000 + "s）"),
      );
    }, BUS_RPC_TIMEOUT_MS);
    entry.timer.unref?.();
    rpcPending.set(reqId, entry);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---- 事件流（/api/events.mux，WebSocket 通道）----
// dsh 的事件流要求 WebSocket 升级（GET 返回 426 Upgrade Required，浏览器 UI 即走 WS）。
// Node 24 内置全局 WebSocket；帧为 JSON，payload 即 MuxFrame。
async function* openMux(base, signal) {
  if (typeof WebSocket !== "function") {
    throw new Error("宿主环境无全局 WebSocket，无法订阅 DSH 事件流");
  }
  const url = base.replace(/^http/, "ws") + "/api/events.mux";
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  let wsError = null;
  let wsClosed = false;
  ws.onmessage = (ev) => {
    let frame = {};
    let envelope = null;
    try {
      envelope = JSON.parse(ev.data);
      frame = envelope?.payload || envelope || {};
    } catch {
      return;
    }
    // server-request 信封（approval/requested 等应答类帧）：外层 rpcId 补进 frame——
    // dsh web host 的 /api/respond 靠 client-response 信封的 rpcId 路由 pending 表，
    // 审批帧的 rpcId 只在外层，只取 payload 会丢（审批应答就断链）。
    if (
      envelope &&
      typeof envelope === "object" &&
      typeof envelope.rpcId === "string" &&
      typeof frame.rpcId !== "string"
    ) {
      frame.rpcId = envelope.rpcId;
    }
    if (!frame || typeof frame.type !== "string") return;
    if (waiters.length) waiters.shift()(frame);
    else queue.push(frame);
  };
  ws.onerror = () => {
    wsError = new Error("dsh events.mux WebSocket 错误");
  };
  ws.onclose = () => {
    wsClosed = true;
    while (waiters.length) waiters.shift()(null);
  };
  if (signal?.aborted) {
    try {
      ws.close();
    } catch {}
    throw Object.assign(new Error("dsh_run 已取消"), { code: "DSH_ABORTED" });
  }
  const onAbort = () => {
    try {
      ws.close();
    } catch {}
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(wsError || new Error("dsh events.mux 连接失败"));
  });
  try {
    while (true) {
      if (queue.length) {
        yield queue.shift();
        continue;
      }
      if (wsError) throw wsError;
      if (wsClosed) return;
      const frame = await new Promise((resolve) => waiters.push(resolve));
      if (frame === null) return;
      yield frame;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

// 从 assistant/chunk 提取文本增量（宽松：delta/block 里任何 {type:"text",text} 都收）
function textFromChunk(chunk) {
  if (!chunk || typeof chunk !== "object") return "";
  const c = chunk.chunk || chunk;
  const t = c?.delta?.text ?? c?.block?.text ?? c?.text;
  return typeof t === "string" ? t : "";
}

// 从 assistant/message 提取文本（content block 数组里 type==="text" 的 text 拼接）
function textFromMessageBlocks(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

export {
  nextRpcId,
  callUnary,
  callUnaryBus,
  openMux,
  textFromChunk,
  textFromMessageBlocks,
};
