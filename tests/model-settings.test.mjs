// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/model-settings.test.mjs — 默认模型通道的纯函数契约（真机探测核对过的形状，见
// tests/e2e/settings-model.probe.mjs）：
//   · settings/describe 的段是数组（namespaces: [{ns,...}]），不是以段名为键的对象；
//   · session/modelCatalog 是无参方法，信封不能包 session 家族的 request 层（bare）；
//   · 段版本冲突的码是 settings/conflict（DSH 侧 SettingsConflictError 自报 SETTINGS_CONFLICT）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildClientRequest } from "../src/lib/rpc-envelope.ts";
import { AGENT_DEFAULT_MODEL_NS, isSettingsConflict, settingsViewOf } from "../src/lib/dsh-rpc.ts";

test("settingsViewOf: 认 namespaces 数组（真机形状）", () => {
  const view = { ns: AGENT_DEFAULT_MODEL_NS, value: { provider: "p", model: "m" }, revision: 0, applies: "live" };
  const described = { writable: true, hasDocument: true, namespaces: [{ ns: "locale", value: {} }, view] };
  assert.equal(settingsViewOf(described, AGENT_DEFAULT_MODEL_NS), view);
  assert.equal(settingsViewOf(described, "nope"), null);
});

test("settingsViewOf: 也容错以段名为键的对象形状；坏输入不炸", () => {
  assert.deepEqual(settingsViewOf({ [AGENT_DEFAULT_MODEL_NS]: { ns: AGENT_DEFAULT_MODEL_NS } }, AGENT_DEFAULT_MODEL_NS), { ns: AGENT_DEFAULT_MODEL_NS });
  assert.deepEqual(settingsViewOf({ sections: { x: { ns: "x" } } }, "x"), { ns: "x" });
  assert.equal(settingsViewOf(null, "x"), null);
  assert.equal(settingsViewOf("nope", "x"), null);
  assert.equal(settingsViewOf({}, "x"), null);
});

test("isSettingsConflict: 认 settings/conflict（网关形态）与 SETTINGS_CONFLICT（服务形态）", () => {
  const gateway = new Error("DSH rpc 失败：settings/conflict settings namespace \"agent-default-model\" changed since it was read");
  assert.equal(isSettingsConflict(gateway), true);
  const service = new Error("changed since it was read");
  service.code = "SETTINGS_CONFLICT";
  assert.equal(isSettingsConflict(service), true);
  const other = new Error("DSH rpc 失败：gateway/bad-request 参数不符");
  other.code = "gateway/bad-request";
  assert.equal(isSettingsConflict(other), false);
  assert.equal(isSettingsConflict(null), false);
});

test("信封：session/modelCatalog 走 bare（不包 request），session/cancel 仍包", () => {
  const bare = buildClientRequest({ method: "session/modelCatalog", payload: {}, bare: true });
  assert.deepEqual(bare.body.payload.args, {});
  const wrapped = buildClientRequest({ method: "session/cancel", payload: { sessionId: "s1" } });
  assert.equal(typeof wrapped.body.payload.args.request, "object");
  assert.equal(wrapped.body.payload.args.request.sessionId, "s1");
});

test("信封：settings/replace 的 args 按参数名给（ns/section/expectedRevision）", () => {
  const { body } = buildClientRequest({ method: "settings/replace", payload: { ns: "agent-default-model", section: { provider: "p", model: "m" }, expectedRevision: 0 } });
  assert.equal(body.method, "settings/replace");
  assert.deepEqual(body.payload.args, { ns: "agent-default-model", section: { provider: "p", model: "m" }, expectedRevision: 0 });
});

test("信封：settings/describe 不带 expectedRevision 这类多余键（网关按声明参数名严格校验）", () => {
  const { body } = buildClientRequest({ method: "settings/describe", payload: {} });
  assert.deepEqual(body.payload.args, {});
  assert.equal(body.method, "settings/describe");
});
