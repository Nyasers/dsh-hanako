// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/task-bridge.test.mjs — src/runtime/task-bridge.js 事件归类纯函数单测
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDshEvent, BRIDGE_EVENTS } from "../src/runtime/task-bridge.ts";

test("classifyDshEvent: api-session/status true/false", () => {
  assert.deepEqual(classifyDshEvent("api-session/status", ["s1", false]), { kind: "status", sessionId: "s1", running: false });
  assert.deepEqual(classifyDshEvent("api-session/status", ["s1", true]), { kind: "status", sessionId: "s1", running: true });
  assert.equal(classifyDshEvent("api-session/status", []), null);
});

test("classifyDshEvent: api-session/error 与 activity", () => {
  assert.deepEqual(classifyDshEvent("api-session/error", ["s1", "boom"]), { kind: "error", sessionId: "s1", message: "boom" });
  assert.deepEqual(classifyDshEvent("api-session/activity", ["s1", 123]), { kind: "activity", sessionId: "s1" });
});

test("classifyDshEvent: session/event turn/end completed/error", () => {
  const completed = classifyDshEvent("session/event", [{ id: "s1" }, { type: "turn/end", data: { reason: { kind: "completed" } } }]);
  assert.deepEqual(completed, { kind: "turn-end", sessionId: "s1", errorKind: null, message: "" });
  const errored = classifyDshEvent("session/event", [
    { id: "s1" },
    { type: "turn/end", data: { reason: { kind: "error", error: { message: "llm failed", code: "X" } } } },
  ]);
  assert.equal(errored.kind, "turn-end");
  assert.equal(errored.errorKind, "error");
  assert.match(errored.message, /llm failed/);
});

test("classifyDshEvent: assistant/message / 未知事件 / 未知 session", () => {
  assert.deepEqual(classifyDshEvent("session/event", [{ id: "s1" }, { type: "assistant/message", data: {} }]), { kind: "assistant", sessionId: "s1" });
  assert.deepEqual(classifyDshEvent("session/event", [{ id: "s1" }, { type: "nope" }]), { kind: "turn-other", sessionId: "s1" });
  assert.equal(classifyDshEvent("unrelated", ["x"]), null);
  assert.equal(classifyDshEvent("session/event", [null, { type: "turn/end" }]), null);
});

test("BRIDGE_EVENTS 覆盖分类所需事件", () => {
  for (const e of ["api-session/status", "api-session/error", "session/event", "api-session/activity"]) {
    assert.ok(BRIDGE_EVENTS.includes(e));
  }
});
