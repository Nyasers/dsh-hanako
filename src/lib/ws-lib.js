// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/ws-lib.js — 零依赖 RFC6455 WebSocket 服务端原语（bridge 专用）
//
// 背景：dsh-hanako 插件本体零依赖打包（rspack externalsPresets.node —— node 内置模块
// 保持外部 import，其余全部内联）。WS #2（宿主 ↔ dsh 进程间通道）与 WS #1（SW ↔ 宿主
// 端点）都需要**服务端** WebSocket：宿主 node 虽有全局 WebSocket（Node 22+，仅客户端），
// 但没有内置服务端实现；宿主 node_modules 的 ws 库不保证插件 bundle 可依赖。因此这里
// 用 node:http 的 'upgrade' 事件 + 手写最小 RFC6455 服务端（握手 + 帧编解码），零运行时
// 依赖（约 200 行，足够承载 JSON 文本帧通道：握手一次 + 文本帧收发 + 协议级 ping/pong +
// close）。
//
// 本模块只做协议原语，不含业务帧分发：
//   createWsServer(options) → 启动一个 http server 并处理 upgrade：
//     onConnection(conn)     —— 握手成功后回调（conn 见下）
//     onError(err)           —— 监听/握手层错误（默认 console.warn）
//   conn（单连接对象）：
//     conn.sendText(text)    —— 发文本帧（自动分片：> 16KB 按 16KB 分片，与 RFC6455
//                               续帧语义一致；对端标准 WebSocket 自动重组）
//     conn.sendPing(payload) —— 发协议级 ping 帧
//     conn.close(code, reason)
//     conn.on("message", (text) => ...)  文本帧（自动拼接续帧）
//     conn.on("close", (code, reason) => ...)
//     conn.on("error", (err) => ...)
//     conn.remoteAddress / conn.readyState
// 帧解析：支持 FIN/opcode（1 文本/2 二进制/8 close/9 ping/10 pong）、MASK 位、7/16/64 位
// 长度、掩码异或；分片消息跨帧缓冲（本通道只发文本，二进制帧按文本解码兜底）。
// 协议级 ping：收到 ping 自动回 pong（RFC 语义）；收到 pong 记 lastPongAt（心跳检测用）。
// close：收到 close 帧回 close 并销毁；主动 close 发 close 帧后等待对端 close/超时销毁。
// 安全：upgrade 请求校验 GET 方法 + Upgrade: websocket + Sec-WebSocket-Key；
// 握手响应带正确 Sec-WebSocket-Accept（SHA1(key + GUID) base64）。
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// CRLF 行结束符（HTTP 握手响应用；避免在源码字符串里写转义序列被构建链改写）
const CRLF = String.fromCharCode(13) + String.fromCharCode(10);
const READY_CONNECTING = 0;
const READY_OPEN = 1;
const READY_CLOSING = 2;
const READY_CLOSED = 3;
// 单帧数据载荷上限（16KB）：超过按 RFC6455 续帧（FIN=0）分片发送，避免大帧阻塞
// socket 写；对端标准 WebSocket 自动重组，本通道对端（undici/浏览器）均支持。
const MAX_FRAME_PAYLOAD = 16 * 1024;
// 主动 close 后等待对端 close 帧的超时（超时直接销毁 socket）
const CLOSE_GRACE_MS = 3000;

/** 计算 Sec-WebSocket-Accept（RFC6455 §4.2.2） */
function acceptKey(key) {
  return createHash("sha1")
    .update(String(key || "") + WS_GUID)
    .digest("base64");
}

/** 编码一帧（服务端 → 客户端：恒不掩码）。opcode：1 文本 / 2 二进制 / 8 close / 9 ping / 10 pong */
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "");
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN=1
  return Buffer.concat([header, data]);
}

/**
 * 单连接对象：封装 socket 上的帧收发 + 分片重组 + 心跳观察。
 * 使用方经 createWsServer 的 onConnection 拿到；内部持有 socket 写锁（并发写串行化）。
 */
