// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/task-bridge.test.mjs — src/runtime/task-bridge.ts 单测：事件归类纯函数 +
// 宿主取消反向触发的两个回归点（真机踩过：取消标记没落、结算成 failed）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyDshEvent, BRIDGE_EVENTS, SessionBridge } from "../src/runtime/task-bridge.ts";
import { writeTaskMap } from "../src/lib/task-map.ts";

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

// ---- 宿主取消反向触发（真机回归：这条路上取消标记没落进映射、任务被结算成 failed）----

const SID = "session-11111111-2222-3333-4444-555555555555";

function makeBridge() {
  const dataDir = mkdtempSync(join(tmpdir(), "dshana-tb-"));
  // 映射文件是真落点：取消标记写回它（跨进程事实源），所以先按提交期形状写好。
  writeTaskMap(dataDir, { taskId: "app:dshana:t1", dshSessionId: SID, action: "create", rpcId: "r_1" });
  const calls = { canceled: [], completed: [], failed: [] };
  const hana = {
    tasks: {
      cancel: async (taskId, msg) => calls.canceled.push({ taskId, msg }),
      complete: async (taskId, res) => calls.completed.push({ taskId, res }),
      fail: async (taskId, msg) => calls.failed.push({ taskId, msg }),
    },
  };
  const bridge = new SessionBridge({
    hana,
    dataDir,
    log: () => {},
    serviceBaseUrl: "http://127.0.0.1:9", // 连接必然被拒：反向 RPC 失败只记日志，不阻断收尾
    bridgeKey: "",
    cancelModelRequests: async () => {},
  });
  bridge.taskId = "app:dshana:t1";
  bridge.sessionId = SID;
  bridge.map = { taskId: "app:dshana:t1", dshSessionId: SID, action: "create" };
  return { bridge, dataDir, calls };
}

test("宿主取消：先把取消标记落进映射文件", async () => {
  const { bridge, dataDir } = makeBridge();
  await bridge.onHostCancel({ status: "canceled" });
  const raw = JSON.parse(readFileSync(join(dataDir, "dshana", "taskmaps", SID + ".json"), "utf8"));
  assert.equal(raw.cancel && raw.cancel.reason, "user");
});

test("宿主取消：本进程亲手取消过 → 结算成 canceled，不得判成 failed", async () => {
  const { bridge, calls } = makeBridge();
  bridge.hostCancelDone = true; // 反向取消路径已置位；此时映射里的 cancel 可能还没回读到
  await bridge.settle({ ok: false, message: "DSH 回合被中止（aborted）" });
  assert.equal(calls.canceled.length, 1, "已亲手请求取消 ⇒ 必须结算成 canceled");
  assert.equal(calls.failed.length, 0);
});
