// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/ui/rspack.config.mts — 壳页脚本 bundle 构建配置（ui 域）
// 产物：dist/ui/app-shell.js（壳页，ESM，`<script type="module" src="./app-shell.js">`）
// 与 dist/ui/settings.js（App 自己的设置页脚本，同理），以及被 import 的样式
// dist/ui/<name>.css（页面用 <link> 引入）。
//
// 打包纪律：
//   - 浏览器 SDK @hana/plugin-sdk 与组件库 @hana/plugin-components 从 devDependencies 解析
//     （file:vendor/hana-app-sdk/*.tgz），由 rspack 静态打进产物。浏览器 ESM 不解析裸包名
//     （宿主不注入 importmap），故不由页面裸 import、也不在 dist/ui 另放一份 vendored
//     拷贝——依赖来源单一（包管理器），产物自包含。
//   - target: "web"（无 node 内置、无 node polyfill）；源码是纯浏览器 ESM（无 node 依赖）。
//   - .ts/.tsx 交给内置 swc 转译，JSX 走 automatic runtime（源码不需要 import React）。
//   - 样式走 rspack 内置 css 支持，按入口产出同名 .css。
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
    settings: ui("settings.tsx"),
  },
  output: {
    path: path.join(DIST_DIR, "ui"),
    filename: "[name].js",
    cssFilename: "[name].css",
    module: true,
    clean: false, // 主 bundle 已 clean 整树；这里只写 ui/*（静态页由 build.ts copy）
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: "builtin:swc-loader",
          options: {
            jsc: {
              parser: { syntax: "typescript", tsx: true },
              transform: { react: { runtime: "automatic", development: false } },
              target: "es2022",
            },
          },
        },
      },
      // 样式按入口抽出同名 .css（outputModule 下不注入 style，必须抽文件）。
      { test: /\.css$/, type: "css" },
    ],
  },
  experiments: { outputModule: true },
  optimization: {
    minimize: true,
    // 按导出裁剪对 ui 域没有意义：组件库是单模块、预打包产物（40 个具名导出在一个
    // 模块里），实测开关前后只差 0.6KB。而它会把组件自己的类名映射一并削掉，
    // 所以关着。
    usedExports: false,
    // 关掉按 package.json sideEffects 做的裁剪：样式 import 是副作用，
    // 不因为包没声明 sideEffects 就被整棵摇掉。
    sideEffects: false,
  },
  // 体积预算：宿主组件库（React + react-dom + settings 组件）与宿主自己的设置样式表
  // 就是这一页的体积构成，两者之和就是合理上限。默认的 300KiB/500KiB 是给走网络的
  // 页面定的，对本地 WebView 页没有指导意义；写明上限后，"真的超了"仍然是信号。
  performance: {
    maxAssetSize: 900 * 1024,
    maxEntrypointSize: 1600 * 1024,
  },
  devtool: false,
  stats: "errors-warnings",
};
