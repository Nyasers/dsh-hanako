// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/routes/dshana-routes.js — dsh-hanako App v2 ctx.routes.register 单 registrar
// （迁移指南 §10/§13 步骤 4/5；v1 routes/webui.js + card.js 两工厂在 v2 合并为单 route app）
//
// 宿主契约（ctx.routes，实证于 server 0.930.1 bundle / @hana/app-sdk）：
//   · 单 bundle App 只能 register 一次；registrar 收到宿主创建的 Hono sub-app（本模块
//     按 duck-typing 挂 get/post，不 import hono 类型）；公开 URL = /api/apps/<appId>/routes/<subpath>，
//     鉴权 app_route（宿主登录或本 App surface 会话）——处理函数在 App 进程内执行
//     （与 ctx.tools.execute 同生命周期，可读 App 运行包与受管 runtime 单例）。
//   · 到受管 runtime 服务的浏览器通道（HTTP/SSE/WS/静态）**不需要本 registrar 转发**：
//     宿主在 runtime service readyMarker 后自动把服务暴露到
//     /api/apps/<appId>/routes/_runtime/<runtimeId>/（自动代理 + 重定向重写 +
//     hana_app_runtime HttpOnly cookie）。本 registrar 只提供壳页/诊断面（boot 状态、
//     启动/停止触发），壳页把 DSH Web UI 指向正确的前缀即可（实证记录见
//     src/lib/boot-state.js 头注释与 DESIGN「步骤 4b/5 收口」）。
//
// 端点（本 App 私有，路径段前缀 dshana）：
//   GET  /dshana/boot-state  归一化 boot 快照（idle/starting/ready/error + 文案 +
//                            logTail/logPath 会话日志尾）——壳页轮询
//   GET  /dshana/health      存活/连通自检（壳页用于判断「路由面可达」与 surface 授权）
//   POST /dshana/start       手动触发受管 runtime 启动（v2 无自动链 UI；fire-and-forget，
//                            立刻 202 返回，壳页轮询 boot-state 跟进；已就绪/启动中幂等）
//   POST /dshana/stop        停止受管 runtime（幂等）
//
// 依赖注入（可测性）：deps = { appId, version, getSnapshot(), start(), stop(), log() }。
// 默认实现经 src/lib/managed-runtime.js 读取真实单例；测试注入 fake。
import { readdirSync, readFileSync, openSync, readSync, statSync, closeSync } from "node:fs";
import { join } from "node:path";

/**
 * 挂路由（registrar 回调体）。app 为宿主传入的 Hono sub-app（duck-typed）。
 * deps 缺省时用 defaultDshanaRouteDeps(null)——单测请显式传 fake。
 */
export const DASHANA_ROUTE_PREFIX = "/dshana";

/** 默认依赖实现（读 App 运行包 + 受管 runtime 单例；模块级状态在 App 进程内共享）。 */
import { managedRuntimeDetails, ensureManagedRuntime, stopManagedRuntime, bridgeAccess } from "../lib/managed-runtime.js";
import { buildBootSnapshot, APP_ID } from "../lib/boot-state.js";

/**
 * 读取 App dataDir/logs 最新会话日志尾部（壳页 starting 态滚动展示 runtime 启动/依赖
 * ensure 过程镜像）。只读、失败静默（{ logPath: null, logTail: [] }），不阻塞状态面。
 */
