// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/managed-runtime.js — dshana 受管 DSH runtime 启动封装
//
// 职责：
//   managedStart/ensureManagedRuntime：父进程随机选取「中继端口（注册给宿主的 service.port）
//     + DSH 内部端口」→ ctx.runtime.start({ runtime:"node", entry:"runtime/dsh-host.mjs",
//     profile:"local-machine", network:"external", cwd:ctx.dataDir, service:{ port:中继端口,
//     readyMarker:带随机 opaque }, ... }) → 状态轮询等到 ready / failed / exited。
//     绝不把 runtimeId 当就绪：starting 只是宿主已拉起进程，DSH 真就绪 = 子
//     进程真实监听后打印的 readyMarker → host 侧 service.state=ready。
//     端口不再暴露给用户：区间随机 + 占用自动换端口重试；就绪缓存每次经
//     runtime.get 探活，子进程崩溃可被父侧识别并重起（对齐样例 controller 边界）。
//   单例语义：一个 App runtime 服务多个 DSH 会话（每会话的 taskId 经任务桥各自携带，
//     不把单次启动任务绑成全局焦点）；首次 create 时启动（tools/session.js 接线点），
//     ready 后所有 action 复用。runtime 终止后清除单例，下次调用重启。App 卸载/重载经
//     disposeManagedRuntime 收尾（apply disposer）。
//   日志：一律走宿主 ctx.logger（`logApp`），App 侧不写文件日志；受管子进程的
//     stdout/stderr 归宿主 runtime 日志（有界，可经 ctx.runtime.watch/info 取），不由
//     App 自己落盘。
//
// 参数契约（与 src/runtime/options.js 对偶；增删需两处同步 + tests/）：
//   唯一的子进程入参是私有运行时配置文件路径（argv[1]），由 writeRuntimeConfigFile 落盘、
//   buildRuntimeConfig 生产 schema；不再有命令行明文参数（凭据/端口不进 argv）。
import { join } from "node:path";
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { randomInt, randomBytes } from "node:crypto";
import { appDataDir, appLogger, getAppRuntime } from "./app-runtime.js";
import { currentSource } from "./data-source.js";
// 依赖随包物化在安装目录 <installRoot>/node_modules，
// 无运行时安装与 spawn。

export const READY_MARKER = "DSH_READY"; // 标记前缀；每次启动拼随机 opaque（宿主按整行匹配）
export const RUNTIME_ENTRY = "runtime/dsh-host.mjs"; // 相对 App 安装目录（宿主校验在安装/数据目录内）
/** 受管端口选取区间（与官方样例 hana-dsh controller.mjs 同款；宿主 service 端口契约 1024..65535 的确定整数，禁 0/随机哨兵）。 */
export const PORT_MIN = 38000;
export const PORT_MAX = 52000;
export const MAX_START_ATTEMPTS = 3; // 端口占用（随机撞车）自动换端口重试上限
/** runtime 终态集合（宿主 runtime state 契约）。 */
export const TERMINAL_STATES = new Set(["failed", "exited", "stopped"]);
export const READY_POLL_MS = 300;
export const READY_TIMEOUT_MS = 240000; // 首次启动含 profile 种子化与 DSH boot，需更宽容限
export const START_ERROR_HINTS = {
  "port-busy": "端口被占用或 DSH 无法监听（服务代理未就绪）。已自动换随机端口重试，仍失败请查看 runtime 日志并确认本机回环端口可用。",
  "port-unreachable": "DSH 未在期望端口完成监听（webServer 服务端口与期望不符或探测失败）。查看 runtime 日志定位。",
  "boot-failed": "DSH runProfile 启动失败（见 runtime 日志）。",
  deps: "DSH 依赖缺失：包内 node_modules 不完整（依赖应随包物化）。请重新安装本 App。",
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
  bridgePort: null, // 中继端口（= 注册给宿主的 service.port；浏览器侧访问）
  bridgeKey: null, // 中继鉴权 key（header x-hana-dsh-bridge / _hana 路径；绝不落盘/落日志）
  controlKey: null, // 控制面 key（/_control；App 工具经 controller.invoke 使用）
};

