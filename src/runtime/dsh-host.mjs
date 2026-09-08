// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/dsh-host.mjs — 受管 native runtime 入口（DSH 运行时承载形态，spec D1）
//
// 谁拉起它：App 主入口 apply(ctx) 侧 src/lib/runtime-host.js 经
//   ctx.runtime.start({
//     runtime: "node",
//     entry: "runtime/dsh-host.mjs",
//     profile: "native",
//     network: "external",
//     taskId,
//     cwd: <App dataDir>,
//     args: ["--port", P, "--dsh-home", …, "--deps-root", …, "--install-dir", …],
//     service: { port: P, readyMarker: "DSH_READY" },
//   })
// 拉起（全平台统一，含 Windows：0.930.1 native + enforcement partial 放行，gap audit §1.1）。
//
// 它在受管 runtime 进程内做什么（顺序即依赖）：
//   ① 解析自有参数（--port / --hana-task-id / --dsh-home / --deps-root / --install-dir /
//      --profile / --app-id；这些是 DSHana 自有参数，Hana 与 DSH 都不认识它们）；
//   ② 三件套固定覆盖（installDir/runtime/ → dataDir/runtime/，随包版本）+ 依赖首启安装
//      （single-flight；载体 @pnpm/napi 进程内调用，无子进程——C4/D2）；
//   ③ connectAppRuntime()：连宿主私有 IPC（tasks/models/network.fetch），绑定本 App；
//   ④ runProfile(dshana profile) 在显式端口 boot，服务真实监听后打印精确行 DSH_READY
//      （宿主据此把 service 代理置 ready；禁止虚假 READY——端口占用显式失败）；
//   ⑤ 常驻：收到 SIGTERM/SIGINT 或父进程 IPC 断开 → dispose cordis 树 + close IPC + 退出。
//
// 为什么必须有这个文件（C1/C3/C5）：installDir 只读、App 进程内 native addon 被
// --allow-addons 挡住；DSH 的 node-pty/koffi/sharp 与依赖安装只能跑在受管 native
// runtime 内（探针实证 conpty.node / koffi.node loaded:true）。
//
// 本文件被 rspack 打包为 dist/runtime/dsh-host.mjs（多入口，见 src/rspack.config.mjs），
// 与 App 主 bundle 各自内联依赖，互不共享 chunk。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  makeLogger,
  runtimePaths,
  readRuntimeDeclaration,
  syncRuntimeDeclaration,
  readInstallState,
  writeInstallState,
  installStateMatches,
  inspectInstalledDeps,
  readInstalledDshVersion,
  READY_MARKER,
  PNPM_VERSION,
  PROFILE_NAME,
} from "../lib/runtime-layout.js";
import { installRuntimeDeps } from "../lib/pnpm-carrier.js";
import { bootProfile, EXIT_PORT_IN_USE, EXIT_DEPS_MISSING, EXIT_BOOT_FAILED } from "../lib/dsh-boot.js";
import { connectAppRuntime } from "../lib/app-runtime-ipc.js";

// ---- 自有参数解析（极简 --key value 形态；未知参数忽略并记录）----
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

const argv = parseArgs(process.argv.slice(2));
const ENTRY_FILE = fileURLToPath(import.meta.url);
// dist/runtime/dsh-host.mjs → dist/（App 安装目录；只读）
const installDir = typeof argv["install-dir"] === "string" ? argv["install-dir"] : dirname(dirname(ENTRY_FILE));
const dataDir = typeof argv["data-dir"] === "string" ? argv["data-dir"] : dirname(installDir);
const depsRoot = typeof argv["deps-root"] === "string" ? argv["deps-root"] : join(dataDir, "runtime");
const dshHome = typeof argv["dsh-home"] === "string" ? argv["dsh-home"] : join(dataDir, "dsh-home");
const profileName = typeof argv.profile === "string" && argv.profile ? argv.profile : PROFILE_NAME;
const port = Number(argv.port);
const taskId = typeof argv["hana-task-id"] === "string" ? argv["hana-task-id"] : "";
const appId = typeof argv["app-id"] === "string" ? argv["app-id"] : "dsh-hanako";

const paths = runtimePaths(dataDir);
const log = makeLogger({ dataDir, tag: "dsh-runtime" });
const milestone = (m) => log.info(m);

