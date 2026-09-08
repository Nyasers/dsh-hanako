// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/runtime-host.js — App 侧受管 runtime 控制器（ctx.runtime.start 单一入口）
//
// 形态（spec D1）：App 进程保持薄壳——只做注册面/路由/任务映射；DSH 运行时整体在受管
// native runtime 进程内（runtime/dsh-host.mjs）。本模块是 App 侧唯一拉起/查询/停止入口：
//   ensureDshRuntime(ctx, { taskId, cwd })  → 幂等 single-flight 启动 + 等就绪
//   stopDshRuntime(ctx)                     → 停该 App 的受管 runtime
//   readDshRuntimeState()                   → 内存态快照（诊断/UI）
//
// 契约要点（0.930.1 宿主 bundle 实证，见 gap audit §1.1）：
//   · profile: "native" 必须显式 network: "external"（否则 INVALID_INPUT）；native 需
//     app/runtime.execute + app/runtime.native + app/runtime.network 三项授权；
//   · entry 必须在 installDir/dataDir 内（相对路径按 installDir 解析）；
//   · cwd 缺省 = dataDir；显式 cwd 必须是 dataDir 或宿主已授权可写根；
//   · service 端口 1024..65535 + 精确 readyMarker（禁止「端口 0 → 随机分配」）；
//   · start() 返回可能仍是 starting —— 必须 watch/get 等到 ready 或 failed；
//   · Windows 后端如实返回 enforcement: "partial"（native + partial 放行）；helper 缺失/
//     过旧 → SANDBOX_UNAVAILABLE，须给可行动的更新提示（不许静默降级 scoped）。
//
// 状态分层（spec D3）：runtimeId/端口等跨 Agent 轻状态 → ctx.storage.global；本模块内存态
// 只做进程内缓存（重载后由 storage.global 恢复）。

import { join } from "node:path";
import { runtimePaths, PROFILE_NAME, READY_MARKER } from "./runtime-layout.js";

/** 默认 service 端口（guide §6 示例值；v1 为随机端口，v2 service 契约要求显式端口）。 */
export const DEFAULT_SERVICE_PORT = 4317;
/** 端口占用时向后重选的次数（App 侧启动协调；不得输出虚假 READY）。 */
export const PORT_RETRY_LIMIT = 5;
const READY_TIMEOUT_MS = 180000; // 首启含依赖安装（213MB 树），给足时间
const POLL_INTERVAL_MS = 700;
const STORAGE_KEY = "dsh.runtime";

/** 进程内单例态（App 进程重载即丢；持久信息在 ctx.storage.global）。 */
const state = {
  runtimeId: null,
  port: null,
  starting: null,
  lastError: null,
  lastInfo: null,
  taskId: null,
};

export function readDshRuntimeState() {
  return { ...state };
}

function servicePortFrom(ctx) {
  let port = DEFAULT_SERVICE_PORT;
  try {
    const v = ctx?.config?.get?.("servicePort");
    if (Number.isInteger(v) && v >= 1024 && v <= 65535) port = v;
  } catch {
    /* 设置不可用（apply 顶层）：用默认值 */
  }
  return port;
}

