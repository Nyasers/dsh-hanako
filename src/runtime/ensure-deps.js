// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/ensure-deps.js — 受管 runtime 依赖 ensure（dsh-host 专用；部署方案落定见
// DESIGN「依赖部署（v2）」与 src/index.js 头注释）
//
// 方案：DSH 依赖（@deepseek-ai/dsh + @deepseek-ai/cordis + dsh-* 官方插件树 + 平台原生
// 产物）装在 App dataDir 的安装区 <data-dir>/runtime/（installDir 只读不可写，v1「pnpm
// install --prod 进插件根 node_modules」物理不可行）。版本随 App 声明（installDir
// package.json dependencies 单一事实源，无独立 DSH 升级通道——升级 dsh = App 发版）。
//
// runtime/ 固定布局（无版本目录；升级覆盖）：
//   runtime/package.json          ← 安装清单①：installRoot 覆盖（含 devDeps 声明，但
//                                     install 只 --prod 拉运行时；lock 需与其匹配）
//   runtime/pnpm-workspace.yaml   ← 安装清单②：allowBuilds 白名单（installRoot 覆盖）
//   runtime/pnpm-lock.yaml        ← 安装清单③：锁文件（installRoot 覆盖，随 App 发版）
//   runtime/node_modules/         ← pnpm install 产物（单实例；depsRoot 默认指向此处）
//   runtime/.runtime-ok           ← 幂等标记：{ manifest:{dsh,cordis}, at }——声明版本变化
//                                    即整体覆盖三件套重装
// pnpm 引导复用 v1 lib/pnpm.js（单文件 pnpm.mjs 下载 + sha512 + worker 提取，缓存于
// <data-dir>/pnpm-dist/）；node 代理 + PATH 前缀（node.cmd 转发到 process.execPath）让
// koffi/node-pty 等 install script 经 cmd 起子进程 node 时找到解释器（v1 T7d 同款）。
// Windows 原生文件锁纪律（迁移指南 §4）：依赖变更重装前必须先停占用 .node 的 DSH
// 进程/worker/终端——本模块只在「本次 runtime 启动前」被调用（旧 runtime 已被 App 侧
// stop 或已退出），重装窗口内没有旧进程占用；App 侧 update/卸载同样先 ctx.runtime.stop。
import { delimiter } from "node:path";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
// v1 运行时引导（纯 node 内置依赖；PLUGIN_ROOT 在子进程 bundle 内向上解析到 App 安装根）
import { ensurePnpm, runPnpm } from "../lib/pnpm.js";

/** 安装区三件套（installRoot 源文件 → runtimeDir 覆盖目标）。 */
export const MANIFEST_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
];

/** 从 installRoot package.json 读声明版本（dsh/cordis 只收字符串依赖）。 */
export function declaredRuntimeVersions(installRoot) {
  try {
    const j = JSON.parse(readFileSync(join(installRoot, "package.json"), "utf8"));
    const deps = (j && j.dependencies) || {};
    return {
      dsh: typeof deps["@deepseek-ai/dsh"] === "string" ? deps["@deepseek-ai/dsh"] : null,
      cordis: typeof deps["@deepseek-ai/cordis"] === "string" ? deps["@deepseek-ai/cordis"] : null,
    };
  } catch {
    return { dsh: null, cordis: null };
  }
}

/** 从 depsRoot 读已安装版本（读 package.json version）。 */
export function installedRuntimeVersions(depsRoot) {
  const read = (name) => {
    try {
      const p = join(depsRoot, "@deepseek-ai", name, "package.json");
      if (!existsSync(p)) return null;
      const j = JSON.parse(readFileSync(p, "utf8"));
      return j && typeof j.version === "string" && j.version ? j.version : null;
    } catch {
      return null;
    }
  };
  return { dsh: read("dsh"), cordis: read("cordis") };
}

/** 幂等判断：声明与已安装完全一致（固定版本语义；v1 同款字符串比对）。 */
export function versionsMatch(decl, inst) {
  return Boolean(decl.dsh && decl.cordis && inst.dsh === decl.dsh && inst.cordis === decl.cordis);
}

/** 关键文件存在性（bin 必须可 import 启动）。 */
export function depsBinIntact(depsRoot) {
  return existsSync(join(depsRoot, "@deepseek-ai", "dsh", "lib", "bin.js"));
}

