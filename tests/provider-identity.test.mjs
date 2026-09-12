// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/provider-identity.test.mjs — src-cordis/plugins/provider/lib/identity.ts 单测
//
// 锁死的是**三态判定**（App 身份仅限“用户直接在 WebUI 使用”）：
//   ① 无映射          ⇒ App 身份（用户自建会话）
//   ② 映射在 + ended  ⇒ App 身份（任务已终结，用户接着在 WebUI 里跑——事实，不是降级）
//   ③ 映射在 + 活动   ⇒ { taskId }（必须，绑定不能丢）
//   ④ 映射在但读不出  ⇒ **抛错**（TASK_MAP_BROKEN）——绝不伪装成 ①
// 身份字段只有 taskId（callToken 是工具调用期推理的事，本 adapter 从不传）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModelIdentity } from "../src-cordis/plugins/provider/lib/identity.ts";

const SID = "session-11111111-2222-3333-4444-555555555555";
let dir;
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dshana-identity-"));
});
test.afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedMap(sessionId, body) {
  const d = join(dir, "dshana", "taskmaps");
  mkdirSync(d, { recursive: true });
  const text = typeof body === "string" ? body : JSON.stringify(body);
  writeFileSync(join(d, sessionId + ".json"), text, "utf8");
}
function mapPath(sessionId) {
  return join(dir, "dshana", "taskmaps", sessionId + ".json");
}
const ACTIVE = { taskId: "task-1", dshSessionId: SID, action: "create", rpcId: "r_1" };

test("① 无映射（用户自建会话）→ App 身份，reason=unowned-session", () => {
  const r = resolveModelIdentity(dir, SID);
  assert.deepEqual(r, { identity: {}, source: "app", reason: "unowned-session" });
  assert.equal("taskId" in r.identity, false);
  assert.equal("callToken" in r.identity, false);
});

test("③ 映射在且任务活动 → taskId 身份，且只带 taskId", () => {
  seedMap(SID, ACTIVE);
  const r = resolveModelIdentity(dir, SID);
  assert.deepEqual(r, { identity: { taskId: "task-1" }, source: "task" });
  assert.deepEqual(Object.keys(r.identity), ["taskId"]);
});

test("② 映射在但任务终结（ended）→ App 身份，reason=task-ended（不遗留陈旧 taskId）", () => {
  seedMap(SID, { ...ACTIVE, ended: { at: Date.now(), status: "task-terminal" } });
  const r = resolveModelIdentity(dir, SID);
  assert.deepEqual(r, { identity: {}, source: "app", reason: "task-ended" });
});

test("②→③ 终结后同会话再 send（重写映射）→ 回到 taskId 身份", () => {
  seedMap(SID, { ...ACTIVE, ended: { at: Date.now(), status: "task-terminal" } });
  assert.equal(resolveModelIdentity(dir, SID).source, "app");
  seedMap(SID, ACTIVE); // writeTaskMap 每次重建记录，不带 ended
  assert.deepEqual(resolveModelIdentity(dir, SID), { identity: { taskId: "task-1" }, source: "task" });
});

test("dataDir/sessionId 缺失 → App 身份（不抛）", () => {
  assert.deepEqual(resolveModelIdentity(null, SID), { identity: {}, source: "app", reason: "unowned-session" });
  assert.deepEqual(resolveModelIdentity(dir, null), { identity: {}, source: "app", reason: "unowned-session" });
  assert.deepEqual(resolveModelIdentity(null, null), { identity: {}, source: "app", reason: "unowned-session" });
  assert.deepEqual(resolveModelIdentity(undefined, undefined), { identity: {}, source: "app", reason: "unowned-session" });
  assert.deepEqual(resolveModelIdentity(dir, "../../etc/passwd"), { identity: {}, source: "app", reason: "unowned-session" });
});

// ④ 这一组是语义核心：映射读不出必须显式失败，不能把“状态丢了”伪装成“用户自建会话”。
for (const [why, body] of [
  ["JSON 解析失败", "{broken"],
  ["缺 taskId", { dshSessionId: SID }],
  ["taskId 为空串", { taskId: "", dshSessionId: SID }],
  ["dshSessionId 非法", { taskId: "task-1", dshSessionId: "not-a-session" }],
  ["顶层不是对象", "null"],
]) {
  test(`④ 映射损坏（${why}）→ 抛 TASK_MAP_BROKEN，不降级成 App 身份`, () => {
    seedMap(SID, body);
    assert.throws(
      () => resolveModelIdentity(dir, SID),
      (e) => e && e.code === "TASK_MAP_BROKEN",
    );
  });
}

test("④ 目录里没有映射文件（没被写过 or 被 prune）→ 仍是 ① App 身份，不抛", () => {
  mkdirSync(join(dir, "dshana", "taskmaps"), { recursive: true });
  assert.deepEqual(resolveModelIdentity(dir, SID), { identity: {}, source: "app", reason: "unowned-session" });
  rmSync(join(dir, "dshana"), { recursive: true, force: true });
  assert.deepEqual(resolveModelIdentity(dir, SID), { identity: {}, source: "app", reason: "unowned-session" });
  assert.equal(mapPath(SID).includes("taskmaps"), true);
});
