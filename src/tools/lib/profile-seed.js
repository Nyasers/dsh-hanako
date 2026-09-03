// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/profile-seed.js — dshana profile 运行时种子化/迁移/scope 链接（lib 提取）
// 从 src/lifecycle.js ensureDshanaProfile 剥离的纯路径逻辑（设计 specs/current/
// dshana-profile-bundle/spec.md D1/D2/D4/D5）：profile 目录（$DSH_HOME/profiles/dshana）
// 由插件运行时种子化为用户自有真实目录（不再整树 junction 挂插件产物），8 个
// @dsh-hanako/* 子插件 + bundle @dsh-hanako/dshana 经单条 scope 目录链接暴露。
//
// 模板文件化（review 修订 2026-09-04）：种子模板以独立文件存于源码层 src-cordis/seed/
// （构建期随 scope 树落位 dist/cordis/seed/，见 build.mjs buildCordis），运行时由
// 本模块按名读取——YAML/JSON 模板保持文件形态可审可校验，不再内嵌 JS 字符串。
// opts.seedDir 为注入的模板目录（消费方 lifecycle.js 传 PLUGIN_ROOT/cordis/seed）。
// 种子范围（2026-09-04 修订）：cordis.yml 不在种子内——它是 loader include 锚点的空
// entry 根，dsh 每次 boot 的 prepareProfile 无条件写回维护（官方所有 profile 同款），
// 种子预填属冗余；剩余三件套 = package.json（profile manifest）/ cordis.patch.yml
// （用户层初始引导模板）/ pnpm-workspace.yaml（hoisted workspace）。
//
// 形态判定（迁移只处理已声明「纯内置物」的两态，其余拒绝——绝不整树删除）：
//   profiles/dshana 不存在                      → 种子（三件套 + scope 链接）
//   isSymbolicLink（老整树 junction）           → rmdir 链接本身后种子
//   实体目录且 node_modules/@dsh-hanako 已是链接 → 新形态：幂等 ensure（只补缺失、
//                                                 链接漂移才重建；不覆盖用户改动）
//   实体目录且 manifest 为纯内置物（name=dsh-profile-dshana 且 dependencies 空）：
//     scope 为实体目录（老拷贝残留）            → 清内置残留后种子
//     scope 缺失（新形态被 pnpm 剪枝等）         → 不清理，只补链接（保守保留文件）
//   其余实体目录（用户依赖非空/name 未知/无法分类）→ 拒绝迁移（warn，由诊断引导）
//
// 幂等：种子文件只补缺失（已有模板内容不重写、用户改动不覆盖）；scope 链接指向正确
// 源即不动，缺失/漂移删旧重建，建失败回退整体拷贝 scope 目录。连续两次调用第二次零变更。
// 平台：Windows junction / 非 Windows symlink(dir)，lstat isSymbolicLink + realpath
// 校验通用（createLink 可注入以便测试回退分支）。
//
// 归类说明：纯路径逻辑 + 注入日志回调（消费方 src/lifecycle.js 经 g.appendLog 传入），
// 零宿主状态；tests/profile-seed.test.mjs 直接 import 本模块做四态断言（node:test）。

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  realpathSync,
  symlinkSync,
  rmSync,
  rmdirSync,
  cpSync,
} from "node:fs";
import { join } from "node:path";

// 老整树拷贝残留判定用的内置 profile manifest 名（与 seed/package.json 的 name 一致；
// 模板内容本身在 seed 目录文件，这里只留判定常量）。
const PROFILE_MANIFEST_NAME = "dsh-profile-dshana";

// 种子文件清单（顺序即写入/清理顺序；package.json 为 profile manifest；内容从
// seedDir 按名读取 = src-cordis/seed 同名文件，见 build.mjs buildCordis 复制）。
// cordis.yml 不入种子（dsh boot prepareProfile 自维护空根，见文件头注释）。
const SEED_NAMES = ["package.json", "cordis.patch.yml", "pnpm-workspace.yaml"];

const noop = () => {};

// 默认目录链接建立（win32 junction / 其他 symlink dir，与旧 ensureDshanaProfile 同分支）。
// junction 要求绝对目标（resolve 归一；scopeSrc 恒来自 PLUGIN_ROOT 已为绝对路径）。
function defaultCreateScopeLink(src, dest) {
  if (process.platform === "win32") symlinkSync(src, dest, "junction");
  else symlinkSync(src, dest, "dir");
}

