// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/task-ownership.test.mjs — src/lib/task-ownership.js（归属校验通则）
//
// 锁死四条：
//   ① 显式 sessionId ⇒ 凭证路径，跳过校验（故意跨对话的能力保留）
//   ② 句柄路径 + 记录的 parentSessionPath 与本次 context.sessionPath 一致 ⇒ 放行
//   ③ 句柄路径 + 不一致 ⇒ 拒绝
//   ④ 拿不到 context.sessionPath（按钮通道）⇒ 放行；记录缺 parentSessionPath ⇒ 拒绝（fail-closed）
import { test } from "node:test";
import assert from "node:assert/strict";
import { taskOwnership, ownershipRefusalText } from "../src/lib/task-ownership.js";

const HERE = "/home/u/.hanako/sessions/aaaa.jsonl";
const OTHER = "/home/u/.hanako/sessions/bbbb.jsonl";

test("① 显式 sessionId：跳过归属校验（凭证路径）", () => {
  const r = taskOwnership({ taskRecord: { parentSessionPath: OTHER }, sessionPath: HERE, explicitSessionId: true });
  assert.deepEqual(r, { ok: true, reason: "explicit-session-id" });
});

test("② 句柄路径 + 来源会话一致 ⇒ 放行", () => {
  const r = taskOwnership({ taskRecord: { parentSessionPath: HERE }, sessionPath: HERE });
  assert.deepEqual(r, { ok: true, reason: "session-match" });
});

test("③ 句柄路径 + 来源会话不一致 ⇒ 拒绝", () => {
  const r = taskOwnership({ taskRecord: { parentSessionPath: OTHER }, sessionPath: HERE });
  assert.deepEqual(r, { ok: false, reason: "session-mismatch" });
  assert.match(ownershipRefusalText(r.reason), /另一段对话/);
});

test("④ 无 context.sessionPath（按钮/卡片通道）⇒ 放行并标注原因", () => {
  for (const sp of [null, undefined, ""]) {
    const r = taskOwnership({ taskRecord: { parentSessionPath: OTHER }, sessionPath: sp });
    assert.deepEqual(r, { ok: true, reason: "no-session-context" });
  }
});

test("④ 记录缺 parentSessionPath（session 任务却为空=异常）⇒ 拒绝 fail-closed", () => {
  for (const rec of [{}, { parentSessionPath: null }, { parentSessionPath: 7 }, null, undefined]) {
    const r = taskOwnership({ taskRecord: rec, sessionPath: HERE });
    assert.deepEqual(r, { ok: false, reason: "record-missing-parent-session" });
  }
  assert.match(ownershipRefusalText("record-missing-parent-session"), /fail-closed/);
});

test("ownershipRefusalText：未知原因也有可读文案", () => {
  assert.equal(typeof ownershipRefusalText("weird"), "string");
  assert.match(ownershipRefusalText(undefined), /unknown/);
});
