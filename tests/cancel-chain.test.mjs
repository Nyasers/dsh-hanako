// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/cancel-chain.test.mjs — src/lib/cancel-chain.js 纯函数单测（计划/超时解析）
// 执行器依赖宿主 ctx（app-runtime 注入），仅在无宿主时验证纯面与设置注入路径。
import { test } from "node:test";
import assert from "node:assert/strict";
import { initAppRuntime } from "../src/lib/app-runtime.ts";
import {
  planCancel,
  resolveTaskTimeoutSec,
  resolveApprovalTimeoutMs,
} from "../src/lib/cancel-chain.ts";
import { cancelAccepted } from "../src/lib/dsh-rpc.ts";

const SID = "session-11111111-2222-3333-4444-555555555555";

test("planCancel: 无取消标记 → 需 DSH cancel；有标记 → 幂等不重复", () => {
  const fresh = { dshSessionId: SID, taskId: "task-1", rpcId: "r_1", at: 1 };
  assert.deepEqual(planCancel(fresh), { sessionId: SID, taskId: "task-1", dshCancelNeeded: true, hostEscalateAvailable: true });
  const marked = { ...fresh, cancel: { at: 2, reason: "user" } };
  assert.deepEqual(planCancel(marked), { sessionId: SID, taskId: "task-1", dshCancelNeeded: false, hostEscalateAvailable: true });
  assert.deepEqual(planCancel(null), { sessionId: "", taskId: "", dshCancelNeeded: false, hostEscalateAvailable: false });
});

test("cancelAccepted: 空值/ok/accepted 视为接受", () => {
  assert.equal(cancelAccepted(undefined), true);
  assert.equal(cancelAccepted(null), true);
  assert.equal(cancelAccepted({}), false);
  assert.equal(cancelAccepted({ ok: true }), true);
  assert.equal(cancelAccepted({ accepted: true }), true);
  assert.equal(cancelAccepted({ ok: false }), false);
});

test("resolveTaskTimeoutSec / resolveApprovalTimeoutMs：无宿主回落与设置注入", () => {
  initAppRuntime(null); // 无宿主：回落
  assert.equal(resolveTaskTimeoutSec(0), 600);
  assert.equal(resolveTaskTimeoutSec(undefined), 600);
  assert.equal(resolveTaskTimeoutSec(120), 120);
  assert.equal(resolveApprovalTimeoutMs(), 30000); // manifest 默认 30s
  const settings = { defaultTimeoutSec: 90, approvalTimeoutSec: 7 };
  initAppRuntime({ ctx: {}, dataDir: ".", readConfig: (k) => settings[k] });
  assert.equal(resolveTaskTimeoutSec(0), 90);
  assert.equal(resolveTaskTimeoutSec(60), 60);
  assert.equal(resolveApprovalTimeoutMs(), 7000);
  settings.approvalTimeoutSec = 0; // 显式禁用
  assert.equal(resolveApprovalTimeoutMs(), 0);
  initAppRuntime(null);
});
