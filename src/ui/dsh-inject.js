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

import { installClipboardShadow } from "./clipboard-shadow.js";

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

// ---- 请求接管----
//
// 为什么需要它：`__DSH_TRANSPORT__` 是**内核 connection 客户端**的 opt-in 钩子，只兜住内核
// 自己的请求。DSH 侧其它代码（新插件、新调用点、非 fetch 载体）照旧打原生接口，而带前导斜杠
// 的裸路径连 `<base>` 都绕开（`/` 开头按 origin 解析，不走 base 的路径）——于是
// `/api/<命名空间>.<方法>`（DSH 的 Typert 文法是 `api/remote.mux`、`api/events.host` 这样）
// 落到**宿主源**上被凭据闸挡（403 missing_credential / 404）。真机又冒出来的
// `/api/present.host` 就是这个漏：每升一版 DSH，多一个调用点就多一个洞。
//
// 样例 hana-dsh 的做法是逐个包打补丁（它打了 client-hmr 与 ui-open-in-app）；我们一开始照做，
// 但成本随版本线性涨。这里改成**一处接管**：直接包住本页的请求原语，规则只有一条。
//
// 判定规则（必须可判定，所以只用两个条件）：
//   仅当 URL 的 origin 是当前文档（或 dsh.internal）**且** pathname 不在宿主前缀白名单下时，
//   才把 pathname + search 挂到中继前缀（privateBase）下；其它一律原样放行。
//   白名单只有一条 `/api/apps/`：App surface 对宿主的一切访问都绑在 `/api/apps/<appId>/...`
//   （SDK 的 hana.api.fetch 也走它），而中继自己就住在
//   `/api/apps/<id>/routes/_runtime/<rid>/_surface/<票>/` 下，天然放行（也顺便防了二次重写）。
//   外部 origin 既不重写也不报错——原生语义照旧；只有 opt-in 的 transport 才该抛。

/** 宿主侧路径前缀：这些前缀下的请求归宿主，不重写。 */
export const HOST_PATH_PREFIXES = ["/api/apps/"];

/**
 * 判定 + 重写：返回应发出的 URL；返回 null 表示按原生放行。
 * @param {string|URL} input
 * @param {URL} privateBase 中继前缀绝对 URL（尾带 /）
 * @param {{pageOrigin?: string, hostPrefixes?: string[]}} [opts]
 * @returns {URL|null}
 */
