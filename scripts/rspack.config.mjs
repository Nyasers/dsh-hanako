// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/rspack.config.mjs — dsh-hanako 单 bundle 构建配置（独立配置文件，不随源码编译）
// 与 hana-remote-dev 的 rspack.config.mjs 对齐，按 dsh-hanako 实际适配：
//   - 单入口 src/index.js → 单产物 dist/index.js（生命周期+7 工具+lib+路由+前端资产全部收敛）
//   - 输出 ESM module（纯 ESM 无原生模块，不需要 CJS+loadBundle 沙箱；宿主直接 import）
//   - library.type=module：入口具名导出（pluginRoutes）真 emit 成 ESM export，
//     dist/routes/index.js 壳 import bundle 转发；default 导出插件类（宿主 new + onload）
//   - asset/source：src/assets 下前端资源（webui-shell.jinja2 / card-op|dep.jinja2 模板 + card.js /
//     card.css），模板经 template-loader（doT）编译为自包含渲染函数，js/css 经 minify-loader 压缩内联
//   - externalsPresets.node：node 内置模块保持外部 import（零运行时依赖）
// rspack 解析路径走 scripts/build.mjs 的 resolveRspackEntry（RSPACK_ENV 或本地 node_modules）
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = path.join(root, "dist");

export default {
  name: "dsh-hanako",
  mode: "production",
  target: "node",
  entry: path.join(root, "src", "index.js"),
  output: {
    path: DIST_DIR,
    filename: "index.js",
    module: true,
    clean: true,
    library: { type: "module" },
  },
  experiments: { outputModule: true },
  externalsPresets: { node: true },
  module: {
    rules: [
      {
        // HTML 模板：构建期经 template-loader（doT）编译为自包含渲染函数（ESM 默认导出）。
        // 产物不含 doT（零运行时依赖，dependencies 恒空）；每请求直接调用渲染函数。
        // 模板语法见 template-loader.mjs 头注释（{{= it.xxx }} 等，it = render scope）。
        test: /\.jinja2$/, // 模板文件用 .jinja2 扩展名（避免静态检查器按 HTML 误报 {{= }} 语法）
        include: [path.join(root, "src", "assets")],
        use: [path.join(root, "scripts", "template-loader.mjs")],
        // 显式 JS 模块类型：loader 输出 ESM 渲染函数，必须按 JS 解析（rspack 默认把未知
        // 扩展名当 asset module，import 会得到 { jinja2: ... } 命名对象而非默认导出函数）
        type: "javascript/esm", // 强制 ESM 语义：loader 输出 ESM（export default/具名），避免 rspack 对大模块走 CJS interop
      },
      {
        // 其余前端资产（js/css）：asset/source 内联为字符串（构建机路径零泄漏）。
        // minify-loader（terser / clean-css）压缩后内联。
        test: /\.(js|css)$/,
        include: [path.join(root, "src", "assets")],
        use: [path.join(root, "scripts", "minify-loader.mjs")],
        type: "asset/source",
      },
    ],
  },
  // usedExports: false + sideEffects: false —— 关闭导出级 tree-shaking（同旧 build.mjs
  // 纪律：入口导出无外部消费者会被整体摇成空壳，插件本体全部保留）
  optimization: { minimize: true, usedExports: false, sideEffects: false },
  devtool: false,
  node: false,
  stats: "minimal",
};
