// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/cordis.config.mjs — @dsh-hanako/* cordis 子插件打包配置（多 entry 数组配置）
// 与 scripts/rspack.config.mjs（主 bundle）同风格，按 cordis 生态适配：
//   - 8 个子插件各一个 entry（index.js 服务端入口）→ 各自输出回
//     dist/cordis/node_modules/@dsh-hanako/<pkg>/index.js（cordis loader 按 package.json
//     main=index.js 原生 import，bundle 具名导出 name/inject/provide/apply 保留即无感知）
//   - 输出 ESM module（library.type=module），externalsPresets.node（node 内建保持
//     外部 import，零运行时依赖）
//   - asset/source：各包 assets/ 下的独立资源（clipboard-bridge.js / theme-bridge.js
//     等浏览器注入脚本）经 minify-loader 压缩后内联为字符串——源码文件化、产物自包含，
//     替代旧「运行时 fs.readFileSync 读文件」形态（review 修订 2026-09-04）
//   - 内部模块（bus 的 ws-lib.js 等）随依赖图合并进 bundle；client.js（bridge/settings
//     的浏览器端手写 __ModuleLoader__ bundle，非 ESM）不进 rspack，由 buildCordis 原样
//     复制 + pack terser（客户端打包链是另一课题）
//   - provider 的动态 import(变量) 依赖 /* webpackIgnore */ 保留原生运行时 import
//     （源码已带注释，见 provider/index.js loadDeps）
// rspack 解析路径走 scripts/build.mjs 的 resolveRspackEntry（RSPACK_ENV 或本地）
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGINS_DIR = path.join(ROOT, "src-cordis", "plugins", "@dsh-hanako");
const OUT_ROOT = path.join(ROOT, "dist", "cordis", "node_modules", "@dsh-hanako");
const MINIFY_LOADER = path.join(ROOT, "scripts", "minify-loader.mjs");

const PKGS = fs
  .readdirSync(PLUGINS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

// 每包一个配置；资产规则 include 只命中本包 assets/ 目录（client.js/ws-lib.js 在包根，
// 不进 asset 规则——client.js 保留为文件，ws-lib.js 由依赖图按代码合并）
export default PKGS.map((name) => {
  const pkgDir = path.join(PLUGINS_DIR, name);
  const assetsDir = path.join(pkgDir, "assets");
  return {
    name: `cordis/${name}`,
    mode: "production",
    target: "node",
    entry: path.join(pkgDir, "index.js"),
    output: {
      path: path.join(OUT_ROOT, name),
      filename: "index.js",
      module: true,
      clean: false, // 前置已整树清空 dist/cordis；clean 会误删同目录 package.json/client.js
      library: { type: "module" },
    },
    experiments: { outputModule: true },
    externalsPresets: { node: true },
    module: {
      rules: [
        {
          // 浏览器注入脚本等独立资源（assets/ 下 js/css）：minify-loader 压缩后
          // asset/source 内联为字符串（与主 bundle src/assets 同款规则/loader）。
          test: /\.(js|css)$/,
          include: [assetsDir],
          use: [MINIFY_LOADER],
          type: "asset/source",
        },
      ],
    },
    optimization: { minimize: true, usedExports: false, sideEffects: false },
    devtool: false,
    node: false,
    stats: "errors-warnings",
  };
});
