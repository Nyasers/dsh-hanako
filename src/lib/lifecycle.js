// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/lifecycle.js — App 侧 DSH 生命周期（v2：受管 runtime 形态）
//
// 与 v1 的差别（一句话）：v1 在本文件里「进程内 runProfile boot dsh web host + 随机端口 +
// 总线/provider 推送」；v2 全部搬进受管 native runtime（runtime/dsh-host.mjs），本文件只剩
// App 侧薄控制面——拉起/复用/停止受管 runtime、把 service 端口交给指令链、静态核对依赖。
//
// 迁移映射（spec「迁移点映射」表）：
//   ensureWebHost/bootInproc（宿主进程内 boot）→ ctx.runtime.start（runtime-host.js）
//   g.dataDir 单例                              → ctx.dataDir（本文件经单例持有 ctx 引用）
//   宿主 provider 文件直读 + 资源 watch 推送     → 第 3 步 ctx.models（本文件已删除该链）
//   dshana profile 种子化                       → runtime 进程内（lib/dsh-boot.js）
//
// 保留的对外形状（调用方不感知迁移）：
//   ensureWebHost(cfg)  → 兼容名，返回 { port, ready, runtimeId, processMode }（run.js 的
//                         HTTP 指令链按 web.port 使用；第 3 步换 ctx.tasks/ACP 后退役）
//   closeProcess()      → 停止本 App 的受管 runtime（幂等）
//   g.verifyDeps / g.installDeps / g.closeProcess 单例挂载（routes/webui.js 等经单例读取）

import { getSingleton } from "./state.js";
import { runtimePaths, dshHomeOf } from "./runtime-layout.js";
import { verifyDepsSmoke } from "./bootstrap.js";
import { ensureDshRuntime, stopDshRuntime, readDshRuntimeState } from "./runtime-host.js";

const STDERR_CAP = 4096;

/**
 * App ctx 绑定（apply() 内调用一次）：v2 受管 runtime 的一切能力都挂在 ctx 上，
 * 而 v1 调用点（run.js/protocol.js/webui 路由）只拿得到 cfg——经单例转发。
 * 只存引用，不改 ctx 内容。
 */
export function bindAppContext(ctx) {
  const g = getSingleton();
  g.ctx = ctx || null;
  if (typeof ctx?.dataDir === "string") g.dataDir = ctx.dataDir;
  return g;
}

function requireCtx() {
  const g = getSingleton();
  const ctx = g.ctx;
  if (!ctx || typeof ctx.runtime?.start !== "function") {
    throw new Error(
      "DSH 运行时未接线：App 未完成 apply(ctx) 绑定或宿主版本 < 0.930.1（ctx.runtime 为 v2 契约）",
    );
  }
  return ctx;
}

/**
 * 兼容入口（v1 名）：确保受管 DSH runtime 已就绪，返回可用端口。
 * cfg: { dataDir?, taskId?, cwd?, ... }（v1 的 dshPkgDir/webPort 已无意义，忽略）。
 */
export async function ensureWebHost(cfg = {}) {
  const ctx = requireCtx();
  const g = getSingleton();
  if (cfg.dataDir && !g.dataDir) g.dataDir = cfg.dataDir;
  try {
    const r = await ensureDshRuntime(ctx, { taskId: cfg.taskId, cwd: cfg.cwd });
    return {
      processMode: "managed-runtime",
      ready: true,
      port: r.port,
      runtimeId: r.runtimeId,
      dshHome: dshHomeOf(ctx.dataDir),
      logPath: joinLog(ctx),
      reused: r.reused,
    };
  } catch (e) {
    // 失败原因供诊断（webui boot-state 读 g.webLastError）
    g.webLastError = String(e?.message || e).slice(0, 1500);
    g.webLastErrorAt = new Date().toISOString();
    throw e;
  }
}

function joinLog(ctx) {
  try {
    return runtimePaths(ctx.dataDir).logsDir + "/dsh-runtime.log";
  } catch {
    return null;
  }
}

/** 停止受管 runtime（幂等；App 卸载/重载时调用）。 */
export async function closeProcess() {
  const g = getSingleton();
  const ctx = g.ctx;
  g.web = null;
  if (!ctx) return { stopped: false };
  try {
    return await stopDshRuntime(ctx);
  } catch (e) {
    g.webLastError = String(e?.message || e).slice(0, STDERR_CAP);
    return { stopped: false, error: g.webLastError };
  }
}

/**
 * 「安装/修复依赖」入口（v1 g.installDeps 兼容名）：v2 下安装发生在 runtime 进程首启，
 * 本函数 = 停旧 runtime → 重新拉起（runtime 内 single-flight ensure 会按声明重装）。
 */
export async function requestDepsInstall(ctxConfig, ctxDataDir) {
  const ctx = requireCtx();
  if (ctxDataDir) getSingleton().dataDir = ctxDataDir;
  await stopDshRuntime(ctx);
  const r = await ensureDshRuntime(ctx, {});
  return { ok: true, state: "installed", port: r.port, runtimeId: r.runtimeId };
}

// ---- 单例挂载（routes/webui.js / tools 经 globalThis 单例读取）----
const g = getSingleton();
g.closeProcess = closeProcess;
g.installDeps = requestDepsInstall;
g.verifyDeps = verifyDepsSmoke;
g.ensureWebHost = ensureWebHost;
g.readDshRuntimeState = readDshRuntimeState;
