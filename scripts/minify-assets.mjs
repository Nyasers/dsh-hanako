// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/scripts/minify-assets.mjs — 资源压缩共享逻辑（单一事实源，学 hana-remote-dev）
// 两处消费，压缩参数只维护一份：
//   minify-loader.mjs（rspack asset/source 内联前压缩 src/assets 前端资源）
import { minify } from "terser";
import CleanCSS from "clean-css";

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
