// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/provider-identity.test.mjs — src-cordis/plugins/provider/lib/identity.ts 单测
//
// 锁死的是**三态判定**（App 身份仅限“用户直接在 WebUI 使用”）：
//   ① 无绑定            ⇒ App 身份（用户自建会话）
//   ② 绑定在 + 已收尾    ⇒ App 身份（任务已终结，用户接着在 WebUI 里跑——事实，不是降级）
//   ③ 绑定在 + 未收尾    ⇒ { taskId }（必须，绑定不能丢）
//   ④ 绑定状态读不到     ⇒ **抛错**（BINDING_UNAVAILABLE）——投影未注册 = 能力缺席，绝不伪装成 ①
// 身份字段只有 taskId（callToken 是工具调用期推理的事，本 adapter 从不传）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModelIdentity } from "../src-cordis/plugins/provider/lib/identity.ts";

const ACTIVE = { taskId: "task-1", timeoutSec: 60, approvalTimeoutMs: 30000, ended: null, at: 7 };

test("① 无绑定（用户自建会话）→ App 身份，reason=unowned-session", () => {
  const r = resolveModelIdentity({ taskId: null, ended: null });
  assert.deepEqual(r, { identity: {}, source: "app", reason: "unowned-session" });
  assert.equal("taskId" in r.identity, false);
  assert.equal("callToken" in r.identity, false);
});

test("③ 有绑定且未收尾 → taskId 身份，且只带 taskId", () => {
  const r = resolveModelIdentity(ACTIVE);
  assert.deepEqual(r, { identity: { taskId: "task-1" }, source: "task" });
  assert.deepEqual(Object.keys(r.identity), ["taskId"]);
});

test("② 绑定在但已收尾 → App 身份，reason=task-ended（不遗留陈旧 taskId）", () => {
  const r = resolveModelIdentity({ ...ACTIVE, ended: "task-terminal" });
  assert.deepEqual(r, { identity: {}, source: "app", reason: "task-ended" });
});

test("③ 绑定缺 taskId（空串/null）按无绑定处理，不抛", () => {
  assert.equal(resolveModelIdentity({ taskId: "", ended: null }).source, "app");
  assert.equal(resolveModelIdentity({ taskId: null, ended: null }).source, "app");
  assert.equal(resolveModelIdentity({}).source, "app");
});

// ④ 这一组是语义核心：投影单元没注册是**能力缺席**，不是“这条会话没有绑定”。
// 把它当 ①，等于对一条还活着的任务丢掉绑定、结果不回投——静默失败。
test("④ 绑定状态读不到（undefined）→ 抛 BINDING_UNAVAILABLE，不降级成 App 身份", () => {
  assert.throws(
    () => resolveModelIdentity(undefined),
    (e) => e && e.code === "BINDING_UNAVAILABLE",
  );
});
