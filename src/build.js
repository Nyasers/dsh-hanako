// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/build.js — 主 bundle（src 域）构建入口
// 布局：领域专用脚本随各自源码——rspack.config.mjs（本目录，配置源）与本入口放 src/，
// 共享工具（collect/walk/terser/assert + minify/template loader）在 scripts/（根级）。
// 产物：dist/index.js（单 bundle：v2 apply 入口 + 工具 + lib + 前端资源，内联 src/assets）
//     + dist/manifest.json（src/manifest.json 复制）+ dist/icon.svg（v2 App icon）+ dist/skills。
//     v2 不再生成 dist/routes/index.js 路由壳——v2 App 的路由在 apply() 内经
//     ctx.routes.register 注册（见 src/index.js），旧宿主 routes/ 扫描面已退役。
// 用法：node src/build.js [RSPACK_ENV=<构建环境目录>]
// 注意：.mjs 不被 collectSource 收集（只收 .js），本文件不随 bundle 打包。
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import fs from "fs-extra";
import config from "./rspack.config.mjs"; // 同目录（src 域配置随源码）
import {
  collectSource,
  makeUrlRewriter,
  extraTerser,
  assertNoStaticFileUrl,
} from "../scripts/build-common.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // src/ → 仓库根

// rspack 解析：RSPACK_ENV 指向构建环境（推荐），否则本地 node_modules
function resolveRspackEntry(coreDir) {
  const pkg = JSON.parse(fs.readFileSync(join(coreDir, "package.json"), "utf8"));
  const dot = pkg.exports?.["."];
  let entry = null;
  if (typeof dot === "string") entry = dot;
  else if (dot && typeof dot === "object") entry = dot.default ?? dot.import ?? dot.require;
  if (!entry) entry = pkg.main ?? "dist/index.js";
  return join(coreDir, entry);
}
let rspackPkg;
const envDir = process.env.RSPACK_ENV;
if (envDir) {
  rspackPkg = await import(
    pathToFileURL(resolveRspackEntry(join(envDir, "node_modules", "@rspack", "core"))).href,
  );
} else {
  rspackPkg = await import("@rspack/core");
}
const rspack = rspackPkg.rspack ?? rspackPkg.default?.rspack;

// src 域源码收集（供 URL 回写）
const rewriter = makeUrlRewriter(collectSource(join(ROOT, "src")));

// 主 bundle 编译
const compiler = rspack(config);
await new Promise((resolvePromise, reject) => {
  compiler.run((err, stats) => {
    compiler.close(() => { });
    if (err) return reject(err);
    if (stats?.hasErrors()) return reject(new Error(stats.toString({ errors: true })));
    console.log(stats?.toString({ colors: true, chunks: false, modules: false, assets: true }));
    resolvePromise();
  });
});

// 1) 静态化路径字面量回写（dist 主区）
rewriter(join(ROOT, "dist"));

// 2) src 域构件复制（→ dist 根）：manifest.json + icon.png（v2 App 必需 icon，
// 与 manifest entry 同目录）+ skills/（SKILL 随 src 分发；v2 下经 App 运行时可读区/后续
// 接线分发，先保留复制不动）
fs.copySync(join(ROOT, "src", "manifest.json"), join(ROOT, "dist", "manifest.json"));
fs.copySync(join(ROOT, "src", "icon.png"), join(ROOT, "dist", "icon.png"));
fs.copySync(join(ROOT, "src", "skills"), join(ROOT, "dist", "skills"));
console.log("manifest.json + icon.png + skills -> dist/");

// 4) 二次 terser（主区）
await extraTerser(join(ROOT, "dist"));
assertNoStaticFileUrl(join(ROOT, "dist"));
console.log("build:src done ->", join(ROOT, "dist"));
