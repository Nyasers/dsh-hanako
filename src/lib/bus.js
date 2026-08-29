// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/bus.js — dshana.bus 进程间消息总线客户端（宿主侧）
//
// 语义：宿主插件作为 dshana.bus 的**客户端**，连 dsh 进程内的消息总线服务端
// （@dsh-hanako/bridge 经 dsh webserver upgrade 路由注册 /api/dshana.bus）——
// 双向收发 JSON 文本帧 { channel, payload }，替代旧的单向 HTTP 反向信道
// POST /child/post（v0.21.2 引入，已退役）。只做消息总线，不做代理：无 SW 拦截、
// 无 HTTP 隧道、无请求转发（bridge 历史教训：feat/bridge-channel 曾做三层通道，
// 因宿主插件路由再分发丢失 upgrade raw socket/env 不可行，v7 改 HTTP 隧道复杂度
// 爆炸整体 revert；本次握手在 dsh webserver 内完成——registerUpgrade 的 handler
// 拥有 socket 完整协商权，不经过宿主路由再分发）。
//
// 传输层：Node 22+ 全局 WebSocket（宿主 node 24 可用，零运行时依赖——不引入 ws 库）。
// 连接 ws://127.0.0.1:<webPort>/api/dshana.bus，open 后首帧发
// { channel:"hello", payload:{} } 握手（v0.22.1+ 免鉴权：总线与 mux、/api/session.*
// 同级，本机信任——不再生成 busToken、不再注入 {{BUS_TOKEN}} 占位符；hello 只作身份
// 宣告，bridge 不再比对）。
//
// 协议（JSON 文本帧，{ channel, payload }，与子插件 @dsh-hanako/bridge 同协议）：
//   { "channel":"hello", "payload":{} }                     —— 首帧握手（免鉴权身份宣告）
//   { "channel":"hello-ok", "payload":{} }                   —— 服务端应答（握手成功）
//   { "channel":"config", "payload":{ dshPkgDir, dataDir } }—— 配置下发（web host 就绪点注册
//                                                              provider，hello-ok 后自动发出，
//                                                              替代 patch config 注入）
//   { "channel":"log", "payload":{ src, line } }             —— dsh 内部日志 → g.appendLog 会话文件
//   { "channel":"update.request", "payload":{ at, fromVersion } }—— 更新请求（设置页发起）
//   { "channel":"update.progress", "payload":{ state, at } } —— 更新开始/进度（本模块 emit）
//   { "channel":"update.result", "payload":{ state, version?, error? } }—— 更新结果（本模块 emit）
//   { "channel":"provider.refresh", "payload":{ routes } }   —— provider 路由推送（本模块 emit）
//   { "channel":"bus.ping", "payload":{} } / { "channel":"bus.pong", "payload":{} } —— 心跳
//
// 连接管理：断线指数退避重连（1s 起、×2、封顶 30s）；心跳应用级 { channel:"bus.ping" }
// 每 30s，90s 无任何消息判死断开重连。单例挂 g.dshanaBus：
// { emit(channel, payload), on(channel, cb), status(), close() }。
// 注意：不用 g.bus 字段——g.bus 是宿主事件总线（index.js onload 存入 ctx.bus，deferred
// 唤醒等生命周期链路使用），DShana 客户端总线挂 g.dshanaBus 避免覆盖宿主总线。
// connectBus(cfg) 幂等：web host 就绪点调用（lifecycle.js ensureWebHost 就绪后）——
// 已连接 no-op，否则清理旧连接/定时器后全新建立。closeBus() 主动关闭（插件卸载 /
// closeProcess / updateDsh 停 host）。
//
// 更新链路接线：本模块订阅总线 update.request → 调 g.updateDsh（现有能力层：停 web
// host → npm i latest → 起 web host → 写 update-result.json）→ 执行期间/完成后总线
// 回投 update.progress / update.result（v0.22.1+ 事件化：update.progress 开始即发，
// update.result 结束回投 { state, version?, error? }——替代设置页 2s 轮询 update-status，
// 事件缓存由 @dsh-hanako/settings 后端维护，update-result.json 读回保留作兜底）。
// 并发防护复用 updateDsh 的 g.updating 语义（进行中重复请求返回 { ok:false,
// state:"updating" }，不重复执行、不回投）。更新执行中 web host 停机 → 总线断开 →
// 连接失败不阻断 dsh 启动/更新（结果以 update-result.json 为准，回投尽力而为）。
//
// 本机事件（内部 emitter，供宿主侧订阅——routes/webui.js 壳页就绪事件化等）：
//   "bus.ready"      —— hello-ok 收到（web host 已就绪且总线已连接；宿主 push ready
//                        给壳页、provider 补推、config 下发都挂这个时机）
//   "bus.disconnect" —— 连接关闭（含断线重连前；web host 停机/总线断开，壳页可推诊断）
// 注释风格：中文 / 双引号 / 分号 / SPDX 头（宿主侧 src/ 规范）；零运行时依赖。

