// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/sidebar — DSH WebUI 主页面 sidebar 隐藏 + 外部指令驱动（方案 A，v1.0.1-alpha.1）。
//
// 语义：DSHana v2 整页卡（fpFullPanel）场景下，「宿主左侧栏 = Full FP 功能面板」由壳页
// （webui-shell）经 hana.panel.set 运行时推送 sections 重建（会话列表 / 状态 / 操作），
// 不再 embedUrl iframe 嵌 dsh Web UI（embedUrl 静态 loopback 硬编端口，宿主 0.810.0 静态
// 透传无端口改写，webPort 配置变更即失效——方案 A 退役 embedUrl）。主页面（?dshana=main）
// 内嵌 dsh Web UI 并隐藏自身 sidebar → 拼成「宿主侧栏 = hana 面板，主区 = dsh center/details」。
//
// 机制：与 @dsh-hanako/theme 同姿势——经 dsh-host-webserver 的 tapIndex 扩展点，
// 向每个 index 响应注入一个自包含脚本（幂等：检测已有标记则跳过）。脚本按
// location.search 的 dshana 参数分支：
//   · 无参数：零动作，正常 dsh UI 行为不变（顶层浏览器直开 3080 不受影响）。
//   · ?dshana=main（主页面 iframe）：隐藏 sidebar 列（display:none + grid 首轨道 0）
//     → center 占满；details 保留并跟随 React 宽度变化（MutationObserver 重放覆盖）；
//     折叠态先展开保证隐藏 sidebar 内会话列表 mounted（窄屏/侧栏被关时 rail 无列表）。
//     另：监听 window postMessage 外部指令（{ type:"dshana.act", action, sessionId?,
//     title?, dupIndex?, absIndex? }，协议见 webui-shell 壳页与本文档注释）→ 在主区隐藏
//     但 mounted 的 sidebar DOM 里定位对应元素并模拟点击（.click() 对 display:none 元素
//     仍冒泡到 React root 事件委托 → React onClick 正常触发）→ dsh 前端切换 current
//     session / 新建会话 / 打开设置 → 主区 center 落实。
//     另：回传当前会话——MutationObserver 观察 aria-selected 变化，把当前选中会话行
//     （标题 + 重复索引 + 绝对索引）postMessage 给壳页（{ type:"dshana.current", ... }），
//     壳页据此在面板 list section 标记 selected（服务端无权威 current，主区回传为准）。
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
// 外部指令目标缺失/结构变化时静默降级（有上限重试后放弃，不报错不阻断 dsh 正常功能）。

export const name = "@dsh-hanako/sidebar";

