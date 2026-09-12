// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/task-bridge.test.mjs — src/runtime/task-bridge.ts 单测：事件归类纯函数 +
// 宿主取消反向触发的两个回归点（真机踩过：取消标记没落、结算成 failed）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyDshEvent, BRIDGE_EVENTS, SessionBridge } from "../src/runtime/task-bridge.ts";
import { BINDING_CANCEL_EVENT } from "../src/lib/binding-slot.ts";

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

// ---- 宿主取消反向触发（真机回归：这条路上取消标记没落进投影、任务被结算成 failed）----

function makeBridge() {
  const appended = [];
  const calls = { canceled: [], completed: [], failed: [] };
  const sessions = {
    get: (sid) => (sid === "session-abc" ? { append: (type, data) => appended.push({ type, data }) } : null),
  };
  const hana = {
    tasks: {
      cancel: async (taskId, msg) => calls.canceled.push({ taskId, msg }),
      complete: async (taskId, res) => calls.completed.push({ taskId, res }),
      fail: async (taskId, msg) => calls.failed.push({ taskId, msg }),
    },
  };
  const bridge = new SessionBridge({
    hana,
    dataDir: mkdtempSync(join(tmpdir(), "dshana-tb-")),
    sessions,
    log: () => {},
    serviceBaseUrl: "http://127.0.0.1:9", // 连接必然被拒：反向 RPC 失败只记日志，不阻断收尾
    bridgeKey: "",
    cancelModelRequests: async () => {},
    ctx: null,
  });
  bridge.taskId = "app:dshana:t1";
  bridge.sessionId = "session-abc";
  bridge.map = { taskId: "app:dshana:t1", dshSessionId: "session-abc", action: "create" };
  return { bridge, appended, calls };
}

test("宿主取消：先把取消标记落进会话事件（投影 cancel 格）", async () => {
  const { bridge, appended } = makeBridge();
  await bridge.onHostCancel({ status: "canceled" });
  const ev = appended.find((e) => e.type === BINDING_CANCEL_EVENT);
  assert.ok(ev, "取消标记必须落进会话事件日志——App 进程没有 sessions 句柄，这个动作只能在 runtime 里做");
  assert.deepEqual(ev.data, { reason: "user" });
});

test("宿主取消：本进程亲手取消过 → 结算成 canceled，不得判成 failed", async () => {
  const { bridge, calls } = makeBridge();
  bridge.hostCancelDone = true; // 反向取消路径已置位；此时投影里的 cancel 可能还没回读到
  await bridge.settle({ ok: false, message: "DSH 回合被中止（aborted）" });
  assert.equal(calls.canceled.length, 1, "已亲手请求取消 ⇒ 必须结算成 canceled");
  assert.equal(calls.failed.length, 0);
});
