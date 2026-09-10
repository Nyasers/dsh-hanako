// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/bridge.js — DSH 访问中继（受管 runtime 子进程内）
//
// 为什么存在：向官方样例 hana-dsh 看齐后，DSH 的鉴权面交回官方 @deepseek-ai/dsh-client-connection
// （BrowserAuth：进程 token → 303 Set-Cookie → authority 绑定签名 cookie）。宿主 runtime 代理
// 会剥离 cookie/authorization，App 页与 App 主进程都无法携带 DSH 凭据，因此 DSH 端口不能直接
// 作为 service 暴露。本中继是唯一的服务面：注册给宿主的 service.port = 中继端口，其余请求一
// 律由中继带 DSH cookie 转发到真实 DSH 端口。
//
// 形态（对齐 hana-dsh 的 runtime/bridge.mjs，零第三方依赖实现）：
//   · key 鉴权：header `x-hana-dsh-bridge: <key>`，或路径前缀 `/_hana/<key>/<rest>`（浏览器
//     iframe 无法自定 header，走路径票据形态）。key 只在本进程与 App 主进程间共享，绝不发往
//     DSH——它的唯一职责是不让回环端口变成「第二个无鉴权面」（DSH 端口本身仍只认自己的 cookie）。
//   · cookie 注入：转发时统一补 `cookie: <DSH cookie>`，剥离客户端自带的 cookie/authorization。
//   · 上游重定向重写：只放行同源 Location，其余 502（防 DSH 被当成开放代理）。
//   · WS 升级：`/api/remote.mux` 等事件流按原始 socket 双向透传（不解析帧，握手响应原样回写）。
//
// 上游恒为 127.0.0.1 回环 HTTP。

import { createServer } from "node:http";
import { connect as netConnect } from "node:net";
import { timingSafeEqual } from "node:crypto";

const MAX_WS_BUFFER = 1024 * 1024;
const HOP_BY_HOP = new Set([
  "connection", "upgrade", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding",
]);

/** 恒定时间比较（等长前提下；长度不等直接 false，不泄漏内容）。 */
export function matchesKey(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/**
 * 请求鉴权与路径归一（纯函数，便于单测）。
 * 接受两种凭据形态：header key，或路径 `/_hana/<key>/<rest>`（剥前缀）。
 * @returns {{ path: string, search: string } | null} 归一后的上游相对路径；null = 未通过
 */
export function authorizeBridgeRequest(requestUrl, headerKey, bridgeKey) {
  const requested = new URL(requestUrl || "/", "http://bridge.invalid");
  if (matchesKey(headerKey, bridgeKey)) return { path: requested.pathname, search: requested.search };
  const parts = requested.pathname.split("/");
  if (parts[1] !== "_hana") return null;
  let decoded;
  try { decoded = decodeURIComponent(parts[2]); } catch { return null; }
  if (!matchesKey(decoded, bridgeKey)) return null;
  return { path: "/" + parts.slice(3).join("/"), search: requested.search };
}

/** 上游请求头构造：剥跳头/凭据/宿主头，补上游 host/origin 与 DSH cookie。 */
export function upstreamRequestHeaders(headers, upstream, cookie) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower.startsWith("sec-websocket-")) continue;
    if (lower === "authorization" || lower === "cookie" || lower === "host" || lower === "origin") continue;
    if (lower === "x-hana-dsh-bridge") continue;
    result[name] = value;
  }
  result.host = upstream.host;
  result.origin = upstream.origin;
  if (cookie) result.cookie = cookie;
  return result;
}

/** 同源 Location 归一（上游 302 指向自身则改写成代理前缀可见的相对路径；跨源返回 null）。 */
export function safeLocation(location, upstream) {
  if (!location) return null;
  let target;
  try { target = new URL(location, upstream); } catch { return null; }
  if (target.origin !== upstream.origin) return null;
  return `${target.pathname}${target.search}${target.hash}`;
}

/** 上游目标 URL（同源：只取路径与查询）。 */
export function sameOriginTarget(requestUrl, upstream) {
  const requested = new URL(requestUrl || "/", "http://bridge.invalid");
  const target = new URL(upstream);
  target.pathname = requested.pathname;
  target.search = requested.search;
  return target;
}

/** 序列化头（WS 升级请求用；值为数组时逐行写出）。 */
function serializeHeaders(headers) {
  const lines = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) lines.push(`${name}: ${v}`);
    else lines.push(`${name}: ${value}`);
  }
  return lines.join("\r\n");
}

