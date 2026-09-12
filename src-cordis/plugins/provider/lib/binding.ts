// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/plugins/provider/lib/binding.ts — 会话↔任务绑定的宿主槽位（会话投影）
//
// 绑定的落点是**会话自己的事件日志**：某条 DSH 会话当前被哪个 Hana task 占着，是这条会话的
// 事实，随会话一起持久化、一起回放。宿主为此提供的接缝是 `sessionProjections`——我们注册一个
// host-only 单元（无 wire，不进客户端快照），本进程内 `stateOf` 直接读到折叠结果，不读文件、
// 不做宿主往返。
//
// 两个事件都是普通字符串类型、非 surface 事件（与官方 `permission/preset` 同款）：
//   dshana/task-binding        { taskId, timeoutSec, approvalTimeoutMs }   ← 认领
//   dshana/task-binding-ended  { taskId, status }                          ← 收尾
// 折叠语义（last-wins，收尾必须对上号）：
//   · 认领整条替换——同一会话 send 会建新 task，新认领必须盖掉旧的 ended；
//   · 收尾只在 taskId 与当前认领一致时生效——上一个 task 的收尾事件不得关掉新认领。
//
// 写入时机：认领由**能落地的那个人落地**。控制面调用到达时会话若已 attach（create 路径）就当场
// append；会话还冷着（send 路径：DSH 要到 prompt 进来才 resume）就先投进同进程邮箱，由
// provider 在模型请求前落地——那一刻它在自己的回合里，会话必然已 attach。邮箱是**传递点**而非
// 第二份事实源：值与最终事件同源，用完即清；落不成也不静默，由调用侧看见。
//
// 零依赖纯函数（node --test 可直接 import）。

/** 投影 key（stateOf 用）。 */
export const BINDING_KEY = "dshanaTaskBinding";

/** 单元版本：折叠语义变化时递增（宿主据此丢弃不匹配的缓存行重新折叠）。 */
export const BINDING_STATE_VERSION = 2;

/** 事件类型。 */
export const BINDING_CLAIM_EVENT = "dshana/task-binding";
export const BINDING_END_EVENT = "dshana/task-binding-ended";
/** 取消标记：取消链在发 DSH cancel **之前** 落的事件（会话级，随下次认领清空）。 */
export const BINDING_CANCEL_EVENT = "dshana/task-cancel";

/** 投影未注册（能力缺席）时的错误码——绝不是"这条会话没有绑定"。 */
export const BINDING_UNAVAILABLE = "BINDING_UNAVAILABLE";

/** 空绑定（未认领）。`at` 是最后一次生效事件的 seq，便于诊断。 */
export function emptyBinding() {
  return { taskId: null, timeoutSec: null, approvalTimeoutMs: null, ended: null, cancel: null, at: null };
}

