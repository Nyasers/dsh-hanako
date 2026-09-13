// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/actions/list.ts — dshana list：DSH 子代理会话清单
//
// 只读查询（官方 session/list，需受管 runtime 就绪）。
//
// 状态：**冻结禁用（2026-09-13）**。源码保留，但不注册到工具面，也不做 cursor / sourceId
// 那套“先 list 发现再操作”的配套语义（见 specs/current/sample-align 裁决 2c）。
// 任务绑定语义下会话靠句柄定位；即便需要“列会话”，也改走**宿主内置的 `ctx.tasks.list` 通道**：
// 按任务记录的 `metadata.dsh` 反查本 App 发起的实例（`parentSessionPath` 天然带会话归属），
// 不再向 DSH 问 session/list。要重新启用本模块：在 src/tools/index.ts 的 import、ACTIONS
// 与 description 里加回即可。
import { execute as queryExecute } from "../shared/query.ts";

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

export async function run(input, ctx) {
  return queryExecute({ ...input, action: "list" }, ctx);
}