// 读 profile manifest，判定是否「老整树拷贝残留」（纯内置物形态）。
// 返回 null = package.json 缺失/不可解析（无法分类 → 拒绝）；对象含 legacy 布尔：
//   legacy = name === dsh-profile-dshana 且 dependencies 为空对象（无用户内容可能）
function readLegacyCopyInfo(profileDir) {
  const p = join(profileDir, "package.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (!j || typeof j !== "object") return { legacy: false };
    const deps = j.dependencies;
    const depsEmpty =
      (!deps || typeof deps === "object") && Object.keys(deps || {}).length === 0;
    return { legacy: j.name === PROFILE_MANIFEST_NAME && depsEmpty };
  } catch {
    return null;
  }
}

// 删除单个路径（缺失忽略；供清理内置残留用——失败不抛出，由种子步补位）
function rmBestEffort(p) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* 删除失败不阻断（种子只补缺失，残留文件不会覆盖） */
  }
}

// 清理老拷贝内置残留：种子四件套 + node_modules/@dsh-hanako 实体拷贝（该形态已声明
// 纯内置物、无用户内容可能；其余未知文件保守保留不碰）
function cleanupLegacyCopy(profileDir, log) {
  for (const name of SEED_NAMES) {
    const p = join(profileDir, name);
    if (existsSync(p)) {
      rmBestEffort(p);
      log(`[cordis] 清理老拷贝内置文件：${name}`);
    }
  }
  const scopeCopy = join(profileDir, "node_modules", "@dsh-hanako");
  if (existsSync(scopeCopy)) {
    rmBestEffort(scopeCopy);
    log("[cordis] 清理老拷贝 scope 实体目录：node_modules/@dsh-hanako");
  }
}

// 种子四件套（幂等：只补缺失，已有文件一律不覆盖——模板内容不重写、用户改动不覆盖）；
// 内容从 seedDir 按名读取（seedDir 缺失由入口前置检查拦截，见 ensureProfileSeeded）
function seedProfileFiles(profileDir, seedDir, log) {
  mkdirSync(profileDir, { recursive: true });
  for (const name of SEED_NAMES) {
    const p = join(profileDir, name);
    if (existsSync(p)) continue;
    try {
      const content = readFileSync(join(seedDir, name), "utf8");
      writeFileSync(p, content, "utf8");
      log(`[cordis] profile 种子文件已写入：${name}（模板 ${seedDir}/${name}）`);
    } catch (e) {
      log(`[cordis] profile 种子文件写入失败（${name}）：${(e && e.message) || e}（不阻断，dsh loadProfile 会再报）`);
    }
  }
}

// scope 链接 ensure：已指向正确源不动；缺失/漂移删旧重建；建失败回退整体拷贝 scope。
// 返回 "linked"（新建链接）/ "scope-copied"（拷贝回退）/ "ensured"（已正确未动）/
// "failed"（建链接与拷贝都失败）
function ensureScopeLink(profileDir, scopeSrc, createLink, log) {
  const nmDir = join(profileDir, "node_modules");
  const link = join(nmDir, "@dsh-hanako");
  mkdirSync(nmDir, { recursive: true });
  try {
    const st = lstatSync(link);
    if (st.isSymbolicLink()) {
      try {
        if (realpathSync(link) === realpathSync(scopeSrc)) return "ensured";
      } catch {
        /* 链接目标缺失（broken link）：按漂移删除重建 */
      }
      rmdirSync(link); // 删链接本身，不递归（防误删链接目标）
    } else if (st.isDirectory()) {
      // 实体目录残留（老拷贝 / pnpm 误建等）：@dsh-hanako 为插件保留区，删后重建
      rmSync(link, { recursive: true, force: true });
    } else {
      rmSync(link, { force: true }); // 文件等异常形态
    }
  } catch {
    /* 不存在 → 直接创建 */
  }
  try {
    createLink(scopeSrc, link);
    log(`[cordis] @dsh-hanako scope 链接（${process.platform === "win32" ? "junction" : "symlink"}）-> ${scopeSrc}`);
    return "linked";
  } catch (e) {
    // 链接建立失败（跨盘/权限等）：回退整体拷贝 scope 目录（保证 profile 可用）
    log(`[cordis] @dsh-hanako scope 链接失败（${(e && e.message) || e}），回退拷贝 scope 目录`);
    try {
      cpSync(scopeSrc, link, { recursive: true, force: true });
      log(`[cordis] @dsh-hanako scope 落位（拷贝回退）-> ${link}`);
      return "scope-copied";
    } catch (e2) {
      log(`[cordis] @dsh-hanako scope 落位失败：${(e2 && e2.message) || e2}`);
      return "failed";
    }
  }
}

