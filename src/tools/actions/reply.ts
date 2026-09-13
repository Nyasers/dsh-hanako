// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/actions/reply.ts — dshana reply：往同一个 DSH 子代理续发消息
//
// 语义对齐 subagent_reply（用句柄续同一个实例）：task 必填；目标二选一——taskId 句柄
// （open/reply 返回，工具自己解析会话并校验归属）或 sessionId 凭证（显式 = 我要跨对话）。
// 同会话多次 reply 由 App 侧串行化（lib/session-serialize.ts），按提交顺序排队。
import { submitDshTask } from "../../lib/session-run.ts";
import { resolveTarget } from "../shared/target.ts";
import { sessionCard } from "../shared/card.ts";

export const command = "reply";
export const summary = "往同一个 DSH 子代理续发消息（task 必填；taskId 句柄或 sessionId 凭证二选一）";
export const readOnly = false;

export const fields = {
  task: { type: "string", description: "续发的消息文本" },
  taskId: {
    type: "string",
    description: "句柄路径（open/reply 返回值里的宿主 task id）：工具自己解析会话并按宿主记录的来源会话校验归属",
  },
  sessionId: {
    type: "string",
    description: "凭证路径（形如 session-<uuid>）：显式传入即视为“我要跨对话操作”，跳过归属校验",
  },
  timeout: { type: "number", description: "任务超时（秒），缺省用 App 设置 defaultTimeoutSec" },
  agentPreset: { type: "string", description: "agent 预设（standard/ptc/cordis/minimal）" },
  reasoningEffort: { type: "string", description: "推理强度（off/high/max）" },
  provider: { type: "string", description: "显式 provider（显式即成为 dsh 新默认）" },
  model: { type: "string", description: "显式 model id（与 provider 一起传时覆盖 dsh 默认）" },
};
export const required = ["task"];

export async function run(input, ctx, deps) {
  // 目标解析：taskId 走句柄路径（反查 + 归属校验），sessionId 走凭证路径（原样使用）
  const target = await resolveTarget(input, ctx);
  const callToken = (input && input.context && input.context.callToken) || "";
  const submit = deps && typeof deps.submitDshTask === "function" ? deps.submitDshTask : submitDshTask;
  const { ready } = submit({
    action: "send",
    input: { ...input, sessionId: target.sessionId },
    callToken,
    log: ctx && ctx.log,
  });
  const loc = await ready;
  const sid = String(loc.sessionId || target.sessionId);
  const rpc = String(loc.rpcId || "");
  const text =
    "已向 DSH 子代理续发消息（reply）：taskId " + loc.taskId + "，sessionId " + sid + "，rpcId " + rpc +
    (loc.cwd ? "，cwd " + loc.cwd : "") +
    "。任务在后台执行，完成/失败会作为后台结果投递到本会话；要看执行过程或最终结论用 dshana action=get（taskId " +
    loc.taskId + "）。";
  return {
    content: [{ type: "text", text }],
    details: {
      dsh: {
        action: "reply",
        sessionId: sid,
        rpcId: rpc,
        taskId: loc.taskId,
        status: "running",
        cwd: loc.cwd || undefined,
      },
      card: sessionCard({ action: "reply", sessionId: sid, taskId: loc.taskId, cwd: loc.cwd }),
    },
  };
}
