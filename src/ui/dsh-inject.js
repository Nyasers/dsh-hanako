// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/ui/dsh-inject.js — 把 DSH 前端注入当前文档 + 提供 __DSH_TRANSPORT__（浏览器 ESM）
//
// 形态对齐官方样例 hana-dsh（runtime/bootstrap.js 的 src/ui/main.ts）：不再用 iframe 内嵌
// DSH，而是把 DSH 的 index.html 解析后注入本页——<base href> 指向中继前缀，DSH 的所有相对
// 资源（./assets/*、manifest、favicon）与绝对路径请求都经 __DSH_TRANSPORT__ 重写到该前缀。
// 这样 DSH 前端的 SPA 基址问题（绝对路径绕开代理前缀）不再存在，也不再需要 iframe 的
// surface 票据兜底。
//
// 宿主（DSH 内核）在 packages/client/connection 读 globalThis.__DSH_TRANSPORT__：
//   { fetch, openStream?, loadBundle?, ownsHost? }
// 本模块按浏览器面提供前三个（fetch/openStream/loadBundle）。
//
// 依赖：全部走浏览器原生 API（DOMParser / fetch / WebSocket / <script> 注入），无第三方包。

const DSH_INTERNAL_ORIGIN = "http://dsh.internal";

/** 相对引用解析：拒绝外部 origin，同前缀则原样返回，否则挂到中继前缀下。 */
export function resolveIndexAssetUrl(reference, privateBase) {
  const parsed = new URL(reference, DSH_INTERNAL_ORIGIN);
  if (parsed.origin !== DSH_INTERNAL_ORIGIN && parsed.origin !== privateBase.origin) {
    throw new Error("DSH index rejected external asset origin " + parsed.origin);
  }
  if (parsed.origin === privateBase.origin && parsed.pathname.startsWith(privateBase.pathname)) return parsed;
  return new URL(parsed.pathname.replace(/^\//, "") + parsed.search, privateBase);
}

/** 运行时 URL 重写：把 DSH 前端发出的（绝对或相对）请求映射到中继前缀下。 */
export function mapRuntimeUrl(input, privateBase, pageOrigin) {
  const url = new URL(input, pageOrigin);
  if (url.origin !== pageOrigin && url.origin !== DSH_INTERNAL_ORIGIN) {
    throw new Error("DSH transport rejected external origin " + url.origin);
  }
  return new URL(url.pathname.replace(/^\//, "") + url.search, privateBase);
}

/** fetch 传输：所有请求经中继前缀发出（同源凭据已由壳页持有）。 */
export function createRuntimeFetch(privateBase, pageOrigin = window.location.origin) {
  return (input, init) => {
    if (input instanceof Request) {
      const mapped = mapRuntimeUrl(input.url, privateBase, pageOrigin);
      const preserved = new Request(mapped, input);
      return fetch(new Request(preserved, { ...init, credentials: "same-origin" }));
    }
    return fetch(mapRuntimeUrl(input, privateBase, pageOrigin), { ...init, credentials: "same-origin" });
  };
}

/** bundle 传输：DSH 客户端插件 chunk 以 <script> 形式按中继前缀加载（保持执行顺序）。 */
export function loadRuntimeBundle(privateBase, pageOrigin = window.location.origin) {
  return (url) => new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = mapRuntimeUrl(url, privateBase, pageOrigin).toString();
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("DSH bundle failed to load: " + url));
    document.head.append(script);
  });
}

// ---- 远程流载体（api/remote.mux WS 上的多路复用）----
const MAX_STREAMS = 128;

/** 一条远端流的收件箱（push/finish/next）。 */
class Inbox {
  constructor() {
    this.values = [];
    this.done = false;
    this.failure = null;
    this.wake = null;
  }
  push(value) {
    this.values.push(value);
    if (this.wake) { const w = this.wake; this.wake = null; w(); }
  }
  finish(error) {
    this.done = true;
    this.failure = error || null;
    if (this.wake) { const w = this.wake; this.wake = null; w(); }
  }
  async next() {
    while (!this.values.length && !this.done) {
      await new Promise((resolve) => { this.wake = resolve; });
    }
    if (this.values.length) return { value: this.values.shift(), done: false };
    if (this.failure) throw this.failure;
    return { value: undefined, done: true };
  }
}

/** 经 api/remote.mux WS 复用多条远端流的载体（对齐样例的 DshStreamMux）。 */
export function createStreamMux(privateBase, WebSocketCtor = window.WebSocket) {
  const wsUrl = new URL("api/remote.mux", privateBase);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  let socket = null;
  const streams = new Map();
  let nextId = 0;

  const failAll = (error) => {
    for (const inbox of streams.values()) inbox.finish(error);
    streams.clear();
  };
  const receive = (raw) => {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { return failAll(new Error("DSH stream carrier sent invalid JSON")); }
    const inbox = frame && typeof frame.streamId === "string" ? streams.get(frame.streamId) : undefined;
    if (!inbox) return;
    if (frame.type === "item") inbox.push(frame.value);
    else if (frame.type === "end") { inbox.finish(); streams.delete(frame.streamId); }
    else if (frame.type === "error") {
      inbox.finish(new Error((frame.error && frame.error.message) || "DSH remote stream failed"));
      streams.delete(frame.streamId);
    }
  };
  const connect = () => {
    if (socket && (socket.readyState === WebSocketCtor.OPEN || socket.readyState === WebSocketCtor.CONNECTING)) return socket;
    const s = new WebSocketCtor(wsUrl.toString());
    s.onmessage = (event) => receive(event.data);
    s.onerror = () => failAll(new Error("DSH stream carrier failed"));
    s.onclose = () => failAll(new Error("DSH stream carrier closed"));
    socket = s;
    return s;
  };
  const send = (frame) => {
    const s = connect();
    const data = JSON.stringify(frame);
    if (s.readyState === WebSocketCtor.CONNECTING) {
      s.addEventListener("open", () => { try { s.send(data); } catch { /* 忽略 */ } }, { once: true });
      return;
    }
    s.send(data);
  };

  return {
    url: wsUrl.toString(),
    async *openStream(endpoint, payload, signal) {
      if (signal && signal.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
      if (streams.size >= MAX_STREAMS) throw new Error("Too many DSH remote streams");
      const streamId = "hana-" + (++nextId);
      const inbox = new Inbox();
      streams.set(streamId, inbox);
      const abort = () => {
        try { send({ type: "cancel", streamId }); } catch { /* 忽略 */ }
        inbox.finish(signal && signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
        streams.delete(streamId);
      };
      if (signal) signal.addEventListener("abort", abort, { once: true });
      try {
        send({ type: "open", streamId, endpoint, payload });
        for (;;) {
          const next = await inbox.next();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        if (signal) signal.removeEventListener("abort", abort);
        if (streams.delete(streamId)) { try { send({ type: "cancel", streamId }); } catch { /* 忽略 */ } }
      }
    },
    dispose() {
      failAll(new Error("DSH stream carrier disposed"));
      try { if (socket) socket.close(); } catch { /* 忽略 */ }
      socket = null;
    },
  };
}

/** 追加一个 script（module 或 classic），按顺序执行。 */
function appendScript(source, module) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    if (module) script.type = "module";
    script.src = source;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("DSH script failed: " + String(source).replace(/\/_(?:surface|hana)\/[^/]+/g, "/[private]")));
    document.head.append(script);
  });
}

