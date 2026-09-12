// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/binding-slot.ts — 会话↔任务绑定的运行期侧（控制面写入 + 终态收尾）
//
// 绑定的唯一落点是**会话自己的事件日志**：`dshana/task-binding` 认领、
// `dshana/task-binding-ended` 收尾，由受管 runtime 内 @dshana/provider 注册的会话投影单元
// （`dshanaTaskBinding`）折叠。本模块只做两件事：
//
//   · 控制面认领：把"这条会话归哪个 Hana task"投进**同进程邮箱**；会话已 attach（create
//     路径）就当场 append，还冷着（send 路径：DSH 要到 prompt 进来才 resume）就留给 provider
//     在模型请求前落地——那一刻它在自己的回合里，会话必然已 attach。两条路同一份载荷。
//   · 终态收尾：任务结算时把 ended 标记 append 进同一会话。
//
// 邮箱是**传递点**，不是第二份事实源：值与最终事件同源，落地后即清；跨 bundle 经 globalThis
// 共享（与 __dshanaHana、活动模型注册表同款约定）。事件名与 key 必须与
// src-cordis/plugins/provider/lib/binding.ts 逐字一致（两套构建树不能互相 import）。

/** 投影 key（与 provider 侧同字）。 */
export const BINDING_KEY = "dshanaTaskBinding";

/** 单元版本。 */
export const BINDING_STATE_VERSION = 4;

/** 事件类型。 */
export const BINDING_CLAIM_EVENT = "dshana/task-binding";
export const BINDING_END_EVENT = "dshana/task-binding-ended";
/** 取消标记：取消链在发 DSH cancel **之前** 落的事件（与 provider 侧同字）。 */
export const BINDING_CANCEL_EVENT = "dshana/task-cancel";

const MAILBOX_KEY = "__dshanaBindingMailbox";

function intOrNull(value) {
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

/** 认领事件数据（只带绑定本身，不带提示词或别的私货）。 */
export function claimPayload(claim) {
  return {
    taskId: claim && typeof claim.taskId === "string" ? claim.taskId : null,
    rpcId: claim && typeof claim.rpcId === "string" && claim.rpcId !== "" ? claim.rpcId : null,
    action: claim && typeof claim.action === "string" && claim.action !== "" ? claim.action : null,
    timeoutSec: intOrNull(claim && claim.timeoutSec),
    approvalTimeoutMs: intOrNull(claim && claim.approvalTimeoutMs),
  };
}

/**
 * 读一条会话的任务绑定：**投影优先**（同进程 stateOf，零文件读），取不到再回落私有映射文件。
 *
 * 两条路同源（都由控制面认领写入），回落只为绑定事件在投影落地之前建的者会话。
 * 返回值形状与 task-map 的记录对齐（taskId/rpcId/cancel/app…），调用方不必分叉。
 *
 * @param {object} ctx DSH cordis 上下文（同进程的 sessions / sessionProjections 服务）
 * @param {string} sessionId DSH 会话 id
 * @param {object} [session] 事件回调给到的会话对象（有就直接用，省一次 sessions.get）
 * @param {function} [fileFallback] 取不到投影时调它拿文件记录（不传就不回落）
 */
export function bindingStateOf(ctx, sessionId, session, fileFallback) {
  const registry = ctx && typeof ctx.get === "function" ? ctx.get("sessionProjections") : null;
  if (registry && typeof registry.stateOf === "function") {
    let s = session;
    if (!s && typeof ctx.get === "function" && typeof sessionId === "string" && sessionId !== "") {
      const sessions = ctx.get("sessions");
      s = sessions && typeof sessions.get === "function" ? sessions.get(sessionId) : null;
    }
    if (s) {
      try {
        const state = registry.stateOf(s, BINDING_KEY);
        if (state && state.taskId) return state;
      } catch {
        /* 单条会话读不到不当致命：交给回落 */
      }
    }
  }
  return typeof fileFallback === "function" ? fileFallback() || null : null;
}

/** 取消事件数据（只带原因，不带别的私货）。 */
export function cancelPayload(reason) {
  return { reason: typeof reason === "string" && reason !== "" ? reason : null };
}

function mailbox() {
  const g = globalThis;
  if (g[MAILBOX_KEY] instanceof Map) return g[MAILBOX_KEY];
  const made = new Map();
  g[MAILBOX_KEY] = made;
  return made;
}

/**
 * 投递一条认领（校验后写入邮箱）。
 * @throws {TypeError} sessionId/taskId 不合法——调用侧必须看见，不静默
 */
export function depositBindingClaim(sessionId, claim) {
  if (typeof sessionId !== "string" || sessionId === "") throw new TypeError("binding: sessionId 必填");
  const payload = claimPayload(claim);
  if (payload.taskId === null || payload.taskId === "") throw new TypeError("binding: taskId 必填");
  mailbox().set(sessionId, payload);
  return payload;
}

/** 读一条待落地的认领（无则 null）。 */
export function pendingBindingClaim(sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  return mailbox().get(sessionId) || null;
}

/** 认领落地后清邮箱；taskId 对不上说明已被更新的认领覆盖，不动它。 */
export function clearBindingClaim(sessionId, taskId) {
  const cur = pendingBindingClaim(sessionId);
  if (cur === null || (taskId !== undefined && cur.taskId !== taskId)) return false;
  mailbox().delete(sessionId);
  return true;
}

/**
 * 往一条**已 attach**的会话 append 一个事件。
 * @param {object|null} sessions 宿主的 sessions 服务（ctx.get("sessions")）
 * @param {string} sessionId DSH 会话 id
 * @param {string} type 事件类型
 * @param {object} data 事件数据
 * @returns {boolean} 是否落地（会话不在场或 append 抛错都算没落地，由调用方决定怎么说话）
 */
export function appendSessionEvent(sessions, sessionId, type, data) {
  if (!sessions || typeof sessions.get !== "function" || typeof sessionId !== "string" || sessionId === "") return false;
  const session = sessions.get(sessionId);
  if (!session || typeof session.append !== "function") return false;
  session.append(type, data);
  return true;
}