function intOrNull(value) {
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

/**
 * 折叠一个事件到绑定状态（纯函数）。
 * @param {object|null} state 当前状态（null/畸形按空绑定处理）
 * @param {object} event 会话事件（{ type, data, seq }）
 * @returns {object} 新状态（每次返回新对象，供宿主按 Object.is 判变化）
 */
export function foldBinding(state, event) {
  const cur = state && typeof state === "object" && !Array.isArray(state)
    ? { ...emptyBinding(), ...state }
    : emptyBinding();
  if (!event || typeof event !== "object") return cur;
  const data = event.data && typeof event.data === "object" ? event.data : {};
  const at = Number.isFinite(event.seq) ? Math.trunc(event.seq) : cur.at;
  if (event.type === BINDING_CLAIM_EVENT) {
    const taskId = typeof data.taskId === "string" && data.taskId !== "" ? data.taskId : null;
    if (taskId === null) return cur;
    return {
      taskId,
      timeoutSec: intOrNull(data.timeoutSec),
      approvalTimeoutMs: intOrNull(data.approvalTimeoutMs),
      ended: null,
      // 新认领 = 新任务：上一轮的取消标记在职于旧任务，随认领清空
      cancel: null,
      at,
    };
  }
  if (event.type === BINDING_CANCEL_EVENT) {
    // 会话级标记（取消是会话上的动作，不要求对上 taskId）；last-wins
    const reason = typeof data.reason === "string" && data.reason !== "" ? data.reason : null;
    return { ...cur, cancel: { reason, at } };
  }
  if (event.type === BINDING_END_EVENT) {
    // 无认领、或收尾的 taskId 不是当前认领（陈旧的收尾）⇒ 不动。
    if (cur.taskId === null || data.taskId !== cur.taskId) return cur;
    const status = typeof data.status === "string" && data.status !== "" ? data.status : "ended";
    return { ...cur, ended: status, at };
  }
  return cur;
}

/**
 * 手写 state 校验。宿主契约只要求 `.parse(value)`：形状不对就抛，宿主据此丢弃该缓存行、
 * 从 `init` 重新折叠整条日志——所以这里"抛"是安全动作，不是丢数据。
 */
export const bindingStateSchema = {
  parse(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("binding state 必须是对象");
    }
    if (value.taskId !== null && (typeof value.taskId !== "string" || value.taskId === "")) {
      throw new TypeError("binding.taskId 必须是 null 或非空字符串");
    }
    if (value.ended !== null && typeof value.ended !== "string") {
      throw new TypeError("binding.ended 必须是 null 或字符串");
    }
    return {
      taskId: value.taskId ?? null,
      timeoutSec: intOrNull(value.timeoutSec),
      approvalTimeoutMs: intOrNull(value.approvalTimeoutMs),
      ended: value.ended ?? null,
      cancel: value.cancel ?? null,
      at: intOrNull(value.at),
    };
  },
};

/** 宿主投影单元定义（host-only）。 */
export function bindingUnit() {
  return {
    key: BINDING_KEY,
    stateVersion: BINDING_STATE_VERSION,
    stateSchema: bindingStateSchema,
    init: () => emptyBinding(),
    apply: foldBinding,
  };
}

/** 认领载荷（provider 落地时构造事件数据用）。 */
export function claimPayload(claim) {
  return {
    taskId: claim.taskId,
    timeoutSec: intOrNull(claim.timeoutSec),
    approvalTimeoutMs: intOrNull(claim.approvalTimeoutMs),
  };
}

// ---- 同进程邮箱（控制面 → provider 的传递点，跨 bundle 经 globalThis，与 __dshanaHana 同款）----

const MAILBOX_KEY = "__dshanaBindingMailbox";

/** 取邮箱（懒建，同进程共享）。 */
export function bindingMailbox() {
  const g = globalThis;
  const cur = g[MAILBOX_KEY];
  if (cur instanceof Map) return cur;
  const made = new Map();
  g[MAILBOX_KEY] = made;
  return made;
}

/**
 * 投递一条认领（校验后写入）。
 * @param {string} sessionId DSH 会话 id
 * @param {{taskId: string, timeoutSec?: number, approvalTimeoutMs?: number}} claim
 * @returns {object} 落进邮箱的载荷
 * @throws {TypeError} sessionId/taskId 不合法（调用侧必须看见，不静默）
 */
export function depositBindingClaim(sessionId, claim) {
  if (typeof sessionId !== "string" || sessionId === "") throw new TypeError("binding: sessionId 必填");
  const taskId = claim && typeof claim.taskId === "string" && claim.taskId !== "" ? claim.taskId : null;
  if (taskId === null) throw new TypeError("binding: taskId 必填");
  const payload = claimPayload({ ...claim, taskId });
  bindingMailbox().set(sessionId, payload);
  return payload;
}

/** 读一条待落地的认领（没有则 null）。 */
export function pendingBindingClaim(sessionId) {
  if (typeof sessionId !== "string" || sessionId === "") return null;
  return bindingMailbox().get(sessionId) || null;
}

/** 认领落地后清邮箱；taskId 对不上说明邮箱已被更新的认领覆盖，不动它。 */
export function clearBindingClaim(sessionId, taskId) {
  const cur = pendingBindingClaim(sessionId);
  if (cur === null || (taskId !== undefined && cur.taskId !== taskId)) return false;
  bindingMailbox().delete(sessionId);
  return true;
}
