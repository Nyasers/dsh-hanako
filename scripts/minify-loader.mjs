// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/scripts/minify-loader.mjs — rspack loader：asset/source 内联前压缩前端资源
// src/assets/*.js/css 以字符串进 bundle，rspack 压缩器不碰字符串内容，故在
// asset/source 之前经本 loader 压缩：
//   card.js  → terser（纯语法级，浏览器脚本直接执行）
//   card.css → clean-css
//   *.jinja2 / *.html → 原样放行（模板文件由 template-loader 专门处理，本 loader 不触碰）
import { minifyJs, minifyCss } from "./minify-assets.mjs";

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