export function resolveRelayUrl(input, privateBase, opts = {}) {
  const pageOrigin = opts.pageOrigin || window.location.origin;
  const hostPrefixes = opts.hostPrefixes || HOST_PATH_PREFIXES;
  let url;
  try { url = new URL(String(input), pageOrigin); } catch { return null; }
  // ws:/wss: 的 origin 与页面的 http:/https: 不等值，按协议族归一后再比（WebSocket 载体
  // 自己带 http(s) URL 的情况真实存在，不能因为 scheme 写法把人拒了）。
  const samePage = url.origin.replace(/^ws/, "http") === pageOrigin.replace(/^ws/, "http");
  if (!samePage && url.origin !== DSH_INTERNAL_ORIGIN) return null;
  if (hostPrefixes.some((prefix) => url.pathname.startsWith(prefix))) return null;
  return new URL(url.pathname.replace(/^\//, "") + url.search + url.hash, privateBase);
}

/** WebSocket 专用映射：http(s) → ws(s)，判定同 resolveRelayUrl。 */
export function resolveRelaySocketUrl(input, privateBase, opts = {}) {
  const mapped = resolveRelayUrl(input, privateBase, opts);
  if (!mapped) return null;
  mapped.protocol = mapped.protocol === "https:" ? "wss:" : "ws:";
  return mapped;
}

/** 把原生构造器上的静态常量（CONNECTING/OPEN/CLOSING/CLOSED）搬到包装类上。 */
function inheritStatics(Wrapped, Native) {
  for (const key of Object.keys(Native)) {
    try { Wrapped[key] = Native[key]; } catch { /* 只读则跳过 */ }
  }
  return Wrapped;
}

/**
 * 接管本页的请求原语：fetch / XMLHttpRequest / EventSource / WebSocket / sendBeacon。
 * 只做一件事——把「发给本页 origin、且不属于宿主前缀」的 URL 改指中继前缀。
 * 覆盖不到的载体（Blob Worker 内部的 fetch、CSS url()、动态 import 之外的 DOM 资源）由
 * `<base>` 与各自钩子负责：见下面 installTransport 的覆盖边界说明。
 * @param {URL} privateBase
 * @param {{target?: any, navigator?: any, pageOrigin?: string, hostPrefixes?: string[]}} [opts]
 * @returns {() => void} disposer（逐个还原原生接口）
 */
export function installRequestTakeover(privateBase, opts = {}) {
  const target = opts.target || window;
  const pageOrigin = opts.pageOrigin || (target.location && target.location.origin) || window.location.origin;
  const nav = opts.navigator || target.navigator || (typeof navigator === "undefined" ? null : navigator);
  const conf = { pageOrigin, hostPrefixes: opts.hostPrefixes || HOST_PATH_PREFIXES };
  const relay = (input) => resolveRelayUrl(input, privateBase, conf);
  const undo = [];

  const originalFetch = target.fetch;
  const nativeFetch = typeof originalFetch === "function" ? originalFetch.bind(target) : null;
  const NativeXHR = target.XMLHttpRequest;
  const NativeEventSource = target.EventSource;
  const NativeWebSocket = target.WebSocket;
  const originalBeacon = nav ? nav.sendBeacon : null;
  const nativeBeacon = typeof originalBeacon === "function" ? originalBeacon.bind(nav) : null;

  if (nativeFetch) {
    target.fetch = (input, init) => {
      if (input instanceof Request) {
        const mapped = relay(input.url);
        if (!mapped) return nativeFetch(input, init);
        return nativeFetch(new Request(mapped, input), { ...init, credentials: "same-origin" });
      }
      const mapped = relay(input);
      if (!mapped) return nativeFetch(input, init);
      return nativeFetch(mapped, { ...init, credentials: "same-origin" });
    };
    undo.push(() => { target.fetch = originalFetch; });
  }

  if (NativeXHR && NativeXHR.prototype && typeof NativeXHR.prototype.open === "function") {
    const nativeOpen = NativeXHR.prototype.open;
    NativeXHR.prototype.open = function open(method, url, ...rest) {
      const mapped = relay(url);
      return nativeOpen.call(this, method, mapped ? mapped.toString() : url, ...rest);
    };
    undo.push(() => { NativeXHR.prototype.open = nativeOpen; });
  }

  if (NativeEventSource) {
    class RelayedEventSource extends NativeEventSource {
      constructor(url, config) {
        const mapped = relay(url);
        super(mapped ? mapped.toString() : url, config);
      }
    }
    target.EventSource = inheritStatics(RelayedEventSource, NativeEventSource);
    undo.push(() => { target.EventSource = NativeEventSource; });
  }

  if (NativeWebSocket) {
    class RelayedWebSocket extends NativeWebSocket {
      constructor(url, protocols) {
        const mapped = resolveRelaySocketUrl(url, privateBase, conf);
        const next = mapped ? mapped.toString() : url;
        if (protocols === undefined) super(next);
        else super(next, protocols);
      }
    }
    target.WebSocket = inheritStatics(RelayedWebSocket, NativeWebSocket);
    undo.push(() => { target.WebSocket = NativeWebSocket; });
  }

  if (nativeBeacon) {
    try {
      nav.sendBeacon = (url, data) => {
        const mapped = relay(url);
        return nativeBeacon(mapped ? mapped.toString() : url, data);
      };
      undo.push(() => { nav.sendBeacon = originalBeacon; });
    } catch { /* 宿主对象不可改则跳过 */ }
  }

  return () => {
    for (const restore of undo.reverse()) {
      try { restore(); } catch { /* 忽略 */ }
    }
  };
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
  // head 忠实搬运，**保持原顺序**（样式与脚本的相对次序决定优先级；只搬不重排）。
  // 对比旧实现的两处差异：① 多搬 <style>（旧实现漏搬，主题插件的静态 fallback
  // 就是这样丢的）；② 内联/外部脚本与样式混在同一趟有序遍历里，不再分块。
  // module entry 最后加载（它依赖前面的东西）。
  let moduleEntry = null;
  for (const node of parsed.head.children) {
    const tag = node.tagName.toLowerCase();
    if (tag === "link") {
      const rel = node.getAttribute("rel") || "";
      if (rel !== "stylesheet" && rel !== "modulepreload") continue;
      const href = node.getAttribute("href");
      if (!href) continue;
      const next = document.createElement("link");
      next.rel = node.rel;
      next.href = resolveIndexAssetUrl(href, privateBase).toString();
      if (node.crossOrigin) next.crossOrigin = node.crossOrigin;
      document.head.append(next);
      continue;
    }
    if (tag === "style") {
      const style = document.createElement("style");
      if (node.id) style.id = node.id;
      style.textContent = node.textContent;
      document.head.append(style);
      continue;
    }
    if (tag !== "script") continue;
    const src = node.getAttribute("src");
    const isModule = (node.getAttribute("type") || "").toLowerCase() === "module";
    if (isModule && src) { moduleEntry = src; continue; }
    if (!src) {
      const script = document.createElement("script");
      script.textContent = node.textContent;
      document.head.append(script);
      continue;
    }
    await appendScript(resolveIndexAssetUrl(src, privateBase).toString());
  }
  if (!moduleEntry) throw new Error("DSH index did not declare a module entry");
  // body 内联脚本（**必须早于 module entry**）：dsh 自己的 boot-theme 行就在 <body> 开头——
  // 它设 documentElement.style.colorScheme、body[data-ds-dark-theme]、--dsh-content-font-size。
  // 旧实现只搬 head，这行就丢了：dsh 的明暗标记与内容字号从未初始化（真机 2026-09-12）。
  for (const source of parsed.body.querySelectorAll("script:not([src])")) {
    const script = document.createElement("script");
    script.textContent = source.textContent;
    document.head.append(script);
  }
  await appendScript(resolveIndexAssetUrl(moduleEntry, privateBase).toString(), true);
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
 *   · dsh-client-hmr 的 /plugins/events（EventSource）与 dsh-client-ui-open-in-app 的
 *     /open-in-app/apps（裸 fetch）没有官方钩子可接，会落到宿主源被 403；样例的做法是**逐个打补丁**
 *     （它打了 client-hmr 与 ui-open-in-app）：EventSource 换 URL（桥的 runtimeUrl）、fetch 换
 *     __DSH_TRANSPORT__.fetch。我们同法（src-integrations/client-hmr、src-integrations/ui-open-in-app）。
 *
 * 2026-09-12 更新（真机上又冒出一个裸请求 /api/present.host）：逐点打补丁的成本随 DSH 版本线性涨，
 * 改成**一处接管**——installRequestTakeover 直接包住本页的 fetch / XMLHttpRequest / EventSource /
 * WebSocket / sendBeacon，凡「发给本页 origin、且不在宿主前缀 /api/apps/ 下」的 URL 一律改指中继前缀。
 * 上面两处逐包补丁保留（同一目标、互为兼容，不再新增第三处）；__DSH_TRANSPORT__ 仍是内核 connection
 * 客户端的 opt-in 通道，语义不变（它对外部 origin 抛错，接管层则原样放行）。
 */
export function installTransport(privateBase, { role, bridge } = {}) {
  // 请求接管先装：它必须早于任何 DSH 侧代码执行（注入 index 前调用本函数）。
  const restoreTakeover = installRequestTakeover(privateBase);
  const mux = createStreamMux(privateBase);
  const runtimeFetch = createRuntimeFetch(privateBase);
  window.__DSH_TRANSPORT__ = {
    fetch: runtimeFetch,
    openStream: (endpoint, payload, signal) => mux.openStream(endpoint, payload, signal),
    loadBundle: loadRuntimeBundle(privateBase),
  };
  window.__DSH_FILE_UPLOAD__ = { fetch: runtimeFetch };
  // 宿主桥：DSH 客户端集成（src-integrations/ui-layout 等）读此对象判断「本文件属于哪个面」。
  // 名字是我们的（样例叫 __HANA_DSH__，我们写自己的 overlay，不沿用它的全局名）。
  //   role       main 卡 → workspace（中+右，无 DSH 侧栏）；FP 面板 → navigation（纯侧栏）。
  //   runtimeUrl 把路径映射到私有运行时基址——给**不能被 fetch 型 transport 包装**的载体用：
  //              dsh-client-hmr 的 EventSource 只能换地址（样例 bridge.runtimeUrl(EVENTS_ENDPOINT)）。
  window.__DSHANA__ = {
    role: role || "workspace",
    runtimeUrl: (path) => mapRuntimeUrl(String(path), privateBase, window.location.origin).toString(),
    // 壳页传入的额外桥面（当前是设置视图读/写/订阅，见 src/ui/app-shell.js 的 VIEW_STATE_API）：
    // src-integrations/ui-settings-general 靠它做「FP 点设置、主卡打开」。
    ...(bridge && typeof bridge === "object" ? bridge : {}),
  };
  // 剪贴板影子：壳级全局安装，也必须在 DSH 注入之前。
  // 理由（实读 dsh-web-frontend 主 bundle 的 writeClipboard）：它在调用时才读
  // navigator.clipboard?.writeText，而原生一失败就 `return false`，execCommand 兜底只在
  // writeText **不存在**时才走——嵌入场景里原生被 Permissions-Policy 关死，于是复制永远失败，
  // 还每次先留一条 [Violation]。影子必须在属性被读到之前就位；桥面已就绪，故放在 __DSHANA__ 之后。
  const restoreClipboard = installClipboardShadow({ bridge: window.__DSHANA__ });
  return () => {
    try { restoreClipboard(); } catch { /* 忽略 */ }
    try { restoreTakeover(); } catch { /* 忽略 */ }
    try { delete window.__DSH_TRANSPORT__; } catch { /* 忽略 */ }
    try { delete window.__DSH_FILE_UPLOAD__; } catch { /* 忽略 */ }
    try { delete window.__DSHANA__; } catch { /* 忽略 */ }
    mux.dispose();
  };
}
