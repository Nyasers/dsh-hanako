// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/index.js — dsh-hanako App v2 入口（迁移指南 §13 步骤 1）
//
// v2 形态：模块导出 apply(ctx)（宿主在隔离 App 进程内加载本文件并调用；入口契约兼容
// 具名 apply / default.apply / 默认函数，这里两种都导出）。apply 完成注册后即返回，
// 不等待任何长活服务结束（指南 §3）。旧的 class + onload() 形态与进程内宿主单例
// （globalThis.__dshHanako）随之退役——v1 onload 的职责按 v2 生命周期平移如下：
//
//   v1 onload 职责                             v2 落点（本文件 / 关联模块）
//   ─────────────────────────────────────────  ─────────────────────────────────
//   统一日志（dataDir/logs 时间戳会话文件）      apply 开头（写 ctx.dataDir/logs，
//     + 旧日志 zstd 归档（log-archive））           logPath/appendLog 进运行包）
//   globalThis 单例（bus/resources/network/      lib/app-runtime.js module-scope 运行包
//     web host 启动器、自动链状态机）              （apply 注入；不再依赖宿主态 globalThis）
//   ctx.registerTool（宿主自动加 pluginId_ 前缀）  ctx.tools.register（v2 无自动前缀，
//                                                 工具名全局唯一，见 tools/session.js）
//   task handler 注册（task:abort → session.cancel） 迁移步骤 4（Hana ctx.tasks 取消链）
//   DSH web host 启动自动链（ensure-deps→booting→ready） 迁移步骤 2（ctx.runtime.start
//     受管 Node 进程 + connectAppRuntime；自动链状态机按受管进程语义重设计）
//   路由注册（v1 routes/webui.js + card.js）       迁移步骤 4b/5（ctx.routes.register 单
//     registrar：routes/dshana-routes.js 壳页诊断面；到受管 runtime 的浏览器通道由宿主
//     /api/apps/<id>/routes/_runtime/<runtimeId>/ 自动代理，不转发；ui/ 卡片贡献步骤 5 已回）
//
// 启动触发模型（v2 无 activationEvents/onStartup，指南 §3/§11）：
// apply 不启动 DSH——只注册工具/设置并返回。DSH 受管运行时采用「工具首调兜底 + 需要时
// 自启」模型：dsh_session 的 create/send/cancel/approve 首调时若 DSH runtime 未就绪则
// 触发启动（ctx.runtime.start → 轮询 get 到 ready → 注册调用）；list/get 纯本地读永远
// 可用，不依赖 DSH 启动。稳定后再启用 manifest activation 的 on-demand 模式。步骤 2
// 已把启动封装落位（lib/managed-runtime.js ensureManagedRuntime 单例），步骤 3 在
// tools/session.js 的接线桩处接入。
//
// 设置读取纪律（指南 §4）：contributes.settings 在 apply() 完成后才由宿主登记，apply
// 顶层不得依赖 ctx.config.get 已可读；工具执行期（apply 已返回）经运行包 readConfig
// 安全读取（ctx.config.get + schema 默认值回填，失败返回 undefined）。
//
// 依赖部署策略（迁移步骤 2 定案，见 DESIGN「依赖部署（v2）」）：DSH 依赖（@deepseek-ai/dsh
// + cordis + dsh-* 官方插件树 + 平台原生产物）装在 App dataDir 安装区 <dataDir>/runtime/
// （首启 pnpm install，installDir 只读不可写），版本随 App 声明（package.json dependencies
// 单一事实源，无独立升级通道）；cordis 产物（@dsh-hanako/*）随包在安装目录 cordis/，
// profile 经 junction 链接（见 src/runtime/seed.js）。本刀受管子进程入口 = runtime/
// dsh-host.mjs（dist 构建产物，见 src/build.js 与 src/runtime/）。
import { mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
// 日志生命周期（v1 同源复用：旧日志 zstd 压缩归档 + 时间戳日志文件命名）
import { archiveOldLogs, nextTimestampLogPath } from "./lib/log-archive.js";
// App v2 运行包持有者（替代 v1 globalThis 单例，见 lib/app-runtime.js 头注释）
import { initAppRuntime } from "./lib/app-runtime.js";
// 受管 DSH runtime 启动封装（迁移步骤 2 落位；disposer 负责收尾。启动触发：工具首调
// 兜底（tools/session.js 接线桩）+ **apply 级自动链**（注册完成即后台拉起受管 runtime，
// 语义回归 v1「插件加载即自动 boot」——壳页打开时通常已 ready/starting，无需手动按钮；
// single-flight 幂等，已就绪不重复启动）
import { disposeManagedRuntime, ensureManagedRuntime } from "./lib/managed-runtime.js";
// 工具模块（导出 name/description/parameters/execute；v2 无自动 pluginId_ 前缀——
// 工具名即注册名，注册策略与命名决策见 tools/session.js 头注释）
import * as dshSession from "./tools/session.js";
// 壳页/诊断面单 registrar（迁移步骤 4b/5；v1 routes/webui.js+card.js 两工厂合并语义：
// ctx.routes.register 只挂本 App 后端面；到受管 runtime 服务由宿主代理自动暴露，不转发）
import { registerDshanaRoutes, defaultDshanaRouteDeps } from "./routes/dshana-routes.js";

// ---- 统一日志（时间戳会话文件；与 v1 同格式，写 App dataDir）----
// DSHana App 全量运行日志：每次 App 进程会话创建 <YYYYMMDD-HHmmss-SSS>.log 真实文件
// （dataDir/logs/）。行格式 [<HH:mm:ss.SSS>] [<src>] <内容>，src ∈ out/err/…（v1 沿用）。
// 旧会话日志（更早时间戳 .log）在 apply 开头压缩为 .log.zst 保留（全部保留不删除，
// 与 dsh session 持久化同策略）。
function logTs() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function appendLogLine(logPath, src, chunk) {
  try {
    if (!logPath) return;
    mkdirSync(dirname(logPath), { recursive: true });
    const lines = String(chunk ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    if (!lines.length) return;
    const ts = logTs();
    appendFileSync(
      logPath,
      lines.map((l) => `[${ts}] [${src}] ${l}`).join("\n") + "\n",
      "utf8",
    );
  } catch {
    /* 日志失败不阻断 */
  }
}

/**
 * App v2 主入口：注册 dsh_session 工具 + 设置/日志就位后返回（不等待 DSH 服务）。
 * 返回 disposer：宿主卸载/重载本 App 时调用，用于收尾（日志落盘；步骤 2+ 在此关闭
 * 受管 DSH runtime、任务与流）。
 */
export function apply(ctx) {
  const appId = "dsh-hanako";
  const dataDir = ctx && typeof ctx.dataDir === "string" && ctx.dataDir ? ctx.dataDir : null;
  if (!dataDir) throw new Error(appId + " App v2 apply: ctx.dataDir 缺失（宿主未提供数据目录）");

  // ---- 日志会话开始（archiveOldLogs 先于建新文件：把上一会话 .log 压成 .log.zst）----
  const logsDir = join(dataDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const { archivedName, compressed } = archiveOldLogs({ dataDir });
  const logPath = nextTimestampLogPath(logsDir);
  const appendLog = (src, chunk) => appendLogLine(logPath, src, chunk);
  if (archivedName) appendLog("hana", `日志归档：${archivedName}（上一 App 会话）`);
  if (compressed > 0) appendLog("hana", `旧日志压缩：${compressed} 个`);
  appendLog("hana", "app apply（App v2 会话开始，migration step 2：受管 runtime 封装就位）");

  // ---- 宿主日志器（ctx.logger：debug/info/warn/error）+ 运行包 ----
  const logger = ctx.logger || null;
  const log = (level, ...args) => {
    appendLog("hana", args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(" "));
    if (logger && typeof logger[level] === "function") {
      try { logger[level](...args); } catch { /* 宿主日志失败忽略 */ }
    }
  };
  // App v2 运行包（module-scope；工具执行经 lib/app-runtime.js 读取）
  const app = {
    ctx,
    dataDir,
    logPath,
    appendLog,
    logger,
    // 工具执行期（apply 已完成、settings 已登记）读取 App 设置；未登记/失败返回 undefined
    readConfig: (key) => {
      try { return ctx.config.get(key); } catch { return undefined; }
    },
  };
  initAppRuntime(app);

  // ---- 工具注册（v2 ctx.tools.register；execute 由宿主在 App 进程内经 RPC 回调执行）----
  // 工具名 = dshSession.name（"dsh_session"，全局唯一，v2 不自动加前缀——决策与冲突面
  // 讨论见 tools/session.js 头注释 1）。action 参数与返回语义保持不变；v1 的
  // sessionPermission（external_side_effect + describeSideEffect 函数）为 v1 宿主形态，
  // 无法跨 App 进程序列化，本步骤不注册（外效 action 真正接线时按宿主契约补声明）。
  // 每个 execute 收到一个工具上下文（v2 execute 上下文袋缺省兼容）：log 写统一日志
  // 文件并镜像宿主 logger；dataDir/config 供工具业务读取。
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

  // ---- ctx.routes.register：壳页/诊断面（迁移步骤 4b/5 收口）----
  // 契约（@hana/app-sdk + server 0.930.1 实证）：单 bundle App 只能 register 一次，
  // registrar 收到宿主创建的 Hono sub-app（public URL /api/apps/dsh-hanako/routes/dshana/*，
  // app_route 鉴权；registrar 可返回 Promise，宿主 await 后发布）。到受管 runtime 服务的
  // 浏览器通道由宿主自动暴露在 /api/apps/dsh-hanako/routes/_runtime/<runtimeId>/（服务
  // readyMarker 后成立，自动代理 HTTP/SSE/WS + 重定向重写 + HttpOnly cookie）——本 registrar
  // 不需要转发受管服务，只提供壳页消费的 boot 状态与启动/停止面。
  // ui/ 壳页（dist/ui/dshana/*.html）以相对同源 fetch 本组端点轮询（页面经 App surface
  // 授权加载；真机对账点：surface cookie/hana.api 形态见 DESIGN 已测/未测清单）。
  let unregisterRoutes = null;
  if (ctx.routes && typeof ctx.routes.register === "function") {
    try {
      unregisterRoutes = ctx.routes.register((app) => registerDshanaRoutes(app, defaultDshanaRouteDeps(ctx)));
      log("info", "路由注册:ctx.routes.register（/dshana/boot-state|health|start|stop——ui/ 壳页消费面）");
    } catch (e) {
      // registrar 抛错 = 路由发布失败 → 抬高让宿主拒绝本 App（路由是步骤 4b 交付面，
      // 缺了壳页只剩纯工具；显式失败比静默残缺好诊断）
      log("error", "ctx.routes.register 失败（App 加载中止）：" + ((e && e.message) || e));
      throw e;
    }
  } else {
    log("warn", "ctx.routes.register 缺失（宿主低于 0.930.1？）：壳页诊断面不可用，DSH Web UI 仅经 dsh_session 使用");
  }

  // ---- apply 级自动链：注册完成即后台拉起受管 DSH runtime（不 await，不阻塞 apply 返回）----
  // 语义回归 v1「插件加载即自动 boot」（v1 activationEvents onStartup → webui 自动链）。
  // v2 无 activationEvents，apply 即宿主加载本 App 的时机：注册完工具/路由后触发一次
  // ensureManagedRuntime（single-flight 幂等：已 starting/ready 时 no-op 共享同一启动）。
  // 首次启动含依赖安装（pnpm install 到 dataDir/runtime）可能耗时数分钟——fire-and-forget，
  // 状态经 boot-state 由壳页轮询展示（starting 日志滚动）；失败不 crash apply，落在 runtime
  // 状态机（phase=error + userText），壳页展示重试指引，dsh_session 首调仍可再触发。
  // ⚠️ 依赖 app/process.spawn capability（宿主 ledger 授予后 App/受管 runtime 进程才带
  // --allow-child-process，pnpm install 才能 spawn node）；未授予时 ensure 报 deps-io。
  {
    // 宿主 bootstrap 窗口实证（0.930.1 plugin-loader-v2）：App 加载对 apply 有 60s
    // RPC bootstrap 超时。beta.3 在 apply 同步路径内直接 fire ensureManagedRuntime，
    // 宿主两次均在 60s 整报 "RPC bootstrap timed out" 并杀 App 进程——受管 runtime
    // 的启动/轮询活动让宿主判定 bootstrap 未完成。故自动链延迟到宿主 bootstrap
    // 握手之后（App 进程 apply 后仍存活）再触发。若延迟后仍超时（首次依赖安装
    // 超过窗口），备选：完全移出 apply（壳页打开触发），见 DESIGN。
    const AUTO_CHAIN_DELAY_MS = 5000;
    try {
      setTimeout(() => {
        ensureManagedRuntime({}).catch((e) => {
          log("warn", "apply 自动链启动 DSH runtime 失败（状态经 boot-state 展示，可手动重试）：" + ((e && e.message) || e));
        });
      }, AUTO_CHAIN_DELAY_MS);
      log("info", "apply 自动链：" + AUTO_CHAIN_DELAY_MS + "ms 后触发 ensureManagedRuntime（避让宿主 bootstrap 窗口，single-flight）");
    } catch (e) {
      log("warn", "apply 自动链触发异常（忽略，继续返回 disposer）：" + ((e && e.message) || e));
    }
  }

  // 返回 disposer：卸载/重载清理（步骤 2 起：停止受管 DSH runtime——若已启动；幂等）
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
        appendLog("hana", "disposer 停止 DSH runtime 失败：" + ((e && e.message) || e));
      });
    } catch (e) {
      appendLog("hana", "disposer 停止 DSH runtime 异常：" + ((e && e.message) || e));
    }
    appendLog("hana", "app apply disposer：工具注销 + 路由注销 + DSH 受管 runtime 收尾完成");
  };
}

export default { apply };
