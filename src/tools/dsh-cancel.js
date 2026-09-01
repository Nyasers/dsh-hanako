// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/dsh-cancel.js — dsh 任务取消（止损）工具
// dsh_session 派发任务后只能等完成或超时，本工具提供主动取消。取消链路已收归宿主 task
// 体系（vX）：任务提交时注册宿主 task（type: 'dsh'，taskId = sessionId），取消经宿主
// task:abort → 插件 handler.abort → dsh session.cancel（Unary RPC 经总线 rpc.request 投递）——
// 宿主 Agent 侧开放 task 工具后本工具退役，当前保留但内部走宿主 task 协议。
// 兜底：任务未注册（register 失败/极早取消）或宿主无 dsh handler 时降级直连 session.cancel。
// cancel 后 dsh 会发 turn/end（reason.kind=aborted），事件循环判 outcome.stopReason === "aborted"
// → throw DSH_ABORTED → promise.catch 以 aborted 终态收尾（deferred 带「dsh_session 已取消」唤醒 Agent）。
// 任务状态零存储（jsonl 唯一事实源），取消必传 sessionId（dsh_session 回调/卡片 URL 取）直接定位会话；
// g.ops 运行期条目以 sessionId 键控（协调态最小化：{ cancelledRequested, activeApprovals }），
// cancel 凭 sessionId 直接 ops.get 取条目（极早 cancel 条目未建则跳过标记）。工具侧先标记
// cancelledRequested = true，防 cancel 导致 mux 断流时事件循环把取消误判为完成
// （dsh-run.js consume 末尾的取消兜底）。best-effort 止损：任务刚好自然完成时 cancel 的 accepted
// 无副作用（事件循环已终态，cancel 幂等）。

import { callUnaryBus } from "./lib/protocol.js";

export const name = "dsh_cancel";

export const description =
  "取消一个已派发的 DSH 任务（主动止损）：误派/卡死/不再需要结果时用。" +
  "传 sessionId（dsh_session 回调/卡片 URL 里带）直接取消；任务以 aborted 终态收尾并唤醒 Agent。" +
  "完整调用手册见 SKILL: skills/dsh-cancel/SKILL.md";

export const parameters = {
  type: "object",
  properties: {
    sessionId: {
      type: "string",
      description:
        "要取消的 DSH 会话 sessionId（dsh_run 异步回调/卡片 URL 里带；必填，取消一律显式传 sessionId，重启后仍有效）",
    },
  },
  required: ["sessionId"],
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
  if (!sessionId)
    throw new Error(
      "需要 sessionId（dsh_session 回调/卡片 URL 里带；取消一律显式传 sessionId）",
    );

  const g = globalThis.__dshHanako;
  // 运行期协调条目以 sessionId 键控：凭 sessionId 直接取条目（协调态最小化，无需遍历）；
  // 极早 cancel（条目未建）时 entry 为 null，跳过标记（语义不变）
  const entry = g?.ops?.get(sessionId) ?? null;
  const targetSessionId = sessionId;

  // 宿主 task 体系取消链路：task:abort → 插件 handler.abort → session.cancel（取消统一
  // 收归宿主 task 协议）。任务未注册（register 失败/极早取消）/宿主无 dsh handler 时
  // 降级直连 session.cancel 兜底（both 路径都标记 cancelledRequested）。
  let viaTask = false;
  const bus = g?.bus;
  if (bus && typeof bus.request === "function") {
    try {
      const r = await bus.request("task:abort", { taskId: targetSessionId });
      const st = r && r.result;
      viaTask =
        st === "aborted" ||
        st === "already_aborted" ||
        st === "already_finished";
    } catch {
      viaTask = false;
    }
  }
  if (!viaTask) {
    // 降级直连（未注册/无 handler/宿主不支持）：总线 Unary RPC（session.cancel）
    await callUnaryBus("session.cancel", { sessionId: targetSessionId });
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
