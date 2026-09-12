// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/provider-identity.test.mjs — src-cordis/plugins/provider/lib/identity.js 单测
// 覆盖《DSHana 调用 Hana 模型接口指南》§3/§5 的身份判定：有映射=taskId（Hana 委派）、
// 无映射=App 身份（DSH Web UI 独立会话，两个身份参数都不传）；容错不抛；身份字段只有
// taskId（callToken 是工具调用期推理的事，本 adapter 从不传）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModelIdentity } from "../src-cordis/plugins/provider/lib/identity.js";

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

test("无映射（DSH Web UI 自建会话）→ App 身份：identity 为空对象", () => {
  const r = resolveModelIdentity(dir, SID);
  assert.deepEqual(r, { identity: {}, source: "app" });
  assert.equal("taskId" in r.identity, false);
  assert.equal("callToken" in r.identity, false);
});

test("有映射（dshana_session 委派）→ taskId 身份，且只带 taskId", () => {
  seedMap(SID, { taskId: "task-1", dshSessionId: SID, action: "create", rpcId: "r_1" });
  const r = resolveModelIdentity(dir, SID);
  assert.deepEqual(r, { identity: { taskId: "task-1" }, source: "task" });
  assert.deepEqual(Object.keys(r.identity), ["taskId"]);
});

test("dataDir/sessionId 缺失 → App 身份（不抛）", () => {
  assert.deepEqual(resolveModelIdentity(null, SID), { identity: {}, source: "app" });
  assert.deepEqual(resolveModelIdentity(dir, null), { identity: {}, source: "app" });
  assert.deepEqual(resolveModelIdentity(null, null), { identity: {}, source: "app" });
  assert.deepEqual(resolveModelIdentity(undefined, undefined), { identity: {}, source: "app" });
});

test("非法 sessionId / 损坏映射 / 无 taskId → App 身份（容错不抛，防路径穿越）", () => {
  assert.deepEqual(resolveModelIdentity(dir, "../../etc/passwd"), { identity: {}, source: "app" });
  seedMap(SID, "{broken");
  assert.deepEqual(resolveModelIdentity(dir, SID), { identity: {}, source: "app" });
  seedMap(SID, { dshSessionId: SID }); // 合法 JSON 但无 taskId
  assert.deepEqual(resolveModelIdentity(dir, SID), { identity: {}, source: "app" });
});

test("委派任务终结、映射被删 → 同会话回到 App 身份（不遗留陈旧 taskId）", () => {
  seedMap(SID, { taskId: "task-1", dshSessionId: SID });
  assert.deepEqual(resolveModelIdentity(dir, SID).source, "task");
  rmSync(join(dir, "dshana", "taskmaps", SID + ".json"));
  assert.deepEqual(resolveModelIdentity(dir, SID), { identity: {}, source: "app" });
});
