// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// assets/sw.js — DSHana 统一通道（bridge）浏览器侧 service worker（M4）
//
// 职责：拦截 scope（/api/plugins/dsh-hanako/web/）内 dsh 页面的一切请求，经 WS #1
// （宿主插件 WS 端点 /api/plugins/dsh-hanako/bridge，query token 宿主鉴权）封装为
// http.request 帧转发到宿主 bridge → WS #2 → dsh 进程内执行，响应分帧回传后经
// ReadableStream respondWith。断线重连 + pending 请求失败返回 502。
//
// 帧协议（JSON 文本帧，见 design-unified-channel §3）：
//   SW → 宿主：{ "type":"http.request", "id":"r1", "method":"GET", "path":"/",
//                "headers":{...}, "body":{ "chunk":0,"data":"<base64>","done":true } }
//              大 body 分段：首段随请求帧，后续 { "type":"http.chunk","id","chunk",
//              "data","done" }
//   宿主 → SW：{ "type":"http.response","id","status","headers","body":<分帧> }
//              { "type":"http.error","id","message" }
//              { "type":"ping" } / { "type":"pong" }
//
// HTML 改写（scope 收窄的配套）：dsh index.html 用绝对路径引用资源（/assets/* 等），
// 在宿主 origin 下会解析到宿主根路径（脱离 scope）。本 SW 对 text/html 响应做一次
// 轻量改写：把属性值里的 "/xxx" 绝对路径改写为 scope 相对（"/api/plugins/dsh-hanako/
// web/xxx"），让静态资源请求落入 scope 被本 SW 继续转发。dsh 运行期 JS 的绝对
// /api/* 调用与实时 WebSocket（events.mux/host）不受 SW 控制，属二期 __DSH_TRANSPORT__
// 隧道范围（一期保持直连 3080 本地可用）。
//
// 注入：WS #1 URL + token 由壳页面经 navigator.serviceWorker.controller.postMessage
// 下发（{ type:"bridge-config", wsUrl, token }）；壳页面 await
// navigator.serviceWorker.ready 后才挂 iframe。
//
// 本文件以纯脚本（非模块）形式经宿主通道 /api/plugins/dsh-hanako/sw.js 提供
// （routes/bridge.js 或 webui.js 路由 serve，content-type: application/javascript）。

/* global self, fetch, Response, ReadableStream, TextDecoder, WebSocket */

var CHANNEL_PREFIX = "/api/plugins/dsh-hanako/web"; // scope（无尾斜杠比较用）
var CHUNK_THRESHOLD = 256 * 1024; // 分帧阈值（与宿主 lib/bridge.js 一致）
var CHUNK_SIZE = 224 * 1024; // 每段原始字节
var REQUEST_TIMEOUT_MS = 30000; // 请求挂起超时
var RECONNECT_BASE_MS = 1000; // WS #1 重连退避基数
var RECONNECT_MAX_MS = 30000; // 重连退避封顶
var HEARTBEAT_MS = 30000; // 心跳间隔（ping）
var DEAD_MS = 90000; // 无消息判死

var config = { wsUrl: null, token: null }; // 壳页面注入（bridge-config）
var ws = null;
var wsOpen = false;
var wsHandshake = false; // WS #1 无应用层握手（宿主鉴权在 HTTP upgrade），预留
var reconnectTimer = null;
var reconnectAttempt = 0;
var heartbeatTimer = null;
var lastMessageAt = 0;
var pending = {}; // id → { resolve, reject, timer, metaBody, chunks, nextChunk }
var seq = 0;

// ---- 日志（调试用；正式环境可关）----
function log(msg) {
  console.log("[dsh-hanako-sw] " + msg);
}

// ---- WS #1 连接管理（断线重连 + 心跳）----
function nextId() {
  seq += 1;
  return "r" + seq;
}

function connect() {
  if (!config.wsUrl || !config.token) {
    // 壳页面尚未下发配置：等 bridge-config 消息
    return;
  }
  var url = config.wsUrl;
  if (url.indexOf("?") === -1) url += "?token=" + encodeURIComponent(config.token);
  else url += "&token=" + encodeURIComponent(config.token);
  var sock;
  try {
    sock = new WebSocket(url);
  } catch (e) {
    log("WS #1 构造失败：" + (e && e.message));
    scheduleReconnect();
    return;
  }
  ws = sock;
  wsOpen = false;
  sock.addEventListener("open", function () {
    wsOpen = true;
    lastMessageAt = Date.now();
    reconnectAttempt = 0;
    log("WS #1 已连接");
    // 连接恢复：pending 请求在断线时已全部 502，无需重发
  });
  sock.addEventListener("message", function (ev) {
    lastMessageAt = Date.now();
    if (typeof ev.data !== "string") return;
    var frame;
    try {
      frame = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    onFrame(frame);
  });
  sock.addEventListener("close", function () {
    if (ws === sock) ws = null;
    wsOpen = false;
    log("WS #1 连接关闭，pending 请求 502");
    failAllPending("SW 连接断开");
    scheduleReconnect();
  });
  sock.addEventListener("error", function () {
    /* close 接手重连 */
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  var delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt));
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    connect();
  }, delay);
}

