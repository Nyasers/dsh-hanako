// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// lib/profile-seed.js — dshana profile 运行时种子化/迁移/scope 链接（lib 提取）
// 从 src/lifecycle.js ensureDshanaProfile 剥离的纯路径逻辑（设计 specs/current/
// dshana-profile-bundle/spec.md D1/D2/D4/D5）：profile 目录（$DSH_HOME/profiles/dshana）
// 由插件运行时初始化为用户自有真实目录（不再整树 junction 挂插件产物），8 个
// @dsh-hanako/* 子插件 + bundle @dsh-hanako/dshana 经单条 scope 目录链接暴露（scopeSrc =
// PLUGIN_ROOT/cordis——9 包平铺于 cordis 资产根，链接名 @dsh-hanako 供 cordis 解析）。
//
// 官方生成工具（2026-09-04 定案）：profile 文件（manifest package.json / 用户层
// cordis.patch.yml / pnpm-workspace.yaml）由 @deepseek-ai/dsh-app-boot 的 initProfile
// 生成（官方库函数，幂等只补缺失；CLI `dsh plugin --profile` 同源）——本模块不维护
// 任何种子模板（seed 目录已退役），opts.initProfile 由消费方（lifecycle.js 经
// loadInprocDsh 拿 appBoot.initProfile）注入。cordis.yml 是 loader include 锚点的空
// entry 根，dsh 每次 boot 的 prepareProfile 无条件写回维护，两处均不碰。
//
// 形态判定（迁移只处理已声明「纯内置物」的两态，其余拒绝——绝不整树删除）：
//   profiles/dshana 不存在                      → initProfile 初始化 + scope 链接
//   isSymbolicLink（老整树 junction）           → rmdir 链接本身后初始化
//   实体目录且 node_modules/@dsh-hanako 已是链接 → 幂等 ensure（initProfile 只补缺失；
//                                                 链接漂移才重建；不覆盖用户改动）
//   实体目录且 manifest 为纯内置物（name=dsh-profile-dshana 且 dependencies 空）：
//     scope 为实体目录（老拷贝残留）            → 清内置残留后 initProfile 补齐
//     scope 缺失（新形态被 pnpm 剪枝等）         → 不清理，只补链接（保守保留文件）
//   其余实体目录（用户依赖非空/name 未知/无法分类）→ 拒绝迁移（warn，由诊断引导）
//
// 幂等：initProfile 官方语义 = 缺失才写（不覆盖用户改动/模板不重写）；scope 链接指向
// 正确源即不动，缺失/漂移删旧重建，建失败回退整体拷贝 scope 目录。连续两次调用第二次零变更。
// 平台：Windows junction / 非 Windows symlink(dir)，lstat isSymbolicLink + realpath
// 校验通用（createLink 可注入以便测试回退分支）。
//
// 归类说明：纯路径逻辑 + 注入回调（initProfile/log/createLink，消费方 src/lifecycle.js
// 注入），零宿主状态；tests/profile-seed.test.mjs 直接 import 本模块做四态断言（node:test）。

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

// 老整树拷贝残留判定用的内置 profile manifest 名（官方 initProfile 生成的 name 规则 =
// dsh-profile-<profile 目录名>；这里锁定 dshana 的固定名用于 legacy 识别）。
const PROFILE_MANIFEST_NAME = "dsh-profile-dshana";

// dshana profile 的官方 initProfile 参数（bundles 层序 = 官方服务层 + 本插件 roster
// bundle；patchReload live 与官方自定义 profile 默认一致）。导出供消费方/测试断言。
export const PROFILE_BUNDLES = ["@deepseek-ai/dsh-base", "@dsh-hanako/dshana"];
export const PROFILE_PATCH_RELOAD = "live";

// 历史内置 bundle 名并集（随包托管边界：profile 目录只有 cordis.patch.yml 归用户，其余
// 全部随包更新）。manifest 归一依据：bundles = 当前期望（PROFILE_BUNDLES，随插件版本演进）
// + 现列表中「不属于任何历史内置」的项（= 用户经 dsh plugin --profile 装的 bundle，保留）。
// 将来期望变化（如去 dsh-base/换源）时：新内置进期望、旧内置仍留在历史集 → 升级自动
// 替换/移除内置项、用户自装项永不丢。
const HISTORICAL_PROFILE_BUNDLES = new Set([...PROFILE_BUNDLES]);

