// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/list.ts — dshana list：DSH 子代理会话清单
//
// 只读查询（官方 session/list，需受管 runtime 就绪）；本项目特色。
import { execute as queryExecute } from "./subtool/query.ts";

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
