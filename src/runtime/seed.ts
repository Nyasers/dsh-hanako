// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/seed.ts — dshana profile 种子化（受管 runtime 子进程侧）
//
// 复用 src/lib/profile-seed.ts（纯路径逻辑零宿主依赖）在子进程内完成：
//   profiles/<name> 由官方 initProfile 初始化（manifest/cordis.patch.yml 用户层/
//   pnpm-workspace.yaml，幂等只补缺失）；
//   node_modules/@dshana scope 链接 → cordisSrc（默认 <installDir>/cordis，@dshana
//   产物 10 包平铺 scope 根），junction/symlink 失败回退整体拷贝。
// 链接源在 installDir（只读）：junction 指向只读目录可正常读取；App 升级换目录后链接
// 漂移由 ensureProfileSeeded 自愈重建（指向新 installDir），重建失败回退拷贝保证可用。
// initProfile（dsh-app-boot）由调用方（main.ts 经 locateDsh 取 appBoot.initProfile）注入；
// profile 名门控（dshana）在调用方完成。
import { join } from "node:path";
import { ensureProfileSeeded, PROFILE_BUNDLES, PROFILE_PATCH_RELOAD } from "../lib/profile-seed.ts";

/**
 * dshana profile 种子化（幂等）。返回 ensureProfileSeeded 的 outcome（字符串），或抛错
 * （initProfile 注入缺失/参数错）。opts: { dshHome, profileName='dshana', cordisSrc,
 * appBoot, log? }——appBoot = locateDsh() 的 appBoot 模块（须含 initProfile）。
 */
export async function seedDshanaProfile(opts) {
  const { dshHome, profileName = "dshana", cordisSrc, appBoot, log = () => {} } = opts;
  if (!dshHome || !cordisSrc || !appBoot || typeof appBoot.initProfile !== "function") {
    throw new Error("seedDshanaProfile: dshHome/cordisSrc/appBoot.initProfile 必填");
  }
  log(`profile 层序（manifest bundles）：${PROFILE_BUNDLES.join(", ")}；patchReload=${PROFILE_PATCH_RELOAD}`);
  return ensureProfileSeeded({
    profileDir: join(dshHome, "profiles", profileName),
    scopeSrc: cordisSrc,
    initProfile: appBoot.initProfile,
    log,
  });
}
