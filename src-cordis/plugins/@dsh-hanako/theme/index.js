// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/theme — 把 Hana 宿主主题「全量配色」注入 dsh Web UI（v0.8.1）。
//
// 语义：嵌入场景（DSHana 标签页）下 dsh 始终使用 Hana 配色——
//   明暗：经壳页面 color-scheme 传导（dsh preference=system 时解析宿主明暗）
//   配色：注入脚本接收壳桥回传的「宿主声明」——壳页面 html[data-theme] 使
//     theme.css 变量生效，getComputedStyle 读到当前主题 16 个变量的渲染值。
//     随宿主更新：宿主切主题 → dataset.theme 变 → 插件 iframe 重载 → 壳桥
//     回传新值；宿主新增/修改主题无需插件更新（无静态主题表）。
// 边界：dsh preference 经 settings/describe 读取（加载时一次回读 + 变更事件驱动——
//   vY T7b 后 0.1.2 无旧 /api/events.host WS；vZ 起事件化：宿主侧 bridge 订阅
//   remote.mux $events 的 settings/document-updated（ui-theme）→ 总线 → /webui/events
//   → 壳页 postMessage dshHanaPref → 注入脚本重读一次，替代早期 3s 轮询）。
//   system → 覆盖 Hana 配色；light/dark → 完全原生。
//
// 机制：经 dsh-host-webserver 的 tapIndex 扩展点，向每个 index 响应注入：
//   1) 静态 <style>：无脚本/桥失败时的默认主题 fallback
//   2) 动态脚本：postMessage 向壳页面索取 { themeId, vars }，preference 为
//      system 时写 body 层 !important 覆盖（压 dsh presenter 的 body inline）
//
// 注入脚本内容文件化 + 打包内联（review 修订）：桥脚本正文存独立文件
// assets/theme-bridge.js（纯浏览器 JS），经 rspack asset/source 内联进本包
// bundle（preset 见 src-cordis/build/service-config.mjs）。桥脚本唯一动态点是数据表注入占位符
// __DSH_THEME_TOKENS__（TOKEN_MAP 序列化），模块初始化时一次 replace 替换——
// 与主 bundle src/assets 内联同架构，无运行时文件 IO。
//
// 覆盖范围：dsh --dsw-alias-* + --dsw-specific-* 中「视觉主表面」全映射
// （bg 层次/遮罩/文字三阶/brand/button/border/interactive/markdown/state/
// specific 组件/滚动条），功能性颜色保留原生（mask-photo 黑底、danger/warn
// 语义色、toast/tooltip 深色浮层、工具栏半透明、反白文字/边框、骨架屏）。
//
// 依赖注入：webServer 服务（host 半部），与 dsh-client-ui-theme 同姿势；统一日志经
// @dsh-hanako/logger 服务（inject ['hanaLogger']）写入本次会话日志（行格式 [theme]）。

import bridgeBody from "./assets/theme-bridge.js";

export const name = "@dsh-hanako/theme";
export const inject = ["hanaLogger"];

// 默认主题 fallback（Hana 默认 new-warm-paper；仅桥不可用时兜底）
const DEFAULT_THEME = {
  bg: "#F5EFE4",
  bgCard: "#FBF7EE",
  sidebarBg: "#EFE8DB",
  text: "#2A2622",
  textLight: "#4A433C",
  textMuted: "#6B6158",
  accent: "#537D96",
  accentHover: "#3F6179",
  accentLight: "rgba(83,125,150,0.08)",
  border: "#D8CFBE",
  green: "#4A6B4A",
  danger: "#8B2C1F",
  userBg: "rgba(83,125,150,0.08)",
  overlayStrong: "rgba(42,38,34,0.15)",
  overlayMedium: "rgba(42,38,34,0.08)",
  dropOverlayBg: "rgba(245,239,228,0.85)",
};

