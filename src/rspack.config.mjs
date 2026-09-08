// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/rspack.config.mjs — dsh-hanako 主 bundle 构建配置（src 域：随源码根；.mjs 不被 collectSource 收集）
//
// 双入口（v2 第 2 步起）：
//   ① index            → dist/index.js          App 主入口（apply(ctx) 注册面 + 工具 + lib + 路由 + 前端资产）
//   ② runtime/dsh-host → dist/runtime/dsh-host.mjs  受管 native runtime 入口（DSH runProfile 承载；
//      manifest 之外的独立进程入口，由 ctx.runtime.start 的 entry 参数按 installDir 相对路径拉起）
//   两个入口各自内联依赖（splitChunks: false）——受管 runtime 进程只加载 dsh-host 需要的模块，
//   不把 App 路由/前端资产带进去。
//
// 其余约束与 v1 一致：
//   - 输出 ESM module（宿主直接 import；受管 runtime 以 node 直接执行 .mjs）
//   - library.type=module：主入口具名导出 apply 真 emit 成 ESM export，default 同指 apply
//   - asset/source：src/assets 下前端资源（jinja2 模板经 template-loader 编译、js/css 经 minify-loader 压缩）
//   - externalsPresets.node：node 内置模块保持外部 import（零运行时依赖）
//   - src/runtime/ 的声明三件套（package.json / pnpm-workspace.yaml / pnpm-lock.yaml）不是打包产物，
//     由 src/build.js 直接复制进 dist/runtime/（见该文件「src 域构件复制」）
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST_DIR = path.join(root, "dist");

export default {
  name: "dsh-hanako",
  mode: "production",
  target: "node",
  entry: {
    index: path.join(root, "src", "index.js"),
    "runtime/dsh-host": path.join(root, "src", "runtime", "dsh-host.mjs"),
  },
  output: {
    path: DIST_DIR,
    // 主入口保持 index.js（manifest.entry）；受管 runtime 入口保持 .mjs（dsh-host.mjs，
    // 与 ctx.runtime.start({ entry: "runtime/dsh-host.mjs" }) 及 args 约定同名）
    filename: (pathData) =>
      pathData.chunk.name === "index" ? "index.js" : pathData.chunk.name + ".mjs",
    module: true,
    // clean: false —— 产物区清理改由 src/build.js 精确执行（只清 src 域产物）。理由：
    // rspack 的 clean 会连 dist/cordis 一起删（build:cordis 的产物，属另一条命令），
    // 单独跑 build:src 时会让 profile 的 scope 源凭空消失（boot 失败）。clean.keep 实测不生效。
    clean: false,
    library: { type: "module" },
  },
  experiments: { outputModule: true },
  externalsPresets: { node: true },
  module: {
    rules: [
      {
        // HTML 模板：构建期经 template-loader（doT）编译为自包含渲染函数（ESM 默认导出）。
        // 产物不含 doT（零运行时依赖）；每请求直接调用渲染函数。
        test: /\.jinja2$/,
        include: [path.join(root, "src", "assets")],
        use: [path.join(root, "src", "template-loader.mjs")],
        type: "javascript/esm",
      },
      {
        // 其余前端资产（js/css）：asset/source 内联为字符串，minify-loader 压缩后内联。
        test: /\.(js|css)$/,
        include: [path.join(root, "src", "assets")],
        use: [path.join(root, "scripts", "minify-loader.mjs")],
        type: "asset/source",
      },
    ],
  },
  // usedExports: false + sideEffects: false —— 关闭导出级 tree-shaking（入口导出无外部消费者
  // 会被整体摇成空壳）；splitChunks/runtimeChunk 关闭 —— 两个入口各自自包含（见文件头）
  optimization: {
    minimize: true,
    usedExports: false,
    sideEffects: false,
    splitChunks: false,
    runtimeChunk: false,
  },
  devtool: false,
  node: false,
  stats: "minimal",
};
