// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/ide-tsconfig.mts — 生成 src-integrations/tsconfig.paths.json（编辑器用路径映射）
//
// 为什么需要：src-integrations/<集成>/files/src/... 是"寄居"在上游包里的覆盖层——它 import 的
// @deepseek-ai/dsh-client-* 那批包，一部分本仓没装（只在 vendor 镜像里有源）。编辑器打开覆盖
// 文件时解析不到就一片红。逐条手写映射不可行：包名（dsh-client-ui-slots）与镜像目录
// （packages/client/ui-slots）不成规律。
//
// 映射口径与 scripts/overlay-typecheck.mts 的 mirrorPathEntries 同源（一律以上游源为准，
// 避免 .pnpm 产物与镜像源混用聚合出两套插槽契约）。产物是给编辑器继承的，判定仍以
// overlay-typecheck 在暂存树里跑的口径为准。
//
// 用法：node scripts/ide-tsconfig.mts   （vendor 更新后重跑）
import { writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { mirrorPathEntries } from "./overlay-typecheck.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIRROR = join(ROOT, "vendor", "deepseek-harness");
const HIDDEN = join(ROOT, "node_modules", ".pnpm", "node_modules");
const OUT_DIR = join(ROOT, "src-integrations");
const OUT = join(OUT_DIR, "tsconfig.paths.json");

const toOut = (abs) => relative(OUT_DIR, abs).replace(/\\/g, "/");

const paths = {
  // 本仓装了的包照旧走 pnpm 隐藏目录（与根 tsconfig 同口径）。
  "*": [toOut(join(HIDDEN, "*"))],
};

for (const [name, targets] of Object.entries(mirrorPathEntries(MIRROR, HIDDEN))) {
  paths[name] = targets.map(toOut);
}

const out = {
  "//": "由 node scripts/ide-tsconfig.mts 生成，勿手改（vendor 更新后重跑）。供 src-integrations/<集成>/tsconfig.json 继承。",
  compilerOptions: { paths },
};

writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log(`[ide-tsconfig] 已写入 ${toOut(OUT)}（${Object.keys(paths).length} 条映射）`);
