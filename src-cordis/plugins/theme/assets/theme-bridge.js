// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/theme 的注入桥脚本（独立文件，review 修订：内容文件化）。
// 本文件 = 原内嵌于 index.js 的 BRIDGE 字符串正文（逐字节搬移，仅一处插值改造）：
// 经 tapIndex 注入每个 index 响应的 <head>，运行时由 index.js 读取并包
// <script id="@dsh-hanako/theme-bridge"> 后注入。
//
// 插值约定：正文唯一动态点是数据表注入行
//     var m = __DSH_THEME_TOKENS__;
// index.js 读取本文件后把占位符 __DSH_THEME_TOKENS__ 替换为
// JSON.stringify(TOKEN_MAP)（服务端数据表序列化进桥脚本；TOKEN_MAP 是受控常量数组，
// 不含该占位符字样）。其余正文无插值，保持纯浏览器 JS（var/ES5 风格，无 import）。
// cordis 子插件散装分发（不经 rspack，文件随包复制进
// dist/cordis/theme/），pack.mjs 静态压缩按 script 语义
// terser（module=false）。语义与配套见 index.js 头注释（主题注入/明暗/preference）。
(function () {
  // 宿主 token 数据表（全文件唯一插值点：index.js 把本行占位符换成 TOKEN_MAP 的序列化结果）。
  // 注意：服务端用的是 String.replace(pattern, …)，**只换第一处**，所以这行必须全局唯一。
  var m = __DSH_THEME_TOKENS__;
  // 父窗口（宿主壳页）origin（postMessage 定向 + 回执校验；无 ancestorOrigins 时为 null）
  var parentOrigin = null;
  try {
    if (window.location.ancestorOrigins && window.location.ancestorOrigins.length > 0) {
      parentOrigin = window.location.ancestorOrigins[0];
    }
  } catch (e) { /* 忽略 */ }
  var cur = null;
  // vY（T7b 后 dsh 0.1.2）：preference 默认 system——跟随宿主配色（壳桥 vars 即应用）；
  // 读 dsh settings/describe 失败/缺失时按 system 处理，主题不因此失效。
  var pref = "system";
  function cssOf(v) {
    var c = "";
    for (var i = 0; i < m.length; i++) {
      var val = m[i][1][0] === "~" ? m[i][1].slice(1) : (v[m[i][1]] || "");
      c += m[i][0] + ":" + val + "!important;";
    }
    return c;
  }
  function applyOrRemove() {
    var st = document.getElementById("@dsh-hanako/theme-dyn");
    if (followHost() && cur) {
      if (!st) { st = document.createElement("style"); st.id = "@dsh-hanako/theme-dyn"; document.head.appendChild(st); }
      st.textContent = "body{" + cssOf(cur) + "}";
    } else if (st) {
      st.remove();
    }
  }
  // 同文档注入形态（当前主路径，2026-09-12 修）：桥与壳页在同一**文档**里，主题变量直接
  // 从文档根算就行，不再经 parent/壳页往返。旧的 iframe 套 iframe 拓扑已退役，而本桥仍
  // 按旧拓扑校验来源（`e.source !== window.parent` 就丢）——壳页现在只能自投
  // （e.source === window），消息全被丢弃 → 内层 dsh WebUI 永远拿不到主题（真机反馈
  // “壳页跟随了，DSHWebUI 没有”）。
  function readDocumentVars() {
    var cs = null;
    try { cs = getComputedStyle(document.documentElement); } catch (e) { return null; }
    var v = {};
    var hits = 0;
    for (var i = 0; i < m.length; i++) {
      var key = m[i][1];
      if (key.charAt(0) === "~") continue;
      var val = "";
      try { val = (cs.getPropertyValue(key) || "").trim(); } catch (e2) { val = ""; }
      if (val) { v[key] = val; hits++; }
    }
    return hits ? v : null;
  }
  // 是否跟随宿主主题：嵌入式（壳页在注入 DSH 前装了 __DSH_TRANSPORT__）一律跟随宿主——
  // App 卡片是 Hana 的一个面，这里不存在“独立 dsh 窗口”的偏好自治语境；非嵌入仍尊重
  // dsh 自己的 preference（system 才覆盖）。
  function followHost() { return !!window.__DSH_TRANSPORT__ || pref === "system"; }
  // 从文档根读取并应用；读到有效变量返 true。
  function pull() {
    var v = readDocumentVars();
    if (!v) return false;
    cur = v;
    applyOrRemove();
    maybeDropStatic();
    return true;
  }
  // 移除静态 fallback（DEFAULT_THEME）：仅在拿到有效宿主主题（cur 已应用）或确认
  // 非 system 偏好（pref 明确 light/dark，静态默认即正确）之后——壳桥永久失败时
  // 保留 DEFAULT_THEME 兜底，页面不致裸样式（CodeRabbit）。
  function maybeDropStatic() {
    if ((cur && Object.keys(cur).length) || (pref && pref !== "system")) {
      var se = document.getElementById("@dsh-hanako/theme");
      if (se && se.remove) se.remove();
    }
  }
  function ask() {
    // 旧拓扑（iframe 套 iframe）里壳页是本页的 parent；同文档注入后本页的 parent 是**宿主**，
    // 投过去没人答。两个目标都投一份：自身（现壳页的 message 监听就在同文档里）与 parent（兼容）。
    try { window.postMessage({ dshHanaThemeRequest: true }, "*"); } catch (e) { }
    try { window.parent.postMessage({ dshHanaThemeRequest: true }, parentOrigin || "*"); } catch (e) { }
  }
  window.addEventListener("message", function (e) {
    // 来源校验：只认壳页。同文档注入下壳页的自投消息 e.source === window；旧 iframe 形式下
    // e.source === window.parent；两者都收，其余来源一律忽略。
    if (e.source !== window && e.source !== window.parent) return;
    if (e.source !== window && parentOrigin && e.origin !== parentOrigin) return;
    if (e.data && e.data.dshHanaTheme) {
      // 壳页的这条消息只当“主题变了”的通知用：值以文档根为权威（同文档下我们读得到）。
      // 读不到（非同文档部署等）才回退用载荷里的 vars。
      if (!pull()) {
        var v = e.data.dshHanaTheme.vars;
        if (v && typeof v === "object" && Object.keys(v).length) {
          cur = v;
          applyOrRemove();
          maybeDropStatic();
        }
      }
      if (cur && askTimer) { clearInterval(askTimer); askTimer = null; }
    }
    // DSH 主题偏好变更通知（壳页经 /webui/events 收到 settings/document-updated 的
    // ui-theme 后 postMessage 转发，只带 revision）：重读一次 preference（事件驱动，
    // 替代旧 3s 轮询 settings/describe——变更时才读，describe 调用量与官方
    // startup-rpc-budget 语义一致）。
    if (e.data && e.data.dshHanaPref) {
      refreshPref();
    }
  });
  // 回读一次 preference 并重跑 applyOrRemove（加载时 + 偏好变更时共用）。
  function refreshPref() {
    // vY（T7b 后 dsh 0.1.2）：settings.describe 端点改斜杠 settings/describe（0.1.1
    // 点号端点已退役）；信封 payload 走 { args }（0.1.2 Remote 约定）。
    // vZ（2026-09-12 真机 403 定位）：**不得裸 fetch(location.origin + "/api/...")**——宿主
    // 凭据闸只认 App 的私有运行时基址。样例 hana-dsh 自己的 ui/bootstrap.js 把同一条
    // settings/describe 发到 /api/apps/hana-dsh/routes/_runtime/<rid>/_surface/<ticket>
    // /_hana/<bridgeKey>/api/settings/describe 得到 200；裸发则 403 missing_credential。
    // 本脚本由 tapIndex 注入 DSH 文档，而 __DSH_TRANSPORT__（src/ui/dsh-inject.js 在注入
    // DSH index 前装）在同一文档里已可用：经它发出的请求会被重写到私有前缀（同源凭据由
    // 壳页持有）。退路：transport 缺席（例如脚本落到非 DSH 文档）仍走原生 fetch，读不到按 system。
    var transport = window.__DSH_TRANSPORT__;
    var transportFetch = transport && transport.fetch;
    var send = typeof transportFetch === "function"
      ? function (path, init) { return transportFetch.call(transport, path, init); }
      : function (path, init) { return fetch(path, init); };
    send("/api/settings/describe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "theme-pref-" + Date.now(), method: "settings/describe", payload: { args: {} } })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var ns = d && d.result && d.result.value && d.result.value.namespaces;
        if (Array.isArray(ns)) {
          for (var i = 0; i < ns.length; i++) {
            if (ns[i] && ns[i].ns === "ui-theme" && ns[i].value) { pref = ns[i].value.preference || "system"; break; }
          }
        }
        applyOrRemove();
        maybeDropStatic();
      })
      .catch(function () { });
  }
  refreshPref();
  // 偏好实时化（vY→vZ：T7b 后 dsh 0.1.2 无 /api/events.host（旧 0.1.1 端点）——官方
  // 主题 preference 走服务端注入 + client presenter，注入脚本无法访问 ctx.remote.$on；
  // 先退化为 3s 轻量轮询 settings/describe（0.1.2→0.1.3 期间），后改事件驱动：宿主侧
  // bridge 订阅 remote.mux $events 的 settings/document-updated（ui-theme）→ 总线
  // events 频道 → /webui/events → 壳页 postMessage dshHanaPref → 上方 message 监听
  // 调 refreshPref 重读一次（变更时才读，替换周期轮询）。加载时保留一次回读兑底。
  var mq = window.matchMedia && matchMedia("(prefers-color-scheme: dark)");
  if (mq && mq.addEventListener) mq.addEventListener("change", ask);
  // 竞态修复：壳页（宿主 iframe 外层）主题桥的注册可能与 dsh 页面加载不同步——脚本加载时
  // 的首次 ask 可能落在壳桥注册前被丢弃（cur 恒 null → 内层 dsh WebUI 不跟随主题）。
  // 周期重试 ask（收到主题 vars 即停止）：消除时序竞态；对已注册的壳桥幂等（postMessage 无副作用）。
  var askTimer = setInterval(function () {
    if (pull() && cur) { if (askTimer) { clearInterval(askTimer); askTimer = null; } return; }
    ask();
  }, 1000);
  // 主题切换（壳页写 documentElement 的 data-theme / data-appearance）即时感知，不等 1s 轮询。
  try {
    var mo = new MutationObserver(function () { pull(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-appearance"] });
  } catch (e) { /* 忽略 */ }
  pull();
  ask();
})();
