// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/ui/settings.tsx — DSHana App 自己的设置页脚本（contributes.settings.ui.route = /settings.html）。
//
// 为什么是我们自己的页：宿主设置区里那个「DSHana」标签页直接渲染本页，配置经 App 自己的后端
// 读写（GET/POST /dshana/settings → dataDir/config.json 的 global.*，即运行时优先直读的那份值），
// 不再让宿主按 manifest schema 代画表单，"两处表单两份值"的分叉因此不存在。缺省值由
// src/lib/config.ts 的 APP_SETTING_DEFAULTS 持有（30 / 1800）。
//
// 界面用宿主自己的设置组件（@hana/plugin-components/settings）：形态、间距、字号、保存反馈与
// 就绪态都由宿主口径出，本页只持有状态与读写逻辑。页面本身不加外边距（宿主设置容器已经在管
// 那圈留白），也不自带色彩——颜色全部由宿主主题变量供给。
//
// 本脚本三件事：
//   1) 跟随宿主主题：hana.theme.getSnapshot() 首屏 + hana.theme.subscribe 事件，不轮询。
//      宿主主题 CSS 在 settings.css 之后注入，变量覆盖顺序因此正确。
//   2) 常规两项：读回来的就是运行时生效值，保存后同样以后端返回的生效值为准，不做本地猜测。
//   3) 默认模型：这份值的正主是 DSH 的 settings 段 agent-default-model，本页只是它的一扇门
//      （不在 config.json 存副本），DSH 未运行时本节给体面态并给启动入口。
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { hana } from "@hana/plugin-sdk";
import {
  Button,
  SaveButton,
  Select,
  SettingRow,
  SettingsPage,
  SettingsSection,
  TextInput,
} from "@hana/plugin-components/settings";
import type { SelectOption } from "@hana/plugin-components/settings";
import "@hana/plugin-components/settings.css";

// ---- 主题跟随（与壳页同一姿势）----
const THEME_STYLE_ATTR = "data-hana-theme-style";
let themeCssUrl: string | null = null;

type ThemeSnap = { theme?: string; appearance?: string; cssUrl?: string };

function applyTheme(snap: ThemeSnap | null | undefined) {
  if (!snap || typeof snap !== "object") return;
  const root = document.documentElement;
  if (typeof snap.theme === "string" && snap.theme) root.setAttribute("data-theme", snap.theme);
  if (typeof snap.appearance === "string" && snap.appearance) {
    root.setAttribute("data-appearance", snap.appearance);
    // 原生控件与滚动条跟着宿主明暗，而不是跟着系统（两者不一致时页面会半黑半白）。
    root.style.colorScheme = snap.appearance === "dark" ? "dark" : "light";
  }
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
      /* 拿不到主题不致命：交给宿主主题变量与组件库自带的兜底 */
    });
}

// ---- 小工具 ----
const START_TIMEOUT_MS = 120000;

function errText(e: unknown) {
  const m = e && (e as { message?: string }).message;
  return m || String(e);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 常规两项：字段名与提示语（值本身由后端与 config.ts 的缺省值决定）。 */
const FIELDS: { key: string; label: string; hint: string }[] = [
  { key: "approvalTimeoutSec", label: "审批超时（秒）", hint: "审批超时自动拒绝；填 0 = 禁用自动拒绝。" },
  { key: "defaultTimeoutSec", label: "任务默认超时（秒）", hint: "单次任务默认超时；填 0 或留空按 600 秒。" },
];

type CatalogModel = { id?: string; name?: string; efforts?: { id?: string; name?: string }[] };
type CatalogGroup = { id?: string; name?: string; models?: CatalogModel[] };

/** 第一段：provider 列表。 */
function providerOptions(model: any): SelectOption[] {
  const groups: CatalogGroup[] = (model && model.catalog && model.catalog.groups) || [];
  return groups.filter((g) => g.id).map((g) => ({ value: String(g.id), label: String(g.name || g.id) }));
}

/**
 * 第二段：该 provider 下的模型。用宿主 Select：它是 Base UI 的 select widget，弹层定位器会算
 * --available-height 并 overflowY:auto，模型再多也能滚。
 */
function modelOptionsFor(model: any, provider: string): SelectOption[] {
  const groups: CatalogGroup[] = (model && model.catalog && model.catalog.groups) || [];
  for (const g of groups) {
    if (String(g.id) !== provider) continue;
    return (g.models || []).filter((m) => m.id).map((m) => ({ value: String(m.id), label: String(m.name || m.id) }));
  }
  return [];
}

/** 第三段：选中模型支持的推理档位（没有就返回空数组，那一行不渲染）。 */
function effortsOf(model: any, provider: string, modelId: string): { id?: string; name?: string }[] {
  const groups: CatalogGroup[] = (model && model.catalog && model.catalog.groups) || [];
  for (const g of groups) {
    if (String(g.id) !== provider) continue;
    for (const m of g.models || []) if (String(m.id) === modelId) return m.efforts || [];
  }
  return [];
}

async function readJson(path: string, init?: RequestInit) {
  const res = await hana.api.fetch(path, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    ...(init || {}),
  });
  const data = await res.json().catch(() => null);
  return { res, data };
}

