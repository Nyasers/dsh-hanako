// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/bridge-freeze.test.mjs — src/runtime/bridge.js 控制面与冻结契约单测（真起 http 服务）
// 覆盖：controlKey 鉴权、prepare-switch/resume 冻结（503、在途调用拒绝、守门失败不半冻）、
// WS 升级握手头不被剥离（101）、冻结时给已升级 WS 发 1013 关闭帧。
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { startDshBridge, wsCloseFrame, FREEZE_CLOSE_CODE } from "../src/runtime/bridge.ts";

const KEY = "bridge-key-0123456789abcdef";
const CONTROL = "control-key-0123456789abcdef";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

/** 最小上游：HTTP 200 + 可选 WS 握手（校验 sec-websocket-key 后才 101）——用来证明中继没剥握手头。 */
async function startUpstream(opts = {}) {
  const hits = { get: 0, post: 0 };
  const sockets = new Set(); // 升级后的 socket 不受 server.closeAllConnections 管辖，关闭时需自己收
  const server = http.createServer((req, res) => {
    if (req.method === "POST") hits.post++;
    else hits.get++;
    if (opts.delayMs && String(req.url).startsWith("/slow")) {
      setTimeout(() => { res.writeHead(200, { "content-type": "text/plain" }); res.end("slow"); }, opts.delayMs);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream-ok");
  });
  server.on("upgrade", (req, socket) => {
    if (!opts.ws) { socket.destroy(); return; }
    const key = req.headers["sec-websocket-key"];
    if (!key) { socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy(); return; }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + createHash("sha1").update(key + GUID).digest("base64") + "\r\n\r\n",
    );
    socket.on("error", () => {});
  });
  const port = await listen(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return {
    server,
    hits,
    origin: "http://127.0.0.1:" + port,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

function startBridge(upstream, onControl) {
  return startDshBridge({
    port: 0,
    bridgeKey: KEY,
    controlKey: CONTROL,
    upstreamOrigin: upstream.origin,
    upstreamCookie: "dsh=1",
    onControl: onControl || (async (action) => ({ ok: true, action })),
  });
}

async function get(port, path = "/", key = KEY) {
  const res = await fetch("http://127.0.0.1:" + port + path, { headers: key ? { "x-hana-dsh-bridge": key } : {} });
  const text = await res.text().catch(() => "");
  return { status: res.status, text };
}

async function post(port, path, key = KEY) {
  const res = await fetch("http://127.0.0.1:" + port + path, { method: "POST", headers: key ? { "x-hana-dsh-bridge": key } : {} });
  await res.text().catch(() => "");
  return res.status;
}

async function control(port, action, key = CONTROL) {
  const res = await fetch("http://127.0.0.1:" + port + "/_control", {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-hana-dsh-control": key } : {}) },
    body: JSON.stringify({ action, args: {} }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("bridge: 鉴权 + prepare-switch/resume 冻结（普通请求 503）", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream);
  try {
    assert.equal((await get(bridge.port)).status, 200, "带 key 的 GET 应被转发");
    assert.equal((await get(bridge.port, "/", null)).status, 403, "无 key 应 403");
    assert.equal((await control(bridge.port, "rpc", "wrong-key-0000000000000000")).status, 403, "错误 controlKey 应 403");

    assert.equal((await control(bridge.port, "prepare-switch")).status, 200);
    assert.equal((await get(bridge.port)).status, 503, "冻结期普通请求应 503");
    assert.equal((await control(bridge.port, "prepare-switch")).status, 409, "重复冻结应 409");
    assert.equal((await control(bridge.port, "rpc")).status, 409, "冻结期控制调用应被拒");

    assert.equal((await control(bridge.port, "resume")).body.resumed, true);
    assert.equal((await get(bridge.port)).status, 200, "解冻后恢复转发");
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: prepare-switch 守门失败 → 409 且不半冻", async () => {
  const upstream = await startUpstream();
  const bridge = await startBridge(upstream, async (action) => {
    if (action === "prepare-switch") throw new Error("DSH 仍有运行中的任务");
    return { ok: true };
  });
  try {
    const r = await control(bridge.port, "prepare-switch");
    assert.equal(r.status, 409);
    assert.match(String(r.body.error), /运行中/);
    assert.equal((await get(bridge.port)).status, 200, "守门失败不得留下冻结态");
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: 有在途调用时 prepare-switch 拒绝（409），调用结束后可切换", async () => {
  const upstream = await startUpstream({ delayMs: 250 });
  const bridge = await startBridge(upstream);
  try {
    const inflight = post(bridge.port, "/slow");
    await sleep(60);
    const denied = await control(bridge.port, "prepare-switch");
    assert.equal(denied.status, 409, "在途调用未归零时不得冻结");
    assert.equal(await inflight, 200);
    await sleep(40);
    assert.equal((await control(bridge.port, "prepare-switch")).status, 200);
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("bridge: WS 升级握手头不被剥离（101），冻结时已升级连接收到 1013", async () => {
  const upstream = await startUpstream({ ws: true });
  const bridge = await startBridge(upstream);
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/api/remote.mux?dshBridge=${KEY}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WS 升级超时")), 3000);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WS 升级失败（握手头可能被剥离）")); }, { once: true });
    });
    const closed = new Promise((resolve) => ws.addEventListener("close", (ev) => resolve(ev), { once: true }));
    assert.equal((await control(bridge.port, "prepare-switch")).status, 200);
    const ev = await closed;
    assert.equal(ev.code, FREEZE_CLOSE_CODE, "冻结应给已升级 WS 发 1013");
  } finally {
    await bridge.close();
    await upstream.close();
  }
});

test("wsCloseFrame: opcode 0x8 + code + reason（载荷 ≤125）", () => {
  const bare = wsCloseFrame(FREEZE_CLOSE_CODE, "");
  assert.equal(bare[0], 0x88);
  assert.equal(bare[1], 2);
  assert.equal(bare.readUInt16BE(2), 1013);

  const withReason = wsCloseFrame(1013, "bye");
  assert.equal(withReason[1], 5);
  assert.equal(withReason.subarray(4).toString("utf8"), "bye");

  const long = wsCloseFrame(1013, "x".repeat(500));
  assert.equal(long[1], 125, "reason 截断到 123 字节");
});
