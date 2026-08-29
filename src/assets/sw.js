// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// assets/sw.js — DSHana 统一通道（bridge）浏览器侧 service worker（M4 + v7）
//
// 职责：拦截 scope（/api/plugins/dsh-hanako/web/）内 dsh 页面的一切请求，经 **HTTP 隧道**
// （v7 起，替代一期 WS #1——宿主 0.769.0 插件路由 rft 再分发丢 upgrade socket，WS #1 101
// 无法完成）转发：封装 { id, method, path, headers, body(base64) } POST 到隧道 URL（宿主
// 普通 HTTP 路由 /api/plugins/dsh-hanako/bridge/http，宿主鉴权层经 X-Hana-Plugin-Surface-
// Session 放行）→ 宿主经 WS #2 转发 dsh 进程内执行 → 响应 { id, status, headers,
// body(base64) } 回传 → event.respondWith(new Response(bytes, { status, headers }))。
//
// 无长连接：HTTP 隧道每次请求独立往返，无重连/心跳；pending 请求超时（30s）失败返回 502。
//
// HTML 改写（scope 收窄的配套）：dsh index.html 用绝对路径引用资源（/assets/* 等），
// 在宿主 origin 下会解析到宿主根路径（脱离 scope）。本 SW 对 text/html 响应做一次
// 轻量改写：把属性值里的 "/xxx" 绝对路径改写为 scope 相对（"/api/plugins/dsh-hanako/
// web/xxx"），让静态资源请求落入 scope 被本 SW 继续转发。dsh 运行期 JS 的绝对
// /api/* 调用与实时 WebSocket（events.mux/host）不受 SW 控制，属二期 __DSH_TRANSPORT__
// 隧道范围。
//
// 注入：隧道 URL + surfaceSession 由壳页面经 navigator.serviceWorker.controller.postMessage
// 下发（{ type:"bridge-config", mode:"http-tunnel", tunnelUrl, surfaceSession }）；
// 壳页面 await navigator.serviceWorker.ready 后才挂 iframe。tunnelUrl 在壳页面拼一次
// （location.origin + /api/plugins/dsh-hanako/bridge/http），SW 零拼接。
//
// 本文件以纯脚本（非模块）形式经宿主通道 /api/plugins/dsh-hanako/sw.js 提供
// （routes/bridge.js 路由 serve，content-type: application/javascript）。

/* global self, fetch, Response, ReadableStream, TextDecoder, btoa, atob */

var CHANNEL_PREFIX = "/api/plugins/dsh-hanako/web"; // scope（无尾斜杠比较用）
var REQUEST_TIMEOUT_MS = 30000; // 单次隧道请求超时

var config = { tunnelUrl: null, surfaceSession: null }; // 壳页面注入（bridge-config）
var seq = 0;

// ---- 配置持久化（cacheStorage）----
// SW worker 可能被浏览器回收（空闲销毁）后冷启动重建，内存 config 丢失；页面若未
// 重新 postMessage bridge-config，隧道请求会因 tunnelUrl 为空而 502。这里把配置写入
// Cache Storage，冷启动时（activate）恢复；写入失败不影响运行（下次页面消息再补）。
var CONFIG_CACHE = "dsh-hanako-bridge-config-v1";
function persistConfig() {
  try {
    return caches.open(CONFIG_CACHE).then(function (cache) {
      return cache.put("/bridge-config", new Response(JSON.stringify(config)));
    }).catch(function () { /* 持久化失败不影响 */ });
  } catch (e) {
    return Promise.resolve();
  }
}
function restoreConfig() {
  try {
    // 超时保护：activate 不能被缓存恢复阻塞（CacheStorage 初始化异常时挂起会让
    // worker 卡在 activating，ready 永不 resolve，壳页面 iframe 白屏）。500ms 超时
    // 忽略恢复，配置缺失由页面下次 bridge-config 消息补齐。
    var restore = caches.open(CONFIG_CACHE).then(function (cache) {
      return cache.match("/bridge-config").then(function (resp) {
        if (!resp) return;
        return resp.json().then(function (data) {
          if (data && typeof data.tunnelUrl === "string" && data.tunnelUrl) {
            config.tunnelUrl = data.tunnelUrl;
            config.surfaceSession = (data.surfaceSession || "");
            log("从缓存恢复 bridge-config（tunnelUrl=" + config.tunnelUrl + "）");
          }
        });
      });
    }).catch(function () { /* 恢复失败忽略 */ });
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () { if (!done) { done = true; resolve(); } };
      restore.then(finish, finish);
      setTimeout(finish, 500);
    });
  } catch (e) {
    return Promise.resolve();
  }
}

// ---- 日志（调试用；正式环境可关）----
function log(msg) {
  console.log("[dsh-hanako-sw] " + msg);
}

function nextId() {
  seq += 1;
  return "r" + seq;
}

