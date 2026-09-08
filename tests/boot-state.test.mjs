// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/boot-state.test.mjs — src/lib/boot-state.js 纯函数单测（node --test）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runtimeProxyPrefix,
  parseRuntimeProxyPrefix,
  buildBootSnapshot,
  stripSnapshotMeta,
  phaseCopy,
  APP_ID,
} from "../src/lib/boot-state.js";

test("runtimeProxyPrefix: 宿主契约形态（/api/apps/<appId>/routes/_runtime/<runtimeId>/，含尾斜杠）", () => {
  assert.equal(runtimeProxyPrefix({ runtimeId: "rt-1" }), "/api/apps/" + APP_ID + "/routes/_runtime/rt-1/");
  assert.equal(runtimeProxyPrefix({ appId: "x y", runtimeId: "a/b" }), "/api/apps/x%20y/routes/_runtime/a%2Fb/");
  assert.equal(runtimeProxyPrefix({}), null);
  assert.equal(runtimeProxyPrefix({ runtimeId: "" }), null);
});

test("parseRuntimeProxyPrefix: 反解析（校验/单测用）", () => {
  assert.deepEqual(parseRuntimeProxyPrefix("/api/apps/dsh-hanako/routes/_runtime/rt-1/"), { appId: "dsh-hanako", runtimeId: "rt-1" });
  assert.deepEqual(parseRuntimeProxyPrefix("/api/apps/dsh-hanako/routes/_runtime/rt-1"), { appId: "dsh-hanako", runtimeId: "rt-1" });
  assert.equal(parseRuntimeProxyPrefix("/api/apps/dsh-hanako/routes/dshana/boot-state"), null);
  assert.equal(parseRuntimeProxyPrefix(null), null);
});

test("buildBootSnapshot: idle（未启动）归一化", () => {
  const s = buildBootSnapshot({ phase: "idle", runtimeId: null, info: null, lastError: null });
  assert.equal(s.phase, "idle");
  assert.equal(s.ready, false);
  assert.equal(s.runtimeId, null);
  assert.equal(s.proxyPrefix, null);
  assert.equal(s.service, null);
  assert.equal(s.error, null);
  assert.ok(typeof s.note === "string" && s.note.includes("未启动"));
});

test("buildBootSnapshot: ready 需 phase+runtimeId+service.state=ready（绝不把 runtimeId 当就绪）", () => {
  const notReady = buildBootSnapshot({ phase: "ready", runtimeId: "rt-1", info: { service: { state: "pending", port: 4317 } }, lastError: null });
  assert.equal(notReady.ready, false);
  assert.equal(notReady.proxyPrefix, null, "service 未就绪不给前缀");
  const ready = buildBootSnapshot({ phase: "ready", runtimeId: "rt-1", info: { service: { state: "ready", port: 4317 } }, lastError: null });
  assert.equal(ready.ready, true);
  assert.equal(ready.proxyPrefix, "/api/apps/dsh-hanako/routes/_runtime/rt-1/");
  assert.deepEqual(ready.service, { state: "ready", port: 4317 });
});

test("buildBootSnapshot: error 携带 code + userText", () => {
  const err = new Error("端口被占用或 DSH 无法监听。改 App 设置 servicePort 后重试。");
  err.code = "port-busy";
  const s = buildBootSnapshot({ phase: "error", runtimeId: null, info: null, lastError: err });
  assert.equal(s.ready, false);
  assert.deepEqual(s.error, { code: "port-busy", userText: err.message });
  assert.ok(s.note.includes("失败"));
});

test("phaseCopy/文案覆盖五态", () => {
  for (const p of ["idle", "starting", "ready", "error", "stopped"]) {
    assert.ok(typeof phaseCopy(p) === "string" && phaseCopy(p).length > 0, p);
  }
});

test("stripSnapshotMeta: 快照深度等价忽略 updatedAt", () => {
  const a = stripSnapshotMeta(buildBootSnapshot({ phase: "idle" }));
  const b = stripSnapshotMeta(buildBootSnapshot({ phase: "idle" }));
  assert.deepEqual(a, b);
  assert.ok(!("updatedAt" in a));
});