milestone(
  "启动：pid=" + process.pid + " node=" + process.version + " platform=" + process.platform + "-" + process.arch,
);
milestone(
  "参数：port=" + port + " profile=" + profileName + " taskId=" + (taskId || "(无)") + " appId=" + appId,
);
milestone("路径：installDir=" + installDir + " dataDir=" + dataDir + " depsRoot=" + depsRoot + " dshHome=" + dshHome);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  milestone("致命：--port 非法（" + argv.port + "）；service 契约要求 1024..65535 的显式端口");
  process.exit(EXIT_BOOT_FAILED);
}

// ---- 状态文件（诊断用：pid/端口/taskId/IPC 来源/依赖版本；App 侧与人工排查都读它）----
function writeStatus(patch) {
  try {
    mkdirSync(paths.root, { recursive: true });
    const prev = (() => {
      try {
        return JSON.parse(readFileSync(join(paths.root, "dsh-host.json"), "utf8"));
      } catch {
        return {};
      }
    })();
    const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    // 健康态清掉上一轮的失败残留（状态文件是诊断事实源，不能让旧 error/exitCode 遮蔽当前就绪）
    if (patch.state === "starting" || patch.state === "ready") {
      delete next.error;
      delete next.exitCode;
    }
    writeFileSync(join(paths.root, "dsh-host.json"), JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch (e) {
    log.warn("状态文件写入失败：" + (e?.message || e));
  }
}

writeStatus({
  pid: process.pid,
  port,
  taskId,
  appId,
  profile: profileName,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  state: "starting",
  startedAt: new Date().toISOString(),
});

// ---- ② 三件套覆盖 + 依赖首启安装（single-flight：本进程只跑一次）----
let depsPromise = null;
async function ensureDeps() {
  if (depsPromise) return depsPromise;
  depsPromise = (async () => {
    const sync = syncRuntimeDeclaration(installDir, paths.root, milestone);
    if (!sync.ok) {
      const err = new Error(sync.error || "运行时声明缺失");
      err.code = "DSH_DEPS_MISSING";
      throw err;
    }
    const declaration = sync.declaration;
    const state = readInstallState(paths.root);
    const inspected = inspectInstalledDeps(paths.root, declaration);
    if (inspected.ok) {
      milestone(
        "依赖已就位（dsh@" + inspected.installed + "，pnpm 载体 " + PNPM_VERSION + "，声明一致）——跳过安装",
      );
      return { declaration, installed: inspected.installed, skipped: true };
    }
    milestone(
      "依赖需要安装（installed=" +
        (inspected.installed || "无") +
        " declared=" +
        (inspected.declared || "无") +
        " carrierOk=" +
        inspected.carrierOk +
        " stateMatch=" +
        installStateMatches(state, declaration) +
        "）",
    );
    // 随包锁文件存在 → frozen-lockfile 语义（可复现，spec D2「pnpm 随发版」）；锁与声明不符时
    // 引擎报 ERR_PNPM_OUTDATED_LOCKFILE——那是发版失误（两者同批构建），必须显式失败而非静默重解析。
    // 无锁（开发态/未生成）→ 正常解析并写出 runtime/pnpm-lock.yaml。
    const frozenLockfile = !!declaration.lockfile;
    const r = await installRuntimeDeps({
      paths,
      declaration,
      frozenLockfile,
      log: milestone,
      onOutput: () => {},
    });
    if (!r.ok) {
      const err = new Error(
        "依赖安装失败" + (r.stage ? "（阶段 " + r.stage + "）" : "") + "：" + (r.error || "未知错误") + (r.hint ? "（" + r.hint + "）" : ""),
      );
      err.code = "DSH_DEPS_INSTALL_FAILED";
      throw err;
    }
    const installed = readInstalledDshVersion(paths.root);
    writeInstallState(paths.root, {
      declaration: {
        dsh: declaration.dshVersion,
        cordis: declaration.cordisVersion,
        pnpm: PNPM_VERSION,
        lockfile: declaration.lockfile
          ? createHash("sha256").update(declaration.lockfile).digest("hex")
          : null,
      },
      installed,
      nodeVersion: process.version,
      storeDir: paths.storeDir,
      carrier: r.carrier ? { version: r.carrier.version, triple: r.carrier.triple } : null,
      stats: r.result?.stats || null,
      installedAt: new Date().toISOString(),
    });
    milestone("依赖安装完成：dsh@" + (installed || "?") + "（storeDir=" + paths.storeDir + "）");
    return { declaration, installed, skipped: false };
  })().finally(() => {
    depsPromise = null;
  });
  return depsPromise;
}

// ---- ③ 宿主私有 IPC（connectAppRuntime）----
let hana = null;
async function connectHost() {
  try {
    const { client, source } = await connectAppRuntime({
      depsRoot,
      log: (level, msg) => (level >= 2 ? log.warn(msg) : milestone(msg)),
    });
    hana = client;
    milestone("宿主 IPC 已连接（connectAppRuntime source=" + source + "，taskId=" + (taskId || "(无)") + "）");
    // 能力探针（不阻断 boot）：models.list 需要 app/models.infer 授权；未授权时宿主如实拒绝，
    // 第 3 步 provider adapter 走 ctx.models 时再处理（本步只证明通道可用）。
    try {
      const catalog = await hana.models.list();
      const n = Array.isArray(catalog?.models)
        ? catalog.models.length
        : catalog && typeof catalog === "object"
          ? Object.keys(catalog).length
          : null;
      milestone("宿主 models 目录可用（条目=" + n + "）");
    } catch (e) {
      log.warn("宿主 models.list 未通过（多为能力未授权，第 3 步接线时授予 app/models.infer）：" + (e?.code ? e.code + ": " : "") + (e?.message || e));
    }
    writeStatus({ ipcSource: source });
    return client;
  } catch (e) {
    log.warn("宿主 IPC 连接失败（DSH 侧工具/模型桥不可用，boot 继续）：" + (e?.code ? e.code + ": " : "") + (e?.message || e));
    return null;
  }
}

// ---- ⑤ 生命周期：优雅退出（宿主 stop(runtimeId) → SIGTERM；或父进程 IPC 断开）----
let handle = null;
let exiting = false;
async function shutdown(reason, code = 0) {
  if (exiting) return;
  exiting = true;
  milestone("退出：" + reason);
  writeStatus({ state: "stopping", stopReason: reason });
  try {
    if (handle) await handle.dispose();
  } catch (e) {
    log.warn("dispose 异常：" + (e?.message || e));
  }
  try {
    hana?.close();
  } catch (e) {
    log.warn("IPC close 异常：" + (e?.message || e));
  }
  writeStatus({ state: "stopped", stoppedAt: new Date().toISOString() });
  process.exit(code);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("disconnect", () => shutdown("宿主 IPC 断开（父进程已退出）"));
process.on("uncaughtException", (e) => {
  log.error("未捕获异常：" + (e?.stack || e?.message || e));
  shutdown("uncaughtException", EXIT_BOOT_FAILED);
});
process.on("unhandledRejection", (e) => {
  log.error("未处理的 Promise 拒绝：" + (e?.stack || e?.message || e));
});

// ---- 主流程 ----
try {
  const deps = await ensureDeps();
  writeStatus({ deps: { dsh: deps.installed, pnpm: PNPM_VERSION, skipped: !!deps.skipped } });
  await connectHost();
  handle = await bootProfile({
    depsRoot,
    installDir,
    profileName,
    port,
    dshHome,
    dataDir,
    log: milestone,
  });
  writeStatus({ state: "ready", readyAt: new Date().toISOString() });
  // 精确行：宿主 service 代理据此把 { port, state: "pending" } 置为 ready
  process.stdout.write(READY_MARKER + "\n");
  milestone("已输出就绪标记 " + READY_MARKER + "（service 代理应转为 ready）");
} catch (e) {
  const code =
    e?.code === "EADDRINUSE"
      ? EXIT_PORT_IN_USE
      : e?.code === "DSH_DEPS_MISSING" || e?.code === "DSH_DEPS_INSTALL_FAILED"
        ? EXIT_DEPS_MISSING
        : EXIT_BOOT_FAILED;
  log.error("启动失败（code=" + (e?.code || "?") + "，exit=" + code + "）：" + (e?.stack || e?.message || e));
  writeStatus({ state: "failed", error: String(e?.message || e), exitCode: code });
  try {
    hana?.close();
  } catch {
    /* 已关闭 */
  }
  process.exit(code);
}

// 常驻：受管 runtime 进程存活期间保持事件循环（cordis 树自带 server/定时器）。
// 这里不做任何轮询——只在 IPC 断开/SIGTERM 时退出（见上方 handler）。
