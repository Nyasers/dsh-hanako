// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/task-map-ext.test.mjs — src/lib/task-map.js 补丁/取消/审批字段单测
// （补丁/取消标记/审批协调字段：addApproval/settleApproval/findPendingApproval/
// markCancelRequested/patchTaskMap/updateTaskMap；映射缺失/畸形容错）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeTaskMap,
  readTaskMap,
  addApproval,
  settleApproval,
  findPendingApproval,
  markCancelRequested,
  patchTaskMap,
  updateTaskMap,
  normalizeApproval,
  APPROVAL_STATUS_PENDING,
  APPROVAL_STATUS_ANSWERED,
} from "../src/lib/task-map.ts";

const SID = "session-11111111-2222-3333-4444-555555555555";
let dir;
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dshana-taskmap-ext-"));
});
test.afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("patchTaskMap / updateTaskMap：读-改-写 + 映射缺失返回 null 不创建", () => {
  assert.equal(patchTaskMap(dir, SID, { a: 1 }), null); // 不存在不创建
  writeTaskMap(dir, { taskId: "t1", dshSessionId: SID, action: "create", rpcId: "r1" });
  const patched = patchTaskMap(dir, SID, { timeoutSec: 120, approvalTimeoutMs: 30000 });
  assert.equal(patched.timeoutSec, 120);
  const mapped = updateTaskMap(dir, SID, (cur) => ({ ...cur, cancel: { at: 5, reason: "timeout" } }));
  assert.equal(mapped.cancel.reason, "timeout");
  const j = JSON.parse(readFileSync(join(dir, "dshana", "taskmaps", SID + ".json"), "utf8"));
  assert.equal(j.timeoutSec, 120);
  assert.equal(j.cancel.reason, "timeout");
});

test("normalizeApproval：status/outcome 归一、可选字段", () => {
  const a = normalizeApproval({ approvalId: "a1", toolName: "write", reason: "r", args: "{}", callId: "c1" });
  assert.equal(a.status, APPROVAL_STATUS_PENDING);
  assert.equal(a.outcome, undefined);
  const b = normalizeApproval({ approvalId: "a2", status: APPROVAL_STATUS_ANSWERED, outcome: "rejected" });
  assert.equal(b.status, APPROVAL_STATUS_ANSWERED);
  assert.equal(b.outcome, "rejected");
  const c = normalizeApproval(null);
  assert.equal(c.approvalId, "");
  assert.equal(c.toolName, "tool");
});

test("addApproval / settleApproval / findPendingApproval：追加、去重、结算、去重应答防护", () => {
  writeTaskMap(dir, { taskId: "t1", dshSessionId: SID, action: "send", rpcId: "r1" });
  addApproval(dir, SID, { approvalId: "a1", toolName: "write", reason: "escalate", args: '{"x":1}' });
  addApproval(dir, SID, { approvalId: "a2", toolName: "bash" });
  let entry = readTaskMap(dir, SID);
  assert.equal(entry.approvals.length, 2);
  const pending = findPendingApproval(entry, "a1");
  assert.equal(pending.toolName, "write");
  assert.equal(findPendingApproval(entry, "nope"), null);
  // 重复 add 同一 approvalId：去重（保持最新）
  addApproval(dir, SID, { approvalId: "a1", toolName: "write", reason: "escalate v2" });
  entry = readTaskMap(dir, SID);
  assert.equal(entry.approvals.length, 2);
  assert.equal(entry.approvals.find((x) => x.approvalId === "a1").reason, "escalate v2");
  // 结算 allowed-once → pending 变 answered；findPending 返回 null（防重复应答）
  settleApproval(dir, SID, "a1", "allowed-once");
  entry = readTaskMap(dir, SID);
  const a1 = entry.approvals.find((x) => x.approvalId === "a1");
  assert.equal(a1.status, APPROVAL_STATUS_ANSWERED);
  assert.equal(a1.outcome, "allowed-once");
  assert.equal(findPendingApproval(entry, "a1"), null);
  // 结算未知 approval：放弃写入（映射文件不变）
  const before = JSON.stringify(entry);
  settleApproval(dir, SID, "ghost", "rejected");
  assert.equal(JSON.stringify(readTaskMap(dir, SID)), before);
});

test("markCancelRequested：幂等覆盖 reason/at；映射缺失返回 null", () => {
  writeTaskMap(dir, { taskId: "t1", dshSessionId: SID, action: "send", rpcId: "r1" });
  const m1 = markCancelRequested(dir, SID, "user");
  assert.equal(m1.cancel.reason, "user");
  const m2 = markCancelRequested(dir, SID, "timeout");
  assert.equal(m2.cancel.reason, "timeout");
  assert.equal(markCancelRequested(dir, "session-99999999-0000-0000-0000-000000000000", "user"), null);
});
