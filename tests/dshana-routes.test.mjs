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
} from "../src/routes/dshana-routes.ts";

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
    appId: "dshana",
    version: "2.0.0-test",
    log: () => {},
    ...over,
    calls,
    getSnapshot: () => { calls.getSnapshot += 1; return over.getSnapshot ? over.getSnapshot() : state; },
    start: async () => { calls.start += 1; return { ok: true }; },
    stop: async () => { calls.stop += 1; return { ok: true }; },
  };
}

test("挂载清单：GET boot-state/health/settings/model + POST start/stop/settings/model（前缀 dshana）", () => {
  const { app, routes } = makeFakeApp();
  registerDshanaRoutes(app, makeFakeDeps());
  const paths = routes.map(([m, p]) => m + " " + p).sort();
  assert.deepEqual(paths, [
    "GET /dshana/boot-state",
    "GET /dshana/health",
    "GET /dshana/model",
    "GET /dshana/settings",
    "POST /dshana/model",
    "POST /dshana/settings",
    "POST /dshana/start",
    "POST /dshana/stop",
  ]);
  assert.deepEqual(dshanaRoutesTable().map(([m, p]) => m + " " + p).sort(), paths);
  assert.equal(DASHANA_ROUTE_PREFIX, "/dshana");
});

test("GET /dshana/settings: 200 返回生效值（deps 注入）", () => {
  const { app, routes } = makeFakeApp();
  registerDshanaRoutes(app, makeFakeDeps({
    readSettings: () => ({ approvalTimeoutSec: 30, defaultTimeoutSec: 1800 }),
  }));
  const [,, handler] = routes.find(([m, p]) => m === "GET" && p === "/dshana/settings");
  const ctx = makeFakeCtx();
  handler(ctx);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.ok, true);
  assert.deepEqual(ctx.body.settings, { approvalTimeoutSec: 30, defaultTimeoutSec: 1800 });
});

test("POST /dshana/settings: 白名单过滤 + 写回 + 返回生效值", async () => {
  const { app, routes } = makeFakeApp();
  let written = null;
  registerDshanaRoutes(app, makeFakeDeps({
    writeSettings: (patch) => {
      written = patch;
      return { approvalTimeoutSec: patch.approvalTimeoutSec ?? 30, defaultTimeoutSec: 1800 };
    },
  }));
  const [,, handler] = routes.find(([m, p]) => m === "POST" && p === "/dshana/settings");
  const ctx = makeFakeCtx();
  ctx.req = { json: async () => ({ approvalTimeoutSec: 45, bogus: 1, defaultTimeoutSec: -3 }) };
  await handler(ctx);
  assert.equal(ctx.status, 200);
  assert.deepEqual(written, { approvalTimeoutSec: 45 }, "只写白名单且仅有限非负数（负数被剔）");
  assert.equal(ctx.body.settings.approvalTimeoutSec, 45);
});

test("POST /dshana/settings: 无合法项 → 400（不写盘）", async () => {
  const { app, routes } = makeFakeApp();
  let called = 0;
  registerDshanaRoutes(app, makeFakeDeps({
    writeSettings: () => { called += 1; return {}; },
  }));
  const [,, handler] = routes.find(([m, p]) => m === "POST" && p === "/dshana/settings");
  const ctx = makeFakeCtx();
  ctx.req = { json: async () => ({ bogus: "x" }) };
  await handler(ctx);
  assert.equal(ctx.status, 400);
  assert.equal(ctx.body.ok, false);
  assert.equal(called, 0, "无合法项时不应调用写回");
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
  assert.equal(ctx.body.app.id, "dshana");
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
  const readyState = { phase: "ready", ready: true, runtimeId: "rt-1", proxyPrefix: "/api/apps/dshana/routes/_runtime/rt-1/", service: { state: "ready", port: 4317 }, error: null, note: "ready", updatedAt: "t" };
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

// ---- 默认模型（值归 DSH 的 settings 段；路由只过手）----

const READY_STATE = { phase: "ready", ready: true, runtimeId: "rt-1", proxyPrefix: null, service: { state: "ready", port: 4317 }, error: null, note: "ready", updatedAt: "t" };

function modelCtx(body) {
  const ctx = makeFakeCtx();
  ctx.req = { json: async () => body };
  return ctx;
}

test("GET /dshana/model: DSH 未运行 → ok=false/ready=false（不碰读模型）", async () => {
  const { app, routes } = makeFakeApp();
  let called = 0;
  registerDshanaRoutes(app, makeFakeDeps({ readModel: async () => { called += 1; return {}; } }));
  const [,, handler] = routes.find(([m, p]) => m === "GET" && p === "/dshana/model");
  const ctx = makeFakeCtx();
  await handler(ctx);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.ok, false);
  assert.equal(ctx.body.ready, false);
  assert.match(ctx.body.error, /未运行/);
  assert.equal(called, 0, "未就绪时不应去读 DSH");
});

test("GET /dshana/model: 就绪 → 原样回读面结果（当前值 + revision + 候选）", async () => {
  const { app, routes } = makeFakeApp();
  const model = {
    current: { provider: "deepseek-official", model: "deepseek-flash" },
    revision: 3,
    applies: "live",
    writable: true,
    catalog: { default: null, routableProviders: ["deepseek-official"], groups: [{ id: "deepseek-official", name: "DeepSeek", models: [{ id: "deepseek-flash", name: "DeepSeek-V41-Flash" }] }], failures: [] },
    catalogError: null,
  };
  registerDshanaRoutes(app, makeFakeDeps({ getSnapshot: () => READY_STATE, readModel: async () => model }));
  const [,, handler] = routes.find(([m, p]) => m === "GET" && p === "/dshana/model");
  const ctx = makeFakeCtx();
  await handler(ctx);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.ok, true);
  assert.equal(ctx.body.ready, true);
  assert.equal(ctx.body.model.revision, 3);
  assert.equal(ctx.body.model.catalog.groups.length, 1);
});

