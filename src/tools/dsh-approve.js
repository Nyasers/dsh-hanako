// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/dsh-approve.js — dsh 审批应答工具
// dsh 会话审批挂起（approval/policy=ask 触发 approval/requested）时，dsh_run 任务的事件
// 循环会把审批上下文存进运行期协调条目（g.ops，键 = 任务 rpcId；审批对象含 respond 路由
// 所需的 respondRpcId——server-request 信封自己的 RPC id，区别于任务 rpcId），并通过宿主
// deferred 通道通知 Agent。Agent 收到通知后调用本工具应答：allowed-once 放行单次 / rejected
// 拒绝。内部经总线 rpc.request method="respond" 调 dsh web host /api/respond（callUnaryBus，
// 总线优先/HTTP 兜底；bridge 回投 { accepted }，校验 j.accepted 语义不变）。

import { callUnaryBus } from "./lib/protocol.js";

export const name = "dsh_approve";

export const description =
  "应答 DSH 任务挂起的权限审批（approval/requested）：allowed-once=放行该次请求 / rejected=拒绝。" +
  "rpcId 与 approvalId 来自审批通知；应答前评估通知里的 toolName 与 reason（命令原文）决定放行或拒绝。" +
  "无人应答也可在 DSH Web UI 人工处理。完整调用手册见 SKILL: skills/dsh-approve/SKILL.md";

export const parameters = {
  type: "object",
  properties: {
    rpcId: {
      type: "string",
      description:
        "审批所属 DSH 任务的 rpcId（审批通知里带；任务级 rpcId，每次任务调用唯一）",
    },
    approvalId: {
      type: "string",
      description:
        "审批 id（审批通知里带；同一任务可能挂起多个审批，逐个应答）",
    },
    outcome: {
      type: "string",
      enum: ["allowed-once", "rejected"],
      description:
        "allowed-once=放行单次（默认，安全默认值：仅本次操作）/ rejected=拒绝该请求",
    },
  },
  required: ["rpcId", "approvalId"],
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "external_api",
    summary:
      "向 DSH web host 提交审批应答（allowed-once/rejected），放行或拒绝 DSH agent 的越界权限请求",
    ruleId: "dsh-hanako-approve",
  }),
};

async function doExecute(input, ctx) {
  const rpcId = String(input.rpcId ?? "").trim();
  const approvalId = String(input.approvalId ?? "").trim();
  const outcome = input.outcome === "rejected" ? "rejected" : "allowed-once";
  if (!rpcId || !approvalId) throw new Error("rpcId 与 approvalId 必填");

  const g = globalThis.__dshHanako;
  const op = g?.ops?.get(rpcId);
  if (!op)
    throw new Error(
      `任务不存在或已过期（rpcId: ${rpcId}）：只可应答本会话近期提交的 DSH 任务审批`,
    );
  const approvals = Array.isArray(op.pendingApprovals)
    ? op.pendingApprovals
    : [];
  const ap = approvals.find((a) => a.approvalId === approvalId);
  if (!ap) {
    const known =
      approvals.map((a) => `${a.approvalId}(${a.status})`).join(", ") || "无";
    throw new Error(
      `审批 ${approvalId} 不在任务 ${rpcId} 的待办列表（可能已被应答/超时）。已知: ${known}`,
    );
  }
  if (ap.status !== "pending") {
    throw new Error(
      `审批 ${approvalId} 已${ap.status === "answered" ? `应答（${ap.outcome}）` : ap.status}，勿重复应答`,
    );
  }

  const body = {
    type: "client-response",
    rpcId: ap.respondRpcId,
    result: {
      ok: true,
      value: { sessionId: ap.sessionId, approvalId, outcome },
    },
  };
  // 经总线 rpc.request method="respond" 发送（bridge 自环 /api/respond，client-response 信封
  // rpcId 路由 pending 表）；bridge 回投 { accepted }，校验 j.accepted 语义不变。
  const j = await callUnaryBus("respond", body);
  if (!j || !j.accepted) {
    throw new Error(
      `审批应答未接受（${(j && j.reason) || "unknown"}）：可能已超时或被其他方处理，任务侧会自行感知`,
    );
  }

  ap.status = "answered";
  ap.outcome = outcome;
  ap.answeredAt = new Date().toISOString();

  const verb = outcome === "allowed-once" ? "已放行" : "已拒绝";
  const reasonLine = ap.reason
    ? `（理由：${String(ap.reason).slice(0, 300)}）`
    : "";
  return {
    content: [
      {
        type: "text",
        text: `${verb}审批 ${approvalId} [${ap.toolName || "tool"}]${reasonLine}`,
      },
    ],
    details: {
      dsh: { rpcId, approvalId, toolName: ap.toolName, outcome, accepted: true },
    },
  };
}

export async function execute(input, ctx) {
  try {
    return await doExecute(input, ctx);
  } catch (e) {
    ctx.log?.error?.(
      "[dsh-hanako] dsh_approve failed:",
      e?.stack || e?.message || String(e),
    );
    throw e;
  }
}
