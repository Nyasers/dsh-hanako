// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/shared/target.ts — 目标解析（句柄优先、凭证显式）
//
// 与任务归属校验配套的公共入口，reply/close/get/approve 共用：
//   · 显式 sessionId ⇒ 凭证路径：直接用，跳过归属校验（故意跨对话的能力保留）；
//   · taskId / approvalId ⇒ 句柄路径：App 侧反查私有映射（DSH 会话坐标不进 agent 面），
//     再以宿主任务记录的 parentSessionPath 校验归属（lib/task-ownership.ts）；
// 解析不出来一律显式失败：不猜、不降级。
import { findTaskMapByTaskId, findTaskMapByApprovalId, isValidSessionId } from "../../lib/task-map.ts";
import { taskOwnership, ownershipRefusalText } from "../../lib/task-ownership.ts";

/**
 * 解析调用目标，返回 { sessionId, explicit, taskId, ownership }。
 * @param {any} input 工具入参（sessionId / taskId / approvalId 任给其一）+ context.sessionPath
 * @param {any} ctx 工具执行上下文（需 dataDir 与 tasks.get）
 */
export async function resolveTarget(input, ctx) {
  const explicit = String((input && input.sessionId) || "").trim();
  const dataDir = ctx && typeof ctx.dataDir === "string" ? ctx.dataDir : null;
  if (explicit) {
    if (!isValidSessionId(explicit)) {
      throw new Error("sessionId 形态不对（应为 session-<uuid>）：" + explicit);
    }
    return { sessionId: explicit, explicit: true, taskId: null, ownership: "explicit-session-id" };
  }
  const taskIdIn = String((input && input.taskId) || "").trim();
  const approvalIdIn = String((input && input.approvalId) || "").trim();
  let entry = null;
  if (taskIdIn) entry = dataDir ? findTaskMapByTaskId(dataDir, taskIdIn) : null;
  else if (approvalIdIn) entry = dataDir ? findTaskMapByApprovalId(dataDir, approvalIdIn) : null;
  if (!entry) {
    throw new Error(
      taskIdIn || approvalIdIn
        ? "找不到该句柄对应的 DSH 会话（任务可能已被回收或映射已清理）：" +
            (taskIdIn || approvalIdIn) +
            "。要跨对话操作请显式传 sessionId。"
        : "需要目标：传 taskId（默认，句柄路径）或 sessionId（显式凭证路径）",
    );
  }
  const taskId = String(entry.taskId || "");
  const sessionPath = input && input.context ? input.context.sessionPath : null;
  let record = null;
  try {
    record =
      taskId && ctx && ctx.tasks && typeof ctx.tasks.get === "function" ? await ctx.tasks.get(taskId) : null;
  } catch (e) {
    throw new Error("宿主任务记录读取失败（归属无法校验，按 fail-closed 处理）：" + ((e && e.message) || e));
  }
  const verdict = taskOwnership({ taskRecord: record, sessionPath, explicitSessionId: false });
  if (!verdict.ok) throw new Error(ownershipRefusalText(verdict.reason));
  return { sessionId: String(entry.dshSessionId || ""), explicit: false, taskId, ownership: verdict.reason };
}