test("GET /dshana/model: 读面抛错 → ok=false/ready=true + error（不假装成功）", async () => {
  const { app, routes } = makeFakeApp();
  registerDshanaRoutes(app, makeFakeDeps({
    getSnapshot: () => READY_STATE,
    readModel: async () => { throw new Error("中继尚未就绪"); },
  }));
  const [,, handler] = routes.find(([m, p]) => m === "GET" && p === "/dshana/model");
  const ctx = makeFakeCtx();
  await handler(ctx);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.ok, false);
  assert.equal(ctx.body.ready, true);
  assert.match(ctx.body.error, /中继尚未就绪/);
});

test("POST /dshana/model: 缺 provider/model → 400（不写）", async () => {
  const { app, routes } = makeFakeApp();
  let called = 0;
  registerDshanaRoutes(app, makeFakeDeps({
    getSnapshot: () => READY_STATE,
    writeModel: async () => { called += 1; return {}; },
  }));
  const [,, handler] = routes.find(([m, p]) => m === "POST" && p === "/dshana/model");
  const ctx = modelCtx({ provider: "deepseek-official" });
  await handler(ctx);
  assert.equal(ctx.status, 400);
  assert.equal(ctx.body.ok, false);
  assert.equal(called, 0);
});

test("POST /dshana/model: 成功 → 200，patch 带到写面（含 expectedRevision）", async () => {
  const { app, routes } = makeFakeApp();
  let written = null;
  registerDshanaRoutes(app, makeFakeDeps({
    getSnapshot: () => READY_STATE,
    writeModel: async (patch) => { written = patch; return { current: { provider: patch.provider, model: patch.model }, revision: 4 }; },
  }));
  const [,, handler] = routes.find(([m, p]) => m === "POST" && p === "/dshana/model");
  const ctx = modelCtx({ provider: "deepseek-official", model: "deepseek-pro", reasoningEffort: "high", expectedRevision: 3, extra: 1 });
  await handler(ctx);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.ok, true);
  assert.deepEqual(written, { provider: "deepseek-official", model: "deepseek-pro", reasoningEffort: "high", expectedRevision: 3 });
  assert.equal(ctx.body.model.revision, 4);
});

test("POST /dshana/model: 段被别处改过 → 409 + code（上游 settings/conflict 上抬）", async () => {
  const { app, routes } = makeFakeApp();
  registerDshanaRoutes(app, makeFakeDeps({
    getSnapshot: () => READY_STATE,
    writeModel: async () => {
      const e = new Error("默认模型已被别处改过（段 revision 前进），请刷新后重试");
      e.code = "SETTINGS_CONFLICT";
      throw e;
    },
  }));
  const [,, handler] = routes.find(([m, p]) => m === "POST" && p === "/dshana/model");
  const ctx = modelCtx({ provider: "deepseek-official", model: "deepseek-flash" });
  await handler(ctx);
  assert.equal(ctx.status, 409);
  assert.equal(ctx.body.ok, false);
  assert.equal(ctx.body.code, "SETTINGS_CONFLICT");
});

test("POST /dshana/model: 非冲突失败 → 200/ok=false + error（不是 409）", async () => {
  const { app, routes } = makeFakeApp();
  registerDshanaRoutes(app, makeFakeDeps({
    getSnapshot: () => READY_STATE,
    writeModel: async () => { throw new Error("settings/replace HTTP 500"); },
  }));
  const [,, handler] = routes.find(([m, p]) => m === "POST" && p === "/dshana/model");
  const ctx = modelCtx({ provider: "deepseek-official", model: "deepseek-flash" });
  await handler(ctx);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.ok, false);
  assert.match(ctx.body.error, /HTTP 500/);
});
