// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/managed-runtime.js — dsh-hanako App v2 受管 DSH runtime 启动封装（迁移指南 §13
// 步骤 2；消费方 = 后续步骤 dsh_session 的 create/send/cancel/approve 接线，本步先落封装
// 与单测，session 侧只留接线注释/桩）
//
// 职责：
//   managedStart/ensureManagedRuntime：解析 servicePort（App 设置，见 manifest
//     contributes.settings.servicePort）→ ctx.runtime.start({ runtime:"node",
//     entry:"runtime/dsh-host.mjs", profile:"local-machine", network:"external", service:{
//     port, readyMarker:"DSH_READY" }, ... }) → 状态轮询等到 ready / failed / exited。
//     绝不把 runtimeId 当就绪（指南 §6）：starting 只是宿主已拉起进程，DSH 真就绪 = 子
//     进程真实监听后打印的 readyMarker → host 侧 service.state=ready。
//   单例语义（本步设计）：一个 App runtime 服务多个 DSH 会话（每会话的 taskId 经后续
//     步骤的任务桥各自携带，不把单次启动任务绑成全局焦点——指南 §7）；首次 create 时
//     启动（tools/session.js 接线点），ready 后所有 action 复用。runtime 终止后清除
//     单例，下次调用重启。App 卸载/重载经 disposeManagedRuntime 收尾（apply disposer）。
//   runtime 日志镜像：watch(runtimeId) 的 log 记录（stream stdout/stderr）尽力镜像进 App
//     会话日志（dataDir/logs/*.log，appendLog 同款行式）；镜像失败只 warn 不阻断。
//
// 参数契约（与 src/runtime/options.js 对偶；增删需两处同步 + tests/）：
//   --hana-task-id/--port/--data-dir/--cordis-src/--deps-root/--ready-marker/--no-ensure
//   buildRuntimeArgs() 是本模块对子进程唯一的参数来源。
import { join } from "node:path";
import { appConfig, appDataDir, appLogger, getAppRuntime } from "./app-runtime.js";
import { PLUGIN_ROOT } from "./state.js";
// App 进程侧依赖 ensure（v2 架构实证：受管 runtime 进程在宿主 win32-restricted-token
// 沙箱内无法 spawn（deps-io EPERM exit=4）；App 进程经 app/process.spawn 授权带
// --allow-child-process 是唯一可 spawn 的进程——依赖安装在此执行）。ensure-deps.js
// 只依赖 node 内置 + lib/pnpm.js + lib/state.js，可安全进主 bundle。
import { ensureDeps } from "../runtime/ensure-deps.js";

export const READY_MARKER = "DSH_READY";
export const RUNTIME_ENTRY = "runtime/dsh-host.mjs"; // 相对 App 安装目录（宿主校验在安装/数据目录内）
export const DEFAULT_SERVICE_PORT = 4317; // manifest contributes.settings.servicePort 默认（宿主 service 端口契约 1024..65535）
export const READY_POLL_MS = 300;
export const READY_TIMEOUT_MS = 240000; // 首次启动含依赖 ensure（pnpm 下载+安装）需更宽容限
export const START_ERROR_HINTS = {
  "port-busy": "端口被占用或 DSH 无法监听（服务代理未就绪）。改 App 设置 servicePort 为未占用端口后重试，或释放占用端口的进程。",
  "port-unreachable": "DSH 已在期望端口监听失败（webServer 服务端口与期望不符或探测失败）。查看 runtime 日志定位，必要时换 servicePort。",
  "boot-failed": "DSH runProfile 启动失败（见 runtime 日志）。若依赖刚变更，可尝试重装依赖（删除 dataDir/runtime/.runtime-ok 后重启）。",
  deps: "DSH 依赖未就绪或安装失败（首次使用需要网络以 pnpm 安装 DSH 依赖到 dataDir/runtime）。检查网络后重试；离线预置见 DESIGN「依赖部署（v2）」。",
  seed: "dshana profile 初始化失败（见 runtime 日志；profile 迁移拒绝/scope 链接失败由种子化引导）。",
  "not-authorized": "宿主未授权本 App 启动受管 runtime（local-machine 能力未授予或已撤销）。检查 App 能力与授权状态。",
  unknown: "受管 runtime 启动失败（见 runtime 日志与状态）。",
};

