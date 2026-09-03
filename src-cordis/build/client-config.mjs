// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/build/client-config.mjs — cordis 子插件 client 半共享 preset（tsdown）
// 学官方 dsh（packages/client/tsdown.client.ts clientBundle 预设）：每包自持构建描述
// （plugins/<pkg>/cordis.config.mjs 的 client 字段），本 preset 生成并执行
// tsdown 打包。输出 closure-factory 自注册 client bundle：
//   format cjs + outputOptions intro/banner/footer →
//     intro:  var module = { exports: {} }; var exports = module.exports;
//     banner: window.__ModuleLoader__.load({ id: "<pkg>", factory: (require) => {
//     footer: return module.exports; } });
//   产物 = client bundle（__ModuleLoader__ 按包名注册，exports 落 module.exports）；
//   externals（react / react/jsx-runtime 等）保持外部 → 编译为对 factory 参数
//   require 的调用（loader 模块表注入，不内联不全局化）；资源（CSS/SVG）经 ?inline
//   文本内联虚拟模块进模块图（规避 tsdown css-guard：虚拟 id 不以 .css 结尾——官方
//   同款加 .mjs 后缀）。产物无源码内嵌内容字符串（全部走正常构建）。
//
// 消费方：scripts/build.mjs 编排（扫描各包 cordis.config.mjs → 本 preset build）。
// tsdown 为 devDep（构建工具不进运行时依赖）。
import { build } from "tsdown";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INLINE_QUERY = "?inline";
const VIRTUAL_PREFIX = "\0hanako-text:";
const VIRTUAL_SUFFIX = ".mjs"; // 规避 tsdown css-guard（匹配 .css 结尾 id，官方同款）

// 通用文本内联虚拟模块：`./x.css?inline` / `./x.svg?inline` → export default 文本
const textInlinePlugin = {
  name: "hanako-text-inline",
  resolveId(source, importer) {
    if (!source.endsWith(INLINE_QUERY)) return null;
    if (!importer) return null;
    const abs = resolve(dirname(importer), source.slice(0, -INLINE_QUERY.length));
    return VIRTUAL_PREFIX + abs + VIRTUAL_SUFFIX;
  },
  load(virtualId) {
    if (!virtualId.startsWith(VIRTUAL_PREFIX)) return null;
    const file = virtualId.slice(VIRTUAL_PREFIX.length, -VIRTUAL_SUFFIX.length);
    return `export default ${JSON.stringify(readFileSync(file, "utf8"))};`;
  },
};

/**
 * 打一个包的 client 半（closure-factory 自注册 bundle）。
 * @param {object} opts - { id, pkgDir, outDir, externals }：id = 包名（注册与注入
 *   style 标记用）；pkgDir = 包源码目录（entry = pkgDir/client.js）；outDir = dist 目标
 *   （与 rspack 服务端半同目录共存，只写 client.js）；externals = loader 模块表
 *   require 解析清单（默认 react 系）。
 */
export async function buildClientBundle({ id, pkgDir, outDir, externals = ["react", "react/jsx-runtime"] }) {
  await build({
    name: id + "/client",
    entry: { client: join(pkgDir, "client.js") },
    outDir,
    format: "cjs",
    platform: "browser",
    dts: false,
    clean: false,
    sourcemap: false,
    minify: true, // 与 rspack 链 minimize 对齐：产物即时压缩（pack terser 二次压缩兜底）
    deps: {
      neverBundle: (spec) => externals.includes(spec), // requested 保持外部，其余内联
    },
    plugins: [textInlinePlugin],
    outputOptions: {
      entryFileNames: "client.js",
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: "return module.exports; } });",
      intro: "var module = { exports: {} }; var exports = module.exports;",
    },
  });
  return { id, out: join(outDir, "client.js") };
}