// 主入口：dshana profile 种子化/迁移/scope 链接（幂等；消费方 = lifecycle.js
// ensureDshanaProfile，profile 名门控与路径定位在调用方完成）。
// opts: { profileDir, scopeSrc, seedDir, log?, createLink? }——profileDir =
// $DSH_HOME/profiles/dshana；scopeSrc = PLUGIN_ROOT/cordis/node_modules/@dsh-hanako；
// seedDir = PLUGIN_ROOT/cordis/seed（种子模板目录，构建期复制自 src-cordis/seed）。
// 返回 outcome：missing-source（scope 源缺失）| missing-seed（模板目录缺失）|
// refused（拒绝迁移）| linked | scope-copied | ensured | failed（scope 链接/回退失败）
export function ensureProfileSeeded(opts) {
  const { profileDir, scopeSrc, seedDir, log = noop, createLink } = opts || {};
  if (!profileDir || !scopeSrc || !seedDir) {
    throw new Error("ensureProfileSeeded: profileDir/scopeSrc/seedDir 必填");
  }
  // 源缺失检查（scope 树形态：产物包内无顶层 package.json，检查 scope 目录存在）
  if (!existsSync(scopeSrc)) {
    log(`[cordis] scope 源缺失：${scopeSrc}（插件未打包 cordis/ 或安装不完整）`);
    return "missing-source";
  }
  if (!existsSync(seedDir)) {
    log(`[cordis] profile 种子模板目录缺失：${seedDir}（插件未打包 cordis/seed 或安装不完整）`);
    return "missing-seed";
  }
  const doLink = createLink || defaultCreateScopeLink;
  // ---- 形态判定与迁移 ----
  let destStat = null;
  try {
    destStat = lstatSync(profileDir);
  } catch {
    /* 不存在 → 直接种子 */
  }
  if (destStat && destStat.isSymbolicLink()) {
    // 老整树 junction：删链接本身（不递归），随后种子
    try {
      rmdirSync(profileDir);
      destStat = null;
      log("[cordis] 检测到老整树 junction（profiles/dshana），移除链接后按新形态种子化");
    } catch (e) {
      log(`[cordis] 老整树 junction 移除失败：${(e && e.message) || e}（跳过，由诊断引导人工处理）`);
      return "refused";
    }
  }
  if (destStat) {
    if (!destStat.isDirectory()) {
      log("[cordis] profiles/dshana 为非目录形态，拒绝迁移（由诊断引导人工处理）");
      return "refused";
    }
    // 实体目录：若 node_modules/@dsh-hanako 已是链接 = 新形态（或漂移，链接 ensure 修复），
    // 不清理（用户文件如 cordis.patch.yml 归用户所有）；scope 路径缺失（新形态被 pnpm
    // 剪枝等）同样不清理——只补链接，保守保留已有文件；仅当 scope 为实体目录（老整树
    // 拷贝残留的典型形态）且 manifest 为纯内置物时才清内置残留重种子。
    const scopeLink = join(profileDir, "node_modules", "@dsh-hanako");
    let scopeIsLink = false;
    try {
      scopeIsLink = lstatSync(scopeLink).isSymbolicLink();
    } catch {
      scopeIsLink = false;
    }
    if (!scopeIsLink) {
      const info = readLegacyCopyInfo(profileDir);
      // 仅当 manifest 为「纯内置物」（name=dsh-profile-dshana 且 dependencies 空）才可能
      // 是插件自有形态；其余（用户依赖非空 / name 未知 / package.json 缺失无法分类）
      // 一律拒绝迁移——绝不整树删除，交由诊断引导人工处理。
      if (!info || !info.legacy) {
        log("[cordis] profiles/dshana 为实体目录且含用户依赖/未知内容，拒绝迁移（绝不整树删除；请经诊断确认后人工处理）");
        return "refused";
      }
      let scopeIsDir = false;
      try {
        scopeIsDir = lstatSync(scopeLink).isDirectory();
      } catch {
        /* scope 缺失：新形态被 pnpm 剪枝等——不清理，下方直接补链接（用户文件保留） */
      }
      if (scopeIsDir) {
        // 老整树实体拷贝残留（scope 为实体目录）：清内置残留后重种子
        cleanupLegacyCopy(profileDir, log);
      }
    }
  }
  // ---- 种子四件套（幂等，内容读自 seedDir）+ scope 链接 ----
  seedProfileFiles(profileDir, seedDir, log);
  return ensureScopeLink(profileDir, scopeSrc, doLink, log);
}
