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
/** 源切换轮询上限：链上最慢的是“停旧 + 起新”（含 profile 种子化与 DSH boot）。 */
const SWITCH_TIMEOUT_MS = 300000;

/** 数据来源三档（内部只有 private/shared 两态，第三档靠 path 区分）。 */
const SOURCE_CHOICES: SelectOption[] = [
  { value: "private", label: "内置独立目录（本 App 自己一份）" },
  { value: "shared-default", label: "DSH 默认目录（~/.dsh）" },
  { value: "shared-custom", label: "共享已有目录（自己选）" },
];

/** 切换链步骤 → 人话（页面进度显示用）。 */
const STEP_LABEL: Record<string, string> = {
  preflight: "预检新目录",
  freeze: "暂停在途请求",
  stopping: "停旧 runtime",
  starting: "按新源启动",
  saving: "落盘新设置",
  "rolling-back": "失败回滚中",
  done: "完成",
};
const MODEL_KEY_SEP = "\u0000"; // provider 与 model id 之间（见 modelOptions）

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

type ModelOption = SelectOption & { group?: string };

/**
 * 候选拉平成一个列表，用 group 标出 provider。
 *
 * 宿主 Select 的 options 支持 group 字段：运行时（组件库里的 select widget）遇到带 group 的项
 * 就成组渲染，画组标题、组间插分隔线——与宿主自己的模型选择器同一个形状。类型面没声明这个
 * 字段，所以这里显式标注。
 *
 * value = provider + 分隔符 + model：不同 provider 会有同名模型，不能只拿 model id 当值。
 */
function modelOptions(model: any): ModelOption[] {
  const groups: CatalogGroup[] = (model && model.catalog && model.catalog.groups) || [];
  const out: ModelOption[] = [];
  for (const g of groups) {
    const name = String(g.name || g.id || "");
    if (!g.id) continue;
    for (const m of g.models || []) {
      if (!m.id) continue;
      out.push({ value: String(g.id) + MODEL_KEY_SEP + String(m.id), label: String(m.name || m.id), group: name });
    }
  }
  return out;
}

/** 选中值拆成 provider 与 model（value 的写法见 modelOptions）。 */
function splitPicked(picked: string): { provider: string; model: string } {
  const at = picked.indexOf(MODEL_KEY_SEP);
  if (at <= 0) return { provider: "", model: "" };
  return { provider: picked.slice(0, at), model: picked.slice(at + MODEL_KEY_SEP.length) };
}

