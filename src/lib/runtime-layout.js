// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/runtime-layout.js — 受管 runtime 依赖区布局（纯路径/纯声明，零 ctx 依赖）
//
// 职责（v2 迁移第 2 步 D2 定案，spec: specs/current/dshana-v2-runtime-inproc/spec.md）：
//   app-data/dsh-hanako/
//   ├── runtime/            ← 依赖实体区（唯一可写区的安装位；可再生工具链）
//   │   ├── package.json       三件套①：运行时声明（只含 @deepseek-ai/dsh + cordis）
//   │   ├── pnpm-workspace.yaml 三件套②：allowBuilds 白名单
//   │   ├── pnpm-lock.yaml      三件套③：锁文件（随包发版；缺失时首装生成）
//   │   ├── pnpm/             pnpm 12 载体（@pnpm/napi + 平台包，T1 定型）
//   │   ├── .dsh-install.json 安装态标记（声明版本 + pnpm 版本 + 锁定摘要）
//   │   └── node_modules/    安装产物（单实例）
//   ├── dsh-home/           ← 真用户数据（profiles/ sessions/ storages/ settings.yaml）
//   └── logs/               ← 运行日志
//
// 分层纪律：本模块只做「路径 + 声明文件读写 + 安装态标记」——不含 ctx、不含宿主单例、
// 不 spawn 子进程。App 进程（runtime-host.js）与受管 runtime 进程（dsh-host.mjs）共用，
// 因此两份 bundle 各自内联一份（rspack 多入口，同步模块不共享 chunk）。
//
// 三件套语义（用户定案 2026-09-08）：installDir 只读，三件套随包固定覆盖到 runtime/——
// 幂等判断 = 安装态标记记录「dsh/cordis 声明版本 + pnpm 版本 + 锁文件摘要」，任一变化即
// 覆盖三件套并重装；不留旧版本目录（固定路径覆盖，非版本目录）。

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  appendFileSync,
  statSync,
  renameSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";

/** 依赖实体区目录名（dataDir 下）。 */
export const RUNTIME_DIR_NAME = "runtime";
/** 受管 service 就绪标记（stdout 精确行；宿主据此把 service 代理置 ready）。 */
export const READY_MARKER = "DSH_READY";
/** pnpm 12 载体版本（T1 定型；升级 = 改此常量 + 发版）。 */
export const PNPM_VERSION = "12.3.4";
/** 载体形态：napi（受管 runtime 内进程内调用，无子进程）。 */
export const PNPM_CARRIER = "napi";
export const DSH_PACKAGE = "@deepseek-ai/dsh";
export const CORDIS_PACKAGE = "@deepseek-ai/cordis";
/** 三件套（installDir/runtime/ → dataDir/runtime/ 固定覆盖）。 */
export const DECLARATION_FILES = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"];
/** 安装态标记文件名（runtime/ 下）。 */
export const INSTALL_STATE_FILE = ".dsh-install.json";
/** 默认 profile 名（用户定案：恒为 dshana，不暴露设置项）。 */
export const PROFILE_NAME = "dshana";

/** dataDir 下的全部关键路径（一次算齐，调用方不再各自拼路径）。 */
export function runtimePaths(dataDir) {
  const root = join(dataDir, RUNTIME_DIR_NAME);
  return {
    dataDir,
    root,
    nodeModules: join(root, "node_modules"),
    pnpmDir: join(root, "pnpm"),
    pnpmMarker: join(root, "pnpm", ".pnpm-ok"),
    // pnpm store 必须落在可写区（T1 实证：受管 runtime 的 writeRoots = dataDir + 授权工作区，
    // 全局 store E:\.pnpm-store 在受管 runtime 内写入被拒 —— ERR GenericFailure os error 5）
    storeDir: join(root, ".pnpm-store"),
    declaration: join(root, "package.json"),
    workspace: join(root, "pnpm-workspace.yaml"),
    lockfile: join(root, "pnpm-lock.yaml"),
    installState: join(root, INSTALL_STATE_FILE),
    dshHome: join(dataDir, "dsh-home"),
    logsDir: join(dataDir, "logs"),
    profileDir: join(dataDir, "dsh-home", "profiles", PROFILE_NAME),
    dshCli: join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    dshPackageJson: join(root, "node_modules", "@deepseek-ai", "dsh", "package.json"),
  };
}

