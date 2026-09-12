// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/dsh-rpc.js — 经注入 fetch 的 DSH /api 网关 RPC 调用
//
// 背景：「App 主进程 → 受管 runtime DSH web /api」的 loopback Unary RPC 封装起初只在
// lib/session-run.js 内部（ctx.network.fetch 门）。同一条 RPC 面还出现在
// 更多地方（cancel 工具、执行超时看门狗、受管 runtime 内 task-bridge 的宿主取消反向
// 触发），把「信封构造 + POST + 响应解析」抽成本模块共用，fetch 由调用方注入：
//   · App 主进程：ctx.network.fetch（manifest network 白名单 127.0.0.1 门，宿主代执行）
//   · 受管 runtime 子进程（task-bridge/approval-bridge 同进程向本机 DSH 发 cancel）：
//     Node 全局 fetch（127.0.0.1 回环，dshana profile 无 BrowserAuth → 免鉴权）。
// 信封/网关契约与 session-run.js 完全一致（lib/rpc-envelope.js：client-request +
// session.* 的 request/_request 包装 + requestId 注入；响应 rpcId 回显 + result.ok）。
import { buildClientRequest, parseServerResponse, defaultRpcTimeoutMs } from "./rpc-envelope.js";

/** 注入式 RPC 调用：fetchFn(url, init) => Promise<Response>；超时/中止经 AbortSignal。 */
export async function rpcCallWithFetch(fetchFn, base, { method, payload, rpcId, signal, timeoutMs }) {
  if (typeof fetchFn !== "function") throw new Error("dsh-rpc: 需要 fetch 注入（ctx.network.fetch / 全局 fetch）");
  const { body } = buildClientRequest({ method, payload, rpcId });
  const deadline = Number(timeoutMs) > 0 ? Number(timeoutMs) : defaultRpcTimeoutMs();
  const ctl = AbortSignal.timeout(deadline);
  const merged = signal ? AbortSignal.any([signal, ctl]) : ctl;
  const res = await fetchFn(base + "/api/" + body.method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: merged,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("DSH /api/" + body.method + " HTTP " + res.status + (text ? "：" + text.slice(0, 300) : ""));
  }
  const full = await res.json();
  return parseServerResponse(full, body.rpcId);
}

/** session 工作取消（DSH 侧中止当前回合/工具/模型/终端；幂等——空闲会话 no-op）。 */
export function rpcSessionCancel(fetchFn, base, sessionId, opts = {}) {
  return rpcCallWithFetch(fetchFn, base, {
    method: "session/cancel",
    payload: { sessionId: String(sessionId || "") },
    rpcId: opts.rpcId,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
}

/** session.cancel 应答判定（纯函数）：{ ok:true } 才算 accepted（网关 value 或 null 宽容）。 */
export function cancelAccepted(value) {
  if (value && typeof value === "object") {
    if (value.ok === true || value.accepted === true) return true;
  }
  return value === undefined || value === null; // DSH 网关常返回空 result.value = 已接受
}