/** 第三段（推理档位）：选中模型支持的档位，没有就返回空数组，那一行不渲染。 */
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
  // 自持设置的 revision（乐观并发：写回带上，落后就 409）
  const [cfgRevision, setCfgRevision] = useState<number | null>(null);
  // 数据来源：当前源回显 + 三档选择 + 切换 operation（页面轮询）
  const [sourceView, setSourceView] = useState<any>(null);
  const [sourceChoice, setSourceChoice] = useState("private");
  const [customPath, setCustomPath] = useState("");
  const [sharedProfile, setSharedProfile] = useState("dshana");
  const [defaultSharedHome, setDefaultSharedHome] = useState("");
  const [switching, setSwitching] = useState(false);
  const [switchOp, setSwitchOp] = useState<any>(null);

  const [model, setModel] = useState<any>(null); // 最近一次读回的整份状态（ready/current/revision/catalog）
  const [modelHint, setModelHint] = useState("");
  const [modelWarn, setModelWarn] = useState(false);
  const [picked, setPicked] = useState("");
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
      setCfgRevision(data && typeof data.revision === "number" ? data.revision : null);
      // 来源回显：内置 / 默认目录 / 自选（第三档靠路径是不是默认目录区分）
      const s = (data && data.settings) || {};
      const sharedHome = data && data.defaults && typeof data.defaults.sharedHome === "string" ? data.defaults.sharedHome : "";
      setDefaultSharedHome(sharedHome);
      setSourceView(data && data.source ? data.source : null);
      if (s.mode === "private") setSourceChoice("private");
      else if (sharedHome && s.path === sharedHome) setSourceChoice("shared-default");
      else {
        setSourceChoice("shared-custom");
        setCustomPath(typeof s.path === "string" ? s.path : "");
      }
      if (typeof s.profile === "string" && s.profile) setSharedProfile(s.profile);
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

  // 每次读回整份状态后，把选择与档位对齐到权威当前值。
  useEffect(() => {
    const cur = model && model.current;
    if (!cur || !cur.provider) return;
    setPicked(String(cur.provider) + MODEL_KEY_SEP + String(cur.model || ""));
    setEffort(typeof cur.reasoningEffort === "string" ? cur.reasoningEffort : "");
  }, [model]);

  useEffect(() => {
    void loadConfig();
    void loadModel();
  }, [loadConfig, loadModel]);

  // 设置变更广播的落地：宿主 App 存储只有 get/set、没有订阅口（已核 SDK 的 d.ts），
  // 所以本页在重新可见时重读一次——另一个窗口改过设置也不会拿着旧值继续操作。
  // 切换进行中不重读（免得把页面上的进度显示冲掉）。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && !switching) void loadConfig();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadConfig, switching]);

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
        body: JSON.stringify({ settings: patch, expectedRevision: cfgRevision ?? undefined }),
      });
      if (res.status === 409) {
        // 别处改过（revision 前进）：不静默覆盖，重读后就着新值重来
        setCfgWarn(true);
        setCfgHint("设置已被别处改过，已刷新。");
        await loadConfig();
        return;
      }
      if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || "HTTP " + res.status);
      setDraft(stringifySettings(data.settings)); // 以后端返回的生效值为准
      if (typeof data.revision === "number") setCfgRevision(data.revision);
      setCfgSaved(true);
    } catch (e) {
      setCfgHint("保存失败：" + errText(e));
      setCfgWarn(true);
    } finally {
      setCfgSaving(false);
    }
  };

  const saveModel = async () => {
    const sel = splitPicked(picked);
    if (!sel.provider || !sel.model) {
      setModelWarn(true);
      setModelHint("请先选一个模型。");
      return;
    }
    const body: Record<string, unknown> = { provider: sel.provider, model: sel.model };
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

  /** 选目录：只经 picker（不提供手填），回来的路径交给路由再 stat 一次（不信任前端）。 */
  const pickDirectory = async () => {
    try {
      const picked = await hana.resources.pick({ mode: "directory" });
      const first = picked && Array.isArray(picked.resources) ? picked.resources[0] : null;
      const path = first && typeof first.path === "string" ? first.path : "";
      if (!path) {
        setCfgWarn(true);
        setCfgHint("没有选到目录。");
        return;
      }
      setCustomPath(path);
      setCfgWarn(false);
      setCfgHint("");
    } catch (e) {
      setCfgWarn(true);
      setCfgHint("选择目录失败：" + errText(e));
    }
  };

  /** 应用数据来源：走切换链（不直接写设置），然后轮询 operation 看结局。 */
  const applySource = async () => {
    const next = sourceChoice === "private"
      ? { mode: "private", profile: "dshana" }
      : {
          mode: "shared",
          path: sourceChoice === "shared-default" ? defaultSharedHome : customPath,
          profile: sharedProfile.trim() || "dshana",
        };
    if (next.mode === "shared" && !next.path) {
      setCfgWarn(true);
      setCfgHint("共享模式要先选一个目录。");
      return;
    }
    setSwitching(true);
    setCfgHint("");
    setCfgWarn(false);
    try {
      const { res, data } = await readJson("dshana/settings/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ settings: next, expectedRevision: cfgRevision ?? undefined }),
      });
      if (res.status === 409) {
        setCfgWarn(true);
        setCfgHint(data && data.code === "SWITCH_BUSY" ? "已有切换在进行中，稍后看结果。" : "设置已被别处改过，已刷新。");
        await loadConfig();
        setSwitching(false);
        return;
      }
      if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || "HTTP " + res.status);
      if (data.noop) {
        setCfgHint("数据来源已经是这一档，无需切换。");
        setSwitching(false);
        return;
      }
      setSwitchOp(data.operation || null);
      const deadline = Date.now() + SWITCH_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(1500);
        if (!alive.current) return;
        try {
          const { data: now } = await readJson("dshana/settings");
          const op = now && now.operation;
          if (!op) continue;
          setSwitchOp(op);
          if (op.state === "succeeded") {
            await loadConfig();
            setCfgHint("数据来源已切换。");
            setSwitching(false);
            return;
          }
          if (op.state === "failed") {
            setCfgWarn(true);
            setCfgHint("切换失败：" + (op.error || "原因未知"));
            setSwitching(false);
            return;
          }
        } catch {
          /* 切换中路由/中继可能短暂不可用，接着等 */
        }
      }
      setCfgWarn(true);
      setCfgHint("切换超时：请稍后刷新本页看结果。");
      setSwitching(false);
    } catch (e) {
      setCfgWarn(true);
      setCfgHint("切换请求失败：" + errText(e));
      setSwitching(false);
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

  const modelOpts = modelOptions(model);
  const sel = splitPicked(picked);
  const effortOptions: SelectOption[] = effortsOf(model, sel.provider, sel.model).map((e) => ({
    value: String(e.id || ""),
    label: String(e.name || e.id || ""),
  }));
  const dshReady = !!(model && model.ready !== false);
  const modelEmpty = model && model.catalog && modelOpts.length === 0;
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
        title="数据来源"
        description="DSH 用哪份数据目录。切换会重启 DSH：先预检新目录，成功之后才落盘，失败自动回到原来的源。"
      >
        <SettingRow
          label="来源"
          hint={
            sourceView && sourceView.home
              ? "当前：" + sourceView.home + (sourceView.shared ? "（共享）" : "（内置）")
              : undefined
          }
          layout="stacked"
          control={<Select ariaLabel="数据来源" value={sourceChoice} options={SOURCE_CHOICES} onChange={setSourceChoice} />}
        />
        {sourceChoice === "shared-custom" && (
          <SettingRow
            label="目录"
            hint={customPath || "选一个已有的 DSH 数据目录（不存在或不是目录会被拒）"}
            layout="stacked"
            control={
              <Button variant="secondary" onClick={() => void pickDirectory()}>
                选择目录
              </Button>
            }
          />
        )}
        {sourceChoice !== "private" && (
          <SettingRow
            label="profile"
            hint="该目录下的 profile 名（内置模式固定为 dshana）"
            layout="stacked"
            control={
              <TextInput
                ariaLabel="profile"
                value={sharedProfile}
                onChange={(e) => setSharedProfile(e.target.value)}
              />
            }
          />
        )}
        <SettingRow
          label="应用"
          hint={
            switching && switchOp && switchOp.state === "running"
              ? "正在进行：" + (STEP_LABEL[switchOp.step] || switchOp.step || "切换中")
              : cfgHint || undefined
          }
          hintVariant={cfgWarn ? "warn" : "default"}
          control={
            <Button variant="primary" loading={switching} onClick={() => void applySource()}>
              应用并重启
            </Button>
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
              label="模型"
              hint={modelHint || catalogHint || undefined}
              hintVariant={modelWarn ? "warn" : "default"}
              layout="stacked"
              control={
                <Select
                  ariaLabel="默认模型"
                  value={picked}
                  options={modelOpts}
                  disabled={modelOpts.length === 0}
                  onChange={setPicked}
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