function stringifySettings(settings: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FIELDS) {
    const v = settings && settings[f.key];
    out[f.key] = typeof v === "number" ? String(v) : "";
  }
  return out;
}

function App() {
  const [draft, setDraft] = useState<Record<string, string>>(() => stringifySettings(null));
  const [cfgHint, setCfgHint] = useState("");
  const [cfgWarn, setCfgWarn] = useState(false);
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgSaved, setCfgSaved] = useState(false);

  const [model, setModel] = useState<any>(null); // 最近一次读回的整份状态（ready/current/revision/catalog）
  const [modelHint, setModelHint] = useState("");
  const [modelWarn, setModelWarn] = useState(false);
  const [providerSel, setProviderSel] = useState("");
  const [modelSel, setModelSel] = useState("");
  const [effort, setEffort] = useState("");
  const [modelSaving, setModelSaving] = useState(false);
  const [modelSaved, setModelSaved] = useState(false);
  const [starting, setStarting] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const { res, data } = await readJson("dshana/settings");
      if (!res.ok) throw new Error("HTTP " + res.status);
      setDraft(stringifySettings(data && data.settings));
      setCfgHint("");
      setCfgWarn(false);
    } catch (e) {
      setCfgHint("读取失败：" + errText(e));
      setCfgWarn(true);
    }
  }, []);

  const loadModel = useCallback(async (): Promise<boolean> => {
    try {
      const { res, data } = await readJson("dshana/model");
      if (!data) throw new Error("HTTP " + res.status);
      if (!data.ready) {
        setModel({ ready: false, error: data.error || "" });
        setStarting(false);
        return false;
      }
      if (!data.ok) {
        setModel({ ready: true });
        setModelWarn(true);
        setModelHint("读取失败：" + (data.error || "未知原因"));
        return false;
      }
      setModel(data.model || {});
      setModelWarn(false);
      setModelHint("");
      return true;
    } catch (e) {
      setModel({ ready: false, error: "" });
      setModelWarn(true);
      setModelHint("读取失败：" + errText(e));
      return false;
    }
  }, []);

  // 每次读回整份状态后，把三段选择对齐到权威当前值。
  useEffect(() => {
    const cur = model && model.current;
    if (!cur || !cur.provider) return;
    setProviderSel(String(cur.provider));
    setModelSel(typeof cur.model === "string" ? cur.model : "");
    setEffort(typeof cur.reasoningEffort === "string" ? cur.reasoningEffort : "");
  }, [model]);

  useEffect(() => {
    void loadConfig();
    void loadModel();
  }, [loadConfig, loadModel]);

  const saveConfig = async () => {
    const patch: Record<string, number> = {};
    for (const f of FIELDS) {
      const v = draft[f.key];
      if (v !== "") patch[f.key] = Number(v);
    }
    if (Object.keys(patch).length === 0) {
      setCfgHint("请先填一个数值。");
      setCfgWarn(true);
      return;
    }
    setCfgSaving(true);
    setCfgHint("");
    setCfgWarn(false);
    try {
      const { res, data } = await readJson("dshana/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || "HTTP " + res.status);
      setDraft(stringifySettings(data.settings)); // 以后端返回的生效值为准
      setCfgSaved(true);
    } catch (e) {
      setCfgHint("保存失败：" + errText(e));
      setCfgWarn(true);
    } finally {
      setCfgSaving(false);
    }
  };

  const saveModel = async () => {
    if (!providerSel || !modelSel) {
      setModelWarn(true);
      setModelHint("请先选一个 provider 与模型。");
      return;
    }
    const body: Record<string, unknown> = { provider: providerSel, model: modelSel };
    if (effort) body.reasoningEffort = effort;
    if (model && typeof model.revision === "number") body.expectedRevision = model.revision;
    setModelSaving(true);
    setModelWarn(false);
    setModelHint("");
    try {
      const { res, data } = await readJson("dshana/model", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 409) {
        setModelWarn(true);
        setModelHint("默认模型已被别处改过，已刷新。");
        await loadModel();
        return;
      }
      if (!data || data.ok !== true) throw new Error((data && data.error) || "HTTP " + res.status);
      // 写回只回 current/revision（候选不在写作范围内）：整份状态从 GET 重读，避免用半份数据
      // 覆盖候选列表。重读失败时如实说，不假装成功。
      const reread = await loadModel();
      if (reread) setModelSaved(true);
      else {
        setModelWarn(true);
        setModelHint("已保存，但重读状态失败，请刷新本页");
      }
    } catch (e) {
      setModelWarn(true);
      setModelHint("保存失败：" + errText(e));
    } finally {
      setModelSaving(false);
    }
  };

  const startDsh = async () => {
    setStarting(true);
    setModelWarn(false);
    setModelHint("");
    try {
      await hana.api.fetch("dshana/start", { method: "POST", cache: "no-store" });
    } catch (e) {
      if (!alive.current) return;
      setStarting(false);
      setModelWarn(true);
      setModelHint("启动请求失败：" + errText(e));
      return;
    }
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(2000);
      if (!alive.current) return;
      try {
        const { data } = await readJson("dshana/model");
        if (data && data.ready && data.ok === true) {
          setModel(data.model || {});
          setModelWarn(false);
          setModelHint("");
          setStarting(false);
          return;
        }
        if (data && data.ready && data.ok !== true) {
          setModelWarn(true);
          setModelHint("读取失败：" + (data.error || "未知原因"));
          setStarting(false);
          return;
        }
      } catch {
        continue; // 启动中路由/中继还没就绪，接着等
      }
    }
    if (!alive.current) return;
    setStarting(false);
    setModelWarn(true);
    setModelHint("启动超时：DSH 还没就绪，稍后刷新本页重试。");
  };

  const providerOpts = providerOptions(model);
  const modelOpts = modelOptionsFor(model, providerSel);
  const effortOptions: SelectOption[] = effortsOf(model, providerSel, modelSel).map((e) => ({
    value: String(e.id || ""),
    label: String(e.name || e.id || ""),
  }));
  const dshReady = !!(model && model.ready !== false);
  const modelEmpty = model && model.catalog && providerOpts.length === 0;

  /** 换 provider：跟着把它下面的第一个模型选上（两段联动，不留空选）。 */
  const pickProvider = (value: string) => {
    setProviderSel(value);
    const opts = modelOptionsFor(model, value);
    setModelSel(opts.length > 0 ? opts[0].value : "");
  };
  const fails = (model && model.catalog && model.catalog.failures) || [];
  const catalogHint = modelEmpty
    ? "DSH 目前没有可选的模型。"
    : fails.length
      ? "部分 provider 加载失败：" + fails.map((f: any) => f.name || f.id).join("、")
      : model && model.catalogError
        ? "候选暂不可用：" + model.catalogError
        : "";

  return (
    <SettingsPage>
      <SettingsSection title="常规" description="这里的改动立刻生效，不需要重启 DSH。">
        {FIELDS.map((f) => (
          <SettingRow
            key={f.key}
            label={f.label}
            hint={f.hint}
            layout="stacked"
            control={
              <TextInput
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                aria-label={f.label}
                value={draft[f.key] ?? ""}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
            }
          />
        ))}
        <SettingRow
          label="保存"
          hint={cfgHint || undefined}
          hintVariant={cfgWarn ? "warn" : "default"}
          control={
            <SaveButton
              status={cfgSaving ? "saving" : cfgSaved ? "saved" : "idle"}
              labels={{ idle: "保存", saving: "保存中", saved: "已保存" }}
              onSavedFeedbackEnd={() => setCfgSaved(false)}
              onClick={() => void saveConfig()}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title="默认模型"
        description="新建会话用的模型。改完立即生效（DSH 的 settings 段，applies=live）。"
      >
        {!dshReady ? (
          <SettingRow
            label="DSH 未运行"
            hint={modelHint || (model && model.error) || "默认模型在 DSH 起来后才能选"}
            hintVariant="warn"
            control={
              <Button variant="primary" loading={starting} onClick={() => void startDsh()}>
                启动 DSH
              </Button>
            }
          />
        ) : (
          <>
            <SettingRow
              label="Provider"
              layout="stacked"
              control={
                <Select
                  ariaLabel="Provider"
                  value={providerSel}
                  options={providerOpts}
                  disabled={providerOpts.length === 0}
                  onChange={pickProvider}
                />
              }
            />
            <SettingRow
              label="模型"
              hint={modelHint || catalogHint || undefined}
              hintVariant={modelWarn ? "warn" : "default"}
              layout="stacked"
              control={
                <Select
                  ariaLabel="默认模型"
                  value={modelSel}
                  options={modelOpts}
                  disabled={modelOpts.length === 0}
                  onChange={setModelSel}
                />
              }
            />
            {effortOptions.length > 0 && (
              <SettingRow
                label="推理强度"
                hint="该模型支持的档位；留空则沿用 DSH 当前的设置。"
                layout="stacked"
                control={
                  <Select
                    ariaLabel="推理强度"
                    placeholder="保持当前设置"
                    value={effort}
                    options={effortOptions}
                    onChange={setEffort}
                  />
                }
              />
            )}
            <SettingRow
              label="保存"
              control={
                <SaveButton
                  status={modelSaving ? "saving" : modelSaved ? "saved" : "idle"}
                  labels={{ idle: "保存", saving: "保存中", saved: "已保存" }}
                  onSavedFeedbackEnd={() => setModelSaved(false)}
                  onClick={() => void saveModel()}
                />
              }
            />
          </>
        )}
      </SettingsSection>
    </SettingsPage>
  );
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
  const host = document.getElementById("root");
  if (host) createRoot(host).render(<App />);
})();
