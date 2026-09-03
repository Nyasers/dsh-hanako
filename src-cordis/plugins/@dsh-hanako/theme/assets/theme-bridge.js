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
// dist/cordis/node_modules/@dsh-hanako/theme/），pack.mjs 静态压缩按 script 语义
// terser（module=false）。语义与配套见 index.js 头注释（主题注入/明暗/preference）。
(function () {
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
    var m = __DSH_THEME_TOKENS__;
    var c = "";
    for (var i = 0; i < m.length; i++) {
      var val = m[i][1][0] === "~" ? m[i][1].slice(1) : (v[m[i][1]] || "");
      c += m[i][0] + ":" + val + "!important;";
    }
    return c;
  }
  function applyOrRemove() {
    var st = document.getElementById("@dsh-hanako/theme-dyn");
    if (pref === "system" && cur) {
      if (!st) { st = document.createElement("style"); st.id = "@dsh-hanako/theme-dyn"; document.head.appendChild(st); }
      st.textContent = "body{" + cssOf(cur) + "}";
    } else if (st) {
      st.remove();
    }
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
  function ask() { try { window.parent.postMessage({ dshHanaThemeRequest: true }, parentOrigin || "*"); } catch (e) { } }
  window.addEventListener("message", function (e) {
    // 来源校验：宿主壳页（window.parent）+ 匹配 origin——防第三方窗口伪造 dshHanaTheme
    if (e.source !== window.parent) return;
    if (parentOrigin && e.origin !== parentOrigin) return;
    if (e.data && e.data.dshHanaTheme) {
      var v = e.data.dshHanaTheme.vars;
      if (v && Object.keys(v).length) {
        cur = v;
        applyOrRemove();
        maybeDropStatic();
        // 收到主题 vars：停止周期重试（竞态已破除）
        if (askTimer) { clearInterval(askTimer); askTimer = null; }
      }
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
    fetch("/api/settings/describe", {
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
    if (cur && Object.keys(cur).length) { if (askTimer) { clearInterval(askTimer); askTimer = null; } return; }
    ask();
  }, 1000);
  ask();
})();
