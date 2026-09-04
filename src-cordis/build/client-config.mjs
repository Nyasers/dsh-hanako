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
//   require 的调用（loader 模块表注入，不内联不全局化）。
//
// 资源/编译面（client 描述可选字段，见各包 cordis.config.mjs）：
//   externals: loader 模块表 require 解析清单（默认 react 系；@dsh-hanako/view 加
//     @deepseek-ai/dsh-client-store——平台 seed，与官方 ui-layout bundle 同款外部）
//   defines:   tsdown define（编译期常量替换；各包自声明，如 view 的 DSH_CLIENT_TITLE）
// 资源内联："./x.css?inline" / "./x.svg?inline" 文本内联虚拟模块（通用文本 loader，
//   规避 tsdown css-guard：虚拟 id 不以 .css 结尾——官方同款加 .mjs 后缀）；
//   "./x.module.css"（官方 TSX 组件 CSS Modules 语义，@dsh-hanako/view vendor 官方
//   ui-layout AppFrame 等源码需要）→ css-modules 虚拟模块（默认导出 local→带前缀 class
//   映射 + 模块执行时注入 <style data-plugin-css>，纯运行时无 React 路径）。
// 环境常量：浏览器产物无 process 全局——define 把 process.env 整体替换为空对象、
// NODE_ENV=production（store 引擎 devFreeze 等按 production 走），官方
// tsdown.client.ts 同款 define 姿势；产物无源码内嵌内容字符串（全部走正常构建）。
//
// 消费方：src-cordis/build.js（package.json build:cordis）编排。
// tsdown 为 devDep（构建工具不进运行时依赖）。
import { build } from "tsdown";
import { dirname, join, resolve } from "node:path";
import { readFileSync } from "node:fs";

const INLINE_QUERY = "?inline";
const TEXT_PREFIX = "\0hanako-text:";
const CSS_PREFIX = "\0hanako-css:";
const VIRTUAL_SUFFIX = ".mjs"; // 规避 tsdown css-guard（匹配 .css 结尾 id，官方同款）

// 通用文本内联虚拟模块："./x.css?inline" / "./x.svg?inline" → export default 文本
const textInlinePlugin = {
  name: "hanako-text-inline",
  resolveId(source, importer) {
    if (!source.endsWith(INLINE_QUERY)) return null;
    if (!importer) return null;
    const abs = resolve(dirname(importer), source.slice(0, -INLINE_QUERY.length));
    return TEXT_PREFIX + abs + VIRTUAL_SUFFIX;
  },
  load(virtualId) {
    if (!virtualId.startsWith(TEXT_PREFIX)) return null;
    const file = virtualId.slice(TEXT_PREFIX.length, -VIRTUAL_SUFFIX.length);
    return "export default " + JSON.stringify(readFileSync(file, "utf8")) + ";";
  },
};

// css-modules 虚拟模块源码：class 名映射（默认导出）+ 样式文本注入 style 标签（幂等）。
// class 名加 "dv_" 前缀（dshana view；官方产物为 lightningcss [hash]_[local] 哈希名，
// 本链无哈希——前缀同样规避与全局/dsw 类名撞名）。注入点 = 模块 materialization
// （factory 执行）——官方 css-modules 同款时机（claimStyles 记账 style[data-plugin]）。
function cssModuleSource(id, fileId, css) {
  const locals = new Set();
  const prefixed = {};
  const tokenRe = /\.([A-Za-z_][A-Za-z0-9_-]*)/g;
  let m;
  while ((m = tokenRe.exec(css)) !== null) locals.add(m[1]);
  const classMap = {};
  for (const local of locals) {
    const pname = "dv_" + local;
    classMap[local] = pname;
    prefixed[local] = pname;
  }
  // 仅改写已知 local class 选择器（保留 data 属性/伪类等非 class 语法；本包 css 无
  // url()/带点字符串内容，tokenRe 替换安全——vendor 复核见 scripts/sync-vendor-layout.mjs）
  const rewritten = css.replace(/\.([A-Za-z_][A-Za-z0-9_-]*)/g, (full, name) =>
    prefixed[name] ? "." + prefixed[name] : full);
  const tagId = styleTagId(id, fileId);
  return [
    "const css = " + JSON.stringify(rewritten) + ";",
    "const tagId = " + JSON.stringify(tagId) + ";",
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    "  tag.dataset.plugin = " + JSON.stringify(id) + ";",
    "  tag.dataset.pluginCss = tagId;",
    "  tag.textContent = css;",
    "  document.head.appendChild(tag);",
    "}",
    "export default " + JSON.stringify(classMap) + ";",
  ].join("\n");
}

// style 注入去重键（data-plugin-css）：插件 id + 源文件 basename
function styleTagId(id, file) {
  const base = file.split(/[\\/]/).pop() || file;
  return id + "/" + base;
}

// css-modules 虚拟 loader："./x.module.css" → 样式注入 + class 映射（见 cssModuleSource）。
// 插件按包实例化（closure 带包 id）——style 注入的 data-plugin/data-plugin-css 标记需要
// 归属当前 client bundle 的包名（claimStyles/HMR 记账按 data-plugin 认领）。
function createCssModulePlugin(id) {
  return {
    name: "hanako-css-modules",
    resolveId(source, importer) {
      if (!source.endsWith(".module.css")) return null;
      if (!importer) return null;
      const abs = resolve(dirname(importer), source);
      return CSS_PREFIX + abs + VIRTUAL_SUFFIX;
    },
    load(virtualId) {
      if (!virtualId.startsWith(CSS_PREFIX)) return null;
      const file = virtualId.slice(CSS_PREFIX.length, -VIRTUAL_SUFFIX.length);
      const css = readFileSync(file, "utf8");
      return cssModuleSource(id, file, css);
    },
  };
}

/**
 * 打一个包的 client 半（closure-factory 自注册 bundle）。
 * @param {object} opts - { id, pkgDir, outDir, externals, defines }：id = 包名（注册与
 *   注入 style 标记用）；pkgDir = 包源码目录（entry = pkgDir/client.js）；outDir = dist
 *   目标（与 rspack 服务端半同目录共存，只写 client.js）；externals = loader 模块表
 *   require 解析清单（默认 react 系）；defines = 包级 tsdown define 常量（合并进环境
 *   默认 define）。
 */
export async function buildClientBundle({ id, pkgDir, outDir, externals = ["react", "react/jsx-runtime"], defines = {} }) {
  // 环境常量默认（官方 tsdown.client.ts clientBuildEnvironmentDefines 同款姿势：
  // 空 process.env 兜底 + 显式 NODE_ENV；浏览器无 process 全局，静态读取落到空对象即
  // undefined 不抛 ReferenceError）
  const envDefines = {
    "process.env": "{}",
    "process.env.NODE_ENV": JSON.stringify("production"),
  };
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
    define: { ...envDefines, ...defines }, // 包级 defines 覆盖环境默认（如 DSH_CLIENT_TITLE）
    deps: {
      neverBundle: (spec) => externals.includes(spec), // requested 保持外部，其余内联
    },
    plugins: [textInlinePlugin, createCssModulePlugin(id)],
    outputOptions: {
      entryFileNames: "client.js",
      banner: "window.__ModuleLoader__.load({ id: " + JSON.stringify(id) + ", factory: (require) => {",
      footer: "return module.exports; } });",
      intro: "var module = { exports: {} }; var exports = module.exports;",
    },
  });
  return { id, out: join(outDir, "client.js") };
}
