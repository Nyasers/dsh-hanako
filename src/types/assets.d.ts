// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/types/assets.d.ts — 非代码资产的导入声明
//
// 构建期这些导入由 rspack 的 asset / css 规则接管（样式抽文件、文本内联），到不了 JS
// 语义层，所以类型层要单独承认"这类导入存在"。缺了它编辑器会在每个 `import "*.css"`
// 上标红（tsc 的 TS2307 只计入日志，不拦闸，但红字会淹没真问题）。

/** 样式导入：rspack 抽出 / 内联，模块侧无导出。 */
declare module "*.css";
