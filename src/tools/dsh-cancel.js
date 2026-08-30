// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/dsh-cancel.js — dsh 任务取消（止损）工具
// dsh_run 派发任务后只能等完成或超时，本工具提供主动取消：经总线 rpc.request 调 dsh web host
// session.cancel（callUnaryBus，总线优先/HTTP 兜底；rpcId 回显校验语义保留——总线路径由
// bridge 回投的 result 承载，宿主侧校验 reqId 配对 + result.ok）中断运行中的任务会话。
// cancel 后 dsh 会发 turn/end（reason.kind=aborted），事件循环判 outcome.stopReason === "aborted"
// → throw DSH_ABORTED → promise.catch 以 aborted 终态收尾（deferred fail 带「dsh_run 已取消」唤醒 Agent）。
// 任务状态零存储（jsonl 唯一事实源），取消必传 sessionId（dsh_run 回调/卡片 URL 取）直接定位会话；
// g.ops 运行期条目以任务 rpcId 键控，cancel 只有 sessionId 时遍历条目找 sessionId 匹配项
// （条目极少——仅运行中任务，遍历可忽略；极早 cancel 条目未建则跳过标记）。工具侧先标记
// cancelledRequested = true，防 cancel 导致 mux 断流时事件循环把取消误判为完成
// （dsh-run.js consume 末尾的取消兜底）。best-effort 止损：任务刚好自然完成时 cancel 的 accepted
// 无副作用（事件循环已终态，cancel 幂等）。

import { callUnaryBus } from "./lib/protocol.js";

export const name = "dsh_cancel";

export const description =
  "取消一个已派发的 DSH 任务（主动止损）：误派/卡死/不再需要结果时用。" +
  "传 sessionId（dsh_run 回调/卡片 URL 里带）直接取消；任务以 aborted 终态收尾并唤醒 Agent。" +
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
      "需要 sessionId（dsh_run 回调/卡片 URL 里带；取消一律显式传 sessionId）",
    );

  const g = globalThis.__dshHanako;
  // 运行期协调条目以任务 rpcId 键控，cancel 只有 sessionId：遍历 g.ops 找该会话条目
  // （条目极少——仅运行中任务，遍历可忽略）；极早 cancel（条目未建）时 entry 为 null，跳过标记
  let entry = null;
  for (const e of g?.ops?.values() ?? []) {
    if (e.sessionId === sessionId) {
      entry = e;
      break;
    }
  }
  const targetSessionId = sessionId;

  // 总线 Unary RPC（session.cancel）：rpcId 回显校验语义保留——总线路径下由 bridge 回投的
  // result 承载（reqId 配对 + result.ok），降级走 HTTP 时与改造前直连行为一致。
  await callUnaryBus("session.cancel", { sessionId: targetSessionId });

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
