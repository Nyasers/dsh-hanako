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

// ---- 默认模型（值归 DSH 的 settings 段 agent-default-model；本页只是它的一扇门）----
// 与上面两项不同：这份值不在我们的 config.json 里，读写都经 App 后转到 DSH 自己的 settings 服务，
// 所以 DSH 没运行时本节给体面态（提示 + 启动按钮），而不是整页报错。
const MODEL_KEY_SEP = "\u0000"; // provider 与 model id 之间：避免不同 provider 的同名模型撞车
let modelState = null; // 最近一次读回的 { current, revision, catalog }

function modelStatus(text, tone) {
  const el = $("#modelStatus");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("err", tone === "err");
  el.classList.toggle("ok", tone === "ok");
}

function setModelReady(ready, hint) {
  const sel = $("#model");
  const save = $("#modelSave");
  const start = $("#modelStart");
  const hintEl = $("#modelHint");
  if (sel && !ready) sel.disabled = true;
  if (save) save.disabled = !ready;
  if (start && start.classList) start.classList.toggle("hidden", ready);
  if (hintEl && !ready && hint) hintEl.textContent = hint;
}

/** 当前选中项 → 该模型的 effort 档位（没有就隐藏）。 */
function renderEffort(current) {
  const sel = $("#model");
  const field = $("#effortField");
  const eff = $("#effort");
  if (!sel || !field || !eff) return;
  const chosen = [...sel.options].find((o) => o.value === sel.value);
  let efforts = [];
  if (chosen && chosen.dataset.efforts) {
    try {
      efforts = JSON.parse(chosen.dataset.efforts) || [];
    } catch {
      efforts = [];
    }
  }
  eff.innerHTML = "";
  if (efforts.length === 0) {
    field.classList.add("hidden");
    return;
  }
  const keep = document.createElement("option");
  keep.value = "";
  keep.textContent = current && current.reasoningEffort ? "保持当前（" + current.reasoningEffort + "）" : "保持当前设置";
  eff.appendChild(keep);
  for (const e of efforts) {
    const opt = document.createElement("option");
    opt.value = e.id;
    opt.textContent = e.name || e.id;
    eff.appendChild(opt);
  }
  if (current && current.reasoningEffort && [...eff.options].some((o) => o.value === current.reasoningEffort)) {
    eff.value = current.reasoningEffort;
  }
  field.classList.remove("hidden");
}

function renderModel(model) {
  if (!model) return;
  modelState = { ...(modelState || {}), ...model };
  const sel = $("#model");
  const hintEl = $("#modelHint");
  const groups = (model.catalog && model.catalog.groups) || [];
  const current = model.current || (model.catalog && model.catalog.default) || null;
  if (sel) {
    sel.innerHTML = "";
    for (const g of groups) {
      const og = document.createElement("optgroup");
      og.label = g.name || g.id;
      for (const m of g.models || []) {
        const opt = document.createElement("option");
        opt.value = g.id + MODEL_KEY_SEP + m.id;
        opt.textContent = m.name || m.id;
        if (m.efforts && m.efforts.length) opt.dataset.efforts = JSON.stringify(m.efforts);
        og.appendChild(opt);
      }
      if (og.childElementCount > 0) sel.appendChild(og);
    }
    if (current) {
      const want = current.provider + MODEL_KEY_SEP + current.model;
      if ([...sel.options].some((o) => o.value === want)) sel.value = want;
    }
    sel.disabled = sel.options.length === 0;
  }
  renderEffort(current);
  if (hintEl) {
    const fails = (model.catalog && model.catalog.failures) || [];
    if (model.catalogError) hintEl.textContent = "候选暂不可用：" + model.catalogError;
    else if (fails.length) hintEl.textContent = "部分 provider 加载失败：" + fails.map((f) => f.name || f.id).join("、");
    else if (sel && sel.options.length === 0) hintEl.textContent = "DSH 目前没有可选的模型。";
    else hintEl.textContent = current ? "当前：" + current.provider + " / " + current.model : "";
  }
}

async function readModel() {
  const res = await hana.api.fetch("dshana/model", {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error("HTTP " + res.status);
  return data;
}

async function loadModel() {
  try {
    const data = await readModel();
    if (!data.ready) {
      setModelReady(false, data.error || "DSH 未运行：默认模型在 DSH 起来后才能选");
      modelStatus("");
      return;
    }
    setModelReady(true);
    if (!data.ok) {
      modelStatus("读取失败：" + (data.error || "未知原因"), "err");
      return;
    }
    renderModel(data.model);
    modelStatus("");
  } catch (e) {
    setModelReady(false, "读取失败，稍后重试");
    modelStatus("读取失败：" + ((e && e.message) || e), "err");
  }
}

async function saveModel() {
  const sel = $("#model");
  const raw = String((sel && sel.value) || "");
  const at = raw.indexOf(MODEL_KEY_SEP);
  if (at <= 0) {
    modelStatus("请先选一个模型。", "err");
    return;
  }
  const body = { provider: raw.slice(0, at), model: raw.slice(at + MODEL_KEY_SEP.length) };
  const eff = $("#effort");
  if (eff && eff.value) body.reasoningEffort = eff.value;
  if (modelState && typeof modelState.revision === "number") body.expectedRevision = modelState.revision;
  const btn = $("#modelSave");
  if (btn) btn.disabled = true;
  modelStatus("保存中…");
  try {
    const res = await hana.api.fetch("dshana/model", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (res.status === 409) {
      modelStatus("默认模型已被别处改过，已刷新。", "err");
      await loadModel();
      return;
    }
    if (!data || data.ok !== true) throw new Error((data && data.error) || "HTTP " + res.status);
    renderModel({ current: data.model && data.model.current, revision: data.model && data.model.revision });
    modelStatus("已保存", "ok");
  } catch (e) {
    modelStatus("保存失败：" + ((e && e.message) || e), "err");
  } finally {
    const b = $("#modelSave");
    if (b) b.disabled = false;
  }
}

/** DSH 未运行时的入口：拉起它，然后轮流读本节直到就绪（超时如实报）。 */
async function startDshForModel() {
  const btn = $("#modelStart");
  if (btn) btn.disabled = true;
  modelStatus("正在启动 DSH…");
  try {
    await hana.api.fetch("dshana/start", { method: "POST", cache: "no-store" });
  } catch (e) {
    modelStatus("启动请求失败：" + ((e && e.message) || e), "err");
    if (btn) btn.disabled = false;
    return;
  }
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    let data = null;
    try {
      data = await readModel();
    } catch {
      continue; // 启动中路由/中继还没就绪，接着等
    }
    if (data.ready && data.ok) {
      setModelReady(true);
      renderModel(data.model);
      modelStatus("DSH 已就绪", "ok");
      if (btn) btn.disabled = false;
      return;
    }
    if (data.ready && !data.ok) {
      setModelReady(true);
      modelStatus("读取失败：" + (data.error || "未知原因"), "err");
      if (btn) btn.disabled = false;
      return;
    }
  }
  modelStatus("启动超时：DSH 还没就绪，稍后刷新本页重试。", "err");
  if (btn) btn.disabled = false;
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
  const modelSel = $("#model");
  if (modelSel) {
    modelSel.addEventListener("change", () => renderEffort(modelState && modelState.current));
  }
  const modelBtn = $("#modelSave");
  if (modelBtn) modelBtn.addEventListener("click", () => { void saveModel(); });
  const startBtn = $("#modelStart");
  if (startBtn) startBtn.addEventListener("click", () => { void startDshForModel(); });
  void load();
  void loadModel();
})();