function startHeartbeat() {
  heartbeatTimer = setInterval(function () {
    if (wsOpen) {
      sendFrame({ type: "ping" });
      if (Date.now() - lastMessageAt > DEAD_MS) {
        log("WS #1 心跳超时，断开重连");
        try { ws.close(); } catch (e) { /* 忽略 */ }
      }
    }
  }, HEARTBEAT_MS);
}

function sendFrame(frame) {
  if (!wsOpen || !ws) return false;
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch (e) {
    return false;
  }
}

// ---- 帧处理 ----
function onFrame(frame) {
  if (frame && frame.type === "pong") return;
  if (frame && frame.type === "ping") {
    sendFrame({ type: "pong" });
    return;
  }
  if (frame && frame.type === "http.response") {
    var entry = pending[frame.id];
    if (!entry) return;
    clearTimeout(entry.timer);
    var body = rebuildBody(frame.body, entry.chunks);
    delete pending[frame.id];
    entry.resolve({
      status: Number(frame.status) || 200,
      headers: frame.headers || {},
      body: body,
    });
    return;
  }
  if (frame && frame.type === "http.error") {
    var entry2 = pending[frame.id];
    if (!entry2) return;
    clearTimeout(entry2.timer);
    delete pending[frame.id];
    entry2.reject(new Error(frame.message || "bridge 请求失败"));
    return;
  }
  // http.chunk：分帧续段（当前实现宿主侧对 SW 恒单段回传——大响应在宿主侧合并后
  // 一次性回传；此处保留重组逻辑以兼容后续流式分帧）
  if (frame && frame.type === "http.chunk") {
    var entry3 = pending[frame.id];
    if (!entry3) return;
    if (entry3.metaBody && frame.chunk === entry3.nextChunk) {
      entry3.chunks.push(frame);
      entry3.nextChunk += 1;
    } else {
      clearTimeout(entry3.timer);
      delete pending[frame.id];
      entry3.reject(new Error("分帧序列错误"));
    }
  }
}

