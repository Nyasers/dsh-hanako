// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/actions/approve.ts — dshana approve：应答子代理挂起的审批
//
// 本项目特色（subagent 没有审批面）。approvalId 是唯一句柄——会话由工具解析（句柄路径校验
// 归属），sessionId 仅在“我要跨对话”时显式传。应答编排见 lib/approve-respond.ts
// （校验审批归属 → ctx.tasks.respondApproval → runtime approval-bridge 把 outcome 只投给
// 该 approvalId 对应的 DSH 等待者）。
import { respondApprovalAction } from "../../lib/approve-respond.ts";
import { resolveTarget } from "../shared/target.ts";

export const command = "approve";
export const summary = "应答子代理挂起的审批（approvalId 必填；决策看 args 不听 reason）";
export const readOnly = false;

export const fields = {
  approvalId: { type: "string", description: "审批 id（审批通知里带；同一任务可能挂起多个审批，逐个应答）" },
  outcome: {
    type: "string",
    enum: ["allowed-once", "rejected"],
    description: "allowed-once=放行单次（安全默认，仅本次操作）/ rejected=拒绝该请求",
  },
  taskId: {
    type: "string",
    description: "句柄路径：审批归属会话经 open/reply 返回的 taskId 解析（与 sessionId 至少给一个）",
  },
  sessionId: { type: "string", description: "凭证路径（形如 session-<uuid>）：显式传入即视为“我要跨对话操作”" },
};
export const required = ["approvalId"];

export async function run(input, ctx) {
  const aid = String((input && input.approvalId) || "").trim();
  if (!aid) {
    throw new Error("approve 需要 approvalId（审批通知里带；同一任务可挂起多个审批，逐个应答）");
  }
  const target = await resolveTarget(input, ctx);
  return respondApprovalAction({ input: { ...input, sessionId: target.sessionId }, log: ctx && ctx.log });
}
