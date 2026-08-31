// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/sidebar — DSH WebUI sidebar 进宿主侧栏桥 + 分离后同步桥（v1.0.1-alpha.1）。
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
//     另：capture 阶段捕获侧栏交互（点会话行 / New Session / 设置入口）→ 写
//     localStorage["dshana.sync"] 指令（new-session / open-settings 以 stopPropagation
//     阻断侧栏自身执行，转主区执行；open-session 不阻断——侧栏自身切高亮无害）。
//   · ?dshana=main（主页面 iframe）：隐藏 sidebar 列（display:none + grid 首轨道 0）
//     → center 占满；details 保留并跟随 React 宽度变化（MutationObserver 重放覆盖）；
//     折叠态先展开保证隐藏 sidebar 内会话列表 mounted（窄屏/侧栏被关时 rail 无列表）。
//     另：监听 window storage 事件（key dshana.sync）→ 解析指令 → 在主区隐藏但 mounted
//     的 sidebar DOM 里模拟点击（.click() 对 display:none 元素仍冒泡到 React root 事件
//     委托 → React onClick 正常触发）→ dsh 前端切换 current session → 主区 center 落实。
//
// 依据（dsh client-ui-layout/workspace/sidebar/settings-general 0.1.1-rc.2 已核实）：
// 三列 grid frame inline gridTemplateColumns + data-sidebar-collapsed / data-details-collapsed
// 语义属性；SIDEBAR_AUTO_COLLAPSE=1024 窄屏折叠；narrow 下 toggleSidebar 翻转
// narrowExpanded，而 narrowExpanded 只在 setNarrow（narrow 值变化）时重置——宿主侧栏宽度
// 固定 → narrow 恒定 → 展开后状态钉住。会话行 = [role="treeitem"][aria-selected]（无稳定
// id 属性，sessionId 只在 React 闭包）→ 标题（行内菜单按钮 aria-label 解析）+ 重复索引
// 匹配，绝对索引兜底。New Session = button[aria-label="新建会话"/"New session"]；
// 设置入口 = button[aria-haspopup="dialog"]。data-slot="sidebar" 为任务契约列特征
// （新版本语义化属性；当前版本无则走 frame 属性/结构兜底）。
//
// 样式纪律：脚本内不硬编码颜色（不涉及配色）；宽度覆盖用 CSS 变量/继承原 class
// 不引入新主题。错误处理：AppFrame 未渲染/找不到元素时静默轮询（上限 ~30s）；
// 同步链路 localStorage 不可用/结构变化时静默降级（侧栏交互回退原生行为），
// 均不报错不阻断 dsh 正常功能。

export const name = "@dsh-hanako/sidebar";

