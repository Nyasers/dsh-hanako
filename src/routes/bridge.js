// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/routes/bridge.js — DSHana 统一通道宿主侧路由（M2 + v7 修正）
//
// 挂宿主 web server 插件命名空间 <宿主>/api/plugins/dsh-hanako/：
//   POST /bridge/http   HTTP 隧道（v7 起，SW ↔ 宿主的实际传输）：SW 封装原始 dsh
//                       请求为 JSON { id, method, path, headers, body(base64) } POST
//                       到这里；宿主解包 → 经 WS #2 转发 dsh（lib/bridge.js
//                       bridgeRequestHttp，id 配对 + 分帧重组 + 30s 超时）→ 回传
//                       { ok, id, status, headers, body(base64) }。无 socket 依赖，
//                       走宿主普通 HTTP 路由；凭据由宿主鉴权层处理（页面 token /
//                       X-Hana-Plugin-Surface-Session，与 /webui/* 同层），路由内
//                       不再额外鉴权。WS #2 未连接 → 502 { ok:false, error }。
//   GET  /bridge         WS #1 端点（一期实现，保留作宿主未来支持 upgrade 时的通道，
//                        标记 deprecated）。宿主 0.769.0 实测边界：插件路由经宿主
//                        `rft` 再分发（t.fetch(d, { pluginRouteRequest })，
//                        bundle L43942-43960）——upgrade 的 raw socket 与 env
//                        （{ incoming, outgoing }）在再分发中丢失，插件 handler 拿
//                        不到 c.env.incoming；且宿主 upgradeWebSocket helper 依赖
//                        模块私有 Symbol（CONNECTION_SYMBOL_KEY）与闭包 pending 表，
//                        插件侧无法复刻 → 101 无法完成。本端点按「能拿到底层 socket
//                        就完成 RFC6455 升级，拿不到返回明确诊断 400」实现；宿主
//                        未来版本若把 socket 经 env 暴露，无需改动即可工作。
//   GET  /bridge/status  桥诊断（WS #2 运行/连接 + SW 连接数），壳页面 health 用。
//   GET  /sw.js          service worker 脚本（scope /api/plugins/dsh-hanako/web/）。
import { createHash } from "node:crypto";
import { bridgeStatus, bridgeRequestHttp, registerSwConnection } from "../lib/bridge.js";
import { WsConnection } from "../lib/ws-lib.js";
// SW 脚本（构建期 asset/source 内联为字符串；经 /sw.js 路由 serve，content-type 正确）
import swSource from "../assets/sw.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ---- RFC6455 握手响应头（无 socket 时无法写入；供诊断/未来 socket 路径共用）----
function acceptKey(key) {
  return createHash("sha1")
    .update(String(key || "") + WS_GUID)
    .digest("base64");
}