export function readLatestLogTail(dataDir, { maxLines = 40, tailBytes = 256 * 1024 } = {}) {
  const empty = { logPath: null, logTail: [] };
  try {
    if (!dataDir) return empty;
    const logsDir = join(dataDir, "logs");
    let names;
    try {
      names = readdirSync(logsDir).filter((n) => typeof n === "string" && n.endsWith(".log"));
    } catch {
      return empty;
    }
    if (!names.length) return empty;
    names.sort((a, b) => {
      try { return statSync(join(logsDir, b)).mtimeMs - statSync(join(logsDir, a)).mtimeMs; } catch { return 0; }
    });
    const file = join(logsDir, names[0]);
    let text = "";
    try {
      const { size } = statSync(file);
      const start = Math.max(0, size - tailBytes);
      if (start <= 0) {
        text = readFileSync(file, "utf8");
      } else {
        const fd = openSync(file, "r");
        try {
          const buf = Buffer.alloc(size - start);
          readSync(fd, buf, 0, buf.length, start);
          text = buf.toString("utf8");
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      return { logPath: file, logTail: [] };
    }
    const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
    return { logPath: file, logTail: lines.slice(-maxLines) };
  } catch {
    return empty;
  }
}

export function defaultDshanaRouteDeps(ctx) {
  const log = (...args) => {
    try {
      if (ctx && typeof ctx.logger?.info === "function") ctx.logger.info(...args);
    } catch {
      /* 忽略 */
    }
  };
  return {
    appId: (ctx && ctx.appId) || APP_ID,
    version: "",
    log,
    getSnapshot: () => {
      const dataDir = ctx && typeof ctx.dataDir === "string" && ctx.dataDir ? ctx.dataDir : null;
      const { logPath, logTail } = readLatestLogTail(dataDir);
      const access = bridgeAccess();
      return buildBootSnapshot(managedRuntimeDetails(), { logPath, logTail, bridgeKey: access ? access.key : null });
    },
    start: () => ensureManagedRuntime({}),
    stop: () => stopManagedRuntime(),
  };
}

export function registerDshanaRoutes(app, deps) {
  const d = deps || {};
  const { appId = APP_ID, version = "", log = () => {} } = d;
  const getSnapshot = typeof d.getSnapshot === "function" ? d.getSnapshot : () => buildBootSnapshot(managedRuntimeDetails());
  const start = typeof d.start === "function" ? d.start : () => ensureManagedRuntime({});
  const stop = typeof d.stop === "function" ? d.stop : () => stopManagedRuntime();

  const json = (c, status, body) => {
    if (typeof c?.json !== "function") {
      return { status: status || 200, body };
    }
    return c.json(body, status);
  };

  // ---- GET /dshana/boot-state：壳页轮询主面 ----
  if (typeof app?.get === "function") {
    app.get(DASHANA_ROUTE_PREFIX + "/boot-state", (c) => {
      try {
        return json(c, 200, { ok: true, app: { id: appId, version }, state: getSnapshot() });
      } catch (e) {
        log("warn", "boot-state 读取失败：" + ((e && e.message) || e));
        return json(c, 500, { ok: false, error: (e && e.message) || String(e) });
      }
    });

    app.get(DASHANA_ROUTE_PREFIX + "/health", (c) => {
      try {
        return json(c, 200, {
          ok: true,
          app: { id: appId, version },
          ts: new Date().toISOString(),
        });
      } catch (e) {
        return json(c, 500, { ok: false, error: (e && e.message) || String(e) });
      }
    });
  }

  // ---- POST /dshana/start：手动触发（v2 无自动链；幂等、不阻塞请求）----
  if (typeof app?.post === "function") {
    app.post(DASHANA_ROUTE_PREFIX + "/start", async (c) => {
      const before = getSnapshot();
      try {
        if (before.ready || before.phase === "ready" || before.phase === "starting") {
          return json(c, 200, { ok: true, accepted: false, reason: before.phase === "starting" ? "starting" : "already-ready", state: before });
        }
        // fire-and-forget：start 可能含依赖 ensure/boot（数分钟），不让 HTTP 请求挂起；
        // 壳页以轮询 boot-state 跟进。错误只在单例 phase=error 与日志中反映。
        const p = Promise.resolve().then(() => start());
        p.then(
          () => log("info", "[dshana-routes] /dshana/start 完成（DSH 就绪）"),
          (e) => log("warn", "[dshana-routes] /dshana/start 失败：" + ((e && e.message) || e)),
        );
        return json(c, 202, { ok: true, accepted: true, state: getSnapshot() });
      } catch (e) {
        log("warn", "/dshana/start 触发异常：" + ((e && e.message) || e));
        return json(c, 500, { ok: false, error: (e && e.message) || String(e) });
      }
    });

    app.post(DASHANA_ROUTE_PREFIX + "/stop", async (c) => {
      try {
        await stop();
        return json(c, 200, { ok: true, state: getSnapshot() });
      } catch (e) {
        log("warn", "/dshana/stop 失败：" + ((e && e.message) || e));
        return json(c, 500, { ok: false, error: (e && e.message) || String(e) });
      }
    });
  }

  return app;
}

/** 注册信息（单测/诊断用）：挂载的端点清单（method path）。 */
export function dshanaRoutesTable() {
  return [
    ["GET", DASHANA_ROUTE_PREFIX + "/boot-state"],
    ["GET", DASHANA_ROUTE_PREFIX + "/health"],
    ["POST", DASHANA_ROUTE_PREFIX + "/start"],
    ["POST", DASHANA_ROUTE_PREFIX + "/stop"],
  ];
}
