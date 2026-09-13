// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/shared/card.ts — 会话流卡字面量（open / reply 的返回值 details.card）
//
// 宿主契约（server 0.951.4 bundle 实证，见 APPS.md「形式归属」）：工具结果的 details.card
// 被运行时透传成流内 plugin_card 块，随后由卡 iframe 加载 route。三条硬要求：
//   · pluginId 必填且必须等于本工具的归属 App id（不等于会被当场丢掉）；
//   · route 必须是宿主能解析到本 App 的写法——App 卡走 ui/ 静态树
//     （/api/apps/<appId>/ui<route>），不是 ctx.routes 的 /routes/ 命名空间；
//   · aspectRatio 要有限正数（渲染期算成 "n / 1" 的比例占位）。
// 卡页需要的数据全压在查询串里（提交时快照，卡页不做轮询），?ts= 防缓存；
// 卡页只向 App 后端做一次 card-state 取数，换个更准的状态行。
import { APP_ID } from "../../lib/boot-state.ts";

/** 卡页文件名（App ui/ 静态树内）。 */
export const SESSION_CARD_ROUTE = "/card.html";

/** 会话流卡的动作面（与 ui/card.html 的 WHAT 表一致）。 */
export type SessionCardAction = "open" | "reply";

/** 动作 → 卡面文案（与 ui/card.html 的 WHAT 表保持一致）。 */
const WHAT: Record<SessionCardAction, string> = { open: "子代理已开启", reply: "续发消息已提交" };

/** sessionCard 的入参：提交成功后拿到的定位信息。 */
export interface SessionCardInput {
  action: SessionCardAction;
  sessionId: string;
  taskId: string;
  cwd?: string | null;
}

/** 宿主流内 plugin_card 块的字面量（三条硬要求见文件头）。 */
export interface SessionCard {
  pluginId: string;
  route: string;
  title: string;
  description: string;
  aspectRatio: number;
}

/** 会话流卡字面量。 */
export function sessionCard({ action, sessionId, taskId, cwd }: SessionCardInput): SessionCard {
  const now = Date.now();
  const params = [
    "ts=" + now,
    "at=" + now,
    "action=" + encodeURIComponent(action),
    "sid=" + encodeURIComponent(sessionId),
    "status=running",
  ];
  if (cwd) params.push("cwd=" + encodeURIComponent(cwd));
  const what = WHAT[action] || WHAT.open;
  return {
    pluginId: APP_ID,
    route: SESSION_CARD_ROUTE + "?" + params.join("&"),
    title: "DSHana " + what,
    description: sessionId.slice(0, 12) + "… · " + (cwd || "未指定工作目录") + " · taskId " + taskId,
    aspectRatio: 4,
  };
}
