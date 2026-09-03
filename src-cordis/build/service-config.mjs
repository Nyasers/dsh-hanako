// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/build/service-config.mjs — cordis 子插件服务端半共享 preset（rspack）
// 学官方 dsh 组织：每包自持构建描述（plugins/@dsh-hanako/<pkg>/cordis.config.mjs），
// 共享 preset 层消费描述生成实际打包配置。本模块 = 原 scripts/cordis.config.mjs
// 单包逻辑的参数化提取（两源两产物：src → 插件本体；src-cordis → 子插件包）。
//
// 服务端半（service 半）：包 index.js 为 entry 打 ESM bundle（cordis loader 按
// package.json main=index.js 原生 import，具名导出 name/inject/provide/apply 保留
// 即无感知）；内部模块合并；assets/ 独立资源（浏览器注入脚本等）经 minify-loader
// + asset/source 内联；node 内建外部 import；provider 动态 import(变量) 靠源码
// /* webpackIgnore */ 保留原生运行时导入。
//
// preset 签名：serviceBundle({ name, pkgDir, outDir, rules?, optimization? })，返回
// rspack 单包配置对象（纯数据，不含 rspack import；rspack 本体由编排侧 scripts/build.mjs
// 统一解析，RSPACK_ENV / 本地 node_modules 两路）。opts 覆盖口供特殊包逃生。
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))); // src-cordis/build → repo 根
const MINIFY_LOADER = path.join(ROOT, "scripts", "minify-loader.mjs");

export function serviceBundle({ name, pkgDir, outDir, rules = [], optimization = {} }) {
  const assetsDir = path.join(pkgDir, "assets");
  return {
    name: `cordis/${name}`,
    mode: "production",
    target: "node",
    entry: path.join(pkgDir, "index.js"),
    output: {
      path: outDir,
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
        ...rules, // 包级覆盖/追加口（特殊包自定义 loader/规则）
      ],
    },
    optimization: { minimize: true, usedExports: false, sideEffects: false, ...optimization },
    devtool: false,
    node: false,
    stats: "errors-warnings",
  };
}