/** dsh-home（DSH_HOME）——会话/profile/存储的唯一事实源。 */
export function dshHomeOf(dataDir) {
  return join(dataDir, "dsh-home");
}

/** 从入口模块 URL 求 App 安装目录（dist/runtime/dsh-host.mjs → dist/）。 */
export function installDirOfEntry(entryUrl) {
  return dirname(dirname(entryUrl));
}

/** 读 JSON（缺失/畸形 → null；不抛）。 */
export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** 读文本（缺失/读失败 → null）。 */
export function readTextFile(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** 文件 sha256（缺失/读失败 → null）。 */
export function fileSha256(file) {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * 读 installDir/runtime/ 的运行时声明（三件套，随包）。
 * 返回 { dir, manifest, workspace, lockfile, dshVersion, cordisVersion }；
 * 缺失项为 null（调用方按容错纪律降级：声明缺失 = 安装链拒绝并给可读错误）。
 */
export function readRuntimeDeclaration(installDir) {
  const dir = join(installDir, RUNTIME_DIR_NAME);
  const manifest = readJsonFile(join(dir, "package.json"));
  const deps = (manifest && manifest.dependencies) || {};
  return {
    dir,
    manifest,
    workspace: readTextFile(join(dir, "pnpm-workspace.yaml")),
    lockfile: readTextFile(join(dir, "pnpm-lock.yaml")),
    dshVersion:
      typeof deps[DSH_PACKAGE] === "string" ? deps[DSH_PACKAGE] : null,
    cordisVersion:
      typeof deps[CORDIS_PACKAGE] === "string" ? deps[CORDIS_PACKAGE] : null,
  };
}

/** 声明摘要（幂等判断与安装态标记共用；任一变化即视为声明变化 → 覆盖三件套 + 重装）。 */
export function declarationDigest(declaration) {
  if (!declaration || !declaration.manifest) return null;
  return {
    dsh: declaration.dshVersion,
    cordis: declaration.cordisVersion,
    pnpm: PNPM_VERSION,
    // 锁文件与 allowBuilds 白名单都影响安装结果，一并进摘要（改白名单即触发重装）
    lockfile: declaration.lockfile
      ? createHash("sha256").update(declaration.lockfile).digest("hex")
      : null,
    workspace: declaration.workspace
      ? createHash("sha256").update(declaration.workspace).digest("hex")
      : null,
  };
}

function sameDigest(a, b) {
  if (!a || !b) return false;
  return (
    a.dsh === b.dsh &&
    a.cordis === b.cordis &&
    a.pnpm === b.pnpm &&
    a.lockfile === b.lockfile &&
    a.workspace === b.workspace
  );
}

/**
 * 三件套固定覆盖（installDir → runtime/）：期望文件存在即写（内容不同才写，避免无谓
 * mtime 变动）；期望缺失的锁文件删除旧残留（不留旧版锁）。返回 { changed, written, removed }。
 * 幂等：连续两次调用第二次 changed=false。
 */
export function syncRuntimeDeclaration(installDir, root, log = () => {}) {
  const declaration = readRuntimeDeclaration(installDir);
  if (!declaration.manifest) {
    return { ok: false, changed: false, declaration, error: "installDir/runtime/package.json 缺失" };
  }
  mkdirSync(root, { recursive: true });
  const changed = [];
  const written = [];
  const removed = [];
  const mapping = [
    ["package.json", declaration.manifest ? JSON.stringify(declaration.manifest, null, 2) + "\n" : null],
    ["pnpm-workspace.yaml", declaration.workspace],
    ["pnpm-lock.yaml", declaration.lockfile],
  ];
  for (const [name, content] of mapping) {
    const target = join(root, name);
    if (content == null) {
      if (existsSync(target)) {
        rmSync(target, { force: true });
        changed.push(name + ":removed");
        removed.push(name);
        log("[runtime] 三件套清理（installDir 无此文件）：" + name);
      }
      continue;
    }
    let prev = null;
    try {
      prev = readFileSync(target, "utf8");
    } catch {
      /* 不存在 */
    }
    if (prev === content) continue;
    writeFileSync(target, content, "utf8");
    changed.push(name + ":written");
    written.push(name);
    log("[runtime] 三件套覆盖：" + name);
  }
  return { ok: true, changed: changed.length > 0, changedFiles: changed, written, removed, declaration };
}

/** 读安装态标记（缺失/畸形 → null）。 */
export function readInstallState(root) {
  return readJsonFile(join(root, INSTALL_STATE_FILE));
}

/** 写安装态标记（原子：临时文件 + rename）。 */
export function writeInstallState(root, state) {
  const target = join(root, INSTALL_STATE_FILE);
  const tmp = target + "." + process.pid + ".tmp";
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    rmSync(target, { force: true });
    renameSync(tmp, target); // 同目录 rename，原子替换
    return true;
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败忽略 */
    }
    return false;
  }
}