const BRIDGE = `<script id="@dsh-hanako/sidebar">
(function () {
  // dshana 主页面桥（方案 A，v1.0.1-alpha.1）——「宿主侧栏 = hana 面板（sections 重建），
  // 主区 = dsh center/details」。宿主侧栏不再 iframe 嵌 dsh Web UI（embedUrl 退役），
  // 本脚本只服务主页面（?dshana=main）：
  //   · 隐藏 sidebar 列（display:none + grid 首轨道 0 !important），center 占满；
  //   · 折叠态先展开——保证隐藏 sidebar 内会话列表 mounted（窄屏/侧栏被关时 rail 无列表，
  //     展开后才有 [role="treeitem"] 行可被模拟点击）
  //   · 监听 window postMessage 外部指令（壳页投递 hana 面板事件后转发）：
  //       { type:"dshana.act", action:"open-session"|"new-session"|"open-settings",
  //         sessionId?, title?, dupIndex?, absIndex? }
  //     → 在主区隐藏但 mounted 的 sidebar DOM 里定位对应元素并模拟点击 → dsh 前端落实
  //   · 回传当前会话：MutationObserver 观察 aria-selected 变化 → postMessage
  //     { type:"dshana.current", title, dupIndex, absIndex } 给壳页 → 壳页标记面板 list
  //     section 的 selected 项（服务端无权威 current，主区回传为准）
  //
  // 依据（dsh client-ui-* 0.1.1-rc.2 已核实）：
  //   - 三列 grid frame：inline gridTemplateColumns = "<s>px minmax(0, 1fr) <d>px"，
  //     子列依次为 sidebarCol | centerCol | detailsCol | overlayLayer([data-shell-overlay])，
  //     frame 带 data-sidebar-collapsed / data-details-collapsed 语义属性（稳定）。
  //   - 窄屏折叠：SIDEBAR_AUTO_COLLAPSE=1024，viewport<1024 → narrow → rail（56px 图标轨）；
  //     展开控件 = sidebar root 内的 toggle 按钮（aria-label 为 toggle.open/toggle.collapse
  //     译文，onClick → toggleSidebar()）。
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
  // 容错：AppFrame 未挂载/元素缺失时静默轮询（上限 ~30s）；外部指令目标找不到 →
  // 500ms×10 有上限重试后静默放弃；回传/监听异常静默。均不报错不阻断 dsh 正常功能。

  var MODE = (function () {
    try {
      return new URLSearchParams(window.location.search).get("dshana");
    } catch (e) { return null; }
  })();
  if (MODE !== "main") return;

  var CSS_ID = "@dsh-hanako/sidebar-css";
  var MAX_ATTEMPTS = 60;      // frame 定位轮询上限（500ms × 60 = 30s）
  var RETRY_MS = 500;
  var ACT_RETRIES = 10;       // 外部指令执行重试上限（500ms × 10 = 5s）
  var attempts = 0;
  var started = false;
  var observer = null;
  var watchdog = null;
  var currentObserver = null;

  // 会话行集合（限定 rootEl 内；主区模式用 sidebar 列）
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
  // 捕获行信息：title + 同标题重复索引 + 全部会话行绝对索引
  function rowInfo(row, rootEl) {
    var title = rowTitle(row);
    if (!title) return null;
    var rows = sessionRows(rootEl);
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
  // 按指令定位会话行：标题唯一直取；重复按 dupIndex；找不到回落 absIndex
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
      if (tries >= ACT_RETRIES) { if (done) done(false); return; }
      setTimeout(attempt, RETRY_MS);
    })();
  }

  // ---- 外部指令：壳页 postMessage → 主区隐藏 sidebar DOM 模拟点击 ----
  function installActListener() {
    window.addEventListener("message", function (e) {
      try {
        if (e.source !== window.parent) return; // 只接受壳页（父窗口）指令
        var m = e.data;
        if (!m || typeof m !== "object" || m.type !== "dshana.act") return;
        if (m.action === "open-session") {
          if (m.title || typeof m.absIndex === "number") {
            retryClick(function () { return findSessionRowByCmd(m, sidebarEl()); });
          }
        } else if (m.action === "new-session") {
          retryClick(function () { return newSessionButton(sidebarEl()); });
        } else if (m.action === "open-settings") {
          retryClick(function () { return settingsButton(sidebarEl()); });
        }
      } catch (err) { /* 静默：不阻断 dsh 正常功能 */ }
    });
  }

  // ---- 当前会话回传：aria-selected 变化 → postMessage 壳页 ----
  function reportCurrent() {
    try {
      var sb = sidebarEl();
      if (!sb) return;
      var rows = sessionRows(sb);
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute("aria-selected") === "true") {
          var info = rowInfo(rows[i], sb);
          if (info && info.title) {
            window.parent.postMessage(
              { type: "dshana.current", title: info.title, dupIndex: info.dupIndex, absIndex: info.absIndex },
              "*"
            );
            return;
          }
        }
      }
    } catch (e) { /* 静默 */ }
  }
  function installCurrentReporter() {
    setTimeout(reportCurrent, 200); // 初始回传一次（iframe 挂载后 sidebar 可能尚未展开）
    try {
      currentObserver = new MutationObserver(function () { reportCurrent(); });
      currentObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["aria-selected"] });
    } catch (e) { /* 无 MutationObserver 时退化为仅初始回传 */ }
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
    var css = "[data-side=\"sidebar\"]{display:none!important}" +
              "[data-slot=\"sidebar\"]{display:none!important}";
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
      // 优先语义属性（宿主契约，跨构建稳定）：data-sidebar-collapsed 显式标记折叠
      if (found.frame.hasAttribute && found.frame.hasAttribute("data-sidebar-collapsed")) return true;
      var sb = found.sidebar;
      // 宽度启发：rail 宽度显著小于完整侧栏（<120px）即折叠态
      if (sb && sb.getBoundingClientRect) {
        var w = sb.getBoundingClientRect().width;
        if (w > 0 && w < 120) return true;
      }
      // 最后兜底：hashed class（hHd-Xa_* 为构建产物哈希，跨 dsh 构建/版本不稳定，
      // 仅当语义属性/宽度不可用时作末位参考，不可作为主判断）
      if (sb && sb.classList && sb.classList.contains("hHd-Xa_collapsed")) return true;
      if (sb && sb.querySelector && sb.querySelector(".hHd-Xa_collapsed")) return true;
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
            label.indexOf("sidebar") !== -1 || label.indexOf("侧栏") !== -1 ||
            label.indexOf("边栏") !== -1 || label.indexOf("展开") !== -1) {
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
    applyMain(found);
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
          // frame 已脱离文档：先断掉 observer（防 detached frame 残留回调），
          // 再清看门狗并重新调度 run（下次挂载时重建观察）。
          if (observer) { try { observer.disconnect(); } catch (e) { /* 忽略 */ } observer = null; }
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
    // main 模式折叠态先展开：保证隐藏 sidebar 列内会话列表 mounted
    // （窄屏/侧栏被关时 rail 无列表，展开后才有 [role="treeitem"] 行可被模拟点击）
    if (isCollapsed(found)) {
      clickExpand(found);
      pollExpanded(found);
    } else {
      applyMode(found);
      watchFrame(found);
    }
  }

  // 指令监听 + 当前会话回传：独立于 frame 装配（DOM 按需查询，目标未就绪由
  // retryClick 有上限重试兜底）——即使 frame 定位失败/未挂载，面板点击也不会丢
  installActListener();
  installCurrentReporter();

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
