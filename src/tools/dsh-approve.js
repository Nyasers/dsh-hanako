// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/dsh-approve.js — dsh 审批应答工具
// dsh 会话审批挂起（approval/policy=ask 触发 approval/requested）时，dsh_run 任务的事件
// 循环会把审批上下文存进 op 快照（含 respond 路由所需的 rpcId），并通过宿主 deferred
// 通道通知 Agent。Agent 收到通知后调用本工具应答：allowed-once 放行单次 / rejected 拒绝。
// 内部调 dsh web host POST /api/respond（client-response 信封，rpcId 路由 pending 表）。

function hostBase() {
  const g = globalThis.__dshHanako;
  const web = g?.web;
  if (!web?.ready || !web.port)
    throw new Error("dsh web host 未就绪（有审批挂起说明任务正在运行）");
  return `http://127.0.0.1:${web.port}`;
}

export const name = "dsh_approve";

export const description =
  "应答 dsh 任务挂起的权限审批（approval/requested）：allowed-once=放行该次请求 / rejected=拒绝。" +
  "opId 与 approvalId 来自审批通知；应答前评估通知里的 toolName 与 reason（命令原文）决定放行或拒绝。" +
  "无人应答也可在 dsh Web UI 人工处理。完整调用手册见 SKILL: skills/dsh-approve/SKILL.md";

export const parameters = {
  type: "object",
  properties: {
    opId: {
      type: "string",
      description: "审批所属 dsh 任务的 opId（审批通知里带）",
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
  required: ["opId", "approvalId"],
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "external_api",
    summary:
      "向 dsh web host 提交审批应答（allowed-once/rejected），放行或拒绝 dsh agent 的越界权限请求",
    ruleId: "dsh-hanako-approve",
  }),
};

async function doExecute(input, ctx) {
  const opId = String(input.opId ?? "").trim();
  const approvalId = String(input.approvalId ?? "").trim();
  const outcome = input.outcome === "rejected" ? "rejected" : "allowed-once";
  if (!opId || !approvalId) throw new Error("opId 与 approvalId 必填");

  const g = globalThis.__dshHanako;
  const op = g?.ops?.get(opId);
  if (!op)
    throw new Error(
      `op 不存在或已过期（${opId}）：只可应答本会话近期提交的 dsh 任务审批`,
    );
  const approvals = Array.isArray(op.pendingApprovals)
    ? op.pendingApprovals
    : [];
  const ap = approvals.find((a) => a.approvalId === approvalId);
  if (!ap) {
    const known =
      approvals.map((a) => `${a.approvalId}(${a.status})`).join(", ") || "无";
    throw new Error(
      `审批 ${approvalId} 不在任务 ${opId} 的待办列表（可能已被应答/超时）。已知: ${known}`,
    );
  }
  if (ap.status !== "pending") {
    throw new Error(
      `审批 ${approvalId} 已${ap.status === "answered" ? `应答（${ap.outcome}）` : ap.status}，勿重复应答`,
    );
  }

  const base = hostBase();
  const body = {
    type: "client-response",
    rpcId: ap.rpcId,
    result: {
      ok: true,
      value: { sessionId: ap.sessionId, approvalId, outcome },
    },
  };
  const res = await fetch(`${base}/api/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/api/respond HTTP ${res.status}`);
  const j = await res.json();
  if (!j.accepted) {
    throw new Error(
      `审批应答未接受（${j.reason || "unknown"}）：可能已超时或被其他方处理，任务侧会自行感知`,
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
      dsh: { opId, approvalId, toolName: ap.toolName, outcome, accepted: true },
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
