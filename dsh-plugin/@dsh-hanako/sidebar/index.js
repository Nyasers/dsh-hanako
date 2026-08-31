// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/sidebar — DSH WebUI sidebar 进宿主侧栏桥（v1.0.1-alpha.1）。
//
// 语义：DSHana v2 整页卡（fpFullPanel）场景下，「宿主左侧栏 = Full FP 功能面板」。
// 目标布局：宿主侧栏显示 dsh Web UI 完整 sidebar（functionPanel.embedUrl loopback
// iframe，?dshana=sidebar），主页面隐藏自身 sidebar（?dshana=main）→ 拼成
// 「宿主侧栏 = dsh sidebar，主区 = dsh center/details」的三列布局。
//
// 机制：与 @dsh-hanako/theme 同姿势——经 dsh-host-webserver 的 tapIndex 扩展点，
// 向每个 index 响应注入一个自包含脚本（幂等：检测已有标记则跳过）。脚本按
// location.search 的 dshana 参数分支：
//   · 无参数：零动作，正常 dsh UI 行为不变（顶层浏览器直开 3080 不受影响）。
//   · ?dshana=sidebar（宿主侧栏 iframe，宽 180-400px 必窄屏 → sidebar 折叠成 rail）：
//     等待 AppFrame 挂载 → 定位 sidebar 列（div[data-slot="sidebar"] 或其祖先 frame）
//     → 若折叠态：模拟点击 rail 展开 toggle（aria-label toggle.open/collapse 语义，
//     class 含 toggle / logoRow 结构兜底）触发 narrowExpanded=true → CSS !important
//     覆盖 frame grid-template-columns 为单轨道（minmax(0,1fr) 0 0）+ display:none
//     隐藏 center/details 等非 sidebar 元素 → sidebar 占满 iframe。
//   · ?dshana=main（主页面 iframe）：隐藏 sidebar 列（display:none + grid 首轨道 0）
//     → center 占满；details 保留并跟随 React 宽度变化（MutationObserver 重放覆盖）。
//
// 依据（dsh client-ui-layout AppFrame 0.1.1-rc.2 已核实）：三列 grid frame inline
// gridTemplateColumns（"<s>px minmax(0, 1fr) <d>px"）+ data-sidebar-collapsed /
// data-details-collapsed 语义属性；SIDEBAR_AUTO_COLLAPSE=1024 窄屏折叠；narrow 下
// toggleSidebar 翻转 narrowExpanded，而 narrowExpanded 只在 setNarrow（narrow 值变化）
// 时重置——宿主侧栏宽度固定 → narrow 恒定 → 展开后状态钉住。data-slot="sidebar"
// 为任务契约列特征（新版本语义化属性；当前版本无则走 frame 属性/结构兜底）。
//
// 样式纪律：脚本内不硬编码颜色（不涉及配色）；宽度覆盖用 CSS 变量/继承原 class
// 不引入新主题。错误处理：AppFrame 未渲染/找不到元素时静默轮询（上限 ~30s），
// 到达上限安静停住，不报错不阻断 dsh 正常功能。

export const name = "@dsh-hanako/sidebar";