/** 复位单例（外部测试/重建用）。 */
export function resetManagedRuntime() {
  managed = {
    runtimeId: null,
    phase: "idle",
    promise: null,
    lastInfo: null,
    lastError: null,
    bridgePort: null,
    bridgeKey: null,
    controlKey: null,
  };
  return managed;
}

/**
 * 访问面归零（端口与两把 key）。失败收尾/停止/重起前调用——否则 bridgeAccess() 会把
 * 已死的中继端口继续发给调用方。runtimeId 一并清（与访问面同生命周期）。
 */
function clearRuntimeIdentity() {
  managed.runtimeId = null;
  managed.bridgePort = null;
  managed.bridgeKey = null;
  managed.controlKey = null;
}

/**
 * 端口选取（纯函数，可注入 rng 便于单测）：[PORT_MIN, PORT_MAX) 内的确定整数。
 * 宿主 runtime service 端口契约要求显式整数（1024..65535，禁 0/随机哨兵），故只能由父进程
 * 自选后传入，不能交给宿主分配；区间随机使端口不再需要用户配置。
 */
export function choosePort(rng = randomInt) {
  return rng(PORT_MIN, PORT_MAX);
}

/** 同次启动的两个端口：中继端口（service.port）与 DSH 内部端口，保证不相等。 */
export function pickPorts(rng = randomInt) {
  const bridgePort = choosePort(rng);
  let dshPort = choosePort(rng);
  while (dshPort === bridgePort) dshPort = choosePort(rng);
  return { bridgePort, dshPort };
}

/** 本次启动的就绪标记：前缀 + 随机 opaque（跨实例不撞、不可预测；不得含换行）。 */
export function makeReadyMarker() {
  return READY_MARKER + ":" + randomBytes(18).toString("base64url");
}

/**
 * 私有运行时配置构造（与 src/runtime/options.js normalizeRuntimeConfig 对偶）。opts:
 * { dataDir, dshHome?, dshPort, bridgePort, bridgeKey, controlKey, cordisSrc?, depsRoot?, readyMarker? }
 * dshHome = 当前数据源的 DSH_HOME；缺省时子进程回落 dataDir/.dsh。
 * 敏感项（bridgeKey）只进本对象→写 0600 文件→argv 只传路径，不出现在 argv/日志。
 */
export function buildRuntimeConfig(opts) {
  const { dataDir, dshHome, dshPort, bridgePort, bridgeKey, controlKey, cordisSrc, depsRoot, readyMarker = READY_MARKER } = opts || {};
  if (typeof dataDir !== "string" || !dataDir) throw new Error("buildRuntimeConfig: dataDir 必填（App ctx.dataDir）");
  if (!Number.isInteger(dshPort) || dshPort < 1 || dshPort > 65535) throw new Error("buildRuntimeConfig: dshPort 必填（1..65535）");
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) throw new Error("buildRuntimeConfig: bridgePort 必填（1..65535）");
  if (typeof bridgeKey !== "string" || bridgeKey.length < 16) throw new Error("buildRuntimeConfig: bridgeKey 必填（≥16 字符）");
  if (typeof controlKey !== "string" || controlKey.length < 16) throw new Error("buildRuntimeConfig: controlKey 必填（≥16 字符）");
  const config = { dataDir, dshPort, bridgePort, bridgeKey, controlKey, readyMarker };
  if (typeof dshHome === "string" && dshHome) config.dshHome = dshHome;
  if (typeof cordisSrc === "string" && cordisSrc) config.cordisSrc = cordisSrc;
  if (typeof depsRoot === "string" && depsRoot) config.depsRoot = depsRoot;
  return config;
}

/** 写私有运行时配置文件（dataDir/integration/，0600），返回绝对路径。 */
export function writeRuntimeConfigFile(dataDir, config) {
  const dir = join(dataDir, "integration");
  mkdirSync(dir, { recursive: true });
  const filename = join(dir, `runtime-${randomBytes(9).toString("hex")}.json`);
  writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  try { chmodSync(filename, 0o600); } catch { /* Windows 权限位有限，忽略 */ }
  return filename;
}

