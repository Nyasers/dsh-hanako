// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/minify-loader.mts — rspack loader：asset/source 内联前压缩前端资源
// src-cordis/plugins/*/assets 下的 js/css 以字符串进 bundle，rspack 压缩器不碰字符串内容，
// 故在 asset/source 之前经本 loader 压缩：
//   *.js  → terser（浏览器注入脚本/桥脚本）
//   *.css → clean-css
//   ＊其余（*.html 等）→ 原样放行
import { minifyJs, minifyCss } from "./minify-assets.mts";

export default async function minifyLoader(content) {
  const callback = this.async();
  try {
    const p = this.resourcePath;
    let out;
    if (p.endsWith(".css")) {
      out = minifyCss(content);
    } else if (p.endsWith(".js")) {
      out = await minifyJs(content);
    } else {
      out = content; // html 模板原样放行（含 ${...}）
    }
    callback(null, out);
  } catch (err) {
    callback(err);
  }
}
