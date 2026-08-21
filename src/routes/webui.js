// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// routes/webui.js — dsh-hanako 插件页：Hana 顶部 tab 内嵌 dsh Web UI
//   GET /webui            插件页（iframe 嵌 http://127.0.0.1:<port>/，含就绪探测/主题注入/失败自检）
//   GET /webui/health     轻量就绪探测（浏览器端 3s 重试轮询源；Node fetch 无 CORS 问题；
//                         未就绪时附带 diagnostics 字段供页面渲染自检）
//   POST /webui/start        手动启动 web host（process 卡片「手动启动」按钮；ready/starting/触发启动三态）
//   POST /webui/install-deps 自动安装 dsh 依赖（deps 卡片「安装依赖」按钮；installing/触发安装）
//   GET  /webui/verify-deps  运行级依赖检测（node cliBin --version；进标签页自动一次 + 手动「检测依赖」按钮）
//   GET  /webui/check-update 版本检查（deps 卡片「检查更新」按钮；经宿主能力层 g.checkDshUpdate）
//   POST /webui/update-dsh   更新 DSH（deps 卡片「更新 DSH」按钮；经宿主能力层 g.updateDsh，
//                            异步触发，更新会重启 web host、正在执行的任务中断）
//
// 机制：与 routes/card.js 同构——宿主把 app 挂在 /api/plugins/<pluginId> 命名空间下，
// 这里注册相对路径。渲染前服务端用 Node fetch 探测 dsh web host 的 /api/host.describe
// （1.5s 超时，低延迟不拖慢页面）；就绪则直接渲染 iframe，未就绪渲染提示区并让浏览器
// 每 3s 轮询本插件的 /webui/health，就绪后动态挂载 iframe。脚本首行 postMessage ready
// 是宿主原始握手（参照 PLUGINS.md；插件 bundle 不含 @hana/plugin-sdk，不依赖它）。
//
// 连接失败自检：web host 未就绪时逐项检查 ① nodejs 配置 ② dsh 依赖
// ③ DSH 进程状态，明确指出哪一项坏了、为什么、怎么修。诊断由服务端收集（Node 侧
// 才能读 config.json、进程单例与 fs 状态；浏览器 iframe 读不到插件进程）——收集函数
// 挂在 globalThis 单例（tools/dsh-run.js 的 collectDiagnostics），这里经单例调用而
// 非静态 import：Hana 以 ?t= 时间戳加载 tools 模块，静态 import 会命中 Node ESM 固定
// URL 缓存读到旧模块（见 tools/dsh-run.js 头部注释），与 index.js 经单例取 closeProcess
// 同一套纪律。工具模块未加载（冷启动窗口）时单例函数缺失，返回 null 由轮询补上。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
// 插件页 HTML 壳（构建期 template-loader 经 doT 编译为自包含渲染函数，运行时零依赖）
import { render as webuiShellHtml } from "../assets/webui-shell.jinja2";


