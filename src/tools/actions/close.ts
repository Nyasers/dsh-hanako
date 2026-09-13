// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/actions/close.ts — dshana close：取消这个子代理正在跑的任务
//
// 语义对齐 subagent_close 的「收工」，但只到「取消当前活动工作」为止：DSH 会话是持久的、
// 随时可 resume，没有实例槽位这回事，所以这里不假装释放实例。只停本工作，不影响共享
// runtime 上的其他会话。取消编排见 lib/cancel-chain.ts（写 cancel 标记 → DSH session.cancel
// → 等 DSH 真中止后宿主任务 canceled；未确认则升级宿主 cancel 并如实告知）。
import { cancelSessionWork } from "../../lib/cancel-chain.ts";
import { resolveTarget } from "../shared/target.ts";

export const command = "close";
export const summary = "取消这个 DSH 子代理正在跑的任务（只停本工作，不影响共享 runtime 上的其他会话）";
export const readOnly = false;

export const fields = {
  taskId: {
    type: "string",
    description: "句柄路径（默认）：open/reply 返回值里的宿主 task id，工具自己解析会话并校验归属",
  },
  sessionId: { type: "string", description: "凭证路径（形如 session-<uuid>）：显式传入即视为“我要跨对话操作”" },
};
export const required = [];

export async function run(input, ctx) {
  const target = await resolveTarget(input, ctx);
  const sessionId = target.sessionId;
  const out = await cancelSessionWork({ sessionId, reason: "user", log: ctx && ctx.log });
  const sid = String(out.sessionId || sessionId);
  let text;
  let status = "cancelling";
  if (out.status === "canceled") {
    status = "canceled";
    text = out.escalated
      ? "已取消任务（session " + sid.slice(0, 12) +
        "…）：DSH 未在确认窗口内确认中止，宿主任务已升级标记 canceled——若 DSH 仍显示运行中请重试取消或检查 runtime 日志"
      : "任务已取消（session " + sid.slice(0, 12) + "…）：DSH 已确认中止，结果/终态通知将投递到发起会话";
  } else if (out.status === "no-active-work") {
    status = "idle";
    text = "会话 " + sid.slice(0, 12) + "… 当前没有运行中的 DSH 任务（映射为空）；已发送幂等 session.cancel，无副作用";
  } else if (out.status === "already-requested") {
    text = "该会话已有取消请求在处理中（reason=" + String(out.reason || "user") + "），等待 DSH 中止确认；勿重复取消";
  } else if (out.status === "dsh-rpc-failed") {
    status = "dsh-unreachable";
    text = "已请求取消（session " + sid.slice(0, 12) + "…），但 DSH 侧取消调用失败：" +
      String(out.dshError || "unknown") + "。宿主任务将以取消兜底终结；若 DSH 进程仍运行请检查 runtime 日志";
  } else {
    text = "已请求取消（session " + sid.slice(0, 12) +
      "…）：DSH 正在中止（模型/工具/终端），终态将随后台任务通知确认——canceled 只在 DSH 真中止后标记";
  }
  return {
    content: [{ type: "text", text }],
    details: {
      dsh: {
        action: "close",
        sessionId: sid,
        taskId: out.taskId || undefined,
        status,
        reason: out.reason || "user",
        dshAccepted: Boolean(out.dshAccepted),
      },
    },
  };
}