/** 安装态是否与当前期望一致（声明/pnpm 版本/锁文件摘要全等）。 */
export function installStateMatches(state, declaration) {
  if (!state || typeof state !== "object") return false;
  const expected = declarationDigest(declaration);
  if (!expected) return false;
  return sameDigest(state.declaration, expected);
}

/** 已安装 dsh 版本（runtime/node_modules/@deepseek-ai/dsh/package.json）。 */
export function readInstalledDshVersion(root) {
  const pkg = readJsonFile(
    join(root, "node_modules", "@deepseek-ai", "dsh", "package.json"),
  );
  return pkg && typeof pkg.version === "string" ? pkg.version : null;
}

/**
 * 依赖是否就位（静态：cliBin 为常规文件 + 版本与声明一致 + 载体标记 + 安装态标记匹配）。
 * opts.requireState=false 时放宽安装态匹配（声明不可读的兜底路径：只剩存在性/版本核对）。
 */
export function inspectInstalledDeps(root, declaration, opts = {}) {
  const requireState = opts.requireState !== false;
  const p = runtimePaths(dirname(root));
  const cli = join(root, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  let isFile = false;
  try {
    isFile = statSync(cli).isFile();
  } catch {
    /* 缺失 */
  }
  const installed = readInstalledDshVersion(root);
  const declared = declaration ? declaration.dshVersion : null;
  const state = readInstallState(root);
  const carrierOk = existsSync(join(root, "pnpm", ".pnpm-ok"));
  const stateMatch = installStateMatches(state, declaration);
  const ok =
    isFile &&
    !!installed &&
    !!declared &&
    installed === declared &&
    carrierOk &&
    (requireState ? stateMatch : true);
  return { ok, cli, installed, declared, carrierOk, stateMatch, state, paths: p };
}

/**
 * 日志器（stdout 逐行 + dataDir/logs/dsh-runtime.log 追加）。
 * runtime 进程的 stdout 由宿主受管 runtime 日志环（64 条终态记录 + logBytes）承载，
 * 文件日志供 dsh_session 诊断与用户排查。
 */
export function makeLogger({ dataDir, tag = "dsh-runtime", echo = true } = {}) {
  let logFile = null;
  if (dataDir) {
    try {
      const dir = join(dataDir, "logs");
      mkdirSync(dir, { recursive: true });
      logFile = join(dir, tag + ".log");
    } catch {
      logFile = null;
    }
  }
  const line = (level, msg) => {
    const text = "[" + new Date().toISOString() + "] [" + level + "] " + String(msg);
    if (echo) {
      try {
        console.log("[" + tag + "] " + String(msg));
      } catch {
        /* stdout 已关闭 */
      }
    }
    if (logFile) {
      try {
        appendFileSync(logFile, text + "\n", "utf8");
      } catch {
        /* 日志失败不阻断 */
      }
    }
    return text;
  };
  return {
    logFile,
    info: (m) => line("info", m),
    warn: (m) => line("warn", m),
    error: (m) => line("error", m),
  };
}
