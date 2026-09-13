// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/rpc-envelope.test.mjs — src/lib/rpc-envelope.js 信封构造/解析单测（node --test）
// 覆盖：client-request 信封（v1 复用格式）、session 方法 gateway 包装（request/_request +
// requestId 注入）、rpcId 回显校验、result.ok 语义。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextRpcId,
  endpointOf,
  isSessionMethod,
  buildClientRequest,
  parseServerResponse,
  defaultRpcTimeoutMs,
} from "../src/lib/rpc-envelope.js";

test("endpointOf: 点号方法 → 斜杠端点；斜杠方法直通", () => {
  assert.equal(endpointOf("session.create"), "session/create");
  assert.equal(endpointOf("session.prompt"), "session/prompt");
  assert.equal(endpointOf("session/list"), "session/list");
  assert.equal(endpointOf("respond"), "respond");
});

test("isSessionMethod: session.* 前缀判定", () => {
  assert.equal(isSessionMethod("session.create"), true);
  assert.equal(isSessionMethod("session/list"), true);
  assert.equal(isSessionMethod("session.selectModel"), true);
  assert.equal(isSessionMethod("respond"), false);
  assert.equal(isSessionMethod("session"), false);
});

test("buildClientRequest: 通用方法裸 payload 透传 + rpcId 生成/回传", () => {
  const { body, rpcId } = buildClientRequest({ method: "respond", payload: { eventId: "e1", outcome: { kind: "result", value: "rejected" } } });
  assert.ok(rpcId && typeof rpcId === "string");
  assert.equal(body.type, "client-request");
  assert.equal(body.rpcId, rpcId);
  assert.equal(body.method, "respond");
  assert.deepEqual(body.payload, { args: { eventId: "e1", outcome: { kind: "result", value: "rejected" } } });
});

test("buildClientRequest: session.create 包 request + 注入 requestId（jsonl 定位键）", () => {
  const { body, rpcId } = buildClientRequest({ method: "session.create", payload: { cwd: "C:/work", agentPreset: "ptc" } });
  assert.equal(body.method, "session/create"); // 网关校验 method === 端点路径段
  assert.deepEqual(body.payload.args, {
    request: { cwd: "C:/work", agentPreset: "ptc", requestId: rpcId },
  });
});

test("buildClientRequest: session.list 用 _request；显式 rpcId 保留", () => {
  const { body, rpcId } = buildClientRequest({ method: "session.list", payload: { projections: ["id", "cwd"] }, rpcId: "r_fixed" });
  assert.equal(rpcId, "r_fixed");
  assert.deepEqual(body.payload.args, { _request: { projections: ["id", "cwd"], requestId: "r_fixed" } });
});

test("parseServerResponse: 成功取 result.value；rpcId 不匹配抛错", () => {
  const v = parseServerResponse({ rpcId: "r1", result: { ok: true, value: { sessionId: "session-1" } } }, "r1");
  assert.deepEqual(v, { sessionId: "session-1" });
  assert.throws(() => parseServerResponse({ rpcId: "r2", result: { ok: true, value: 1 } }, "r1"), /rpcId 不匹配/);
});

test("parseServerResponse: result.ok=false 抛错并带 dsh code", () => {
  try {
    parseServerResponse({ rpcId: "r1", result: { ok: false, error: { code: "session-conflict", message: "conflict" } } }, "r1");
    assert.fail("应抛错");
  } catch (e) {
    assert.equal(e.code, "session-conflict");
    assert.match(e.message, /session-conflict/);
  }
});

test("辅助：nextRpcId 唯一、defaultRpcTimeoutMs 恒正", () => {
  assert.notEqual(nextRpcId(), nextRpcId());
  assert.ok(defaultRpcTimeoutMs() > 0);
});