import { EventEmitter } from "node:events";
import { getSingleton } from "../tools/lib/state.js";

const BUS_PATH = "/api/dshana.bus";
const RECONNECT_BASE_MS = 1000; // 退避基数
const RECONNECT_MAX_MS = 30000; // 退避封顶
const HEARTBEAT_MS = 30000; // 应用级 ping 间隔
const DEAD_MS = 90000; // 无任何消息判死

// ---- 模块级单例状态（bus.js 内联进 dsh-run bundle，单实例）----
let ws = null;
let authed = false; // hello 已发送（服务端 hello-ok 前即为 true）
let url = null;
// update.result 断线/未握手时排队（有界 ≤20），连接恢复后补发——更新结果不因
// 总线窗口（web host 重启停机/重连）丢失，settings 侧能等到最终状态。
let pendingResults = [];
let stopFlag = false; // closeBus 置位：不再重连（下次 connectBus 复位）
let reconnectAttempt = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastMessageAt = 0;
let updateWired = false; // update.request → updateDsh 接线只做一次
// 宿主侧 config 下发 provider（web host 就绪点注册；hello-ok 后自动发 config 帧，
// 替代 patch config 注入——settings/provider 子插件经 dshanaBus.getConfig() 取路径）
let configProvider = null;
const emitter = new EventEmitter();

function log(msg) {
  const g = getSingleton();
  try {
    g.appendLog?.("hana", "[dshana.bus] " + msg);
  } catch {
    /* 日志失败不阻断 */
  }
  console.log("[dshana.bus] " + msg);
}

/** 清理重连/心跳定时器（断开与重建共用） */
function clearTimers() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/** 立即断开当前连接 + 清定时器（不置 stopFlag——connectBus 重建前调用） */
function disconnectInternal() {
  clearTimers();
  if (ws) {
    const sock = ws;
    ws = null;
    try {
      sock.close();
    } catch {
      /* 已关闭 */
    }
  }
  authed = false;
}

/** 发 JSON 文本帧（未连接/未握手时：update.result 排队待补发，其余 no-op，返回是否送达） */
function sendFrame(frame) {
  if (!ws || ws.readyState !== 1 || !authed) {
    if (frame && frame.channel === "update.result") {
      if (pendingResults.length < 20) pendingResults.push(frame);
    }
    return false;
  }
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

/** 补发排队的 update.result（连接 + 握手成功后调用；失败帧重新入队等下次补发） */
function flushPending() {
  const queue = pendingResults;
  pendingResults = [];
  for (const f of queue) sendFrame(f);
}

/** 收到一帧：channel 分发 + 心跳应答 + 本机事件 */
function onFrame(text) {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return; // 非法 JSON：忽略本帧（与子插件容错一致）
  }
  if (!frame || typeof frame.channel !== "string") return;
  lastMessageAt = Date.now();
  if (frame.channel === "bus.ping") {
    sendFrame({ channel: "bus.pong", payload: {} });
    return;
  }
  if (frame.channel === "bus.pong") return;
  if (frame.channel === "hello-ok") {
    log("总线握手确认（hello-ok，免鉴权）");
    reconnectAttempt = 0; // 握手成功：退避归零
    flushPending(); // 连接恢复：补发断线期间排队的 update.result
    // 下发 config（dshPkgDir/dataDir 替代 patch config 注入；每次握手重发，
    // 覆盖 web host 重启后新 bridge 实例）
    if (configProvider) {
      try {
        const c = configProvider();
        if (c && typeof c === "object") {
          sendFrame({ channel: "config", payload: c });
        }
      } catch {
        /* config 下发失败不阻断 */
      }
    }
    // 本机事件 bus.ready：web host 已就绪且总线已连接——
    // 壳页 ready push / provider 补推都挂这个时机
    emitter.emit("bus.ready", {});
    return;
  }
  if (frame.channel === "log") {
    // dsh 内部日志转发：复用 index.js 挂的 appendLog 单例写会话文件
    // （行格式 [ts] [src] 一致；src ∈ theme/provider/settings/bridge 等）
    const p = frame.payload && typeof frame.payload === "object" ? frame.payload : {};
    const src = typeof p.src === "string" && p.src ? p.src : "dsh";
    const line = typeof p.line === "string" ? p.line : "";
    if (line) {
      const g = getSingleton();
      try {
        if (typeof g.appendLog === "function") g.appendLog(src, line);
        else log("总线 log 转发（" + src + "）：" + line);
      } catch {
        /* 日志失败不阻断 */
      }
    }
    return;
  }
  emitter.emit(frame.channel, frame.payload ?? {});
}

