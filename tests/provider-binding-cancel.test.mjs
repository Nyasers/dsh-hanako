// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/provider-binding-cancel.test.mjs — 投影 v2 的"取消标记"格（会话事件日志的第二类状态）。
//
// 取消标记为什么放进投影：它原来的落点是私有映射文件，而读它的是 runtime 子进程（就是 DSH
// 进程本身）。投影在同一进程内 stateOf 直接读折叠结果，不必再跨文件。语义上它是**会话级**的
// （取消是会话上的动作），所以不要求对上 taskId；但新一次认领等于新任务，标记随之清空。
import test from "node:test";
import assert from "node:assert/strict";
import {
  BINDING_STATE_VERSION,
  BINDING_CLAIM_EVENT,
  BINDING_END_EVENT,
  BINDING_CANCEL_EVENT,
  bindingStateSchema,
  emptyBinding,
  foldBinding,
} from "../src-cordis/plugins/provider/lib/binding.ts";
import {
  BINDING_STATE_VERSION as RUNTIME_STATE_VERSION,
  BINDING_CANCEL_EVENT as RUNTIME_CANCEL_EVENT,
  BINDING_CLAIM_EVENT as RUNTIME_CLAIM_EVENT,
  BINDING_END_EVENT as RUNTIME_END_EVENT,
  cancelPayload,
} from "../src/lib/binding-slot.ts";

test("两套构建树的版本与事件名逐字一致（跨 bundle 约定靠常量对齐）", () => {
  assert.equal(BINDING_STATE_VERSION, 4);
  assert.equal(BINDING_STATE_VERSION, RUNTIME_STATE_VERSION);
  assert.equal(BINDING_CANCEL_EVENT, RUNTIME_CANCEL_EVENT);
  assert.equal(BINDING_CANCEL_EVENT, "dshana/task-cancel");
  assert.equal(BINDING_CLAIM_EVENT, RUNTIME_CLAIM_EVENT);
  assert.equal(BINDING_END_EVENT, RUNTIME_END_EVENT);
});

test("空绑定含 cancel 格（null = 没取消过）", () => {
  assert.equal(Object.prototype.hasOwnProperty.call(emptyBinding(), "cancel"), true);
  assert.equal(emptyBinding().cancel, null);
});

test("折叠：取消标记落在会话上，不要求对上 taskId", () => {
  const claimed = foldBinding(emptyBinding(), { type: BINDING_CLAIM_EVENT, seq: 1, data: { taskId: "task-1" } });
  const cancelled = foldBinding(claimed, { type: BINDING_CANCEL_EVENT, seq: 2, data: cancelPayload("user") });
  assert.deepEqual(cancelled.cancel, { reason: "user", at: 2 });
  assert.equal(cancelled.taskId, "task-1", "取消不动绑定本身");
  assert.equal(cancelled.ended, null);
});

test("折叠：取消标记 last-wins，原因随最后一次", () => {
  const a = foldBinding(emptyBinding(), { type: BINDING_CANCEL_EVENT, seq: 1, data: cancelPayload("user") });
  const b = foldBinding(a, { type: BINDING_CANCEL_EVENT, seq: 2, data: cancelPayload("timeout") });
  assert.deepEqual(b.cancel, { reason: "timeout", at: 2 });
});

test("折叠：取消原因缺失按 null 存，不编造字符串", () => {
  const s = foldBinding(emptyBinding(), { type: BINDING_CANCEL_EVENT, seq: 3, data: {} });
  assert.deepEqual(s.cancel, { reason: null, at: 3 });
});

test("折叠：新认领清空上一轮的取消标记（新任务不该背着旧取消）", () => {
  const cancelled = foldBinding(emptyBinding(), { type: BINDING_CANCEL_EVENT, seq: 1, data: cancelPayload("user") });
  assert.notEqual(cancelled.cancel, null);
  const reclaimed = foldBinding(cancelled, { type: BINDING_CLAIM_EVENT, seq: 2, data: { taskId: "task-2" } });
  assert.equal(reclaimed.cancel, null);
  assert.equal(reclaimed.taskId, "task-2");
});

test("折叠：取消之后收尾照常生效（标记不拦终态）", () => {
  const claimed = foldBinding(emptyBinding(), { type: BINDING_CLAIM_EVENT, seq: 1, data: { taskId: "task-1" } });
  const cancelled = foldBinding(claimed, { type: BINDING_CANCEL_EVENT, seq: 2, data: cancelPayload("user") });
  const ended = foldBinding(cancelled, { type: BINDING_END_EVENT, seq: 3, data: { taskId: "task-1", status: "canceled" } });
  assert.equal(ended.ended, "canceled");
  assert.deepEqual(ended.cancel, { reason: "user", at: 2 }, "终态不改写取消标记");
});

test("state 校验：cancel 格缺省补 null，形状不对就抛", () => {
  const parsed = bindingStateSchema.parse({ taskId: null, timeoutSec: null, approvalTimeoutMs: null, ended: null, at: null });
  assert.equal(parsed.cancel, null);
  const kept = bindingStateSchema.parse({
    taskId: "t",
    timeoutSec: null,
    approvalTimeoutMs: null,
    ended: null,
    cancel: { reason: "user", at: 5 },
    at: 5,
  });
  assert.deepEqual(kept.cancel, { reason: "user", at: 5 });
  assert.throws(() => bindingStateSchema.parse("nope"), /必须是对象/);
});

test("折叠：认领带上 rpcId 与 action（桥读它们），没给就是 null", () => {
  const withRpc = foldBinding(emptyBinding(), {
    type: BINDING_CLAIM_EVENT,
    seq: 1,
    data: { taskId: "task-1", rpcId: "rpc-7", action: "send" },
  });
  assert.equal(withRpc.rpcId, "rpc-7");
  assert.equal(withRpc.action, "send");
  const without = foldBinding(emptyBinding(), { type: BINDING_CLAIM_EVENT, seq: 2, data: { taskId: "task-1" } });
  assert.equal(without.rpcId, null, "没给就是 null，不编造");
  assert.equal(without.action, null, "没给就是 null，不编造");
});
