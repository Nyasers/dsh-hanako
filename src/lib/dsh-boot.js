// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/dsh-boot.js — DSH profile 在受管 runtime 进程内的 boot 链（去宿主化）
//
// 从 v1 的 src/lib/lifecycle.js 剥离并去宿主化：v1 形态是「宿主插件进程内 runProfile」
// （宿主 node 无 permission model，dsh 与宿主同进程）；v2 形态（spec D1/C3）是
// 「受管 native runtime 进程内 runProfile」——本模块只被 src/runtime/dsh-host.mjs 使用，
// **不 import 任何宿主 ctx/单例**（App 进程内跑 runProfile 会撞 --allow-addons 墙）。
//
// 与 v1 逐字迁移的部分：
//   loadInprocDsh    dsh 包定位（枚举 lib/profile-boot-*.js 试出 runProfile 导出）+
//                    app-boot 定位（createRequire 从 dsh 包视角 → .pnpm 枚举兜底）
//   setDshEnv        DSH_HOME / DSHANA_ROOT / DSHANA_HOME（+ DSHANA_BUS_SECRET 兼容）
//   seedDshanaProfile dshana profile 种子化（官方 initProfile + @dsh-hanako scope 链接）
//   bootProfile      loadLayeredEnv → runProfile({ profile, args: ["--port", P, "--no-open"] })
//   waitListening    端口真实监听后才允许打印 readyMarker（宿主 service 代理契约）
//
// v2 改动点（相对 v1）：
//   ① 依赖根 = dataDir/runtime（depsRoot），不再是插件根 node_modules（C1：installDir 只读）；
//   ② 端口显式传入（service 契约禁止「端口 0 → 随机分配 → 回读」；占用即显式失败）；
//   ③ 就绪判定用 TCP connect（服务真实监听），不依赖 DSH HTTP API 形态；
//   ④ 不再挂 ACP/总线/宿主 deferred——App↔DSH 业务通道属第 3 步 task-bridge。

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { ensureProfileSeeded, PROFILE_BUNDLES, PROFILE_PATCH_RELOAD } from "./profile-seed.js";

/** 退出码约定（App 侧按码决定是否换端口重试）。 */
export const EXIT_PORT_IN_USE = 12;
export const EXIT_DEPS_MISSING = 13;
export const EXIT_BOOT_FAILED = 14;

/**
 * dsh 包定位（depsRoot = dataDir/runtime）。
 * profile-boot-*.js 是带构建 hash 的产物名（bin.js 按 hash 动态 import），不能硬编码——
 * 枚举 lib 目录试出导出 runProfile 的候选；app-boot 经 createRequire 从 dsh 包视角解析
 * （pnpm 严格结构下 @deepseek-ai/dsh-app-boot 是 dsh 的间接依赖，不在顶层 node_modules），
 * 失败回退 .pnpm 虚拟存储枚举。
 * 返回 { profileBoot, bootEntry, appBoot, appBootEntry }。
 */
