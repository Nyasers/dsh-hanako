// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/bridge.js — DSHana 统一通道（bridge）宿主侧核心（M1，WS #2 server + WS #1 连接桥）
//
// 架构（见 _tmp/design/design-unified-channel.md v4.1）：
//   WS #2：宿主 ↔ dsh 子进程的进程间通道。宿主侧起 127.0.0.1 随机端口 WS 服务端
//     （零依赖 RFC6455，src/lib/ws-lib.js），私有 token（每次 web host 启动生成）经
//     spawn env（DSH_BRIDGE_URL / DSH_BRIDGE_TOKEN）注入，dsh 侧 @dsh-hanako/bridge
//     插件连接后首帧 { type:"hello", token } 握手校验。
//   WS #1：SW ↔ 宿主 web server 的插件 WS 端点（routes/bridge.js 注册 /bridge），
//     本模块提供 SW 连接的对象化接入（registerSwConnection）与帧分发。
//
// 帧协议（JSON 文本帧，见设计 §3）：
//   { "type":"hello", "token":"<私有>" } / { "type":"hello-ok" }        —— WS #2 握手
//   { "type":"http.request", "id":"r1", "method":"GET", "path":"/", "headers":{...}, "body":<分帧> }
//   { "type":"http.response", "id":"r1", "status":200, "headers":{...}, "body":<分帧> }
//   { "type":"http.error", "id":"r2", "message":"…" }
//   { "type":"event", "name":"update.request", "payload":{...} }         —— 自定义消息流
//   { "type":"ping" } / { "type":"pong" }
//   分帧：body 超过 256KB 时分段 { "chunk":n, "data":"<base64>", "done":bool }
//     （首段随请求/响应帧的 body 字段，后续段为 { "type":"http.chunk", "id", "chunk", "data", "done" }）
//
// 职责：
//   · ensureBridge(cfg)：幂等启动 WS #2 服务端（已运行直接复用），返回 { port, token }
//   · stopBridge()：关闭服务端 + 全部连接（closeProcess 调用）
//   · http 请求背面转发：WS #1 的 http.request 帧（id 透传）→ 经 WS #2 转发 dsh；
//     dsh 侧响应（http.response/http.error）→ 回传对应 WS #1 连接
//   · event 帧分发：WS #2 的 event 帧 → 本进程 EventEmitter（g.bridgeEvents，宿主
//     lifecycle.js 订阅 update.request 等）；宿主侧也可经 emitEvent(name, payload)
//     向 dsh 推事件（update.result 等）
//   · id 配对 + 超时（30s）：WS #1 请求挂起表；分帧重组（> 256KB base64 分段）
//   · 心跳：WS #2 服务端每 30s 协议级 ping，90s 无 pong 判死；dsh 侧同时有应用级
//     ping/pong（见 dsh 插件），服务端对应用级 ping 回 pong
//
// 注释风格：中文 / 双引号 / 分号 / SPDX 头（宿主侧 src/ 规范）；零运行时依赖。
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { listenWsServer } from "./ws-lib.js";
import { getSingleton } from "../tools/lib/state.js";

const BRIDGE_HEARTBEAT_MS = 30000; // 心跳间隔（协议级 ping）
const BRIDGE_DEAD_MS = 90000; // 无 pong 判死
const REQUEST_TIMEOUT_MS = 30000; // WS #1 请求挂起超时（id 配对）
const CHUNK_THRESHOLD = 256 * 1024; // 分帧阈值（base64 后约 341KB，WS 帧安全）
const CHUNK_SIZE = 224 * 1024; // 每段原始字节（base64 后约 299KB，留帧头余量）

