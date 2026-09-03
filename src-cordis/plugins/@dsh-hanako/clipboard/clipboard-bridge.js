// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/clipboard 的注入桥脚本（独立文件，review 修订：内容文件化）。
// 本文件 = 原内嵌于 index.js 的 BRIDGE 字符串正文（逐字节搬移，行为零变化）：
// 经 tapIndex 注入每个 index 响应的 <head> 内，运行时由 index.js
// readFileSync(new URL("./clipboard-bridge.js", import.meta.url)) 读取并包
// <script id="@dsh-hanako/clipboard-bridge"> 后注入。cordis 子插件散装分发
// （不经 rspack，文件随包复制进 dist/cordis/node_modules/@dsh-hanako/clipboard/），
// pack.mjs 静态压缩步会把本文件按 script 语义 terser（module=false，无 ESM 语法）。
// 语义与配套见 index.js 头注释（clipboard 权限链/MessageChannel 回执/2.5s 超时）。
(function () {
  var isEmbedded = (function () {
    try { return window.parent !== window; } catch (e) { return false; }
  })();
  if (!isEmbedded) return;
  // 父窗口（宿主壳页）origin：postMessage 定向投递 + 回执校验（防第三方窗口伪造）。
  // 读取方式：Chromium 的 ancestorOrigins 第一位 = 最近父窗口 origin；不可用时回退
  // location.href 推导不可靠，故 postMessage 兜底用 "*"（仅回执侧校验 source+origin）。
  var parentOrigin = null;
  try {
    if (window.location.ancestorOrigins && window.location.ancestorOrigins.length > 0) {
      parentOrigin = window.location.ancestorOrigins[0];
    }
  } catch (e) { /* 忽略 */ }
  var nc = navigator.clipboard;
  if (!nc || typeof nc.writeText !== "function") return;
  var orig = nc.writeText.bind(nc);
  nc.writeText = function (text) {
    var p;
    try { p = orig(text); } catch (e) { return bridgeCopy(text); }
    if (p && typeof p.then === "function") {
      return p.then(function () {}, function () { return bridgeCopy(text); });
    }
    return bridgeCopy(text);
  };
  function bridgeCopy(text) {
    return new Promise(function (resolve, reject) {
      var ch = new MessageChannel();
      var to = setTimeout(function () { ch.port1.close(); reject(new Error("copy bridge timeout")); }, 2500);
      ch.port1.onmessage = function (e) {
        clearTimeout(to);
        ch.port1.close();
        // 回执校验：来源必须是宿主壳页窗口（parent）+ 匹配其 origin，防伪造 __dshCopyResult
        if (e.origin && parentOrigin && e.origin !== parentOrigin) { reject(new Error("copy bridge origin mismatch")); return; }
        if (e.data && e.data.__dshCopyResult && e.data.__dshCopyResult.ok) resolve();
        else reject(new Error("copy bridge failed"));
      };
      // 定向投递到宿主壳页（已知其 origin 时）；未知时退 "*"（仅本窗口的 parent 收得到）
      window.parent.postMessage({ __dshCopy: true, id: "cb" + Math.random().toString(36).slice(2), text: text }, parentOrigin || "*", [ch.port2]);
    });
  }
})();