/** 中继/控制访问面（App 侧用）：{ base, headers, port, key, controlKey, runtimeId }；未就绪返回 null。 */
export function bridgeAccess() {
  if (!managed.bridgePort) return null;
  return {
    base: "http://127.0.0.1:" + managed.bridgePort,
    headers: managed.bridgeKey ? { "x-hana-dsh-bridge": managed.bridgeKey } : {},
    port: managed.bridgePort,
    key: managed.bridgeKey,
    controlKey: managed.controlKey,
    runtimeId: managed.runtimeId,
  };
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
  const logger = appLogger();
  if (logger && typeof logger[level] === "function") {
    try {
      logger[level](...args);
    } catch {
      /* 宿主日志失败忽略 */
    }
  }
}

/**
 * 启动 + 等到就绪（single-flight 单例）。opts: { taskId?, cordisSrc?, depsRoot? }。
 * 成功返回 { runtimeId, info }（state=ready）；失败抛 Error（message 含归类与用户指引），
 * 单例清空以便下次调用重试。首次调用 = profile 种子化 + DSH boot（日志可见）。
 */
/** 等 runtime 到终态（停业确认）；超时或查询失败返回 null。 */
async function waitTerminal(ctx, runtimeId, timeoutMs = 15000) {
  if (!runtimeId || !ctx || typeof ctx.runtime?.get !== "function") return null;
  const until = Date.now() + timeoutMs;
  for (;;) {
    const cur = await ctx.runtime.get(runtimeId).catch(() => null);
    if (!cur || TERMINAL_STATES.has(cur.state)) return cur;
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * 就绪探活：宿主 runtime.get 到 ready 才算仍活着。子进程崩溃/被回收后 state 变终态 →
 * 返回 null（调用方转重起），不再拿陈旧缓存冒充 ready。查询本身失败时保守视为仍就绪
 * （避免宿主查询抖动引起不必要的重起/双 runtime）。
 */
async function probeLiveRuntime() {
  const app = getAppRuntime();
  const runtimeId = managed.runtimeId;
  if (!app || !app.ctx || typeof app.ctx.runtime?.get !== "function" || !runtimeId) return null;
  let cur;
  try {
    cur = await app.ctx.runtime.get(runtimeId);
  } catch (e) {
    logApp("warn", "[managed-runtime] runtime.get 探活失败（保守视为仍就绪）：" + ((e && e.message) || e));
    return managed.lastInfo;
  }
  if (cur && (cur.state === "ready" || (cur.service && cur.service.state === "ready"))) {
    managed.lastInfo = cur;
    return cur;
  }
  return null;
}

/**
 * 失败收尾：runtime 未到终态则停掉并等终态，之后访问面（端口 + 两把 key）与 runtimeId 归零。
 * 重试前必须先做——旧 runtime 不收掉，新一次的中继访问面会与它纠缠。
 */
async function reapFailedRuntime(ctx) {
  const runtimeId = managed.runtimeId;
  clearRuntimeIdentity();
  if (!runtimeId || !ctx || typeof ctx.runtime?.get !== "function") return;
  try {
    const cur = await ctx.runtime.get(runtimeId);
    if (cur && !TERMINAL_STATES.has(cur.state) && typeof ctx.runtime.stop === "function") {
      await ctx.runtime.stop(runtimeId);
      await waitTerminal(ctx, runtimeId);
    }
  } catch (e) {
    logApp("warn", "[managed-runtime] 失败 runtime 收尾异常（宿主可能已回收）：" + ((e && e.message) || e));
  }
}

/**
 * 启动 + 等到就绪（single-flight 单例）。opts: { taskId?, cordisSrc?, depsRoot? }。
 * 成功返回 { runtimeId, info }（state=ready）；失败抛 Error（message 含归类与用户指引），
 * 单例清空以便下次调用重试。首次调用 = profile 种子化 + DSH boot（日志可见）。
 */

// ---- 失败后的自动重试 ----
// 首次安装时“能力/权限尚未授予”是常态：apply 自动链的第一次 ensure 必然失败。既然页面不再提供
// 手动「启动 / 重启」按钮（无交互设计），这条链就得自己回来——失败即按退避重试，直到成功、
// 被手动停止（stopManagedRuntime 冻结）或 App 卸载（dispose 走 stop）。任何显式启动请求
// （apply 自动链 / dshana_session 首调 / /dshana/start）都会重新武装。
const AUTO_RETRY_SCHEDULE_MS = [5000, 15000, 30000, 60000, 120000, 300000]; // 5s → 5min，之后停在 5min
let autoRetryTimer = null;
let autoRetryAttempt = 0;
let autoRetryFrozen = false;

/** 取消并冻结自动重试（手动停止时调用）；下一次显式 ensure 会重新武装。 */
function cancelRuntimeAutoRetry() {
  if (autoRetryTimer) {
    try { clearTimeout(autoRetryTimer); } catch { /* 忽略 */ }
    autoRetryTimer = null;
  }
  autoRetryFrozen = true;
  autoRetryAttempt = 0;
}

function scheduleRuntimeAutoRetry(reason) {
  if (autoRetryFrozen || autoRetryTimer) return;
  const delay = AUTO_RETRY_SCHEDULE_MS[Math.min(autoRetryAttempt, AUTO_RETRY_SCHEDULE_MS.length - 1)];
  autoRetryAttempt += 1;
  const nth = autoRetryAttempt;
  const timer = setTimeout(() => {
    autoRetryTimer = null;
    if (autoRetryFrozen) return;
    ensureManagedRuntime({}).then(
      () => { autoRetryAttempt = 0; logApp("info", "[managed-runtime] 自动重试成功，DSH 已就绪"); },
      () => { scheduleRuntimeAutoRetry(reason); },
    );
  }, delay);
  if (timer && typeof timer.unref === "function") timer.unref();
  autoRetryTimer = timer;
  logApp(
    "warn",
    "[managed-runtime] DSH 启动失败（第 " + nth + " 次）：" + String(reason).slice(0, 160) +
      " —— " + Math.round(delay / 1000) + "s 后自动重试（无需手动操作）",
  );
}

/**
 * 每次命中 ready 缓存都先探活（runtime.get）；子进程崩溃/被回收则清单例并重起。
 */
export async function ensureManagedRuntime(opts = {}) {
  // 显式启动请求 = 重新武装自动重试（用户手动停止过、随后又有会话或 /dshana/start 触发）
  autoRetryFrozen = false;
  if (managed.phase === "ready" && managed.runtimeId) {
    const live = await probeLiveRuntime();
    if (live) return { runtimeId: managed.runtimeId, info: live };
    logApp("warn", "[managed-runtime] 缓存 ready 但 runtime 已不在就绪态（子进程退出/宿主回收），重新启动");
    const app = getAppRuntime();
    await reapFailedRuntime(app && app.ctx);
    managed.phase = "idle";
    managed.lastInfo = null;
  }
  if (managed.phase === "starting" && managed.promise) {
    return managed.promise; // 并发首启共享同一 promise
  }
  const promise = startWithPortRetry(opts);
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
    clearRuntimeIdentity(); // 失败不留死端口/死 key（bridgeAccess 不得再发出去）
    // 失败不等于等人来救：按退避自动重试（首次安装「权限尚未授予」这类必失败就靠它自愈）
    scheduleRuntimeAutoRetry((e && e.message) || String(e));
    throw e;
  } finally {
    managed.promise = null;
  }
}

/** 端口占用（本机随机撞车）自动换随机端口重试；其他失败直接上抛。 */
async function startWithPortRetry(opts) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
    try {
      return await doStartManaged(opts, attempt);
    } catch (e) {
      lastError = e;
      await reapFailedRuntime(getAppRuntime()?.ctx);
      if (!(e && e.code === "port-busy") || attempt >= MAX_START_ATTEMPTS) throw e;
      logApp("warn", "[managed-runtime] 端口占用（第 " + attempt + " 次尝试）——换随机端口重试");
    }
  }
  throw lastError || new Error(START_ERROR_HINTS.unknown);
}

