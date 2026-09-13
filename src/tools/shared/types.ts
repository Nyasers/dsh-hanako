// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/shared/types.ts — 工具面共享类型（入参基形与调用上下文）
//
// 一个插件一个同名工具：所有 action 共用同一份宿主投递形状（input + context），各自的专属
// 字段在 actions/<action>.ts 的 fields 里声明。这里只放跨 action 共用的那部分。

/** 宿主随工具调用投递的调用上下文（context.sessionPath 是归属校验的会话坐标）。 */
export interface ToolCallContext {
  /** 发起本次工具调用的 Hana 会话路径（按钮/卡片通道可能缺省）。 */
  sessionPath?: string | null;
  /** 宿主给的调用令牌（受限作用域任务需要）。 */
  callToken?: string;
  /** 宿主可能附加的其它字段：保持开放，避免漏抄一项就静默降级。 */
  [key: string]: unknown;
}

/** 工具返回（契约在 src/types/tool.ts；这里转出去，让 tools/ 只认一个 shared 入口）。 */
export type { ToolResult } from "../../types/tool.ts";

/** 所有 action 入参的公共部分：句柄三选一，或显式凭证。 */
export interface ToolInputBase {
  context?: ToolCallContext;
  /** 显式凭证路径：直接用，跳过归属校验（跨对话操作）。 */
  sessionId?: string;
  /** 句柄路径：宿主任务 id（本工具投递出去的那次任务）。 */
  taskId?: string;
  /** 句柄路径：审批 id。 */
  approvalId?: string;
}