/** 模块级单例状态（一个 App 进程一个 DSH runtime；apply 卸载/失败会清）。 */
let managed = {
  runtimeId: null,
  phase: "idle", // idle | starting | ready | error | stopped
  promise: null, // starting 阶段共享 promise（并发首启 single-flight）
  lastInfo: null,
  lastError: null,
  mirrorCancel: null, // watch 日志镜像 AbortController
  mirrors: [], // 已挂 watch 的 runtimeId（防重复）
};

/** 复位单例（外部测试/重建用）。 */
export function resetManagedRuntime() {
  managed = {
    runtimeId: null,
    phase: "idle",
    promise: null,
    lastInfo: null,
    lastError: null,
    mirrorCancel: null,
    mirrors: [],
  };
  return managed;
}

/**
 * servicePort 解析（纯函数，便于单测）：raw 为 ctx.config.get('servicePort') 的原始值。
 * 合法整数 1024..65535 返回原值（宿主 runtime service 端口契约下限 1024——特权口/0/随机
 * 一律不接受，见迁移核对记录）；非法/缺省返回 fallback（默认 DEFAULT_SERVICE_PORT）。
 * 显式 <1024/负/越界/非数都不作为随机端口——指南 §10 禁随机端口契约（宿主不认子进程自报）。
 */
export function parseServicePort(raw, fallback = DEFAULT_SERVICE_PORT) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  if (Number.isInteger(n) && n >= 1024 && n <= 65535) return n;
  return Number.isInteger(fallback) && fallback >= 1024 && fallback <= 65535 ? fallback : DEFAULT_SERVICE_PORT;
}

/**
 * 子进程参数构造（与 src/runtime/options.js parseArgs 对偶）。opts:
 * { taskId?, port, dataDir, cordisSrc?, depsRoot?, readyMarker?, noEnsure? }
 */
export function buildRuntimeArgs(opts) {
  const { taskId, port, dataDir, cordisSrc, depsRoot, readyMarker = READY_MARKER, noEnsure = false } = opts || {};
  const args = [];
  if (typeof port === "number") args.push("--port", String(port));
  else throw new Error("buildRuntimeArgs: port 必填（1..65535 显式端口）");
  if (typeof dataDir === "string" && dataDir) args.push("--data-dir", dataDir);
  else throw new Error("buildRuntimeArgs: dataDir 必填（App ctx.dataDir）");
  if (taskId) args.push("--hana-task-id", String(taskId));
  if (typeof cordisSrc === "string" && cordisSrc) args.push("--cordis-src", cordisSrc);
  if (typeof depsRoot === "string" && depsRoot) args.push("--deps-root", depsRoot);
  args.push("--ready-marker", readyMarker);
  if (noEnsure) args.push("--no-ensure");
  return args;
}

/** runtime 终态归类（纯函数）：按 info.state/exitCode/signal/service 产出 { kind, userText }。 */
export function classifyRuntimeFailure(info) {
  if (!info || typeof info !== "object") return { kind: "unknown", userText: START_ERROR_HINTS.unknown };
  const code = typeof info.exitCode === "number" ? info.exitCode : null;
  const state = info.state || "";
  // 子进程退出码由 src/runtime/main.js EXIT 约定：7=port/boot/ready 失败、4=deps、5=seed…
  if (code === 7 || /port/i.test(String(info.signal || ""))) {
    return { kind: "port-busy", userText: START_ERROR_HINTS["port-busy"] };
  }
  if (code === 4) return { kind: "deps", userText: START_ERROR_HINTS.deps };
  if (code === 5) return { kind: "seed", userText: START_ERROR_HINTS.seed };
  if (code === 6) return { kind: "boot-failed", userText: START_ERROR_HINTS["boot-failed"] };
  if (state === "failed" || state === "exited" || state === "stopped") {
    return { kind: "boot-failed", userText: START_ERROR_HINTS["boot-failed"] };
  }
  return { kind: "unknown", userText: START_ERROR_HINTS.unknown };
}

