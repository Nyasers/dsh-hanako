// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/plugins/theme/assets/theme-bridge.d.ts — theme-bridge.js 的类型声明
//
// theme-bridge.js 是注入 DSH index 的浏览器脚本文本，不是 ESM 模块：service 半经
// rspack 的 asset/source 把它当**文本**内联进 bundle（见本包 index.ts 的 import）。
// 同目录同名 .d.ts 让类型层承认"默认导出是源码文本"，而不是去把那个 .js 当模块解析。

/** theme-bridge.js 的源码文本。 */
declare const source: string;
export default source;
