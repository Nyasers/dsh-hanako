// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/index.js — dshana App v2 入口（模块导出 apply(ctx)）
//
// 形态：宿主在隔离 App 进程内加载本文件并调用 apply(ctx)（入口契约兼容具名 apply /
// default.apply / 默认函数，两种都导出）。apply 完成注册后立即返回，不等任何长活服务结束。
// 宿主进程内单例不存在：运行包（dataDir / ctx）由 lib/app-runtime.js 在 apply 期注入。
//
// 启动模型：apply **不**启动 DSH，只注册工具/路由并返回。受管 runtime 走「工具首调兜底 +
// 需要时自启」（lib/managed-runtime.js 的 ensureManagedRuntime 单例，single-flight 幂等）；
// apply 级自动链在注册完成后后台拉起，所以壳页打开时通常已是 ready/starting。list/get 经
// 控制面读官方查询面，需要 runtime 就绪。
//
// 设置读取纪律：contributes.settings 在 apply() 完成后才由宿主登记，apply 顶层不得依赖
// ctx.config.get 已可读；工具执行期经运行包 readConfig 安全读取（schema 默认值回填，
// 失败返回 undefined）。
//
// 依赖部署：DSH 依赖（@deepseek-ai/dsh + cordis + 官方插件树 + 多平台原生产物）由
// scripts/pack.mjs 在构建时物化进安装目录 node_modules（hoisted 布局，安装即用、无运行时
// 安装，版本随 App 声明）；cordis 产物（@dshana/*）在安装目录 cordis/，profile 经 junction
// 暴露（src/runtime/seed.js）；受管子进程入口 = runtime/dsh-host.mjs（dist 构建产物）。
//
// 日志：只走宿主 ctx.logger；ctx.logger 缺失或抛错时回落 stderr（宁可吵，不静默丢日志）。
import { initAppRuntime } from "./lib/app-runtime.js";
// 受管 DSH runtime：启动封装 + 释放（disposer 负责收尾）
import { disposeManagedRuntime, ensureManagedRuntime } from "./lib/managed-runtime.js";
// 工具模块（导出 name/description/parameters/execute；v2 工具名即注册名，无自动前缀）
import * as dshSession from "./tools/session.js";
// 壳页/诊断面单 registrar（ctx.routes.register 只挂本 App 后端面；到受管 runtime 的服务
// 由宿主按 /api/apps/<id>/routes/_runtime/<runtimeId>/ 自动代理，本文件不转发）
import { registerDshanaRoutes, defaultDshanaRouteDeps } from "./routes/dshana-routes.js";

// ---- 统一日志：只走宿主 ctx.logger ----
// App 侧不写自己的文件日志；ctx.logger 缺失（旧 host）或宿主抛错时回落 stderr。

/**
 * App v2 主入口：注册 dshana_session 工具 + 设置/路由就位后返回（不等待 DSH 服务）。
 * 返回 disposer：宿主卸载/重载本 App 时调用，用于收尾（关闭受管 DSH
 * runtime、任务与流）。
 */
