// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/ui/app-shell.js — dsh-hanako App v2 壳页逻辑（main/sidebar 共用；浏览器 ESM）
//
// 相对资源纪律（迁移指南 §10）：经 <script type="module" src="./app-shell.js"> 相对引入，
// 页面内不出现根路径绝对 URL。浏览器 SDK = 官方 @hana/plugin-sdk（devDependencies，
// file:vendor/hana-app-sdk/hana-plugin-sdk-0.0.0.tgz），构建期由 rspack 静态打进本文件（见
// src/ui/rspack.config.mjs）——浏览器 ESM 不解析裸包名（宿主不注入 importmap），所以依赖
// 由打包器 resolve、产物自包含，不在 dist/ui 另放 vendored 拷贝。到本 App 后端路由一律
// hana.api.fetch：宿主在 App surface iframe URL 附 appSurfaceSession query，SDK 注入
// X-Hana-App-Surface-Session header——裸 fetch 会被宿主网关 403 missing_credential
// （真机实测 0.930.1）。受管 runtime iframe 首访透传 appSurfaceSession（宿主按 surface
// 授权并种 hana_app_runtime cookie）。视觉沿袭 v1 webui-shell 纸张风（CSS 变量 +
// fallback 纸张色），数据语义 v2 boot-state（phase idle/starting/ready/error/stopped +
// logTail/logPath）。
import { hana } from "@hana/plugin-sdk";
import { injectDshIndex, installTransport } from "./dsh-inject.js";

