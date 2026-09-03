// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/version-common.mjs — 版本域共享模块（根级通用：bump/syncver/postbump 复用）
// 布局原则：跨脚本共享/流程性构件放根级（scripts/），领域特有随源码（src-cordis/build）。
// 提供 cordis 包清单（src-cordis 顶层 roster bundle + plugins/*）与派生同步目标
// （manifest + cordis 包）——版本单一事实源 = 主 package.json（bump 是改版本唯一入口，
// 派生同步见 scripts/syncver.mjs）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// cordis 包 package.json 清单（相对 ROOT；随插件整体发版不独立发布，历史独立号废弃）
export function cordisPkgPaths() {
  const out = ["src-cordis/package.json"];
  const plugins = path.join(ROOT, "src-cordis", "plugins");
  for (const name of fs.readdirSync(plugins)) {
    const p = path.join(plugins, name);
    if (!fs.statSync(p).isDirectory()) continue;
    const pj = path.join(p, "package.json");
    if (fs.existsSync(pj)) out.push(path.relative(ROOT, pj));
  }
  return out.sort();
}

// 派生同步目标（随主版本同步的文件）：src/manifest.json（src 域构件）+ cordis 包（不含主 package.json——
// 主是事实源，由 bump 阶段改；这里指"跟随"它的文件）
export function derivedVersionTargets() {
  return ["src/manifest.json", ...cordisPkgPaths()];
}

// 版本文件全集（含主 package.json——postbump 提交范围用：bump 已改主待提交）
export function versionCommitFiles() {
  return ["package.json", ...derivedVersionTargets()];
}

export const readPkg = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
export const writePkg = (p, data) => {
  fs.writeFileSync(path.join(ROOT, p), JSON.stringify(data, null, 2) + "\n", "utf8");
};
