// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/bootstrap.js — 依赖声明/就位核对（v2：App 侧只读核对，安装移入受管 runtime）
//
// v1 形态（本文件历史）：App/宿主进程内 pnpm install --prod 到插件根 node_modules，
// 并在本文件里维护 installDepsFromPlugin（长任务 + 日志通道 + 错误分类）。
// v2 形态（spec C1/C4/D2）：
//   · installDir 只读 → 依赖实体落 dataDir/runtime（唯一可写区）；
//   · 安装在受管 native runtime 内执行（runtime/dsh-host.mjs 首启 single-flight，
//     载体 @pnpm/napi 进程内调用）——App 进程不再 spawn、不再有 processSpawn；
//   · 本文件只保留「读声明 + 静态核对 + 版本比较」三件事，供诊断/路由/工具使用。
//
// 声明位置：installDir/runtime/package.json（随包三件套之一）。App 侧经自身模块 URL
// 求 installDir（dist/index.js → dist/）；读不到时回退受管 runtime 写下的安装态标记
// （dataDir/runtime/.dsh-install.json，含声明版本）——两条路都能给诊断一个确定答案。

import { statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getSingleton } from "./state.js";
import {
  runtimePaths,
  readRuntimeDeclaration,
  readInstallState,
  readInstalledDshVersion,
  inspectInstalledDeps,
  PNPM_VERSION,
  DSH_PACKAGE,
  CORDIS_PACKAGE,
} from "./runtime-layout.js";
// 说明：verifyDepsSmoke 用完整声明（含锁文件/白名单哈希）核对安装态，与受管 runtime 写下的
// .dsh-install.json 同源；App 目录形态异常时回退安装态记录并放宽匹配（见函数内注释）。

// ---- App 安装目录（dist/）：入口 bundle 自身 URL 的所在目录 ----
// rspack 会把源码里的 import.meta.url 静态化为构建机路径，构建链 scripts/build-common.mjs
// 的 makeUrlRewriter 再把它换回 import.meta.url——运行期即宿主实际加载的 dist/index.js。
export function appInstallDir() {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return "";
  }
}

/** dsh 依赖根（v2）= dataDir/runtime（installDir 只读，不可作为安装位）。 */
export function resolveDshPkgDir(cfg) {
  const dataDir =
    (cfg && typeof cfg.dataDir === "string" && cfg.dataDir) ||
    getSingleton().dataDir ||
    "";
  return dataDir ? runtimePaths(dataDir).root : "";
}

/**
 * 运行时声明（三件套之一）读取：installDir/runtime/package.json 优先；
 * 读不到（App 目录形态异常）回退安装态标记里记录的声明版本。
 * 返回 { dsh, cordis, manifest, source }。
 */
export function readDeclaredDeps() {
  const installDir = appInstallDir();
  if (installDir) {
    const d = readRuntimeDeclaration(installDir);
    if (d.manifest) {
      return { dsh: d.dshVersion, cordis: d.cordisVersion, manifest: d.manifest, source: "installDir" };
    }
  }
  const dataDir = getSingleton().dataDir;
  if (dataDir) {
    const state = readInstallState(runtimePaths(dataDir).root);
    if (state?.declaration) {
      return {
        dsh: state.declaration.dsh || null,
        cordis: state.declaration.cordis || null,
        manifest: null,
        source: "install-state",
      };
    }
  }
  return { dsh: null, cordis: null, manifest: null, source: "missing" };
}

/** 声明版本号（合法 semver/dist-tag 才返回；否则 null）。 */
export function readDeclaredDshVersion() {
  const v = readDeclaredDeps().dsh;
  return v && isValidPkgSpec(v) ? v : null;
}

// ---- 零依赖 semver 比较（major.minor.patch + SemVer §11.4 预发布比较）----
export function parseSemver(v) {
  const s = String(v || "").trim();
  const m = s.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split(".") : null };
}

function comparePreIdentifiers(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) {
    const na = Number(a);
    const nb = Number(b);
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  const len = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i += 1) {
    const c = comparePreIdentifiers(pa.pre[i], pb.pre[i]);
    if (c !== 0) return c;
  }
  if (pa.pre.length !== pb.pre.length) return pa.pre.length < pb.pre.length ? -1 : 1;
  return 0;
}

/** 已装 dsh 版本（dataDir/runtime/node_modules/@deepseek-ai/dsh/package.json）。 */
export function readDshInstalledVersion(cfg) {
  const root = resolveDshPkgDir(cfg);
  return root ? readInstalledDshVersion(root) : null;
}

function notifyDepsChanged() {
  const g = getSingleton();
  if (g && typeof g.notifyDepsChanged === "function") {
    try {
      g.notifyDepsChanged();
    } catch {
      /* 通知失败不阻断 */
    }
  }
}