// alias/specific token ← 主题字段映射（~ 前缀 = 静态值，不走主题字段）
const TOKEN_MAP = [
  // bg 层次
  ["--dsw-alias-bg-base", "bg"],
  ["--dsw-alias-bg-layer-1", "bg"],
  ["--dsw-alias-bg-layer-2", "bgCard"],
  ["--dsw-alias-bg-layer-3", "sidebarBg"],
  ["--dsw-alias-bg-module-platform", "sidebarBg"],
  ["--dsw-alias-bg-multi-select", "accentLight"],
  ["--dsw-alias-bg-overlay", "bgCard"],
  // bg-mask：主题化遮罩层次（mask-3 全屏深遮罩/拖放 → drop-overlay；photo 保留黑底）
  ["--dsw-alias-bg-mask-1", "overlayStrong"],
  ["--dsw-alias-bg-mask-2", "overlayMedium"],
  ["--dsw-alias-bg-mask-3", "dropOverlayBg"],
  ["--dsw-alias-bg-mask-drop", "dropOverlayBg"],
  // brand
  ["--dsw-alias-brand-primary", "accent"],
  ["--dsw-alias-brand-primary-invert", "accent"],
  ["--dsw-alias-brand-primary-new-colorprimary-new-color", "accent"],
  ["--dsw-alias-brand-text", "text"],
  // button
  ["--dsw-alias-button-primary-fill", "accent"],
  ["--dsw-alias-button-primary-hover", "accentHover"],
  ["--dsw-alias-button-primary-dimmed", "accentLight"],
  ["--dsw-alias-button-contrast-fill", "accent"],
  ["--dsw-alias-button-elevated-fill", "bgCard"],
  ["--dsw-alias-button-floating-fill", "bgCard"],
  ["--dsw-alias-button-floating-hover", "accentLight"],
  ["--dsw-alias-button-info-fill", "accent"],
  ["--dsw-alias-button-info-hover", "accentHover"],
  ["--dsw-alias-button-ghost-active-border", "border"],
  ["--dsw-alias-button-ghost-active-fill", "bgCard"],
  ["--dsw-alias-button-ghost-active-hover", "accentLight"],
  // label 三阶
  ["--dsw-alias-label-primary", "text"],
  ["--dsw-alias-label-primary-bluish", "accent"],
  ["--dsw-alias-label-primary-dimmed", "textLight"],
  ["--dsw-alias-label-secondary", "textLight"],
  ["--dsw-alias-label-tertiary", "textMuted"],
  ["--dsw-alias-label-caption", "textMuted"],
  ["--dsw-alias-label-dimmed", "textMuted"],
  // border（Hana 单一 ink-line；darkmode-thin 为 l2 的 dark 特化）
  ["--dsw-alias-border-l1", "border"],
  ["--dsw-alias-border-l2", "border"],
  ["--dsw-alias-border-l2-darkmode-thin", "border"],
  ["--dsw-alias-border-l3", "border"],
  ["--dsw-alias-border-l4", "border"],
  // interactive
  ["--dsw-alias-interactive-bg-hover", "accentLight"],
  ["--dsw-alias-interactive-bg-active", "accentLight"],
  ["--dsw-alias-interactive-bg-hover-accent", "accentLight"],
  ["--dsw-alias-interactive-bg-hover-solid", "bgCard"],
  // markdown
  ["--dsw-alias-markdown-inline-code", "accentLight"],
  ["--dsw-alias-markdown-code-block", "bg"],
  ["--dsw-alias-markdown-code-block-banner", "bgCard"],
  ["--dsw-alias-markdown-code-segment-selected", "accentLight"],
  ["--dsw-alias-markdown-code-segment-unselected", "bg"],
  ["--dsw-alias-markdown-tag", "accentLight"],
  ["--dsw-alias-markdown-placeholder", "accentLight"],
  ["--dsw-alias-markdown-citation", "bgCard"],
  // state 语义色
  ["--dsw-alias-state-business-primary", "accent"],
  ["--dsw-alias-state-business-tertiary", "accentLight"],
  ["--dsw-alias-state-error-primary", "danger"],
  ["--dsw-alias-state-error-secondary", "danger"],
  ["--dsw-alias-state-success-primary", "green"],
  ["--dsw-alias-state-success-secondary", "green"],
  // scrollbar：复刻 Hana 原生语言（中性灰，不主题化）
  ["--dsw-alias-scrollbar-bg-l1", "~rgba(128,128,128,0.2)"],
  ["--dsw-alias-scrollbar-bg-l2", "~rgba(128,128,128,0.2)"],
  ["--dsw-alias-scrollbar-hover-l1", "~rgba(128,128,128,0.4)"],
  ["--dsw-alias-scrollbar-hover-l2", "~rgba(128,128,128,0.4)"],
  // specific 层：bubble 用 Hana userBg（accent 透明遮罩，非实色卡片）
  ["--dsw-specific-bubble-highlight", "accentLight"],
  ["--dsw-specific-bubble", "userBg"],
  ["--dsw-specific-input-major", "bgCard"],
  ["--dsw-specific-login-input", "bg"],
  ["--dsw-specific-menu", "sidebarBg"],
  ["--dsw-specific-selector", "bgCard"],
  ["--dsw-specific-sidebar-fill", "sidebarBg"],
  ["--dsw-specific-sidebar-nav-item-active-accent", "accentLight"],
  ["--dsw-specific-sidebar-nav-item-active", "accentLight"],
  ["--dsw-specific-sidebar-nav-item-hover", "accentLight"],
  ["--dsw-specific-tip", "accentLight"],
];

function tokenCss(v) {
  return TOKEN_MAP.map(
    ([t, k]) => `${t}:${k[0] === "~" ? k.slice(1) : v[k]}!important`,
  ).join(";");
}

// 静态 fallback 写 body 层（压 presenter inline）；脚本启动即移除，仅无脚本时兜底
const STATIC = `<style id="@dsh-hanako/theme">
body{${tokenCss(DEFAULT_THEME)}}
</style>`;

// 动态脚本：宿主声明（壳桥 vars）直接应用 + preference 边界。正文在
// assets/theme-bridge.js（自包含浏览器 JS），唯一动态点 = TOKEN_MAP 数据表注入
// （占位符 __DSH_THEME_TOKENS__ 模块初始化时替换为序列化常量）。
const BRIDGE = `<script id="@dsh-hanako/theme-bridge">
${bridgeBody.replace("__DSH_THEME_TOKENS__", JSON.stringify(TOKEN_MAP))}
</script>`;

export function apply(ctx, config) {
  ctx.inject(["webServer", "hanaLogger"], (httpCtx) => {
    httpCtx.effect(() => {
      try {
        httpCtx.webServer.tapIndex((html) => {
          if (html.includes('id="@dsh-hanako/theme"')) return html;
          return html.replace("</head>", STATIC + BRIDGE + "</head>");
        });
        httpCtx.hanaLogger.log("theme", "主题注入 tapIndex 已注册");
      } catch (e) {
        httpCtx.hanaLogger.log("theme", `主题注入注册失败：${e?.message || e}`);
        try {
          ctx.logger?.warn?.(
            `[@dsh-hanako/theme] tapIndex 注册失败：${e?.message || e}`,
          );
        } catch {
          /* 忽略 */
        }
      }
    });
  });
}