/** runtime 安装区幂等标记路径/读写（marker 是纯函数，便于单测）。 */
export function markerPath(runtimeDir) {
  return join(runtimeDir, ".runtime-ok");
}
export function readMarker(runtimeDir) {
  try {
    const j = JSON.parse(readFileSync(markerPath(runtimeDir), "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}
export function writeMarker(runtimeDir, decl, at = new Date().toISOString()) {
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    markerPath(runtimeDir),
    JSON.stringify({ manifest: { dsh: decl.dsh, cordis: decl.cordis }, at }, null, 2) + "\n",
    "utf8",
  );
}

/** 复制 installRoot 三件套到 runtimeDir（整体覆盖不留旧版——用户定案见归档 spec D2）。 */
export function copyManifests(installRoot, runtimeDir, log) {
  mkdirSync(runtimeDir, { recursive: true });
  for (const name of MANIFEST_FILES) {
    const src = join(installRoot, name);
    if (!existsSync(src)) {
      throw new Error(`安装清单缺失（${src}）：App 安装不完整（三件套随 App 发版，见 pack.mjs）`);
    }
    copyFileSync(src, join(runtimeDir, name));
  }
  log(`安装清单已覆盖：${MANIFEST_FILES.join(", ")} -> ${runtimeDir}`);
}

/** node 代理（win node.cmd / 其他 node）→ process.execPath（install script 用 node 时命中）。 */
export function writeNodeProxy(runtimeDir) {
  mkdirSync(runtimeDir, { recursive: true });
  const isWin = process.platform === "win32";
  const target = join(runtimeDir, isWin ? "node.cmd" : "node");
  const body = isWin
    ? `@"${process.execPath}" %*\n`
    : `#!/bin/sh\nexec "${process.execPath}" "$@"\n`;
  writeFileSync(target, body, isWin ? "utf8" : { encoding: "utf8", mode: 0o755 });
  return target;
}

/** pnpm install --prod 部署到 runtimeDir（frozen-lockfile 保证可复现；registry 缺省官方）。 */
async function pnpmInstallInto(runtimeDir, { dataDir, log }) {
  const pnpmCli = await ensurePnpm({ dataDir });
  log("pnpm 引导就绪：" + pnpmCli);
  const proxyDir = runtimeDir;
  const env = {
    ...process.env,
    // PATH 前缀 = runtimeDir（node 代理所在；install script 经 cmd 起子进程 node 时命中）
    PATH: proxyDir + delimiter + (process.env.PATH || ""),
  };
  const args = ["install", "--prod", "--frozen-lockfile"];
  const r = await runPnpm(args, { pnpmCli, cwd: runtimeDir, dataDir, env });
  if (r.code !== 0) {
    const tail = String(r.stderr || r.stdout || "").slice(-800) || "无输出";
    throw new Error(`pnpm install 失败（exit ${r.code}）：\n${tail}`);
  }
}

/**
 * 依赖 ensure 主流程。返回 { status, ... }：
 *   status 'present'  已安装且版本一致（幂等快路径）
 *   status 'installed' 本次执行安装并验证通过
 *   status 'error'    附带 { kind, message }（declaration/missing/io/network/install-failed）
 * @param opts { dataDir, installRoot, runtimeDir, depsRoot, noEnsure?, log? }
 */
export async function ensureDeps(opts) {
  const { dataDir, installRoot, runtimeDir, depsRoot, noEnsure = false, log = () => {} } = opts;
  const decl = declaredRuntimeVersions(installRoot);
  if (!decl.dsh || !decl.cordis) {
    return {
      status: "error",
      kind: "declaration",
      message: `installRoot package.json 缺 @deepseek-ai/dsh / @deepseek-ai/cordis 声明（${installRoot}/package.json）`,
    };
  }
  const inst = installedRuntimeVersions(depsRoot);
  if (versionsMatch(decl, inst) && depsBinIntact(depsRoot)) {
    const marker = readMarker(runtimeDir);
    if (marker && marker.manifest && versionsMatch(decl, marker.manifest)) {
      log(`依赖已就绪（dsh@${inst.dsh} / cordis@${inst.cordis}，与声明一致）`);
      return { status: "present", dsh: inst.dsh, cordis: inst.cordis };
    }
  }
  // 已安装但 marker 缺失/漂移 → 版本已一致时补 marker 即可（不重装）
  if (versionsMatch(decl, inst) && depsBinIntact(depsRoot)) {
    writeMarker(runtimeDir, decl);
    log("依赖版本一致但 marker 缺失，补写 .runtime-ok");
    return { status: "present", dsh: inst.dsh, cordis: inst.cordis };
  }
  if (noEnsure) {
    return {
      status: "error",
      kind: "missing",
      message: `依赖未就绪且 --no-ensure 跳过安装（depsRoot=${depsRoot}，声明 dsh@${decl.dsh}/cordis@${decl.cordis}，已装 dsh@${inst.dsh || "-"}/cordis@${inst.cordis || "-"}）`,
    };
  }
  // ---- 执行安装（覆盖三件套 → pnpm install --prod --frozen-lockfile）----
  log(`依赖版本变化/缺失：声明 dsh@${decl.dsh} cordis@${decl.cordis}，已装 dsh@${inst.dsh || "-"} cordis@${inst.cordis || "-"} —— 触发重装`);
  try {
    mkdirSync(runtimeDir, { recursive: true });
    copyManifests(installRoot, runtimeDir, log);
    writeNodeProxy(runtimeDir);
    await pnpmInstallInto(runtimeDir, { dataDir, log });
  } catch (e) {
    const text = (e && e.message) || String(e);
    const kind = /timed out|ENOTFOUND|ECONNREFUSED|getaddrinfo|fetch failed|registry|ETIMEDOUT/i.test(text)
      ? "network"
      : /EACCES|EPERM|EBUSY|锁|locked/i.test(text)
        ? "io"
        : "install-failed";
    return { status: "error", kind, message: text };
  }
  // ---- 装后验证 + 落 marker ----
  const after = installedRuntimeVersions(depsRoot);
  if (!versionsMatch(decl, after) || !depsBinIntact(depsRoot)) {
    return {
      status: "error",
      kind: "install-failed",
      message: `安装后验证失败：声明 dsh@${decl.dsh}/cordis@${decl.cordis}，实际 dsh@${after.dsh || "-"}/cordis@${after.cordis || "-"}`,
    };
  }
  writeMarker(runtimeDir, decl);
  log(`依赖安装完成（dsh@${after.dsh} / cordis@${after.cordis}）`);
  return { status: "installed", dsh: after.dsh, cordis: after.cordis };
}