// ---- 分帧（base64；与宿主同协议）----
function encodeBody(buf) {
  if (!buf || buf.length === 0) return null;
  if (buf.length <= CHUNK_THRESHOLD) {
    return { chunk: 0, data: base64FromBytes(buf), done: true };
  }
  return { chunk: 0, data: base64FromBytes(buf.subarray ? buf.subarray(0, CHUNK_SIZE) : buf.slice(0, CHUNK_SIZE)), done: false };
}
function base64FromBytes(buf) {
  // ArrayBuffer/视图 → base64（浏览器无 Buffer）
  var bytes = new Uint8Array(buf);
  var bin = "";
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function bytesFromBase64(b64) {
  var bin = atob(b64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function rebuildBody(metaBody, chunks) {
  var parts = [];
  var total = 0;
  if (metaBody && metaBody.data) {
    var b = bytesFromBase64(metaBody.data);
    parts.push(b);
    total += b.length;
  }
  for (var i = 0; i < chunks.length; i++) {
    var c = bytesFromBase64(chunks[i].data);
    parts.push(c);
    total += c.length;
  }
  if (total === 0) return null;
  var out = new Uint8Array(total);
  var off = 0;
  for (var j = 0; j < parts.length; j++) {
    out.set(parts[j], off);
    off += parts[j].length;
  }
  return out;
}

// ---- 请求挂起 ----
function sendHttpRequest(method, path, headers, bodyBuf) {
  return new Promise(function (resolve, reject) {
    if (!wsOpen) {
      reject(new Error("bridge 未连接（502）"));
      return;
    }
    var id = nextId();
    var frame = {
      type: "http.request",
      id: id,
      method: method,
      path: path,
      headers: headers || {},
    };
    var enc = encodeBody(bodyBuf);
    if (enc) frame.body = enc;
    var entry = {
      resolve: resolve,
      reject: reject,
      timer: setTimeout(function () {
        delete pending[id];
        reject(new Error("请求超时（" + Math.round(REQUEST_TIMEOUT_MS / 1000) + "s）"));
      }, REQUEST_TIMEOUT_MS),
      metaBody: enc && enc.done === false ? enc : null,
      chunks: [],
      nextChunk: 1,
    };
    pending[id] = entry;
    var ok = sendFrame(frame);
    if (!ok) {
      clearTimeout(entry.timer);
      delete pending[id];
      reject(new Error("bridge 未连接（502）"));
    }
  });
}

function failAllPending(msg) {
  var ids = Object.keys(pending);
  for (var i = 0; i < ids.length; i++) {
    var entry = pending[ids[i]];
    clearTimeout(entry.timer);
    entry.reject(new Error(msg || "bridge 未连接（502）"));
    delete pending[ids[i]];
  }
}

// ---- HTML 改写（绝对路径 → scope 相对）----
// dsh index.html 的资源引用是 "/assets/..." 等绝对路径；改写为
// "/api/plugins/dsh-hanako/web/assets/..."（scope 相对）后落入本 SW 拦截范围。
// 只改属性值中的路径（href=/src=），不改协议绝对 URL（http(s)://、//、data:、#）。
function rewriteHtmlUrls(html) {
  if (typeof html !== "string") return html;
  return html.replace(
    /([ \t\r\n](?:href|src)[ \t\r\n]*=[ \t\r\n]*["'])\/(?!\/)([^"']*)["']/g,
    function (all, prefix, path) {
      // 跳过已带 scope 前缀的
      if (path.indexOf("api/plugins/dsh-hanako/") === 0) return all;
      return prefix + CHANNEL_PREFIX + "/" + path + '"';
    },
  );
}

// ---- fetch 拦截 ----
self.addEventListener("install", function (event) {
  // 立即激活（不等待旧 SW 释放页面控制）
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", function (ev) {
  var data = ev.data;
  if (data && data.type === "bridge-config") {
    config.wsUrl = data.wsUrl || config.wsUrl;
    config.token = data.token || config.token;
    log("收到 bridge-config（wsUrl=" + (config.wsUrl || "(none)") + "）");
    if (!ws) connect();
  }
});

self.addEventListener("fetch", function (event) {
  var url = new URL(event.request.url);
  var pathname = url.pathname;
  // 仅拦截 scope 内请求
  if (pathname.indexOf(CHANNEL_PREFIX + "/") !== 0 && pathname !== CHANNEL_PREFIX) {
    return; // 超出 scope：直放（宿主自身请求/其它）
  }
  var method = event.request.method || "GET";
  // navigate（iframe 首载/刷新）：同样转发（dsh 侧返回 index.html）
  var dshPath = pathname === CHANNEL_PREFIX ? "/" : pathname.slice(CHANNEL_PREFIX.length) + url.search;
  event.respondWith(
    (async function () {
      var headers = {};
      event.request.headers.forEach(function (v, k) {
        // 去掉 hop-by-hop 与浏览器自管头（宿主/dsh 侧会补）
        if (/^(host|connection|upgrade|sec-websocket|accept-encoding|content-length)$/i.test(k)) return;
        headers[k] = v;
      });
      var bodyBuf = null;
      if (method !== "GET" && method !== "HEAD" && event.request.body) {
        bodyBuf = new Uint8Array(await event.request.arrayBuffer());
      }
      var resp;
      try {
        resp = await sendHttpRequest(method, dshPath, headers, bodyBuf);
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "bridge_unavailable", detail: String(e && e.message || e) }),
          {
            status: 502,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          },
        );
      }
      var respHeaders = new Headers();
      var isHtml = false;
      if (resp.headers) {
        Object.keys(resp.headers).forEach(function (k) {
          var v = resp.headers[k];
          if (/^content-length$/i.test(k)) return; // 流式长度由 ReadableStream 自算
          if (/^content-type$/i.test(k) && String(v).indexOf("text/html") !== -1) isHtml = true;
          respHeaders.set(k, v);
        });
      }
      if (!respHeaders.has("content-type") && isHtml) {
        respHeaders.set("content-type", "text/html; charset=utf-8");
      }
      var body = resp.body;
      // HTML 改写（小页面直接缓冲；非 HTML 直接流式）
      if (isHtml && body && body.byteLength && body.byteLength < 2 * 1024 * 1024) {
        var text = new TextDecoder().decode(body);
        var rewritten = rewriteHtmlUrls(text);
        return new Response(rewritten, { status: resp.status, headers: respHeaders });
      }
      var stream = new ReadableStream({
        start: function (controller) {
          if (!body || body.byteLength === 0) {
            controller.close();
            return;
          }
          controller.enqueue(body);
          controller.close();
        },
      });
      return new Response(stream, { status: resp.status, headers: respHeaders });
    })(),
  );
});

// ---- 启动 ----
connect();
startHeartbeat();
