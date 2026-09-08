// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/build.js — 主 bundle（src 域）构建入口（App v2 交付形态）
// 布局：领域专用脚本随各自源码——rspack.config.mjs（本目录，配置源）与本入口放 src/，
// 共享工具（collect/walk/terser/assert + minify/template loader）在 scripts/（根级）。
// 产物（dist/ = App 安装目录形态，迁移指南 §3；宿主读 dist 根 manifest.json + entry）：
//   manifest.json       App v2 manifest（entry "index.js" / icon "assets/icon.png"）
//   index.js            rspack 单 bundle（入口具名导出 apply + default.apply）
//   assets/icon.png     App 身份图标（manifest.icon 指向的包内真实图片）
//   skills/             App skills（dsh-hanako / dsh-session，SKILL.md 随包分发）
//   （runtime/、ui/ 等目录在后续迁移步骤按需归位——DSH 受管进程入口与 UI 资产）
// v1 遗留变化：不再生成 dist/routes/index.js 壳（v1 宿主按 routes/ 目录扫描具名导出
// pluginRoutes；v2 路由走 ctx.routes.register 单 route app，宿主不扫 dist 目录）。
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
const DIST_DIR = join(ROOT, "dist");

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

// 主 bundle 编译（rspack output.clean 清空 dist 后写入 dist/index.js）
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
rewriter(DIST_DIR);

// 2) App 交付目录组装（dist 根 = App 安装目录；manifest/skills/icon 与入口 index.js 同层）
fs.copySync(join(ROOT, "src", "manifest.json"), join(DIST_DIR, "manifest.json"));
fs.copySync(join(ROOT, "src", "skills"), join(DIST_DIR, "skills"));
// App 图标：src/assets/icon.png 为唯一规范源（manifest.icon "assets/icon.png"）；
// 依赖部署（DSH node_modules 随包 vs dataDir）未定案，后续步骤决定 assets/ 是否并入
// runtime/ 目录一并打包（届时 icon 路径不变，仍相对 App 安装根）。
const iconSrc = join(ROOT, "src", "assets", "icon.png");
if (!fs.pathExistsSync(iconSrc))
  throw new Error("App 图标缺失（src/assets/icon.png）：manifest.icon 指向 assets/icon.png，需真实可解码图片");
fs.copySync(iconSrc, join(DIST_DIR, "assets", "icon.png"));
console.log("manifest.json + skills/ + assets/icon.png -> dist/（App v2 安装目录形态）");

// 3) 二次 terser（主区）+ 静态 URL 断言
await extraTerser(DIST_DIR);
assertNoStaticFileUrl(DIST_DIR);
console.log("build:src done ->", DIST_DIR);
