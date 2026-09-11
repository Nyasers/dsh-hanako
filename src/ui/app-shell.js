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
// fallback 纸张色），数据语义 v2 boot-state（phase idle/starting/ready/error/stopped）。
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
    try {
      var q = new URLSearchParams(location.search).get("appSurfaceSession");
      if (q) return q;
      // 宿主 FP / 主卡的 iframe 用的是**路径票据**形态（functionPanel.routeUrl 经
      // /api/apps/iframe-ticket 换回 uiBasePath，票据在路径里），不会带我们的查询参数；
      // 只认查询参数会把这类页面判成「缺少凭据」。这里也认路径形态。
      var m = /\/_surface\/([^\/]+)\//.exec(location.pathname || "");
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
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
  // 本页没拿到 surface 会话时的说明（appSurfaceSession 由宿主开页时附在 surface URL 上）
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

  // 台面上唯一那行小字（官方 loading 里 “Loading plugins…” 的对应物）；细节一律进 #boot-panel。
  function statusText(view, s) {
    if (view === "booting") return "正在启动 DSH…";
    if (view === "idle") return "DSH 未启动";
    if (view === "action") {
      var t = (s && s.error && s.error.userText) || (s && s.note) || "";
      t = String(t).split("\n")[0].slice(0, 120);
      if (t) return t;
      return s && s.phase === "stopped" ? "DSH 已停止" : "启动失败，需要处理";
    }
    return "";
  }

  // ---- 时间线片段（预期流程；v2 无细分上报，booting 时全程待命，不假装具体阶段）----
  function timelineHtml() {
    var steps = [
      ["运行区与 profile 准备", "受管 runtime 拉起 + profile 种子化（依赖随包，无需安装）"],
      ["DSH 服务启动", "cordis profile 装载 + 本地端口监听"],
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
    return bits.length ? '<p class="meta-line">' + bits.join(" · ") + "</p>" : "";
  }

  // ---- main 视图渲染（boot-panel 容器 innerHTML）----
  function idleViewHtml(s) {
    return '<div class="card">'
      + '<h2 class="card-label">尚未启动</h2>'
      + '<p class="desc">App 加载后会自动拉起 DSH 受管 runtime；也可点下方「启动 DSH」手动触发。'
      + "就绪后本页自动载入 DSH Web UI。</p>"
      + '<div class="actions"><button class="primary" data-dsh-start>启动 DSH</button></div>'
      + metaHtml(s)
      + "</div>";
  }
  function bootingViewHtml(s) {
    // 启动中台面上只留 loader，诊断收进折叠区：启动卡住时展开看时间线/日志尾。
    return '<details class="raw-details"><summary>启动详情</summary>'
      + '<p class="desc">受管 runtime 正在拉起（profile 种子化 + 服务监听）。'
      + "就绪后本页自动载入 DSH Web UI。</p>"
      + timelineHtml()
      + logBlock(s && s.logTail)
      + metaHtml(s)
      + "</details>";
  }
  function actionViewHtml(s) {
    var isErr = !s || s.phase === "error";
    var isStop = s && s.phase === "stopped";
    var userText = s && s.error && s.error.userText;
    var code = s && s.error && s.error.code;
    var guide = userText || (isStop ? "DSH 已停止（手动停止或卸载流程触发）。" : "DSH 启动失败，详情如下。");
    var noteText = isErr
      ? "可点「启动 DSH」重试；端口被占用会自动换端口。持续失败请看下方详情与日志。"
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
    var status = $("#dsh-status");
    var panel = $("#boot-panel");
    if (view === "ready") {
      if (!surfaceSession()) {
        // DSH 已就绪但本页 URL 没带 appSurfaceSession（宿主没发）：代理对无凭据请求一律
        // 403 missing_credential。停在 action 视图，把原因写清。
        body.setAttribute("data-view", "action");
        if (spin) spin.hidden = true;
        if (status) status.textContent = "缺少 App surface 会话凭据";
        if (panel) panel.innerHTML = credMissingHtml();
        schedulePoll(POLL_SLOW_MS);
        return;
      }
      body.setAttribute("data-view", "ready");
      if (spin) spin.hidden = true;
      if (panel) panel.innerHTML = "";
      startInjection(s.proxyPrefix);
      schedulePoll(POLL_SLOW_MS);
      return;
    }

    body.setAttribute("data-view", view === "booting" ? "booting" : view === "action" ? "action" : "idle");
    if (spin) spin.hidden = view !== "booting";
    if (status) status.textContent = statusText(view, s);
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

  // ---- 跨面共享状态（样例 src/ui/settings/view-state.ts 的同一语义，载体换成 App 全局存储）----
  // 两个消费方：设置视图（FP 齿轮点开 → 主卡开面板）与会话选中（FP 点会话 → 主卡跟随）。
  // 作用域：我们单 DSH 源，只按**卡片实例**配对（宿主文档：主卡与其 FP 具有同一 cardInstanceId）；
  // 样例额外按 sourceId 分域，单源下不需要，日后多源时再补。
  // 键在调用时才算：context 可能后到，算早了会拼出错误作用域。
  function cardInstanceIdOf() {
    try {
      var c = hana && hana.surface && typeof hana.surface.getContext === "function" ? hana.surface.getContext() : null;
      return c && typeof c.cardInstanceId === "string" && c.cardInstanceId ? c.cardInstanceId : null;
    } catch (e) { return null; }
  }
  function sharedKey(kind) {
    return "dshana.card." + (cardInstanceIdOf() || "unknown") + "." + kind;
  }
  // storage.global 在 SDK 里即可调用对象、也可能是工厂（两边兼容地取）。
  function sharedStore() {
    try {
      var g = hana && hana.storage ? hana.storage.global : null;
      if (typeof g === "function") { var s = g(); if (s && typeof s.get === "function") return s; }
      if (g && typeof g.get === "function") return g;
    } catch (e) { /* 忽略 */ }
    return null;
  }
  function readShared(kind) {
    var st = sharedStore();
    if (!st) return Promise.resolve(null);
    return Promise.resolve(st.get(sharedKey(kind))).then(function (entry) {
      var v = entry && typeof entry === "object" ? entry.value : null;
      return v && typeof v === "object" ? v : null;
    }, function () { return null; });
  }
  function writeShared(kind, value) {
    var st = sharedStore();
    if (!st) return Promise.reject(new Error("hana.storage.global \u4e0d\u53ef\u7528"));
    return Promise.resolve(st.set(sharedKey(kind), value));
  }
  function onSharedChanged(kind, listener) {
    var st = sharedStore();
    if (!st || typeof st.onChanged !== "function") return function () { /* 无通知面则只靠读时刷新 */ };
    var key = sharedKey(kind);
    var off = st.onChanged(function (keys) {
      if (Array.isArray(keys) && keys.indexOf(key) >= 0) { try { listener(); } catch (e) { /* 忽略 */ } }
    });
    return typeof off === "function" ? off : function () { /* 无取消句柄 */ };
  }

  // 设置视图：{ open, section }。
  function readSettingsView() {
    return readShared("settings-view").then(function (v) {
      return {
        open: !!(v && v.open === true),
        section: v && typeof v.section === "string" && v.section ? v.section : null,
      };
    });
  }
  function writeSettingsView(next) {
    var open = !!(next && next.open === true);
    var section = next && typeof next.section === "string" && next.section ? next.section : null;
    return writeShared("settings-view", { open: open, section: section });
  }

  // 会话选中：{ sessionId }。启动握手靠读快照（存储有当前值，没有“错过广播”的问题）。
  function readSelection() {
    return readShared("selection").then(function (v) {
      return { sessionId: v && typeof v.sessionId === "string" && v.sessionId ? v.sessionId : null };
    });
  }
  function writeSelection(sessionId) {
    return writeShared("selection", {
      sessionId: typeof sessionId === "string" && sessionId ? sessionId : null,
    });
  }

  // 挂到宿主桥（__DSHANA__）上的跨面接口：
  //   设置视图 → src-integrations/ui-settings-general；会话选中 → src-integrations/ui-session。
  var SURFACE_API = {
    readSettingsView: readSettingsView,
    writeSettingsView: writeSettingsView,
    onSettingsViewChanged: function (listener) { return onSharedChanged("settings-view", listener); },
    readSelection: readSelection,
    writeSelection: writeSelection,
    onSelectionChanged: function (listener) { return onSharedChanged("selection", listener); },
  };

  // ---- DSH 注入（对齐官方样例：同文档注入 + __DSH_TRANSPORT__，不再用 iframe）----
  // 一次装配：标记视图参数（DSH 侧 view 插件读 ?dshana-view=）→ 装 transport → 取回 DSH
  // index 注入本页。私有前缀 = 中继前缀 + surface 路径票据（DSH 前端经原生 fetch 发出的
  // 请求带不了 header，票据必须在路径里）。
  var injected = { started: false, dispose: null };
  function startInjection(prefix) {
    if (injected.started) return;
    injected.started = true;
    var view = resolveView(shell);
    var privatePrefix = withSurfaceTicket(prefix, surfaceSession());
    var base = new URL(privatePrefix, location.origin);
    injected.dispose = installTransport(base, {
      role: view === "sidebar" ? "navigation" : "workspace",
      bridge: SURFACE_API,
    });
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
  // 注：原先这里有个 readIndexThemePreference()（从 index 的 boot-theme 行抽 dsh 偏好）。
  // 偏好已改由 ui-layout 的 presenter 投影到 html 属性、DSH 内桥自己观察（见文件头三段分工），
  // 壳页不再转发，故该函数退役。
  // 旧的 ?dshana-view= 参数已退役（2026-09-12）：它唯一的消费者是 @dsh-hanako/view 客户端插件，
  // 而该插件已不在册（官方 ui-layout 放开后就成对换回了）；正式路径读的是 __DSHANA__.role，
  // 而 role 的事实源是页面自己的声明（meta / 壳属性）。故不再改写当前 URL。
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
    var btnStart = $("[data-dsh-start]", main);
    var btnStop = $("[data-dsh-stop]", main);

    // FP = DSH Web UI 的 sidebar 本体：就绪后整块让给侧栏——本页自带的标题/状态/按钮 chrome
    // （[data-dsh-chrome]）全部收起（DSH sidebar 自带 brand 行，叠一层重复）；未就绪时才露
    // chrome 当占位。data-dsh-ready 同时撤掉 .panel 内边距。
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
        schedulePoll(POLL_SLOW_MS);
        return;
      }
      if (meta) meta.textContent = "runtime " + (s.runtimeId || "–") + (s.service && s.service.port ? " · port " + s.service.port : "");
      if (logEl) logEl.hidden = true;
      if (btnStart) btnStart.hidden = true;
      if (btnStop) btnStop.hidden = true;
      startInjection(s.proxyPrefix);
      schedulePoll(POLL_SLOW_MS);
      return;
    }
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
  // 只传宿主当前的真实值：**不做固定值兜底**（拿不到就传空，桥会跳过空值 → DSH 保持内置 token）。
  // 制造用户没选过的颜色比不跟随更糟：样例 README 原话是 “A failed swap keeps the current
  // theme rather than falling back to a built-in palette”。
  var THEME_VARS = [
    "--bg", "--bg-card", "--sidebar-bg", "--text", "--text-light", "--text-muted",
    "--accent", "--accent-hover", "--accent-light", "--border", "--green", "--danger",
    "--overlay-strong", "--overlay-medium", "--user-bg",
  ];
  function readThemeVars() {
    var cs = getComputedStyle(document.documentElement);
    var out = {};
    for (var i = 0; i < THEME_VARS.length; i++) {
      var name = THEME_VARS[i];
      out[name] = cs.getPropertyValue(name).trim();
    }
    try {
      out.themeId = new URLSearchParams(location.search).get("hana-theme") || "inherit";
    } catch (e) { out.themeId = "inherit"; }
    return out;
  }
  function sendThemeTo(dst) {
    var msg = { dshHanaTheme: { vars: readThemeVars() } };
    try { dst.postMessage(msg, "*"); } catch (e) { /* 目标不可达忽略 */ }
  }
  // 同文档注入形态（当前主路径）：主题桥就在本页里，向本窗口广播即可被它收到。
  // 为什么必须由壳页主动推：桥发的 dshHanaThemeRequest 走的是 parent.postMessage，而
  // 同文档注入后本页的 parent 是**宿主**而不是壳页，那个请求到不了这里，壳也就没机会回
  // ——这就是主卡 / FP 主题不跟随的原因（旧 iframe 形态下 parent 恰好是壳页，才一直正常）。
  function pushThemeToSelf() {
    try { window.postMessage({ dshHanaTheme: { vars: readThemeVars() } }, "*"); } catch (e) { /* 忽略 */ }
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
  // 主题跟随（**事件驱动，不轮询**）：宿主主题变化由 SDK 通知（事件名 hana.theme.changed，
  // 常量见 @hana/plugin-protocol 的 THEME_CHANGED），SDK 侧即 hana.theme.subscribe；
  // 当前主题的官方读法是 hana.theme.getSnapshot()。SDK README 另写明：重绘本身由 SDK
  // 完成（“the repaint happens without this”），订阅只是给需要跟着做别的事的插件用——
  // 我们属于后者（要把变量转成 DSH token 告知内层），所以变化时推一次就够，无定时推送。
  function pushThemeNow() {
    pushThemeToSelf();
  }
  // 宿主主题（宿主的原生能力，取代我们自补的一切）：
  //   宿主经 App surface iframe 的 URL 参数给 hana-theme / hana-css / hana-theme-appearance，
  //   变更再经 hana.theme.changed 推同一组值（SDK hana.theme.subscribe 已有快照）。
  //   契约：**App 自己把宿主主题贴进自己的文档**（官方样例 SDK 的 followHostTheme：
  //   fetch cssUrl → <style data-hana-theme-style>），宿主不代劳。
  //   此前我们只读 getComputedStyle(documentElement) 却从没加载过主题样式表——读到的永远是
  //   空值，页面一路吃 HTML 里的纸张 fallback（var(--bg, #F5EFE4)），所以连 loading 壳页也
  //   不跟随（真机反馈 2026-09-12）。修完这条，壳页、注入的 DSH UI、以及主题桥读到的变量
  //   才会是真实的 Hana 配色。
  var THEME_STYLE_ATTR = "data-hana-theme-style";
  var themeCssUrl = null;
  // 注：dsh 自己的主题偏好（system/light/dark）**不由壳页判断**——它是 DSH 侧的事实
  // （宿主主题 API 里也没有它）。现由 ui-layout 的 presenter 投影到
  // html[data-dsh-theme-preference]，DSH 内的主题桥直接观察该属性决定是否跟随。
  // 壳页在这里只负责一件事：维持宿主主题变量（样式表）。
  function applyThemeCss(cssUrl) {
    if (typeof cssUrl !== "string" || !cssUrl) return;
    themeCssUrl = cssUrl;
    fetch(cssUrl, { credentials: "same-origin", cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("theme.css HTTP " + res.status);
      return res.text();
    }).then(function (css) {
      if (themeCssUrl !== cssUrl) return; // 期间主题又变了，等新的那次落地
      var el = document.querySelector("style[" + THEME_STYLE_ATTR + "]");
      if (!el) {
        el = document.createElement("style");
        el.setAttribute(THEME_STYLE_ATTR, "");
        (document.head || document.documentElement).appendChild(el);
      }
      if (el.textContent !== css) el.textContent = css;
      // CSS 落地后立即再推一次：属性变化通知会早于样式表到位，桥那一刻读到的还是旧值。
      try { pushThemeNow(); } catch (e) { /* 忽略 */ }
    }).catch(function (err) {
      // 主题拿不到不致命：页面仍用 HTML 里写好的纸张 fallback 色。
      try { console.warn("[dshana] 宿主主题样式表加载失败", err && err.message ? err.message : err); } catch (e) { /* 忽略 */ }
    });
  }
  function applyHostTheme(snap) {
    if (!snap || typeof snap !== "object") return;
    var themeId = typeof snap.theme === "string" && snap.theme ? snap.theme : null;
    var appearance = snap.appearance === "light" || snap.appearance === "dark" ? snap.appearance : null;
    try {
      var root = document.documentElement;
      if (themeId) root.setAttribute("data-theme", themeId);
      if (appearance) root.setAttribute("data-appearance", appearance);
      else root.removeAttribute("data-appearance");
    } catch (e) { /* 忽略 */ }
    applyThemeCss(snap.cssUrl);
  }
  // 首屏主题：官方读法 hana.theme.getSnapshot()（宿主报过来的实况）；
  // 拿不到再退 URL 参数（宿主白名单参数名）。
  try {
    var themeSnap = hana && hana.theme && typeof hana.theme.getSnapshot === "function" ? hana.theme.getSnapshot() : null;
    if (themeSnap) applyHostTheme(themeSnap);
  } catch (e) { /* 忽略 */ }
  try {
    var themeParams = new URLSearchParams(location.search);
    if (themeParams.get("hana-css") || themeParams.get("hana-theme")) {
      applyHostTheme({
        theme: themeParams.get("hana-theme"),
        cssUrl: themeParams.get("hana-css"),
        appearance: themeParams.get("hana-theme-appearance"),
      });
    }
  } catch (e) { /* 忽略 */ }
  try {
    if (hana && hana.theme && typeof hana.theme.subscribe === "function") {
      hana.theme.subscribe(function (snap) { applyHostTheme(snap); pushThemeNow(); });
    }
  } catch (e) { /* SDK 主题订阅不可用则只靠首屏那一次 */ }

  // ---- 认面：页面自己声明为准，宿主 slot 只作兜底 ----
  // 与样例 hana-dsh 同一姿势："我是哪个面"写在**页面自己身上**（样例用 <meta name="hana-dsh-role">，
  // 我们用 <meta name="hana-dshana-role"> + 壳属性 data-dshana-view）。
  // 为什么不反过来靠宿主：宿主把本页挂进 FP 用的是 functionPanel.routeUrl，不带我们的任何参数；
  // 而 hostSlot() 可能报 page / widget 这类广义值，比静态声明更不确定。
  var SLOT_VIEW = { "card": "main", "function-panel": "sidebar", "settings": "settings" };
  function hostSlot() {
    try {
      if (!hana || !hana.surface || typeof hana.surface.getContext !== "function") return null;
      var c = hana.surface.getContext();
      return c && typeof c.slot === "string" ? c.slot : null;
    } catch (e) { return null; }
  }
  function declaredView(root) {
    try {
      var m = document.querySelector('meta[name="hana-dshana-role"]');
      var v = m && m.getAttribute("content");
      if (v === "main" || v === "sidebar" || v === "settings") return v;
    } catch (e) { /* 忽略 */ }
    var a = root && root.getAttribute("data-dshana-view");
    return a === "main" || a === "sidebar" || a === "settings" ? a : null;
  }
  function resolveView(root) {
    return declaredView(root) || SLOT_VIEW[hostSlot() || ""] || "main";
  }

  // ---- 启动 ----
  function boot() {
    var root = $("[data-dshana-shell]");
    if (!root) return;
    shell = root;
    // 宿主握手（对齐官方样例 hana-dsh 的 bootstrap：页面挂载即 hana.ready()，宿主据此
    // 确认本页已接管；payload 省略——本 App 无额外就绪声明）。
    try { if (hana && typeof hana.ready === "function") hana.ready(); } catch (e) { /* 宿主未提供则忽略 */ }
    var began = false;
    function begin() {
      if (began) return;
      began = true;
      isSidebar = resolveView(root) === "sidebar";
      // 卸载释放注入的 transport（WS 载体等）
      window.addEventListener("pagehide", function () {
        if (injected.dispose) { try { injected.dispose(); } catch (e) { /* 忽略 */ } }
      }, { once: true });
      // 主题不再定时推送（原有一个 1.5s 轮询，只为等“壳页就绪后再推”）：首屏由
      // getSnapshot()+URL 参数落地，注入完成后在 startInjection 的完成回调里推一次，
      // 此后完全由 hana.theme.subscribe（hana.theme.changed）事件驱动。
      poll();
    }
    // 等宿主交面（样例协议）：已有 context 立即开始；否则订一次变更事件，并留 1.5s 兜底
    // （自己在浏览器里开页调试时宿主不会给 context）。
    if (hostSlot() !== null) { begin(); return; }
    try {
      if (hana && hana.surface && typeof hana.surface.onContextChanged === "function") {
        var off = hana.surface.onContextChanged(function (next) {
          var slot = next && typeof next.slot === "string" ? next.slot : null;
          if (!slot) return;
          try { if (typeof off === "function") off(); } catch (e) { /* 忽略 */ }
          begin();
        });
      }
    } catch (e) { /* SDK 未提供则只走兜底 */ }
    setTimeout(begin, 1500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
