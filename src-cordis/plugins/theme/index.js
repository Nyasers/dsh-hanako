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
// 边界（2026-09-12 二改）：dsh preference 有**两段来源**，都在 DSH 侧语义之内——
//   ① 启动段：壳页从 DSH index 的 boot-theme 行取 `const preference = "..."`（见
//      src/ui/app-shell.js readIndexThemePreference），随主题载荷 postMessage 给桥，桥拿它
//      当自举值。官方注释把这行定位成 "the browser's pre-plugin interval"（每个 index 渲染
//      都嵌入当前持久偏好，插件树激活后 ThemePresenter 接管同一批 DOM 字段）——不借它，
//      注入完成到插件就位之间 DSH 会一直穿内置配色（空窗，她 2026-09-12 指出）。
//   ② 稳态段：我们的 client 半（client.js）把 ctx.theme 的偏好投影成
//      html[data-dsh-theme-preference]，属性出现即接管权威（桥的 readPreference 优先属性）。
//   门：system → 覆盖 Hana 配色；light/dark → 完全原生；未知 → 不动手。
//   旧的 settings/describe RPC 自读与宿主 bus 事件链保持退役（前者信封在 0.1.5 未验，
//   读不到就永远停在 system 把 UI 钉住）。
//
// 机制：经 dsh-host-webserver 的 tapIndex 扩展点，向每个 index 响应注入动态桥脚本：
//   桥向壳页索取主题变量（preference 为 system 时），写 body 层 !important 覆盖
//   （压 dsh presenter 的 body inline）。**不再注入任何静态兜底样式**：拿不到宿主主题时
//   就保持 dsh 内置 token（官方明暗），不从宿主搬一套固定值来充数（2026-09-12 她定）。
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
// 依赖注入：webServer 服务（host 半部），与 dsh-client-ui-theme 同姿势。日志直接写 cordis
// 内建 LoggerService（runtime stdout，行首带 [theme] 前缀）——@dsh-hanako/logger 已于
// 2026-09-12 随 bus 一起退役（它当时只剩三行转发，没有存在价值）。

import bridgeBody from "./assets/theme-bridge.js";

export const name = "@dsh-hanako/theme";