function esc(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 反向代理 dsh web host：插件页 iframe 不再直连 127.0.0.1，改经本插件 route 同源转发。
 * 路径设计：挂在 `/api/plugins/<pluginId>/web/...`（相对注册 `/web/*`），1:1 映射到
 * `http://127.0.0.1:<port>/<rest>`。目标 = 浏览器端不再产生任何对 127.0.0.1 的直连请求
 * （HTML/CSS/JS/字体/图片的 GET 全量资源 + JSON API 的 POST 等），全部回落到插件命名空间。
 *
 * 关于 dsh SPA 的路径改写（为什么要做 HTML 重写）：
 *   - dsh web frontend 的 index.html 用「根绝对路径」引用资源：`/assets/...`、
 *     `/favicon.svg`、`/manifest.webmanifest`。若不做任何处理，浏览器把 iframe 文档
 *     （origin = 宿主）里这些 `/assets/...` 解析到宿主根路径，不会经过代理 → UI 直接坏掉。
 *   - 但 dsh 的 JS bundle 内部用「相对路径」引用分包（`./vendor-xxx.js`、
 *     `assets/langs/xxx.js`）。因此只要把 HTML 里的根绝对资源前缀改写为代理前缀，整个
 *     资源图就经代理回流（JS 相对解析落在自身的代理目录下）。
 *   - 本实现只改写 HTML（text/html）里少数已知根绝对资源前缀（assets/favicon/manifest），
 *     不动 JS/CSS 字节（相对引用天然走代理），最小化误伤面。
 *
 * 流式回传与响应头纪律：
 *   - GET 全量资源用 `c.body(res.body)` 流式（不落缓冲，字体/大 JS 低内存）；POST 同理。
 *   - 复制状态码、content-type 与关键非 hop-by-hop 头；去掉 hop-by-hop 头（connection/
 *     transfer-encoding/upgrade/te/trailer 等）。逐条删除 content-length —— 流式回传时
 *     浏览器/宿主会按 chunked 传输，残留 content-length 会与分块传输冲突。
 *   - HTML 因需改写而读全文（index.html 毕竟很小），此时一并去掉 content-encoding（已解压）
 *     与 content-length。
 *   - set-cookie 用 getSetCookie() 保真（Node≥18.14；宿主 electron Node 满足）。
 *
 * 容错：未就绪/连接失败时返回友好 HTML（不抛异常、不外泄日志），复用 probeHost 探测做
 * 一次就绪确认，并附带 webLastError（如有）便于排障；上游请求 header 不转发 host（回写
 * 127.0.0.1:port）避免宿主侧浏览器信任围栏误判。 */
const PROXY_PREFIX = "/web";
// 请求侧 hop-by-hop + 不应回传的上游 host（Node fetch 从 URL 自行设置 Host）
const REQUEST_HOP = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
  "expect",
]);
// 响应侧 hop-by-hop + 由流式传输接管/由镜像内容取代的头部
const RESPONSE_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
]);
// 已知根绝对资源前缀（index.html 里出现的全部；改写为代理前缀后子资源经代理回流）。
// 注意 HTML_ROOT_ASSET 必须用 (src|href)="..." 的标签属性形式——若用宽松的
// /"\/(assets\/|...)/g 会误伤 __DSH_BOOT__ 里 url 字段（那些是独立一类，见 HTML_BOOT_ENTRY_URL）。
const HTML_ROOT_ASSET =
  /\b(src|href)="\/(assets\/|favicon\.svg|manifest\.webmanifest)/gi;
