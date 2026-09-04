// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/syncver.mjs — 版本派生同步（manifest + cordis 包 = 主 package.json）
// 独立命令，由 package.json scripts 编排在关键点引用（单一实现，无脚本互调内联）：
//   prepack     → syncver（出包前强制：dist 复制源前源已与主一致，pack 产物自带正确版本）
//   version 钩子 → syncver（version-hook.mjs：pnpm version 算号后拼回完整版，同步派生随 bump 提交）
// 语义：pnpm version 是改版本号唯一入口（version-hook 收口）；prepack 兜底任何直 pack
// 场景（绕过 version 流程的手改主版本也在出包前被同步/校验）。幂等：已一致零写入。
// 用法：
//   node scripts/syncver.mjs            # 同步（manifest + cordis 源 = 主，幂等）
//   node scripts/syncver.mjs --check    # 只校验不一致即 exit 1（CI/门禁用）
// 派生同步目标（manifest + cordis 包）与版本读写为根级共享（scripts/version-common.mjs，
// version-hook/syncver/changelog 复用——通用构件放根级，领域特有随源码）
import { derivedVersionTargets, readPkg, writePkg } from "./version-common.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const checkOnly = args.includes("--check");

function main() {
  const pkg = readPkg("package.json");
  const version = pkg.version;
  if (typeof version !== "string" || !version) {
    console.error("[syncver] package.json version 缺失");
    process.exit(1);
  }
  const targets = derivedVersionTargets();
  const stale = [];
  for (const rel of targets) {
    const j = readPkg(rel);
    if (j.version !== version) stale.push({ rel, old: j.version });
  }
  if (checkOnly) {
    if (stale.length) {
      console.error("[syncver] 版本不同步（主 = " + version + "）：");
      for (const s of stale) console.error("  - " + s.rel + " = " + s.old);
      console.error("[syncver] 跑 node scripts/syncver.mjs 同步后提交（或走 pnpm version 发版流程）");
      process.exit(1);
    }
    console.log("[syncver] 一致（主 + " + targets.length + " 个派生目标 = " + version + "）");
    return;
  }
  let changed = 0;
  for (const s of stale) {
    const j = readPkg(s.rel);
    j.version = version;
    writePkg(s.rel, j);
    changed += 1;
    console.log("[syncver] " + s.rel + ": " + s.old + " -> " + version);
  }
  console.log(
    "[syncver] 派生版本同步：目标 " + targets.length + " 个（manifest + cordis 包），" + changed + " 个已写，均 = " + version,
  );
}

main();
