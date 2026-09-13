// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/rspack.config.mts — dshana 主 bundle 构建配置（src 域：随源码根，见布局原则\n// 「领域专用脚本随各自源码」；.mjs 不被 collectSource 收集，不随 bundle 打包）
// 与 hana-remote-dev 的 rspack.config.mts 对齐，按 dshana 实际适配：
//   - 单入口 src/index.js → 单产物 dist/index.js（生命周期 + dshana 工具 + lib + 路由全部收敛）
//   - 输出 ESM module（纯 ESM 无原生模块，不需要 CJS+loadBundle 沙箱；宿主直接 import）
//   - library.type=module：入口具名导出（apply）真 emit 成 ESM export，宿主直接 import
//   - src/assets 只剩 icon.png（App 图标，由 build.ts 原样 copy，不进 bundle）；v1 的 jinja2
//     模板与 card.js/css 已随 W6 清理删除，本配置不再需要 asset 规则
//   - externalsPresets.node：node 内置模块保持外部 import（零运行时依赖）
// rspack 解析路径走 scripts/build.mjs 的 resolveRspackEntry（RSPACK_ENV 或本地 node_modules）
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = path.join(root, "dist");

export default {
  name: "dshana",
  mode: "production",
  target: "node",
  entry: path.join(root, "src", "index.ts"),
  output: {
    path: DIST_DIR,
    filename: "index.js",
    module: true,
    clean: true,
    library: { type: "module" },
  },
  experiments: { outputModule: true },
  externalsPresets: { node: true },
  // v1 的 assets 前端资源（jinja2 模板 + card.js/css）已随 W6 清理删除，无需 asset/source 与
  // template-loader 规则（src/assets 只剩 icon.png，由 build.ts 原样 copy，不进 bundle）。
  // usedExports: false + sideEffects: false —— 关闭导出级 tree-shaking（入口导出无外部
  // 消费者会被整体摇成空壳，插件本体全部保留）
  optimization: { minimize: true, usedExports: false, sideEffects: false },
  devtool: false,
  node: false,
  stats: "minimal",
};