/** 建立连接（open 后首帧发 hello；断线由 close 事件触发重连） */
function open() {
  if (stopFlag) return;
  let sock;
  try {
    sock = new WebSocket(url);
  } catch (e) {
    log("WebSocket 构造失败：" + (e?.message || e));
    scheduleReconnect("构造失败");
    return;
  }
  ws = sock;
  authed = false;
  sock.addEventListener("open", () => {
    lastMessageAt = Date.now();
    try {
      // 免鉴权 hello（身份宣告，不带 token）
      sock.send(JSON.stringify({ channel: "hello", payload: {} }));
      authed = true;
      log("已连接，hello 已发送（免鉴权）");
    } catch (e) {
      /* 发送失败由 close/error 路径兜底 */
    }
  });
  sock.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    onFrame(ev.data);
  });
  sock.addEventListener("close", (ev) => {
    if (ws === sock) ws = null;
    authed = false;
    const code = ev && typeof ev.code === "number" ? ev.code : 1006;
    const reason = (ev && ev.reason) || "";
    log("总线连接关闭（code=" + code + " " + reason + "）");
    // 本机事件 bus.disconnect：web host 停机/总线断开（壳页可推诊断）
    emitter.emit("bus.disconnect", { code, reason });
    if (stopFlag) return;
    scheduleReconnect("连接关闭");
  });
  sock.addEventListener("error", () => {
    /* error 后必随 close，close 统一走重连 */
  });
}

/** 指数退避重连（1s → 封顶 30s；同一时刻只挂一个定时器） */
function scheduleReconnect(reason) {
  if (stopFlag) return;
  if (reconnectTimer) return;
  const delay = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt),
  );
  reconnectAttempt += 1;
  log("总线重连（" + reason + "，" + Math.round(delay / 1000) + "s 后）");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    open();
  }, delay);
  reconnectTimer.unref?.();
}

/** 心跳：每 30s 发应用级 ping；90s 无任何消息判死断开重连 */
function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    if (stopFlag) return;
    if (!ws || ws.readyState !== 1 || !authed) return;
    sendFrame({ channel: "bus.ping", payload: {} });
    if (Date.now() - lastMessageAt > DEAD_MS) {
      log("总线心跳超时（90s 无消息），断开重连");
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
    }
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}