class WsConnection extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.readyState = READY_OPEN;
    // 基线 error 监听：EventEmitter 无 error 监听时抛未捕获异常，连接错误必须静默兜底
    // （调用方可再挂自己的 error 监听；本监听保证任何路径都不会因连接错误崩溃进程）
    this.on("error", () => {});
    this.remoteAddress =
      (socket.remoteAddress || "") + (socket.remotePort ? ":" + socket.remotePort : "");
    this.lastPongAt = Date.now();
    // 分片重组缓冲
    this._fragments = [];
    this._fragmentOpcode = 0;
    this._writeQueue = Promise.resolve();
    this._closeTimer = null;

    socket.setNoDelay?.(true);
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("error", (err) => {
      this._fail(err);
    });
    socket.on("close", () => {
      this._finalize(1006, "socket closed");
    });
  }

  /** 帧解析状态机（跨 chunk 累积） */
  _onData(chunk) {
    if (this.readyState === READY_CLOSED) return;
    this._buffer = this._buffer ? Buffer.concat([this._buffer, chunk]) : chunk;
    let consumed = true;
    while (consumed) {
      consumed = this._tryParseFrame();
    }
  }

  _tryParseFrame() {
    const buf = this._buffer;
    if (!buf || buf.length < 2) return false;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return false;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return false;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        this.close(1009, "frame too large");
        this._buffer = null;
        return false;
      }
      len = Number(big);
      offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return false;
    let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
    if (masked) {
      const mask = buf.subarray(offset, offset + 4);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
      payload = out;
    }
    this._buffer = buf.subarray(offset + maskLen + len);
    this._handleFrame(fin, opcode, payload);
    return true;
  }

  _handleFrame(fin, opcode, payload) {
    switch (opcode) {
      case 0x1: // 文本
      case 0x2: {
        // 二进制帧也按文本处理（本通道只发 JSON 文本；防御性容错）
        if (!fin) {
          // 续帧开始/中间：暂存
          if (this._fragmentOpcode === 0) this._fragmentOpcode = opcode;
          this._fragments.push(payload);
        } else if (this._fragmentOpcode !== 0) {
          this._fragments.push(payload);
          const full = Buffer.concat(this._fragments).toString("utf8");
          this._fragments = [];
          this._fragmentOpcode = 0;
          this.emit("message", full);
        } else {
          this.emit("message", payload.toString("utf8"));
        }
        break;
      }
      case 0x8: {
        // close：回 close 帧并关闭
        const code =
          payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
        const reason =
          payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        try {
          this._write(encodeFrame(0x8, payload.subarray(0, 2)));
        } catch {
          /* 写失败忽略 */
        }
        this._finalize(code, reason);
        break;
      }
      case 0x9: {
        // ping → 自动回 pong（payload 原样回显）
        try {
          this._write(encodeFrame(0xa, payload));
        } catch {
          /* 写失败忽略 */
        }
        break;
      }
      case 0xa: {
        this.lastPongAt = Date.now();
        break;
      }
      default:
        // 未知 opcode：协议错误关闭
        this.close(1002, "unknown opcode");
        break;
    }
  }

  /** 串行写（socket 并发写会交错帧）；连接已关闭/销毁时写为 no-op（不 reject——close 路径
   * 与竞态下静默丢弃即可，调用方不需要因关闭而报错） */
  _write(buf) {
    this._writeQueue = this._writeQueue.then(
      () =>
        new Promise((resolve) => {
          if (this.readyState === READY_CLOSED || this.socket.destroyed) {
            resolve();
            return;
          }
          this.socket.write(buf, (err) => {
            if (err) this.emit("error", err);
            resolve();
          });
        }),
    );
    return this._writeQueue;
  }

  /** 发文本帧（> 16KB 自动续帧分片） */
  sendText(text) {
    const data = Buffer.from(String(text ?? ""), "utf8");
    if (data.length <= MAX_FRAME_PAYLOAD) {
      return this._write(encodeFrame(0x1, data));
    }
    const parts = [];
    let offset = 0;
    let fragmentIndex = 0;
    while (offset < data.length) {
      const chunk = data.subarray(offset, offset + MAX_FRAME_PAYLOAD);
      offset += chunk.length;
      const isLast = offset >= data.length;
      // RFC6455 分片：首片 opcode=1（FIN=0），续片 opcode=0（continuation），末片 FIN=1。
      // 之前的实现所有分片都用 opcode=1，对端解析器视为交错消息直接丢弃（实测不达）。
      const opcode = fragmentIndex === 0 ? 0x1 : 0x0;
      fragmentIndex += 1;
      const len = chunk.length;
      let header;
      if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
      } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }
      header[0] = (isLast ? 0x80 : 0x00) | opcode;
      parts.push(header, chunk);
    }
    return this._write(Buffer.concat(parts));
  }

  /** 发协议级 ping 帧（心跳探测；对端标准 WebSocket 自动回 pong） */
  sendPing(payload) {
    return this._write(encodeFrame(0x9, payload || Buffer.alloc(0)));
  }

  /** 主动 close：发 close 帧，等对端 close 或超时后销毁 */
  close(code = 1000, reason = "") {
    if (this.readyState === READY_CLOSED) return;
    if (this.readyState === READY_OPEN) {
      this.readyState = READY_CLOSING;
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason, "utf8"));
      payload.writeUInt16BE(code, 0);
      payload.write(reason, 2, "utf8");
      try {
        this._write(encodeFrame(0x8, payload));
      } catch {
        /* 写失败直接销毁 */
      }
      this._closeTimer = setTimeout(() => this.socket.destroy(), CLOSE_GRACE_MS);
      this._closeTimer.unref?.();
    }
  }

  _fail(err) {
    if (this.readyState === READY_CLOSED) return;
    this.emit("error", err);
    this._finalize(1006, err?.message || "socket error");
  }

  _finalize(code, reason) {
    if (this.readyState === READY_CLOSED) return;
    this.readyState = READY_CLOSED;
    if (this._closeTimer) {
      clearTimeout(this._closeTimer);
      this._closeTimer = null;
    }
    this._buffer = null;
    this._fragments = [];
    try {
      this.socket.destroy();
    } catch {
      /* 已销毁 */
    }
    this.emit("close", code, reason);
  }
}