export async function loadInprocDsh(depsRoot) {
  const dshPkg = join(depsRoot, "node_modules", "@deepseek-ai", "dsh");
  const libDir = join(dshPkg, "lib");
  if (!existsSync(join(dshPkg, "package.json"))) {
    const err = new Error(
      "DSH 包未就绪：" + dshPkg + " 不存在（依赖区 " + depsRoot + "；安装链会按声明补齐）",
    );
    err.code = "DSH_DEPS_MISSING";
    throw err;
  }
  let profileBoot = null;
  let bootEntry = null;
  let tried = 0;
  try {
    for (const f of readdirSync(libDir)) {
      if (!f.startsWith("profile-boot-") || !f.endsWith(".js")) continue;
      const abs = join(libDir, f);
      tried += 1;
      try {
        const m = await import(/* webpackIgnore: true */ pathToFileURL(abs).href);
        if (typeof m.runProfile === "function") {
          profileBoot = m;
          bootEntry = abs;
          break;
        }
      } catch {
        /* 单个候选加载失败：继续试下一个（dsh 版本演进产物名变化） */
      }
    }
  } catch (e) {
    throw new Error("无法枚举 dsh profile-boot 模块（" + libDir + "）：" + (e?.message || e));
  }
  if (!profileBoot) {
    throw new Error("dsh 包无可用 profile-boot 模块（lib 下已检查 " + tried + " 个 profile-boot-*.js）");
  }
  let appBootEntry = null;
  try {
    const dshRequire = createRequire(join(dshPkg, "package.json"));
    appBootEntry = dshRequire.resolve("@deepseek-ai/dsh-app-boot");
  } catch {
    appBootEntry = null;
  }
  if (appBootEntry === null) {
    const pnpmDir = join(depsRoot, "node_modules", ".pnpm");
    try {
      for (const d of readdirSync(pnpmDir)) {
        if (!d.startsWith("@deepseek-ai+dsh-app-boot@")) continue;
        const candidate = join(pnpmDir, d, "node_modules", "@deepseek-ai", "dsh-app-boot", "lib", "index.js");
        if (existsSync(candidate)) {
          appBootEntry = candidate;
          break;
        }
      }
    } catch {
      /* 枚举失败（.pnpm 不存在等）：保持 null */
    }
  }
  if (appBootEntry === null) {
    throw new Error("无法解析 @deepseek-ai/dsh-app-boot（dsh 依赖缺失？createRequire 与 .pnpm 枚举均未命中）");
  }
  const appBoot = await import(/* webpackIgnore: true */ pathToFileURL(appBootEntry).href);
  if (typeof appBoot.loadLayeredEnv !== "function") {
    throw new Error("@deepseek-ai/dsh-app-boot 缺 loadLayeredEnv 导出（" + appBootEntry + "）");
  }
  return { profileBoot, bootEntry, appBoot, appBootEntry };
}

const ENV_KEYS = ["DSH_HOME", "DSHANA_ROOT", "DSHANA_HOME", "DSHANA_BUS_SECRET"];
let envSnapshot = null;

/**
 * 进程级 env 设置（dsh 官方契约读 DSH_HOME；DSHANA_ROOT = 依赖根，DSHANA_HOME = dataDir）。
 * 只在 runtime 进程内改写（不碰宿主进程环境——spec §4）；restoreDshEnv 还原。
 */
export function setDshEnv({ dshHome, dataDir, depsRoot }) {
  envSnapshot = {};
  for (const k of ENV_KEYS) envSnapshot[k] = process.env[k];
  process.env.DSH_HOME = dshHome;
  process.env.DSHANA_ROOT = depsRoot;
  process.env.DSHANA_HOME = dataDir;
  process.env.DSHANA_BUS_SECRET = randomUUID();
  return { dshHome, dataDir, depsRoot };
}

export function restoreDshEnv() {
  if (!envSnapshot) return;
  const prev = envSnapshot;
  envSnapshot = null;
  for (const k of ENV_KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
}

/**
 * dshana profile 种子化（官方 initProfile + @dsh-hanako scope 链接）。
 * scopeSrc = installDir/cordis（只读可读，scope 树形态）；profileDir = $DSH_HOME/profiles/dshana。
 * 幂等（见 profile-seed.js）；失败只记日志，由 dsh 侧报错引导。
 */
export function seedDshanaProfile({ profileDir, installDir, appBoot, log }) {
  const scopeSrc = join(installDir, "cordis");
  if (typeof appBoot?.initProfile !== "function") {
    log("[cordis] dsh app-boot 无 initProfile（版本过旧？），profile 种子化跳过（由诊断引导）");
    return "no-init-profile";
  }
  try {
    const outcome = ensureProfileSeeded({
      profileDir,
      scopeSrc,
      initProfile: appBoot.initProfile,
      log: (m) => log(m),
    });
    log("[cordis] profile 初始化结果：" + outcome);
    return outcome;
  } catch (e) {
    log("[cordis] profile 初始化异常：" + (e?.message || e) + "（dsh loadProfile 会再报）");
    return "error";
  }
}

/** TCP 探测端口是否已监听（就绪判定的唯一硬证据）。 */
export function probeListening(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        sock?.destroy();
      } catch {
        /* 已关闭 */
      }
      resolve(ok);
    };
    const sock = connect({ host: "127.0.0.1", port });
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => finish(true));
    sock.once("timeout", () => finish(false));
    sock.once("error", () => finish(false));
  });
}

