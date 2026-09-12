// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/minify-assets.mts — 资源压缩共享逻辑（单一事实源）
// 三个消费方，压缩参数只维护一份：
//   minify-loader.mts（rspack asset/source 内联前压缩 src/assets 前端资源）
//   build-common.mts 的 extraMinify（rspack 产物二次压缩：JS 与静态壳页 HTML）
//   （前两个之外还有测试直接调）
import { minify } from "terser";
import CleanCSS from "clean-css";
import { minify as minifyHtmlSource } from "html-minifier-terser";

/** JS 压缩：terser，module 语义（保留 ESM 语法，普通脚本同样适用） */
export async function minifyJs(content) {
  const r = await minify(content, { module: true });
  return r.code;
}

/** CSS 压缩：clean-css level 2，出错即抛（fail-closed） */
export function minifyCss(content) {
  const r = new CleanCSS({ level: 2 }).minify(content);
  if (r.errors.length) throw new Error(`clean-css: ${r.errors.join("; ")}`);
  return r.styles;
}

/** 标签名序列（用于压缩前后结构比对）：先把注释剥掉——注释里的例样标签本就应该消失。 */
function tagsOf(html) {
  const bare = html.replace(/<!--[\s\S]*?-->/g, "");
  return (bare.match(/<[a-zA-Z][a-zA-Z0-9-]*/g) || []).map((s) => s.toLowerCase().slice(1)).join(",");
}

/**
 * HTML 压缩：只做去注释与收空白。
 *
 * 不动内联 <style>/<script>（它们由 minifyCss/minifyJs 各自负责，在这里顺手动它们容易改语义），
 * 也不动属性引号、标签顺序；空白按保守方式收（留一个空格），不冒把行内文字粘起来的脸。
 * 压缩前后标签名序列必须一致，变了就是动了结构，当场失败（壳页里跑的是 DSH 的 UI，
 * 少一个标签就是另一个页面）。
 */
export async function minifyHtml(content) {
  const out = await minifyHtmlSource(content, {
    removeComments: true,
    collapseWhitespace: true,
    conservativeCollapse: true,
    minifyCSS: false,
    minifyJS: false,
    removeAttributeQuotes: false,
    sortAttributes: false,
    sortClassName: false,
  });
  const before = tagsOf(content);
  const after = tagsOf(out);
  if (before !== after) throw new Error("html-minifier 改了标签结构（压缩前后标签序列不一致），拒绝写出");
  return out;
}
