// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/ui/app-shell.ts — dshana App v2 壳页逻辑（main/sidebar 共用；浏览器 ESM）
//
// 相对资源纪律：经 <script type="module" src="./app-shell.js"> 相对引入，
// 页面内不出现根路径绝对 URL。浏览器 SDK = 官方 @hana/plugin-sdk（devDependencies，
// file:vendor/hana-app-sdk/hana-plugin-sdk-0.0.0.tgz），构建期由 rspack 静态打进本文件（见
// src/ui/rspack.config.mts）——浏览器 ESM 不解析裸包名（宿主不注入 importmap），所以依赖
// 由打包器 resolve、产物自包含，不在 dist/ui 另放 vendored 拷贝。到本 App 后端路由一律
// hana.api.fetch：宿主在 App surface iframe URL 附 appSurfaceSession query，SDK 注入
// X-Hana-App-Surface-Session header——裸 fetch 会被宿主网关 403 missing_credential
// （真机实测）。受管 runtime iframe 首访透传 appSurfaceSession（宿主按 surface
// 授权并种 hana_app_runtime cookie）。视觉沿袭 v1 webui-shell 纸张风（CSS 变量 +
// fallback 纸张色），数据语义 v2 boot-state（phase idle/starting/ready/error/stopped）。
import { hana } from "@hana/plugin-sdk";
import { injectDshIndex, installTransport } from "#/ui/dsh-inject.ts";

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
  function $(sel, root = document) { return (root || document).querySelector(sel); }
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
    return '<pre class="diag-progress">缺少 App surface 会话凭据：本页 URL 上没有 appSurfaceSession，\n'
      + "DSH 运行时经宿主代理会被直接拒（missing_credential），状态面与内嵌视图都拿不到。\n"
      + "请从 Card Center 重新打开本卡。</pre>";
  }

  // ---- 视图判定（v2 phase → 壳视图）----
  function viewOf(s) {
    if (!s) return "idle";
    if (s.ready) return "ready";
    if (s.phase === "starting") return "booting";
    if (s.phase === "error" || s.phase === "stopped") return "action";
    return "idle";
  }

  // 台面上唯一那行小字：只报状态（报错内容在下方 <pre> 里，不在这里重复）。
  function statusText(view, s) {
    if (view === "booting") return "正在启动 DSH…";
    if (view === "idle") return "DSH 未启动";
    if (view === "action") return s && s.phase === "stopped" ? "DSH 已停止" : "启动失败";
    return "";
  }

  // ---- main 视图渲染（#boot-panel innerHTML）----
  // 只有两件东西值得占版面：启动按钮，和报错时那块 <pre>。时间线与折叠详情都撤了。
  // ---- 页面打开时补一次启动：轮询不会重试，打开页面至少该重试一次 ----
  // 为何放在壳页：App 进程里的退避重试可能早已用尽/被冻结（装完时那次失败常常发生在 App 被
  // 批准之前——进程根本没在跑）。用户打开页面是最强的一次“我要用它”信号，此刻补一脚；服务端
  // single-flight，重复调用无害（未就绪才动手，ready/starting 时接口自己会答 already-ready）。
  // 只针对 idle / error：stopped 是用户主动停的，不替他复活。每页只踢一次。
  var kickedOnLoad = false;
  function kickStartIfNeeded(s) {
    if (kickedOnLoad || !s) return;
    var phase = s.phase || "idle";
    if (phase !== "idle" && phase !== "error") return;
    kickedOnLoad = true;
    var st = $("#dsh-status");
    if (st && phase === "error") st.textContent = "启动失败，正在重试…";
    postAction("start").then(function () { poll(true); }).catch(function () { /* 忽略：状态面会显示 */ });
  }

  // 免交互：DSH 的拉起由 App 的自动链负责（apply 即 ensureManagedRuntime +
  // 崩溃重起 + 端口占用自动换端口），页面不提供「启动 / 重启」按钮——那是让用户替系统干活。
  // 页面只负责说清当前状态（状态行 + 出错时的 <pre>）。
  function idleViewHtml(s) {
    return "";
  }
  function bootingViewHtml(s) {
    return ""; // 启动中台面只有 loader + 状态行
  }
  function actionViewHtml(s) {
    var raw = [];
    if (s && s.error && s.error.code) raw.push("code: " + s.error.code);
    if (s && s.error && s.error.userText) raw.push("message: " + s.error.userText);
    if (s && s.note) raw.push("note: " + s.note);
    if (s && s.runtimeId) raw.push("runtimeId: " + s.runtimeId);
    if (s && s.service && s.service.port) raw.push("port: " + s.service.port);
    if (s && s.logTail && s.logTail.length) raw.push("最近日志:\n" + s.logTail.slice(-14).join("\n"));
    // 只报错、不给按钮：自动链会自己重试（换端口 / 崩溃重起），用户插手反而是多余路径。
    return raw.length ? '<pre class="diag-progress" data-log-scroll>' + esc(raw.join("\n")) + "</pre>" : "";
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
    kickStartIfNeeded(s);
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

  // 会话选中：{ sessionId, at }。at 是写入时刻，接收端据此判断这条意见是否比自己的动手新
  // （主卡自己切工作区/新建会话也会改本地选中，旧意见不得把它压回去）。
  // 启动握手靠读快照（存储有当前值，没有“错过广播”的问题）。
  function readSelection() {
    return readShared("selection").then(function (v) {
      return {
        sessionId: v && typeof v.sessionId === "string" && v.sessionId ? v.sessionId : null,
        at: v && typeof v.at === "number" ? v.at : 0,
      };
    });
  }
  function writeSelection(sessionId) {
    return writeShared("selection", {
      sessionId: typeof sessionId === "string" && sessionId ? sessionId : null,
      at: Date.now(),
    });
  }

  // 挂到宿主桥（__DSHANA__）上的跨面接口：
  //   设置视图 → src-integrations/ui-settings-general；会话选中 → src-integrations/ui-session；
  //   剪贴板 → @dshana/clipboard 的 client 半（同文档，直接调，无消息协议）。
  var SURFACE_API = {
    readSettingsView: readSettingsView,
    writeSettingsView: writeSettingsView,
    onSettingsViewChanged: function (listener) { return onSharedChanged("settings-view", listener); },
    readSelection: readSelection,
    writeSelection: writeSelection,
    onSelectionChanged: function (listener) { return onSharedChanged("selection", listener); },
    clipboardWrite: writeClipboard,
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
      // 面 → DSH 侧上游角色词：sidebar（FP）= navigation（只有侧栏）；
      // default（full / 拆窗）= standalone（整幅 DSH UI，可折叠）；main 与 settings = workspace
      // （中列 + 右列，无 DSH 侧栏）。
      role: view === "sidebar" ? "navigation" : view === "default" ? "standalone" : "workspace",
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
      .then(function (html) {
        // 先取走 boot-theme 行的偏好再注入：桥在 index 解析时就跑，它要立刻知道门开不开。
        dshPreference = readIndexThemePreference(html);
        return injectDshIndex(html, base);
      })
      // 注入完成后推一次（桥此刻已在文档里）；再开标题栏交互区域的上报。此后主题完全由
      // hana.theme.subscribe 事件驱动。
      .then(function () { pushThemeNow(); startInteractiveRegions(); })
      .catch(function (err) { showInjectionError(err); });
  }
  // DSH index 的 boot-theme 行（ui-theme/src/boot-theme.ts 生成，紧跟 <body> 开标签）：
  //   const preference = "system"|"light"|"dark"
  // 官方把这行定位成 "the browser's pre-plugin interval"：插件树激活前浏览器手里只有它，
  // 之后 ui-layout 的 ThemePresenter 接管同一批 DOM 字段。我们读同一处，把偏好随主题载荷
  // 一起交给桥——于是「插件加载之前」就能决定跟不跟随，不必等我们 DSH 侧的 client 半
  // （那是插件，加载晚）。权威归属不变：桥的 readPreference() 优先 client 半投影的属性，
  // 本值只在属性出现前充数。
  // 注：壳页读的只是**启动那一段**——DSH 自己写在 index 里的字面量，不是壳页的意见。
  var dshPreference = null;
  function readIndexThemePreference(html) {
    var m = /const\s+preference\s*=\s*"([^"]+)"/.exec(String(html || ""));
    return m && /^(system|light|dark)$/.test(m[1]) ? m[1] : null;
  }
  // 不读旧 URL 参数：正式路径是 __DSHANA__.role，而 role 的事实源是页面自己的声明
  // （meta / 壳属性）。
  function showInjectionError(err) {
    var msg = (err && err.message) ? err.message : String(err);
    // 不隐藏根：main 的 data-dshana-shell 就在 <body> 上（hidden 会把整页抹白），
    // sidebar 的根就是 .panel。统一用 data-view 回到自举态让错误可见。
    document.body.setAttribute("data-view", "action");
    var status = $("#dsh-status");
    if (status) status.textContent = "DSH 前端注入失败";
    var panel = $("#boot-panel") || $(".panel");
    if (!panel) { panel = document.createElement("div"); document.body.append(panel); }
    panel.innerHTML = '<pre class="diag-progress">DSH 前端注入失败：' + esc(msg)
      + "\nDSH 已就绪，但页面装配失败。重开本卡重试；若反复如此，检查中继前缀与 surface 票据。</pre>";
    schedulePoll(POLL_SLOW_MS);
  }

  function bindMainActions(s) {
    var main = $("[data-dshana-shell]");
    if (!main) return;
    var btnStop = $("[data-dsh-stop]", main);
    if (btnStop && !btnStop.dataset.bound) {
      btnStop.dataset.bound = "1";
      btnStop.addEventListener("click", function () {
        postAction("stop").then(function () { poll(true); }).catch(function (e) {
          setStateView("error", "停止请求失败：" + ((e && e.message) || e));
        });
      });
    }
  }

  // ---- sidebar 紧凑渲染 ----
  function renderSidebar(s, view) {
    var main = $("[data-dshana-shell]");
    if (main) kickStartIfNeeded(s);
    main.setAttribute("data-phase", s.phase || "idle");
    var chip = $("[data-dsh-phase]", main);
    if (chip) chip.textContent = PHASE_CHIP[s.phase] || s.phase || "–";
    var detail = $("[data-dsh-detail]", main);
    var meta = $("[data-dsh-meta]", main);
    var logEl = $("[data-dsh-log]", main);
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
    } else if (view === "booting") {
      if (detail) { detail.textContent = note; detail.classList.remove("err"); }
    } else {
      if (detail) { detail.textContent = note; detail.classList.remove("err"); }
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
    var btnStop = $("[data-dsh-stop]", main);
    if (btnStop && !btnStop.dataset.bound) {
      btnStop.dataset.bound = "1";
      btnStop.addEventListener("click", function () {
        postAction("stop").then(function () { poll(true); }).catch(function (e) {
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
      var status = $("#dsh-status");
      if (status) status.textContent = "无法连接 App 后端路由";
      document.body.setAttribute("data-view", "error");
      var panel = $("#boot-panel");
      if (panel) panel.innerHTML = '<pre class="diag-progress">' + esc(text)
        + "\n请从 Card Center 重新打开本卡以完成 App surface 授权。</pre>";
    }
    schedulePoll(POLL_SLOW_MS);
  }

  function schedulePoll(ms) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ms);
  }
  // ---- 轮询去重：一份状态只让一个 owner 去取 ----
  // 事实只有一个（App 侧 boot-state），但主卡与 FP 是两份文档、各有一个定时器——两路轮询同一份
  // 状态是重复劳动。定为：**主卡是 owner**，取回快照后写进跨面共享存储；
  // FP 只订阅 + 读快照，不主动取；只有当快照不存在/被标记下线/老得离谱（owner 悄悄没了）时
  // FP 才自己取。通道复用设置视图与会话选中那条（hana.storage.global + onChanged），不新开协议。
  // 代价如实记：owner 非正常消失（没跑到 pagehide）时，FP 最多陈旧 STALE_MS。
  var BOOT_STATE_STALE_MS = 5 * 60 * 1000;
  var lastPublishedSig = null;
  var lastSnapshot = null;
  function bootSig(s) {
    if (!s) return "";
    var e = s.error || {};
    return [
      s.phase || "", s.ready ? 1 : 0, s.runtimeId || "",
      (s.service && s.service.port) || "", e.code || "", e.userText || "", s.note || "",
      Array.isArray(s.logTail) ? s.logTail.length : 0,
    ].join("|");
  }
  function publishBootState(s) {
    var sig = bootSig(s);
    if (sig === lastPublishedSig) return; // 状态没变就不写，免存储抖动
    lastPublishedSig = sig;
    writeShared("boot-state", { at: Date.now(), state: s })
      .catch(function () { /* 拿不到共享面就当没有，本面照常自取 */ });
  }
  function fetchOwnState() {
    fetchState().then(function (s) {
      if (!isSidebar) { lastSnapshot = s; publishBootState(s); }
      applySnapshot(s);
    }).catch(function (err) {
      setStateView("error", (err && err.message) || String(err));
    });
  }
  /** force=true 忽略共享快照直接自取（本面刚发过动作，必须立刻看到结果）。 */
  function poll(force = false) {
    if (!isSidebar) { fetchOwnState(); return; }
    readShared("boot-state").then(function (v) {
      var fresh = v && typeof v.at === "number" && v.at > 0 && Date.now() - v.at < BOOT_STATE_STALE_MS;
      if (!force && fresh && v.state) { applySnapshot(v.state); return; }
      fetchOwnState();
    }, function () { fetchOwnState(); });
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
    try { dst.postMessage(themeMessage(), "*"); } catch (e) { /* 目标不可达忽略 */ }
  }
  // 同文档注入形态（当前主路径）：主题桥就在本页里，向本窗口广播即可被它收到。
  // 为什么必须由壳页主动推：桥发的 dshHanaThemeRequest 走的是 parent.postMessage，而
  // 同文档注入后本页的 parent 是**宿主**而不是壳页，那个请求到不了这里，壳也就没机会回
  // ——这就是主卡 / FP 主题不跟随的原因（旧 iframe 形态下 parent 恰好是壳页，才一直正常）。
  // 主题载荷：宿主变量 + 启动偏好（boot-theme 行字面量；桥在插件树之前靠它开门）。
  function themeMessage() {
    return { dshHanaTheme: { vars: readThemeVars(), preference: dshPreference } };
  }
  function pushThemeToSelf() {
    try { window.postMessage(themeMessage(), "*"); } catch (e) { /* 忽略 */ }
  }
  window.addEventListener("message", function (e) {
    var data = e.data;
    if (!data || typeof data !== "object") return;
    if (data.dshHanaThemeRequest) { try { sendThemeTo(e.source); } catch (err) { /* 忽略 */ } }
  });
  // 剪贴板：走宿主能力门（app/ui.clipboard-write）。本窗口（嵌入场景）里
  // navigator.clipboard 被宿主的 Permissions-Policy 拒（'denied'），所以壳级全局 shadow
  // （src/ui/clipboard-shadow.ts，桥优先）改调 __DSHANA__.clipboardWrite，最终落到这里：
  // 宿主执行 hana.clipboard.writeText，不受插件 iframe 权限链限制。
  //
  // 契约：@hana/plugin-sdk 的 HanaClipboardWriteTextResult 是
  // **{ written: boolean }**。旧代码判的是 `payload.ok === false`——字段名不对，于是
  // 宿主明确回 written:false 时这里照样返回 true，表现为「界面显示复制成功、系统剪贴板里
  // 什么都没有」（DSH 那个 helper 只要不抛就报成功）。现在：显式 written:false 与异常都
  // **reject 并打印原因**，让失败可见（调用方据此报失败，不再静默假装成功）。
  //
  // 现场结论（方向已按决定暂停）：**两条路都在宿主手里**——
  //   宿主：Plugin UI capability "clipboard.writeText" is not allowed in card slots
  //         （App 卡面不被允许用这个能力通道，SDK 直接拒）
  //   原生：NotAllowedError（Permissions-Policy 把 Clipboard API 在本文档里关死）
  // 转发逻辑保留（宿主哪天放开，不用改代码就能活）。**报错每次都说**：她要的是即时反馈，
  // 不是被静音过的失败（失败每次即时上报）。唯一未试过的候选是
  // document.execCommand('copy')（DSH 只在 writeText 不存在时才走它），大概被同一道策略管着，不做。
  function writeClipboard(text) {
    if (!hana || !hana.clipboard || typeof hana.clipboard.writeText !== "function") {
      console.warn("[dshana/clipboard] 宿主 SDK 无 hana.clipboard.writeText（能力 app/ui.clipboard-write 未授予？）");
      return Promise.reject(new Error("host clipboard API unavailable"));
    }
    return Promise.resolve(hana.clipboard.writeText(text)).then(
      function (payload) {
        if (payload && payload.written === false) {
          console.warn("[dshana/clipboard] 宿主返回 written:false（复制未发生）：", payload);
          throw new Error("host clipboard write refused");
        }
        return true;
      },
      function (error) {
        console.warn("[dshana/clipboard] 宿主能力调用失败：", (error && error.message) || error);
        throw error instanceof Error ? error : new Error(String(error));
      }
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
  //   不跟随。修完这条，壳页、注入的 DSH UI、以及主题桥读到的变量
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
  // 三态模型：
  //   default —— full（整幅 DSH UI）与 detached（拆窗）共用一页，内容一样；
  //   main    —— 主卡，无 DSH 侧栏（侧栏归 FP）；
  //   sidebar —— FP，只有侧栏。
  // 另有 settings（App 自己的设置页，不注入 DSH），它是宿主设置标签页的面，不属于上面三态。
  // 映射到 DSH 侧上游的角色词：default→standalone、sidebar→navigation、main/settings→workspace。
  // 为何不反过来靠宿主：宿主把本页挂进 FP 用的是 functionPanel.routeUrl，不带我们的任何参数；
  // 而 hostSlot() 可能报 page / widget 这类广义值，比静态声明更不确定。
  var SLOT_VIEW = { "card": "main", "function-panel": "sidebar", "settings": "settings" };
  var VIEWS = ["default", "main", "sidebar", "settings"];
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
      if (VIEWS.indexOf(v) >= 0) return v;
    } catch (e) { /* 忽略 */ }
    var a = root && root.getAttribute("data-dshana-view");
    return a && VIEWS.indexOf(a) >= 0 ? a : null;
  }
  function resolveView(root) {
    // 兜底到 default（full）而不是 main：认不出面时按上游本来的行为画整幅 DSH UI，
    // 而不是默认为主卡（那会把侧栏当成去掉的、少一列）。
    return declaredView(root) || SLOT_VIEW[hostSlot() || ""] || "default";
  }

  // ---- 标题栏内的交互区域（Hana 0.950.0+；“APPS.md・标题栏内的交互区域”）----
  // 宿主顶部那条半透明标题带会盖住页面内容，落在带内的控件点不到——表现就是“那个位置
  // 有按钮也按不了”。官方门：await hana.surface.setInteractiveRegions(regions)，**运行时调用、
  // 不需要清单权限**，只对**黑板主卡与拆窗主卡**开放（FP / 设置页 / 未就绪页面不行），返回
  // { applied: true }；坐标是 **iframe 视口的 CSS 像素**。
  // 契约束（官方要求，不自行简化）：每次调用替换完整集合；上限 64 个矩形；只报控件真实
  // 边界（不把整条工具栏或 iframe 报上去）；隐藏控件剔除；布局/滚动/尺寸变化后重测，同帧
  // 合并，集合没变就跳过。
  var CHROME_BAND_PX = 44; // 与拆窗页/设置面留白同一个常量（样例 bootstrap.css）
  var IR_LIMIT = 64;
  var IR_SELECTOR = "button, [role='button'], a[href], input, select, textarea, summary";
  var irLastSig = null;
  var irFrame = 0;
  var irStarted = false;
  function interactiveRegionRects() {
    var out = [];
    var nodes;
    try { nodes = document.querySelectorAll(IR_SELECTOR); } catch (e) { return out; }
    var seen = {};
    for (var i = 0; i < nodes.length && out.length < IR_LIMIT; i++) {
      var el = nodes[i];
      if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") continue;
      var r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width <= 0 || r.height <= 0) continue;
      // 只认落在标题带里、且确实有一块可见面积的控件
      if (r.bottom <= 0 || r.top >= CHROME_BAND_PX) continue;
      var reg = {
        x: Math.round(r.left), y: Math.round(r.top),
        width: Math.round(r.width), height: Math.round(r.height),
      };
      var key = reg.x + "," + reg.y + "," + reg.width + "," + reg.height;
      if (seen[key]) continue;
      seen[key] = true;
      out.push(reg);
    }
    return out;
  }
  function reportInteractiveRegions() {
    irFrame = 0;
    var v = resolveView(shell);
    if (v !== "main" && v !== "default") return; // 只有黑板主卡与拆窗卡能调
    if (!hana || !hana.surface || typeof hana.surface.setInteractiveRegions !== "function") return;
    var regions = interactiveRegionRects();
    var sig = regions.map(function (r) { return r.x + "," + r.y + "," + r.width + "," + r.height; }).join(";");
    if (sig === irLastSig) return; // 集合没变就不上报
    irLastSig = sig;
    try {
      Promise.resolve(hana.surface.setInteractiveRegions(regions)).catch(function () {
        /* 旧宿主明确失败；也不重试——不是致命能力 */
      });
    } catch (e) { /* 忽略 */ }
  }
  function scheduleInteractiveRegions() {
    if (irFrame) return; // 同帧合并
    try { irFrame = requestAnimationFrame(reportInteractiveRegions); } catch (e) { irFrame = 0; }
  }
  /** 注入完成（DSH 已就位）后开始观测；FP / 设置页直接不开这个门。 */
  function startInteractiveRegions() {
    if (irStarted) return;
    var v = resolveView(shell);
    if (v !== "main" && v !== "default") return;
    irStarted = true;
    try {
      if (typeof ResizeObserver === "function") {
        var ro = new ResizeObserver(scheduleInteractiveRegions);
        ro.observe(document.documentElement);
      }
    } catch (e) { /* 忽略 */ }
    try { window.addEventListener("resize", scheduleInteractiveRegions); } catch (e) { /* 忽略 */ }
    // 捕获阶段听滚动：内层滚动容器不会冒泡到 window
    try { document.addEventListener("scroll", scheduleInteractiveRegions, true); } catch (e) { /* 忽略 */ }
    try {
      var mo = new MutationObserver(scheduleInteractiveRegions);
      mo.observe(document.body, { childList: true, subtree: true });
    } catch (e) { /* 忽略 */ }
    scheduleInteractiveRegions();
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
      // FP 是投影面：owner（主卡）一写快照就立刻跟随（事件驱动，不等自己的定时器），
      // 并先用快照渲染首屏（免得空等到第一次定时器）。owner 不在场时下面的 poll 会自己取。
      if (isSidebar) {
        onSharedChanged("boot-state", function () {
          readShared("boot-state").then(function (v) {
            if (v && v.state) applySnapshot(v.state);
          }, function () { /* 忽略 */ });
        });
        readShared("boot-state").then(function (v) {
          if (v && v.state) applySnapshot(v.state);
        }, function () { /* 忽略 */ });
      }
      // 卸载释放注入的 transport（WS 载体等）
      window.addEventListener("pagehide", function () {
        if (injected.dispose) { try { injected.dispose(); } catch (e) { /* 忽略 */ } }
        // owner 下线：把快照标成过期（at: 0），FP 不必等 5 分钟安全网就能接上
        if (!isSidebar && lastSnapshot) {
          try { writeShared("boot-state", { at: 0, state: lastSnapshot }); } catch (e) { /* 忽略 */ }
        }
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
