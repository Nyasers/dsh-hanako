// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/actions/list.ts — dshana list：DSH 子代理会话清单
//
// 只读查询（官方 session/list，需受管 runtime 就绪）；本项目特色。
//
// 状态：**源码保留，但暂不注册到工具面**（2026-09-13）。任务绑定语义下会话靠句柄定位，
// 不需要 list 发现路径；此文件保留以备将来需要“跨对话找回旧会话”时再导入（见
// specs/current/sample-align W4 的收缩口径）。要重新启用：在 src/tools/index.ts 的 ACTIONS
// 与 description 里加回本模块即可。
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