async function waitListening(port, { timeoutMs, isBootError, log }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const err = isBootError();
    if (err) throw err;
    if (await probeListening(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** 从 cordis ctx 读回 webServer 实际端口（应与请求端口一致；不一致按异常报告）。 */
export function readWebServerPort(ctx) {
  try {
    if (!ctx) return 0;
    const svc = typeof ctx.get === "function" ? ctx.get("webServer") : ctx.webServer;
    if (!svc) return 0;
    if (typeof svc.port === "number" && svc.port > 0) return svc.port;
    const srv = svc._server || (svc.server && svc.server._server);
    if (srv && typeof srv.address === "function") {
      const a = srv.address();
      if (a && typeof a === "object" && a.port) return a.port;
    }
  } catch {
    /* 读端口失败走 0 */
  }
  return 0;
}

/**
 * 在受管 runtime 进程内 boot DSH profile（显式端口）。
 * opts: { depsRoot, installDir, profileName, port, dshHome, dataDir, log, readyTimeoutMs }
 * 返回 { ctx, shutdown, port, dispose }；失败抛错（端口占用错误 code = "EADDRINUSE"）。
 */
export async function bootProfile(opts) {
  const {
    depsRoot,
    installDir,
    profileName,
    port,
    dshHome,
    dataDir,
    log = () => {},
    readyTimeoutMs = 90000,
  } = opts;
  const { profileBoot, bootEntry, appBoot, appBootEntry } = await loadInprocDsh(depsRoot);
  log("[dsh] 依赖解析完成（profile-boot=" + bootEntry + "，app-boot=" + appBootEntry + "）");
  setDshEnv({ dshHome, dataDir, depsRoot });
  seedDshanaProfile({
    profileDir: join(dshHome, "profiles", profileName),
    installDir,
    appBoot,
    log,
  });
  const environment = appBoot.loadLayeredEnv("dsh");
  let bootError = null;
  log('[dsh] runProfile({ profile: "' + profileName + '", port: ' + port + " }) …");
  let r;
  try {
    r = await profileBoot.runProfile({
      environment,
      profile: profileName,
      patchFiles: [],
      args: ["--port", String(port), "--no-open"],
    });
  } catch (e) {
    restoreDshEnv();
    const msg = String(e?.message || e);
    if (/EADDRINUSE|address already in use/i.test(msg)) {
      const err = new Error("端口 " + port + " 已被占用：" + msg);
      err.code = "EADDRINUSE";
      throw err;
    }
    const err = new Error("DSH runProfile 失败：" + msg);
    err.code = "DSH_BOOT_FAILED";
    throw err;
  }
  const handle = {
    ctx: r.ctx,
    shutdown: r.shutdown,
    port,
    async dispose() {
      try {
        await handle.ctx?.fiber?.dispose();
      } catch (e) {
        log("[dsh] dispose 异常：" + (e?.message || e));
      }
      restoreDshEnv();
    },
  };
  // runProfile 返回后服务可能尚未监听（bind 是异步的）——TCP 探测到真实监听才算就绪。
  const ok = await waitListening(port, {
    timeoutMs: readyTimeoutMs,
    isBootError: () => bootError,
    log,
  });
  if (!ok) {
    await handle.dispose();
    const err = new Error(
      "DSH web 服务在 " + Math.round(readyTimeoutMs / 1000) + "s 内未在 127.0.0.1:" + port + " 监听",
    );
    err.code = "DSH_READY_TIMEOUT";
    throw err;
  }
  const actual = readWebServerPort(r.ctx);
  if (actual && actual !== port) {
    log("[dsh] 警告：webServer 实际端口 " + actual + " ≠ 请求端口 " + port + "（service 代理按请求端口注册）");
  }
  log("[dsh] 服务就绪（127.0.0.1:" + port + "，profile=" + profileName + "）");
  return handle;
}

export { PROFILE_BUNDLES, PROFILE_PATCH_RELOAD };
