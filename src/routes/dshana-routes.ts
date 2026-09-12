// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/routes/dshana-routes.ts — dshana App v2 ctx.routes.register 单 registrar
// 
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
//     src/lib/boot-state.ts 头注释）。
//
// 端点（本 App 私有，路径段前缀 dshana）：
//   GET  /dshana/boot-state  归一化 boot 快照（idle/starting/ready/error + 文案）——壳页轮询
//   GET  /dshana/health      存活/连通自检（壳页用于判断「路由面可达」与 surface 授权）
//   POST /dshana/start       手动触发受管 runtime 启动（App 自动链之外的兑底入口；fire-and-forget，
//                            立刻 202 返回，壳页轮询 boot-state 跟进；已就绪/启动中幂等）
//   POST /dshana/stop        停止受管 runtime（幂等）
//   GET  /dshana/model       默认模型（读自 DSH 的 settings 段 agent-default-model）+ 候选模型目
//   POST /dshana/model       改默认模型（整段替换；带 expectedRevision，落后就 409）
//   GET  /dshana/card-state  会话流卡页的状态面（一次性取数：读 App 自己的 task-map；回卡页
//                            可直接换进 DOM 的状态行 HTML）
//
// 依赖注入（可测性）：deps = { appId, version, getSnapshot(), start(), stop(), log() }。
// 默认实现经 src/lib/managed-runtime.ts 读取真实单例；测试注入 fake。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { managedRuntimeDetails, ensureManagedRuntime, stopManagedRuntime, bridgeAccess } from "../lib/managed-runtime.ts";
import { buildBootSnapshot, APP_ID } from "../lib/boot-state.ts";
import { dataSources, sourceOf } from "../lib/data-source.ts";
// 数据源切换（lib/source-switch.ts）的入口暂时撤下：链未在真机验证过，见 POST /dshana/settings/restart。
import { readDefaultModel, writeDefaultModel } from "../lib/model-settings.ts";
import { readTaskMap, isValidSessionId } from "../lib/task-map.ts";
export const DASHANA_ROUTE_PREFIX = "/dshana";

// ---- 应用设置（GET/POST /dshana/settings）----
// 两个超时与数据模式同栈：一份设置（dataDir/integration/settings.json）、一个 revision，
// 缺省值由 lib/config.ts 的 APP_SETTING_DEFAULTS 单点持有（30 / 1800）。
// 为什么不用 schema 门：设置标签页直接渲染本 App 自己的页
// （contributes.settings.ui.route），配置经 App 自己的后端读写，宿主不再代画表单。
// 写带 expectedRevision：不匹配回 409，不静默覆盖。
const APP_SETTING_BROADCAST_KEY = "dshana:settings";

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

/**
 * App 级设置的视图：两个超时与数据模式在同一份设置、同一个 revision（W2）。
 * source 由设置推出（home/sourceId 供页面回显与运行时接线），lastShared 供“切回共享”预填。
 */
async function readSettingsView(ctx, dataDir) {
  const st = await dataSources(ctx).read();
  return {
    revision: st.revision,
    settings: st.settings,
    source: sourceOf(st.settings, dataDir),
    lastShared: st.lastShared || null,
  };
}

