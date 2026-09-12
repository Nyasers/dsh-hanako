// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/ui/rspack.config.mjs — 壳页脚本 bundle 构建配置（ui 域）
// 产物：dist/ui/app-shell.js（卡壳页，ESM，`<script type="module" src="./app-shell.js">`）
// 与 dist/ui/settings.js（App 自己的设置页脚本，同理）。
//
// 打包纪律：
//   - 浏览器 SDK @hana/plugin-sdk 从 devDependencies 解析（file:vendor/hana-app-sdk/
//     hana-plugin-sdk-0.0.0.tgz 的浏览器构建 dist/browser.js），由 rspack 静态打进产物。
//     浏览器 ESM 不解析裸包名（宿主不注入 importmap），故**不由页面裸 import**、也不在
//     dist/ui 另放一份 vendored 拷贝——依赖来源单一（包管理器），产物自包含。
//   - target: "web"（无 node 内置、无 node polyfill）；源码是纯浏览器 ESM（无 node 依赖）。
//   - 入口无导出（自执行脚本）：不设 library，产物只做副作用执行。
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))); // src/ui/ → 仓库根
const DIST_DIR = path.join(root, "dist");

const ui = (f) => path.join(root, "src", "ui", f);

export default {
  name: "dshana-ui",
  mode: "production",
  target: "web",
  entry: {
    "app-shell": ui("app-shell.ts"),
    settings: ui("settings.ts"),
  },
  output: {
    path: path.join(DIST_DIR, "ui"),
    filename: "[name].js",
    module: true,
    clean: false, // 主 bundle 已 clean 整树；这里只写 ui/*.js（静态页由 build.js copy）
  },
  experiments: { outputModule: true },
  optimization: { minimize: true, usedExports: false, sideEffects: false },
  devtool: false,
  stats: "errors-warnings",
};