/**
 * 把 DSH 的 index.html 注入当前文档：设 <base>，搬 head 里的 stylesheet/modulepreload/
 * 内联与外部 script，最后加载 module entry；卸载壳页自举 UI，准备 #root 容器。
 * @param {string} indexHtml DSH index 原文（经中继取回）
 * @param {URL} privateBase 中继前缀绝对 URL（尾带 /）
 * @param {{containerId?: string}} [opts]
 */
export async function injectDshIndex(indexHtml, privateBase, opts) {
  const containerId = (opts && opts.containerId) || "root";
  const parsed = new DOMParser().parseFromString(indexHtml, "text/html");
  // 清掉壳页自举 UI，准备 DSH 挂载容器
  const boot = document.getElementById("hana-dsh-boot");
  if (boot) boot.remove();
  let container = document.getElementById(containerId);
  if (!container) {
    container = document.createElement("div");
    container.id = containerId;
    document.body.append(container);
  } else {
    container.replaceChildren();
  }
  // base 必须先于任何资源解析插入
  const base = document.createElement("base");
  base.href = privateBase.toString();
  document.head.prepend(base);
  // stylesheet / modulepreload
  for (const link of parsed.querySelectorAll('link[rel="stylesheet"],link[rel="modulepreload"]')) {
    const href = link.getAttribute("href");
    if (!href) continue;
    const next = document.createElement("link");
    next.rel = link.rel;
    next.href = resolveIndexAssetUrl(href, privateBase).toString();
    if (link.crossOrigin) next.crossOrigin = link.crossOrigin;
    document.head.append(next);
  }
  // 内联 script（先于外部按序）
  for (const source of parsed.querySelectorAll("script:not([type=\"module\"]):not([src])")) {
    const script = document.createElement("script");
    script.textContent = source.textContent;
    document.head.append(script);
  }
  for (const source of parsed.querySelectorAll("script[src]:not([type=\"module\"])")) {
    await appendScript(resolveIndexAssetUrl(source.getAttribute("src"), privateBase).toString());
  }
  const entry = parsed.querySelector('script[type="module"][src]');
  if (!entry) throw new Error("DSH index did not declare a module entry");
  await appendScript(resolveIndexAssetUrl(entry.getAttribute("src"), privateBase).toString(), true);
}

