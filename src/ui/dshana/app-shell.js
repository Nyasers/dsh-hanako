// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/ui/dshana/app-shell.js — dsh-hanako App v2 壳页逻辑（main/sidebar 共用；纯浏览器 JS）
//
// 相对资源纪律（迁移指南 §10）：本文件经 <script src="./app-shell.js"> 相对引入，页面内
// 不出现根路径绝对 URL（/assets 等）。到本 App 后端路由的调用同样用相对同源路径：
//   apiBase = "/api/apps/<appId>/routes"（自 location.pathname 推导，不硬编码 appId）
//   boot-state  = apiBase + "/dshana/boot-state"
// 宿主在 App surface 授权下加载 ui/ 页面并为同源子请求放行（app_route = 宿主登录或本 App
// surface 会话）。真机对账点：页面到 routes 的鉴权 cookie/hana.api 形态见 DESIGN。
//
// 到受管 runtime 服务（DSH Web UI / API / SSE / WS）：宿主在 service readyMarker 后自动
// 暴露代理前缀 /api/apps/<appId>/routes/_runtime/<runtimeId>/（自动代理 HTTP/SSE/WS +
// 重定向重写 + hana_app_runtime HttpOnly cookie，实证 server 0.930.1）。壳页在 ready 后把
// iframe 指向该前缀（?dshana-view=main|sidebar 为本 App 与 DSH UI 约定的视图参数，DSH
// UI 忽略未知参数）。DSH UI 的 SPA 若以根路径写死资源/API/WS，需 DSH 侧适配代理 base
// （宿主不重写任意 SPA 的 HTML/根路径——真机验收项，见 DESIGN 已测/未测清单）。
//
// 壳桥兼容（v1 iframe 壳页职责平移）：DSH Web UI 内注入的 @dsh-hanako/theme 桥会向
// window.parent postMessage({ dshHanaThemeRequest:true }) 索取主题 vars；clipboard 桥会
// postMessage({__dshCopy,...}) 经 MessageChannel 回执。本壳页按同一契约应答（best-effort，
// 无浏览器 SDK 依赖）。嵌入场景下 DSH 页面在 iframe 内、parent === 本页 window。
(function () {
  "use strict";

  var APP_SEG = null; // { appId, apiBase }
  function deriveAppSeg() {
    if (APP_SEG) return APP_SEG;
    var parts = (location.pathname || "").split("/"); // ["","api","apps",appId,"ui",...]
    var idx = parts.indexOf("api");
    var appId = idx >= 0 && parts[idx + 1] === "apps" ? parts[idx + 2] : null;
    if (!appId) return null;
    APP_SEG = { appId: appId, apiBase: "/api/apps/" + appId + "/routes" };
    return APP_SEG;
  }

  var PHASE_LABEL = { idle: "未启动", starting: "启动中", ready: "就绪", error: "失败", stopped: "已停止" };
  var POLL_FAST_MS = 1500;   // 非就绪：较快轮询
  var POLL_SLOW_MS = 5000;   // 就绪/错误：慢轮询（发现运行态漂移）
  var pollTimer = null;
  var lastReady = false;
  var stateEls = {};

  function $(sel, root) { return (root || document).querySelector(sel); }

  function fetchState() {
    var seg = deriveAppSeg();
    if (!seg) return Promise.reject(new Error("无法从页面路径推导 App 路由前缀"));
    return fetch(seg.apiBase + "/dshana/boot-state", {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" }
    }).then(function (res) {
      if (!res.ok) throw new Error("boot-state HTTP " + res.status + "（" + res.statusText + "）");
      return res.json();
    });
  }

  function postAction(action) {
    var seg = deriveAppSeg();
    if (!seg) return Promise.reject(new Error("无法推导 App 路由前缀"));
    return fetch(seg.apiBase + "/dshana/" + action, { method: "POST", cache: "no-store" })
      .then(function (res) { return res.json().catch(function () { return {}; }); });
  }

  function schedule(ms) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, ms);
  }

  function render(snap) {
    var s = snap && snap.state;
    if (!s) { setView("error", "boot-state 响应缺少 state 字段"); return; }
    var phase = s.phase || "idle";
    var el = stateEls;
    var detail = s.note || (PHASE_LABEL[phase] || phase);
    setView(phase, detail, s);
    if (el.phase) el.phase.textContent = PHASE_LABEL[phase] || phase;
    if (el.phaseCode) el.phaseCode.textContent = phase;
    if (el.errorCode) el.errorCode.textContent = s.error ? s.error.code : "";
    if (el.errorText) el.errorText.textContent = s.error ? s.error.userText : "";
    if (el.runtime) el.runtime.textContent = s.runtimeId || "-";
    // 就绪：展示 iframe（指向宿主运行时服务代理前缀）；否则隐藏并清理
    var frame = el.frame;
    if (frame) {
      if (s.ready && s.proxyPrefix) {
        frame.src = s.proxyPrefix + (window.__DSHANA_VIEW ? "?dshana-view=" + encodeURIComponent(window.__DSHANA_VIEW) : "");
        frame.hidden = false;
        if (el.frameZone) el.frameZone.hidden = false;
      } else {
        frame.removeAttribute("src");
        frame.hidden = true;
        if (el.frameZone) el.frameZone.hidden = true;
      }
    }
    lastReady = Boolean(s.ready);
  }

  function setView(phase, text, s) {
    var body = stateEls.body;
    if (!body) return;
    body.setAttribute("data-phase", phase);
    var show = { idle: "idle", starting: "starting", ready: "ready", error: "error", stopped: "idle" };
    body.classList.toggle("ph-ready", phase === "ready");
    body.classList.toggle("ph-booting", phase === "starting");
    body.classList.toggle("ph-error", phase === "error" || phase === "stopped");
    if (stateEls.detail) stateEls.detail.textContent = text;
    // 操作按钮显隐：idle/error/stopped 显示「启动」；ready 显示「停止」
    if (stateEls.btnStart) stateEls.btnStart.hidden = phase !== "idle" && phase !== "error" && phase !== "stopped";
    if (stateEls.btnStop) stateEls.btnStop.hidden = phase !== "ready";
    if (stateEls.errorPanel) stateEls.errorPanel.hidden = !(phase === "error");
    if (stateEls.actionPanel) stateEls.actionPanel.hidden = phase !== "idle" && phase !== "stopped" && phase !== "error";
    if (stateEls.bootLine) stateEls.bootLine.hidden = phase !== "starting";
    if (stateEls.readyNote) stateEls.readyNote.hidden = !(phase === "ready" && s && s.proxyPrefix);
  }

  function poll() {
    fetchState().then(function (data) {
      render(data);
      schedule(data && data.state && data.state.ready ? POLL_SLOW_MS : POLL_FAST_MS);
    }).catch(function (err) {
      setView("error", "无法连接 App 后端路由（" + (err && err.message ? err.message : String(err)) + "）。请从 Card Center 重新打开本卡以完成 App surface 授权。");
      schedule(POLL_SLOW_MS);
    });
  }

  function startNow() {
    postAction("start").then(function () {
      stateEls.startingNote && stateEls.startingNote.removeAttribute("hidden");
      poll();
    }).catch(function (err) {
      setView("error", "启动请求失败：" + (err && err.message ? err.message : String(err)));
    });
  }
  function stopNow() {
    postAction("stop").then(function () { poll(); }).catch(function (err) {
      setView("error", "停止请求失败：" + (err && err.message ? err.message : String(err)));
    });
  }

  // ---- 壳桥应答：theme / clipboard（DSH Web UI 嵌入时 window.parent === 本页）----
  // @dsh-hanako/theme 桥的 TOKEN_MAP 别名表在本页不可静态获得（宿主不保证把全套主题
  // CSS 变量注入 App surface），故 best-effort：从 documentElement 计算样式读常见 alias
  // token（存在才回），拿不到完整表时留给真机对账（DSH UI 内嵌验收）补充。
  var THEME_ALIAS_VARS = [
    "--dsw-alias-bg", "--dsw-alias-fg", "--dsw-alias-accent", "--dsw-alias-border",
    "--dsw-specific-bg", "--dsw-specific-fg", "--dsw-specific-accent", "--dsw-specific-border"
  ];
  function collectThemeVars() {
    var vars = {};
    try {
      var cs = getComputedStyle(document.documentElement);
      for (var i = 0; i < THEME_ALIAS_VARS.length; i++) {
        var name = THEME_ALIAS_VARS[i];
        var val = cs.getPropertyValue(name);
        if (val) vars[name] = String(val).trim();
      }
    } catch (e) { /* 主题采集失败忽略 */ }
    return vars;
  }
  window.addEventListener("message", function (e) {
    var data = e.data;
    if (!data || typeof data !== "object") return;
    if (data.dshHanaThemeRequest) {
      try {
        e.source.postMessage({ dshHanaTheme: { vars: collectThemeVars() } }, e.origin);
      } catch (err) { /* 忽略 */ }
    }
    // dshHanaPref：DSH 偏好变更事件提示——本页无 /webui/events 等价通道（v1 宿主插件
    // 专供），嵌入验收后补（见 DESIGN 已测/未测清单）
    if (data.__dshCopy) {
      var text = typeof data.text === "string" ? data.text : "";
      writeClipboard(text).then(function (ok) {
        try {
          if (data.port2 && data.port2.postMessage) {
            data.port2.postMessage({ __dshCopyResult: { ok: ok } });
          } else if (e.ports && e.ports[0]) {
            e.ports[0].postMessage({ __dshCopyResult: { ok: ok } });
          }
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
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(ta);
      return Boolean(ok);
    } catch (e) {
      return false;
    }
  }

  // ---- 启动 ----
  function boot() {
    var root = $("[data-dshana-shell]");
    if (!root) return;
    window.__DSHANA_VIEW = root.getAttribute("data-dshana-view") || "main";
    stateEls = {
      body: root,
      phase: $("[data-dsh-phase]", root), phaseCode: $("[data-dsh-phase-code]", root),
      detail: $("[data-dsh-detail]", root),
      errorCode: $("[data-dsh-error-code]", root), errorText: $("[data-dsh-error-text]", root),
      runtime: $("[data-dsh-runtime]", root),
      frame: $("[data-dsh-frame]", root), frameZone: $("[data-dsh-frame-zone]", root),
      btnStart: $("[data-dsh-start]", root), btnStop: $("[data-dsh-stop]", root),
      errorPanel: $("[data-dsh-error-panel]", root), actionPanel: $("[data-dsh-action]", root),
      bootLine: $("[data-dsh-boot-line]", root), readyNote: $("[data-dsh-ready-note]", root),
      startingNote: $("[data-dsh-starting-note]", root)
    };
    if (stateEls.btnStart) stateEls.btnStart.addEventListener("click", startNow);
    if (stateEls.btnStop) stateEls.btnStop.addEventListener("click", stopNow);
    poll();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
