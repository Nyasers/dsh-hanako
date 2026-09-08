// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/dshana-routes.test.mjs — src/routes/dshana-routes.js 挂载/响应单测（fake app/ctx）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerDshanaRoutes,
  DASHANA_ROUTE_PREFIX,
  dshanaRoutesTable,
} from "../src/routes/dshana-routes.js";

function makeFakeApp() {
  const routes = [];
  const app = {
    get(path, h) { routes.push(["GET", path, h]); return app; },
    post(path, h) { routes.push(["POST", path, h]); return app; },
    all(path, h) { routes.push(["ALL", path, h]); return app; },
  };
  return { app, routes };
}

function makeFakeCtx() {
  const ctx = { body: null, status: null };
  ctx.json = (body, status) => {
    ctx.body = body;
    ctx.status = typeof status === "number" ? status : 200;
    return { status: ctx.status, body };
  };
  return ctx;
}

function makeFakeDeps(over = {}) {
  const calls = { getSnapshot: 0, start: 0, stop: 0 };
  const state = { phase: "idle", ready: false, runtimeId: null, proxyPrefix: null, service: null, error: null, note: "未启动（fake）", updatedAt: "t" };
  return {
    appId: "dsh-hanako",
    version: "2.0.0-test",
    log: () => {},
    ...over,
    calls,
    getSnapshot: () => { calls.getSnapshot += 1; return over.getSnapshot ? over.getSnapshot() : state; },
    start: async () => { calls.start += 1; return { ok: true }; },
    stop: async () => { calls.stop += 1; return { ok: true }; },
  };
}

test("挂载清单：GET boot-state/health + POST start/stop（前缀 dshana）", () => {
  const { app, routes } = makeFakeApp();
  registerDshanaRoutes(app, makeFakeDeps());
  const paths = routes.map(([m, p]) => m + " " + p).sort();
  assert.deepEqual(paths, [
    "GET /dshana/boot-state",
    "GET /dshana/health",
    "POST /dshana/start",
    "POST /dshana/stop",
  ]);
  assert.deepEqual(dshanaRoutesTable().map(([m, p]) => m + " " + p).sort(), paths);
  assert.equal(DASHANA_ROUTE_PREFIX, "/dshana");
});

test("GET /dshana/boot-state: 200 归一化快照（ok+app+state）", () => {
  const { app, routes } = makeFakeApp();
  const deps = makeFakeDeps();
  registerDshanaRoutes(app, deps);
  const [,, handler] = routes.find(([m, p]) => m === "GET" && p === "/dshana/boot-state");
  const ctx = makeFakeCtx();
  const out = handler(ctx);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.ok, true);
  assert.equal(ctx.body.app.id, "dsh-hanako");
  assert.equal(ctx.body.state.phase, "idle");
  assert.equal(out.status, 200);
  assert.equal(deps.calls.getSnapshot, 1);
});

test("GET /dshana/health: 200 存活", () => {
  const { app, routes } = makeFakeApp();
  registerDshanaRoutes(app, makeFakeDeps());
  const [,, handler] = routes.find(([m, p]) => m === "GET" && p === "/dshana/health");
  const ctx = makeFakeCtx();
  handler(ctx);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.ok, true);
});

test("POST /dshana/start: idle → 202 accepted + fire start（不阻塞请求）", async () => {
  const { app, routes } = makeFakeApp();
  const deps = makeFakeDeps();
  registerDshanaRoutes(app, deps);
  const [,, handler] = routes.find(([m, p]) => m === "POST" && p === "/dshana/start");
  const ctx = makeFakeCtx();
  await handler(ctx);
  assert.equal(ctx.status, 202);
  assert.equal(ctx.body.ok, true);
  assert.equal(ctx.body.accepted, true);
  assert.equal(ctx.body.reason, undefined);
  await new Promise((r) => setTimeout(r, 0)); // 等 fire-and-forget
  assert.equal(deps.calls.start, 1);
});

test("POST /dshana/start: 已 ready/starting → 不重复触发", async () => {
  const { app, routes } = makeFakeApp();
  const readyState = { phase: "ready", ready: true, runtimeId: "rt-1", proxyPrefix: "/api/apps/dsh-hanako/routes/_runtime/rt-1/", service: { state: "ready", port: 4317 }, error: null, note: "ready", updatedAt: "t" };
  const deps = makeFakeDeps({ getSnapshot: () => readyState });
  registerDshanaRoutes(app, deps);
  const [,, handler] = routes.find(([m, p]) => m === "POST" && p === "/dshana/start");
  const ctx = makeFakeCtx();
  await handler(ctx);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.accepted, false);
  assert.equal(ctx.body.reason, "already-ready");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(deps.calls.start, 0, "ready 时不重复启动");
});

test("POST /dshana/stop: 停 runtime（幂等）", async () => {
  const { app, routes } = makeFakeApp();
  const deps = makeFakeDeps();
  registerDshanaRoutes(app, deps);
  const [,, handler] = routes.find(([m, p]) => m === "POST" && p === "/dshana/stop");
  const ctx = makeFakeCtx();
  await handler(ctx);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.ok, true);
  assert.equal(deps.calls.stop, 1);
  assert.equal(deps.calls.getSnapshot >= 1, true);
});
