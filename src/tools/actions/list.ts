// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/actions/list.ts — dshana list：DSH 子代理会话清单
//
// 只读查询（官方 session/list，需受管 runtime 就绪）。
//
// 状态：**冻结禁用（2026-09-13）**。源码保留，但不注册到工具面，也不做 cursor / sourceId
// 那套“先 list 发现再操作”的配套语义（见 specs/current/sample-align 裁决 2c）。
//
// 理由：任务绑定语义下会话靠句柄（宿主 taskId）定位；“查任务”这件事由**宿主提供给 Agent 的
// 内置任务查询工具**承担（模型侧，本环境是 check_pending_tasks）——dshana 的 open/reply 建的
// 就是本会话的后台任务，本来就出现在那份清单里，不需要本工具再开一扇只读门。
//
// 要重新启用本模块：在 src/tools/index.ts 的 import、ACTIONS 与 description 里加回即可。
import { execute as queryExecute } from "#/tools/shared/query.ts";
import type { ToolCtx } from "#/types/host.ts";
import type { ToolInputBase, ToolResult } from "#/tools/shared/types.ts";

/** list 入参（冻结期保留形状，重新启用时直接可用）。 */
export interface ListInput extends ToolInputBase {
  limit?: number;
}

export const command = "list";
export const summary = "列出 DSH 子代理会话清单（需 DSH 运行时在线；按最近提交倒序）";
export const readOnly = true;

export const fields = {
  limit: {
    type: "integer",
    description: "返回条数（按 lastPromptAt 最新在前，取最近 N 条）：默认 10，有效范围 1~100，超出自动收敛到边界",
  },
};
export const required = [];

export async function run(input: ListInput, ctx: ToolCtx): Promise<ToolResult> {
  return queryExecute({ ...input, action: "list" }, ctx);
}