/** 更新链路接线（只做一次）：总线 update.request → g.updateDsh → 回投 update.progress/result */
function wireUpdateRequest() {
  if (updateWired) return;
  updateWired = true;
  emitter.on("update.request", (payload) => {
    const g = getSingleton();
    if (!g || typeof g.updateDsh !== "function") {
      log("收到 update.request 但插件能力层未加载，忽略");
      return;
    }
    const p = payload && typeof payload === "object" ? payload : {};
    // 受理确认：先回 update.ack（settings request-update 等 ack 才返回 updating，
    // 5s 超时视为宿主未受理）——避免 fire-and-forget 导致前端误报已在更新。
    if (p.reqId) {
      sendFrame({ channel: "update.ack", payload: { reqId: p.reqId } });
    }
    log("收到 update.request（fromVersion=" + (p.fromVersion || "?") + "），触发更新");
    // 复用现有 updateDsh（停 host → npm i latest → 起 host → 写 update-result.json）：
    // 并发防护 g.updating 在 updateDsh 内部（进行中重复请求返回 { ok:false,
    // state:"updating" }，不重复执行）。updateDsh 内部会经总线 emit
    // update.progress/update.result（事件化，见 lifecycle.js）；这里只受理请求。
    let result;
    try {
      result = g.updateDsh({
        dataDir: g.dataDir,
        webPort: Number(g.webServerPort) || 3080,
      });
    } catch (e) {
      sendFrame({
        channel: "update.result",
        payload: { state: "error", error: String(e?.message || e).slice(0, 1500) },
      });
      return;
    }
    Promise.resolve(result)
      .then((r) => {
        // 并发请求（已在更新中）：不重复触发、不回投（首个请求拥有结果上报）
        if (r && r.state === "updating") return;
        // updateDsh 内部已 emit update.result（lifecycle.js 完成点）；这里兜底一次
        // （防御 updateDsh 直调路径未 emit 的情况——幂等，settings 事件缓存去重）
        const state = r && r.ok ? "done" : (r && r.state) || "error";
        const out = { state };
        if (r && r.version) out.version = r.version;
        if (r && r.error) out.error = r.error;
        log("更新完成（state=" + state + "），回投 update.result");
        sendFrame({ channel: "update.result", payload: out });
      })
      .catch((e) => {
        sendFrame({
          channel: "update.result",
          payload: { state: "error", error: String(e?.message || e).slice(0, 1500) },
        });
      });
  });
}

/**
 * 连接 dshana.bus（web host 就绪点调用，幂等）：已连接 no-op；否则断开旧连接/定时器
 * 后全新建立。cfg：{ webPort } 等（与 ensureWebHost cfg 同源）。
 */
export function connectBus(cfg = {}) {
  const g = getSingleton();
  const port = Number(cfg.webPort) || Number(g.webServerPort) || 3080;
  stopFlag = false;
  wireUpdateRequest();
  if (ws && ws.readyState === 1 && authed) return; // 已连接
  disconnectInternal();
  url = "ws://127.0.0.1:" + port + BUS_PATH;
  log("连接 dshana.bus（" + url + "）");
  open();
  startHeartbeat();
}

/**
 * 注册 config 下发 provider（web host 就绪点调用；hello-ok 后自动发 config 帧）。
 * fn 返回 { dshPkgDir, dataDir }（每次握手重发，覆盖 web host 重启后新 bridge 实例）。
 */
export function setBusConfigProvider(fn) {
  configProvider = typeof fn === "function" ? fn : null;
}

/** 主动关闭（插件卸载 / closeProcess / updateDsh 停 host 时调用）；下次 connectBus 复位 */
export function closeBus() {
  stopFlag = true;
  disconnectInternal();
  log("总线已主动关闭");
}

/**
 * 挂单例 g.dshanaBus：跨模块（routes/webui.js 等经 globalThis 单例调用）访问总线。
 * bus.js 被 lifecycle.js 静态 import（内联进 dsh-run bundle），模块级状态即单例；
 * g.dshanaBus 暴露服务面（emit/on/status/close），与 g.closeProcess 等单例字段同纪律。
 * 注意：g.bus 是宿主事件总线（index.js onload 存 ctx.bus），不可覆盖——DShana 客户端
 * 总线挂 g.dshanaBus。
 */
getSingleton().dshanaBus = {
  emit: (channel, payload) => sendFrame({ channel, payload: payload ?? {} }),
  on: (channel, cb) => {
    if (typeof channel !== "string" || typeof cb !== "function") return () => {};
    emitter.on(channel, cb);
    return () => emitter.off(channel, cb);
  },
  status: () => ({
    connected: !!ws && ws.readyState === 1 && authed,
    url,
  }),
  close: () => closeBus(),
};
