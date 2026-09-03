// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/client-chain.mjs — cordis 子插件「client 半」打包链（tsdown，学官方 dsh）
// 第二条构建链路：src → 插件本体 bundle（rspack）；src-cordis 子插件服务端入口
// （index.js）→ rspack（scripts/cordis.config.mjs）；子插件浏览器端 client 源 →
// tsdown 打 closure-factory 自注册 bundle。与官方 dsh clientBundle 预设同构：
//   format cjs + outputOptions intro/banner/footer →
//     intro:  var module = { exports: {} }; var exports = module.exports;
//     banner: window.__ModuleLoader__.load({ id: "<pkg>", factory: (require) => {
//     footer: return module.exports; } });
//   产物 = client bundle（__ModuleLoader__ 按包名注册，exports 落 module.exports），
//   react / react/jsx-runtime 等走 external → 编译为对 factory 参数 require 的调用
//   （loader 模块表注入，不内联不全局化）。资源（CSS/SVG 等）经 ?inline 文本内联
//   虚拟模块进模块图（本链自备 textInlinePlugin，规避 tsdown css-guard：虚拟 id 不
//   以 .css 结尾——官方同款处理加 .mjs 后缀）。产物无源码内嵌内容字符串。
// 消费方：build.mjs buildCordis 后段（两链合一产出 dist/cordis）；tsdown 为 devDep
// （构建工具不进运行时依赖）。
import { build } from "tsdown";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_PLUGINS = join(ROOT, "src-cordis", "plugins", "@dsh-hanako");
const OUT_PLUGINS = join(ROOT, "dist", "cordis", "node_modules", "@dsh-hanako");

// client 链清单：有浏览器端 client 源且需要构建的包（源 = <pkg>/client.js ESM；
// 产物 = <pkg>/client.js closure-factory）。bridge 的 client.js 为无内容字符串的
// vendor 手写包，保持散装复制 + pack terser，不进本链。
const CLIENTS = [
  { id: "@dsh-hanako/settings", pkg: "settings" },
];

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

/** 跑 client 链：逐包 tsdown 打 closure-factory client bundle 到 dist 目标目录。 */
export async function buildClientBundles() {
  for (const { id, pkg } of CLIENTS) {
    const entry = join(SRC_PLUGINS, pkg, "client.js");
    const outDir = join(OUT_PLUGINS, pkg);
    await build({
      name: id + "/client",
      entry: { client: entry },
      outDir,
      format: "cjs",
      platform: "browser",
      dts: false,
      clean: false, // 与 rspack 服务端半同目录：只写 client.js，不清理 index.js/package.json
      sourcemap: false,
      minify: true, // 与 rspack 链 minimize 对齐：产物即时压缩（rolldown 压缩器）；pack terser 二次压缩兜底
      // loader 模块表注入 require 解析（官方 deps.neverBundle 语义）：requested 保持外部
      // （react / react/jsx-runtime），其余全部内联进 bundle
      deps: {
        neverBundle: (spec) => spec === "react" || spec === "react/jsx-runtime",
      },
      plugins: [textInlinePlugin],
      outputOptions: {
        entryFileNames: "client.js",
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
        footer: "return module.exports; } });",
        intro: "var module = { exports: {} }; var exports = module.exports;",
      },
    });
    console.log(`client bundle -> ${pkg}/client.js（${id}，tsdown closure-factory）`);
  }
}