const BRIDGE = `<script id="@dsh-hanako/sidebar">
(function () {
  // dshana 侧栏桥（v1.0.1-alpha.1 + 分离后同步桥）——「宿主侧栏 = dsh sidebar，主区 = dsh center/details」。
  // 两个 dsh Web UI 实例以 URL 参数区分模式（无参数 = 原生行为，本脚本零动作）：
  //   ?dshana=sidebar  → 宿主功能面板 iframe（180-400px 窄宽）：强制展开 sidebar 并占满 iframe
  //   ?dshana=main     → 主页面卡片 iframe：隐藏 sidebar 列，center/details 占满主区
  //
  // 分离后同步桥（本版新增）：两个 iframe 是兄弟（宿主 DOM 内）、同源（127.0.0.1:3080），
  // 但前端 store 无跨实例同步（dsh-client-store persist 机械写 localStorage，无 storage 事件/
  // BroadcastChannel；current session 是前端 selection 状态）→ 自建 localStorage + storage
  // 事件通道：
  //   · 侧栏 iframe：document capture 阶段监听 click，识别三类交互（点会话行 / New Session /
  //     设置入口）→ 写 localStorage["dshana.sync"] = { action, title?, dupIndex?, absIndex?, ts }。
  //     new-session / open-settings 用 stopPropagation 阻断侧栏自身执行（避免双创建/双面板），
  //     转由主区执行；open-session 不阻断（侧栏自身切高亮，两 store 指向同一 session 无害）。
  //   · 主区 iframe：window storage 事件（同源其他文档触发，自身不触发 → 天然无自环）→ 解析
  //     指令 → 在主区隐藏但 mounted 的 sidebar DOM 里模拟点击（.click() 对 display:none 元素
  //     仍冒泡到 React root 事件委托 → React onClick 正常触发）→ dsh 前端切换 current session
  //     → 主区 center 落实显示。找不到目标（列表未加载/结构变化）→ 有上限重试（500ms×10）后
  //     静默放弃。
  //   会话行匹配：会话行无稳定 id 属性（sessionId 只在 React 闭包）→ 用「标题 + 重复索引」主
  //   匹配（标题从行内菜单按钮 aria-label 解析：zh 会话“{title}”的操作 / en Session actions
  //   for {title}；空白会话行无菜单按钮 → 本地化 blank 标题“新会话”/“New Session”），绝对索引
  //   兜底（两 iframe 同后端同列表序）。
  //
  // 依据（dsh client-ui-* 0.1.1-rc.2 已核实）：
  //   - 三列 grid frame：inline gridTemplateColumns = "<s>px minmax(0, 1fr) <d>px"，
  //     子列依次为 sidebarCol | centerCol | detailsCol | overlayLayer([data-shell-overlay])，
  //     frame 带 data-sidebar-collapsed / data-details-collapsed 语义属性（稳定）。
  //   - 窄屏折叠：SIDEBAR_AUTO_COLLAPSE=1024，viewport<1024 → narrow → rail（56px 图标轨）；
  //     展开控件 = sidebar root 内的 toggle 按钮（class 含 toggle，aria-label 为 toggle.open/
  //     toggle.collapse 译文，onClick → toggleSidebar()）。
  //   - narrowExpanded 仅在 setNarrow 触发（narrow 值变化）时重置；宿主侧栏宽度固定 →
  //     narrow 恒定 → 展开后状态钉住，不会自愈回折叠。
  //   - 会话列表：div[role="tree"][aria-label="会话"/"Sessions"] 内，会话行 = div[role="treeitem"]
  //     [aria-selected]（onClick → onOpen(node.id)）；工作区行 = [role="treeitem"][aria-expanded]
  //     （可区分）；行内菜单按钮 aria-label = t("actions.session.aria", {name:title})。
  //   - New Session：button[aria-label="新建会话"/"New session"]（shell 级 + brand 按钮均
  //     onClick → startSession()）；设置入口：button[aria-haspopup="dialog"]（SidebarRoot footer
  //     trigger，onClick → setOpen(true)）。
  //   - 兜底选择器（任务契约）：div[data-slot="sidebar"]（新版本 dsh 的语义化列特征）。
  // 样式策略：React 每次重渲染会重写 frame inline gridTemplateColumns —— 用
  // style.setProperty(..., "important") 压过 React inline（非 important），
  // 并挂 MutationObserver（attributeFilter:["style"]）在 React 更新后重放覆盖，保持响应式。
  // 容错：AppFrame 未挂载/元素缺失时静默轮询（上限 ~30s）；同步链路 localStorage 不可用/
  // 结构变化时静默降级（侧栏交互回退原生行为，不阻断 dsh 正常功能）。

  var MODE = (function () {
    try {
      return new URLSearchParams(window.location.search).get("dshana");
    } catch (e) { return null; }
  })();
  if (MODE !== "main" && MODE !== "sidebar") return;

  var CSS_ID = "@dsh-hanako/sidebar-css";
  var SYNC_KEY = "dshana.sync";
  var SYNC_TTL = 15000;       // 指令过期阈值（ms）
  var MAX_ATTEMPTS = 60;      // frame 定位轮询上限（500ms × 60 = 30s）
  var RETRY_MS = 500;
  var SYNC_RETRIES = 10;      // 同步指令执行重试上限（500ms × 10 = 5s）
  var attempts = 0;
  var started = false;
  var observer = null;
  var watchdog = null;

  // ---- 同步通道（localStorage + storage 事件）----
  function syncWrite(cmd) {
    try {
      cmd = cmd || {};
      cmd.ts = Date.now();
      window.localStorage.setItem(SYNC_KEY, JSON.stringify(cmd));
    } catch (e) { /* localStorage 不可用（沙箱/配额）→ 静默降级 */ }
  }
  function syncRead(raw) {
    try {
      if (!raw) return null;
      var cmd = JSON.parse(raw);
      if (!cmd || typeof cmd.action !== "string") return null;
      if (!cmd.ts || Date.now() - cmd.ts > SYNC_TTL) return null; // 过期指令丢弃
      return cmd;
    } catch (e) { return null; }
  }
  // 会话行集合（限定 rootEl 内；侧栏模式用 document，主区模式用 sidebar 列）
  function sessionRows(rootEl) {
    var rows = [];
    try {
      var all = (rootEl || document).querySelectorAll('[role="treeitem"][aria-selected]');
      for (var i = 0; i < all.length; i++) rows.push(all[i]);
    } catch (e) { /* 忽略 */ }
    return rows;
  }
  // 会话行标题：优先行内菜单按钮 aria-label 解析（zh/en 两种模式），空白行兜底本地化标题
  function rowTitle(row) {
    try {
      var btn = row.querySelector('button[aria-label]');
      if (btn) {
        var label = (btn.getAttribute("aria-label") || "").trim();
        var m = label.match(/^会话[\u201C"]([\s\S]*?)[\u201D"]的操作$/) || label.match(/^Session actions for ([\s\S]*)$/);
        if (m && m[1]) return m[1].trim();
      }
    } catch (e) { /* 忽略 */ }
    try {
      var text = (row.textContent || "").trim();
      if (text.indexOf("新会话") !== -1) return "新会话";
      if (text.indexOf("New Session") !== -1) return "New Session";
      var spans = row.querySelectorAll("span");
      for (var i = spans.length - 1; i >= 0; i--) {
        var st = (spans[i].textContent || "").trim();
        if (st && !spans[i].querySelector("button")) return st;
      }
    } catch (e) { /* 忽略 */ }
    return "";
  }
  // 捕获侧行信息：title + 同标题重复索引 + 全部会话行绝对索引
  function rowInfo(row) {
    var title = rowTitle(row);
    if (!title) return null;
    var rows = sessionRows();
    var absIndex = -1, dupIndex = -1, seen = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] === row) absIndex = i;
      if (rowTitle(rows[i]) === title) {
        if (rows[i] === row) dupIndex = seen;
        seen += 1;
      }
    }
    return { title: title, dupIndex: dupIndex, absIndex: absIndex };
  }
  // 主区侧按指令定位会话行：标题唯一直取；重复按 dupIndex；找不到回落 absIndex
  function findSessionRowByCmd(cmd, rootEl) {
    var rows = sessionRows(rootEl);
    if (!rows.length) return null;
    var matches = [];
    for (var i = 0; i < rows.length; i++) {
      if (rowTitle(rows[i]) === cmd.title) matches.push(rows[i]);
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      var di = typeof cmd.dupIndex === "number" && cmd.dupIndex >= 0 ? cmd.dupIndex : 0;
      return matches[Math.min(di, matches.length - 1)] || null;
    }
    if (typeof cmd.absIndex === "number" && cmd.absIndex >= 0 && cmd.absIndex < rows.length) {
      return rows[cmd.absIndex];
    }
    return null;
  }
  function sidebarEl() {
    try {
      var found = findFrame();
      return found ? found.sidebar : null;
    } catch (e) { return null; }
  }
  function newSessionButton(rootEl) {
    try {
      var btns = (rootEl || document).querySelectorAll('button[aria-label]');
      for (var i = 0; i < btns.length; i++) {
        var l = (btns[i].getAttribute("aria-label") || "").trim();
        if (l === "新建会话" || l === "New session") return btns[i];
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }
  function settingsButton(rootEl) {
    try {
      return (rootEl || document).querySelector('button[aria-haspopup="dialog"]');
    } catch (e) { return null; }
  }
  // 有上限重试的模拟点击（目标未就绪/列表加载中 → 500ms×N 后静默放弃）
  function retryClick(finder, done) {
    var tries = 0;
    (function attempt() {
      var el = null;
      try { el = finder(); } catch (e) { /* 忽略 */ }
      if (el) {
        try { el.click(); } catch (e) { /* 忽略 */ }
        if (done) done(true);
        return;
      }
      tries += 1;
      if (tries >= SYNC_RETRIES) { if (done) done(false); return; }
      setTimeout(attempt, RETRY_MS);
    })();
  }

  // ---- 侧栏模式：capture 阶段捕获交互 → 写指令 ----
  function installSidebarCapture() {
    document.addEventListener("click", function (e) {
      try {
        if (e.button !== undefined && e.button !== 0) return;
        var t = e.target;
        if (!t || typeof t.closest !== "function") return;
        var label = "";
        try {
          var mb = t.closest('button[aria-label]');
          if (mb) label = (mb.getAttribute("aria-label") || "").trim();
        } catch (err) { /* 忽略 */ }
        // 行内菜单按钮（会话/工作区操作）→ 菜单切换，不同步
        if (/^会话[\u201C"]/.test(label) || /^工作区[\u201C"]/.test(label) ||
            /^Session actions for /.test(label) || /^Workspace actions for /.test(label) ||
            /^New session in /.test(label) || /^在[\u201C"].*[\u201D"]中新建会话$/.test(label)) return;
        // 设置入口（footer trigger；无 aria-label，仅 aria-haspopup="dialog"）
        if (label !== "新建会话" && label !== "New session") {
          try {
            var st = t.closest('button[aria-haspopup="dialog"]');
            if (st) {
              e.stopPropagation(); // 阻断侧栏自身开面板，转主区执行
              syncWrite({ action: "open-settings" });
              return;
            }
          } catch (err) { /* 忽略 */ }
        }
        // New Session（shell 级按钮 + brand 按钮，均 startSession）
        if (label === "新建会话" || label === "New session") {
          e.stopPropagation(); // 阻断侧栏自身创建（避免双会话），转主区执行
          syncWrite({ action: "new-session" });
          return;
        }
        // 会话行 → open-session（不 stopPropagation：侧栏自身切高亮，两 store 指向同一 session 无害）
        try {
          var row = t.closest('[role="treeitem"][aria-selected]');
          if (row) {
            var info = rowInfo(row);
            if (info && info.title) {
              syncWrite({ action: "open-session", title: info.title, dupIndex: info.dupIndex, absIndex: info.absIndex });
            }
          }
        } catch (err) { /* 忽略 */ }
      } catch (err) { /* 静默：不阻断 dsh 正常功能 */ }
    }, true);
  }

  // ---- 主区模式：storage 事件 → 隐藏 sidebar DOM 模拟点击 ----
  function installMainSyncListener() {
    window.addEventListener("storage", function (e) {
      try {
        if (e.key !== SYNC_KEY) return;
        var cmd = syncRead(e.newValue);
        if (!cmd) return;
        if (cmd.action === "open-session") {
          retryClick(function () { return findSessionRowByCmd(cmd, sidebarEl()); });
        } else if (cmd.action === "new-session") {
          retryClick(function () { return newSessionButton(sidebarEl()); });
        } else if (cmd.action === "open-settings") {
          retryClick(function () { return settingsButton(sidebarEl()); });
        }
      } catch (err) { /* 静默：不阻断 dsh 正常功能 */ }
    });
  }

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

  function pollExpanded(found) {
    var waited = 0;
    var WAIT_MAX = 4000;
    (function poll() {
      if (!isCollapsed(found) || waited >= WAIT_MAX) {
        applyMode(found);
        watchFrame(found);
        return;
      }
      waited += 150;
      setTimeout(poll, 150);
    })();
  }

  function run() {
    if (started) return;
    var found = findFrame();
    if (!found) {
      attempts += 1;
      if (attempts >= MAX_ATTEMPTS) return;
      setTimeout(run, RETRY_MS);
      return;
    }
    started = true;
    styleEl();
    // 两种模式统一：折叠态先展开——sidebar 模式本来就要展开占满；
    // main 模式保证隐藏的 sidebar 列内会话列表 mounted（窄屏/侧栏被关时 rail 无列表，展开后才有）
    if (isCollapsed(found)) {
      clickExpand(found);
      pollExpanded(found);
    } else {
      applyMode(found);
      watchFrame(found);
    }
  }

  // 同步桥装配：侧栏装捕获监听，主区装 storage 监听（独立于 frame 装配，DOM 按需查询）
  if (MODE === "sidebar") installSidebarCapture();
  else installMainSyncListener();

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
