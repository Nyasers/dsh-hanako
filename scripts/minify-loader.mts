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
import { errText } from "./err-text.mts";

/**
 * rspack loader 上下文里本 loader 用到的字段（不 import @rspack/core：本仓根级 node_modules
 * 下没有它，types 解析不到会多出一条 Cannot find module）。用注解代替隐式 this，
 * 同时把这个窄形状写清楚。
 */
interface MinifyLoaderContext {
  resourcePath: string;
  async(): (err: Error | null, content?: string) => void;
}

export default async function minifyLoader(this: MinifyLoaderContext, content) {
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
    // rspack 的 async 回调只认 Error | null，而 catch 到的值类型未知：非 Error 就包一层
    callback(err instanceof Error ? err : new Error(errText(err)));
  }
}
