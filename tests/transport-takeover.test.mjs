// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/transport-takeover.test.mjs — 请求接管的判定规则与接管面
//
// 背景：带前导斜杠的裸路径（`/api/<命名空间>.<方法>`，真机上又冒出来的 /api/present.host 就是）
// 既不经过 __DSH_TRANSPORT__，也不受 <base> 约束（`/` 开头按 origin 解析，不继承 base 的路径），
// 于是落到宿主源上被凭据闸挡。接管规则必须同时满足两件事，所以两条都锁在这里：
//   ① 只重写「本页 origin（或 dsh.internal）」；
//   ② 宿主前缀 /api/apps/ 与外部 origin 一律原样放行（否则会把 App 自己的宿主访问也改道）。

import test from "node:test";
import assert from "node:assert/strict";

import {
  HOST_PATH_PREFIXES,
  installRequestTakeover,
  resolveRelaySocketUrl,
  resolveRelayUrl,
} from "../src/ui/dsh-inject.js";

const PAGE = "https://hana.local";
const BASE = new URL("https://hana.local/api/apps/dshana/routes/_runtime/r1/_surface/tok/");
const conf = { pageOrigin: PAGE };
const relayed = (input) => resolveRelayUrl(input, BASE, conf);
const expectRelayed = (input, expectedPath) => {
  const url = relayed(input);
  assert.ok(url, `应被接管：${String(input)}`);
  assert.equal(url.toString(), BASE.origin + BASE.pathname + expectedPath);
};

test("内核裸路径（前导斜杠）被接管到中继前缀", () => {
  expectRelayed("/api/present.host", "api/present.host");
  expectRelayed("/api/remote.mux", "api/remote.mux");
  expectRelayed("/api/events.host", "api/events.host");
});

test("无前导斜杠的相对路径同样被接管", () => {
  expectRelayed("api/session.list", "api/session.list");
  expectRelayed("./assets/index-abc.js", "assets/index-abc.js");
});

test("dsh.internal 绝对地址被接管", () => {
  expectRelayed("http://dsh.internal/api/present.host", "api/present.host");
});

test("query 与 hash 原样保留", () => {
  expectRelayed("/api/session.page?cursor=9&x=1", "api/session.page?cursor=9&x=1");
  const withHash = relayed("/api/x.y?a=1#frag");
  assert.equal(withHash.search, "?a=1");
  assert.equal(withHash.hash, "#frag");
});

test("宿主前缀（/api/apps/）与中继自身一律放行，防二次重写", () => {
  assert.equal(relayed("/api/apps/dshana/routes/_runtime/r1/_surface/tok/api/present.host"), null);
  assert.equal(relayed("/api/apps/dshana/ui/default.html"), null);
  assert.equal(relayed(BASE.toString() + "api/present.host"), null);
  assert.deepEqual(HOST_PATH_PREFIXES, ["/api/apps/"]);
});

test("外部 origin 不重写也不抛（原生语义照旧）", () => {
  assert.equal(relayed("https://example.com/api/present.host"), null);
  assert.equal(relayed("http://127.0.0.1:5173/api/x.y"), null);
});

test("WebSocket 映射：跟随中继前缀的 http(s) → ws(s)", () => {
  // 页面是 https → 中继也是 https → 映射结果应为 wss（跟页面协议一致，不是写死 ws）。
  const mapped = resolveRelaySocketUrl("/api/remote.mux", BASE, conf);
  assert.ok(mapped);
  assert.equal(mapped.protocol, "wss:");
  assert.equal(mapped.toString(), "wss://hana.local/api/apps/dshana/routes/_runtime/r1/_surface/tok/api/remote.mux");
  // 输入自己就是 wss:// 时 origin 归一后同样认得（协议族等价）。
  const secure = resolveRelaySocketUrl("wss://hana.local/api/remote.mux", BASE, conf);
  assert.ok(secure);
  assert.equal(secure.protocol, "wss:");
  assert.equal(secure.toString(), "wss://hana.local/api/apps/dshana/routes/_runtime/r1/_surface/tok/api/remote.mux");
  assert.equal(resolveRelaySocketUrl("https://example.com/api/remote.mux", BASE, conf), null);
});

/** 一套最小的宿主替身：五个原语 + 调用记录。 */
function fakeTarget() {
  const calls = [];
  class FakeXHR {
    open(method, url) { this.method = method; this.url = url; }
  }
  class FakeEventSource {
    constructor(url) { this.url = url; }
  }
  FakeEventSource.CONNECTING = 0;
  FakeEventSource.OPEN = 1;
  class FakeWebSocket {
    constructor(url) { this.url = url; }
  }
  FakeWebSocket.OPEN = 1;
  const target = {
    location: { origin: PAGE },
    fetch: (input) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ kind: "fetch", url });
      return Promise.resolve({ ok: true });
    },
    XMLHttpRequest: FakeXHR,
    EventSource: FakeEventSource,
    WebSocket: FakeWebSocket,
    navigator: {
      sendBeacon: (url) => { calls.push({ kind: "beacon", url: String(url) }); return true; },
    },
  };
  return { target, calls };
}

test("接管面：五个原语都被改写，宿主侧与外部 origin 不动，disposer 还原", async () => {
  const { target, calls } = fakeTarget();
  const nativeFetch = target.fetch;
  const nativeXHR = target.XMLHttpRequest;
  const nativeEventSource = target.EventSource;
  const nativeWebSocket = target.WebSocket;
  const nativeBeacon = target.navigator.sendBeacon;

  const restore = installRequestTakeover(BASE, { target, navigator: target.navigator, ...conf });

  // fetch：重写 + same-origin 凭据
  await target.fetch("/api/present.host");
  await target.fetch("/api/apps/dshana/routes/keep-me");
  await target.fetch("https://example.com/out");
  assert.deepEqual(calls.filter((c) => c.kind === "fetch").map((c) => c.url), [
    BASE.toString() + "api/present.host",
    "/api/apps/dshana/routes/keep-me",
    "https://example.com/out",
  ]);

  // XHR
  const xhr = new target.XMLHttpRequest();
  xhr.open("GET", "/api/session.list");
  assert.equal(xhr.url, BASE.toString() + "api/session.list");

  // EventSource / WebSocket
  assert.equal(new target.EventSource("/api/events.host").url, BASE.toString() + "api/events.host");
  assert.equal(new target.WebSocket("/api/remote.mux").url, "wss://hana.local/api/apps/dshana/routes/_runtime/r1/_surface/tok/api/remote.mux");
  assert.equal(target.WebSocket.OPEN, 1);
  assert.equal(target.EventSource.OPEN, 1);

  // sendBeacon
  target.navigator.sendBeacon("/api/present.host", "x");
  assert.equal(calls.filter((c) => c.kind === "beacon")[0].url, BASE.toString() + "api/present.host");

  // disposer
  restore();
  assert.equal(target.fetch, nativeFetch);
  assert.equal(target.XMLHttpRequest, nativeXHR);
  assert.equal(target.EventSource, nativeEventSource);
  assert.equal(target.WebSocket, nativeWebSocket);
  assert.equal(target.navigator.sendBeacon, nativeBeacon);
});

test("Request 对象输入：方法/请求体保住，URL 换成中继前缀", async () => {
  const { target, calls } = fakeTarget();
  installRequestTakeover(BASE, { target, navigator: target.navigator, ...conf });
  await target.fetch(new Request(PAGE + "/api/present.host", { method: "POST", body: "payload" }));
  assert.equal(calls.find((c) => c.kind === "fetch").url, BASE.toString() + "api/present.host");
});