/**
 * 创建 WS 服务端：内部起一个 node:http server（随机端口），'upgrade' 事件做
 * RFC6455 握手，成功后 onConnection(conn)。
 * 返回 { server, port, connections: Set<WsConnection>, close(): Promise<void> }。
 * server 可被外部注入 listen 行为（默认 listen 随机端口，0 端口由 OS 分配）。
 */
function createWsServer(options = {}) {
  const { onConnection, onError, onListening } = options;
  const connections = new Set();
  const server = createServer((req, res) => {
    // 非 upgrade 请求：回 426（本服务端只接受 WebSocket 升级）
    res.writeHead(426, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Upgrade Required");
  });

  server.on("upgrade", (req, socket, head) => {
    const fail = (status, text) => {
      try {
        socket.end(
          "HTTP/1.1 " +
            status +
            " " +
            text +
            CRLF +
            "Connection: close" +
            CRLF +
            "Content-Length: 0" +
            CRLF +
            CRLF,
        );
      } catch {
        socket.destroy();
      }
    };
    if (String(req.method || "").toUpperCase() !== "GET") {
      fail(405, "Method Not Allowed");
      return;
    }
    const upgrade = String(req.headers.upgrade || "").toLowerCase();
    if (upgrade !== "websocket") {
      fail(400, "Bad Request");
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || !key) {
      fail(400, "Bad Request");
      return;
    }
    // 拼接握手响应（head 中可能已带首批帧数据，交给 WsConnection 后续解析）
    const accept = acceptKey(key);
    try {
      socket.write(
        "HTTP/1.1 101 Switching Protocols" +
          CRLF +
          "Upgrade: websocket" +
          CRLF +
          "Connection: Upgrade" +
          CRLF +
          "Sec-WebSocket-Accept: " +
          accept +
          CRLF +
          CRLF,
      );
    } catch (err) {
      onError?.(err);
      socket.destroy();
      return;
    }
    const conn = new WsConnection(socket, req);
    connections.add(conn);
    conn.once("close", () => connections.delete(conn));
    if (onError) conn.on("error", onError);
    if (head && head.length > 0) {
      // 首帧数据可能随 upgrade 请求一起到达
      try {
        conn._onData(head);
      } catch {
        /* 解析失败由连接错误路径兜底 */
      }
    }
    try {
      onConnection?.(conn);
    } catch (err) {
      onError?.(err);
    }
  });

  server.on("error", (err) => {
    onError?.(err);
  });

  const close = () =>
    new Promise((resolve) => {
      for (const conn of [...connections]) {
        try {
          conn.close(1001, "server closing");
        } catch {
          /* 忽略 */
        }
      }
      server.close(() => resolve());
      // 兜底：等待中的连接也销毁（close 只停新连接）
      setTimeout(() => {
        for (const conn of [...connections]) {
          try {
            conn.socket?.destroy();
          } catch {
            /* 忽略 */
          }
        }
        resolve();
      }, 200).unref?.();
    });

  return { server, connections, close, acceptKey };
}

/** 启动 WS 服务端并监听随机端口（0 → OS 分配），返回已就绪对象 */
async function listenWsServer(options = {}) {
  const { host = "127.0.0.1", onConnection, onError } = options;
  const ws = createWsServer({ onConnection, onError });
  const port = await new Promise((resolve, reject) => {
    ws.server.once("error", reject);
    ws.server.listen(0, host, () => {
      ws.server.off("error", reject);
      resolve(ws.server.address().port);
    });
  });
  ws.port = port;
  return ws;
}

export {
  createWsServer,
  listenWsServer,
  WsConnection,
  acceptKey,
  READY_CONNECTING,
  READY_OPEN,
  READY_CLOSING,
  READY_CLOSED,
  MAX_FRAME_PAYLOAD,
};