/** HTML 文本转义（卡状态下发片段里的文案注入）。 */
function escHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 本地时间戳（分钟精度）；非法值给空串。 */
function stampMinute(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/**
 * 卡状态行片段：与 ui/card.html 的初始状态行同形（div.state#dsh-state[data-state] 里
 * 一个圆点 + 一个文案 + 一个 detail），卡页就地把这段换进 DOM，故这里的类名与 id 是
 * 卡页的渲染契约。data-state ∈ tracked / ended / cancelling / unknown。
 */
function cardStateHtml({ state, label, detail }) {
  return (
    '<div class="state" id="dsh-state" data-state="' + escHtml(state) + '">' +
    '<span class="dot"></span><span>' + escHtml(label) + "</span>" +
    (detail ? '<span class="detail">' + escHtml(detail) + "</span>" : "") +
    "</div>"
  );
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
  // 设置面用 App 自己的私有数据目录。宿主契约（@hana/app-sdk HanaPluginContextV2）：
  // dataDir 在 ctx **顶层**（ctx.dataDir，与 apply 期 index.js、lib/data-source 的
  // createDataSourceStore 同一来源）；ctx.config 是设置读写面（get/getAll/set…），其上没有
  // dataDir。真机曾按 ctx.config.dataDir 取 → 恒为空串 → POST /dshana/settings 必 500
  // （读路径只静默降级，所以先前没暴露）。
  const dataDir = ctx && typeof ctx.dataDir === "string" ? ctx.dataDir : "";
  // 默认模型不经我们存储：经中继打 DSH 自己的 settings 服务（与 session/cancel 同一条通道）。
  const appFetch = ctx && ctx.network && typeof ctx.network.fetch === "function" ? ctx.network.fetch : null;
  return {
    appId: (ctx && ctx.appId) || APP_ID,
    version: "",
    log,
    // 卡数据面：读 App 自己的 task-map（<dataDir>/dshana/taskmaps/<sid>.json，App 主进程与
    // 受管 runtime 共用的跨进程事实源）。无记录一律 unknown——不猜「也许还在跑」。
    readCardState: (sessionId) => {
      const entry = dataDir ? readTaskMap(dataDir, sessionId) : null;
      if (!entry) {
        return {
          state: "unknown",
          label: "无跟踪记录",
          detail: "App 侧没有这个会话的提交记录（可能已回收，或不是本 App 提交的会话）",
        };
      }
      if (entry.ended) {
        return {
          state: "ended",
          label: "已终结",
          detail: "终态 " + String(entry.ended.status || "terminal") + (stampMinute(entry.ended.at) ? " · " + stampMinute(entry.ended.at) : ""),
        };
      }
      if (entry.cancel) {
        return { state: "cancelling", label: "已请求取消", detail: "reason " + String(entry.cancel.reason || "user") };
      }
      return { state: "tracked", label: "运行中", detail: "App 侧仍在跟踪（rpcId " + String(entry.rpcId || "") + "）" };
    },
    readSettings: () => readSettingsView(ctx, dataDir),
    readModel: () => {
      if (!appFetch) throw new Error("ctx.network.fetch 不可用（manifest network 白名单 / 宿主代发门）");
      return readDefaultModel(appFetch);
    },
    writeModel: (patch) => {
      if (!appFetch) throw new Error("ctx.network.fetch 不可用（manifest network 白名单 / 宿主代发门）");
      return writeDefaultModel(appFetch, patch);
    },
    writeSettings: async (patch, expectedRevision) => {
      if (!dataDir) throw new Error("ctx.dataDir 不可用（宿主未提供 App 数据目录），无法写应用设置");
      const store = dataSources(ctx);
      const cur = await store.read();
      if (typeof expectedRevision === "number" && expectedRevision !== cur.revision) {
        const err = new Error(
          "设置已被别处改过（revision " + cur.revision + " ≠ " + expectedRevision + "），请刷新后重试",
        );
        err.code = "SETTINGS_CONFLICT";
        err.revision = cur.revision;
        throw err;
      }
      const next = await store.write({ ...cur.settings, ...patch });
      // 变更广播：已开页面据此刷新。宿主 App 存储只有 get/set（没有订阅口），
      // 所以已开页在重新可见时重读；并发写仍由上面的 revision 把关。
      try {
        if (ctx.storage && ctx.storage.global && typeof ctx.storage.global.set === "function") {
          await ctx.storage.global.set(APP_SETTING_BROADCAST_KEY, { revision: next.revision, at: Date.now() });
        }
      } catch (e) {
        log("warn", "设置变更广播写入失败（不影响本次写入）：" + ((e && e.message) || e));
      }
      const st = await store.read();
      return {
        revision: st.revision,
        settings: st.settings,
        source: sourceOf(st.settings, dataDir),
        lastShared: st.lastShared || null,
      };
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
  const readCardState =
    typeof d.readCardState === "function"
      ? d.readCardState
      : () => ({ state: "unknown", label: "未接线", detail: "deps.readCardState 未注入" });
  const writeSettings = typeof d.writeSettings === "function" ? d.writeSettings : (patch) => patch;
  const readModel = typeof d.readModel === "function" ? d.readModel : async () => {
    throw new Error("默认模型读写不可用：deps.readModel 未注入");
  };
  const writeModel = typeof d.writeModel === "function" ? d.writeModel : async () => {
    throw new Error("默认模型读写不可用：deps.writeModel 未注入");
  };

  const json = (c, status, body) => {
    if (typeof c?.json !== "function") {
      return { status: status || 200, body };
    }
    return c.json(body, status);
  };

  // HTML 响应（卡状态面）：与 json 同一条 duck-typing 纪律，fake ctx 里没 html 也能测。
  const html = (c, status, body) => {
    if (typeof c?.html !== "function") {
      return { status: status || 200, body };
    }
    return c.html(body, status || 200);
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

    // ---- GET /dshana/settings：App 级设置的权威读 ----
    // 一份设置、一个 revision：两个超时与数据模式同栈（W2）。
    // 一律 200，成败看 ok；设置页不依赖 DSH 运行也能渲染。
    app.get(DASHANA_ROUTE_PREFIX + "/settings", async (c) => {
      try {
        const view = await readSettings();
        return json(c, 200, { ok: true, ready: true, ...view });
      } catch (e) {
        log("warn", "/dshana/settings 读取失败：" + ((e && e.message) || e));
        return json(c, 500, { ok: false, error: (e && e.message) || String(e) });
      }
    });

    // ---- GET /dshana/model：默认模型 + 候选（DSH 未运行时给 ready=false，不是错误）----
    // 契约：一律 200，成败看 ok / ready——设置页不依赖 DSH 运行也能渲染（AC W2-1）。
    app.get(DASHANA_ROUTE_PREFIX + "/model", async (c) => {
      const snap = getSnapshot();
      if (!snap.ready) {
        return json(c, 200, { ok: false, ready: false, error: "DSH 未运行：默认模型在 DSH 起来后才能读" });
      }
      try {
        return json(c, 200, { ok: true, ready: true, model: await readModel() });
      } catch (e) {
        log("warn", "/dshana/model 读取失败：" + ((e && e.message) || e));
        return json(c, 200, { ok: false, ready: true, error: (e && e.message) || String(e) });
      }
    });

    // ---- GET /dshana/card-state：会话流卡页的状态面（一次性取数，无 SSE / 无轮询）----
    // 卡页（ui/card.html，宿主以 /api/apps/<appId>/ui/card.html 服务）加载后取一次：读 App
    // 自己的 task-map 给出该 DSH 会话在 App 侧的跟踪态。响应是卡页可直接换进 DOM 的状态行
    // HTML（形制见 cardStateHtml）。会话 id 形态不对回 400（形状错，不是「没状态」）。
    app.get(DASHANA_ROUTE_PREFIX + "/card-state", async (c) => {
      const sid = String((c && c.req && typeof c.req.query === "function" ? c.req.query("sessionId") : "") || "").trim();
      if (!isValidSessionId(sid)) {
        return html(c, 400, cardStateHtml({ state: "unknown", label: "会话 id 不合法", detail: "" }));
      }
      try {
        return html(c, 200, cardStateHtml(await readCardState(sid)));
      } catch (e) {
        log("warn", "/dshana/card-state 读取失败：" + ((e && e.message) || e));
        return html(c, 500, cardStateHtml({ state: "unknown", label: "状态读取失败", detail: (e && e.message) || String(e) }));
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

    // ---- POST /dshana/settings：只改常规项（两个超时）；数据来源走切换链 ----
    // 形状：{ settings: {...}, expectedRevision }。带来源字段一律 400：改来源必须先起新源、
    // 成功才落盘（见 spec D-m），所以那条路归 /settings/restart。
    // revision 不匹配回 409（不静默覆盖）；设置值非法回 400（存储侧校验的话原样上抬）。
    app.post(DASHANA_ROUTE_PREFIX + "/settings", async (c) => {
      try {
        const body = c && c.req && typeof c.req.json === "function" ? await c.req.json() : null;
        const patch = body && typeof body.settings === "object" && body.settings ? body.settings : null;
        if (!patch) return json(c, 400, { ok: false, error: "需要 { settings, expectedRevision } 形状" });
        const sourceKeys = ["mode", "path", "profile"].filter((k) => k in patch);
        if (sourceKeys.length) {
          return json(c, 400, {
            ok: false,
            error: "数据来源不在本端点改（必须先是新源再落盘）：" + sourceKeys.join("/") + " —— 用 POST " + DASHANA_ROUTE_PREFIX + "/settings/restart",
          });
        }
        const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
        const view = await writeSettings(patch, expectedRevision);
        return json(c, 200, { ok: true, ...view });
      } catch (e) {
        if (e && e.code === "SETTINGS_CONFLICT") {
          return json(c, 409, { ok: false, code: "SETTINGS_CONFLICT", error: (e && e.message) || String(e), revision: e.revision });
        }
        const msg = (e && e.message) || String(e);
        if (/未知键|必须|只能是|绝对路径|NUL/.test(msg)) return json(c, 400, { ok: false, error: msg });
        log("warn", "/dshana/settings 写入失败：" + msg);
        return json(c, 500, { ok: false, error: msg });
      }
    });

    // ---- POST /dshana/model：改默认模型（DSH settings 段整段替换）----
    // 409 = 段 revision 已前进（别处改过）：上游 DSH 报 settings/conflict，这里原样上抬。
    app.post(DASHANA_ROUTE_PREFIX + "/model", async (c) => {
      const snap = getSnapshot();
      if (!snap.ready) {
        return json(c, 200, { ok: false, ready: false, error: "DSH 未运行：默认模型在 DSH 起来后才能改" });
      }
      let body = null;
      try {
        body = c && c.req && typeof c.req.json === "function" ? await c.req.json() : null;
      } catch {
        body = null;
      }
      const provider = typeof body?.provider === "string" ? body.provider.trim() : "";
      const model = typeof body?.model === "string" ? body.model.trim() : "";
      if (!provider || !model) {
        return json(c, 400, { ok: false, error: "需要 provider 与 model（非空字符串）" });
      }
      const patch = { provider, model };
      if (typeof body.reasoningEffort === "string" && body.reasoningEffort.trim()) {
        patch.reasoningEffort = body.reasoningEffort.trim();
      }
      if (typeof body.expectedRevision === "number" && Number.isFinite(body.expectedRevision)) {
        patch.expectedRevision = body.expectedRevision;
      }
      try {
        return json(c, 200, { ok: true, ready: true, model: await writeModel(patch) });
      } catch (e) {
        if (e && e.code === "SETTINGS_CONFLICT") {
          return json(c, 409, { ok: false, ready: true, code: "SETTINGS_CONFLICT", error: (e && e.message) || "默认模型已被别处改过" });
        }
        log("warn", "/dshana/model 写入失败：" + ((e && e.message) || e));
        return json(c, 200, { ok: false, ready: true, error: (e && e.message) || String(e) });
      }
    });
    // ---- POST /dshana/settings/restart：数据源切换（入口暂撤）----
    // 切换链（lib/source-switch.ts）还没跑通：停旧、起新、失败回滚这条链没有在真机上验证过，
    // 而它第一步就会停掉正在跑的 runtime。为避免半成品被误触发，这里先只回一句明确的
    // 「未启用」，不碰任何状态。实现原地保留，等切换做完把这层闸去掉即可恢复原状。
    app.post(DASHANA_ROUTE_PREFIX + "/settings/restart", (c) =>
      json(c, 503, {
        ok: false,
        code: "SWITCH_DISABLED",
        error: "数据源切换尚未启用（功能未完成，入口暂时撤下）",
      }),
    );
  }

  return app;
}

/** 注册信息（单测/诊断用）：挂载的端点清单（method path）。 */
export function dshanaRoutesTable() {
  return [
    ["GET", DASHANA_ROUTE_PREFIX + "/boot-state"],
    ["GET", DASHANA_ROUTE_PREFIX + "/health"],
    ["GET", DASHANA_ROUTE_PREFIX + "/settings"],
    ["GET", DASHANA_ROUTE_PREFIX + "/model"],
    ["GET", DASHANA_ROUTE_PREFIX + "/card-state"],
    ["POST", DASHANA_ROUTE_PREFIX + "/start"],
    ["POST", DASHANA_ROUTE_PREFIX + "/stop"],
    ["POST", DASHANA_ROUTE_PREFIX + "/settings"],
    ["POST", DASHANA_ROUTE_PREFIX + "/settings/restart"],
    ["POST", DASHANA_ROUTE_PREFIX + "/model"],
  ];
}
