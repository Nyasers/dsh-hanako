// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/watch-sse.test.mjs — src/lib/watch-sse.js 单测（SSE 解码/帧解释/终态与审批映射/
// watch 对账循环）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TERMINAL_STATUSES,
  recordIsTerminal,
  approvalOutcomeOf,
  extractWatchRecord,
  interpretWatchFrame,
  createSseDecoder,
  runWatchReconcile,
} from "../src/lib/watch-sse.js";

test("recordIsTerminal: 终态集合", () => {
  for (const s of TERMINAL_STATUSES) assert.equal(recordIsTerminal({ status: s }), true);
  assert.equal(recordIsTerminal({ status: "running" }), false);
  assert.equal(recordIsTerminal(null), false);
  assert.equal(recordIsTerminal({}), false);
});

test("approvalOutcomeOf: allowed-once/rejected 原样；终态无 outcome fail-closed；pending 继续等", () => {
  assert.equal(approvalOutcomeOf({ approvalId: "a1", outcome: "allowed-once" }), "allowed-once");
  assert.equal(approvalOutcomeOf({ approvalId: "a1", outcome: "rejected" }), "rejected");
  assert.equal(approvalOutcomeOf({ approvalId: "a1", status: "canceled" }), "rejected"); // 终态无 outcome：拒绝
  assert.equal(approvalOutcomeOf({ approvalId: "a1", status: "completed", outcome: "allowed-once" }), "allowed-once");
  assert.equal(approvalOutcomeOf({ approvalId: "a1", status: "running" }), null); // 未终态：等
  assert.equal(approvalOutcomeOf({ status: "canceled" }), null); // 非审批记录
  assert.equal(approvalOutcomeOf(null), null);
});

test("extractWatchRecord: 裸记录 / record / data / approval 包装", () => {
  const bare = { taskId: "t1", status: "running" };
  assert.deepEqual(extractWatchRecord(bare), bare);
  assert.deepEqual(extractWatchRecord({ type: "snapshot", record: bare }), bare);
  assert.deepEqual(extractWatchRecord({ kind: "task", data: bare }), bare);
  assert.deepEqual(extractWatchRecord({ approval: { approvalId: "a1", status: "pending" } }), { approvalId: "a1", status: "pending" });
  assert.equal(extractWatchRecord({ type: "ping" }), null);
  assert.equal(extractWatchRecord(null), null);
});

test("interpretWatchFrame: snapshot/app-task/reset/结构兜底", () => {
  const rec = { taskId: "t1", status: "running" };
  assert.deepEqual(interpretWatchFrame("snapshot", JSON.stringify({ type: "snapshot", record: rec })), { kind: "snapshot", record: rec });
  assert.deepEqual(interpretWatchFrame("app-task", JSON.stringify(rec)), { kind: "app-task", record: rec });
  assert.deepEqual(interpretWatchFrame("message", JSON.stringify({ type: "app-task", record: rec })), { kind: "app-task", record: rec });
  assert.deepEqual(interpretWatchFrame("reset", ""), { kind: "reset", record: null });
  assert.deepEqual(interpretWatchFrame("message", JSON.stringify({ type: "reset" })), { kind: "reset", record: null });
  // 无事件名 + data 直接是记录：结构兜底
  assert.deepEqual(interpretWatchFrame("", JSON.stringify({ approvalId: "a1", status: "running" })), { kind: "app-task", record: { approvalId: "a1", status: "running" } });
  // 坏 data：other
  assert.deepEqual(interpretWatchFrame("snapshot", "{broken"), { kind: "other", record: null });
});

test("createSseDecoder: 跨 chunk 余量 + CRLF + 心跳注释", () => {
  const dec = createSseDecoder();
  const events = [];
  // data 物理行跨 chunk 边界（同一行内拆包，JSON 不跨行）+ CRLF + 注释心跳块
  events.push(...dec.push("event: snapshot\r\ndata: {\"a\":"));
  events.push(...dec.push("1}\r\n\r\n"));
  events.push(...dec.push(": keepalive\n\n"));
  events.push(...dec.push("event: app-task\ndata: {\"b\":2}\n\n"));
  events.push(...dec.end());
  assert.equal(events.length, 2);
  assert.equal(events[0].event, "snapshot");
  assert.equal(JSON.parse(events[0].data).a, 1);
  assert.equal(events[1].event, "app-task");
  assert.equal(JSON.parse(events[1].data).b, 2);
});

test("createSseDecoder: 无尾空行的残留块由 end() flush", () => {
  const dec = createSseDecoder();
  assert.deepEqual(dec.push("data: x"), []);
  const tail = dec.end();
  assert.equal(tail.length, 1);
  assert.equal(tail[0].data, "x");
  assert.deepEqual(dec.end(), []);
});

function sseResponse(blocks) {
  const bytes = new TextEncoder().encode(blocks.join(""));
  let pos = 0;
  const reader = {
    read() {
      if (pos >= bytes.length) return Promise.resolve({ done: true, value: undefined });
      const end = Math.min(bytes.length, pos + 40);
      const value = bytes.slice(pos, end);
      pos = end;
      return Promise.resolve({ done: false, value });
    },
    cancel() { return Promise.resolve(); },
  };
  return { body: { getReader: () => reader } };
}

test("runWatchReconcile: 先 get 对账；app-task 终态回调返回 false 即结束（approval 场景）", async () => {
  let getCalls = 0;
  const frames = [];
  const outcome = await runWatchReconcile({
    watch: () => Promise.resolve(sseResponse(["event: app-task\ndata: " + JSON.stringify({ approvalId: "a1", outcome: "rejected" }) + "\n\n"])),
    get: () => { getCalls += 1; return Promise.resolve({ approvalId: "a1", status: "running" }); },
    onFrame: async (rec, kind) => {
      frames.push({ kind, rec });
      const o = approvalOutcomeOf(rec);
      return o ? false : true;
    },
    shouldStop: () => false,
  });
  assert.equal(outcome, "terminal");
  assert.ok(getCalls >= 1);
  const last = frames[frames.length - 1];
  assert.equal(last.kind, "app-task");
  assert.equal(approvalOutcomeOf(last.rec), "rejected");
});

test("runWatchReconcile: reset 事件 → get() 重读快照（多次迭代仍先对账）", async () => {
  let gets = 0;
  const watchEvents = [];
  const outcome = await runWatchReconcile({
    watch: () => Promise.resolve(sseResponse(["event: reset\ndata: {}\n\n"])),
    get: () => { gets += 1; return Promise.resolve({ taskId: "t1", status: gets === 1 ? "running" : "canceled" }); },
    onFrame: async (rec, kind) => {
      watchEvents.push(kind);
      if (kind === "snapshot" && rec && rec.status === "canceled") return false;
      return true;
    },
    shouldStop: () => false,
  });
  assert.equal(outcome, "terminal");
  assert.ok(gets >= 2, "reset 后应重新 get 对账");
  assert.ok(watchEvents.includes("snapshot"));
});

test("runWatchReconcile: shouldStop 立即退出（stopped）", async () => {
  const outcome = await runWatchReconcile({
    watch: () => Promise.resolve(sseResponse([])),
    get: () => Promise.resolve(null),
    onFrame: async () => true,
    shouldStop: () => true,
  });
  assert.equal(outcome, "stopped");
});
