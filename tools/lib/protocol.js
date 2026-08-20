// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/protocol.js — dsh web /api 网关协议层共用模块（lib 提取）
// 从 tools/dsh-run.js 剥离的纯协议/纯函数：HTTP RPC 客户端、事件流（WS mux）、文本
// 提取与回调摘要构建。全部零宿主状态（不碰 globalThis 单例），dsh-run.js 静态 import。
//
// 归类说明：callUnary / nextRpcId / openMux 是 dsh web host /api 网关的传输协议（Unary
// RPC + WebSocket 事件流）；textFromChunk / textFromMessageBlocks / buildSummary 是同一
// 网关事件帧的文本/摘要格式化面（assistant/chunk、assistant/message 的载荷提取与 PTC
// 式回调压缩）。两者同属"与 dsh web 通信的线上协议"一条线，收敛在一个 protocol.js 里
// （若拆 format.js 反而让 callUnary 与它消费的事件帧解析分处两文件，语义更散）。
//
// 消费方：tools/dsh-run.js submitTask（事件循环 / session.create / session.prompt /
// session.selectModel / session.cancel 全经此层）。routes/card.js 另有一份独立 openMux
// 事件流实现，但它不 import 本模块（是独立实现，见 dsh-run.js 头注释），不在此归并。

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

// ---- 事件流（/api/events.mux，WebSocket 通道）----
// dsh 的事件流要求 WebSocket 升级（GET 返回 426 Upgrade Required，浏览器 UI 即走 WS）。
// Node 24 内置全局 WebSocket；帧为 JSON，payload 即 MuxFrame。
async function* openMux(base, signal) {
  if (typeof WebSocket !== "function") {
    throw new Error("宿主环境无全局 WebSocket，无法订阅 dsh 事件流");
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

// ---- 回调摘要构建（PTC 式压缩：中间步骤不进 Agent 上下文）----
// 参考 dsh PTC 模式（Code Mode SDK：一次程序执行替代多次工具往返）的思路：
// 中间过程是噪音，最终结论才是信号。完整输出保留在 op 快照（卡片可查）
// 与 dsh web UI（sessionId 定位），回调只带最终结论摘要。
// 摘要锚点：最后一条 assistant/message 的文本，即 dsh 对任务的最终汇报。
const SUMMARY_HEAD = 1500;
const SUMMARY_TAIL = 600;

function buildSummary(output, finalText) {
  const full = String(output ?? "");
  const candidate = String(finalText ?? "").trim();
  if (candidate) {
    return {
      text: candidate,
      summaryOf: "final-message",
      fullLength: full.length,
    };
  }
  if (full.length > SUMMARY_HEAD + SUMMARY_TAIL) {
    const hidden = full.length - SUMMARY_HEAD - SUMMARY_TAIL;
    return {
      text: `${full.slice(0, SUMMARY_HEAD)}\n\n…[中间过程 ${hidden} 字符已折叠，完整输出见 op 快照 / dsh web UI]…\n\n${full.slice(-SUMMARY_TAIL)}`,
      summaryOf: "head-tail",
      fullLength: full.length,
    };
  }
  return { text: full, summaryOf: "full", fullLength: full.length };
}

export {
  nextRpcId,
  callUnary,
  openMux,
  textFromChunk,
  textFromMessageBlocks,
  buildSummary,
  SUMMARY_HEAD,
  SUMMARY_TAIL,
};