export function apply(ctx) {
  const appId = "dshana";
  const dataDir = ctx && typeof ctx.dataDir === "string" && ctx.dataDir ? ctx.dataDir : null;
  if (!dataDir) throw new Error(appId + " App v2 apply: ctx.dataDir 缺失（宿主未提供数据目录）");

  // ---- 宿主日志器（ctx.logger：debug/info/warn/error）----
  const logger = ctx.logger || null;
  const log = (level, ...args) => {
    if (logger && typeof logger[level] === "function") {
      try { logger[level](...args); return; } catch { /* 宿主日志失败 → 回落 stderr */ }
    }
    try { console.error(`[dshana] [${level}]`, ...args); } catch { /* 忽略 */ }
  };
  log("info", "app apply（App v2 会话开始；日志走 ctx.logger，App 侧不写文件日志）");
  // App v2 运行包（module-scope；工具执行经 lib/app-runtime.js 读取）
  const app = {
    ctx,
    dataDir,
    logger,
    // 工具执行期（apply 已完成、settings 已登记）读取 App 设置；未登记/失败返回 undefined
    readConfig: (key) => {
      try { return ctx.config.get(key); } catch { return undefined; }
    },
  };
  initAppRuntime(app);

  // ---- 工具注册（v2 ctx.tools.register；execute 由宿主在 App 进程内经 RPC 回调执行）----
  // 工具名 = dshSession.name（"dshana_session"，全局唯一；v2 不自动加前缀，重名会被宿主
  // 当场拒掉）。action 参数与返回语义见 tools/session.js。
  // 每个 execute 收到一个工具上下文（v2 execute 上下文袋缺省兼容）：log 走宿主 ctx.logger；
  // dataDir/config 供工具业务读取。
  const makeToolCtx = () => ({
    dataDir,
    config: ctx.config,
    log: {
      debug: (...a) => log("debug", ...a),
      info: (...a) => log("info", ...a),
      warn: (...a) => log("warn", ...a),
      error: (...a) => log("error", ...a),
    },
  });

  const unregisterTool = ctx.tools.register({
    name: dshSession.name,
    description: dshSession.description,
    parameters: dshSession.parameters,
    execute: (input, callCtx) => dshSession.execute(input, makeToolCtx()),
  });
  log("info", `工具注册:${dshSession.name}（ctx.tools.register，v2 全局唯一名，无自动前缀）`);

  // ---- ctx.routes.register：壳页/诊断面 ----
  // 契约（@hana/app-sdk）：单 bundle App 只能 register 一次，
  // registrar 收到宿主创建的 Hono sub-app（public URL /api/apps/dshana/routes/dshana/*，
  // app_route 鉴权；registrar 可返回 Promise，宿主 await 后发布）。到受管 runtime 服务的
  // 浏览器通道由宿主自动暴露在 /api/apps/dshana/routes/_runtime/<runtimeId>/（服务
  // readyMarker 后成立，自动代理 HTTP/SSE/WS + 重定向重写 + HttpOnly cookie）——本 registrar
  // 不需要转发受管服务，只提供壳页消费的 boot 状态与启动/停止面。
  // ui/ 壳页（dist/ui/*.html）以相对同源 fetch 本组端点轮询（页面经 App surface
  // 授权加载；真机对账点：surface cookie/hana.api 形态见 DESIGN 已测/未测清单）。
  let unregisterRoutes = null;
  if (ctx.routes && typeof ctx.routes.register === "function") {
    try {
      unregisterRoutes = ctx.routes.register((app) => registerDshanaRoutes(app, defaultDshanaRouteDeps(ctx)));
      log("info", "路由注册:ctx.routes.register（/dshana/boot-state|health|start|stop——ui/ 壳页消费面）");
    } catch (e) {
      // registrar 抛错 = 路由发布失败 → 抬高让宿主拒绝本 App（路由是壳页/诊断面的
      // 交付面，缺了只剩纯工具；显式失败比静默残缺好诊断）
      log("error", "ctx.routes.register 失败（App 加载中止）：" + ((e && e.message) || e));
      throw e;
    }
  } else {
    log("warn", "ctx.routes.register 缺失（宿主低于 0.930.1？）：壳页诊断面不可用，DSH Web UI 仅经 dshana_session 使用");
  }

  // ---- apply 级自动链：注册完成即后台拉起受管 DSH runtime（不 await，不阻塞 apply 返回）----
  // apply 即宿主加载本 App 的时机：注册完工具/路由后触发一次
  // ensureManagedRuntime（single-flight 幂等：已 starting/ready 时 no-op 共享同一启动）。
  // 依赖随包物化（安装目录 node_modules），启动只做 runtime boot（秒级）——fire-and-forget，
  // 状态经 boot-state 由壳页轮询展示（starting 日志滚动）；失败不 crash apply，落在 runtime
  // 状态机（phase=error + userText），壳页展示重试指引，dshana_session 首调仍可再触发。
  {
    // 宿主 bootstrap 窗口实证（0.930.1 plugin-loader-v2）：App 加载对 apply 有 60s RPC
    // bootstrap 超时（beta.3 在 apply 同步栈内 fire ensure 两次均 60s 整被杀）。规避 =
    // 自动链不占 apply 同步栈：Promise.resolve().then 微任务链移出栈（启动的首个
    // await 即让出事件循环，宿主 bootstrap 应答可正常处理；无需 setTimeout 宏任务延迟）。
    try {
      Promise.resolve()
        .then(() => ensureManagedRuntime({}))
        .catch((e) => {
          log("warn", "apply 自动链启动 DSH runtime 失败（状态经 boot-state 展示，可手动重试）：" + ((e && e.message) || e));
        });
      log("info", "apply 自动链：Promise 微任务触发 ensureManagedRuntime（不占 apply 同步栈，single-flight）");
    } catch (e) {
      log("warn", "apply 自动链触发异常（忽略，继续返回 disposer）：" + ((e && e.message) || e));
    }
  }

  // 返回 disposer：卸载/重载清理（停止受管 DSH runtime——若已启动；幂等）
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    try { if (typeof unregisterTool === "function") unregisterTool(); } catch { /* 忽略 */ }
    try { if (typeof unregisterRoutes === "function") unregisterRoutes(); } catch { /* 忽略 */ }
    // 受管 runtime 收尾：停 runtime + 清单例（Windows 依赖更新/App 卸载前须先停，见
    // managed-runtime.js 与 DESIGN「依赖部署（v2）」锁纪律）。disposer 可异步不等待宿主。
    try {
      disposeManagedRuntime().catch((e) => {
        log("warn", "disposer 停止 DSH runtime 失败：" + ((e && e.message) || e));
      });
    } catch (e) {
      log("warn", "disposer 停止 DSH runtime 异常：" + ((e && e.message) || e));
    }
    log("info", "app apply disposer：工具注销 + 路由注销 + DSH 受管 runtime 收尾完成");
  };
}

export default { apply };
