// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/plugins/provider/lib/identity.ts — 模型请求身份判定
//
// 身份参数二选一，且不能同时传；本 adapter 只可能给出两种形态：
//   · 会话绑定**仍活动**（dshana_session 创建/续写）→ { taskId }：保留任务绑定，结果沿
//     task-bridge 回投到发起它的 Hana 会话；
//   · App 身份 → {}：callToken 与 taskId 都不传，宿主据此把请求归属 App 自己。
// 注意 models.stream **不接受** scope 字段（scope:"app" 是 models.utility 的参数）。
//
// 三态判定（**App 身份仅限"用户直接在 WebUI 使用"**）：
//   ① 无绑定          ⇒ App 身份。**只有**这里与下一条才允许 App 身份。
//   ② 绑定在 + 已收尾  ⇒ App 身份（任务已终结，用户接着在 WebUI 里跑——事实，不是降级）
//   ③ 绑定在 + 未收尾  ⇒ { taskId }（必须：这是我们建的会话，绑定不能丢）
//   ④ 读不到绑定状态   ⇒ **报错**（code BINDING_UNAVAILABLE）。
// ④ 是关键：投影单元没注册 = **能力缺席**，不是"这条会话没有绑定"。把能力缺席当①，等于对一条
// 还活着的任务丢掉绑定、结果不回投，静默失败。
//
// 判定依据：会话投影 dshanaTaskBinding（lib/binding.js 注册；宿主持久、本进程 stateOf 本地读）。
// 收尾只标记、不抹除认领——"读过但已收尾"与"从没认领过"必须是两件事。
//
// 明确不做的事：拿到失效或归属不正确的 taskId 时，**不得**捕获错误、删掉身份参数重新调用。
// 那种情况必须让宿主报错并原样上抛，由 DSH 的错误处理呈现给对应会话。
// 本模块只回答"这条会话的身份是什么"，不承担任何降级重试。
//
// 纯函数 + 零依赖（可被 node --test 直接 import）。

/**
 * @param {object|undefined} state 会话绑定状态（undefined = 投影未注册）
 * @returns {{ identity: { taskId?: string }, source: "task" | "app", reason?: string }}
 * @throws {Error} code `BINDING_UNAVAILABLE`：绑定状态读不到（能力缺席，显式失败）
 */
export function resolveModelIdentity(state) {
  if (state === undefined) {
    const e = new Error("会话绑定不可读（sessionProjections 未注册 " + "dshanaTaskBinding" + "）");
    e.code = "BINDING_UNAVAILABLE";
    throw e;
  }
  const taskId = state && typeof state.taskId === "string" && state.taskId !== "" ? state.taskId : null;
  // ① 没有认领 ⇒ 不是我们创建的会话（用户在 WebUI 自建）⇒ App 身份。
  if (taskId === null) return { identity: {}, source: "app", reason: "unowned-session" };
  // ② 我们建的，但任务已终结（用户接着在 WebUI 里跑）⇒ App 身份。
  if (typeof state.ended === "string" && state.ended !== "") {
    return { identity: {}, source: "app", reason: "task-ended" };
  }
  // ③ 我们建的、任务活动 ⇒ 必须带 taskId（失效由宿主报错，不降级）。
  return { identity: { taskId }, source: "task" };
}