/** 等待 drain 或中止（背压）。 */
function waitForDrain(response, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      response.off("drain", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    response.once("drain", done);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * 起中继（监听 127.0.0.1:port）。
 * @param {{port:number, bridgeKey:string, upstreamOrigin:string, upstreamCookie?:string, log?:(s:string)=>void}} opts
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
export async function startDshBridge(opts) {
  const { port, bridgeKey, upstreamOrigin, upstreamCookie = "", log = () => {} } = opts || {};
  const upstream = new URL(upstreamOrigin);
  if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1") {
    throw new Error("dshana bridge：上游必须是 127.0.0.1 的 loopback HTTP 源");
  }
  if (!bridgeKey) throw new Error("dshana bridge：bridgeKey 必填");

  const activeRequests = new Set();
  const upstreamSockets = new Set();

  function rejectJson(res, status, message) {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }

  const server = createServer(async (req, res) => {
    const authorized = authorizeBridgeRequest(req.url, req.headers["x-hana-dsh-bridge"], bridgeKey);
    if (!authorized) {
      rejectJson(res, 403, "DSH bridge authorization required");
      return;
    }
    const controller = new AbortController();
    activeRequests.add(controller);
    const abort = () => controller.abort();
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      const response = await fetch(sameOriginTarget(`${authorized.path}${authorized.search}`, upstream), {
        method: req.method,
        headers: upstreamRequestHeaders(req.headers, upstream, upstreamCookie),
        redirect: "manual",
        signal: controller.signal,
        ...(req.method === "GET" || req.method === "HEAD" ? {} : { body: req, duplex: "half" }),
      });
      const headers = new Headers(response.headers);
      headers.delete("set-cookie");
      headers.delete("connection");
      headers.delete("content-encoding");
      headers.delete("content-length");
      const location = headers.get("location");
      if (location) {
        const safe = safeLocation(location, upstream);
        if (!safe) {
          await response.body?.cancel().catch(() => {});
          rejectJson(res, 502, "DSH bridge rejected an external redirect");
          return;
        }
        headers.set("location", safe);
      }
      res.writeHead(response.status, Object.fromEntries(headers.entries()));
      if (!response.body) return res.end();
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        while (!controller.signal.aborted) {
          const part = await reader.read();
          if (part.done) break;
          if (!res.write(part.value)) await waitForDrain(res, controller.signal);
        }
        if (!controller.signal.aborted) res.end();
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => {});
      }
    } catch (error) {
      if (!res.headersSent && !controller.signal.aborted) {
        rejectJson(res, 502, error instanceof Error ? error.message : "DSH bridge upstream unavailable");
      } else if (!res.destroyed) {
        res.destroy(error instanceof Error ? error : undefined);
      }
    } finally {
      activeRequests.delete(controller);
      req.off("aborted", abort);
      res.off("close", abort);
    }
  });

  // WS 升级：原始 socket 双向透传（握手请求改写 Host/Origin/Cookie 后转上游，响应原样回写）。
  server.on("upgrade", (req, clientSocket, head) => {
    const requested = new URL(req.url || "/", "http://bridge.invalid");
    const queryKey = requested.searchParams.get("dshBridge");
    requested.searchParams.delete("dshBridge");
    const authorized = authorizeBridgeRequest(`${requested.pathname}${requested.search}`, queryKey, bridgeKey);
    if (!authorized) {
      clientSocket.destroy();
      return;
    }
    const headers = upstreamRequestHeaders(req.headers, upstream, upstreamCookie);
    const upstreamSocket = netConnect(Number(upstream.port), upstream.hostname, () => {
      upstreamSocket.write(
        `GET ${authorized.path}${authorized.search} HTTP/1.1\r\n` +
        serializeHeaders(headers) + "\r\n\r\n",
      );
      if (head && head.length) upstreamSocket.write(head);
    });
    upstreamSockets.add(upstreamSocket);
    const closeBoth = () => {
      upstreamSockets.delete(upstreamSocket);
      upstreamSocket.destroy();
      clientSocket.destroy();
    };
    upstreamSocket.on("error", closeBoth);
    clientSocket.on("error", closeBoth);
    upstreamSocket.on("close", closeBoth);
    clientSocket.on("close", closeBoth);
    // 双向字节透传（WS 帧由两端自行协商，中继不介入）
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      log(`bridge 监听 127.0.0.1:${server.address().port} → ${upstream.origin}`);
      resolve();
    });
  });

  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve) => {
        for (const controller of activeRequests) controller.abort();
        for (const socket of upstreamSockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export { MAX_WS_BUFFER };
