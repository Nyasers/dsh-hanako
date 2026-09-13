// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/index.ts — dshana 工具统一入口（一个插件一个同名工具 + subcommand）
//
// 形态：一个插件只暴露一个与插件同名的工具（name = "dshana"），动作以顶层 action
// （subcommand）区分；parameters 用 oneOf 为每个子命令单独声明参数字段集，模型的参数面因此
// 不串味（open 看不到 approvalId）。每个子命令是本目录 actions/ 下的一个独立模块，本文件只做
// 装配（name/description/parameters）与分发（execute）。
//
// 每个 action 模块导出同一组字段：
//   command  subcommand 名（顶层 action 取值，全局唯一）
//   summary  一句话语义（汇总进 description）
//   fields   本子命令的 JSON Schema properties（不含 action）
//   required 必填字段（不含 action）
//   readOnly 只读动作（不产生副作用）
//   run(input, ctx, deps)  执行体（deps 仅单测注入提交链，线上为 undefined）
//
// 语义对齐 subagent：open ≈ subagent（创建即带任务）、reply ≈ subagent_reply（按句柄续）、
// close ≈ subagent_close（收工）；get / approve 是本项目特色（subagent 没有）。
// 调用模型：句柄默认（taskId/approvalId，按宿主记录的来源会话校验归属）、凭证显式
// （sessionId = 我要跨对话）。
//
// 数据目录取 ctx.dataDir（宿主 app-data/<id>/）；工具名以本文件 name 为单一事实源
// （v2 注册不自动加前缀，重名会被宿主当场拒掉）。
import * as openAction from "./actions/open.ts";
import * as replyAction from "./actions/reply.ts";
import * as closeAction from "./actions/close.ts";
import * as getAction from "./actions/get.ts";
import * as approveAction from "./actions/approve.ts";
// actions/list.ts（会话清单）：**源码保留，暂不注册**——任务绑定语义下会话靠句柄定位，不需要
// list 发现路径（理由见该文件头注释与 specs/current/sample-align 的 W4 收缩口径）。
// 要重新启用：把 list 的 import、ACTIONS 里的条目、description 的列举一并加回。

/** subcommand 注册表（顺序即 description 的列举顺序）。 */
const ACTIONS = [openAction, replyAction, closeAction, getAction, approveAction];

export const name = "dshana";

export const description =
  "DSH 子代理（一个插件一个同名工具，CLI subcommand 式调用：action 选动作）：" +
  "open=开一个 DSH 子代理并交首件活（task/cwd 必填；后台执行，结果回到本会话，之后用返回的 taskId 续/关）；" +
  "reply=往同一个子代理续发消息（task 必填；taskId 句柄或 sessionId 凭证二选一）；" +
  "close=取消正在跑的任务（只停本工作，不影响共享 runtime 上的其他会话）；" +
  "get=回看某一轮最终结论；approve=应答挂起审批（approvalId 必填）。" +
  "用法心智同 subagent：开、续、关；本项目另有 get/approve 两个特色动作。" +
  "调用模型：句柄默认（taskId/approvalId，按宿主记录的来源会话校验归属）、凭证显式（sessionId = 我要跨对话）。" +
  "完整调用手册见 SKILL: skills/dsh-session/SKILL.md";

/** 参数 Schema：顶层 action + oneOf 分支（每个子命令独立的参数字段集）。 */
export const parameters = {
  type: "object",
  oneOf: ACTIONS.map((mod) => ({
    type: "object",
    additionalProperties: false,
    required: ["action", ...mod.required],
    properties: { action: { const: mod.command }, ...mod.fields },
  })),
};

/**
 * action 实现体。deps 只给单测注入提交链（open/reply；缺省用真实 submitDshTask）；
 * 线上路径经 execute 调用时 deps 为 undefined，行为不变。
 */
export async function doExecute(input, ctx, deps) {
  const action = String((input && input.action) || "").trim();
  const mod = ACTIONS.find((m) => m.command === action);
  if (!mod) {
    throw new Error(
      "action 必须是 " + ACTIONS.map((m) => m.command).join(" / ") + "（收到 " + action + "）",
    );
  }
  return mod.run(input, ctx, deps);
}

export async function execute(input, ctx) {
  try {
    return await doExecute(input, ctx, null);
  } catch (e) {
    // ctx 为 App apply 注入的工具上下文（见 index.ts makeToolCtx：统一日志出口）；缺失时静默（防御）
    ctx?.log?.error?.("[dshana] dshana failed:", e?.stack || e?.message || String(e));
    throw e;
  }
}
