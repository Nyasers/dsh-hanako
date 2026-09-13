// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/dsh-rpc.ts — 经注入 fetch 的 DSH /api 网关 RPC 调用
//
// 背景：「App 主进程 → 受管 runtime DSH web /api」的 loopback Unary RPC 封装起初只在
// src/lib/session-run.ts 内部（ctx.network.fetch 门）。同一条 RPC 面还出现在
// 更多地方（cancel 工具、执行超时看门狗、受管 runtime 内 task-bridge 的宿主取消反向
// 触发），把「信封构造 + POST + 响应解析」抽成本模块共用，fetch 由调用方注入：
//   · App 主进程：ctx.network.fetch（manifest network 白名单 127.0.0.1 门，宿主代执行）
//   · 受管 runtime 子进程（task-bridge/approval-bridge 同进程向本机 DSH 发 cancel）：
//     Node 全局 fetch（127.0.0.1 回环，dshana profile 无 BrowserAuth → 免鉴权）。
// 信封/网关契约与 session-run.js 完全一致（lib/rpc-envelope.js：client-request +
// session.* 的 request/_request 包装 + requestId 注入；响应 rpcId 回显 + result.ok）。
import { buildClientRequest, parseServerResponse, defaultRpcTimeoutMs } from "#/lib/rpc-envelope.ts";

/** 一元 RPC 的公共入参（信封字段 + 超时/中止；bare = 不走 session 信封）。 */
interface RpcCallInput {
  method: string;
  payload?: unknown;
  /** 幂等键（响应回显校验用）；缺省由信封生成。 */
  rpcId?: string;
  /** 调用方的中止信号（与内建超时合并）。 */
  signal?: AbortSignal | null;
  /** 超时毫秒（>0 采用；否则用默认）。 */
  timeoutMs?: number;
  /** true = 顶层方法（不包 session 信封）。 */
  bare?: boolean;
}

/** 各封装传给 rpcCallWithFetch 的公共可选项。 */
interface RpcOpts {
  rpcId?: string;
  signal?: AbortSignal | null;
  timeoutMs?: number;
}

/** 注入式 RPC 调用：fetchFn(url, init) => Promise<Response>；超时/中止经 AbortSignal。 */
export async function rpcCallWithFetch(fetchFn, base, { method, payload, rpcId, signal, timeoutMs, bare }: RpcCallInput) {
  if (typeof fetchFn !== "function") throw new Error("dsh-rpc: 需要 fetch 注入（ctx.network.fetch / 全局 fetch）");
  const { body } = buildClientRequest({ method, payload, rpcId, bare });
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
export function rpcSessionCancel(fetchFn, base, sessionId, opts: RpcOpts = {}) {
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

// ---- settings 面（默认模型）：值归 DSH 的 settings 服务，我们只过手，不存副本 ----

/** 默认模型所在的 settings 段名（持有者 @deepseek-ai/dsh-agent-default-model）。 */
export const AGENT_DEFAULT_MODEL_NS = "agent-default-model";

/** settings/describe：各段视图（value + revision）。无参方法。 */
export function rpcSettingsDescribe(fetchFn, base, opts: RpcOpts = {}) {
  return rpcCallWithFetch(fetchFn, base, {
    method: "settings/describe",
    payload: {},
    rpcId: opts.rpcId,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * settings/replace：整段替换（`replace(ns, section, expectedRevision)`，args 按参数名给）。
 * expectedRevision 只在是有限数时才带上——不带 = 不校验版本（DSH 只在带版本时判冲突）。
 */
export function rpcSettingsReplace(
  fetchFn,
  base,
  { ns, section, expectedRevision }: { ns: string; section: unknown; expectedRevision?: number },
  opts: RpcOpts = {},
) {
  const args: { ns: string; section: unknown; expectedRevision?: number } = { ns: String(ns), section };
  if (typeof expectedRevision === "number" && Number.isFinite(expectedRevision)) {
    args.expectedRevision = expectedRevision;
  }
  return rpcCallWithFetch(fetchFn, base, {
    method: "settings/replace",
    payload: args,
    rpcId: opts.rpcId,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
}

/** session/modelCatalog：候选模型（按 provider 分组）。无参方法——不走 session 信封（bare）。 */
export function rpcModelCatalog(fetchFn, base, opts: RpcOpts = {}) {
  return rpcCallWithFetch(fetchFn, base, {
    method: "session/modelCatalog",
    payload: {},
    bare: true,
    rpcId: opts.rpcId,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * 从 settings/describe 的返回里取某段视图（纯函数）。describe 的形状是
 * `{ writable, hasDocument, namespaces: SettingsNamespaceView[] }`——按 `ns` 找那一项；
 * 也容错以段名为键的对象形状。取不到返回 null。
 */
export function settingsViewOf(described, ns) {
  if (!described || typeof described !== "object") return null;
  const list = described.namespaces;
  if (Array.isArray(list)) {
    return list.find((v) => v && typeof v === "object" && v.ns === ns) ?? null;
  }
  const bag = described.sections ?? list ?? described;
  if (!bag || typeof bag !== "object") return null;
  const view = bag[ns];
  return view && typeof view === "object" ? view : null;
}

/** 冲突判定（纯函数）：DSH 对版本不符的写入报 `settings/conflict`（真机探测核对）。 */
export function isSettingsConflict(error) {
  const code = String((error && (error.code || error.dshCode)) || "");
  if (code === "SETTINGS_CONFLICT" || code === "settings/conflict") return true;
  const msg = String((error && error.message) || "");
  return /SETTINGS_CONFLICT|conflict|revision/i.test(code + " " + msg);
}
