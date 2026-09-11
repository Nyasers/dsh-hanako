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
  // 偏好是否已知：由本插件的 client 半（src-cordis/plugins/theme/client.js）投影到
  // html[data-dsh-theme-preference]；未得知前不动手（否则会先按 system 压一遍 Hana
  // 配色、再被纠正，中间可见闪烁）。client 半未加载时本值恒 false（不压 token）。
  var prefKnown = false;
  /** 读 presenter 投影的偏好属性；非法/缺失返 null。 */
  function readPreference() {
    try {
      var v = document.documentElement.getAttribute("data-dsh-theme-preference");
      return v === "light" || v === "dark" || v === "system" ? v : null;
    } catch (e) { return null; }
  }
  function cssOf(v) {
    var c = "";
    for (var i = 0; i < m.length; i++) {
      var val = m[i][1][0] === "~" ? m[i][1].slice(1) : (v[m[i][1]] || "");
      if (!val) continue; // 空值不出手：空自定义属性会让 var() “无效于计算值”（bg 系变 transparent）
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
  function followHost() {
    // 仅在**已知且明确**偏好为 system 时跟随宿主；已知为 light/dark 时完全原生；
    // 尚未得知偏好时不动手（等壳页首次推送）。2026-09-12：我一度写成“装了
    // __DSH_TRANSPORT__ 就无条件跟随”，把这条特性抬掉了，真机反馈纠正后收回。
    return prefKnown && pref === "system";
  }
  // 从文档根读取并应用；读到有效变量返 true。
  function pull() {
    // 先采纳偏好（presenter 写的 html 属性；属性一变就重新算门——事件驱动，无轮询）。
    var p = readPreference();
    if (p !== null) { pref = p; prefKnown = true; }
    var v = readDocumentVars();
    if (!v) return false;
    cur = v;
    applyOrRemove();
    return true;
  }
  // 已无静态 fallback 可撤：拿不到宿主主题时就保持 dsh 内置 token（官方明暗）——
  // 不从宿主搬固定值充数（2026-09-12 她定）。旧实现会在这里摘掉静态 <style>，
  // 随 STATIC 一起退役。
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
      // 值以文档根为权威（同文档下我们读得到）；读不到才回退用载荷里的 vars。
      // （偏好不在这里——它由 presenter 的属性承载，见 pull()。）
      // pull() 内部已 applyOrRemove()，所以换门后不必再跑一遍。
      if (!pull()) {
        var v = e.data.dshHanaTheme.vars;
        if (v && typeof v === "object" && Object.keys(v).length) {
          cur = v;
          applyOrRemove();
        }
      }
      if (cur && askTimer) { clearInterval(askTimer); askTimer = null; }
    }
  });
  // 主题偏好不再由本脚本 RPC 自读：旧实现打 settings/describe，信封在新版本未验；读不到就
  // 永远停在 system、把 UI 钉住（真机 2026-09-12）。现改由壳页随每次主题推送下发（来源：
  // DSH index 的 boot-theme 行，见 src/ui/app-shell.js readIndexThemePreference）；
  // 原先“宿主侧 bridge 订阅 remote.mux → dshanaBus → /webui/events → dshHanaPref”的
  // 事件链也一并退役（那是宿主没给能力时的自补）。
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
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-appearance", "data-dsh-theme-preference"],
    });
  } catch (e) { /* 忽略 */ }
  pull();
  ask();
})();
