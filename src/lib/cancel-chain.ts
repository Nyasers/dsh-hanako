// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/cancel-chain.ts — dshana_session cancel / 执行超时取消编排（App 主进程侧）
//
// 职责：
//   ① 触发：dshana_session(action=cancel)（本模块 cancelDshTask）或执行超时看门狗
//      （session-run 定时器，同一函数）；
//   ② DSH 侧中止：经 loopback HTTP RPC session/cancel（DSH 中止 agent 回合 → provider
//      adapter 流 signal abort → hana.models.cancel(requestId)，工具/终端由 DSH 回合
//      中止机制收尾——v1 同款语义）；
//   ③ 只关本工作资源：取消按 sessionId 定位（task-map 文件键 = sessionId）；单例受管
//      runtime 服务多会话时 session/cancel 只作用该会话，绝不停整个 runtime/他人会话；
//   ④ 确定取消状态：映射写 cancel 标记（先于 RPC）→ task-bridge 在 DSH turn/end
//      (aborted) 时据此把宿主任务结算成 canceled（真中止后才取消，不是先标 canceled）→
//      App 侧等宿主任务终态（确认窗口内轮询 get）给用户确定状态；DSH 超窗未确认时
//      升级 ctx.tasks.cancel 兜底并如实告知（残留风险见 DESIGN 边界）。
//
// 与宿主「取消 UI」的反向触发（host task canceled/aborted → DSH cancel）在受管 runtime
// 的 task-bridge 侧实现（watch 宿主任务 SSE），不在此模块（App 进程内看不到 DSH 事件）。
import { appCtx, appDataDir, appConfig } from "./app-runtime.ts";
import { readTaskMap, markCancelRequested } from "./task-map.ts";
import { rpcSessionCancel, cancelAccepted } from "./dsh-rpc.ts";
import { rpcViaControl } from "./controller.ts";
import { readSettingsSync } from "./data-source.ts";

export const CANCEL_CONFIRM_MS = 15000; // DSH 中止确认窗口（超窗升级宿主 cancel）
export const CANCEL_ESCALATE_REASON = "cancel-confirm-timeout";

/** 纯函数：按映射条目给出取消编排计划（供单测与执行器共用）。 */
export function planCancel(entry) {
  const sid = String((entry && entry.dshSessionId) || "");
  const taskId = String((entry && entry.taskId) || "");
  return {
    sessionId: sid,
    taskId,
    // 已有取消标记：不重复发 DSH cancel（幂等）；否则需要 DSH 侧取消
    dshCancelNeeded: !!(sid && !(entry && entry.cancel)),
    hostEscalateAvailable: !!taskId,
  };
}

function logWarn(log, msg) {
  try { if (log && typeof log.warn === "function") log(msg); } catch { /* 忽略 */ }
}

/**
 * 取消编排执行（cancel 工具 / 执行超时共用）。返回 { status, taskId, reason }：
 *   status = 'cancelling'（DSH cancel 已请求，宿主终态随后由 task-bridge 结算）
 *          | 'no-active-work'（无映射/空闲会话；仍发幂等 session.cancel）
 *          | 'already-requested'（取消标记已存在——幂等，不再重复发）
 *          | 'dsh-rpc-failed'（DSH 侧不可达：已尽力，任务仍会由宿主侧终结兜底）
 */
export async function executeCancel({ dataDir, sessionId, reason, log }) {
  const ctx = appCtx();
  if (!ctx || !dataDir) throw new Error("App 运行包未初始化（apply 未注入宿主 ctx/dataDir）");
  const sid = String(sessionId || "").trim();
  if (!sid) throw new Error("cancel 需要 sessionId");
  const entry = readTaskMap(dataDir, sid);
  const plan = planCancel(entry);
  if (!entry) {
    // 无映射（空闲/映射已清）：仍向 DSH 发幂等 cancel，防「宿主侧已清、DSH 仍在跑」
    let dshAccepted = null;
    try {
      const value = await rpcViaControl(ctx, { method: "session/cancel", payload: { sessionId: String(sid || "") } });
      dshAccepted = cancelAccepted(value);
    } catch (e) {
      logWarn(log, "[dsh-session] cancel RPC（无映射兜底）失败：" + ((e && e.message) || e));
    }
    return { status: "no-active-work", sessionId: sid, dshAccepted, taskId: null, reason };
  }
  if (!plan.dshCancelNeeded) {
    return { status: "already-requested", sessionId: sid, taskId: entry.taskId, reason: (entry.cancel && entry.cancel.reason) || reason };
  }
  // ① 写取消标记（先于 RPC：task-bridge 终态判定据此把 aborted 结算成 canceled）
  try {
    markCancelRequested(dataDir, sid, reason || "user");
  } catch (e) {
    logWarn(log, "[dsh-session] cancel 标记写失败（继续取消）：" + ((e && e.message) || e));
  }
  // ② DSH session.cancel（loopback；失败不阻断——记录并交由终态兜底）
  let dshAccepted = null;
  let dshError = null;
  try {
    const value = await rpcViaControl(ctx, { method: "session/cancel", payload: { sessionId: String(sid || "") } });
    dshAccepted = cancelAccepted(value);
  } catch (e) {
    dshError = (e && e.message) || String(e);
    logWarn(log, "[dsh-session] DSH session.cancel RPC 失败：" + dshError);
  }
  if (!dshAccepted && dshError) {
    return { status: "dsh-rpc-failed", sessionId: sid, taskId: entry.taskId, reason, dshError };
  }
  return { status: "cancelling", sessionId: sid, taskId: entry.taskId, reason, dshAccepted };
}