// ---- base64 编解码（浏览器无 Buffer）----
function base64FromBytes(buf) {
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

// ---- 配置主动索取（双向握手）----
// 壳页面在 navigator.serviceWorker.ready 后才 postMessage bridge-config；若 ready
// 卡住（activate 延迟）或 SW 冷启动后缓存缺失，config.tunnelUrl 为空，拦截请求会
// 502 bridge_unavailable。这里在隧道请求前检查：配置缺失时向所有 window 客户端
// 发 bridge-config-request，壳页面收到后重发 bridge-config（1.5s 超时，拿不到就 502）。
var configRequestId = 0;
function ensureConfig() {
  if (config.tunnelUrl) return Promise.resolve(true);
  var id = ++configRequestId;
  return new Promise(function (resolve) {
    var timer = null;
    var done = false;
    var finish = function (ok) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      self.removeEventListener("message", onMsg);
      resolve(ok);
    };
    var onMsg = function (ev) {
      var d = ev.data;
      if (
        d &&
        d.type === "bridge-config" &&
        d.mode === "http-tunnel" &&
        typeof d.tunnelUrl === "string" &&
        d.tunnelUrl
      ) {
        config.tunnelUrl = d.tunnelUrl;
        config.surfaceSession = d.surfaceSession || config.surfaceSession || "";
        persistConfig();
        log("配置缺失时从客户端获取 bridge-config（" + config.tunnelUrl + "）");
        finish(true);
      }
    };
    self.addEventListener("message", onMsg);
    self.clients.matchAll({ type: "window" }).then(function (clients) {
      clients.forEach(function (c) {
        try {
          c.postMessage({ type: "bridge-config-request", id: id });
        } catch (e) { /* 单个客户端失败忽略 */ }
      });
    }).catch(function () { /* matchAll 失败忽略 */ });
    timer = setTimeout(function () {
      log("bridge-config 索取超时（1.5s），请求将 502");
      finish(false);
    }, 1500);
  });
}

// ---- HTTP 隧道请求（v7）----
// 封装原始 dsh 请求为 JSON POST 到隧道 URL；响应 { ok, id, status, headers, body(base64) }。
// 大 body 以 base64 单段携带（WS #2 通道内部 >256KB 分段对 SW 透明）。失败/未就绪 reject
// （status 502/504 由调用方转 HTTP 状态码）。
async function tunnelRequest(method, path, headers, bodyBuf) {
  if (!config.tunnelUrl) {
    // 配置缺失：先主动向客户端索取（双向握手），仍拿不到才 502
    var got = await ensureConfig();
    if (!got) {
      var e0 = new Error("bridge 未就绪（隧道 URL 未配置）");
      e0.status = 502;
      throw e0;
    }
  }
  var envelope = {
    id: nextId(),
    method: method,
    path: path,
    headers: headers || {},
    body: bodyBuf && bodyBuf.byteLength > 0 ? base64FromBytes(bodyBuf) : null,
  };
  var resp;
  try {
    resp = await fetch(config.tunnelUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // 宿主鉴权（与壳页面 surfaceHeaders() 同款 legacy 底层协议）
        "X-Hana-Plugin-Surface-Session": config.surfaceSession || "",
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // 网络错误/超时
    var e1 = new Error("隧道请求失败：" + String((err && err.message) || err));
    e1.status = err && err.name === "TimeoutError" ? 504 : 502;
    throw e1;
  }
  var data = null;
  try {
    data = await resp.json();
  } catch (err) {
    var e2 = new Error("隧道响应解析失败（HTTP " + resp.status + "）");
    e2.status = 502;
    throw e2;
  }
  if (!data || data.ok !== true) {
    var e3 = new Error((data && data.error) || ("隧道 HTTP " + resp.status));
    e3.status = resp.status || 502;
    throw e3;
  }
  return {
    status: Number(data.status) || 200,
    headers: data.headers && typeof data.headers === "object" ? data.headers : {},
    body: typeof data.body === "string" && data.body.length > 0 ? bytesFromBase64(data.body) : null,
  };
}

// ---- HTML 改写（绝对路径 → scope 相对）----
// dsh index.html 的资源引用是 "/assets/..." 等绝对路径；改写为
// "/api/plugins/dsh-hanako/web/assets/..."（scope 相对）后落入本 SW 拦截范围。
// 只改属性值中的路径（href=/src=），不改协议绝对 URL（http(s)://、//、data:、#）。
// 引号处理：捕获开头引号（' 或 "），用反向引用 \2 复用同一引号闭合重写后的值——
// 单引号属性（href='/assets/x.js'）不会变成双引号开头单引号结尾的不闭合串。
function rewriteHtmlUrls(html) {
  if (typeof html !== "string") return html;
  return html.replace(
    /([ \t\r\n](?:href|src)[ \t\r\n]*=[ \t\r\n]*)(["'])\/(?!\/)([^"']*)\2/g,
    function (all, prefix, quote, path) {
      // 跳过已带 scope 前缀的
      if (path.indexOf("api/plugins/dsh-hanako/") === 0) return all;
      return prefix + quote + CHANNEL_PREFIX + "/" + path + quote;
    },
  );
}

// ---- SW 生命周期 ----
self.addEventListener("install", function (event) {
  // 立即激活（不等待旧 SW 释放页面控制）
  event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", function (event) {
  event.waitUntil(Promise.all([self.clients.claim(), restoreConfig()]));
});

self.addEventListener("message", function (ev) {
  var data = ev.data;
  if (data && data.type === "bridge-config" && data.mode === "http-tunnel") {
    config.tunnelUrl = data.tunnelUrl || config.tunnelUrl;
    config.surfaceSession = data.surfaceSession || config.surfaceSession || "";
    log("收到 bridge-config（http-tunnel，tunnelUrl=" + (config.tunnelUrl || "(none)") + "）");
    // 持久化：SW 被回收冷启动后从缓存恢复（见 persistConfig/restoreConfig）
    persistConfig();
  }
});

// ---- fetch 拦截 ----
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
        resp = await tunnelRequest(method, dshPath, headers, bodyBuf);
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "bridge_unavailable", detail: String((e && e.message) || e) }),
          {
            status: (e && e.status) || 502,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          },
        );
      }
      var respHeaders = new Headers();
      var isHtml = false;
      if (resp.headers) {
        Object.keys(resp.headers).forEach(function (k) {
          var v = resp.headers[k];
          if (/^content-length$/i.test(k)) return; // 流式长度由 Response 自算
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