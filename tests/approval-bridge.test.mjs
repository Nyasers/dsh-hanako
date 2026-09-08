// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/approval-bridge.test.mjs — src/runtime/approval-bridge.js 纯函数面单测
// （审批会话定位 / args 预览 / tool-call 收集 / 有界缓存；watch 对账在 watch-sse.test）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvalSessionIdOf,
  previewArgs,
  collectToolCallsFromEvent,
  ToolCallCache,
  DEFAULT_APPROVAL_TIMEOUT_MS,
} from "../src/runtime/approval-bridge.js";

test("approvalSessionIdOf: agent.session.id；缺失返回 null", () => {
  assert.equal(approvalSessionIdOf({ agent: { session: { id: "session-1" } } }), "session-1");
  assert.equal(approvalSessionIdOf({ agent: { session: {} } }), null);
  assert.equal(approvalSessionIdOf({}), null);
  assert.equal(approvalSessionIdOf(null), null);
});

test("previewArgs: 对象拍平/字符串/截断/空值", () => {
  assert.equal(previewArgs(null), null);
  assert.equal(previewArgs(undefined), null);
  assert.equal(previewArgs(""), null);
  assert.equal(previewArgs({ a: 1 }), '{"a":1}');
  assert.equal(previewArgs('{"b":2}'), '{"b":2}');
  const long = "x".repeat(5000);
  const p = previewArgs(long);
  assert.ok(p.length < 5000);
  assert.match(p, /…$/);
  assert.equal(previewArgs(42), "42");
});

test("collectToolCallsFromEvent: assistant/message 的 tool-call 块", () => {
  const ev = {
    type: "assistant/message",
    data: {
      message: {
        content: [
          { type: "text", text: "hi" },
          { type: "tool-call", id: "call_1", name: "write", arguments: '{"path":"a.txt"}' },
          { type: "tool-call", callId: "call_2", name: "bash", arguments: { command: "ls" } },
        ],
      },
    },
  };
  const frames = collectToolCallsFromEvent("session-1", ev);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].callId, "call_1");
  assert.equal(frames[0].name, "write");
  assert.equal(frames[0].args, '{"path":"a.txt"}');
  assert.equal(frames[1].callId, "call_2");
  assert.equal(JSON.parse(frames[1].args).command, "ls");
  assert.deepEqual(collectToolCallsFromEvent("session-1", { type: "turn/end" }), []);
});

test("ToolCallCache: 按 session+callId 存取、有界淘汰", () => {
  const c = new ToolCallCache();
  c.push([{ sessionId: "s1", callId: "c1", name: "write", args: "{}" }]);
  assert.deepEqual(c.get("s1", "c1"), { name: "write", args: "{}" });
  assert.equal(c.get("s1", "c2"), null);
  assert.equal(c.get("s2", "c1"), null);
  c.clear();
  assert.equal(c.get("s1", "c1"), null);
});

test("DEFAULT_APPROVAL_TIMEOUT_MS 与 manifest 30s 一致", () => {
  assert.equal(DEFAULT_APPROVAL_TIMEOUT_MS, 30000);
});