// __DSH_BOOT__ 的 entries 数组里每个入口形如 "url":"/plugins/<id>/client.js?rev=..."。
// dsh 前端插件系统 boot 代码读该 JSON 后 document.createElement('script').src = entry.url
// 加载（不走 fetch），因此必须在 HTML 文本层改写成代理前缀，否则浏览器把 /plugins/...
// 解析到宿主根路径、绕开代理 → UI 无法加载。
const HTML_BOOT_ENTRY_URL = /("url":")\/(plugins\/)/g;

/** 把 HTML 里的根绝对引用改写为代理前缀（只针对 HTML；JS/CSS 相对引用天然走代理无需动）。
 * 两类改写：
 *   ① 标签属性 src/href 的根绝对资源（/assets/…、/favicon.svg、/manifest.webmanifest）
 *   ② __DSH_BOOT__ 里 boot 入口的 "url":"/plugins/…"（dsh 插件系统前端加载入口）
 * HTML_BOOT_ENTRY_URL 在 HTML_ROOT_ASSET 之后应用，两者模式不重叠（属性 vs url 字段）。
 *
 * sessQuery：可选，宿主 surface session 凭证（形如 "pluginSurfaceSession=<enc>"，不含前导
 * 分隔符）。设定后改写出的每个资源 URL 都附加该凭证 query（已有 query 用 &、否则 ?）——
 * 宿主反代对 /api/plugins/* 全局鉴权且只认 query 通道（X-Hana-Plugin-Surface-Session 头对
 * 静态资源无效，src/href 加载也无法加 header），故静态资源必须把凭证写进 URL query。
 * 凭证仅在「浏览器→宿主」段携带，宿主转发前剥离，不会传给 dsh host。 */
function rewriteHtmlForProxy(html, proxyBase, sessQuery) {
  const q = sessQuery || "";
  const joinQuery = (rest) =>
    q ? (rest.indexOf("?") === -1 ? "?" : "&") + q : "";
  return html
    .replace(
      HTML_ROOT_ASSET,
      (m, attr, rest) => `${attr}="${proxyBase}/${rest}${joinQuery(rest)}`,
    )
    .replace(
      HTML_BOOT_ENTRY_URL,
      (m, quote, rest) => `${quote}${proxyBase}/${rest}${joinQuery(rest)}`,
    );
}

/** 注入 <head> 最前（__DSH_BOOT__ 之前）的 boot 前置脚本——一个自包含 IIFE，patch 全局
 *  fetch/EventSource/WebSocket/XMLHttpRequest，把「以 / 开头的根绝对路径」重写到代理前缀。
 * 这样 dsh 前端运行时里编译期字符串字面量的根绝对 API 请求（readSse("/api/events.mux")、
 * postJson(`/api/${method}`)）在运行时被拦截改写，无需 dsh 支持 basePath（其 resolveBase
 * 用 location.origin 拼装，无 base path 配置点，见 routes/webui.js 头部代理说明）。
 *
 * 动因为何选运行时 patch 而非 HTML 改写：这些 /api/* 前缀只以 JS 字符串字面量形式出现在
 * 已混淆/分包的 bundle 字节里（客户端 JS 里无固定可安全匹配的文本签名），HTML 文本层无
 * 法安全全局替换（会误伤普通字符串内容），故必须注入前置脚本在全局 API 层兜底。脚本自包含、
 * 零外部依赖、IIFE + 局部变量不污染全局命名；代理前缀在注入时代入实际 base（不硬编码）。
 *
 * @returns 注入后的完整 HTML */
function injectBootPreface(html, proxyBase) {
  const body = BOOT_PREFACE.replace(/@__BOOT_PROXY__@/g, proxyBase)
    .replace(/@__BOOT_SESS_HEADER__@/g, BOOT_SESS_HEADER)
    .replace(/@__BOOT_SESS_QUERY__@/g, BOOT_SESS_QUERY);
  // 包 <script> 标签；模板内任何 </script> 立即打断序列化，转义为 <\/script> 防提前闭合
  const script =
    "<script>" + body.replace(/<\/script>/gi, "<\\/script>") + "</script>";
  // 在 <head> 开口标签之后插入（此时 __DSH_BOOT__ script 尚未执行，patch 先行生效）；
  // 找不到 <head>（异常 HTML）时原样返回。
  if (!/<head[^>]*>/i.test(html)) return html;
  return html.replace(/<head[^>]*>/i, (m) => m + script);
}

// boot 脚本模板（注入时把 @__BOOT_PROXY__@ / @__BOOT_SESS_HDR__@ / @__BOOT_SESS_QUERY__@
// 替换为实际值）。IIFE 完整包住，仅改写根绝对路径与附加凭证；相对路径自然落 iframe
// 代理目录无需动；跨源绝对 URL 跳过（保持第三方出站能力）。
//   rewrite 规则：
//     - 非字符串 / 空串：原样（Request 等对象在此层不处理，由各 patch 内部分支处理）
//     - 不以 / 开头：原样跳过（相对路径天然在代理目录下）
//     - 已以代理前缀开头：原样（防二次加前缀）
//     - 其余以 / 开头的根绝对路径：PROXY + u
//   另对「完整同源绝对 URL」（location.origin + 路径）做保守处理：仅当 origin 匹配时提取
//   路径段走 rewrite 再拼回，异常/跨源 try-catch 跳过。
//   fetch：input 为 string 直接 rewrite；input 为 Request 时仅同源才重建（保留 method/
//   headers/body），跨源或解析失败跳过。
//   EventSource：new OES(rewrite(url), cfg)——dsh 事件流（/api/events.mux SSE）走这里，最关键。
//   WebSocket / XHR.open：防御性 patch（dsh UI 当前未确认使用，但第三方插件脚本可能用到）。
//
// 凭证（surface session）附加 —— 宿主对所有 /api/plugins/* route（含本代理 /web/*）做全局
// 鉴权，要求 principal 满足至少一个宿主 plugin surface session（header/query 凭证），否则
// missing_credential 403。实测宿主对实时代理 route **只认 query 通道**（X-Hana-Plugin-Surface-
// Session 头无效），故文档内所有请求（fetch/EventSource/XHR）一律以 **URL query**（pluginSurfaceSession=）
// 附加凭证（header 仅作双保险，宿主接受其一即可）；静态资源（src/href）无法加 header，必须
// 靠服务端 rewriteHtmlForProxy 把凭证写进改写后的资源 URL query。
// 凭证来源 = 本文档 location.search 的 pluginSurfaceSession（壳页面 attach() 注入 iframe
// src query，见 webui-shell.jinja2）。凭证仅在「浏览器→宿主」段携带，宿主 proxyToPlugin
// 转发前会剥离该 header/query，不会传给 dsh host。凭证缺失时各附加分支直接跳过（不改造
// 原先 rewrite 行为，保持向后兼容）。
const BOOT_SESS_HEADER = "X-Hana-Plugin-Surface-Session";
const BOOT_SESS_QUERY = "pluginSurfaceSession";
const BOOT_PREFACE = `(function(){
  "use strict";
  var PROXY = "@__BOOT_PROXY__@";
  var SESS_HEADER = "@__BOOT_SESS_HEADER__@";
  var SESS_QUERY = "@__BOOT_SESS_QUERY__@";
  // surface session 凭证（宿主签发 12h TTL；壳页面经 iframe src query 注入本文档）。
  // 空串表示无凭证 → withSessionQuery/withSessionHeader 全部跳过（对原行为零改动）。
  var SESS = new URLSearchParams(location.search).get(SESS_QUERY) || "";
  function rewrite(u){
    if (typeof u !== "string" || u === "") return u;
    if (u.charAt(0) === "/") {
      if (u === PROXY || u.indexOf(PROXY + "/") === 0) return u;
      return PROXY + u;
    }
    // 完整同源绝对 URL（location.origin + 路径）：仅 origin 匹配才改路径段，其余原样
    var o = location.origin;
    if (o && u.indexOf(o) === 0) {
      var rest = u.slice(o.length);
      if (rest && rest.charAt(0) === "/" &&
          rest !== PROXY && rest.indexOf(PROXY + "/") !== 0) {
        return o + PROXY + rest;
      }
    }
    return u;
  }
  // 给 URL 附加凭证 query（EventSource/WebSocket 无 setRequestHeader 能力，只能走 query）。
  // 已带 query 用 & 连接、无则 ?；凭证缺失原样返回。
  function withSessionQuery(u){
    if (SESS === "" || typeof u !== "string") return u;
    return u + (u.indexOf("?") === -1 ? "?" : "&")
      + SESS_QUERY + "=" + encodeURIComponent(SESS);
  }
  // 把凭证 header 合并进 fetch init.headers（多形态：undefined/数组/对象/Headers 统一为
  // Headers）；调用方已有同名 header 不覆盖；无凭证原样返回 init（对原行为零改动）。
  function withSessionHeader(init){
    if (SESS === "") return init;
    var h = new Headers(init && init.headers ? init.headers : undefined);
    if (!h.has(SESS_HEADER)) h.set(SESS_HEADER, SESS);
    return Object.assign({}, init || {}, { headers: h });
  }
  var oFetch = window.fetch;
  if (typeof oFetch === "function") {
    window.fetch = function(input, init){
      // 凭证以 URL query 附加（宿主对 /api/plugins/* 只认 query 通道，header 无效）；
      // 同时保留 header（双保险，宿主接受其一即可）。
      if (typeof input === "string") { input = withSessionQuery(rewrite(input)); }
      else if (input && input.url !== undefined) {
        try {
          if (typeof input.url === "string" &&
              input.url.indexOf(location.origin) === 0) {
            var pu = new URL(input.url);
            input = new Request(withSessionQuery(rewrite(pu.pathname + pu.search)), input);
          }
        } catch (e) { /* 跨源/异常跳过 */ }
      }
      return oFetch.call(this, input, withSessionHeader(init));
    };
  }
  var OES = window.EventSource;
  if (typeof OES === "function") {
    var esWrap = function(url, cfg){ return new OES(withSessionQuery(rewrite(url)), cfg); };
    try { Object.setPrototypeOf(esWrap, OES); } catch (e) { /* 静态常量为非必须，忽略 */ }
    window.EventSource = esWrap;
  }
  var OWS = window.WebSocket;
  if (typeof OWS === "function") {
    var wsWrap = function(url, proto){
      var u = withSessionQuery(rewrite(url));
      return proto === undefined ? new OWS(u) : new OWS(u, proto);
    };
    try { Object.setPrototypeOf(wsWrap, OWS); } catch (e) { /* 同上 */ }
    window.WebSocket = wsWrap;
  }
  var xhr = window.XMLHttpRequest;
  if (xhr && xhr.prototype && xhr.prototype.open) {
    var xOpen = xhr.prototype.open;
    xhr.prototype.open = function(method, url){
      // 凭证以 URL query 附加（宿主只认 query 通道）+ header 双保险
      arguments[1] = withSessionQuery(rewrite(url));
      var r = xOpen.apply(this, arguments);
      if (SESS !== "") { try { this.setRequestHeader(SESS_HEADER, SESS); } catch (e) { /* header 被拒/只读 */ } }
      return r;
    };
  }
})();`;

/** 代理到 dsh web host（GET 全量资源 + POST JSON API）。subPath 含前导 /，对应
 * 127.0.0.1:<port><subPath><query>。任何失败走友好 JSON/HTML 容错，本 handler 不抛异常。 */
async function proxyToDsh(c, ctx, port, subPath) {
  const g = globalThis.__dshHanako;
  // method 需在 try/catch 两侧可见（catch 里按 method 决定回 JSON 还是 HTML 错误），
  // 故提到函数顶部声明；hasBody 同理在 try 内使用。
  const method = String(c?.req?.method || "GET").toUpperCase();
  try {
    const upstream = `http://127.0.0.1:${port}${subPath}${new URL(c.req.url).search}`;
    const reqHeaders = new Headers();
    for (const [k, v] of c.req.raw.headers) {
      if (!REQUEST_HOP.has(k.toLowerCase())) reqHeaders.set(k, v);
    }
    reqHeaders.set("host", `127.0.0.1:${port}`);
    const hasBody = method !== "GET" && method !== "HEAD";
    const upstreamRes = await fetch(upstream, {
      method,
      headers: reqHeaders,
      body: hasBody ? c.req.raw.body : undefined,
      ...(hasBody ? { duplex: "half" } : {}),
      redirect: "manual", // 不跟随：把 3xx 连同 Location 原样回传给浏览器（dsh 一般不重定向）
    });

    const headers = new Headers();
    upstreamRes.headers.forEach((v, k) => {
      if (!RESPONSE_HOP.has(k.toLowerCase())) headers.set(k, v);
    });
    // set-cookie 保真（getSetCookie 仅 Node≥18.14；缺失时退化为普通 append）
    if (typeof upstreamRes.headers.getSetCookie === "function") {
      const sc = upstreamRes.headers.getSetCookie();
      if (sc.length) {
        headers.delete("set-cookie");
        for (const s of sc) headers.append("set-cookie", s);
      }
    }
    headers.delete("content-length"); // 流式/改写后由传输层接管，避免与 chunked 冲突

    const ct = String(upstreamRes.headers.get("content-type") || "").toLowerCase();
    if (ct.includes("text/html")) {
      // HTML 需改写到代理前缀：读全文（index.html 很小），此时也去掉 content-encoding。
      // 改写（标签属性资源 + __DSH_BOOT__ boot 入口 url）后再注入 <head> 最前的
      // boot 前置脚本（patch 全局 API 兜底 /api/* 等运行时地址），见函数注释。
      const proxyBase = "/api/plugins/" + ctx.pluginId + PROXY_PREFIX;
      // 取宿主 surface session 凭证（宿主对 /api/plugins/* 只认 query 通道；src/href 静态
      // 资源无法加 header，只能把凭证写进改写出的资源 URL query）。来源：入站 /web/ 请求
      // query 优先，其次同名 header（宿主转发前是否剥离因版本而异，两种都兜底）。
      let sessQuery = "";
      try {
        const reqUrl = new URL(c.req.url);
        const tok =
          reqUrl.searchParams.get(BOOT_SESS_QUERY) ||
          String(c.req.raw?.headers?.[BOOT_SESS_HEADER.toLowerCase()] || "");
        sessQuery = tok ? `${BOOT_SESS_QUERY}=${encodeURIComponent(tok)}` : "";
      } catch {
        /* 忽略 */
      }
      let html = rewriteHtmlForProxy(await upstreamRes.text(), proxyBase, sessQuery);
      html = injectBootPreface(html, proxyBase);
      headers.delete("content-encoding");
      return c.html(html, upstreamRes.status, Object.fromEntries(headers));
    }
    // 其余资源（JS/CSS/字体/图片/API JSON）：流式回传，保留原 content-type/encoding
    return c.body(upstreamRes.body, upstreamRes.status, Object.fromEntries(headers));
  } catch (e) {
    // 连接失败/未就绪：友好容错（含就绪确认 + 最近一次启动错误，不抛异常）
    const ready = await probeHost(port, ctx.log).catch(() => false);
    const lastErr = g?.webLastError || null;
    const state = ready ? "dsh web host 已就绪但转发失败" : "dsh web host 未就绪";
    const detail = e?.message || String(e);
    // API 类请求（POST 或 /api/ 路径）回 JSON 错误（前端 fetch JSON 解析）；文档类回 HTML 页
    if (method === "POST" || /^\/api\//i.test(subPath)) {
      return c.json(
        { ok: false, error: state + "：" + detail, webLastError: lastErr },
        502,
      );
    }
    return c.html(
      `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<title>DSHana 代理不可用</title></head><body style="font-family:system-ui,Segoe UI,Microsoft YaHei,sans-serif;padding:24px">
<h2>${state}</h2><p style="color:#8a3b2f">${esc(detail)}</p>${
        lastErr
          ? `<p>最近启动错误：${esc(typeof lastErr === "string" ? lastErr : lastErr?.message || String(lastErr))}</p>`
          : ""
      }
<p>返回 DSHana 标签页等待就绪后自动进入。</p></body></html>`,
      502,
    );
  }
}

/** 探测 dsh web host 是否就绪（host.describe RPC，1.5s 超时；任何失败视为未就绪） */
async function probeHost(port, log) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/host.describe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "probe",
        method: "host.describe",
        payload: {},
      }),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch (e) {
    log?.warn?.(
      `[dsh-hanako] probeHost 失败（port ${port}）：${e?.message || e}`,
    );
    return false;
  }
}

