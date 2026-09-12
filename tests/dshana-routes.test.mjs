// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/dshana-routes.test.mjs — src/routes/dshana-routes.js 挂载/响应单测（fake app/ctx）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  registerDshanaRoutes,
  defaultDshanaRouteDeps,
  DASHANA_ROUTE_PREFIX,
  dshanaRoutesTable,
} from "../src/routes/dshana-routes.ts";
import { writeTaskMap, markTaskMapEnded } from "../src/lib/task-map.ts";
import { initAppRuntime } from "../src/lib/app-runtime.ts";
import { resetDataSourceStore } from "../src/lib/data-source.ts";

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
  ctx.html = (body, status) => {
    ctx.body = body;
    ctx.status = typeof status === "number" ? status : 200;
    return { status: ctx.status, body };
  };
  return ctx;
}

/** 查询串 ctx（GET 路由用；fake 只认 query(name)） */
function queryCtx(params) {
  const ctx = makeFakeCtx();
  ctx.req = { query: (name) => (name in params ? params[name] : undefined) };
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

test("挂载清单：GET boot-state/health/settings/model/card-state + POST start/stop/settings/model（前缀 dshana）", () => {
  const { app, routes } = makeFakeApp();
  registerDshanaRoutes(app, makeFakeDeps());
  const paths = routes.map(([m, p]) => m + " " + p).sort();
  assert.deepEqual(paths, [
    "GET /dshana/boot-state",
    "GET /dshana/card-state",
    "GET /dshana/health",
    "GET /dshana/model",
    "GET /dshana/settings",
    "POST /dshana/model",
    "POST /dshana/settings",
    "POST /dshana/settings/restart",
    "POST /dshana/start",
    "POST /dshana/stop",
  ]);
  assert.deepEqual(dshanaRoutesTable().map(([m, p]) => m + " " + p).sort(), paths);
  assert.equal(DASHANA_ROUTE_PREFIX, "/dshana");
});

test("GET /dshana/settings: 200 返回设置视图（两个超时 + 数据模式 + revision）", async () => {
  const { app, routes } = makeFakeApp();
  registerDshanaRoutes(app, makeFakeDeps({
    readSettings: async () => ({
      revision: 7,
      settings: { mode: "private", path: null, profile: "dshana", approvalTimeoutSec: 30, defaultTimeoutSec: 1800 },
      source: { sourceId: "private", home: "C:/data/.dsh", profileName: "dshana", shared: false, mode: "private" },
      lastShared: null,
    }),
  }));
  const [,, handler] = routes.find(([m, p]) => m === "GET" && p === "/dshana/settings");
  const ctx = makeFakeCtx();
  await handler(ctx);
  assert.equal(ctx.status, 200);
  assert.equal(ctx.body.ok, true);
  assert.equal(ctx.body.revision, 7);
  assert.equal(ctx.body.settings.approvalTimeoutSec, 30);
  assert.equal(ctx.body.settings.mode, "private");
  assert.equal(ctx.body.source.sourceId, "private");
});

test("POST /dshana/settings: 带 expectedRevision 写入并回新视图", async () => {
  const { app, routes } = makeFakeApp();
  let seen = null;
  registerDshanaRoutes(app, makeFakeDeps({
    writeSettings: async (patch, expectedRevision) => {
      seen = { patch, expectedRevision };
      return {
        revision: 8,
        settings: { mode: "private", path: null, profile: "dshana", approvalTimeoutSec: 45, defaultTimeoutSec: 1800 },
        source: { sourceId: "private", home: "C:/data/.dsh", profileName: "dshana", shared: false, mode: "private" },
        lastShared: null,
      };
    },
  }));
  const [,, handler] = routes.find(([m, p]) => m === "POST" && p === "/dshana/settings");
  const ctx = makeFakeCtx();
  ctx.req = { json: async () => ({ settings: { approvalTimeoutSec: 45 }, expectedRevision: 7 }) };
  await handler(ctx);
  assert.equal(ctx.status, 200);
  assert.deepEqual(seen, { patch: { approvalTimeoutSec: 45 }, expectedRevision: 7 }, "只把 settings 里的补丁与原 revision 交给写面");
  assert.equal(ctx.body.revision, 8);
  assert.equal(ctx.body.settings.approvalTimeoutSec, 45);
});

test("POST /dshana/settings: revision 落后 → 409 + code（不静默覆盖）", async () => {
  const { app, routes } = makeFakeApp();
  registerDshanaRoutes(app, makeFakeDeps({
    writeSettings: async () => {
      const e = new Error("设置已被别处改过（revision 9 ≠ 7），请刷新后重试");
      e.code = "SETTINGS_CONFLICT";
      e.revision = 9;
      throw e;
    },
  }));
  const [,, handler] = routes.find(([m, p]) => m === "POST" && p === "/dshana/settings");
  const ctx = makeFakeCtx();
  ctx.req = { json: async () => ({ settings: { approvalTimeoutSec: 45 }, expectedRevision: 7 }) };
  await handler(ctx);
  assert.equal(ctx.status, 409);
  assert.equal(ctx.body.ok, false);
  assert.equal(ctx.body.code, "SETTINGS_CONFLICT");
  assert.equal(ctx.body.revision, 9, "把当前 revision 一并给回，页面好刷新");
});

test("POST /dshana/settings: 带来源字段 → 400（改来源必须走切换链）", async () => {
  const { app, routes } = makeFakeApp();
  let called = 0;
  registerDshanaRoutes(app, makeFakeDeps({
    writeSettings: async () => { called += 1; return {}; },
  }));
  const [,, handler] = routes.find(([m, p]) => m === "POST" && p === "/dshana/settings");
  const ctx = makeFakeCtx();
  ctx.req = { json: async () => ({ settings: { mode: "shared", path: "D:/dsh" }, expectedRevision: 1 }) };
  await handler(ctx);
  assert.equal(ctx.status, 400);
  assert.match(ctx.body.error, /数据来源不在本端点改/);
  assert.equal(called, 0, "来源变更不得当普通设置写");
});

test("POST /dshana/settings: 设置值非法（存储侧校验）→ 400，不当 500", async () => {
  const { app, routes } = makeFakeApp();
  registerDshanaRoutes(app, makeFakeDeps({
    writeSettings: async () => { throw new Error("approvalTimeoutSec 必须是不小于 0 的整数秒（收到 -3）"); },
  }));
  const [,, handler] = routes.find(([m, p]) => m === "POST" && p === "/dshana/settings");
  const ctx = makeFakeCtx();
  ctx.req = { json: async () => ({ settings: { approvalTimeoutSec: -3 }, expectedRevision: 1 }) };
  await handler(ctx);
  assert.equal(ctx.status, 400);
  assert.match(ctx.body.error, /approvalTimeoutSec/);
});

test("POST /dshana/settings: 形状不对 → 400（不写盘）", async () => {
  const { app, routes } = makeFakeApp();
  let called = 0;
  registerDshanaRoutes(app, makeFakeDeps({
    writeSettings: async () => { called += 1; return {}; },
  }));
  const [,, handler] = routes.find(([m, p]) => m === "POST" && p === "/dshana/settings");
  const ctx = makeFakeCtx();
  ctx.req = { json: async () => ({ bogus: "x" }) };
  await handler(ctx);
  assert.equal(ctx.status, 400);
  assert.equal(ctx.body.ok, false);
  assert.equal(called, 0, "形状不对时不应调用写面");
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

// ---- 数据源切换：入口暂时撤下（实现留在 lib/source-switch.ts 与其单测里）----

test("POST /dshana/settings/restart: 入口暂撤 → 一律 503 SWITCH_DISABLED，不碰切换链", async () => {
  const { app, routes } = makeFakeApp();
  let called = 0;
  registerDshanaRoutes(app, makeFakeDeps({
    switchSource: async () => { called += 1; return { ok: true, operation: { id: "switch-1" } }; },
  }));
  const [,, handler] = routes.find(([m, p]) => m === "POST" && p === "/dshana/settings/restart");
  for (const body of [
    { settings: { mode: "shared", path: "D:/dsh" }, expectedRevision: 3 },
    { mode: "shared" },
    null,
  ]) {
    const ctx = makeFakeCtx();
    ctx.req = { json: async () => body };
    await handler(ctx);
    assert.equal(ctx.status, 503, "形状对不对都只回 503：入口撤下，不做形状判定");
    assert.equal(ctx.body.code, "SWITCH_DISABLED");
  }
  assert.equal(called, 0, "撤下的入口不得触发切换链（它会停掉正在跑的 runtime）");
});

test("GET /dshana/settings: 不再带切换面字段（operation / defaults 已撤）", async () => {
  const { app, routes } = makeFakeApp();
  registerDshanaRoutes(app, makeFakeDeps({
    readSettings: async () => ({
      revision: 1,
      settings: { mode: "private", path: null, profile: "dshana", approvalTimeoutSec: 30, defaultTimeoutSec: 1800 },
      source: { sourceId: "private" },
      lastShared: null,
    }),
    switchOperation: () => ({ id: "switch-1", state: "failed", error: "预检未通过" }),
  }));
  const [,, handler] = routes.find(([m, p]) => m === "GET" && p === "/dshana/settings");
  const ctx = makeFakeCtx();
  await handler(ctx);
  assert.equal(ctx.body.operation, undefined);
  assert.equal(ctx.body.defaults, undefined);
  assert.equal(ctx.body.source.sourceId, "private", "只读的当前源回显留着（诊断用）");
});

// ---- 会话流卡的状态面（ui/card.html 加载后的一次性取数，不是轮询面）----

const CARD_SID = "session-0f0e0d0c-0b0a-4009-0807-060504030201";

test("GET /dshana/card-state: 200 返回卡页可直接换进 DOM 的状态行 HTML", async () => {
  const { app, routes } = makeFakeApp();
  registerDshanaRoutes(app, makeFakeDeps({
    readCardState: (sid) => {
      assert.equal(sid, CARD_SID);
      return { state: "tracked", label: "运行中", detail: "App 侧仍在跟踪（rpcId rpc-1）" };
    },
  }));
  const [,, handler] = routes.find(([m, p]) => m === "GET" && p === "/dshana/card-state");
  const ctx = queryCtx({ sessionId: CARD_SID });
  await handler(ctx);
  assert.equal(ctx.status, 200);
  assert.match(ctx.body, /^<div class="state" id="dsh-state" data-state="tracked">/);
  assert.match(ctx.body, /运行中/);
  assert.match(ctx.body, /rpc-1/);
});

test("GET /dshana/card-state: sessionId 形态不对 → 400（形状错，不当 200 的空状态）", async () => {
  const { app, routes } = makeFakeApp();
  let called = 0;
  registerDshanaRoutes(app, makeFakeDeps({
    readCardState: () => { called += 1; return { state: "tracked", label: "运行中", detail: "" }; },
  }));
  const [,, handler] = routes.find(([m, p]) => m === "GET" && p === "/dshana/card-state");
  for (const params of [{}, { sessionId: "not-a-session" }]) {
    const ctx = queryCtx(params);
    await handler(ctx);
    assert.equal(ctx.status, 400);
    assert.match(ctx.body, /data-state="unknown"/);
  }
  assert.equal(called, 0, "id 不合法时不去读状态面");
});

test("GET /dshana/card-state: 默认实现读 task-map（无记录 / 跟踪中 / 已终结）", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dshana-card-state-"));
  try {
    const deps = defaultDshanaRouteDeps({ appId: "dshana", dataDir, logger: { info() {} } });
    assert.equal((await deps.readCardState(CARD_SID)).state, "unknown", "没有映射就是没有记录（不猜还在跑）");
    writeTaskMap(dataDir, { taskId: "task-1", dshSessionId: CARD_SID, action: "create", rpcId: "rpc-1" });
    const tracked = await deps.readCardState(CARD_SID);
    assert.equal(tracked.state, "tracked");
    assert.match(tracked.detail, /rpc-1/);
    markTaskMapEnded(dataDir, CARD_SID, "success");
    const ended = await deps.readCardState(CARD_SID);
    assert.equal(ended.state, "ended", "终态优先于跟踪中");
    assert.match(ended.detail, /success/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---- 真机 ctx 形状契约 ----
// 曾经踩到：deps 按 ctx.config.dataDir 取数据目录，而宿主（@hana/app-sdk）只在 ctx 顶层给
// dataDir，ctx.config 是设置读写面。后果 = 读路径静默降级（卡状态恒 unknown），写设置恒 500。

/** 真机形状的宿主 ctx：dataDir 在顶层；config 只有方法，没有 dataDir。 */
function hostLikeCtx(dataDir) {
  return {
    appId: "dshana",
    dataDir,
    logger: { info() {} },
    config: { get: () => undefined, getAll: () => ({}), set() {}, setMany() {} },
  };
}

test("defaultDshanaRouteDeps: 数据目录取宿主顶层 ctx.dataDir（ctx.config 上没有 dataDir）", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dshana-host-ctx-"));
  try {
    const deps = defaultDshanaRouteDeps(hostLikeCtx(dataDir));
    assert.equal((await deps.readCardState(CARD_SID)).state, "unknown");
    writeTaskMap(dataDir, { taskId: "task-1", dshSessionId: CARD_SID, action: "create", rpcId: "rpc-1" });
    assert.equal((await deps.readCardState(CARD_SID)).state, "tracked", "顶层 dataDir 必须真的接进 task-map 读取");

    // 写设置：旧写法在这份 ctx 下恒空 → 必抛；顶层取值后应能落盘并回新视图
    resetDataSourceStore();
    initAppRuntime({ ctx: hostLikeCtx(dataDir), dataDir });
    const view = await deps.writeSettings({ approvalTimeoutSec: 45 }, 0);
    assert.equal(view.settings.approvalTimeoutSec, 45);
    assert.equal(view.revision, 1);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, "integration", "settings.json"), "utf8"));
    assert.equal(onDisk.settings.approvalTimeoutSec, 45, "写设置必须真的落在 ctx.dataDir 下");
  } finally {
    initAppRuntime(null);
    resetDataSourceStore();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