// ---- 分帧 / 重组（base64 分段）----
// body 形态：null（无 body）| { chunk, data, done }（data 恒 base64）。
// 编码：<= 阈值单段 { chunk:0, data, done:true }；> 阈值首段 done:false，后续经
// http.chunk 帧发送。解码：按 id 累积段（chunk 顺序校验），done:true 收尾。
function encodeBody(body) {
  if (body === null || body === undefined) return null;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buf.length <= CHUNK_THRESHOLD) {
    return { chunk: 0, data: buf.toString("base64"), done: true };
  }
  const first = buf.subarray(0, CHUNK_SIZE);
  return { chunk: 0, data: first.toString("base64"), done: false };
}
/** 把大 body 拆成后续分段帧（不含首段；首段随请求/响应帧） */
function chunkBodyFrames(id, body) {
  if (body === null || body === undefined) return [];
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buf.length <= CHUNK_THRESHOLD) return [];
  const frames = [];
  let chunk = 1;
  let offset = CHUNK_SIZE;
  while (offset < buf.length) {
    const part = buf.subarray(offset, offset + CHUNK_SIZE);
    offset += part.length;
    frames.push({
      type: "http.chunk",
      id,
      chunk: chunk++,
      data: part.toString("base64"),
      done: offset >= buf.length,
    });
  }
  return frames;
}
/** 重建 body：单段或经 http.chunk 累积（返回 Buffer | null） */
function rebuildBody(metaBody, chunks) {
  const parts = [];
  let total = 0;
  if (metaBody && typeof metaBody === "object" && typeof metaBody.data === "string") {
    const b = Buffer.from(metaBody.data, "base64");
    parts.push(b);
    total += b.length;
  }
  for (const c of chunks) {
    const b = Buffer.from(c.data, "base64");
    parts.push(b);
    total += b.length;
  }
  return total === 0 ? null : Buffer.concat(parts, total);
}

// ---- WS #2 服务端（宿主侧）----
// 单例挂 g.bridge：{ server, port, token, conn, swConnections, pending }。
// ensureBridge 幂等：已运行直接复用；stopBridge 清空后下次 ensureBridge 重建
// （web host 重启 = 新 token，dsh 侧以新 env 重连）。
class BridgeCore {
  constructor() {
    this.ws = null; // { server, port, connections, close }
    this.token = null; // 私有 token（每次 web host 启动生成）
    this.conn = null; // 当前 WS #2 连接（dsh 侧；一次只有一个）
    this.swConnections = new Map(); // WsConnection → { id, pending: Map<id, entry> }
    this.pending = new Map(); // WS #2 → WS #1 回传挂起（一般不用，WS #1 挂起在连接上）
    this.events = new EventEmitter(); // event 帧 → 本进程分发（宿主订阅）
    this._heartbeatTimer = null;
    this._requestTimer = null;
  }

  /** 幂等启动 WS #2 服务端；返回 { port, token } */
  async ensure() {
    if (this.ws) return { port: this.ws.port, token: this.token };
    this.token = randomBytes(24).toString("hex");
    const ws = await listenWsServer({
      onConnection: (conn) => this._onWs2Connection(conn),
      onError: (err) => this._log("error", "WS #2 服务端错误：" + (err?.message || err)),
    });
    this.ws = ws;
    this._startHeartbeat();
    this._log("hana", "bridge WS #2 已启动（127.0.0.1:" + ws.port + "，token 已生成）");
    return { port: ws.port, token: this.token };
  }