/** 等宿主任务终态（轮询 get；确认窗口给用户确定状态）。返回记录或 null（超窗）。 */
export async function awaitCancelTerminal({ taskId, timeoutMs = CANCEL_CONFIRM_MS, pollMs = 500, log }) {
  const ctx = appCtx();
  if (!taskId || !ctx || typeof ctx.tasks?.get !== "function") return null;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  for (;;) {
    let rec = null;
    try {
      rec = await ctx.tasks.get(taskId);
    } catch (e) {
      logWarn(log, "[dsh-session] 取消确认 tasks.get 失败：" + ((e && e.message) || e));
    }
    if (rec && ["completed", "failed", "canceled", "aborted"].includes(String(rec.status))) return rec;
    if (Date.now() >= deadline) return null;
    await new Promise((res) => setTimeout(res, pollMs));
  }
}

/**
 * cancel 工具主流程：executeCancel + 确认窗口内等终态；DSH 超窗未确认时升级宿主
 * ctx.tasks.cancel（如实告知——见 DESIGN 边界）。返回 { status, terminal?, escalated?, ... }。
 */
export async function cancelSessionWork({ sessionId, reason, log, confirmMs = CANCEL_CONFIRM_MS }) {
  const dataDir = appDataDir();
  const ctx = appCtx();
  const res = await executeCancel({ dataDir, sessionId, reason, log });
  if (res.status === "no-active-work" || res.status === "already-requested" || res.status === "dsh-rpc-failed") {
    return res;
  }
  const terminal = await awaitCancelTerminal({ taskId: res.taskId, timeoutMs: confirmMs, log });
  if (terminal) return { ...res, status: "canceled", terminal };
  // 升级兜底：宿主任务先 cancel（真实取消状态仍要保证；DSH 若真未停，日志/边界记录）
  if (res.taskId && ctx && typeof ctx.tasks?.cancel === "function") {
    try {
      await ctx.tasks.cancel(res.taskId, reason || CANCEL_ESCALATE_REASON);
      return { ...res, status: "canceled", escalated: true };
    } catch (e) {
      logWarn(log, "[dsh-session] 取消升级 ctx.tasks.cancel 失败：" + ((e && e.message) || e));
    }
  }
  return { ...res, status: "cancelling" };
}

/**
 * 当前 App 设置（同步读自持存储）；离线或文件损坏返回 null，由调用方决定回落。
 * 超时值从这里取：设置页写的就是这份存储（与数据模式同栈同 revision）。
 */
function settingsOrNull() {
  try {
    const dir = appDataDir();
    if (!dir) return null;
    return readSettingsSync(dir);
  } catch {
    return null;
  }
}

/** 执行超时秒解析（纯函数面）：显式值 > 0 采用；否则 App 设置 defaultTimeoutSec；
 * 读不到/非法/0 回落 600（与工具描述同语义）。 */
export function resolveTaskTimeoutSec(explicitSec) {
  if (Number.isFinite(Number(explicitSec)) && Number(explicitSec) > 0) return Math.round(Number(explicitSec));
  const v = Number(settingsOrNull()?.defaultTimeoutSec);
  if (Number.isFinite(v) && v > 0) return Math.round(v);
  return 600;
}

/** 审批自动拒绝超时毫秒（approval-bridge 经映射下传；0 = 宿主不自动拒绝）。 */
export function resolveApprovalTimeoutMs() {
  const v = Number(settingsOrNull()?.approvalTimeoutSec);
  if (!Number.isFinite(v)) return 30000;
  return v > 0 ? Math.round(v * 1000) : 0;
}