async function doStartManaged(opts, attempt = 1) {
  const app = getAppRuntime();
  if (!app || !app.ctx || typeof app.ctx.runtime?.start !== "function") {
    throw new Error("managed-runtime: App 运行包未初始化（apply 未注入 ctx.runtime）");
  }
  const ctx = app.ctx;
  const dataDir = appDataDir();
  if (!dataDir) throw new Error("managed-runtime: ctx.dataDir 缺失");
  // 数据源：DSH_HOME 由当前源决定（private = <dataDir>/.dsh；shared = 外部目录）。
  // 读设置失败即抛错（不得默认切错源）；设置文件不存在时回落 private 默认。
  const source = await currentSource();
  const { bridgePort, dshPort } = pickPorts();
  const bridgeKey = randomBytes(24).toString("base64url");
  const controlKey = randomBytes(24).toString("base64url");
  const readyMarker = makeReadyMarker();
  const config = buildRuntimeConfig({
    dataDir,
    dshHome: source.home,
    dshPort,
    bridgePort,
    bridgeKey,
    controlKey,
    readyMarker,
    cordisSrc: typeof opts.cordisSrc === "string" && opts.cordisSrc ? opts.cordisSrc : undefined,
    depsRoot: typeof opts.depsRoot === "string" && opts.depsRoot ? opts.depsRoot : undefined,
  });
  const configPath = writeRuntimeConfigFile(dataDir, config);
  logApp("info", "[managed-runtime] 启动 DSH 受管 runtime（attempt " + attempt + "/" + MAX_START_ATTEMPTS + " source=" + source.sourceId + " dshHome=" + source.home + " dshPort=" + dshPort + " bridgePort=" + bridgePort + "）");
  // 权限档 = local-machine：
  // 明确不是沙箱——受管程序自持工作区与命令策略，可读写当前用户可及的一切文件（含其他应用
  // 数据与磁盘凭据），仅保留 stop / 撤销 / 进程树回收的托管语义。宿主契约**禁止**传
  // readRoots / writeRoots / callToken / taskId，故本调用一律不带（文件边界归零，换来 DSH 能
  // 写进用户项目工作区）。护栏 = DSH 自身权限模式与审批策略 + 已接上的 Hana 审批面。
  const input = {
    runtime: "node",
    entry: RUNTIME_ENTRY,
    profile: "local-machine",
    network: "external",
    cwd: dataDir,
    args: [configPath],
    service: { port: bridgePort, readyMarker },
  };
  let info;
  try {
    info = await ctx.runtime.start(input);
  } catch (e) {
    // 启动失败：配置文件中含 bridgeKey，立即删除（不残留凭据）
    try { rmSync(configPath, { force: true }); } catch { /* 忽略 */ }
    // 宿主侧 start 拒绝（能力/授权/校验失败）：归类上报
    const text = (e && e.message) || String(e);
    logApp("error", "[managed-runtime] ctx.runtime.start 被宿主拒绝：" + text);
    const kind = /not authorized|authoriz|DENIED|declined/i.test(text) ? "not-authorized" : "unknown";
    const err = new Error((START_ERROR_HINTS[kind] || START_ERROR_HINTS.unknown) + "（宿主：" + text + "）");
    err.code = kind;
    throw err;
  }
  // 子进程已启动：配置已读入（首件事），延迟清理文件；同时记录中继访问面供 App 侧 RPC。
  managed.bridgePort = bridgePort;
  managed.bridgeKey = bridgeKey;
  managed.controlKey = controlKey;
  setTimeout(() => { try { rmSync(configPath, { force: true }); } catch { /* 忽略 */ } }, 10000);
  const runtimeId = info && info.runtimeId;
  if (!runtimeId) {
    throw new Error("ctx.runtime.start 未返回 runtimeId（宿主契约异常）：" + JSON.stringify(info || null));
  }
  managed.runtimeId = runtimeId;
  logApp("info", "[managed-runtime] runtimeId=" + runtimeId + " state=" + (info.state || "starting"));
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
        "首次启动含 profile 种子化与 DSH boot，若仍在进行请稍候；查看 App 日志/runtime 日志。",
      );
      err.code = "timeout";
      throw err;
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
}

/** 停止当前受管 runtime（App 卸载/重载/更新前调用；Windows 依赖重装前同样先停）。 */
export async function stopManagedRuntime() {
  // 手动停止同时冻结自动重试（否则刚停就被重试拉回来）；下一次显式 ensure 会重新武装
  cancelRuntimeAutoRetry();
  const app = getAppRuntime();
  const runtimeId = managed.runtimeId;
  managed.phase = "stopped";
  clearRuntimeIdentity();
  managed.lastInfo = null;
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
