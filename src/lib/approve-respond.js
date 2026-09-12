// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/approve-respond.js — dshana_session approve 应答编排（App 主进程侧）
//
// 职责：
//   用户/Agent 经 dshana_session(action=approve, sessionId, approvalId, outcome) 应答 →
//   本模块校验审批归属（task-map approvals 表：approvalId 属于该会话且仍 pending——
//   防串会话/重复应答）→ ctx.tasks.respondApproval({ approvalId, outcome }) 结算宿主
//   审批 → 受管 runtime 的 approval-bridge 经 watch(approvalId) 观察到终态 outcome，
//   只投给**该 approvalId 对应的 DSH 等待者**（allowed-once/rejected 原样，绝不自动
//   allowed-once）。本模块**不**直接向 DSH 投递任何结果——宿主审批记录是唯一决策事实源。
//
//   超时/父任务结束/撤销：宿主侧把审批结算成 rejected（timeoutMs 自动拒绝 / 父任务终态
//   拒绝剩余审批），approval-bridge watch 同样把 rejected 投给 DSH 等待者——DSH 得到
//   确定终态，绝不隐式放行。本模块不设本地定时器（不重复宿主语义）。
import { appCtx, appDataDir } from "./app-runtime.js";
import { readTaskMap, findPendingApproval, settleApproval } from "./task-map.js";

/** 校验并应答一个挂起审批；返回 { content:[...], details }（与 v1 approve.js 同形态）。 */
export async function respondApprovalAction({ input, log }) {
  const sessionId = String((input && input.sessionId) || "").trim();
  const approvalId = String((input && input.approvalId) || "").trim();
  const outcome = input && input.outcome === "rejected" ? "rejected" : "allowed-once";
  if (!sessionId) throw new Error("approve 需要 sessionId（审批所属 DSH 会话）");
  if (!approvalId) throw new Error("approve 需要 approvalId（审批通知里带；同一任务可挂起多个审批，逐个应答）");

  const ctx = appCtx();
  const dataDir = appDataDir();
  if (!ctx || !dataDir) throw new Error("App 运行包未初始化（apply 未注入宿主 ctx/dataDir）");
  if (!ctx.tasks || typeof ctx.tasks.respondApproval !== "function") {
    throw new Error("宿主 ctx.tasks.respondApproval 不可用（缺 app/tasks.manage 能力授予）");
  }

  const entry = readTaskMap(dataDir, sessionId);
  const list = entry && Array.isArray(entry.approvals) ? entry.approvals : [];
  const known = list.find((a) => a && a.approvalId === approvalId) || null;
  if (!known) {
    const knownIds = list.map((a) => a && a.approvalId).filter(Boolean).join(", ") || "无";
    throw new Error(
      "审批 " + approvalId + " 不在会话 " + sessionId + " 的待办列表（可能已被应答/超时/任务已结束）。已知审批: " + knownIds,
    );
  }
  const pending = findPendingApproval(entry, approvalId);
  if (!pending) {
    const was = known && known.outcome ? known.outcome : "answered";
    throw new Error("审批 " + approvalId + " 已应答（" + was + "），勿重复应答");
  }

  // 结算宿主审批（权威决策源）；失败（已超时/他方已应答/宿主已终态）直接抛给 Agent
  let settled = null;
  try {
    settled = await ctx.tasks.respondApproval({ approvalId, outcome });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    throw new Error("审批应答未接受（" + msg.slice(0, 300) + "）：可能已超时或被其他方处理，任务侧会自行感知终态");
  }
  // 回填本地表（去重视图；幂等尽力而为——watch 对账以宿主记录为准）
  try {
    settleApproval(dataDir, sessionId, approvalId, outcome);
  } catch { /* 本地回填失败不阻断应答 */ }

  const verb = outcome === "allowed-once" ? "已放行" : "已拒绝";
  const reasonLine = pending.reason ? "（理由：" + String(pending.reason).slice(0, 300) + "）" : "";
  return {
    content: [
      {
        type: "text",
        text:
          verb + "审批 " + approvalId + " [" + (pending.toolName || "tool") + "]" + reasonLine +
          "。决策只投给该审批对应的 DSH 等待者（allowed-once 仅放行本次操作）；DSH 侧继续/收尾结果随后续任务通知送达。",
      },
    ],
    details: {
      dsh: {
        action: "approve",
        sessionId,
        approvalId,
        toolName: pending.toolName || null,
        outcome,
        accepted: !!(settled && (settled.outcome || settled.status)),
      },
    },
  };
}