export default function registerBridgeRoutes(app, ctx) {
  // WS #1 端点：SW 连入。浏览器/Node WebSocket 客户端发 GET + Upgrade: websocket，
  // 宿主 upgrade 分发把它作为普通 GET 请求路由到本 handler（raw socket 视宿主版本
  // 决定是否可达）。
  app.get("/bridge", (c) => {
    const upgrade = String(c.req.header("upgrade") || "").toLowerCase();
    if (upgrade !== "websocket") {
      // 普通 GET（非升级）：回桥状态 JSON（便于直接 curl 排查）
      return c.json({ ok: true, bridge: bridgeStatus() });
    }
    // 尝试取 raw socket：Hono 上下文 env.incoming 是宿主 upgrade 分发的 raw
    // IncomingMessage（0.769.0 经 rft 再分发后不可达，见文件头注释）
    const incoming = c.env && c.env.incoming;
    const socket = incoming && incoming.socket;
    if (!incoming || !socket) {
      // 宿主边界：拿不到 raw socket → 明确诊断（不静默失败）
      ctx.log?.warn?.(
        "[dsh-hanako] /bridge WS 端点：宿主 upgrade 分发未暴露 raw socket（宿主 0.769.0 边界），无法完成 RFC6455 升级；WS #1 通道不可用",
      );
      return c.json(
        {
          error: "bridge_ws_unavailable",
          detail:
            "宿主 upgrade 分发未把 raw socket 传给插件路由（host 0.769.0 边界：rft 再分发丢失 env.incoming，upgradeWebSocket helper 依赖宿主私有 Symbol）。插件端点无法完成 RFC6455 升级。",
        },
        400,
      );
    }
    // 拿到 raw socket：完成握手 + 接入 bridge 帧分发（未来宿主路径）
    const key = c.req.header("sec-websocket-key");
    if (!key) {
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return c.body(null);
    }
    try {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Accept: " +
          acceptKey(key) +
          "\r\n\r\n",
      );
    } catch (e) {
      ctx.log?.warn?.(
        "[dsh-hanako] /bridge WS 握手写入失败:",
        e?.message || String(e),
      );
      try {
        socket.destroy();
      } catch {
        /* 忽略 */
      }
      return c.body(null);
    }
    // 接入 bridge（ws-lib 连接对象化：以 socket 为底层重建 WsConnection）
    const conn = new WsConnection(socket, incoming);
    registerSwConnection(conn);
    return c.body(null);
  });

  // ---- HTTP 隧道（v7 起，SW ↔ 宿主的实际传输）----
  // SW 封装原始 dsh 请求 { id, method, path, headers, body(base64) } POST 到这里；
  // 宿主经 lib/bridge.js bridgeRequestHttp 发起 WS #2 http.request 帧转发 dsh，
  // 等待响应（id 配对 + 分帧重组 + 30s 超时）后回传 { ok, id, status, headers,
  // body(base64) }。凭据由宿主鉴权层处理（页面 token / X-Hana-Plugin-Surface-Session，
  // 与 /webui/* 同层）；路由内不额外鉴权。WS #2 未连接 → 502。body 大时分帧由
  // WS #2 通道内部处理（>256KB base64 分段），本路由对 SW 恒定单 JSON 往返。
  app.post("/bridge/http", async (c) => {
    let envelope = null;
    try {
      envelope = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "请求体不是合法 JSON" }, 400);
    }
    if (!envelope || typeof envelope !== "object") {
      return c.json({ ok: false, error: "请求体缺失" }, 400);
    }
    const id = typeof envelope.id === "string" ? envelope.id : null;
    try {
      const result = await bridgeRequestHttp({
        id,
        method: envelope.method,
        path: envelope.path,
        headers: envelope.headers,
        body:
          typeof envelope.body === "string" && envelope.body.length > 0
            ? Buffer.from(envelope.body, "base64")
            : null,
      });
      return c.json({
        ok: true,
        id: result.id,
        status: result.status,
        headers: result.headers,
        body: result.body === null ? null : result.body.toString("base64"),
      });
    } catch (e) {
      // WS #2 未连接（502）/ 超时（504）/ dsh 错误（502）：统一回 JSON + 状态码
      return c.json(
        { ok: false, id, error: String(e?.message || e) },
        e?.status || 502,
      );
    }
  });

  // 桥诊断端点（非升级请求，普通 HTTP）：WS #2 运行/连接状态 + WS #1 连接数
  app.get("/bridge/status", (c) => {
    return c.json({ ok: true, bridge: bridgeStatus() });
  });

  // service worker 脚本：壳页面 navigator.serviceWorker.register 从这里加载
  // （/api/plugins/dsh-hanako/sw.js，content-type application/javascript；scope 取
  // /api/plugins/dsh-hanako/web/ 在脚本目录之下，无需 Service-Worker-Allowed 头；
  // 宿主白名单亦原生 serve 插件根 sw.js，本路由为兼容/覆盖）
  app.get("/sw.js", (c) => {
    c.header("Content-Type", "application/javascript; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    return c.body(swSource);
  });

  // /web 通道代理端点：远程访问时 iframe 指向 /web（scope 外，无尾斜杠），由宿主
  // 直接提供 dsh 页面——index 不经 SW（SW 激活与否不影响入口，杜绝 about:blank/404）。
  // 逻辑：fetch dsh web host（127.0.0.1:<port>）对应路径 → HTML/CSS 绝对路径改写
  // （/assets → /api/plugins/dsh-hanako/web/assets）→ 回传。
  // 端口与 webui.js 同源（manifest 默认 + 用户配置合并的 ctx.config；非对象回退 3080）
  const dshCfg = ctx && typeof ctx.config === "object" && ctx.config ? ctx.config : {};
  const dshPort = () => Number(dshCfg.webPort) || 3080;
  // HTML 改写（绝对路径 → scope 相对，与 sw.js rewriteHtmlUrls 同逻辑）
  function rewriteHtmlUrls(html) {
    return String(html).replace(
      /([ \t\r\n](?:href|src)[ \t\r\n]*=[ \t\r\n]*)(["'])\/(?!\/)([^"']*)\2/g,
      (all, prefix, quote, path) => {
        if (path.indexOf("api/plugins/dsh-hanako/") === 0) return all;
        return prefix + quote + "/api/plugins/dsh-hanako/web/" + path + quote;
      },
    );
  }
  // CSS 改写（url() 绝对路径 → scope 相对）
  function rewriteCssUrls(css) {
    return String(css).replace(
      /url\((["']?)\/(?!\/)([^"')]+)\1\)/g,
      (all, quote, path) => {
        if (path.indexOf("api/plugins/dsh-hanako/") === 0) return all;
        return "url(" + quote + "/api/plugins/dsh-hanako/web/" + path + quote + ")";
      },
    );
  }
  // /web 与 /web/* 统一代理（GET/POST/HEAD；HTML/CSS 改写，其余透传）
  app.all("/web*", async (c) => {
    const url = new URL(c.req.url, "http://dsh.internal");
    let path = url.pathname;
    if (path === "/web" || path === "/web/") path = "/";
    else if (path.startsWith("/web/")) path = path.slice(4);
    else return c.text("not found", 404);
    const method = c.req.method || "GET";
    const port = dshPort();
    try {
      const headers = {};
      // 转发关键头（Host 必须为 dsh loopback——isTrustedApiRequest 可信校验）；
      // 剥离浏览器跨站标记（Origin/Referer/sec-fetch-*，进程内转发无跨站概念）
      for (const [k, v] of Object.entries(c.req.headers || {})) {
        const lk = k.toLowerCase();
        if (/^(host|origin|referer|sec-fetch-|connection|upgrade|accept-encoding)$/i.test(lk)) continue;
        if (typeof v === "string") headers[k] = v;
      }
      headers["host"] = "127.0.0.1:" + port;
      const body = method !== "GET" && method !== "HEAD" ? await c.req.arrayBuffer() : undefined;
      const upstream = await fetch("http://127.0.0.1:" + port + path + url.search, {
        method,
        headers,
        body,
        redirect: "manual",
      });
      const ct = String(upstream.headers.get("content-type") || "");
      const buf = Buffer.from(await upstream.arrayBuffer());
      let out = buf;
      if (buf.length < 2 * 1024 * 1024) {
        if (ct.indexOf("text/html") !== -1) {
          out = Buffer.from(rewriteHtmlUrls(buf.toString("utf8")), "utf8");
        } else if (ct.indexOf("text/css") !== -1) {
          out = Buffer.from(rewriteCssUrls(buf.toString("utf8")), "utf8");
        }
      }
      const outHeaders = {};
      for (const [k, v] of upstream.headers.entries()) {
        if (/^(content-length|content-encoding|transfer-encoding|connection|upgrade)$/i.test(k)) continue;
        outHeaders[k] = v;
      }
      c.header("Content-Type", ct || "application/octet-stream");
      c.header("Cache-Control", "no-store");
      c.status(upstream.status);
      return c.body(out);
    } catch (e) {
      return c.json({ ok: false, error: "代理 dsh 失败：" + String(e?.message || e) }, 502);
    }
  });
}