function helperGuidance(e) {
  const code = e?.code || "";
  if (code === "SANDBOX_UNAVAILABLE") {
    return (
      "受管 runtime 不可用（" + (e?.message || code) + "）。Windows 需安装带新 Node IPC 协议的 " +
      "Hana helper（resources/sandbox/windows/hana-win-sandbox.exe --runtime-capabilities 应返回 " +
      '{"version":1,"nodeIpc":true}）；请更新 Hana 桌面安装包/独立运行时——单独复制 SDK 或更新' +
      "服务端脚本不能代替 helper 更新。"
    );
  }
  if (code === "NATIVE_DENIED" || code === "NETWORK_DENIED" || code === "APP_CAPABILITY_DENIED") {
    return (
      "缺少受管 runtime 授权（" + code + "）：需要 app/runtime.execute + app/runtime.native + " +
      "app/runtime.network（network 还须显式 external）。请在扩展设置里授予后重试。"
    );
  }
  if (code === "CONCURRENCY_LIMIT") {
    return "已达每 App 4 个活动受管 runtime 的上限：" + (e?.message || code);
  }
  return e?.message || String(e);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 读 storage.global 里上次记录的 runtimeId/端口（重载后对账用）。 */
function readStoredRuntime(ctx) {
  try {
    const v = ctx?.storage?.global?.get?.(STORAGE_KEY);
    if (v && typeof v === "object") return v;
  } catch {
    /* storage 不可用（apply 顶层） */
  }
  return null;
}

function writeStoredRuntime(ctx, patch) {
  try {
    const prev = readStoredRuntime(ctx) || {};
    ctx?.storage?.global?.set?.(STORAGE_KEY, { ...prev, ...patch, at: new Date().toISOString() });
  } catch {
    /* storage 不可用：内存态仍可用 */
  }
}

/** 查 runtime 状态（get 失败/未知 → null）。 */
async function getInfo(ctx, runtimeId) {
  try {
    return await ctx.runtime.get(runtimeId);
  } catch {
    return null;
  }
}

/**
 * 拉起（或复用）受管 DSH runtime，等到 ready。
 * ctx 必须是 App 的 v2 context（ctx.runtime/ctx.storage/ctx.config/ctx.dataDir/ctx.logger）。
 * opts: { taskId?, cwd?, profile?, force? }——taskId 由 ctx.tasks.create 产生（第 3 步完整接线）。
 * 返回 { runtimeId, port, info, reused }；失败抛错（message 已含可行动指引）。
 */
export function ensureDshRuntime(ctx, opts = {}) {
  if (state.starting) return state.starting;
  state.starting = startOnce(ctx, opts).finally(() => {
    state.starting = null;
  });
  return state.starting;
}

async function startOnce(ctx, opts) {
  const dataDir = ctx?.dataDir;
  if (typeof dataDir !== "string" || !dataDir) {
    throw new Error("ensureDshRuntime：ctx.dataDir 缺失（v2 App context 必带 dataDir）");
  }
  if (!ctx?.runtime || typeof ctx.runtime.start !== "function") {
    throw new Error("ensureDshRuntime：ctx.runtime 不可用（宿主版本 < 0.930.1？受管 runtime 为 v2 契约）");
  }
  const paths = runtimePaths(dataDir);
  const profileName = opts.profile || PROFILE_NAME;

  // ① 复用：内存态 → storage.global 记录的 runtimeId → get() 对账
  const candidates = [];
  if (state.runtimeId) candidates.push(state.runtimeId);
  const stored = readStoredRuntime(ctx);
  if (stored?.runtimeId && stored.runtimeId !== state.runtimeId) candidates.push(stored.runtimeId);
  for (const runtimeId of candidates) {
    const info = await getInfo(ctx, runtimeId);
    if (info && (info.state === "ready" || info.state === "starting")) {
      if (info.state === "starting") {
        const ready = await waitReady(ctx, runtimeId, info);
        state.runtimeId = runtimeId;
        state.port = ready.service?.port ?? info.service?.port ?? stored?.port ?? null;
        state.lastInfo = ready;
        syncCompatWeb(ctx);
        return { runtimeId, port: state.port, info: ready, reused: true };
      }
      state.runtimeId = runtimeId;
      state.port = info.service?.port ?? stored?.port ?? null;
      state.lastInfo = info;
      syncCompatWeb(ctx);
      return { runtimeId, port: state.port, info, reused: true };
    }
  }

  // ② 启动：端口显式 + 占用重选（App 侧启动协调；宿主不会替我们挑端口）
  const basePort = servicePortFrom(ctx);
  const cwd = typeof opts.cwd === "string" && opts.cwd ? opts.cwd : dataDir;
  let lastError = null;
  for (let attempt = 0; attempt < PORT_RETRY_LIMIT; attempt += 1) {
    const port = basePort + attempt;
    if (port > 65535) break;
    let runtime;
    try {
      runtime = await startRuntime(ctx, { port, cwd, opts, paths, profileName });
    } catch (e) {
      lastError = new Error(helperGuidance(e));
      lastError.code = e?.code;
      break; // 能力/沙箱类错误换端口无用，直接上报
    }
    state.runtimeId = runtime.runtimeId;
    state.port = port;
    state.taskId = opts.taskId || null;
    writeStoredRuntime(ctx, { runtimeId: runtime.runtimeId, port, taskId: opts.taskId || null });
    let info;
    try {
      info = await waitReady(ctx, runtime.runtimeId, runtime);
    } catch (e) {
      info = state.lastInfo;
      if (e?.code === "DSH_PORT_IN_USE" && attempt + 1 < PORT_RETRY_LIMIT) {
        lastError = e;
        try {
          await ctx.runtime.stop(runtime.runtimeId);
        } catch {
          /* 已退出 */
        }
        state.runtimeId = null;
        continue; // 换下一个端口
      }
      lastError = e;
      break;
    }
    state.lastInfo = info;
    state.lastError = null;
    syncCompatWeb(ctx);
    return { runtimeId: runtime.runtimeId, port, info, reused: false };
  }
  state.lastError = lastError ? lastError.message : "未知失败";
  throw lastError || new Error("受管 runtime 启动失败");
}

/**
 * 启动一次受管 runtime。
 * cwd 回退：工具传入的 cwd 必须是宿主已授权可写根（guide §6：仅传字符串不产生授权）；
 * 授权解析失败（INVALID_INPUT/scope 类错误）时回退 App dataDir（宿主保证可写）再试一次——
 * DSH 的会话工作区授权属第 3 步（task-bridge 按 session 解析），本步不因 cwd 未授权而整体失败。
 */
async function startRuntime(ctx, { port, cwd, opts, paths, profileName }) {
  const args = [
    "--port",
    String(port),
    "--hana-task-id",
    String(opts.taskId || ""),
    "--dsh-home",
    paths.dshHome,
    "--deps-root",
    paths.root,
    // installDir 由 runtime 入口以 import.meta.url 自行推导（宿主按 installDir 解析 entry，
    // 故 dist/runtime/dsh-host.mjs 的 dirname(dirname()) 即 App 安装目录）；不经参数传递。
    "--profile",
    profileName,
    "--app-id",
    String(ctx.id || "dsh-hanako"),
  ];
  const base = {
    runtime: "node",
    entry: "runtime/dsh-host.mjs",
    profile: "native",
    network: "external",
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    args,
    service: { port, readyMarker: READY_MARKER },
  };
  try {
    return await ctx.runtime.start({ ...base, cwd });
  } catch (e) {
    const code = e?.code || "";
    const cwdRelated =
      code === "INVALID_INPUT" || /authoriz|scope|writable|workspace/i.test(String(e?.message || ""));
    if (!cwdRelated || cwd === paths.dataDir) throw e;
    try {
      ctx.logger?.warn?.(
        "[dsh-hanako] cwd 未获授权（" + (e?.message || code) + "），回退 dataDir 启动受管 runtime",
      );
    } catch {
      /* 日志失败不阻断 */
    }
    return await ctx.runtime.start({ ...base, cwd: paths.dataDir });
  }
}

/** 轮询到 ready/failed/exited；超时抛错。端口占用（runtime 退出码 12）→ code=DSH_PORT_IN_USE。 */
async function waitReady(ctx, runtimeId, initial) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let info = initial;
  while (Date.now() < deadline) {
    if (!info) info = await getInfo(ctx, runtimeId);
    const st = info?.state;
    if (st === "ready") {
      if (info.service && info.service.state === "pending") {
        // runtime ready 但 service 代理尚未见 marker：继续等（marker 在监听后打印）
        await sleep(POLL_INTERVAL_MS);
        info = await getInfo(ctx, runtimeId);
        continue;
      }
      return info;
    }
    if (st === "failed" || st === "exited" || st === "stopped") {
      const code = info?.exitCode;
      const err = new Error(
        "DSH 受管 runtime 未就绪（state=" + st + "，exitCode=" + code + "）。详见 runtime 日志：" +
          join(ctx.dataDir, "logs", "dsh-runtime.log") +
          (code === 12 ? "（端口被占用——已尝试自动换端口）" : ""),
      );
      err.code = code === 12 ? "DSH_PORT_IN_USE" : "DSH_RUNTIME_FAILED";
      err.info = info;
      state.lastInfo = info;
      throw err;
    }
    await sleep(POLL_INTERVAL_MS);
    info = await getInfo(ctx, runtimeId);
  }
  const err = new Error("DSH 受管 runtime 就绪超时（" + Math.round(READY_TIMEOUT_MS / 1000) + "s）");
  err.code = "DSH_READY_TIMEOUT";
  throw err;
}

