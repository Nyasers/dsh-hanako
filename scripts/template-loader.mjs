// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/template-loader.mjs — rspack loader：HTML 模板构建期编译（doT）
// 目标：构建期把 src/assets/*.jinja2 编译成「自包含渲染函数」JS 模块，运行时零依赖。
// 源码 .jinja2 原样保留（含注释/多行，可读），一切处理只发生在编译期（本 loader 内对模板
// 内容副本操作，不写回源文件）。
//
// 压行安全（编译期）：doT 默认 strip:true 把模板压成单行 —— 壳页模板 <script> 内的多行 JS 中，
// 行注释 // … 在单行里会吞掉其后代码（v0.15.3 回归：壳页主题桥/剪贴板桥/轮询被吞，内层 iframe 的
// DSH WebUI 不跟随主题）。故编译前对 <script> 块做词法注释剥离（strip-js-comments.mjs：字符串/
// 正则内不误删，注释以空格原位替换），随后 strip:true 压行 —— 删除注释在编译期完成，源文件零
// 改动，产物保留单行体积收益且无吞码风险。
// 为何不用 terser 剥注释：模板 <script> 内含 doT 插值 {{= it.xxx }}，terser 将其解析为非法 JS
// 直接报 Unexpected token；strip-js-comments 是字符级处理（只识别 /*、// 与字符串边界），对
// {{ }} 无感，天然兼容模板语法。
import dot from "dot";
import { stripJsComments } from "./strip-js-comments.mjs";

export default async function templateLoader(content) {
  const callback = this.async();
  try {
    const p = this.resourcePath;
    if (!p.endsWith(".jinja2")) {
      callback(null, content);
      return;
    }
    // 编译期预处理：仅对 <script> 块内 JS 剥注释（字符串内不误删）；HTML/CSS/{{ }} 插值段不动
    const cleaned = String(content).replace(
      /<script([^>]*)>([\s\S]*?)<\/script>/g,
      (m, attrs, body) =>
        "<script" + attrs + ">" + stripJsComments(body) + "</script>",
    );
    dot.templateSettings.strip = true;
    let fn;
    try {
      fn = dot.template(cleaned);
    } catch (err) {
      throw new Error("doT 模板编译失败（" + p + "）：" + err.message);
    }
    const body = fn.toString();
    // 输出 default+具名导出 render：大模板未被内联时走模块引用，具名导出避免 default interop 歧义
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
