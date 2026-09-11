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
//   GET  /dshana/boot-state  归一化 boot 快照（idle/starting/ready/error + 文案）——壳页轮询
//   GET  /dshana/health      存活/连通自检（壳页用于判断「路由面可达」与 surface 授权）
//   POST /dshana/start       手动触发受管 runtime 启动（App 自动链之外的兑底入口；fire-and-forget，
//                            立刻 202 返回，壳页轮询 boot-state 跟进；已就绪/启动中幂等）
//   POST /dshana/stop        停止受管 runtime（幂等）
//
// 依赖注入（可测性）：deps = { appId, version, getSnapshot(), start(), stop(), log() }。
// 默认实现经 src/lib/managed-runtime.js 读取真实单例；测试注入 fake。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { managedRuntimeDetails, ensureManagedRuntime, stopManagedRuntime, bridgeAccess } from "../lib/managed-runtime.js";
import { buildBootSnapshot, APP_ID } from "../lib/boot-state.js";
import { resolveApprovalTimeoutSec, resolveDefaultTimeoutSec } from "../lib/config.js";
export const DASHANA_ROUTE_PREFIX = "/dshana";

// ---- 应用设置（GET/POST /dshana/settings）----
// 只认两项（原 manifest contributes.settings.schema 的那两个键），值落在 dataDir/config.json
// 的 global.*——和宿主设置界面当初写的是同一处，也正是 src/lib/config.js 里
// resolveApprovalTimeoutSec / resolveDefaultTimeoutSec 优先直读的那份值：改完即时生效，
// 不需要重启。
// 为什么不再用 schema（她的决定）：设置标签页直接渲染本 App 自己的页
// （contributes.settings.ui.route），配置经 App 自己的后端读写，宿主不再代画表单；缺省值
// 随之由 lib/config.js 的 APP_SETTING_DEFAULTS 持有（值不变：30 / 1800）。
const APP_SETTING_KEYS = ["approvalTimeoutSec", "defaultTimeoutSec"];
const APP_SETTING_LEGACY = { approvalTimeoutSec: "approvalTimeoutMs", defaultTimeoutSec: "defaultTimeoutMs" };

/** 读 dataDir/config.json（缺失/坏 JSON 一律当空对象：设置面不该把诊断面拖下水）。 */
function readConfigJson(dataDir) {
  try {
    const f = join(dataDir, "config.json");
    if (!existsSync(f)) return {};
    const j = JSON.parse(readFileSync(f, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

/** 只挑白名单键、只认有限非负数；其余忽略（设置面不接受任意键写入）。 */
function pickAppSettings(input) {
  const out = {};
  for (const k of APP_SETTING_KEYS) {
    const v = input ? input[k] : undefined;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = Math.round(v);
  }
  return out;
}

/** 生效值（与运行时同一读法）：交给 config.js 的 resolver 从 config.json + 缺省值算出。 */
function effectiveSettings(dataDir) {
  return {
    approvalTimeoutSec: resolveApprovalTimeoutSec({ dataDir }),
    defaultTimeoutSec: resolveDefaultTimeoutSec({ dataDir }),
  };
}

/** 默认依赖实现（读 App 运行包 + 受管 runtime 单例；模块级状态在 App 进程内共享）。 */

export function defaultDshanaRouteDeps(ctx) {
  const log = (...args) => {
    try {
      if (ctx && typeof ctx.logger?.info === "function") ctx.logger.info(...args);
    } catch {
      /* 忽略 */
    }
  };
  // 设置面用 App 自己的私有数据目录（ctx.config.dataDir，宿主提供）
  const dataDir = ctx && ctx.config && typeof ctx.config.dataDir === "string" ? ctx.config.dataDir : "";
  return {
    appId: (ctx && ctx.appId) || APP_ID,
    version: "",
    log,
    readSettings: () => effectiveSettings(dataDir),
    writeSettings: (patch) => {
      if (!dataDir) throw new Error("ctx.config.dataDir 不可用，无法写应用设置");
      const j = readConfigJson(dataDir);
      const global = j.global && typeof j.global === "object" ? { ...j.global } : {};
      for (const [k, v] of Object.entries(patch)) {
        global[k] = v;
        // 新键落盘即撤旧毫秒键（config.js 的兼容分支随之不再命中，免单位误读）
        const legacy = APP_SETTING_LEGACY[k];
        if (legacy) delete global[legacy];
      }
      j.global = global;
      writeFileSync(join(dataDir, "config.json"), JSON.stringify(j, null, 2) + "\n", "utf8");
      return effectiveSettings(dataDir);
    },
    getSnapshot: () => {
      const access = bridgeAccess();
      return buildBootSnapshot(managedRuntimeDetails(), { bridgeKey: access ? access.key : null });
    },
    start: () => ensureManagedRuntime({}),
    stop: () => stopManagedRuntime(),
  };
}

/**
 * 挂路由（registrar 回调体）。app 为宿主传入的 Hono sub-app（duck-typed）。
 * deps 缺省时用 defaultDshanaRouteDeps(null)——单测请显式传 fake。
 */
export function registerDshanaRoutes(app, deps) {
  const d = deps || {};
  const { appId = APP_ID, version = "", log = () => {} } = d;
  const getSnapshot = typeof d.getSnapshot === "function" ? d.getSnapshot : () => buildBootSnapshot(managedRuntimeDetails());
  const start = typeof d.start === "function" ? d.start : () => ensureManagedRuntime({});
  const stop = typeof d.stop === "function" ? d.stop : () => stopManagedRuntime();
  const readSettings = typeof d.readSettings === "function" ? d.readSettings : () => ({});
  const writeSettings = typeof d.writeSettings === "function" ? d.writeSettings : (patch) => patch;

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

    // ---- GET /dshana/settings：设置页读生效值 ----
    app.get(DASHANA_ROUTE_PREFIX + "/settings", (c) => {
      try {
        return json(c, 200, { ok: true, settings: readSettings() });
      } catch (e) {
        log("warn", "/dshana/settings 读取失败：" + ((e && e.message) || e));
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
        // fire-and-forget：start 含 runtime 拉起与 profile 种子化，不让 HTTP 请求挂起；
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

    // ---- POST /dshana/settings：设置页写回（只收白名单两项）----
    app.post(DASHANA_ROUTE_PREFIX + "/settings", async (c) => {
      try {
        const body = c && c.req && typeof c.req.json === "function" ? await c.req.json() : null;
        const patch = pickAppSettings(body);
        if (Object.keys(patch).length === 0) {
          return json(c, 400, { ok: false, error: "没有可写入的设置项（只认 " + APP_SETTING_KEYS.join("/") + "，数值且 ≥ 0）" });
        }
        return json(c, 200, { ok: true, settings: writeSettings(patch) });
      } catch (e) {
        log("warn", "/dshana/settings 写入失败：" + ((e && e.message) || e));
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
    ["GET", DASHANA_ROUTE_PREFIX + "/settings"],
    ["POST", DASHANA_ROUTE_PREFIX + "/start"],
    ["POST", DASHANA_ROUTE_PREFIX + "/stop"],
    ["POST", DASHANA_ROUTE_PREFIX + "/settings"],
  ];
}
