// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/task-ownership.ts — 归属校验通则（纯函数，无宿主依赖）
//
// 归属校验规则，与“句柄默认、凭证显式”配套：
//
//   · **显式传 sessionId** ⇒ 这是“我就是要跨对话”的凭证路径，跳过归属校验（旧语义保留）；
//   · 工具按**句柄**（taskId / approvalId）自己解析出来的目标 ⇒ 必须校验归属：
//       宿主记录的 parentSessionPath（= 发起那段 Hana 对话）必须等于本次调用的
//       context.sessionPath；不等 ⇒ 拒绝；
//   · 拿不到 context.sessionPath（按钮 / 卡片通道，调用者是用户本人）⇒ 放行，reason
//       no-session-context（无从校验，但也没有“冒充另一段对话”的主体）；
//   · 记录上**没有** parentSessionPath（既是 session 任务又为空 = 异常）⇒ 拒绝，fail-closed。
//
// 判据来自**宿主字段**（AppTaskRecordV2.parentSessionId / parentSessionPath），不是我们
// 自己推断的归属；这也正是"用宿主能力"的直接体现。

import type { AppTaskRecordV2 } from "../types/host.ts";

/** 归属校验的判定结果码（工具面直接把 reason 给用户/模型看）。 */
export type OwnershipReason =
  | "explicit-session-id"
  | "no-session-context"
  | "session-match"
  | "session-mismatch"
  | "record-missing-parent-session";

/** 归属校验结论。 */
export interface OwnershipVerdict {
  ok: boolean;
  reason: OwnershipReason;
}

/** 归属校验入参。 */
export interface OwnershipInput {
  /** 宿主任务记录（ctx.tasks.get 的返回）。 */
  taskRecord?: AppTaskRecordV2 | null;
  /** 本次工具调用的 context.sessionPath。 */
  sessionPath?: string | null;
  /** 调用方是否显式给了 sessionId。 */
  explicitSessionId?: boolean;
}

export function taskOwnership(
  { taskRecord, sessionPath, explicitSessionId }: OwnershipInput = {},
): OwnershipVerdict {
  if (explicitSessionId) return { ok: true, reason: "explicit-session-id" };
  const path = typeof sessionPath === "string" && sessionPath ? sessionPath : "";
  if (!path) return { ok: true, reason: "no-session-context" };
  const parent =
    taskRecord && typeof taskRecord.parentSessionPath === "string" ? taskRecord.parentSessionPath : "";
  if (!parent) return { ok: false, reason: "record-missing-parent-session" };
  if (parent !== path) return { ok: false, reason: "session-mismatch" };
  return { ok: true, reason: "session-match" };
}

/** 归属拒绝时的可读原因（工具面直接给用户/模型看）。 */
export function ownershipRefusalText(reason) {
  switch (reason) {
    case "session-mismatch":
      return "该任务属于另一段对话（宿主记录的来源会话与本次调用不一致）。要跨对话操作请显式传 sessionId。";
    case "record-missing-parent-session":
      return "宿主任务记录里没有来源会话字段（异常状态），已按 fail-closed 拒绝。";
    default:
      return "归属校验未通过（" + String(reason || "unknown") + "）。";
  }
}