/**
 * 依赖就位静态核对（无 spawn、无网络）：
 *   cliBin 为常规文件 + 磁盘版本 === 声明版本 + pnpm 载体标记存在 + 安装态标记与声明一致。
 * 结果写 g.deps.result（{ ok, version, error, at, running, pnpmReady, pnpmVersion, pnpmError }）
 * 与 g.deps.status（ok/error）。运行级裁决由受管 runtime 的 boot 承担（进程内同路）。
 */
export async function verifyDepsSmoke(cfg, opts = {}) {
  const g = getSingleton();
  if (!opts.force && g.deps.status === "running") return g.deps.result;
  if (!opts.force && g.deps.status === "installing") {
    return g.deps.result ?? { ok: false, running: true, error: "依赖安装进行中，验证稍后自动执行" };
  }
  const dataDir = cfg?.dataDir || g.dataDir || "";
  const root = dataDir ? runtimePaths(dataDir).root : "";
  const smoke = {
    ok: false,
    version: null,
    error: "",
    stderr: "",
    at: "",
    running: true,
    pnpmReady: false,
    pnpmVersion: PNPM_VERSION,
    pnpmError: "",
    installDir: appInstallDir(),
    depsRoot: root,
  };
  g.deps.result = smoke;
  g.deps.status = "running";
  notifyDepsChanged();
  const slog = (s) => {
    if (typeof g.appendLog === "function") {
      try {
        g.appendLog("hana", "[依赖验证] " + s);
      } catch {
        /* 日志失败不阻断 */
      }
    }
  };
  try {
    if (!root) throw new Error("dataDir 缺失：无法定位依赖区（dataDir/runtime）");
    // 完整声明（含锁文件与 allowBuilds 白名单哈希）优先；App 目录形态异常时回退安装态里
    // 记录的声明版本，并放宽安装态匹配（requireState=false）——核对仍以「存在 + 版本一致」为准。
    const installDir = appInstallDir();
    const full = installDir ? readRuntimeDeclaration(installDir) : null;
    const fallback = readDeclaredDeps();
    const declared = (full && full.dshVersion) || fallback.dsh;
    if (!declared) throw new Error("运行时声明缺失：installDir/runtime/package.json 未随包");
    const declaration = full && full.manifest
      ? full
      : { dshVersion: declared, cordisVersion: fallback.cordis, manifest: null, workspace: null, lockfile: null };
    const inspected = inspectInstalledDeps(root, declaration, { requireState: !!declaration.manifest });
    smoke.pnpmReady = inspected.carrierOk;
    smoke.pnpmError = inspected.carrierOk ? "" : "pnpm 载体未就位（runtime/pnpm/.pnpm-ok 缺失）";
    if (!inspected.cli || !statSyncSafeIsFile(inspected.cli)) {
      throw new Error("dsh cliBin 不存在或非文件：" + inspected.cli);
    }
    if (!inspected.installed) throw new Error("dsh 包版本读取失败：" + inspected.cli);
    const declaredIsSemver = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(declared);
    if (declaredIsSemver && inspected.installed !== declared) {
      smoke.error = "磁盘 dsh@" + inspected.installed + " ≠ 声明 " + declared + "（需重新安装依赖）";
      slog("不一致（磁盘 " + inspected.installed + " ≠ 声明 " + declared + "）");
    } else {
      smoke.ok = true;
      smoke.version = inspected.installed;
      slog("通过（version=" + inspected.installed + "，声明来源 " + declaration.source + "）");
    }
  } catch (e) {
    smoke.ok = false;
    smoke.error = String(e?.message || e).slice(0, 400);
    slog("异常：" + String(smoke.error).slice(0, 200));
  } finally {
    smoke.at = new Date().toISOString();
    smoke.running = false;
    g.deps.status = smoke.ok ? "ok" : "error";
    g.deps.error = smoke.ok ? "" : smoke.error;
    notifyDepsChanged();
  }
  return smoke;
}

function statSyncSafeIsFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** spec 注入面校验（保留 v1 语义：拒绝 npm:/github:/file: 等非预期安装目标）。 */
export function isValidPkgSpec(spec) {
  const s = String(spec || "").trim();
  if (!s) return false;
  if (isValidSemverSpec(s)) return true;
  if (!/[a-zA-Z]/.test(s)) return false;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s)) return false;
  return !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(s);
}

const SEMVER_STRICT_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isValidSemverSpec(s) {
  const m = String(s).match(SEMVER_STRICT_RE);
  if (!m) return false;
  const pre = m[4];
  if (!pre) return true;
  for (const id of pre.split(".")) {
    if (/^\d+$/.test(id)) {
      if (id.length > 1 && id[0] === "0") return false;
    } else if (!/[A-Za-z-]/.test(id)) {
      return false;
    }
  }
  return true;
}

export { DSH_PACKAGE, CORDIS_PACKAGE, PNPM_VERSION };
