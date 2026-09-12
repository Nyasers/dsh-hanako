// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/provider-binding.test.mjs — 会话↔任务绑定单测
//   ① 折叠语义：认领整条替换；收尾必须对上 taskId（陈旧收尾不得关掉新认领）
//   ② state 校验：形状不对就抛（宿主据此丢弃缓存行重新折叠）
//   ③ 同进程邮箱：投递/读取/清理，以及"taskId 对不上就不清"
//   ④ 运行期侧 append 助手：会话不在场返回 false，不抛
import test from "node:test";
import assert from "node:assert/strict";
import {
  BINDING_KEY,
  BINDING_STATE_VERSION,
  BINDING_CLAIM_EVENT,
  BINDING_END_EVENT,
  BINDING_CANCEL_EVENT,
  bindingUnit,
  bindingStateSchema,
  emptyBinding,
  foldBinding,
  claimPayload,
  depositBindingClaim,
  pendingBindingClaim,
  clearBindingClaim,
  bindingMailbox,
} from "../src-cordis/plugins/provider/lib/binding.ts";
import {
  BINDING_CLAIM_EVENT as RUNTIME_CLAIM_EVENT,
  BINDING_END_EVENT as RUNTIME_END_EVENT,
  BINDING_CANCEL_EVENT as RUNTIME_CANCEL_EVENT,
  BINDING_STATE_VERSION as RUNTIME_STATE_VERSION,
  BINDING_KEY as RUNTIME_KEY,
  appendSessionEvent,
  cancelPayload,
  claimPayload as runtimeClaimPayload,
  depositBindingClaim as runtimeDeposit,
} from "../src/lib/binding-slot.ts";

const SID = "session-11111111-2222-3333-4444-555555555555";

// ---- ① 折叠 ----

test("单元定义：key/版本/无 wire（host-only，不进客户端快照）", () => {
  const unit = bindingUnit();
  assert.equal(unit.key, BINDING_KEY);
  assert.equal(unit.key, "dshanaTaskBinding");
  assert.equal(unit.stateVersion, BINDING_STATE_VERSION);
  assert.equal("wire" in unit, false);
  assert.deepEqual(unit.init(), emptyBinding());
  assert.equal(typeof unit.apply, "function");
});

test("折叠：认领写入 taskId 与超时，ended 归零", () => {
  const s = foldBinding(emptyBinding(), {
    type: BINDING_CLAIM_EVENT,
    seq: 7,
    data: { taskId: "task-1", timeoutSec: 60, approvalTimeoutMs: 30000 },
  });
  assert.deepEqual(s, { taskId: "task-1", rpcId: null, timeoutSec: 60, approvalTimeoutMs: 30000, ended: null, cancel: null, at: 7 });
});

test("折叠：收尾对上 taskId 才生效", () => {
  const claimed = foldBinding(emptyBinding(), { type: BINDING_CLAIM_EVENT, seq: 1, data: { taskId: "task-1" } });
  const ended = foldBinding(claimed, { type: BINDING_END_EVENT, seq: 2, data: { taskId: "task-1", status: "completed" } });
  assert.equal(ended.ended, "completed");
  assert.equal(ended.taskId, "task-1");
  assert.equal(ended.at, 2);
});

test("折叠：陈旧收尾（taskId 对不上）与无认领收尾都不动状态", () => {
  const claimed = foldBinding(emptyBinding(), { type: BINDING_CLAIM_EVENT, seq: 1, data: { taskId: "task-2" } });
  assert.deepEqual(
    foldBinding(claimed, { type: BINDING_END_EVENT, seq: 2, data: { taskId: "task-1", status: "completed" } }),
    claimed,
  );
  assert.deepEqual(foldBinding(emptyBinding(), { type: BINDING_END_EVENT, seq: 2, data: { taskId: "task-1" } }), emptyBinding());
});

test("折叠：同会话再认领（send 建新 task）整条替换，旧的 ended 被盖掉", () => {
  const a = foldBinding(emptyBinding(), { type: BINDING_CLAIM_EVENT, seq: 1, data: { taskId: "task-1" } });
  const done = foldBinding(a, { type: BINDING_END_EVENT, seq: 2, data: { taskId: "task-1", status: "completed" } });
  const b = foldBinding(done, { type: BINDING_CLAIM_EVENT, seq: 3, data: { taskId: "task-2" } });
  assert.equal(b.taskId, "task-2");
  assert.equal(b.ended, null);
});

test("折叠：无关事件、畸形载荷、缺 taskId 的认领都不动状态", () => {
  const claimed = foldBinding(emptyBinding(), { type: BINDING_CLAIM_EVENT, seq: 1, data: { taskId: "task-1" } });
  for (const ev of [
    { type: "turn/end", seq: 2, data: {} },
    { type: BINDING_CLAIM_EVENT, seq: 3, data: {} },
    { type: BINDING_CLAIM_EVENT, seq: 4, data: { taskId: "" } },
    { type: BINDING_CLAIM_EVENT, seq: 5, data: null },
    null,
    "not-an-event",
  ]) {
    assert.deepEqual(foldBinding(claimed, ev), claimed, JSON.stringify(ev));
  }
});

