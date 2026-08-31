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

import { randomUUID } from "node:crypto";
import { getSingleton } from "./state.js";

// ---- HTTP RPC 客户端（dsh web /api 网关，fetch 载波）----
// Unary：POST /api/<method>，body = { type:"client-request", rpcId, method, payload }
// 响应 ServerResponse：rpcId 回显 + result.ok/value 或 result.ok=false + error。
function nextRpcId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function callUnary(base, method, payload, signal, meta) {
  const rpcId = nextRpcId();
  // meta.rpcId 回传：rpcId 由宿主生成（client-request 信封），dsh 侧以此写 jsonl
  // user/message 的 data.source.rpcId——生成即有效，提前设置使失败/拒绝路径也能拿到
  //（成功路径同值），供调用方在提交失败时保留 rpcId 关联（sessionId+rpcId 定位轮次）。
  if (meta && typeof meta === "object") meta.rpcId = rpcId;
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
  // meta.rpcId 提前回传（同 callUnary 语义：reqId 宿主生成、dsh 侧写 jsonl
  // data.source.rpcId）——总线路径成功/失败/超时/中止都保留 rpcId 关联；降级路径由
  // callUnary 内部的 meta.rpcId 覆盖为实际 HTTP rpcId。
  if (meta && typeof meta === "object") meta.rpcId = reqId;
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
    if (method === "respond") {
      // respond 是 client-response 信封（rpcId 路由 web host pending 表，payload 已是
      // { type:"client-response", rpcId, result } 原样信封）——不能用 callUnary 的
      // client-request 信封（会再包一层，dsh /api/respond 校验失败）。总线不可用时
      // 直发 HTTP，信封语义与总线路径（bridge 翻译器 respond 特殊处理）一致。
      return respondDirect(rpcBusBase(g), payload, signal);
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

// respond 审批应答直发（client-response 信封原样 POST /api/respond）：总线不可用时的
// 降级路径。响应 rpcReceipt { accepted, reason? }，调用方校验 j.accepted 语义不变。
async function respondDirect(base, payload, signal) {
  const res = await fetch(`${base}/api/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) throw new Error(`/api/respond HTTP ${res.status}`);
  return await res.json();
}

// ---- 事件流（/api/remote.mux，WebSocket 通道；vX 适配 dsh 0.1.2）----
// 0.1.2 事件流：remote.mux WS（cookie 鉴权——launchToken 换发，本机 Node 侧带 Cookie
// 头不涉 SameSite）+ $events 订阅（open 帧：UUID streamId + endpoint "$events" +
// payload {args:{}}）。服务端推 item 帧（value = RemoteEventDownlinkFrame：
// ready / emit / waterfall / cancel）。waterfall 帧需回投 $events/result
//（outcome next——宿主只读不处理，否则服务端挂起）；emit 帧是广播（session 事件），
// 不回投。Node 全局 WebSocket 支持 headers（Cookie）。
let muxCookie = "";
let muxCookieAt = 0;

/** remote.mux 鉴权 cookie（launchToken → GET /?token= → dsh-auth-*，缓存 6h）。 */
async function ensureMuxCookie(base) {
  if (muxCookie && Date.now() - muxCookieAt < 6 * 3600 * 1000) return muxCookie;
  const g = getSingleton();
  const tok = g?.web?.token || "";
  if (!tok) return "";
  try {
    const res = await fetch(base + "/?token=" + encodeURIComponent(tok), {
      redirect: "manual",
    });
    const setCookies =
      typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : res.headers.get("set-cookie")
          ? [res.headers.get("set-cookie")]
          : [];
    muxCookie = setCookies
      .map((s) => String(s).split(";")[0])
      .filter(Boolean)
      .join("; ");
    muxCookieAt = Date.now();
    return muxCookie;
  } catch {
    return muxCookie || "";
  }
}

/** 回投 $events/result（waterfall 帧默认 next——宿主只读不处理，fire-and-forget）。 */
async function ackRemoteEvent(base, clientId, eventId, outcome) {
  try {
    const cookie = await ensureMuxCookie(base);
    await fetch(base + "/api/$events/result", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "ev_" + Date.now().toString(36),
        method: "$events/result",
        payload: { args: { clientId, eventId, outcome } },
      }),
    });
  } catch {
    /* 回投失败不阻断（服务端超时自愈） */
  }
}

async function* openMux(base, signal) {
  if (typeof WebSocket !== "function") {
    throw new Error("宿主环境无全局 WebSocket，无法订阅 DSH 事件流");
  }
  const url = base.replace(/^http/, "ws") + "/api/remote.mux";
  const cookie = await ensureMuxCookie(base);
  const ws = new WebSocket(url, cookie ? { headers: { Cookie: cookie } } : {});
  const queue = [];
  const waiters = [];
  let wsError = null;
  let wsClosed = false;
  let readyClientId = "";
  ws.onmessage = (ev) => {
    let item = null;
    try {
      item = JSON.parse(ev.data);
    } catch {
      return;
    }
    // remote.mux item 帧：{ type:"item", streamId, value: <事件帧> }——
    // value 即 RemoteEventDownlinkFrame（ready/emit/waterfall/cancel）。
    const value = item?.value;
    if (!value || typeof value.type !== "string") return;
    if (value.type === "ready") {
      // 事件流就绪：记录 clientId（waterfall 回投用），不投给上层
      readyClientId = typeof value.clientId === "string" ? value.clientId : "";
      return;
    }
    if (value.type === "waterfall") {
      // 瀑布事件（审批等）：默认回投 next（宿主只读），同时投上层（审批应答适配后续）
      if (readyClientId && typeof value.eventId === "string") {
        ackRemoteEvent(base, readyClientId, value.eventId, { kind: "next" });
      }
    }
    const frame = value;
    if (waiters.length) waiters.shift()(frame);
    else queue.push(frame);
  };
  ws.onerror = () => {
    wsError = new Error("dsh remote.mux WebSocket 错误");
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
    ws.onopen = () => {
      try {
        // 订阅事件流：open 帧（UUID streamId + $events 端点 + 空 args）
        ws.send(
          JSON.stringify({
            type: "open",
            streamId: crypto.randomUUID(),
            endpoint: "$events",
            payload: { args: {} },
          }),
        );
      } catch (e) {
        reject(wsError || e);
        return;
      }
      resolve();
    };
    ws.onerror = () => reject(wsError || new Error("dsh remote.mux 连接失败"));
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
