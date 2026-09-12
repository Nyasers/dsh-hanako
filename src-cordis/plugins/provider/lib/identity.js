// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/plugins/provider/lib/identity.js — 模型请求身份判定
// （《DSHana 调用 Hana 模型接口指南》§3/§5）
//
// 身份参数二选一，且不能同时传；本 adapter 只可能给出两种形态：
//   · 有会话→任务映射（dshana_session 创建/续写、任务仍在活动）→ { taskId }：
//     保留任务绑定，结果沿 task-bridge 回投到发起它的 Hana 会话；
//   · 无映射（DSH Web UI 自建的会话，或委派任务已终结、用户继续在 Web UI 里跑）
//     → {}：callToken 与 taskId 都不传，宿主据此把请求归属 App 自己。
// 注意 models.stream **不接受** scope 字段（scope:"app" 是 models.utility 的参数）。
//
// 判定依据只有一处：<dataDir>/dshana/taskmaps/<sessionId>.json（src/lib/task-map.js 写的
// 单一事实源）。任务终态时 task-bridge / session-run 会删除该文件，所以"映射还在"≈"任务
// 仍活动"；被 preune 的旧映射同样落到 App 身份。
//
// 明确不做的事（指南 §5）：拿到失效或归属不正确的 taskId 时，**不得**捕获错误、删掉身份
// 参数重新调用。那种情况必须让宿主报错并原样上抛，由 DSH 的错误处理呈现给对应会话。
// 本模块只回答"有没有映射"，不承担任何降级重试。
//
// 纯函数 + 零宿主/零 DSH 依赖（cordis 构建树不 import src/lib），可被 node --test 直接 import。

import { readTaskMap } from "./taskmap.js";

/**
 * @param {string|null} dataDir 受管 runtime 进程的 DSHANA_HOME（main.js 注入）
 * @param {string|null} sessionId DSH 会话 id（llm options.sessionId）
 * @returns {{ identity: { taskId?: string }, source: "task" | "app" }}
 */
export function resolveModelIdentity(dataDir, sessionId) {
  const map = dataDir && sessionId ? readTaskMap(dataDir, sessionId) : null;
  const taskId = map && typeof map.taskId === "string" && map.taskId ? map.taskId : null;
  if (taskId) return { identity: { taskId }, source: "task" };
  return { identity: {}, source: "app" };
}