// alias/specific token ← 主题字段映射（~ 前缀 = 静态值，不走主题变量）。
// 右侧一律是**宿主主题 CSS 的变量名**（与 shell 的 THEME_VARS、渲染器 themes/*.css 同名）。
const TOKEN_MAP = [
  // bg 层次
  ["--dsw-alias-bg-base", "--bg"],
  ["--dsw-alias-bg-layer-1", "--bg"],
  ["--dsw-alias-bg-layer-2", "--bg-card"],
  ["--dsw-alias-bg-layer-3", "--sidebar-bg"],
  ["--dsw-alias-bg-module-platform", "--sidebar-bg"],
  ["--dsw-alias-bg-multi-select", "--accent-light"],
  ["--dsw-alias-bg-overlay", "--bg-card"],
  // bg-mask：主题化遮罩层次（mask-3 全屏深遮罩/拖放 → drop-overlay；photo 保留黑底）
  ["--dsw-alias-bg-mask-1", "--overlay-strong"],
  ["--dsw-alias-bg-mask-2", "--overlay-medium"],
  ["--dsw-alias-bg-mask-3", "--drop-overlay-bg"],
  ["--dsw-alias-bg-mask-drop", "--drop-overlay-bg"],
  // brand
  ["--dsw-alias-brand-primary", "--accent"],
  ["--dsw-alias-brand-primary-invert", "--accent"],
  ["--dsw-alias-brand-primary-new-colorprimary-new-color", "--accent"],
  ["--dsw-alias-brand-text", "--text"],
  // button
  ["--dsw-alias-button-primary-fill", "--accent"],
  ["--dsw-alias-button-primary-hover", "--accent-hover"],
  ["--dsw-alias-button-primary-dimmed", "--accent-light"],
  ["--dsw-alias-button-contrast-fill", "--accent"],
  ["--dsw-alias-button-elevated-fill", "--bg-card"],
  ["--dsw-alias-button-floating-fill", "--bg-card"],
  ["--dsw-alias-button-floating-hover", "--accent-light"],
  ["--dsw-alias-button-info-fill", "--accent"],
  ["--dsw-alias-button-info-hover", "--accent-hover"],
  ["--dsw-alias-button-ghost-active-border", "--border"],
  ["--dsw-alias-button-ghost-active-fill", "--bg-card"],
  ["--dsw-alias-button-ghost-active-hover", "--accent-light"],
  // label 三阶
  ["--dsw-alias-label-primary", "--text"],
  ["--dsw-alias-label-primary-bluish", "--accent"],
  ["--dsw-alias-label-primary-dimmed", "--text-light"],
  ["--dsw-alias-label-secondary", "--text-light"],
  // 反白主文字：wordmark 的 badge 文字、Toast、附件条等都在用它（旧表漏了这一格，
  // 于是那几个地方只跟着 dsh 自己的明暗走——2026-09-12 真机：sidebar 品牌名处就它变色）。
  // 它读作“坐在主文字色块上的反白字”，对应 Hana 的页面底色。
  ["--dsw-alias-label-primary-inverted", "--bg"],
  ["--dsw-alias-label-tertiary", "--text-muted"],
  ["--dsw-alias-label-caption", "--text-muted"],
  ["--dsw-alias-label-dimmed", "--text-muted"],
  // border（Hana 单一 ink-line；darkmode-thin 为 l2 的 dark 特化）
  ["--dsw-alias-border-l1", "--border"],
  ["--dsw-alias-border-l2", "--border"],
  ["--dsw-alias-border-l2-darkmode-thin", "--border"],
  ["--dsw-alias-border-l3", "--border"],
  ["--dsw-alias-border-l4", "--border"],
  // interactive
  ["--dsw-alias-interactive-bg-hover", "--accent-light"],
  ["--dsw-alias-interactive-bg-active", "--accent-light"],
  ["--dsw-alias-interactive-bg-hover-accent", "--accent-light"],
  ["--dsw-alias-interactive-bg-hover-solid", "--bg-card"],
  // markdown
  ["--dsw-alias-markdown-inline-code", "--accent-light"],
  ["--dsw-alias-markdown-code-block", "--bg"],
  ["--dsw-alias-markdown-code-block-banner", "--bg-card"],
  ["--dsw-alias-markdown-code-segment-selected", "--accent-light"],
  ["--dsw-alias-markdown-code-segment-unselected", "--bg"],
  ["--dsw-alias-markdown-tag", "--accent-light"],
  ["--dsw-alias-markdown-placeholder", "--accent-light"],
  ["--dsw-alias-markdown-citation", "--bg-card"],
  // state 语义色
  ["--dsw-alias-state-business-primary", "--accent"],
  ["--dsw-alias-state-business-tertiary", "--accent-light"],
  ["--dsw-alias-state-error-primary", "--danger"],
  ["--dsw-alias-state-error-secondary", "--danger"],
  ["--dsw-alias-state-success-primary", "--green"],
  ["--dsw-alias-state-success-secondary", "--green"],
  // state 语义色（2026-09-12 补全）：原来只映了 business/error/success 的 primary/secondary，
  // 结果 DSH 自带的**连接状态指示灯**（ui-primitives 的 ConnectionIndicator，落在侧栏 footer 的
  // settings 区）不跟随主题——它用的是 warn-* 系列。而宿主主题没有 amber 语义色（只有 --green /
  // --danger），所以按“只用宿主变量、不搬固定值”的纪律取最近的语义位：
  //   warn/success 的 tint 用中性遮罩 --overlay-medium 与强调浅色 --accent-light；
  //   标签色用 --danger / --green 保住“这是告警 / 这是成功”的读法。
  ["--dsw-alias-state-warn-primary", "--danger"],
  ["--dsw-alias-state-warn-label", "--danger"],
  ["--dsw-alias-state-warn-tertiary", "--overlay-medium"],
  ["--dsw-alias-state-success-label", "--green"],
  ["--dsw-alias-state-success-tertiary", "--accent-light"],
  ["--dsw-alias-state-error-label", "--danger"],
  ["--dsw-alias-state-error-tertiary", "--overlay-medium"],
  ["--dsw-alias-state-business-label", "--accent"],
  ["--dsw-alias-state-business-secondary", "--accent-light"],
  // scrollbar：复刻 Hana 原生语言（中性灰，不主题化）
  ["--dsw-alias-scrollbar-bg-l1", "~rgba(128,128,128,0.2)"],
  ["--dsw-alias-scrollbar-bg-l2", "~rgba(128,128,128,0.2)"],
  ["--dsw-alias-scrollbar-hover-l1", "~rgba(128,128,128,0.4)"],
  ["--dsw-alias-scrollbar-hover-l2", "~rgba(128,128,128,0.4)"],
  // specific 层：bubble 用 Hana userBg（accent 透明遮罩，非实色卡片）
  ["--dsw-specific-bubble-highlight", "--accent-light"],
  ["--dsw-specific-bubble", "--user-bg"],
  ["--dsw-specific-input-major", "--bg-card"],
  ["--dsw-specific-login-input", "--bg"],
  ["--dsw-specific-menu", "--sidebar-bg"],
  ["--dsw-specific-selector", "--bg-card"],
  ["--dsw-specific-sidebar-fill", "--sidebar-bg"],
  ["--dsw-specific-sidebar-nav-item-active-accent", "--accent-light"],
  ["--dsw-specific-sidebar-nav-item-active", "--accent-light"],
  ["--dsw-specific-sidebar-nav-item-hover", "--accent-light"],
  ["--dsw-specific-tip", "--accent-light"],
];

// 动态脚本：宿主声明（壳桥 vars + preference）直接应用。正文在
// assets/theme-bridge.js（自包含浏览器 JS），唯一动态点 = TOKEN_MAP 数据表注入
// （占位符 __DSH_THEME_TOKENS__ 模块初始化时替换为序列化常量）。
const BRIDGE = `<script id="@dsh-hanako/theme-bridge">
${bridgeBody.replace("__DSH_THEME_TOKENS__", JSON.stringify(TOKEN_MAP))}
</script>`;

export function apply(ctx, config) {
  ctx.inject(["webServer"], (httpCtx) => {
    httpCtx.effect(() => {
      try {
        httpCtx.webServer.tapIndex((html) => {
          if (html.includes('id="@dsh-hanako/theme-bridge"')) return html;
          return html.replace("</head>", BRIDGE + "</head>");
        });
        try { ctx.logger?.info?.("[theme] 主题注入 tapIndex 已注册"); } catch { /* 忽略 */ }
      } catch (e) {
        try { ctx.logger?.warn?.("[theme] 主题注入注册失败：" + (e?.message || e)); } catch { /* 忽略 */ }
      }
    });
  });
}
