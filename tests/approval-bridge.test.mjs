// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/approval-bridge.test.mjs — src/runtime/approval-bridge.js 的纯函数部分
//
// 这里锁的是**归属校验通则**的第一半（审批侧）：宿主审批记录自带 parentTaskId，
// 它和我们映射里以为的 taskId 必须一致，否则 fail-closed 拒绝（绝不放行）。
// 契约上 parentTaskId 必填 → 缺失也按不一致处理，宁可拒绝一次，不拿来源不明的审批等结果。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvalOwnsTask,
  approvalSessionIdOf,
  previewArgs,
  collectToolCallsFromEvent,
  ToolCallCache,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  TOOL_ARGS_PREVIEW_MAX,
} from "../src/runtime/approval-bridge.js";

test("approvalOwnsTask：parentTaskId 一致才放行", () => {
  assert.equal(approvalOwnsTask({ parentTaskId: "task-1" }, "task-1"), true);
  assert.equal(approvalOwnsTask({ parentTaskId: "task-2" }, "task-1"), false, "不一致必须拒绝");
});

test("approvalOwnsTask：缺失/非字符串/空串一律按不一致处理（fail-closed）", () => {
  for (const bad of [{}, { parentTaskId: "" }, { parentTaskId: null }, { parentTaskId: 42 }, null, undefined]) {
    assert.equal(approvalOwnsTask(bad, "task-1"), false, JSON.stringify(bad) + " 应判为不一致");
  }
  assert.equal(approvalOwnsTask({ parentTaskId: "task-1" }, ""), false, "期望值为空也必须拒绝");
});

test("approvalSessionIdOf：只认 agent.session.id", () => {
  assert.equal(approvalSessionIdOf({ agent: { session: { id: "session-1" } } }), "session-1");
  assert.equal(approvalSessionIdOf({ agent: { session: { id: 7 } } }), null);
  assert.equal(approvalSessionIdOf({}), null);
  assert.equal(approvalSessionIdOf(null), null);
});

test("previewArgs：JSON 字符串截断 + 空值归 null", () => {
  assert.equal(previewArgs(null), null);
  assert.equal(previewArgs("  "), null);
  assert.equal(previewArgs({ a: 1 }), '{"a":1}');
  const long = "x".repeat(TOOL_ARGS_PREVIEW_MAX + 50);
  const cut = previewArgs(long);
  assert.equal(cut.length, TOOL_ARGS_PREVIEW_MAX + 1, "截断后带一个省略号");
  assert.ok(cut.endsWith("…"));
});

test("collectToolCallsFromEvent：只吃 assistant/message 的 tool-call 块", () => {
  const ev = {
    type: "assistant/message",
    data: { message: { content: [{ type: "text", text: "hi" }, { type: "tool-call", id: "c1", name: "bash", arguments: '{"cmd":"ls"}' }] } },
  };
  const got = collectToolCallsFromEvent("session-1", ev);
  assert.deepEqual(got, [{ sessionId: "session-1", callId: "c1", name: "bash", args: '{"cmd":"ls"}' }]);
  assert.deepEqual(collectToolCallsFromEvent("session-1", { type: "user/message" }), []);
  assert.deepEqual(collectToolCallsFromEvent(null, ev), [], "无会话 id 不收集");
  assert.deepEqual(collectToolCallsFromEvent("session-1", { type: "assistant/message", data: { message: { content: [{ type: "tool-call", name: "x" }] } } }), [], "无 callId 不收集");
});

test("ToolCallCache：有界 + 按会话隔离 + 取不到返回 null", () => {
  const cache = new ToolCallCache();
  cache.push([
    { sessionId: "s1", callId: "c1", name: "bash", args: '{"a":1}' },
    { sessionId: "s2", callId: "c9", name: "fs", args: null },
  ]);
  assert.deepEqual(cache.get("s1", "c1"), { name: "bash", args: '{"a":1}' });
  assert.equal(cache.get("s2", "c1"), null, "不同会话不串");
  assert.deepEqual(cache.get("s2", "c9"), { name: "fs", args: null });
  assert.equal(cache.get("s1", "nope"), null);
  cache.clear();
  assert.equal(cache.get("s1", "c1"), null);
});

test("常量：默认审批超时是 App 侧策略值，不是宿主默认（宿主默认 0 = 不超时）", () => {
  assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, 30000);
});