  /** 停止服务端 + 全部连接（closeProcess / web host 重建时调用） */
  async stop() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._requestTimer) {
      clearInterval(this._requestTimer);
      this._requestTimer = null;
    }
    // 清理全部挂起（WS #1 连接断开语义：pending 请求失败）
    for (const sw of this.swConnections.values()) {
      for (const entry of sw.pending.values()) {
        this._rejectPending(sw, entry, "bridge 关闭");
      }
      sw.pending.clear();
    }
    this.swConnections.clear();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      this.conn = null;
      try {
        await ws.close();
      } catch {
        /* 关闭失败忽略 */
      }
      this._log("hana", "bridge WS #2 已停止");
    }
  }

  _log(src, msg) {
    const g = getSingleton();
    try {
      g.appendLog?.(src, msg);
    } catch {
      /* 日志失败不阻断 */
    }
  }

  /** WS #2 新连接（dsh 侧）→ 首帧 hello 校验 */
  _onWs2Connection(conn) {
    let handshook = false;
    const onMessage = (text) => {
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        conn.close(1007, "bad json");
        return;
      }
      if (!handshook) {
        // 首帧必须是 hello
        if (frame?.type !== "hello") {
          conn.close(1008, "hello required");
          return;
        }
        if (frame.token !== this.token) {
          this._log("hana", "bridge WS #2 握手失败（token 不匹配），拒绝连接");
          conn.close(1008, "bad token");
          return;
        }
        handshook = true;
        // 同一时刻只保留一个 dsh 连接（旧连接顶掉）
        if (this.conn && this.conn !== conn) {
          try {
            this.conn.close(1001, "replaced");
          } catch {
            /* 忽略 */
          }
        }
        this.conn = conn;
        this._send(conn, { type: "hello-ok" });
        this._log("hana", "bridge WS #2 握手成功（dsh 侧已连接）");
        return;
      }
      this._dispatchWs2Frame(conn, frame);
    };
    const onClose = (code, reason) => {
      conn.off("message", onMessage);
      if (this.conn === conn) {
        this.conn = null;
        this._log("hana", "bridge WS #2 连接断开（code=" + code + " " + (reason || "") + "）");
      }
    };
    conn.on("message", onMessage);
    conn.once("close", onClose);
    // 握手超时（5s 未发 hello 丢弃）
    const t = setTimeout(() => {
      if (!handshook) {
        try {
          conn.close(1008, "hello timeout");
        } catch {
          /* 忽略 */
        }
      }
    }, 5000);
    t.unref?.();
    conn.once("close", () => clearTimeout(t));
  }

  /** 分发 WS #2 帧：http.response/http.error 回传 WS #1；event 帧本进程分发；ping/pong */
  _dispatchWs2Frame(conn, frame) {
    if (process.env.DSH_BRIDGE_DEBUG) {
      console.log("[bridge-debug] ws2 frame:", frame && frame.type, frame && frame.id, frame && frame.chunk);
    }
    switch (frame?.type) {
      case "http.response":
      case "http.error": {
        // 回传发起方 WS #1 连接（按 id 反查）
        const { sw, entry } = this._findSwPending(frame.id);
        if (!sw || !entry) return; // 超时已清理：丢弃
        if (frame.type === "http.response") {
          if (frame.body && frame.body.done === false) {
            // 大响应首段随响应帧，后续分段经 http.chunk 帧到达（entry.chunks 只收续段）
            entry.metaBody = frame.body;
            entry.metaHeaders = frame.headers && typeof frame.headers === "object" ? frame.headers : {};
            entry.metaStatus = Number(frame.status) || 200;
            entry.nextChunk = 1;
            return;
          }
          this._completeResponse(sw, entry, frame);
        } else {
          this._rejectPending(sw, entry, frame.message || "dsh 请求失败");
        }
        break;
      }
      case "http.chunk": {
        const { sw, entry } = this._findSwPending(frame.id);
        if (!sw || !entry) {
          if (process.env.DSH_BRIDGE_DEBUG) console.log("[bridge-debug] chunk: no pending for", frame.id);
          return;
        }
        if (process.env.DSH_BRIDGE_DEBUG) console.log("[bridge-debug] chunk: metaBody=", !!entry.metaBody, "chunk=", frame.chunk, "next=", entry.nextChunk);
        if (entry.metaBody && frame.chunk === entry.nextChunk) {
          entry.chunks.push(frame);
          entry.nextChunk += 1;
          if (frame.done) {
            const headers = entry.metaHeaders || {};
            const status = entry.metaStatus;
            const body = rebuildBody(entry.metaBody, entry.chunks);
            if (process.env.DSH_BRIDGE_DEBUG) console.log("[bridge-debug] chunk complete: body len=", body ? body.length : 0, "status=", status);
            this._sendSw(sw, {
              type: "http.response",
              id: entry.id,
              status: status || 200,
              headers,
              body: body === null ? null : { chunk: 0, data: body.toString("base64"), done: true },
            });
            this._dropSwPending(sw, entry.id);
          }
        } else {
          this._rejectPending(sw, entry, "分帧序列错误");
        }
        break;
      }
      case "event": {
        // 自定义消息流：本进程事件分发（宿主 lifecycle.js 订阅 update.request 等）
        if (frame.name && typeof frame.name === "string") {
          this.events.emit(frame.name, frame.payload);
        }
        break;
      }
      case "ping": {
        this._send(conn, { type: "pong" });
        break;
      }
      case "pong": {
        // 应用级 pong：仅作 liveness（协议级 pong 已由 ws-lib 记录）
        break;
      }
      default:
        break;
    }
  }

  _findSwPending(id) {
    for (const sw of this.swConnections.values()) {
      const entry = sw.pending.get(id);
      if (entry) return { sw, entry };
    }
    return { sw: null, entry: null };
  }

  /** WS #1 连接接入（routes/bridge.js 握手成功后调用） */
  registerSwConnection(conn) {
    const sw = { id: "sw-" + randomBytes(6).toString("hex"), conn, pending: new Map(), nextChunk: 1 };
    this.swConnections.set(conn, sw);
    const onMessage = (text) => {
      let frame;
      try {
        frame = JSON.parse(text);
      } catch {
        conn.close(1007, "bad json");
        return;
      }
      this._dispatchSwFrame(sw, frame);
    };
    const onClose = () => {
      conn.off("message", onMessage);
      this.swConnections.delete(conn);
      for (const entry of sw.pending.values()) this._rejectPending(sw, entry, "SW 连接断开");
      sw.pending.clear();
    };
    conn.on("message", onMessage);
    conn.once("close", onClose);
    this._log("hana", "bridge WS #1 连接接入（" + conn.remoteAddress + "）");
  }

  /** 分发 WS #1 帧：http.request → 经 WS #2 转发 dsh；ping/pong */
  _dispatchSwFrame(sw, frame) {
    switch (frame?.type) {
      case "http.request": {
        if (!this.conn) {
          this._sendSw(sw, {
            type: "http.error",
            id: frame.id,
            message: "bridge 未就绪（dsh 侧未连接）",
          });
          return;
        }
        const id = String(frame.id ?? "");
        if (!id || sw.pending.has(id)) {
          this._sendSw(sw, { type: "http.error", id: id || "?", message: "请求 id 缺失或重复" });
          return;
        }
        const entry = {
          id,
          sw,
          timer: setTimeout(() => {
            this._rejectPending(sw, entry, "请求超时（" + Math.round(REQUEST_TIMEOUT_MS / 1000) + "s）");
          }, REQUEST_TIMEOUT_MS),
          metaBody: null,
          metaHeaders: null,
          metaStatus: null,
          nextChunk: 1,
          chunks: [],
        };
        entry.timer.unref?.();
        sw.pending.set(id, entry);
        // 转发到 dsh（id 透传；body 分帧）
        const out = {
          type: "http.request",
          id,
          method: String(frame.method || "GET").toUpperCase(),
          path: String(frame.path || "/"),
          headers: frame.headers && typeof frame.headers === "object" ? frame.headers : {},
        };
        const bodyEnc = encodeBody(frame.body ?? null);
        if (bodyEnc) out.body = bodyEnc;
        const chunkFrames = chunkBodyFrames(id, frame.body ?? null);
        this._send(this.conn, out);
        for (const cf of chunkFrames) this._send(this.conn, cf);
        break;
      }
      case "ping": {
        this._sendSw(sw, { type: "pong" });
        break;
      }
      default:
        break;
    }
  }

  _completeResponse(sw, entry, frame) {
    const body = rebuildBody(frame.body, entry.chunks);
    this._sendSw(sw, {
      type: "http.response",
      id: entry.id,
      status: Number(frame.status) || 500,
      headers: frame.headers && typeof frame.headers === "object" ? frame.headers : {},
      body: body === null ? null : { chunk: 0, data: body.toString("base64"), done: true },
    });
    this._dropSwPending(sw, entry.id);
  }

  _rejectPending(sw, entry, message) {
    clearTimeout(entry.timer);
    if (sw.pending.has(entry.id)) {
      sw.pending.delete(entry.id);
      this._sendSw(sw, { type: "http.error", id: entry.id, message: String(message) });
    }
  }

  _dropSwPending(sw, id) {
    const entry = sw.pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      sw.pending.delete(id);
    }
  }

  _send(conn, obj) {
    try {
      conn.sendText(JSON.stringify(obj));
    } catch {
      /* 发送失败由连接错误路径兜底 */
    }
  }

  _sendSw(sw, obj) {
    try {
      if (process.env.DSH_BRIDGE_DEBUG) console.log("[bridge-debug] _sendSw to", sw.id, "type=", obj && obj.type, "id=", obj && obj.id);
      sw.conn.sendText(JSON.stringify(obj)).catch((err) => {
        if (process.env.DSH_BRIDGE_DEBUG) console.log("[bridge-debug] _sendSw failed:", err && err.message);
      });
    } catch (err) {
      if (process.env.DSH_BRIDGE_DEBUG) console.log("[bridge-debug] _sendSw threw:", err && err.message);
    }
  }

  /** 宿主侧向 dsh 推事件（update.result 等）：经 WS #2 event 帧 */
  emitEvent(name, payload) {
    if (!this.conn) return false;
    this._send(this.conn, { type: "event", name, payload: payload ?? {} });
    return true;
  }

  /** 心跳：WS #2 服务端每 30s 协议级 ping，90s 无 pong 判死 */
  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      const conn = this.conn;
      if (!conn) return;
      try {
        conn.sendPing();
      } catch {
        /* 发送失败由错误路径兜底 */
      }
      if (Date.now() - conn.lastPongAt > BRIDGE_DEAD_MS) {
        this._log("hana", "bridge WS #2 心跳超时（90s 无 pong），断开连接");
        try {
          conn.close(1001, "heartbeat timeout");
        } catch {
          /* 忽略 */
        }
      }
    }, BRIDGE_HEARTBEAT_MS);
    this._heartbeatTimer.unref?.();
  }

  /** 桥状态（/bridge/status 与 health 诊断用） */
  status() {
    return {
      ws2: {
        running: !!this.ws,
        port: this.ws ? this.ws.port : null,
        connected: !!this.conn,
        tokenReady: !!this.token,
      },
      ws1: {
        connections: this.swConnections.size,
        pending: [...this.swConnections.values()].reduce((n, s) => n + s.pending.size, 0),
      },
    };
  }
}