/** 读连接失败自检（服务端收集：config.json + 单例 + fs；经单例调用 tools 的收集函数）。
 * 工具模块未加载（冷启动窗口）时返回 null，页面先渲染占位，轮询刷新后填充。
 * 只回布尔与截断文本（不返回凭据）；stderr 尾部在收集端已截断 ≤800。 */
function readDiagnostics(ctx, cfg, port) {
  const g = globalThis.__dshHanako;
  if (g && typeof g.collectDiagnostics === "function") {
    try {
      return g.collectDiagnostics({ dataDir: ctx?.dataDir, webPort: port });
    } catch (e) {
      ctx.log?.warn?.(
        "[dsh-hanako] 收集连接自检失败:",
        e?.message || String(e),
      );
      return null;
    }
  }
  return null;
}

/** 插件页 HTML 壳：ready=true 由壳页面加载后立即 attach() 挂载 iframe（src 含 surface session
 * 凭证）；否则提示区（标题 + 自检列表 + 重试）+ 轮询 health 后动态挂载。两种情况 iframe 均不带
 * 内联 src（统一由 attach() 设置），保证 ready=true 的初始导航也带宿主凭证。
 * colorScheme：按宿主 hana-theme 映射的 color-scheme（dark/light）。dsh 主题为
 * system 时通过 prefers-color-scheme 解析，Chromium 会让跨源 iframe 继承父页面
 * 的 color-scheme，因此 dsh 会跟随宿主主题；dsh 内显式选了 light/dark 则不受影响。
 * diagnostics：未就绪时服务端收集的首帧自检数据（JSON 对象或 null）；浏览器端
 * 渲染进提示区，并在每次 health 轮询未就绪时用新 diagnostics 刷新。 */
