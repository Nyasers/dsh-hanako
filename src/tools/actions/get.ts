// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/actions/get.ts — dshana get：回看某个子代理最近一轮的最终结论
//
// 只读查询，取数走官方查询面（shared/query.ts：session/list 定 asOfSeq → session/page
// 取尾部一窗）；本项目特色——subagent 只能等结果回投，回看不到过程与结论。
import { execute as queryExecute } from "../shared/query.ts";
import { resolveTarget } from "../shared/target.ts";

export const command = "get";
export const summary = "回看某个 DSH 子代理最近一轮的最终结论（taskId 句柄或 sessionId 凭证）";
export const readOnly = true;

export const fields = {
  taskId: {
    type: "string",
    description: "句柄路径（默认）：open/reply 返回值里的宿主 task id，工具自己解析会话并校验归属",
  },
  sessionId: { type: "string", description: "凭证路径（形如 session-<uuid>）：显式传入即视为“我要跨对话操作”" },
};
export const required = [];

export async function run(input, ctx) {
  // 句柄优先（taskId）→ 解析出 DSH 会话并校验归属；sessionId 为显式凭证路径
  const target = await resolveTarget(input, ctx);
  return queryExecute({ ...input, action: "get", sessionId: target.sessionId }, ctx);
}