// ---- 单例挂载（globalThis.__dshHanako.bridge）----
// ensureBridge / stopBridge 挂 g.bridgeStart / g.bridgeStop（lifecycle.js 调用）；
// g.bridgeEvents 供宿主订阅 event 帧（update.request 等）。
function getBridge() {
  const g = getSingleton();
  if (!g.bridge) g.bridge = new BridgeCore();
  return g.bridge;
}

/** 幂等启动 WS #2（web host 启动流程调用）；返回 { port, token } */
export async function ensureBridge() {
  const bridge = getBridge();
  return bridge.ensure();
}

/** 停止 bridge（closeProcess / updateDsh 重启 web host 时调用） */
export async function stopBridge() {
  const bridge = getBridge();
  await bridge.stop();
}

/** 宿主订阅 WS #2 event 帧（lifecycle.js 订阅 update.request 等）；返回退订函数 */
export function onBridgeEvent(name, cb) {
  const bridge = getBridge();
  bridge.events.on(name, cb);
  return () => bridge.events.off(name, cb);
}

/** 宿主向 dsh 推事件（update.result 等）；返回是否送达 */
export function emitBridgeEvent(name, payload) {
  return getBridge().emitEvent(name, payload);
}

/** WS #1 连接接入（routes/bridge.js 调用） */
export function registerSwConnection(conn) {
  getBridge().registerSwConnection(conn);
}

/** 桥状态（诊断用） */
export function bridgeStatus() {
  return getBridge().status();
}
