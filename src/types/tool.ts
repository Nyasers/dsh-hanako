// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/types/tool.ts — 工具返回契约（宿主透传前的形态）
//
// 放公共类型区而不是 tools/：lib 层的动作实现（approve-respond、tools/shared/query）也直接
// 构造它，靠 types/ 收口可免掉 lib → tools 的反向依赖。
// 工具**入参**的公共形状见 tools/shared/types.ts（那是「模型给什么」）。

/** 工具返回：content 透传给模型，details 供流内卡与诊断。
 *  ok / error 是我们的约定槽：工具自己判定成败（宿主按 content 透传，不消费这两个字段）。 */
export interface ToolResult {
  ok?: boolean;
  error?: string;
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}