/**
 * 兼容桥（过渡，第 3 步退役）：v1 的指令/事件链（lib/protocol.js、tools/subtool/*）经
 * 宿主单例 g.web.port 走 HTTP /api 与进程内 ctx。v2 下 DSH 在受管 runtime 内，App 进程
 * 只拿到 service 端口——这里把 g.web 指到该端口，让第 2 步的 create/send 有可用通道；
 * 第 3 步换成 ctx.tasks + ACP/IPC 后删除本函数。
 */
function syncCompatWeb(ctx) {
  try {
    const g = globalThis.__dshHanako;
    if (!g || typeof g !== "object") return;
    g.web = {
      processMode: "managed-runtime",
      ready: true,
      port: state.port,
      runtimeId: state.runtimeId,
      dshHome: runtimePaths(ctx.dataDir).dshHome,
      logPath: join(ctx.dataDir, "logs", "dsh-runtime.log"),
      ctx: null, // DSH cordis ctx 在 runtime 进程内，App 进程不再持有
    };
  } catch {
    /* 兼容桥失败不阻断 */
  }
}

/** 停止本 App 的受管 DSH runtime（幂等）。 */
export async function stopDshRuntime(ctx) {
  const runtimeId = state.runtimeId || readStoredRuntime(ctx)?.runtimeId;
  state.runtimeId = null;
  state.port = null;
  state.lastInfo = null;
  try {
    const g = globalThis.__dshHanako;
    if (g) g.web = null;
  } catch {
    /* 忽略 */
  }
  if (!runtimeId || !ctx?.runtime?.stop) return { stopped: false };
  try {
    await ctx.runtime.stop(runtimeId);
    writeStoredRuntime(ctx, { runtimeId: null, stoppedAt: new Date().toISOString() });
    return { stopped: true, runtimeId };
  } catch (e) {
    return { stopped: false, runtimeId, error: String(e?.message || e) };
  }
}
