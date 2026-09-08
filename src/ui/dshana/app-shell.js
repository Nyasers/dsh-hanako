// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/ui/dshana/app-shell.js — dsh-hanako App v2 壳页逻辑（main/sidebar 共用；浏览器 ESM）
//
// 相对资源纪律（迁移指南 §10）：经 <script type="module" src="./app-shell.js"> 相对引入，
// 页面内不出现根路径绝对 URL。到本 App 后端路由一律 hana.api.fetch（@hana/plugin-sdk）：
// 宿主在 App surface iframe URL 附 appSurfaceSession query，SDK 注入
// X-Hana-App-Surface-Session header——裸 fetch 会被宿主网关 403 missing_credential
// （真机实测 0.930.1）。受管 runtime iframe 首访透传 appSurfaceSession（宿主按 surface
// 授权并种 hana_app_runtime cookie）。视觉沿袭 v1 webui-shell 纸张风（CSS 变量 +
// fallback 纸张色），数据语义 v2 boot-state（phase idle/starting/ready/error/stopped +
// logTail/logPath）。
import { hana } from "./vendor/hana-plugin-sdk.js";

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
          throw new Error("页面缺少 App surface 会话凭据，请从 Card Center 重新打开本卡");
        }
        throw err;
      });
  }
  function postAction(action) {
    return hana.api.fetch("dshana/" + action, { method: "POST", cache: "no-store" })
      .then(function (res) { return res.json().catch(function () { return {}; }); });
  }

  // 受管 runtime iframe URL：proxyPrefix 尾带 "/"；首访透传本页 appSurfaceSession query
  // （宿主按 surface 授权并为 runtime 路径种 hana_app_runtime cookie），再带视图参数。
  function runtimeUiUrl(prefix) {
    var q = new URLSearchParams();
    var ss = new URLSearchParams(location.search).get("appSurfaceSession");
    if (ss) q.set("appSurfaceSession", ss);
    var view = shell && shell.getAttribute("data-dshana-view");
    if (view) q.set("dshana-view", view);
    var qs = q.toString();
    return prefix + (qs ? "?" + qs : "");
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
      body.setAttribute("data-view", "ready");
      if (spin) spin.hidden = true;
      if (panel) panel.innerHTML = "";
      if (frameWrap) {
        frameWrap.hidden = false;
        var bar = $("#runtime-bar");
        var rt = $("[data-dsh-runtime]", bar), pt = $("[data-dsh-port]", bar);
        if (rt) rt.textContent = "runtime " + (s.runtimeId || "–");
        if (pt) pt.textContent = s.service && s.service.port ? "port " + s.service.port : "–";
      }
      if (frame) {
        if (frame.getAttribute("data-src") !== s.proxyPrefix) {
          frame.setAttribute("data-src", s.proxyPrefix);
          frame.src = runtimeUiUrl(s.proxyPrefix);
        }
        frame.hidden = false;
      }
      bindMainActions(s);
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

    if (view === "ready") {
      if (detail) detail.textContent = "DSH 已就绪。";
      if (meta) { meta.hidden = false; meta.textContent = "runtime " + (s.runtimeId || "–") + (s.service && s.service.port ? " · port " + s.service.port : ""); }
      if (logEl) logEl.hidden = true;
      if (frameZone) frameZone.hidden = false;
      if (frame) {
        if (frame.getAttribute("data-src") !== s.proxyPrefix) {
          frame.setAttribute("data-src", s.proxyPrefix);
          frame.src = runtimeUiUrl(s.proxyPrefix);
        }
        frame.hidden = false;
      }
      if (btnStart) btnStart.hidden = true;
      if (btnStop) btnStop.hidden = false;
      bindSidebarActions();
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
  function writeClipboard(text) {
    var nc = navigator.clipboard;
    if (nc && typeof nc.writeText === "function") {
      return nc.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(ta);
      return Boolean(ok);
    } catch (e) { return false; }
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
