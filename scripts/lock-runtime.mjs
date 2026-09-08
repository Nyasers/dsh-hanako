// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/lock-runtime.mjs — 生成 src/runtime/pnpm-lock.yaml（随包锁文件，spec D2「pnpm 随发版」）
//
// 为什么需要：受管 runtime 的依赖安装优先走 --frozen-lockfile（可复现）。锁文件必须与
// src/runtime/package.json 的声明一致，因此**发版前**在构建机生成一次并随包：
//   1) 本脚本用与运行时同一条链路（src/lib/pnpm-carrier.js → @pnpm/napi install）解析
//      依赖图，lockfileOnly=true 只写锁、不物化 node_modules；
//   2) 结果复制到 src/runtime/pnpm-lock.yaml（src/build.js 会带进 dist/runtime/）。
// 前置：能访问 npm registry（脚本自己下载 pnpm 12 载体到 _tmp/lock-runtime/pnpm/）。
// 用法：node scripts/lock-runtime.mjs（或 pnpm run lock:runtime）
import { mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installRuntimeDeps } from "../src/lib/pnpm-carrier.js";
import { runtimePaths, syncRuntimeDeclaration, PNPM_VERSION } from "../src/lib/runtime-layout.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORK = join(ROOT, "_tmp", "lock-runtime");

// 声明源 = src/runtime/（仓库内布局；与 src/build.js 复制到 dist/runtime/ 的同一份），
// 解析根 = _tmp/lock-runtime（隔离，不碰仓库 node_modules 与任何 workspace 祖先）
const manifest = JSON.parse(readFileSync(join(ROOT, "src", "runtime", "package.json"), "utf8"));
const deps = manifest.dependencies || {};
const decl = {
  dir: join(ROOT, "src", "runtime"),
  manifest,
  workspace: readFileSync(join(ROOT, "src", "runtime", "pnpm-workspace.yaml"), "utf8"),
  lockfile: null,
  dshVersion: deps["@deepseek-ai/dsh"] || null,
  cordisVersion: deps["@deepseek-ai/cordis"] || null,
};

const log = (m) => console.log("[lock:runtime] " + m);

// 守卫：本脚本的解析根在仓库内（_tmp/），pnpm 的工作区探测在某些情形下会把仓库根当成
// workspace 并改写仓库根 pnpm-lock.yaml（实测：首次无 pnpm-workspace.yaml 时）。这里备份
// 并在结束时原样还原——仓库根锁只归仓库自身的依赖树，绝不被 runtime 依赖区污染。
const repoLock = join(ROOT, "pnpm-lock.yaml");
let repoLockBackup = null;
try {
  repoLockBackup = readFileSync(repoLock);
} catch {
  repoLockBackup = null;
}
const restoreRepoLock = () => {
  if (repoLockBackup === null) return;
  try {
    const now = readFileSync(repoLock);
    if (!now.equals(repoLockBackup)) {
      writeFileSync(repoLock, repoLockBackup);
      log("守卫：已还原仓库根 pnpm-lock.yaml（生成过程曾被工作区探测改写）");
    }
  } catch {
    /* 还原失败不阻断（用户可 git checkout -- pnpm-lock.yaml） */
  }
};

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const paths = runtimePaths(WORK);
// 三件套先落位到解析根（引擎按 dir 读 pnpm-workspace.yaml / 写 pnpm-lock.yaml）
const synced = syncRuntimeDeclaration(join(ROOT, "src"), paths.root, log);
if (!synced.ok) {
  console.error("[lock:runtime] 三件套落位失败：" + (synced.error || "未知"));
  process.exit(1);
}

log("声明：" + JSON.stringify({ dsh: decl.dshVersion, cordis: decl.cordisVersion, pnpm: PNPM_VERSION }));

const r = await installRuntimeDeps({
  paths,
  declaration: decl,
  lockfileOnly: true,
  log,
  onOutput: () => {},
});
if (!r.ok) {
  console.error("[lock:runtime] 失败：" + (r.error || "未知") + (r.hint ? "（" + r.hint + "）" : ""));
  process.exit(1);
}
if (!existsSync(paths.lockfile)) {
  restoreRepoLock();
  console.error("[lock:runtime] 未生成锁文件：" + paths.lockfile);
  process.exit(1);
}
restoreRepoLock();
const target = join(ROOT, "src", "runtime", "pnpm-lock.yaml");
copyFileSync(paths.lockfile, target);
log("已写入 " + target + "（随包；src/build.js 会复制到 dist/runtime/）");