(function () {
  "use strict";

  var PHASE_CHIP = { idle: "未启动", starting: "启动中", ready: "就绪", error: "失败", stopped: "已停止" };
  var POLL_FAST_MS = 1500;   // 非就绪：较快轮询（starting 日志滚动）
  var POLL_MID_MS = 3000;    // idle/error：中速
  var POLL_SLOW_MS = 6000;   // 就绪：慢轮询（发现运行态漂移）
  var pollTimer = null;
  var shell = null;          // 根元素（data-dshana-shell）
  var isSidebar = false;

  // ---- 小工具 ----
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
      .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ---- 状态面（hana.api.fetch，surface session 自动注入）----
  function fetchState() {
    return hana.api.fetch("dshana/boot-state", {
      method: "GET", cache: "no-store", headers: { Accept: "application/json" }
    }).then(function (res) {
      if (!res.ok) throw new Error("boot-state HTTP " + res.status);
      return res.json();
    }).then(function (d) { return (d && d.state) || null; })
      .catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        if (/appSurfaceSession/.test(msg)) {
          throw new Error(SURFACE_MISSING);
        }
        throw err;
      });
  }
  function postAction(action) {
    return hana.api.fetch("dshana/" + action, { method: "POST", cache: "no-store" })
      .then(function (res) { return res.json().catch(function () { return {}; }); });
  }

  // ---- App surface 凭据（iframe 不能自定 header，两条路一起走）----
  // 宿主 0.946.2 runtime 代理（bundle ffe/kLt/ELt）认四条：Authorization/query token、
  // 头 X-Hana-App-Surface-Session、cookie hana_app_runtime（HttpOnly，Path 锁在
  // /api/apps/<id>/routes/_runtime/<rid>/）、以及「路径票据」
  //   /api/apps/<id>/routes/_runtime/<rid>/_surface/<appSurfaceSession>/<rest>
  // （宿主按 ffe 解析，并把上游 302 的 Location 重写回同一基路径；官方样例
  //  @hana/plugin-sdk 的 hana.api.url(path, /*authenticateRuntime*/ true) 就是这一形态）。
  // iframe 只认后两条：路径票据让「文档请求自身」就带凭据（不赌 cookie 时序/作用域），
  // cookie 兜住 iframe 内丢掉前缀的绝对路径子请求。
  function surfaceSession() {
    try { return new URLSearchParams(location.search).get("appSurfaceSession"); }
    catch (e) { return null; }
  }
  // 代理前缀 → 带路径票据的前缀（已带则不重复插）
  function withSurfaceTicket(prefix, ss) {
    if (!ss) return prefix;
    var m = /^(\/api\/apps\/[^/]+\/routes\/_runtime\/[^/]+)\/?(.*)$/.exec(prefix);
    if (!m) return prefix;
    if (/^_surface\//.test(m[2])) return prefix;
    return m[1] + "/_surface/" + encodeURIComponent(ss) + "/" + m[2];
  }
  // 同源预请求一次代理前缀：带上 header，宿主会在响应里种下 hana_app_runtime cookie
  // （bundle 109816：`req.query(appSurfaceSession) || req.header(X-Hana-App-Surface-Session)`
  // → Set-Cookie Path=代理前缀；HttpOnly，JS 读不到，只当保险丝用）。
  function warmRuntimeCookie(prefix) {
    var ss = surfaceSession();
    if (!ss) return Promise.resolve(false);
    return fetch(prefix, {
      headers: { "X-Hana-App-Surface-Session": ss },
      cache: "no-store",
      credentials: "same-origin",
    })
      .then(function (r) {
        return r.text().catch(function () { return ""; }).then(function () { return r.ok; });
      })
      .catch(function () { return false; });
  }
  // 受管 runtime iframe URL：代理前缀（带路径票据）+ 视图参数（给 DSH 视图装配）。
  function runtimeUiUrl(prefix) {
    var q = new URLSearchParams();
    var view = shell && shell.getAttribute("data-dshana-view");
    if (view) q.set("dshana-view", view);
    var qs = q.toString();
    var base = withSurfaceTicket(prefix, surfaceSession());
    return base + (qs ? "?" + qs : "");
  }
  // 本页没拿到 surface 会话时的说明（appSurfaceSession 由宿主开页时附在 iframe URL 上）
  var SURFACE_MISSING = "状态读取失败：本页缺少 App surface 会话凭据，请从 Card Center 重新打开本卡";
  function credMissingHtml() {
    return '<div class="card">'
      + '<h2 class="card-label">缺少 App surface 会话凭据</h2>'
      + '<div class="guide"><div class="guide-label">问题</div>'
      + "本页 URL 上没有 appSurfaceSession，DSH 运行时经宿主代理时会被直接拒（missing_credential）。"
      + "状态面（hana.api.fetch）与内嵌视图都拿不到。"
      + "</div>"
      + '<div class="note auto">DSH 已就绪，只是这个页面没凭据。请从 Card Center 重新打开本卡；'
      + "若反复如此，说明这层 surface（功能面板/新窗口）宿主没发凭据，需要改走主卡推送。</div>"
      + "</div>";
  }

  // ---- 视图判定（v2 phase → 壳视图）----
  function viewOf(s) {
    if (!s) return "idle";
    if (s.ready) return "ready";
    if (s.phase === "starting") return "booting";
    if (s.phase === "error" || s.phase === "stopped") return "action";
    return "idle";
  }

  // ---- 时间线片段（预期流程；v2 无细分上报，booting 时全程待命，不假装具体阶段）----
  function timelineHtml() {
    var steps = [
      ["依赖与运行区准备", "首次启动经 pnpm 安装 DSH 依赖（dataDir/runtime）"],
      ["DSH 服务启动", "cordis profile 装载 + 显式端口监听"],
      ["服务就绪确认", "宿主代理 /routes/_runtime/<id>/ 暴露，Web UI 可用"],
    ];
    var html = '<ol class="timeline">';
    for (var i = 0; i < steps.length; i++) {
      html += '<li class="pending"><span class="tl-dot"></span><span class="tl-body">'
        + '<div class="tl-name">' + esc(steps[i][0]) + "</div>"
        + '<div class="tl-desc">' + esc(steps[i][1]) + "</div></span></li>";
    }
    return html + "</ol>";
  }

  function logBlock(lines) {
    var arr = Array.isArray(lines) ? lines : [];
    if (!arr.length) return "";
    return '<pre class="diag-progress" data-log-scroll>' + esc(arr.join("\n")) + "</pre>";
  }

  function metaHtml(s) {
    var bits = [];
    if (s && s.runtimeId) bits.push("runtimeId " + esc(s.runtimeId));
    if (s && s.service && s.service.port) bits.push("port " + esc(String(s.service.port)));
    if (s && s.logPath) bits.push("日志 " + esc(s.logPath));
    return bits.length ? '<p class="meta-line">' + bits.join(" · ") + "</p>" : "";
  }

  // ---- main 视图渲染（boot-panel 容器 innerHTML）----
  function idleViewHtml(s) {
    return '<div class="card">'
      + '<h2 class="card-label">尚未启动</h2>'
      + '<p class="desc">v2 无自动链：DSH 由会话任务（dsh_session create/send）首次调用自动启动；'
      + "也可点下方「启动 DSH」手动预热 Web UI。首次启动含依赖安装，可能需要数分钟。</p>"
      + '<div class="actions"><button class="primary" data-dsh-start>启动 DSH</button></div>'
      + metaHtml(s)
      + "</div>";
  }
  function bootingViewHtml(s) {
    return '<div class="card">'
      + '<h2 class="card-label">正在启动 DSH</h2>'
      + '<p class="desc">受管 runtime 正在拉起（首次含依赖安装与 profile 种子化，可能需要数分钟）。'
      + "就绪后本页自动载入 DSH Web UI。</p>"
      + timelineHtml()
      + logBlock(s && s.logTail)
      + metaHtml(s)
      + "</div>";
  }
  function actionViewHtml(s) {
    var isErr = !s || s.phase === "error";
    var isStop = s && s.phase === "stopped";
    var userText = s && s.error && s.error.userText;
    var code = s && s.error && s.error.code;
    var guide = userText || (isStop ? "DSH 已停止（手动停止或卸载流程触发）。" : "DSH 启动失败，详情如下。");
    var noteText = isErr
      ? "可调整 App 设置（servicePort 换未占用端口 / nodejsPath）后重新启动；依赖区异常时可删除 dataDir/runtime/.runtime-ok 触发重装。"
      : "再次 create/send 或点「启动 DSH」即可重新启动。";
    var raw = [];
    if (code) raw.push("code: " + esc(code));
    if (userText) raw.push("message: " + esc(userText));
    if (s && s.runtimeId) raw.push("runtimeId: " + esc(s.runtimeId));
    if (s && s.service && s.service.port) raw.push("port: " + esc(String(s.service.port)));
    if (s && s.logTail && s.logTail.length) raw.push("最近日志:\n" + esc(s.logTail.slice(-14).join("\n")));
    return '<div class="card">'
      + '<h2 class="card-label">' + (isErr ? "启动失败，需要处理" : "已停止") + "</h2>"
      + '<div class="guide"><div class="guide-label">' + (isErr ? "问题" : "状态") + "</div>"
      + esc(guide) + "</div>"
      + '<div class="note ' + (isErr ? "auto" : "stop") + '">' + esc(noteText) + "</div>"
      + '<div class="actions"><button class="primary" data-dsh-start>重新启动 DSH</button></div>'
      + (raw.length ? "<details class=\"raw-details\"><summary>原始详情</summary>"
        + '<pre class="diag-progress">' + raw.join("\n") + "</pre></details>" : "")
      + metaHtml(s)
      + "</div>";
  }

  // ---- 渲染 ----
  function applySnapshot(s) {
    if (!s) { setStateView("error", "boot-state 无响应"); return; }
    var view = viewOf(s);
    var body = document.body;
    var main = $("[data-dshana-shell]");
    if (!main) return;

    if (isSidebar) { renderSidebar(s, view); return; }

    // main 卡
    var spin = $("#dsh-spin");
    var stage = $("#dsh-stage");
    var frameWrap = $("#frame-wrap");
    var frame = $("#dsh-frame");
    var panel = $("#boot-panel");
    if (view === "ready") {
      if (!surfaceSession()) {
        // DSH 已就绪但本页 URL 没带 appSurfaceSession（宿主没发）：代理对无凭据请求一律
        // 403 missing_credential，下挂 iframe 只会把那段 JSON 画出来。停在 action 视图
        // 把原因写清，不挂 iframe。
        body.setAttribute("data-view", "action");
        if (spin) spin.hidden = true;
        if (frameWrap) frameWrap.hidden = true;
        if (frame) { frame.removeAttribute("src"); frame.hidden = true; }
        if (panel) panel.innerHTML = credMissingHtml();
        schedulePoll(POLL_SLOW_MS);
        return;
      }
      body.setAttribute("data-view", "ready");
      if (spin) spin.hidden = true;
      if (panel) panel.innerHTML = "";
      if (frameWrap) frameWrap.hidden = true;
      if (frame) { frame.removeAttribute("src"); frame.hidden = true; }
      startInjection(s.proxyPrefix);
      schedulePoll(POLL_SLOW_MS);
      return;
    }

    body.setAttribute("data-view", view === "booting" ? "booting" : view === "action" ? "action" : "idle");
    if (spin) spin.hidden = view !== "booting";
    if (frameWrap) frameWrap.hidden = true;
    if (frame) { frame.removeAttribute("src"); frame.hidden = true; }
    if (panel) {
      var html = view === "booting" ? bootingViewHtml(s)
        : view === "action" ? actionViewHtml(s)
          : idleViewHtml(s);
      panel.innerHTML = html;
      var dp = panel.querySelector("[data-log-scroll]");
      if (dp) dp.scrollTop = dp.scrollHeight;
      bindMainActions(s);
    }
    schedulePoll(view === "booting" ? POLL_FAST_MS : POLL_MID_MS);
  }

  // ---- DSH 注入（对齐官方样例：同文档注入 + __DSH_TRANSPORT__，不再用 iframe）----
  // 一次装配：标记视图参数（DSH 侧 view 插件读 ?dshana-view=）→ 装 transport → 取回 DSH
  // index 注入本页。私有前缀 = 中继前缀 + surface 路径票据（DSH 前端经原生 fetch 发出的
  // 请求带不了 header，票据必须在路径里）。
  var injected = { started: false, dispose: null };
  function startInjection(prefix) {
    if (injected.started) return;
    injected.started = true;
    var view = (shell && shell.getAttribute("data-dshana-view")) || "main";
    markViewParam(view);
    var privatePrefix = withSurfaceTicket(prefix, surfaceSession());
    var base = new URL(privatePrefix, location.origin);
    injected.dispose = installTransport(base);
    // 取 index：privatePrefix 已是完整代理路径（含 _surface 票据，宿主路由直认），用原生同源
    // fetch——hana.api.fetch 的入参是「App 路由相对路径」（会再拼 /api/apps/<id>/routes/），
    // 传完整路径会重复前缀 404。
    fetch(privatePrefix + "index.html", { cache: "no-store", credentials: "same-origin" })
      .then(function (r) {
        if (!r.ok) throw new Error("DSH index HTTP " + r.status);
        return r.text();
      })
      .then(function (html) { return injectDshIndex(html, base); })
      .catch(function (err) { showInjectionError(err); });
  }
  // 视图参数写进 URL（DSH 侧 view 插件按 ?dshana-view= 装配；replaceState 不改历史）
  function markViewParam(view) {
    try {
      var u = new URL(location.href);
      if (u.searchParams.get("dshana-view") !== view) {
        u.searchParams.set("dshana-view", view);
        history.replaceState(null, "", u.toString());
      }
    } catch (e) { /* 非标准环境忽略 */ }
  }
  function showInjectionError(err) {
    var msg = (err && err.message) ? err.message : String(err);
    // 不隐藏根：main 的 data-dshana-shell 就在 <body> 上（hidden 会把整页抹白），
    // sidebar 的根就是 .panel。统一用 data-view 回到自举态让错误可见。
    document.body.setAttribute("data-view", "action");
    var panel = $("#boot-panel") || $(".panel");
    if (!panel) { panel = document.createElement("div"); document.body.append(panel); }
    panel.innerHTML = '<div class="card"><h2 class="card-label">DSH 前端注入失败</h2>'
      + '<div class="guide"><div class="guide-label">问题</div>' + esc(msg) + "</div>"
      + '<div class="note auto">DSH 已就绪，但页面装配失败。重开本卡重试；若反复如此，检查中继前缀与 surface 票据。</div></div>';
    schedulePoll(POLL_SLOW_MS);
  }

  function bindMainActions(s) {
    var main = $("[data-dshana-shell]");
    if (!main) return;
    var btnStart = $("[data-dsh-start]", main);
    var btnStop = $("[data-dsh-stop]", main);
    if (btnStart && !btnStart.dataset.bound) {
      btnStart.dataset.bound = "1";
      btnStart.addEventListener("click", function () {
        postAction("start").catch(function (e) {
          setStateView("error", "启动请求失败：" + ((e && e.message) || e));
        });
      });
    }
    if (btnStop && !btnStop.dataset.bound) {
      btnStop.dataset.bound = "1";
      btnStop.addEventListener("click", function () {
        postAction("stop").catch(function (e) {
          setStateView("error", "停止请求失败：" + ((e && e.message) || e));
        });
      });
    }
  }

  // ---- sidebar 紧凑渲染 ----
  function renderSidebar(s, view) {
    var main = $("[data-dshana-shell]");
    main.setAttribute("data-phase", s.phase || "idle");
    var chip = $("[data-dsh-phase]", main);
    if (chip) chip.textContent = PHASE_CHIP[s.phase] || s.phase || "–";
    var detail = $("[data-dsh-detail]", main);
    var meta = $("[data-dsh-meta]", main);
    var logEl = $("[data-dsh-log]", main);
    var frameZone = $("[data-dsh-frame-zone]", main);
    var frame = $("[data-dsh-frame]", main);
    var btnStart = $("[data-dsh-start]", main);
    var btnStop = $("[data-dsh-stop]", main);

    // FP = DSH Web UI 的 sidebar 本体：就绪后整块让给侧栏——本页自带的标题/状态/按钮 chrome
    // （[data-dsh-chrome]）全部收起（DSH sidebar 自带 brand 行，叠一层重复）；未就绪时才露
    // chrome 当占位。data-dsh-ready 同时撤掉 .panel 内边距，iframe 贴边占满。
    var chromeEls = main.querySelectorAll("[data-dsh-chrome]");
    for (var ci = 0; ci < chromeEls.length; ci++) chromeEls[ci].hidden = view === "ready";
    if (view === "ready") main.setAttribute("data-dsh-ready", "1");
    else main.removeAttribute("data-dsh-ready");

    if (view === "ready") {
      if (!surfaceSession()) {
        // FP 页没拿到 surface 会话：侧栏 iframe 同样 403，chrome 留着把原因写在 detail 上
        for (var ck = 0; ck < chromeEls.length; ck++) chromeEls[ck].hidden = false;
        main.removeAttribute("data-dsh-ready");
        if (detail) { detail.textContent = SURFACE_MISSING; detail.classList.add("err"); }
        if (frameZone) frameZone.hidden = true;
        if (frame) { frame.removeAttribute("src"); frame.hidden = true; }
        schedulePoll(POLL_SLOW_MS);
        return;
      }
      if (meta) meta.textContent = "runtime " + (s.runtimeId || "–") + (s.service && s.service.port ? " · port " + s.service.port : "");
      if (logEl) logEl.hidden = true;
      if (frameZone) frameZone.hidden = true;
      if (frame) { frame.removeAttribute("src"); frame.hidden = true; }
      if (btnStart) btnStart.hidden = true;
      if (btnStop) btnStop.hidden = true;
      startInjection(s.proxyPrefix);
      schedulePoll(POLL_SLOW_MS);
      return;
    }
    if (frameZone) frameZone.hidden = true;
    if (frame) { frame.removeAttribute("src"); frame.hidden = true; }
    if (btnStop) btnStop.hidden = true;
    var note = s && s.note ? s.note : "";
    var errTxt = s && s.error && s.error.userText;
    if (view === "action") {
      if (detail) { detail.textContent = (errTxt || note); detail.classList.add("err"); }
      if (btnStart) btnStart.hidden = false;
    } else if (view === "booting") {
      if (detail) { detail.textContent = note; detail.classList.remove("err"); }
      if (btnStart) btnStart.hidden = true;
    } else {
      if (detail) { detail.textContent = note; detail.classList.remove("err"); }
      if (btnStart) btnStart.hidden = false;
    }
    if (meta) {
      var bits = [];
      if (s && s.runtimeId) bits.push("runtime " + s.runtimeId);
      if (s && s.service && s.service.port) bits.push("port " + s.service.port);
      meta.hidden = bits.length === 0;
      meta.textContent = bits.join(" · ");
    }
    if (logEl) {
      var lines = s && s.logTail && s.logTail.length ? s.logTail.slice(-10) : [];
      logEl.hidden = lines.length === 0;
      logEl.textContent = lines.join("\n");
      logEl.scrollTop = logEl.scrollHeight;
    }
    bindSidebarActions();
    schedulePoll(view === "booting" ? POLL_FAST_MS : POLL_MID_MS);
  }
  function bindSidebarActions() {
    var main = $("[data-dshana-shell]");
    if (!main) return;
    var btnStart = $("[data-dsh-start]", main);
    var btnStop = $("[data-dsh-stop]", main);
    if (btnStart && !btnStart.dataset.bound) {
      btnStart.dataset.bound = "1";
      btnStart.addEventListener("click", function () {
        postAction("start").then(function () { poll(); }).catch(function (e) {
          setStateView("error", "启动请求失败：" + ((e && e.message) || e));
        });
      });
    }
    if (btnStop && !btnStop.dataset.bound) {
      btnStop.dataset.bound = "1";
      btnStop.addEventListener("click", function () {
        postAction("stop").then(function () { poll(); }).catch(function (e) {
          setStateView("error", "停止请求失败：" + ((e && e.message) || e));
        });
      });
    }
  }

  function setStateView(_phase, text) {
    var main = $("[data-dshana-shell]");
    if (!main) return;
    var detail = $("[data-dsh-detail]", main) || $("#boot-panel");
    if (detail) detail.textContent = text;
    if (!isSidebar) {
      var spin = $("#dsh-spin");
      if (spin) spin.hidden = true;
      document.body.setAttribute("data-view", "error");
      var panel = $("#boot-panel");
      if (panel) panel.innerHTML = '<div class="card"><h2 class="card-label">无法连接 App 后端路由</h2>'
        + '<p class="desc">' + esc(text) + "</p>"
        + '<p class="muted">请从 Card Center 重新打开本卡以完成 App surface 授权。</p></div>';
    }
    schedulePoll(POLL_SLOW_MS);
  }

  function schedulePoll(ms) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ms);
  }
  function poll() {
    fetchState().then(function (s) { applySnapshot(s); })
      .catch(function (err) {
        setStateView("error", (err && err.message) || String(err));
      });
  }

  // ---- 壳桥：主题 + 剪贴板（内层 DSH Web UI 的 v1 契约应答）----
  var THEME_VARS = [
    ["--bg", "#F5EFE4"], ["--bg-card", "#FBF7EE"], ["--sidebar-bg", "#EFE8DB"],
    ["--text", "#2A2622"], ["--text-light", "#4A433C"], ["--text-muted", "#6B6158"],
    ["--accent", "#537D96"], ["--accent-hover", "#3F6179"],
    ["--border", "#D8CFBE"], ["--green", "#4A6B4A"], ["--danger", "#8B2C1F"],
    ["--overlay-strong", "rgba(42,38,34,0.15)"], ["--overlay-medium", "rgba(42,38,34,0.08)"],
    ["--user-bg", "rgba(83,125,150,0.08)"], ["--accent-light", "rgba(83,125,150,0.08)"],
  ];
  function readThemeVars() {
    var cs = getComputedStyle(document.documentElement);
    var out = {};
    for (var i = 0; i < THEME_VARS.length; i++) {
      var name = THEME_VARS[i][0];
      var val = cs.getPropertyValue(name).trim();
      out[name] = val || THEME_VARS[i][1];
    }
    try {
      out.themeId = new URLSearchParams(location.search).get("hana-theme") || "inherit";
    } catch (e) { out.themeId = "inherit"; }
    return out;
  }
  function sendThemeTo(dst) {
    var msg = { dshHanaTheme: readThemeVars() };
    try { dst.postMessage(msg, "*"); } catch (e) { /* 目标不可达忽略 */ }
  }
  function frameWindow() {
    var main = $("[data-dshana-shell]");
    var f = isSidebar ? $("[data-dsh-frame]", main) : $("#dsh-frame");
    return f && !f.hidden ? f.contentWindow : null;
  }
  window.addEventListener("message", function (e) {
    var data = e.data;
    if (!data || typeof data !== "object") return;
    if (data.dshHanaThemeRequest) { try { sendThemeTo(e.source); } catch (err) { /* 忽略 */ } }
    if (data.__dshCopy) {
      writeClipboard(typeof data.text === "string" ? data.text : "").then(function (ok) {
        try {
          if (data.port2 && data.port2.postMessage) data.port2.postMessage({ __dshCopyResult: { ok: ok } });
          else if (e.ports && e.ports[0]) e.ports[0].postMessage({ __dshCopyResult: { ok: ok } });
        } catch (err) { /* 忽略 */ }
      });
    }
  });
  // 复制必须走宿主能力门（app/ui.clipboard-write）：iframe 内由 postMessage 触发的复制没有
  // 用户手势，navigator.clipboard 与 document.execCommand 都会被拒——v1 真机实测过，那两条
  // 兜底全是白写，故不再保留。SDK 侧 hana.clipboard.writeText 失败会 reject。
  function writeClipboard(text) {
    if (!hana || !hana.clipboard || typeof hana.clipboard.writeText !== "function") {
      return Promise.resolve(false);
    }
    return Promise.resolve(hana.clipboard.writeText(text)).then(
      function (payload) { return !(payload && payload.ok === false); },
      function () { return false; }
    );
  }
  // 主题跟随：SDK 主题订阅（宿主变更 → 推送内层）+ 定时兜底推送（frame 存在时）
  var themePushTimer = null;
  function startThemePush() {
    var cw = frameWindow();
    if (!cw) return;
    sendThemeTo(cw);
    clearInterval(themePushTimer);
    themePushTimer = setInterval(function () {
      var w = frameWindow();
      if (w) sendThemeTo(w);
      else { clearInterval(themePushTimer); themePushTimer = null; }
    }, 2000);
  }
  try {
    if (hana && typeof hana.theme.subscribe === "function") {
      hana.theme.subscribe(function () { startThemePush(); });
    }
  } catch (e) { /* SDK 主题订阅不可用则只走定时推送 */ }

  // ---- 启动 ----
  function boot() {
    var root = $("[data-dshana-shell]");
    if (!root) return;
    shell = root;
    isSidebar = root.getAttribute("data-dshana-view") === "sidebar";
    // 宿主握手（对齐官方样例 hana-dsh 的 bootstrap：页面挂载即 hana.ready()，宿主据此
    // 确认本页已接管；payload 省略——本 App 无额外就绪声明）。
    try { if (hana && typeof hana.ready === "function") hana.ready(); } catch (e) { /* 宿主未提供则忽略 */ }
    // 卸载释放注入的 transport（WS 载体等）
    window.addEventListener("pagehide", function () {
      if (injected.dispose) { try { injected.dispose(); } catch (e) { /* 忽略 */ } }
    }, { once: true });
    // 就绪后定时向 iframe 推主题（render 每轮也会触发一次首推）
    var obs = setInterval(function () {
      if (document.body.getAttribute("data-view") === "ready" || (isSidebar && frameWindow())) {
        startThemePush();
      }
      if (document.body.getAttribute("data-view") !== "ready" && !isSidebar) {
        clearInterval(obs);
      }
    }, 1500);
    poll();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
