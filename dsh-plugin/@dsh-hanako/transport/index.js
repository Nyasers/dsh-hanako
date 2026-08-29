// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// dsh-plugin/@dsh-hanako/transport/index.js — 远程通道前端桥（B 路线插件化）
//
// 职责：经 dsh-host-webserver 的 tapIndex 扩展点，向 dsh 前端注入传输桥脚本——
// 把 dsh 前端运行期发起的绝对路径请求（fetch /api/*、WebSocket）改写为宿主代理
// 前缀（/api/plugins/dsh-hanako/web/*），使远程通道下 POST/WS 经宿主代理转发 dsh。
//
// 背景：远程访问时 iframe 经宿主代理 /web 加载 dsh 页面（location.origin = 宿主），
// dsh 前端用 location.origin 拼绝对路径（/api/...、ws://<host>/api/...）指向宿主根，
// 宿主没有 dsh 的 API/WS → 断链（HTML 改写覆盖不到运行期构造的 URL）。本桥在
// 页面加载早期（tapIndex 注入，早于 dsh 前端 JS）包装 window.fetch / window.WebSocket：
//   - fetch：绝对 /api/* → /api/plugins/dsh-hanako/web/api/*（附页面 token 凭据）
//   - WebSocket：ws://<host>/api/* → ws://<host>/api/plugins/dsh-hanako/web/api/*
//     （宿主 upgrade 支持与否决定连通性：0.769 插件路由 upgrade 丢 socket 前不可达，
//     注入先行，宿主暴露 socket 后自动可用）
// 注入脚本自判断模式：location.origin 非 dsh 自身（直连 127.0.0.1:<port> 时不改写，
// 直连同源天然全通；仅宿主 origin（代理模式）改写）。
//
// 机制同 @dsh-hanako/theme（tapIndex 注入 <script> 到 </head> 前；html.includes 幂等）。
// 日志经 @dsh-hanako/logger（inject ['hanaLogger']）写入会话日志（行格式 [transport]）。
export const name = '@dsh-hanako/transport'
export const inject = ['hanaLogger']

const BRIDGE_SCRIPT = `<script id="@dsh-hanako/transport-bridge">
(function () {
  // 代理模式判定：dsh 页面经宿主代理加载（location.origin 是宿主而非 dsh 自身）。
  // 直连模式（127.0.0.1:<dshPort> 同源）不改写。用 pathname 前缀判断更稳：
  // 代理模式 URL = /api/plugins/dsh-hanako/web/...；直连 = /（dsh 自身根）。
  var pathname = location.pathname || "";
  var isProxied = pathname.indexOf("/api/plugins/dsh-hanako/web") === 0;
  if (!isProxied) return;
  var token = new URLSearchParams(location.search).get("token") || "";
  var BASE = "/api/plugins/dsh-hanako/web";
  var cred = token ? "?token=" + encodeURIComponent(token) : "";
  function rewriteUrl(url) {
    try {
      var u = new URL(url, location.origin);
      if (u.origin !== location.origin) return url; // 跨源不动
      if (u.pathname.indexOf(BASE) === 0) return url; // 已带前缀
      if (u.pathname.indexOf("/api/") !== 0) return url; // 只改 dsh 的 /api/*
      var sep = u.search ? "&" : "?";
      return u.origin + BASE + u.pathname + u.search + sep + "token=" + encodeURIComponent(token);
    } catch (e) { return url; }
  }
  // 包装 fetch：绝对 /api/* 改写为代理前缀（附 token 凭据过宿主鉴权墙）
  var origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input, init) {
      if (typeof input === "string" && input.indexOf("/api/") !== -1) {
        input = rewriteUrl(input);
      } else if (input && input.url && typeof input.url === "string") {
        input = new Request(rewriteUrl(input.url), input);
      }
      return origFetch.call(this, input, init);
    };
  }
  // 包装 WebSocket：ws://<host>/api/* 改写为 ws://<host>/api/plugins/dsh-hanako/web/api/*
  // （宿主 upgrade 支持后连通；0.769 插件路由 upgrade 丢 socket 前不可达）
  var OrigWS = window.WebSocket;
  if (typeof OrigWS === "function") {
    window.WebSocket = function (url, protocols) {
      var wsUrl = typeof url === "string" ? rewriteUrl(url.replace(/^http/i, "ws")) : url;
      return protocols ? new OrigWS(wsUrl, protocols) : new OrigWS(wsUrl);
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.CONNECTING = OrigWS.CONNECTING;
    window.WebSocket.OPEN = OrigWS.OPEN;
    window.WebSocket.CLOSING = OrigWS.CLOSING;
    window.WebSocket.CLOSED = OrigWS.CLOSED;
  }
})();
</script>`

export function apply(ctx, config) {
  try {
    ctx.inject(['webServer', 'hanaLogger'], (httpCtx) => {
      httpCtx.webServer.tapIndex((html) => {
        if (typeof html !== 'string') return html
        if (html.includes('id="@dsh-hanako/transport"')) return html
        return html.replace('</head>', BRIDGE_SCRIPT + '</head>')
      })
      httpCtx.hanaLogger.log('transport', '传输桥 tapIndex 已注册')
    })
  } catch (e) {
    try {
      ctx.get('hanaLogger')?.log('transport', `tapIndex 注册失败：${e?.message || e}`)
    } catch { /* 日志失败不阻断 */ }
  }
}