function logApp(level, ...args) {
  const app = getAppRuntime();
  if (app && typeof app.appendLog === "function") {
    try {
      app.appendLog("hana", args.map((a) => (a instanceof Error ? a.stack || a.message : String(a))).join(" "));
    } catch {
      /* 日志失败不阻断 */
    }
  }
  const logger = appLogger();
  if (logger && typeof logger[level] === "function") {
    try {
      logger[level](...args);
    } catch {
      /* 宿主日志失败忽略 */
    }
  }
}

/** watch 镜像（尽力）：消费 runtime SSE/NDJSON log 记录 → appendLog(src=dsht)。 */
async function mirrorRuntimeLogs(ctx, runtimeId) {
  const app = getAppRuntime();
  if (!app || !app.appendLog) return;
  if (managed.mirrors.includes(runtimeId)) return;
  managed.mirrors.push(runtimeId);
  const ac = new AbortController();
  managed.mirrorCancel = ac;
  try {
    const res = await ctx.runtime.watch(runtimeId);
    if (!res || !res.body || typeof res.body.getReader !== "function") return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      if (ac.signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        consumeLine(line);
      }
    }
  } catch {
    /* watch 镜像失败：不阻断（宿主 runtime 自带日志，诊断可经 watch 重取） */
  } finally {
    try {
      managed.mirrorCancel = null;
    } catch { /* ignore */ }
  }
  function consumeLine(raw) {
    const line = String(raw).trim();
    if (!line) return;
    let record = null;
    if (line.startsWith("data:")) {
      try { record = JSON.parse(line.slice(5).trim()); } catch { /* 非 JSON 数据行 */ }
    } else {
      try { record = JSON.parse(line); } catch { /* 非 JSON（日志原文） */ }
    }
    const text = record && typeof record.text === "string" ? record.text : line;
    try {
      app.appendLog("dsht", text);
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 启动 + 等到就绪（single-flight 单例）。opts: { taskId?, cordisSrc?, depsRoot?, noEnsure? }。
 * 成功返回 { runtimeId, info }（state=ready）；失败抛 Error（message 含归类与用户指引），
 * 单例清空以便下次调用重试。首次调用 = 依赖 ensure + DSH boot（可能数分钟，日志可见）。
 */
export async function ensureManagedRuntime(opts = {}) {
  if (managed.phase === "ready" && managed.runtimeId) {
    return { runtimeId: managed.runtimeId, info: managed.lastInfo };
  }
  if (managed.phase === "starting" && managed.promise) {
    return managed.promise; // 并发首启共享同一 promise
  }
  const promise = doStartManaged(opts);
  managed.phase = "starting";
  managed.promise = promise;
  try {
    const result = await promise;
    managed.phase = "ready";
    managed.lastInfo = result.info;
    managed.lastError = null; // ready 态不残留历史失败（boot-state 快照 error 字段同步清空）
    return result;
  } catch (e) {
    managed.phase = "error";
    managed.lastError = e;
    managed.runtimeId = null;
    throw e;
  } finally {
    managed.promise = null;
  }
}

async function doStartManaged(opts) {
  const app = getAppRuntime();
  if (!app || !app.ctx || typeof app.ctx.runtime?.start !== "function") {
    throw new Error("managed-runtime: App 运行包未初始化（apply 未注入 ctx.runtime）");
  }
  const ctx = app.ctx;
  const dataDir = appDataDir();
  if (!dataDir) throw new Error("managed-runtime: ctx.dataDir 缺失");
  const port = parseServicePort(appConfig("servicePort"));
  logApp("info", "[managed-runtime] 启动 DSH 受管 runtime（entry=runtime/dsh-host.mjs port=" + port + "）");

  // ---- App 进程侧依赖 ensure（runtime 沙箱无法 spawn，见模块头）----
  // opts.noEnsure = 跳过（预置 depsRoot 调试/离线场景，直接 start）；默认在此 ensure：
  // pnpm install 到 dataDir/runtime（App 进程有 --allow-child-process，唯一可 spawn 者）。
  // runtime 进程恒以 --no-ensure 启动（只 boot 不 spawn——沙箱内 ensure 必 EPERM）。
  if (!opts.noEnsure) {
    const runtimeDir = join(dataDir, "runtime");
    const depsRoot = typeof opts.depsRoot === "string" && opts.depsRoot ? opts.depsRoot : join(runtimeDir, "node_modules");
    logApp("info", "[managed-runtime] deps ensure（App 进程，spawn 授权面）：installRoot=" + PLUGIN_ROOT);
    let ensured;
    try {
      ensured = await ensureDeps({
        dataDir,
        installRoot: PLUGIN_ROOT, // App 安装根（只读，含 runtime 三件套声明）
        runtimeDir,
        depsRoot,
        noEnsure: false,
        log: (s) => logApp("info", "[managed-runtime] " + s),
      });
    } catch (e) {
      const text = (e && e.message) || String(e);
      logApp("error", "[managed-runtime] deps ensure 异常：" + text);
      const err = new Error("DSH 依赖 ensure 异常：" + text);
      err.code = "deps-unknown";
      throw err;
    }
    if (ensured.status === "error") {
      const text = ensured.message || "";
      const hint = ensured.kind === "io"
        ? " 依赖安装无法启动子进程：请确认宿主已授予本 App app/process.spawn 能力（Settings → Security → App capabilities，授予后需重载 App 生效）。"
        : ensured.kind === "network"
          ? " 首次安装需要网络（registry.npmjs.org）。"
          : "";
      const err = new Error("DSH 依赖 ensure 失败（kind=" + ensured.kind + "）：" + text + hint);
      err.code = "deps-" + ensured.kind;
      logApp("error", "[managed-runtime] deps ensure 失败 kind=" + ensured.kind);
      throw err;
    }
    logApp("info", "[managed-runtime] deps 就绪：" + (ensured.status === "present" ? "幂等命中（dsh@" + ensured.dsh + "）" : "本次安装完成（dsh@" + ensured.dsh + "）"));
  }

  // cordisSrc 默认不传：子进程按自身入口位置推导 <installRoot>/cordis（App 安装只读，
  // 从 App 侧算 installRoot 反而脆弱）。调试/预置场景可显式传 depsRoot/cordisSrc 覆盖。
  const args = buildRuntimeArgs({
    taskId: opts.taskId || null,
    port,
    dataDir,
    cordisSrc: typeof opts.cordisSrc === "string" && opts.cordisSrc ? opts.cordisSrc : undefined,
    depsRoot: typeof opts.depsRoot === "string" && opts.depsRoot ? opts.depsRoot : undefined,
    noEnsure: true, // runtime 进程恒不 ensure（沙箱无法 spawn；依赖由 App 进程 ensure 保证）
  });
  // 权限档 = local-machine（定案 2026-09-10，见 specs/dshana-v2-定案与待议-2026-09-10.md §1）：
  // 明确不是沙箱——受管程序自持工作区与命令策略，可读写当前用户可及的一切文件（含其他应用
  // 数据与磁盘凭据），仅保留 stop / 撤销 / 进程树回收的托管语义。宿主契约**禁止**传
  // readRoots / writeRoots / callToken / taskId，故本调用一律不带（文件边界归零，换来 DSH 能
  // 写进用户项目工作区）。护栏 = DSH 自身权限模式与审批策略 + 已接上的 Hana 审批面。
  const input = {
    runtime: "node",
    entry: RUNTIME_ENTRY,
    profile: "local-machine",
    network: "external",
    args,
    service: { port, readyMarker: READY_MARKER },
  };
  let info;
  try {
    info = await ctx.runtime.start(input);
  } catch (e) {
    // 宿主侧 start 拒绝（能力/授权/校验失败）：归类上报
    const text = (e && e.message) || String(e);
    logApp("error", "[managed-runtime] ctx.runtime.start 被宿主拒绝：" + text);
    const kind = /not authorized|authoriz|DENIED|declined/i.test(text) ? "not-authorized" : "unknown";
    const err = new Error((START_ERROR_HINTS[kind] || START_ERROR_HINTS.unknown) + "（宿主：" + text + "）");
    err.code = kind;
    throw err;
  }
  const runtimeId = info && info.runtimeId;
  if (!runtimeId) {
    throw new Error("ctx.runtime.start 未返回 runtimeId（宿主契约异常）：" + JSON.stringify(info || null));
  }
  managed.runtimeId = runtimeId;
  logApp("info", "[managed-runtime] runtimeId=" + runtimeId + " state=" + (info.state || "starting"));
  // 日志镜像（尽力，不阻塞就绪等待）
  try {
    void mirrorRuntimeLogs(ctx, runtimeId);
  } catch {
    /* 忽略 */
  }
  // 轮询等到 ready / failed / exited / stopped（起始 starting；不能把 runtimeId 当就绪）
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    let cur = null;
    try {
      cur = await ctx.runtime.get(runtimeId);
    } catch (e) {
      logApp("warn", "[managed-runtime] runtime.get 查询失败：" + ((e && e.message) || e));
    }
    const state = cur && cur.state;
    const service = cur && cur.service;
    if (state === "ready" || (service && service.state === "ready")) {
      logApp("info", "[managed-runtime] DSH 就绪（state=ready service=" + JSON.stringify(service) + "）");
      managed.lastInfo = cur;
      return { runtimeId, info: cur };
    }
    if (state === "failed" || state === "exited" || state === "stopped") {
      const cls = classifyRuntimeFailure(cur);
      managed.lastInfo = cur;
      const err = new Error(cls.userText + "（runtime state=" + state + " exitCode=" + (cur && cur.exitCode) + "）");
      err.code = cls.kind;
      logApp("error", "[managed-runtime] DSH runtime 终态异常：" + state + " exit=" + (cur && cur.exitCode));
      throw err;
    }
    if (Date.now() >= deadline) {
      const err = new Error(
        "DSH 受管 runtime 启动超时（" + Math.round(READY_TIMEOUT_MS / 1000) + "s 内未就绪）。" +
        "首次启动含依赖 ensure 与 DSH boot，若仍在进行请稍候；查看 App 日志/runtime 日志。",
      );
      err.code = "timeout";
      throw err;
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
}

/** 停止当前受管 runtime（App 卸载/重载/更新前调用；Windows 依赖重装前同样先停）。 */
export async function stopManagedRuntime() {
  const app = getAppRuntime();
  const runtimeId = managed.runtimeId;
  managed.phase = "stopped";
  managed.runtimeId = null;
  managed.lastInfo = null;
  if (managed.mirrorCancel) {
    try {
      managed.mirrorCancel.abort();
    } catch { /* ignore */ }
    managed.mirrorCancel = null;
  }
  if (!runtimeId) return;
  if (app && app.ctx && typeof app.ctx.runtime?.stop === "function") {
    try {
      await app.ctx.runtime.stop(runtimeId);
      logApp("info", "[managed-runtime] runtime 已停止：" + runtimeId);
    } catch (e) {
      logApp("warn", "[managed-runtime] runtime.stop 失败（宿主可能已回收）：" + ((e && e.message) || e));
    }
  }
}

/** apply disposer 收尾（幂等）：停 runtime、清单例。 */
export async function disposeManagedRuntime() {
  await stopManagedRuntime();
  resetManagedRuntime();
}

/** 读取当前单例状态（诊断/接线调试用）。 */
export function managedRuntimeState() {
  return {
    runtimeId: managed.runtimeId,
    phase: managed.phase,
    lastError: managed.lastError ? String((managed.lastError && managed.lastError.message) || managed.lastError) : null,
  };
}

/**
 * 单例详情快照（boot-state / 壳页诊断面消费；保留对象形态供 UI 化展示）：
 * { phase, runtimeId, info（最近一次 runtime.get 轮询记录，含 service 就绪态）,
 *   lastError（Error 实例或 null）}。phase 值语义见 managed 注释。
 */
export function managedRuntimeDetails() {
  return {
    phase: managed.phase,
    runtimeId: managed.runtimeId,
    info: managed.lastInfo ? { ...managed.lastInfo } : null,
    lastError: managed.lastError || null,
  };
}