function buildShell({
  ready,
  hcLink,
  theme,
  api,
  port,
  colorScheme,
  diagnostics,
}) {
  // dsh-frame 保持裸嵌（曾尝试显式声明 sandbox/allow 绕过宿主沙箱，实测跨源继承链
  // 下内层声明无法生效，属无效方案已回滚，见 CHANGELOG）。
  // 剪贴板问题的正规解法是 dsh-hana-clipboard 插件（tapIndex 注入桥 → 宿主 capability）
  // + 下方壳页面桥（hostRequest + __dshCopy 监听）。
  // iframe 不再直连 127.0.0.1，src 也**不在此拼写**：宿主对本代理 route（/api/plugins/*）
  // 全局鉴权，ready=true 时的初始导航（/web/ → host 根）同样要求凭证，因此 src 统一由壳
  // 页面浏览器侧 attach() 设置（指向插件自身 /web/ 代理 route 并携带宿主 surface session
  // 凭证，见 webui-shell.jinja2 的 attach()）。此处 iframe 恒留空 src，等 attach() 挂载。
  const iframe = `<iframe id="dsh-frame"></iframe>`;
  // 嵌入首帧自检 JSON：把 </ 转义成 <\/，防诊断文本（路径/stderr）里的 </script> 提前闭合脚本
  const initDiag = diagnostics
    ? JSON.stringify(diagnostics).replace(/<\//g, "<\\/")
    : "null";
  // HTML 模板来自 src/assets/webui-shell.jinja2（asset/source 内联，占位符保留）；
  // 渲染函数由 template-loader 在构建期生成（doT），scope 直接作 it 传入。
  return webuiShellHtml({
    colorScheme,
    hcLink,
    esc,
    theme,
    ready,
    iframe,
    api,
    initDiag,
    port,
  });
}

export default function registerWebuiRoutes(app, ctx) {
  const base = "/api/plugins/" + ctx.pluginId;
  // 端口：manifest 默认 + 用户配置合并后的 ctx.config；非对象容错回退 3080
  const cfg =
    ctx && typeof ctx.config === "object" && ctx.config ? ctx.config : {};
  const port = Number(cfg.webPort) || 3080;

  // 插件页：服务端先探测 host，就绪直接渲染 iframe；未就绪给提示（含自检诊断）+ 浏览器端轮询
  app.get("/webui", async (c) => {
    const ready = await probeHost(port, ctx.log);
    const hc = c.req.query("hana-css") || "";
    const th = c.req.query("hana-theme") || "inherit";
    const hcLink = hc ? `<link rel="stylesheet" href="${esc(hc)}">` : "";
    // 宿主深色主题（midnight/dark 等）→ iframe 内 prefers-color-scheme dark，dsh 的 system 跟随宿主
    const colorScheme = /midnight|dark/i.test(th) ? "dark" : "light";
    // 未就绪时服务端同步收集一次自检（首屏即渲染，轮询再刷新）；就绪不收集保持轻量
    const diagnostics = ready ? null : readDiagnostics(ctx, cfg, port);
    return c.html(
      buildShell({
        ready,
        hcLink,
        theme: th,
        api: base,
        port,
        colorScheme,
        diagnostics,
      }),
    );
  });

  // 轻量就绪探测端点（浏览器端重试轮询复用同一探测逻辑；未就绪时附带自检诊断字段便于排障）
  app.get("/webui/health", async (c) => {
    const ready = await probeHost(port, ctx.log);
    const body = { ok: ready, port, timestamp: Date.now() };
    // 未就绪时附带诊断（可为 null——工具模块冷启动未加载，下一轮轮询补上）；就绪时保持轻量
    if (!ready) body.diagnostics = readDiagnostics(ctx, cfg, port);
    return c.json(body);
  });

  // 手动启动 web host（process 卡片「手动启动」按钮调用）：读单例按当前状态返回——
  // 已就绪 → ready；启动中（readyPromise 挂起）→ starting；否则异步触发
  // g.startWebHost(ctx.config, dataDir)（不 await 其就绪，页面靠轮询检测）→ starting。
  // 单例缺失/无函数/异常一律容错回 {ok:false}，本路由不抛异常。
  app.post("/webui/start", (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.startWebHost !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.web?.ready) return c.json({ ok: true, state: "ready" });
      if (g.web?.readyPromise) return c.json({ ok: true, state: "starting" });
      // 异步触发（startWebHostFromPlugin 内部已 try/catch 记 webLastError 返回布尔；
      // 这里再 .catch 兜底——路由不等待就绪、不抛异常）。dataDir 缺省用单例记录值，
      // 避免路由 ctx 无 dataDir 时误落 PLUGIN_ROOT/data。
      Promise.resolve(
        g.startWebHost(ctx.config, ctx.dataDir || g.dataDir),
      ).catch(() => {});
      return c.json({ ok: true, state: "starting" });
    } catch (e) {
      ctx.log?.warn?.(
        "[dsh-hanako] 手动启动 web host 失败:",
        e?.message || String(e),
      );
      return c.json({ ok: false, error: "启动请求失败，请稍后重试" });
    }
  });

  // 自动安装 dsh 依赖（deps 卡片「安装依赖」按钮调用）：读单例按状态返回——
  // 部署中（g.depsInstalling）→ {ok:true,state:"installing"}；否则异步触发
  // g.installDeps(ctx.config, dataDir)（不 await 其完成，页面靠轮询诊断刷新）→ installing。
  // 单例缺失/无函数/异常一律容错回 {ok:false}，本路由不抛异常。
  app.post("/webui/install-deps", (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.installDeps !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.depsInstalling) return c.json({ ok: true, state: "installing" });
      // 异步触发（installDepsFromPlugin 内部已 try/catch 记 depsInstallError 返回结果；
      // 这里再 .catch 兜底——路由不等待完成、不抛异常）。dataDir 缺省用单例记录值。
      Promise.resolve(
        g.installDeps(ctx.config, ctx.dataDir || g.dataDir),
      ).catch(() => {});
      return c.json({ ok: true, state: "installing" });
    } catch (e) {
      ctx.log?.warn?.(
        "[dsh-hanako] 自动安装依赖失败:",
        e?.message || String(e),
      );
      return c.json({ ok: false, error: "安装请求失败，请稍后重试" });
    }
  });

  // 运行级依赖检测（deps 卡片「检测依赖」按钮 + 进标签页自动一次；GET 只读）：
  // 检测中（g.depsSmoke.running）→ {ok:true,running:true}；否则 await verifyDepsSmoke(cfg)
  // （≤10s 返回）→ {ok:true, verified, version, error, running:false}。结果写入 g.depsSmoke，
  // 前端随后经 health 读取诊断刷新 deps 卡片。单例缺失/无函数/异常一律容错回 {ok:false}。
  app.get("/webui/verify-deps", async (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.verifyDeps !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.depsSmoke?.running) return c.json({ ok: true, running: true });
      const smoke = await g.verifyDeps({
        dataDir: ctx.dataDir || g.dataDir,
        webPort: port,
      });
      return c.json({
        ok: true,
        running: false,
        verified: smoke.ok,
        version: smoke.version,
        error: smoke.error || null,
      });
    } catch (e) {
      ctx.log?.warn?.(
        "[dsh-hanako] 运行级依赖检测失败:",
        e?.message || String(e),
      );
      return c.json({ ok: false, error: "检测请求失败，请稍后重试" });
    }
  });

  // 版本检查（deps 卡片「检查更新」按钮 + Agent 工具 dsh_update 共用能力层；
  // GET 只读）：检查中（g.checking）→ {ok:true,running:true}；否则 await
  // g.checkDshUpdate(cfg)（npm view ≤~15s，官方源失败重试 npmmirror）→
  // {ok:true, localVersion, latestVersion, updateAvailable, error?}。结果缓存进
  // g.checkResult 并写 check-result.json，前端随后经 health 读取诊断刷新 deps 卡片。
  // 单例缺失/无函数/异常一律容错回 {ok:false}，本路由不抛异常。
  app.get("/webui/check-update", async (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.checkDshUpdate !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.checking) return c.json({ ok: true, running: true });
      const r = await g.checkDshUpdate({
        dataDir: ctx.dataDir || g.dataDir,
        webPort: port,
      });
      return c.json({
        ok: true,
        running: false,
        localVersion: r.localVersion,
        latestVersion: r.latestVersion,
        updateAvailable: r.updateAvailable,
        error: r.error || null,
      });
    } catch (e) {
      ctx.log?.warn?.("[dsh-hanako] 版本检查失败:", e?.message || String(e));
      return c.json({ ok: false, error: "版本检查失败，请稍后重试" });
    }
  });

  // 更新 DSH（deps 卡片「更新 DSH」按钮 + Agent 工具 dsh_update 共用能力层）：
  // 更新中（g.updating）→ {ok:true,state:"updating"}；否则异步触发 g.updateDsh(cfg)
  // （不 await 其完成——npm i 可能耗时数分钟，前端轮询 health 诊断/设置页
  // update-result.json 看进度）→ {ok:true,state:"updating"}。更新会重启 web host，
  // 正在执行的 dsh 任务会中断（前端按钮已有确认文案）。单例缺失/无函数/异常一律容错
  // 回 {ok:false}，本路由不抛异常。
  app.post("/webui/update-dsh", (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.updateDsh !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.updating) return c.json({ ok: true, state: "updating" });
      // 异步触发（updateDsh 内部已 try/catch 写 update-result.json 返回结果；
      // 这里再 .catch 兜底——路由不等待完成、不抛异常）。dataDir 缺省用单例记录值。
      Promise.resolve(
        g.updateDsh({ dataDir: ctx.dataDir || g.dataDir, webPort: port }),
      ).catch(() => {});
      return c.json({ ok: true, state: "updating" });
    } catch (e) {
      ctx.log?.warn?.("[dsh-hanako] 更新 DSH 失败:", e?.message || String(e));
      return c.json({ ok: false, error: "更新请求失败，请稍后重试" });
    }
  });

  // ── 反向代理 dsh web host（插件页 iframe 同源载体，替代浏览器直连 127.0.0.1）──
  // 挂在 `app.all(PROXY_PREFIX)` 与 `app.all(PROXY_PREFIX + "/*")`：前者对应根 `/web`
  // （→ host 根 `/`），后者对应 `/web/<rest>`（1:1 映射到 host `<rest>`）。支持 GET 全量
  // 资源（HTML/CSS/JS/字体/图片）与 POST JSON API，统一走 proxyToDsh（流式回传 + 头纪律
  // + HTML 根绝对资源改写 + 未就绪友好容错）。本代理在宿主 Node 内 fetch 回环 127.0.0.1
  // （与 probeHost/tools 同链路），不受 manifest network.allowedHosts 约束（那是对
  // ctx.network.fetch 的外部主机白名单）；已确认宿主 route 层无对 /api/plugins/* 子路径
  // 的额外拦截（仅剥离 surface-session/agent 身份头，与本代理无关）。
  // WebSocket 说明：宿主插件 route 走 `pluginApp.fetch()`（纯 HTTP Request/Response），
  // 无 upgradeWebSocket 接线（chat WS 是单独 route，插件 route 不支持 WS 升级），因此
  // card.js 的 events.mux WebSocket 无法经本代理 route 转发，保持 Node 侧直连（宿主环境
  // 连接非浏览器直连，无 CORS/混合内容问题）。如需 WS 走代理须宿主为插件 route 提供
  // upgrade 通道，属宿主能力缺口，不在本迭代范围。
  app.all(PROXY_PREFIX, (c) => proxyToDsh(c, ctx, port, "/"));
  app.all(PROXY_PREFIX + "/*", (c) => {
    const u = new URL(c.req.url);
    // 剥掉 /web 前缀得到 host 相对路径；剥不掉（异常路径）时兜底到根
    const sub =
      u.pathname.startsWith(PROXY_PREFIX + "/")
        ? u.pathname.slice(PROXY_PREFIX.length) || "/"
        : "/";
    return proxyToDsh(c, ctx, port, sub);
  });
}