test("折叠不共享引用（宿主按 Object.is 判变化）", () => {
  const a = foldBinding(emptyBinding(), { type: BINDING_CLAIM_EVENT, seq: 1, data: { taskId: "task-1" } });
  const b = foldBinding(a, { type: "turn/start", seq: 2, data: {} });
  assert.equal(a === b, false);
  assert.deepEqual(a, b);
});

// ---- ② state 校验 ----

test("stateSchema.parse：合法状态规范化返回", () => {
  assert.deepEqual(bindingStateSchema.parse({ taskId: "t", ended: null }), {
    taskId: "t",
    rpcId: null,
    timeoutSec: null,
    approvalTimeoutMs: null,
    ended: null,
    cancel: null,
    at: null,
  });
  assert.deepEqual(bindingStateSchema.parse({ taskId: null, ended: "failed", timeoutSec: 1.9, at: 3.7 }), {
    taskId: null,
    rpcId: null,
    timeoutSec: 1,
    approvalTimeoutMs: null,
    ended: "failed",
    cancel: null,
    at: 3,
  });
});

test("stateSchema.parse：形状不对就抛（缓存行会被丢弃并从 init 重折）", () => {
  for (const bad of [null, "x", 3, [], { taskId: "" }, { taskId: 5 }, { taskId: null, ended: 7 }]) {
    assert.throws(() => bindingStateSchema.parse(bad), TypeError, JSON.stringify(bad));
  }
});

// ---- ③ 同进程邮箱 ----

test("邮箱：投递 → 读取 → 清理；taskId 对不上不清", () => {
  bindingMailbox().clear();
  const payload = depositBindingClaim(SID, { taskId: "task-1", timeoutSec: 60, approvalTimeoutMs: 0 });
  assert.deepEqual(payload, { taskId: "task-1", rpcId: null, timeoutSec: 60, approvalTimeoutMs: 0 });
  assert.deepEqual(pendingBindingClaim(SID), payload);
  assert.equal(clearBindingClaim(SID, "task-other"), false);
  assert.deepEqual(pendingBindingClaim(SID), payload);
  assert.equal(clearBindingClaim(SID, "task-1"), true);
  assert.equal(pendingBindingClaim(SID), null);
  assert.equal(clearBindingClaim(SID), false);
});

test("邮箱：参数不合法显式抛（不静默）", () => {
  assert.throws(() => depositBindingClaim("", { taskId: "t" }), TypeError);
  assert.throws(() => depositBindingClaim(SID, { taskId: "" }), TypeError);
  assert.throws(() => depositBindingClaim(SID, null), TypeError);
  assert.equal(pendingBindingClaim(null), null);
});

test("邮箱：两套构建树的约定逐字一致（key 与事件名）", () => {
  assert.equal(RUNTIME_KEY, BINDING_KEY);
  assert.equal(RUNTIME_CLAIM_EVENT, BINDING_CLAIM_EVENT);
  assert.equal(RUNTIME_END_EVENT, BINDING_END_EVENT);
  assert.deepEqual(runtimeClaimPayload({ taskId: "t", timeoutSec: 5 }), claimPayload({ taskId: "t", timeoutSec: 5 }));
});

test("邮箱：运行期侧投递后 provider 侧读得到（同一张 globalThis Map）", () => {
  bindingMailbox().clear();
  runtimeDeposit(SID, { taskId: "task-9" });
  assert.deepEqual(pendingBindingClaim(SID), { taskId: "task-9", rpcId: null, timeoutSec: null, approvalTimeoutMs: null });
  bindingMailbox().clear();
});

// ---- ④ append 助手 ----

test("appendSessionEvent：会话不在场返回 false 不抛；在场则 append 且参数正确", () => {
  const seen = [];
  const sessions = { get: (id) => (id === SID ? { append: (type, data) => seen.push({ type, data }) } : undefined) };
  assert.equal(appendSessionEvent(sessions, SID, BINDING_CLAIM_EVENT, { taskId: "t" }), true);
  assert.deepEqual(seen, [{ type: BINDING_CLAIM_EVENT, data: { taskId: "t" } }]);
  assert.equal(appendSessionEvent(sessions, "session-99999999-8888-7777-6666-555555555555", BINDING_CLAIM_EVENT, {}), false);
  assert.equal(appendSessionEvent(null, SID, BINDING_CLAIM_EVENT, {}), false);
  assert.equal(appendSessionEvent({}, SID, BINDING_CLAIM_EVENT, {}), false);
  assert.equal(appendSessionEvent(sessions, "", BINDING_CLAIM_EVENT, {}), false);
});
