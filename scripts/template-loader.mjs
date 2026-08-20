// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/template-loader.mjs — rspack loader：HTML 模板构建期编译（doT + html-minifier-terser）
// 目标：构建期把 src/assets/*.jinja2 编译成「自包含渲染函数」JS 模块，运行时零依赖
// （bundle 不含任何模板库），dependencies 恒空；产物只是普通渲染函数。
//
// 编译期处理（源文件 .jinja2 零改动）：
// 1. html-minifier-terser 先对模板整体压缩：
//    - ignoreCustomFragments 保护 doT 插值 {{= it.xxx }} / {{ }}（整体占位，不动）
//    - minifyJS（terser，compress/mangle 全关）压缩 <script>：正确移除 JS 行注释，
//      不会出现 `单行 + // 注释吞掉其后代码`（v0.15.3/0.15.4 回归根因：壳页主题桥/
//      剪贴板桥/轮询被吞，内层 iframe DSH WebUI 不跟随主题）
//    - collapseWhitespace 压成单行（体积最优）
// 2. 压缩结果交给 doT 编译为自包含渲染函数（产物无模板引擎引用）。
// 为何用手写词法不行：JS 含正则字面量内的引号（如 /</ g 等）会让手写状态机串态；
// html-minifier-terser 内嵌 terser 是成熟 JS 解析器，字符串/正则边界完美。
import dot from "dot";
import { minify as htmlMinify } from "html-minifier-terser";

export default async function templateLoader(content) {
  const callback = this.async();
  try {
    const p = this.resourcePath;
    if (!p.endsWith(".jinja2")) {
      callback(null, content);
      return;
    }
    // 编译期压缩：保护 {{ }} 插值 + terser 剥 JS 注释 + 压行
    const minified = await htmlMinify(String(content), {
      ignoreCustomFragments: [/{{[\s\S]*?}}/],
      collapseWhitespace: true,
      removeComments: true,
      minifyJS: { compress: false, mangle: false },
      minifyCSS: false,
    });
    dot.templateSettings.strip = true;
    let fn;
    try {
      fn = dot.template(minified);
    } catch (err) {
      throw new Error("doT 模板编译失败（" + p + "）：" + err.message);
    }
    const body = fn.toString();
    const out =
      "function render" +
      body.slice(body.indexOf("(")) +
      "\n" +
      "export { render };" +
      "\n";
    callback(null, out);
  } catch (err) {
    callback(err);
  }
}