const BRIDGE = `<script id="@dsh-hanako/sidebar">
(function () {
  // dshana 侧栏桥（v1.0.1-alpha.1）——「宿主侧栏 = dsh sidebar，主区 = dsh center/details」。
  // 两个 dsh Web UI 实例以 URL 参数区分模式（无参数 = 原生行为，本脚本零动作）：
  //   ?dshana=sidebar  → 宿主功能面板 iframe（180-400px 窄宽）：强制展开 sidebar 并占满 iframe
  //   ?dshana=main     → 主页面卡片 iframe：隐藏 sidebar 列，center/details 占满主区
  //
  // 依据（dsh client-ui-layout AppFrame，0.1.1-rc.2 已核实）：
  //   - 三列 grid frame：inline gridTemplateColumns = "<s>px minmax(0, 1fr) <d>px"，
  //     子列依次为 sidebarCol | centerCol | detailsCol | overlayLayer([data-shell-overlay])，
  //     frame 带 data-sidebar-collapsed / data-details-collapsed 语义属性（稳定）。
  //   - 窄屏折叠：SIDEBAR_AUTO_COLLAPSE=1024，viewport<1024 → narrow → rail（56px 图标轨）；
  //     展开控件 = sidebar root 内的 toggle 按钮（class 含 toggle，aria-label 为 toggle.open/
  //     toggle.collapse 译文，onClick → toggleSidebar()）。
  //   - narrowExpanded 仅在 setNarrow 触发（narrow 值变化）时重置；宿主侧栏宽度固定 →
  //     narrow 恒定 → 展开后状态钉住，不会自愈回折叠。
  //   - 兜底选择器（任务契约）：div[data-slot="sidebar"]（新版本 dsh 的语义化列特征）。
  // 样式策略：React 每次重渲染会重写 frame inline gridTemplateColumns —— 用
  // style.setProperty(..., "important") 压过 React inline（非 important），
  // 并挂 MutationObserver（attributeFilter:["style"]）在 React 更新后重放覆盖，保持响应式。
  // 容错：AppFrame 未挂载/元素缺失时静默轮询（上限 ~30s），到达上限安静停住，不报错不阻断。
  var MODE = (function () {
    try {
      return new URLSearchParams(window.location.search).get("dshana");
    } catch (e) { return null; }
  })();
  if (MODE !== "main" && MODE !== "sidebar") return;

  var CSS_ID = "@dsh-hanako/sidebar-css";
  var MAX_ATTEMPTS = 60;   // 500ms × 60 = 30s
  var RETRY_MS = 500;
  var attempts = 0;
  var started = false;
  var observer = null;
  var watchdog = null;

  // 注入/复用样式节点（幂等；多次执行/页面重载不会重复叠加）。
  // 静态 CSS 覆盖稳定语义属性（data-side / data-slot 契约），与元素级 setProperty 双保险。
  function styleEl() {
    var st = document.getElementById(CSS_ID);
    if (!st) {
      st = document.createElement("style");
      st.id = CSS_ID;
      st.setAttribute("data-dshana-sidebar", "1");
      if (document.head) document.head.appendChild(st);
    }
    var css = "";
    if (MODE === "sidebar") {
      css = "[data-side=\"sidebar\"],[data-side=\"details\"]{display:none!important}" +
            "[data-slot=\"sidebar\"]{width:100%!important}" +
            "[data-slot=\"sidebar\"]>*{width:100%!important}";
    } else {
      css = "[data-side=\"sidebar\"]{display:none!important}" +
            "[data-slot=\"sidebar\"]{display:none!important}";
    }
    if (st.textContent !== css) st.textContent = css;
    return st;
  }

  // 定位 AppFrame 三列 grid frame 与 sidebar 列元素。
  // 优先任务契约 data-slot；其次 frame 语义属性；最后结构扫描（inline grid 三列）。
  function findFrame() {
    // 1) 契约：div[data-slot="sidebar"]（新版本语义化列特征）→ 向上找 frame
    var slot = null;
    try { slot = document.querySelector('[data-slot="sidebar"]'); } catch (e) { slot = null; }
    if (slot) {
      var el = slot;
      while (el && el.parentElement) {
        var gtc = el.style ? el.style.gridTemplateColumns : "";
        if (el.hasAttribute && (el.hasAttribute("data-sidebar-collapsed") || el.hasAttribute("data-details-collapsed") || /minmax\(\s*0\s*,\s*1fr\s*\)/.test(gtc || ""))) {
          return { frame: el, sidebar: slot, viaSlot: true };
        }
        el = el.parentElement;
      }
      return { frame: slot.parentElement, sidebar: slot, viaSlot: true };
    }
    // 2) frame 语义属性（data-sidebar-collapsed / data-details-collapsed 由 AppFrame 设置）
    try {
      var f2 = document.querySelector('[data-sidebar-collapsed], [data-details-collapsed]');
      if (f2 && f2.firstElementChild) return { frame: f2, sidebar: f2.firstElementChild, viaSlot: false };
    } catch (e) { /* 忽略 */ }
    // 3) 结构扫描：inline gridTemplateColumns 含 minmax(0, 1fr) 的三列容器
    try {
      var all = document.querySelectorAll("div");
      for (var i = 0; i < all.length; i++) {
        var f = all[i];
        if (f.children.length < 3) continue;
        var s = f.style ? f.style.gridTemplateColumns : "";
        if (/minmax\(\s*0\s*,\s*1fr\s*\)/.test(s || "")) {
          return { frame: f, sidebar: f.firstElementChild, viaSlot: false };
        }
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  function isCollapsed(found) {
    try {
      if (found.frame.hasAttribute && found.frame.hasAttribute("data-sidebar-collapsed")) return true;
      var sb = found.sidebar;
      if (sb && sb.classList && sb.classList.contains("hHd-Xa_collapsed")) return true;
      if (sb && sb.querySelector && sb.querySelector(".hHd-Xa_collapsed")) return true;
      if (sb && sb.getBoundingClientRect) {
        var w = sb.getBoundingClientRect().width;
        if (w > 0 && w < 120) return true;
      }
    } catch (e) { /* 忽略 */ }
    return false;
  }

  // 点击展开控件：折叠态（rail）下 sidebar root 内只有 toggle 一个按钮带
  // toggle.open/collapse 语义 aria-label；兜底按结构（class 含 toggle / logoRow 按钮）。
  function clickExpand(found) {
    var sb = found.sidebar;
    if (!sb || !sb.querySelectorAll) return false;
    var toggle = null;
    // 1) aria-label 语义（toggle.open/toggle.collapse 译文，含 open/collapse/sidebar/展开/侧栏）
    try {
      var btns = sb.querySelectorAll('button[aria-label]');
      for (var i = 0; i < btns.length; i++) {
        var label = String(btns[i].getAttribute("aria-label") || "").toLowerCase();
        if (label.indexOf("open") !== -1 || label.indexOf("collapse") !== -1 ||
            label.indexOf("sidebar") !== -1 || label.indexOf("侧栏") !== -1 || label.indexOf("展开") !== -1) {
          toggle = btns[i];
          break;
        }
      }
    } catch (e) { /* 忽略 */ }
    // 2) 结构兜底：class 含 toggle / logoRow 内按钮
    if (!toggle) {
      try { toggle = sb.querySelector('button[class*="toggle"]'); } catch (e) { /* 忽略 */ }
    }
    if (!toggle) {
      try { toggle = sb.querySelector('.hHd-Xa_logoRow button'); } catch (e) { /* 忽略 */ }
    }
    if (!toggle) return false;
    try { toggle.click(); return true; } catch (e) { return false; }
  }

  // 解析 frame 当前 inline grid 三列（React 计算值），返回 [s, center, d]
  function parseColumns(frame) {
    var st = frame.style ? (frame.style.gridTemplateColumns || "") : "";
    var m = /^\s*(\S+)\s+minmax\(\s*0\s*,\s*1fr\s*\)\s*(\S*)\s*$/.exec(st);
    if (m) return [m[1] || "0px", "minmax(0, 1fr)", m[2] || "0px"];
    return ["0px", "minmax(0, 1fr)", "0px"];
  }

  // sidebar 模式：sidebar 占满 iframe（单轨道），隐藏 center/details 列与拖拽柄
  function applySidebar(found) {
    var frame = found.frame;
    if (!frame) return;
    var want = "minmax(0, 1fr) 0px 0px";
    if (!(frame.style.getPropertyPriority("grid-template-columns") === "important" &&
          frame.style.getPropertyValue("grid-template-columns") === want)) {
      frame.style.setProperty("grid-template-columns", want, "important");
    }
    // sidebar 列铺满（列宽 = iframe 宽）；其内层 root（wide 态 inline width 280px）同样铺满
    var sb = found.sidebar;
    if (sb && sb.style) {
      if (sb.style.getPropertyPriority("width") !== "important" || sb.style.getPropertyValue("width") !== "100%") {
        sb.style.setProperty("width", "100%", "important");
      }
      if (sb.firstElementChild && sb.firstElementChild.style) {
        var inner = sb.firstElementChild;
        if (inner.style.getPropertyPriority("width") !== "important" || inner.style.getPropertyValue("width") !== "100%") {
          inner.style.setProperty("width", "100%", "important");
        }
      }
    }
    // 隐藏 center/details 列与拖拽柄；保留 overlayLayer（菜单/浮层 portal 宿主）
    var kids = frame.children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k === sb) continue;
      if (k.hasAttribute && k.hasAttribute("data-shell-overlay")) continue;
      if (k.style && (k.style.getPropertyPriority("display") !== "important" || k.style.getPropertyValue("display") !== "none")) {
        k.style.setProperty("display", "none", "important");
      }
    }
  }

  // main 模式：隐藏 sidebar 列，center 占满；details 保留（响应 React 的 details 宽度变化）
  function applyMain(found) {
    var frame = found.frame;
    if (!frame) return;
    var cols = parseColumns(frame);
    var want = "0px minmax(0, 1fr) " + (cols[2] || "0px");
    if (!(frame.style.getPropertyPriority("grid-template-columns") === "important" &&
          frame.style.getPropertyValue("grid-template-columns") === want)) {
      frame.style.setProperty("grid-template-columns", want, "important");
    }
    var sb = found.sidebar;
    if (sb && sb.style && (sb.style.getPropertyPriority("display") !== "important" || sb.style.getPropertyValue("display") !== "none")) {
      sb.style.setProperty("display", "none", "important");
    }
    // 隐藏 sidebar 拖拽柄（列已隐藏）
    try {
      var handles = frame.querySelectorAll('[data-side="sidebar"]');
      for (var i = 0; i < handles.length; i++) {
        if (handles[i].style) handles[i].style.setProperty("display", "none", "important");
      }
    } catch (e) { /* 忽略 */ }
  }

  function applyMode(found) {
    if (MODE === "main") applyMain(found);
    else applySidebar(found);
  }

  // 展开后重放覆盖：React 重渲染会重写 frame inline style，MutationObserver 保持响应式
  function watchFrame(found) {
    if (observer) { try { observer.disconnect(); } catch (e) { /* 忽略 */ } observer = null; }
    try {
      observer = new MutationObserver(function () { applyMode(found); });
      observer.observe(found.frame, { attributes: true, attributeFilter: ["style"] });
    } catch (e) { /* 无 MutationObserver 时退化为静态覆盖 */ }
    // 看门狗：frame 被 React 整棵重挂（HMR/路由级重建）时重跑整套装配
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
    watchdog = setInterval(function () {
      try {
        if (!document.contains(found.frame)) {
          clearInterval(watchdog); watchdog = null;
          started = false;
          attempts = 0;
          setTimeout(run, 100);
        }
      } catch (e) { /* 忽略 */ }
    }, 5000);
  }

  function run() {
    if (started) return;
    var found = findFrame();
    if (!found) {
      attempts += 1;
      if (attempts >= MAX_ATTEMPTS) return; // 上限静默停住
      setTimeout(run, RETRY_MS);
      return;
    }
    started = true;
    styleEl();
    if (MODE === "sidebar") {
      if (isCollapsed(found)) {
        clickExpand(found);
        // 等 React 完成展开（data-sidebar-collapsed 移除 / rail class 消失），再铺满
        var waited = 0;
        var WAIT_MAX = 4000;
        (function pollExpanded() {
          if (!isCollapsed(found) || waited >= WAIT_MAX) {
            applyMode(found);
            watchFrame(found);
            return;
          }
          waited += 150;
          setTimeout(pollExpanded, 150);
        })();
      } else {
        applyMode(found);
        watchFrame(found);
      }
    } else {
      applyMode(found);
      watchFrame(found);
    }
  }

  // 页面加载早期脚本即执行：等 DOM 就绪后启动装配
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { setTimeout(run, 50); });
  } else {
    setTimeout(run, 50);
  }
})();
</script>`;

export function apply(ctx) {
  ctx.inject(["webServer"], (httpCtx) => {
    httpCtx.effect(() => {
      try {
        httpCtx.webServer.tapIndex((html) => {
          if (html.includes('id="@dsh-hanako/sidebar"')) return html;
          return html.replace("</head>", BRIDGE + "</head>");
        });
      } catch (e) {
        try {
          ctx.logger?.warn?.(
            `[@dsh-hanako/sidebar] tapIndex 注册失败：${e?.message || e}`,
          );
        } catch {
          /* 忽略 */
        }
      }
    });
  });
}