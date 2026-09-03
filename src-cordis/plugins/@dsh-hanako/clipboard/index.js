// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/clipboard — dsh Web UI 剪贴板桥（v0.13.3）。
//
// 语义：嵌入场景（DSHana 标签页）下，dsh 页面内 navigator.clipboard.writeText 会被
// 宿主插件 iframe 的 Permissions-Policy 继承链拦截（宿主插件 iframe 与宿主主窗口
// 跨源且无 allow 属性 → 整棵子树 clipboard deny；内层 iframe 自身声明 allow 无法
// 覆盖父级 inherited deny，见 CHANGELOG v0.13.2/0.13.3）。本插件经 dsh-host-webserver
// 的 tapIndex 扩展点注入覆盖脚本，把写入失败转接到插件壳页面（postMessage）→ 壳页面
// 经宿主 capability clipboard.writeText（DSHana manifest ui.hostCapabilities 白名单）
// 写剪贴板 → 宿主主窗口上下文执行 navigator.clipboard，不受插件 iframe 权限链限制。
//
// 机制：
//   1) tapIndex 向每个 index 响应注入 <script id="@dsh-hanako/clipboard-bridge">
//   2) 桥脚本仅嵌入场景启用（window.parent !== window）；顶层直接浏览 dsh UI 时
//      clipboard 原生可用（self policy），桥保持静默（零行为差异）
//   3) 覆盖 navigator.clipboard.writeText：先试原生（宿主未来放宽 iframe 权限后
//      原生即成功，桥自动退场，不浪费 user activation），失败（NotAllowedError）
//      走桥：MessageChannel 回执 + 2.5s 超时
//
// 注入脚本内容文件化（review 修订）：桥脚本正文存独立文件 clipboard-bridge.js
// （本目录，随包分发；cordis 子插件散装分发不经 rspack，运行时 readFileSync 读取），
// index.js 只保留包装与注入逻辑——与主 bundle assets/* 文件化、profile 种子模板
// 文件化同一原则。文件缺失/读取失败时降级：不注册桥（嵌入场景复制失败不转接，
// 其余零行为差异），warn 记日志。
//
// 与 bundle patch 方案的取舍：tapIndex 是 dsh web server 稳定扩展点，dsh 升级后
// 注入机制不变（bundle hash 无关）；覆盖点在 Clipboard 实例方法层，覆盖所有
// navigator.clipboard.writeText 调用点（不限于单一复制函数），且不修改任何
// node_modules 文件。
//
// 配套：壳页面桥在 routes/webui.js（hostRequest + __dshCopy 监听），manifest
// ui.hostCapabilities 声明 clipboard.writeText。缺壳页面桥时桥消息无人响应 →
// 2.5s 超时 reject → dsh UI 显示复制失败（不静默假装成功）。

import { readFileSync } from "node:fs";

export const name = "@dsh-hanako/clipboard";

const BRIDGE_ID = '@dsh-hanako/clipboard-bridge';

// 桥脚本正文（独立文件，本目录随包分发）。模块顶层读一次；缺失/失败 → null，
// apply 内降级（不注册 tapIndex，warn 记录）——嵌入复制不转接，原生路径不受影响。
let bridgeScript = null;
let bridgeLoadError = null;
try {
  bridgeScript = readFileSync(new URL("./clipboard-bridge.js", import.meta.url), "utf8");
} catch (e) {
  bridgeLoadError = (e && e.message) || e;
}

export function apply(ctx) {
  if (bridgeScript === null) {
    try {
      ctx.logger?.warn?.(`[@dsh-hanako/clipboard] 桥脚本读取失败，clipboard 桥未注册：${bridgeLoadError}`);
    } catch { /* 忽略 */ }
    return;
  }
  ctx.inject(["webServer"], (httpCtx) => {
    httpCtx.effect(() => {
      try {
        httpCtx.webServer.tapIndex((html) => {
          if (html.includes(`id="${BRIDGE_ID}"`)) return html;
          return html.replace("</head>", `<script id="${BRIDGE_ID}">\n${bridgeScript}</script>\n</head>`);
        });
      } catch (e) {
        try { ctx.logger?.warn?.(`[@dsh-hanako/clipboard] tapIndex 注册失败：${e?.message || e}`); } catch { /* 忽略 */ }
      }
    });
  });
}