// manifest 随包归一（幂等：一致不写；期望内字段按插件声明刷新，CLI 追加项保留）
function normalizeProfileManifest(profileDir, log) {
  const manifestPath = join(profileDir, "package.json");
  if (!existsSync(manifestPath)) return; // initProfile 刚生成/缺失由 initProfile 兜底
  let j = null;
  try {
    j = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    log("[cordis] profile manifest 解析失败，跳过随包归一（由诊断引导）");
    return;
  }
  if (!j || typeof j !== "object") return;
  const cur = Array.isArray(j.dsh?.profile?.bundles) ? j.dsh.profile.bundles : [];
  const computed = [...PROFILE_BUNDLES];
  for (const name of cur) {
    if (HISTORICAL_PROFILE_BUNDLES.has(name) || computed.includes(name)) continue;
    computed.push(name); // 用户经 dsh plugin --profile 追加的 bundle（不在历史内置集）保留
  }
  const reload = j.dsh?.profile?.patchReload;
  if (reload === PROFILE_PATCH_RELOAD && sameList(cur, computed)) return; // 一致不写
  j.dsh = { ...(j.dsh || {}), profile: { ...(j.dsh?.profile || {}), bundles: computed, patchReload: PROFILE_PATCH_RELOAD } };
  try {
    writeFileSync(manifestPath, JSON.stringify(j, null, 2) + "\n", "utf8");
    log(`[cordis] profile manifest 随包归一：bundles -> [${computed.join(", ")}]（期望随插件版本）`);
  } catch (e) {
    log(`[cordis] profile manifest 随包归一写入失败：${(e && e.message) || e}`);
  }
}
function sameList(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// 老拷贝形态的内置文件（清理用；新形态由官方 initProfile 管理，不在此列）
const LEGACY_BUILTIN_FILES = ["package.json", "cordis.patch.yml", "pnpm-workspace.yaml"];

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

// 删除单个路径（缺失忽略；供清理内置残留用——失败不抛出，由后续 initProfile 补位）
function rmBestEffort(p) {
  try {
    rmSync(p, { recursive: true, force: true });
  } catch {
    /* 删除失败不阻断（initProfile 只补缺失，残留文件不会覆盖） */
  }
}

// 清理老拷贝内置残留：内置三文件（manifest/旧 roster 用户层/pnpm-workspace，该形态已
// 声明纯内置物无用户内容可能——旧 cordis.patch.yml 是构建期内置 58 行 roster 非用户
// 内容，roster 已进 bundle patch）+ node_modules/@dsh-hanako 实体拷贝；其余未知文件
// 保守保留不碰。cordis.yml 残留保留（dsh boot 自维护写回空根）。
function cleanupLegacyCopy(profileDir, log) {
  for (const name of LEGACY_BUILTIN_FILES) {
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

// 主入口：dshana profile 初始化/迁移/scope 链接（幂等；消费方 = lifecycle.js
// ensureDshanaProfile，profile 名门控与路径定位在调用方完成）。
// opts: { profileDir, scopeSrc, initProfile, log?, createLink? }——profileDir =
// $DSH_HOME/profiles/dshana；scopeSrc = PLUGIN_ROOT/cordis（产物平铺 scope 根）；
// initProfile = 官方 @deepseek-ai/dsh-app-boot 的 initProfile(dir, bundles, patchReload)
//（生成 manifest/用户层模板/pnpm-workspace，幂等只补缺失）。
// 返回 outcome：missing-source（scope 源缺失）| refused（拒绝迁移）| init-failed |
// linked | scope-copied | ensured | failed（scope 链接/回退失败）
export function ensureProfileSeeded(opts) {
  const { profileDir, scopeSrc, initProfile, log = noop, createLink } = opts || {};
  if (!profileDir || !scopeSrc) throw new Error("ensureProfileSeeded: profileDir/scopeSrc 必填");
  if (typeof initProfile !== "function") {
    throw new Error("ensureProfileSeeded: initProfile 必填（官方 dsh-app-boot initProfile，消费方注入）");
  }
  // 源缺失检查（scope 树形态：产物包内无顶层 package.json，检查 scope 目录存在）
  if (!existsSync(scopeSrc)) {
    log(`[cordis] scope 源缺失：${scopeSrc}（插件未打包 cordis/ 或安装不完整）`);
    return "missing-source";
  }
  const doLink = createLink || defaultCreateScopeLink;
  // ---- 形态判定与迁移 ----
  let destStat = null;
  try {
    destStat = lstatSync(profileDir);
  } catch {
    /* 不存在 → 直接初始化 */
  }
  if (destStat && destStat.isSymbolicLink()) {
    // 老整树 junction：删链接本身（不递归），随后初始化
    try {
      rmdirSync(profileDir);
      destStat = null;
      log("[cordis] 检测到老整树 junction（profiles/dshana），移除链接后按新形态初始化");
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
    // 拷贝残留的典型形态）且 manifest 为纯内置物时才清内置残留重初始化。
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
        // 老整树实体拷贝残留（scope 为实体目录）：清内置残留后重初始化
        cleanupLegacyCopy(profileDir, log);
      }
    }
  }
  // ---- 官方 initProfile 生成 profile 文件（manifest/用户层模板/pnpm-workspace，幂等）----
  try {
    initProfile(profileDir, PROFILE_BUNDLES, PROFILE_PATCH_RELOAD);
  } catch (e) {
    log(`[cordis] profile 初始化失败（initProfile）：${(e && e.message) || e}`);
    return "init-failed";
  }
  // ---- manifest 随包归一（profile 目录只有 cordis.patch.yml 归用户，其余随包更新）----
  normalizeProfileManifest(profileDir, log);
  // ---- scope 链接 ----
  return ensureScopeLink(profileDir, scopeSrc, doLink, log);
}
