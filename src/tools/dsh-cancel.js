// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/dsh-cancel.js — dsh 任务取消（止损）工具
// dsh_run 派发任务后只能等完成或超时，本工具提供主动取消：调 dsh web host
// POST /api/session.cancel（client-request 信封，rpcId 回显校验）中断运行中的任务会话。
// cancel 后 dsh 会发 turn/end（reason.kind=aborted），事件循环判 outcome.stopReason === "aborted"
// → throw DSH_ABORTED → promise.catch 以 aborted 终态收尾（deferred fail 带「dsh_run 已取消」唤醒 Agent）。
// 任务状态零存储（jsonl 唯一事实源），取消优先按 sessionId 直接定位会话——
// sessionId 从 dsh_run 回调/卡片 URL 取；未传 sessionId 时兼容按 opId 从运行期协调状态（g.ops 残留，
// 仅存审批/取消状态 + sessionId）反查，miss 则报错提示传 sessionId。工具侧先标记
// cancelledRequested = true，防 cancel 导致 mux 断流时事件循环把取消误判为完成
// （dsh-run.js consume 末尾的取消兜底）。best-effort 止损：任务刚好自然完成时 cancel 的 accepted
// 无副作用（事件循环已终态，cancel 幂等）。

function hostBase() {
  const g = globalThis.__dshHanako;
  const web = g?.web;
  if (!web?.ready || !web.port) throw new Error("DSH web host 未就绪");
  return `http://127.0.0.1:${web.port}`;
}

export const name = "dsh_cancel";

export const description =
  "取消一个已派发的 DSH 任务（主动止损）：误派/卡死/不再需要结果时用。" +
  "优先传 sessionId（dsh_run 回调/卡片 URL 里带）直接取消，兼容传 opId（仅运行期残留可反查，推荐 sessionId）。" +
  "任务以 aborted 终态收尾并唤醒 Agent。完整调用手册见 SKILL: skills/dsh-cancel/SKILL.md";

export const parameters = {
  type: "object",
  properties: {
    sessionId: {
      type: "string",
      description:
        "要取消的 DSH 会话 sessionId（dsh_run 异步回调/卡片 URL 里带；推荐传此参数，重启后仍有效）",
    },
    opId: {
      type: "string",
      description:
        "要取消的 DSH 任务的 opId（dsh_run 提交时返回；仅本插件进程运行期残留可反查会话，任务结束即失效，优先用 sessionId）",
    },
  },
  required: [],
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "external_api",
    summary:
      "向 DSH web host 请求取消一个运行中的 DSH 任务会话（session.cancel），中断 DSH agent",
    ruleId: "dsh-hanako-cancel",
  }),
};

async function doExecute(input, ctx) {
  const sessionId = String(input.sessionId ?? "").trim();
  const opId = String(input.opId ?? "").trim();
  if (!sessionId && !opId)
    throw new Error(
      "需要 sessionId 或 opId 至少一个（推荐传 sessionId：dsh_run 回调/卡片 URL 里带）",
    );

  const g = globalThis.__dshHanako;
  // 运行期协调状态条目（op Map 退役后仅存审批/取消状态 + sessionId，不含任务快照）
  let entry = null;
  if (opId && g?.ops) entry = g.ops.get(opId) || null;
  let targetSessionId = sessionId;
  if (!targetSessionId) {
    if (!entry || !entry.sessionId) {
      throw new Error(
        `op 不存在或已过期（${opId}）：任务状态已不保存在插件内存（jsonl 唯一事实源），请显式传 sessionId（dsh_run 回调/卡片 URL 里带）`,
      );
    }
    targetSessionId = String(entry.sessionId);
  }

  const base = hostBase();
  const rpcId = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${base}/api/session.cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId,
      method: "session.cancel",
      payload: { sessionId: targetSessionId },
    }),
  });
  if (!res.ok) throw new Error(`/api/session.cancel HTTP ${res.status}`);
  const full = await res.json();
  if (!full || full.rpcId !== rpcId)
    throw new Error("/api/session.cancel rpcId 不匹配");
  if (!full.result?.ok) {
    const e = full.result?.error || {};
    throw new Error(
      `取消请求未接受（${e.code || "unknown"} ${e.message || ""}）`,
    );
  }

  // 标记：防 mux 断流时事件循环把取消误判为完成（dsh-run.js consume 末尾取消兜底读取该标记）
  if (entry) entry.cancelledRequested = true;

  const sid = String(targetSessionId);
  return {
    content: [
      {
        type: "text",
        text: `已请求取消任务（会话 ${sid.slice(0, 12)}…）：DSH agent 会收到中断，任务将尽快以 aborted 终态收尾`,
      },
    ],
    details: {
      dsh: {
        opId: opId || null,
        sessionId: sid,
        accepted: true,
        status: "cancelling",
      },
    },
  };
}

export async function execute(input, ctx) {
  try {
    return await doExecute(input, ctx);
  } catch (e) {
    ctx.log?.error?.(
      "[dsh-hanako] dsh_cancel failed:",
      e?.stack || e?.message || String(e),
    );
    throw e;
  }
}
