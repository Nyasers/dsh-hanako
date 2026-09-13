// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dshana/clipboard 前端 client 半。
//
// 影子本体与安装逻辑在 src/ui/clipboard-shadow.ts，由**壳页**在注入 DSH 之前装
// （全局 + 最早）——那里才是能保证生效的位置。本 client 半只保留一次幂等的补装：
//   · DSH 的 client 插件按 boot manifest 的 immediately 决定是否启动时激活，装得晚；
//   · 壳页那次安装已经就位时，这里的调用是空操作（installClipboardShadow 幂等）。
// 保留它的价值：壳页那条路万一没走成（例如未来换了注入形态），这里还有一次机会。
//
// 依赖方向：本文件 import src/ui/clipboard-shadow.ts（同一份实现的唯一副本，不复制逻辑）。
// 约束：只在浏览器面加载；无 navigator 的构建/测试环境直接跳过。

import { installClipboardShadow } from "../../../src/ui/clipboard-shadow.js";

export function apply(ctx) {
  if (typeof navigator === "undefined" || navigator.clipboard === undefined || navigator.clipboard === null) return;
  const install = () => installClipboardShadow({ target: globalThis, bridge: globalThis.__DSHANA__ });
  if (typeof ctx.effect === "function") {
    ctx.effect(() => install(), 'clipboard: shell-level global shadow (idempotent)');
    return;
  }
  install();
}
