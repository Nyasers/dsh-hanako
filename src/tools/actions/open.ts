// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/actions/open.ts — dshana open：开一个 DSH 子代理并交首件活
//
// 语义对齐 subagent 的「创建即带任务」：新建 DSH 会话 + 立即提交首条 prompt（task/cwd 必填），
// 固定异步，结果作为后台结果回投来源会话。提交链见 lib/session-run.ts
// （ctx.tasks.create → 受管 runtime 就绪 → session.create/selectModel/prompt → task-map 映射）。
//
// 模块契约（六个 action 模块共用，见 tools/index.ts）：导出 command / summary / fields /
// required / readOnly / run；run(input, ctx, deps) 中 deps 仅单测注入提交链。
import { submitDshTask } from "#/lib/session-run.ts";
import { sessionCard } from "#/tools/shared/card.ts";
import type { ToolCtx } from "#/types/host.ts";
import type { ToolInputBase, ToolResult } from "#/tools/shared/types.ts";

/** open 入参：task/cwd 必填（语义对齐 subagent 的“创建即带任务”）。 */
export interface OpenInput extends ToolInputBase {
  task: string;
  cwd: string;
  label?: string;
  timeout?: number;
  agentPreset?: string;
  reasoningEffort?: string;
  provider?: string;
  model?: string;
}

/** 提交链注入面（仅单测用；线上为 undefined）。 */
export interface SubmitDeps {
  submitDshTask?: typeof submitDshTask;
}

export const command = "open";
export const summary = "开一个 DSH 子代理并交首件活（task/cwd 必填；后台执行，结果回到本会话）";
export const readOnly = false;

export const fields = {
  task: { type: "string", description: "交给子代理的首件活（任务描述/消息文本）" },
  cwd: {
    type: "string",
    description:
      "沙箱工作目录（bash 与文件系统工具的活动范围，绝对路径；无 defaultCwd 回退，每次调用显式指定）",
  },
  label: { type: "string", description: "可选显示名（便于在清单与结果通知里辨认这个子代理）" },
  timeout: { type: "number", description: "任务超时（秒），缺省用 App 设置 defaultTimeoutSec" },
  agentPreset: { type: "string", description: "agent 预设（standard/ptc/cordis/minimal）" },
  reasoningEffort: { type: "string", description: "推理强度（off/high/max）" },
  provider: { type: "string", description: "显式 provider（显式即成为 dsh 新默认）" },
  model: { type: "string", description: "显式 model id（与 provider 一起传时覆盖 dsh 默认）" },
};
export const required = ["task", "cwd"];

export async function run(input: OpenInput, ctx: ToolCtx, deps?: SubmitDeps): Promise<ToolResult> {
  const callToken = (input && input.context && input.context.callToken) || "";
  // 提交面（deps 可注入以单测 open 分支；缺省用真实 submitDshTask）返回 { promise, ready }：
  // ready 在 prompt 被 DSH 接受后 resolve 定位键（sessionId/rpcId/taskId），提交阶段失败则
  // reject（错误上抛给工具面）；promise 是后台生命周期（等 task 终态、释放串行锁），本处不 await。
  const submit = deps && typeof deps.submitDshTask === "function" ? deps.submitDshTask : submitDshTask;
  const { ready } = submit({ action: "create", input, callToken, log: ctx && ctx.log });
  const loc = await ready;
  const sid = String(loc.sessionId || "");
  const rpc = String(loc.rpcId || "");
  const text =
    "已开启 DSH 子代理（open）：taskId " + loc.taskId + "（后续续/关优先用它），sessionId " + sid + "，rpcId " + rpc +
    (loc.cwd ? "，cwd " + loc.cwd : "") +
    "。任务在后台执行，完成/失败会作为后台结果投递到本会话；要看执行过程或最终结论用 dshana action=get（taskId " +
    loc.taskId + "）。";
  return {
    content: [{ type: "text", text }],
    details: {
      dsh: {
        action: "open",
        sessionId: sid,
        rpcId: rpc,
        taskId: loc.taskId,
        status: "running",
        cwd: loc.cwd || undefined,
      },
      card: sessionCard({ action: "open", sessionId: sid, taskId: loc.taskId, cwd: loc.cwd }),
    },
  };
}
