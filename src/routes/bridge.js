// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/routes/bridge.js — DSHana 统一通道 WS #1 端点（M2）
//
// 挂宿主 web server 插件命名空间：<宿主>/api/plugins/dsh-hanako/bridge
//   SW（浏览器 service worker）连入：query token 过宿主全局鉴权墙后，upgrade 事件
//   经宿主 Hono app 分发到插件路由（实证：宿主 injectWebSocket 把 upgrade 交给
//   e.app.request(c, { headers }, u) 完整路由分发，见 artifacts/server/0.769.0/
//   bundle/index.js L1916-1942），这里注册 /bridge 处理升级。
//
// ⚠️ 宿主 0.769.0 实测边界（实现时考古确认，见 design-unified-channel §1/§7 与
// 下方注释）：插件路由经宿主 `rft` 再分发（t.fetch(d, { pluginRouteRequest })，
// bundle L43942-43960）——raw socket 与 env（{ incoming, outgoing }）在再分发中
// 丢失，插件 handler 拿不到 c.env.incoming；且宿主 upgradeWebSocket helper 依赖
// 模块私有 Symbol（CONNECTION_SYMBOL_KEY）与闭包 pending 表，插件侧无法复刻。
// 因此本端点按「能拿到底层 socket 就完成 RFC6455 升级，拿不到则返回明确诊断」实现：
//   · 若宿主未来版本把 raw socket 经 env 传给插件路由（env.incoming），本端点
//     直接完成握手 + 接入 bridge 帧分发（registerSwConnection），无需改动；
//   · 当前 0.769.0 下返回 HTTP 400 + JSON 诊断（WS 客户端会看到握手失败，
//     错误体解释宿主限制），WS #1 通道的运行时验证由主上下文实机判定。
//
// 另注册 GET /bridge/status：桥诊断（WS #2 是否运行/连接、WS #1 连接数），供
// 壳页面 /webui/health 与人工排查使用（非升级请求，普通 HTTP 可达）。
import { createHash } from "node:crypto";
import { bridgeStatus, registerSwConnection } from "../lib/bridge.js";
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

  // 桥诊断端点（非升级请求，普通 HTTP）：WS #2 运行/连接状态 + WS #1 连接数
  app.get("/bridge/status", (c) => {
    return c.json({ ok: true, bridge: bridgeStatus() });
  });

  // service worker 脚本：壳页面 navigator.serviceWorker.register 从这里加载
  // （/api/plugins/dsh-hanako/sw.js，content-type application/javascript；scope 取
  // /api/plugins/dsh-hanako/web/ 在脚本目录之下，无需 Service-Worker-Allowed 头）
  app.get("/sw.js", (c) => {
    c.header("Content-Type", "application/javascript; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    return c.body(swSource);
  });
}
