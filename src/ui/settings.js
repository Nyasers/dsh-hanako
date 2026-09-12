// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/ui/settings.js — DSHana App 自己的设置页脚本（contributes.settings.ui.route = /settings.html）。
//
// 为什么是我们自己的页：宿主设置区里那个「DSHana」标签页直接渲染本页，配置经
// App 自己的后端读写（GET/POST /dshana/settings → dataDir/config.json 的 global.*），不再让
// 宿主按 manifest schema 代画表单——"两处表单两份值"的分叉从此不存在。缺省值由
// src/lib/config.js 的 APP_SETTING_DEFAULTS 持有（30 / 1800，与原 schema 的 default 一致）。
//
// 本脚本只做两件事：
//   1) 跟随宿主主题：与卡壳页同一姿势（hana.theme.getSnapshot() 首屏 + hana.theme.changed
//      事件 + cssUrl 贴成 <style data-hana-theme-style>，不轮询）。这是重复的一小段——等第三处
//      需要跟随主题时再抽公共模块，现在不为两处建抽象。
//   2) 读写这两项：读回来的就是运行时生效值（后端走 config.js 的 resolver，与 DSH 启动时的
//      读法完全一致），保存后同样以后端返回的生效值为准，不做本地猜测。
import { hana } from "@hana/plugin-sdk";

const $ = (sel) => document.querySelector(sel);
const THEME_STYLE_ATTR = "data-hana-theme-style";
let themeCssUrl = null;

// ---- 主题跟随（同 app-shell.js）----
function applyTheme(snap) {
  if (!snap || typeof snap !== "object") return;
  const root = document.documentElement;
  if (typeof snap.theme === "string" && snap.theme) root.setAttribute("data-theme", snap.theme);
  if (typeof snap.appearance === "string" && snap.appearance) root.setAttribute("data-appearance", snap.appearance);
  const url = typeof snap.cssUrl === "string" ? snap.cssUrl : "";
  if (!url) return;
  themeCssUrl = url;
  fetch(url, { credentials: "same-origin", cache: "no-store" })
    .then((r) => (r.ok ? r.text() : ""))
    .then((css) => {
      if (themeCssUrl !== url || !css) return; // 期间主题又变了，等新的那次落地
      let el = document.querySelector("style[" + THEME_STYLE_ATTR + "]");
      if (!el) {
        el = document.createElement("style");
        el.setAttribute(THEME_STYLE_ATTR, "");
        (document.head || document.documentElement).appendChild(el);
      }
      if (el.textContent !== css) el.textContent = css;
    })
    .catch(() => {
      /* 拿不到主题不致命：页面用 HTML 里写好的纸张 fallback 色 */
    });
}

// ---- 设置读写 ----
function setStatus(text, tone) {
  const el = $("#status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("err", tone === "err");
  el.classList.toggle("ok", tone === "ok");
}

function fill(settings) {
  if (!settings || typeof settings !== "object") return;
  const a = $("#approvalTimeoutSec");
  const d = $("#defaultTimeoutSec");
  if (a && typeof settings.approvalTimeoutSec === "number") a.value = String(settings.approvalTimeoutSec);
  if (d && typeof settings.defaultTimeoutSec === "number") d.value = String(settings.defaultTimeoutSec);
}

function readForm() {
  const patch = {};
  const a = $("#approvalTimeoutSec");
  const d = $("#defaultTimeoutSec");
  if (a && a.value !== "") patch.approvalTimeoutSec = Number(a.value);
  if (d && d.value !== "") patch.defaultTimeoutSec = Number(d.value);
  return patch;
}

async function load() {
  try {
    const res = await hana.api.fetch("dshana/settings", {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    fill(data && data.settings);
    setStatus("");
  } catch (e) {
    setStatus("读取失败：" + ((e && e.message) || e), "err");
  }
}

async function save() {
  const btn = $("#save");
  const patch = readForm();
  if (Object.keys(patch).length === 0) {
    setStatus("请先填一个数值。", "err");
    return;
  }
  if (btn) btn.disabled = true;
  setStatus("保存中…");
  try {
    const res = await hana.api.fetch("dshana/settings", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) {
      throw new Error((data && data.error) || "HTTP " + res.status);
    }
    fill(data.settings); // 以后端返回的生效值为准
    setStatus("已保存", "ok");
  } catch (e) {
    setStatus("保存失败：" + ((e && e.message) || e), "err");
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---- 启动 ----
(function boot() {
  try {
    if (hana && typeof hana.ready === "function") hana.ready();
  } catch {
    /* 宿主未提供则忽略 */
  }
  try {
    const snap = hana && hana.theme && typeof hana.theme.getSnapshot === "function" ? hana.theme.getSnapshot() : null;
    if (snap) applyTheme(snap);
  } catch {
    /* 忽略 */
  }
  try {
    if (hana && hana.theme && typeof hana.theme.subscribe === "function") hana.theme.subscribe(applyTheme);
  } catch {
    /* 忽略 */
  }
  const btn = $("#save");
  if (btn) btn.addEventListener("click", save);
  const form = $("#form");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void save();
    });
  }
  void load();
})();