/**
 * 安装 __DSH_TRANSPORT__ 与 __DSH_FILE_UPLOAD__（注入 index 前调用）。返回 disposer。
 *
 * 覆盖边界（2026-09-11 真机 403 排查 + 全树核对）：`__DSH_TRANSPORT__` 在全树里**只有
 * DSH 内核的 connection 客户端（dsh-client-connection）在读**，所以它只兜住内核自己的请求；
 * 浏览器侧其余 DSH 插件一律走原生 fetch/EventSource 或各自的钩子：
 *   · dsh-client-file-upload 读 `globalThis.__DSH_FILE_UPLOAD__`（官方为此设的钩子）。不设它
 *     → 回退到内联 Worker 载体（Blob Worker），而 Worker 里的 fetch 是**同源**（= 当前文档的
 *     宿主源，不是中继前缀）→ 宿主凭据闸 403 missing_credential。样例 hana-dsh 的
 *     ui/bootstrap.js 就是在这里一并设的（__DSH_FILE_UPLOAD__ 挨着 __DSH_TRANSPORT__），我们照做。
 *   · dsh-client-hmr 的 /plugins/events 用**原生 EventSource**打开、dsh-client-ui-open-in-app
 *     直取 /open-in-app/apps —— 这两条没有钩子可接，会落到宿主源被 403；样例同样如此
 *     （样例也没补 EventSource），非我们独有的退化。
 */
export function installTransport(privateBase, { role } = {}) {
  const mux = createStreamMux(privateBase);
  const runtimeFetch = createRuntimeFetch(privateBase);
  window.__DSH_TRANSPORT__ = {
    fetch: runtimeFetch,
    openStream: (endpoint, payload, signal) => mux.openStream(endpoint, payload, signal),
    loadBundle: loadRuntimeBundle(privateBase),
  };
  window.__DSH_FILE_UPLOAD__ = { fetch: runtimeFetch };
  // 宿主桥：DSH 客户端集成（integrations/ui-layout 等）读此对象判断「本文件属于哪个面」。
  // 名字是我们的（样例叫 __HANA_DSH__，我们写自己的 overlay，不沿用它的全局名）。
  // 目前只放 role：main 卡 → workspace（中+右，无 DSH 侧栏）；FP 面板 → navigation（纯侧栏）。
  window.__DSHANA__ = { role: role || "workspace" };
  return () => {
    try { delete window.__DSH_TRANSPORT__; } catch { /* 忽略 */ }
    try { delete window.__DSH_FILE_UPLOAD__; } catch { /* 忽略 */ }
    try { delete window.__DSHANA__; } catch { /* 忽略 */ }
    mux.dispose();
  };
}
