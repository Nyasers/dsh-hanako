// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/plugins/provider/lib/identity.js — 模型请求身份判定
// （《DSHana 调用 Hana 模型接口指南》§3/§5）
//
// 身份参数二选一，且不能同时传；本 adapter 只可能给出两种形态：
//   · 有会话→任务映射**且任务仍活动**（dshana_session 创建/续写）→ { taskId }：
//     保留任务绑定，结果沿 task-bridge 回投到发起它的 Hana 会话；
//   · App 身份 → {}：callToken 与 taskId 都不传，宿主据此把请求归属 App 自己。
// 注意 models.stream **不接受** scope 字段（scope:"app" 是 models.utility 的参数）。
//
// 三态判定（2026-09-12 她定调：**App 身份仅限“用户直接在 WebUI 使用”**）：
//   ① 无映射            ⇒ App 身份。**只有**这里与下一条才允许 App 身份。
//   ② 映射在 + ended    ⇒ App 身份（任务已终结，用户接着在 WebUI 里跑——事实，不是降级）
//   ③ 映射在 + 未终结   ⇒ { taskId }（必须：这是我们建的会话，绑定不能丢）
//   ④ 映射在但读不出    ⇒ **报错**（code TASK_MAP_BROKEN → 上层转 LlmError）
// ④ 是关键：以前“文件读不到”一律降级成 App 身份，等于把“状态丢了”伪装成“用户会话”，
// 对一条还活着的任务就是丢掉绑定、结果不回投——静默失败。
//
// 判定依据：<dataDir>/dshana/taskmaps/<sessionId>.json（src/lib/task-map.js 写的单一事实源）。
// 任务终态只标记 ended，不删文件（删了就分不出 ① 与 ④）。
//
// 明确不做的事：拿到失效或归属不正确的 taskId 时，**不得**捕获错误、删掉身份
// 参数重新调用。那种情况必须让宿主报错并原样上抛，由 DSH 的错误处理呈现给对应会话。
// 本模块只回答“这条会话的身份是什么”，不承担任何降级重试。
//
// 纯函数 + 零宿主/零 DSH 依赖（cordis 构建树不 import src/lib），可被 node --test 直接 import。

import { readTaskMap } from "./taskmap.js";

/**
 * @param {string|null} dataDir 受管 runtime 进程的 DSHANA_HOME（main.js 注入）
 * @param {string|null} sessionId DSH 会话 id（llm options.sessionId）
 * @returns {{ identity: { taskId?: string }, source: "task" | "app", reason?: string }}
 * @throws {Error} code `TASK_MAP_BROKEN`：会话任务标记存在但读不出（状态丢了，显式失败）
 */
export function resolveModelIdentity(dataDir, sessionId) {
  // ① 无标记 ⇒ 不是我们创建的会话（用户在 WebUI 自建）⇒ App 身份。
  const map = dataDir && sessionId ? readTaskMap(dataDir, sessionId) : null;
  if (!map) return { identity: {}, source: "app", reason: "unowned-session" };
  // ② 我们建的，但任务已终结（用户接着在 WebUI 里跑）⇒ App 身份。
  if (map.ended) return { identity: {}, source: "app", reason: "task-ended" };
  // ③ 我们建的、任务活动 ⇒ 必须带 taskId（失效由宿主报错，不降级）。
  return { identity: { taskId: map.taskId }, source: "task" };
}
