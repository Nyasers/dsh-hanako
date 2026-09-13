// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/plugins/theme/token-map.ts — DSH token → 宿主主题变量映射表（纯数据，零依赖）。
// 单独成文件的理由：index.js 顶部 import 了 assets/theme-bridge.js（默认导出由打包器注入的
// 构建期资源），普通 node 无法 import 那个模块，映射表也就没法被单测覆盖。拆出来两边共用。
//
// 纪律：右侧一律是宿主主题 CSS 变量名（~ 前缀 = 静态字面量，仅滚动条这类与主题无关的构件）。
//
// 两条容易踩的纪律：
//   ① **层次位用叠色，别拿面去顶。** dsh 靠 5% 级明度差分层（输入框 bluish-00 纯白 →
//      hover bluish-75 浅灰 → selector bluish-60），而 Hana 只有**一层** --bg-card。把
//      selector / hover-solid 这类"比底略深"的表面直接接成 --bg-card，差为 0 → 悬停与
//      静止同色、按钮与输入框融为一体。--overlay-medium 是半透明，叠在卡片上恰好还原
//      这个量级，且随主题自适应。
//   ② **结构性深浅不映射。** border-l* / tooltip-bg / toast-bg 这一族随 dsh 自己的明暗
//      翻转（或在深底上配硬编码反白字），与 Hana 的单一色相 ink-line 语义不等价；映射
//      过去只会同色化（暖底上的暖线 = 没画）或白底白字。判定一条该不该映射，要看这对
//      变量的**配对关系**，不能只看名字。

export const TOKEN_MAP = [
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
  // 反白主文字：wordmark 的 badge 文字、Toast、附件条等都在用它（漏了这一格的话，
  // 那几个地方只跟着 dsh 自己的明暗走，sidebar 品牌名处就会变色）。
  // 它读作“坐在主文字色块上的反白字”，对应 Hana 的页面底色。
  ["--dsw-alias-label-primary-inverted", "--bg"],
  ["--dsw-alias-label-tertiary", "--text-muted"],
  ["--dsw-alias-label-caption", "--text-muted"],
  ["--dsw-alias-label-dimmed", "--text-muted"],
  // border：**整族不映射**（保持 dsh 原生）。
  // 这五档不只是"画线"，还是 elevation 的描边色来源——宿主在 gradient-shadow-text.css 里把
  // --dsw-elevation-stroke-color 默认绑到 l4，Menu / InputBar / ChatView / AttachmentRail 又
  // 各自重绑 l1 / l2 / l2-darkmode-thin / l3。而 l* 是**结构性深浅线**（浅色主题黑 4–16%、
  // 深色主题白 6–20%，随明暗翻转），Hana 的 --border 却是**单一色相**的暖调 ink-line。接上去
  // 不是"变淡"而是"同色系"：暖底上的暖线等于没画，并且连带把整套 elevation（那一笔描边 +
  // panel/prominent/soft 三层投影）一起拖没。
  // 注：不映射的只有 border-l*；--dsw-alias-separator-primary / border-inverted2 /
  // button-ghost-active-border 这些**语义明确的分隔线**仍走 --border。
  // interactive
  ["--dsw-alias-interactive-bg-hover", "--accent-light"],
  ["--dsw-alias-interactive-bg-active", "--accent-light"],
  ["--dsw-alias-interactive-bg-hover-accent", "--accent-light"],
  // hover-solid 是"实色悬停底"（圆按钮等），原值 bluish-75（浅灰，比纯白深约一档），
  // 属**层次位** → 叠色（见文件头纪律①）。
  ["--dsw-alias-interactive-bg-hover-solid", "--overlay-medium"],
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
  // state 语义色：business/error/success 的 primary/secondary 之外还要覆盖 warn-* 系列——
  // DSH 自带的**连接状态指示灯**（ui-primitives 的 ConnectionIndicator，落在侧栏 footer 的
  // settings 区）用的就是它。宿主主题没有 amber 语义色（只有 --green / --danger），所以按
  // “只用宿主变量、不搬固定值”的纪律取最近的语义位：
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
  // ---- alias 层补漏 ----
  // 办法：从引擎自带的 DSH 前端 CSS/JS 反推全部 --dsw-* 用量，与 TOKEN_MAP 做差集。
  // 结论：--dsw-* 共 368 个，其中 alias 语义层 86 个（原覆盖 66）；font*、static-*、
  // elevation-/shadow-/mask、corner-shape 与 linear-* 梯度属于字体/调色板/阴影/几何，
  // 本身不随主题走，不映射也不该映射。下面补齐 alias 差额：
  ["--dsw-alias-link", "--accent"],
  ["--dsw-alias-interactive-bg-hover-danger", "--overlay-medium"],
  ["--dsw-alias-label-primary-foreground", "--bg"],
  ["--dsw-alias-label-error", "--danger"],
  ["--dsw-alias-state-warn-secondary", "--danger"],
  ["--dsw-alias-border-inverted", "--text"],
  ["--dsw-alias-border-inverted2", "--border"],
  ["--dsw-alias-separator-primary", "--border"],
  // tooltip / toast 的底**不映射**：它们看似 alias，实为"深色浮层 + 硬编码反白字"的功能性
  // 配对——原值两档都深（tooltip 浅色 bluish-850 / 深色 bluish-750，toast 800 / 750），字色是
  // static 层的 bluish-00 纯白，接成 --bg-card 便是白底白字。
  // 判据：差集只能找"漏"，判不了"该不该"——一条该不该映射，看它与配对色的关系，不看名字。
  ["--dsw-alias-bg-layer-4", "--bg-card"],
  ["--dsw-alias-bg-skeleton", "--overlay-medium"],
  ["--dsw-alias-bg-mask-photo", "--overlay-strong"],
  ["--dsw-alias-button-tool-bar-fill", "--bg-card"],
  ["--dsw-alias-button-tool-bar-hover", "--accent-light"],
  ["--dsw-alias-button-tool-bar-fill-invisible", "--bg-card"],
  ["--dsw-alias-fill-tertiary", "--overlay-medium"],
  ["--dsw-alias-fill-l2", "--overlay-medium"],
  ["--dsw-alias-fill-tsp-secondary", "--overlay-medium"],
  ["--dsw-alias-label-quaternary", "--text-muted"],
  ["--dsw-hovercard-bg", "--bg-card"],

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
  // selector 是"选择器项"的底，原值 bluish-60（略深于纯白的浅灰），同属层次位 → 叠色。
  ["--dsw-specific-selector", "--overlay-medium"],
  ["--dsw-specific-sidebar-fill", "--sidebar-bg"],
  ["--dsw-specific-sidebar-nav-item-active-accent", "--accent-light"],
  ["--dsw-specific-sidebar-nav-item-active", "--accent-light"],
  ["--dsw-specific-sidebar-nav-item-hover", "--accent-light"],
  ["--dsw-specific-tip", "--accent-light"],
];
