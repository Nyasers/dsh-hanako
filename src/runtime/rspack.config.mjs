// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/rspack.config.mjs — 受管 runtime 入口 bundle 构建配置（runtime/ 域）
// 产物：dist/runtime/dsh-host.mjs（ESM，宿主 ctx.runtime.start({ runtime:"node", entry:
// "runtime/dsh-host.mjs" }) 直接以 node 执行；entry 相对 App 安装根）。
//
// 打包纪律（迁移指南 §7 + 交付物 4）：
//   - @deepseek-ai/*（dsh/cordis/dsh-* 官方插件树）**不静态打进**：它们装在 App dataDir
//     依赖区（<data-dir>/runtime/，首启 pnpm 安装，方案见 DESIGN「依赖部署（v2）」），
//     运行时才可解析——dsh 定位/动态 import 一律 /* webpackIgnore: true */ 保留原生
//     import()（见 src/runtime/locate.js 与 main.js）；
//   - @hana/app-sdk 的 connectAppRuntime 运行时实现来自 devDependencies（file:./sdk/
//     hana-app-sdk.tgz，0.930.0，Apache-2.0，来源与许可声明见 THIRD_PARTY_NOTICES.md），
//     经静态 import 由本 bundle 内联（只依赖 node:crypto，无运行时包解析——bundle 后
//     不依赖 App 能解析 @hana/app-sdk 包）；
//   - node 内建外部 import（externalsPresets.node）；src/lib/profile-seed.js、
//     src/lib/pnpm.js 等零宿主依赖叶子模块随 bundle 内联（pnpm 引导复用 v1 实现）。
//   - 不做 library 命名导出：入口只 self-run（main()），宿主只认 stdout readyMarker/退出码。
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))); // src/runtime/ → 仓库根
const DIST_DIR = path.join(root, "dist");

export default {
  name: "dsh-hanako-runtime",
  mode: "production",
  target: "node",
  entry: path.join(root, "src", "runtime", "main.js"),
  output: {
    path: path.join(DIST_DIR, "runtime"),
    filename: "dsh-host.mjs",
    module: true,
    clean: false, // 主 bundle 已 clean 整树；这里只追加 runtime/ 产物
  },
  experiments: { outputModule: true },
  externalsPresets: { node: true },
  optimization: { minimize: true, usedExports: false, sideEffects: false },
  devtool: false,
  node: false,
  stats: "errors-warnings",
};
