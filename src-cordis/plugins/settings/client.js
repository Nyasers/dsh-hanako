// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/settings 前端 client 模块（v0.13.0 由 default-model 插件改名升级并
// UI 重排；v0.18.1 统一收敛 @dsh-hanako scope，版本检查改 dsh 侧直查）：
// 设置面板「DSHana 设置」分页原生渲染——不再用 tapIndex DOM 注入，而是按 dsh client
// 插件规范注册 settings.section slot（ledger 驱动导航：ui-settings-general 的
// useSections 直接投影 ctx.slots.entries("settings.section")，注册即出现在设置面板
// 导航，无需任何 DOM hack）。本文件是 ESM 源（构建输入）：tsdown client 链
// （src-cordis/build/client-config.mjs）构建期为 package.json exports["./client"] 指向的
// client bundle 产物（学官方 dsh clientBundle 预设：intro/banner/footer 包
// window.__ModuleLoader__.load({ id, factory })，react/jsx-runtime external 走
// loader 注入模块表 require）。CSS/图标存 assets/（hs.css/gear.svg）经 ?inline 内联。
//
// 分页内容 = 设置中心式布局（同一 settings.section 内，两个并列分组卡片，不再是
// 「默认模型表单 + 版本块硬堆叠」）：
//   页头：DSHana 品牌区（图标 + 「DSHana 设置」标题）——让分页先有一个属于
//   「DSHana 设置」自身的身份，而不是一进来就是默认模型表单。
//   ① 默认模型卡片：组件语义与旧面板一致——模型列表改新版 **session/modelCatalog** RPC
//      （connection.rpc.call，dsh 0.1.2 的 ModelCatalog：provider → model → 思考强度
//      三级联动；旧 connection.api（0.1.1）已随新版 connection handle 退役——新版 handle
//      无 api 字段，vY T7b 后 connection 由 @dsh-hanako/api-bridge 的 client 载体提供）；
//      当前默认回显（POST /api/hana-settings.read）；保存
//      （POST /api/hana-settings.save）→ agentDefaultModel 服务写 settings.yaml。
//   ② DSH 版本卡片：纯展示——T7d 起 dsh 版本严格锁插件声明（更新 dsh = 更新插件
//      发版），无远端检查/更新。挂载时 POST /api/hana-settings.check-version 一次
//      （后端只回 localVersion：本地版本直读 dsh-pkg package.json，零延迟）即显示，
//      无按钮无轮询。
// 样式用 dsw CSS 变量（--dsw-alias-*），对齐设置面板原生观感（hs-* 类，设置中心：
// 页头品牌区 + 圆角分组卡片 + 卡片头分隔线 + 版本信息面板；hs 前缀 = hana-settings，
// 替代改名前的 hdm（hana-default-model）标识）。
//
// 服务注入：inject = ['slots', 'locale', 'connection']——slots（注册）、locale
// （导航 label 与文案 i18n）、connection（session/modelCatalog RPC，新版 rpc.call）。
// 自定义路由
// （read/save/check-version/request-update/update-status）不走 RPC 信封
// （不在 ApiProxy 契约内），组件里直接 fetch。

import * as react from "react";
import * as jsx_runtime from "react/jsx-runtime";
import cssText from "./assets/hs.css?inline";
import iconSvg from "./assets/gear.svg?inline";

// ---- 页头品牌图标：齿轮（设置语义，stroke 跟随 currentColor）----
// 注入方式：dangerouslySetInnerHTML（ICON 是 SVG 字符串，作 children 会被 React
// 转义成文本；注入为 HTML 才能渲染成图形）
const ICON = iconSvg; // 独立文件 assets/gear.svg（?inline 内联）


// ---- 样式：dsw CSS 变量 + 固定 data-plugin-css 注入（幂等，同 shipped 姿势）----
// 设置中心布局：滚动容器 .hs-page → 页头品牌区 .hs-header → 两个并列分组卡片
// .hs-card（卡片头 .hs-card-head 分隔线 + 内容区 .hs-card-body）。
// 类前缀 hs- = hana-settings（替代改名前的 hdm = hana-default-model）。
const CSS = cssText; // 独立文件 assets/hs.css（?inline 内联）
const tagId = "@dsh-hanako/settings/HanaSettingsSection.css";
// JSON.stringify 自带引号（选择器属性值引号），外面不能再套引号（否则 style[data-plugin-css=""...""] 非法选择器）
if (
  typeof document !== "undefined" &&
  document.querySelector(
    "style[data-plugin-css=" + JSON.stringify(tagId) + "]",
  ) === null
) {
  const tag = document.createElement("style");
  tag.dataset.plugin = "@dsh-hanako/settings";
  tag.dataset.pluginCss = tagId;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

// ---- i18n：设置命名空间字典（zh 为准，en 对照）----
// v0.13.0: NS 由 settings.hanaDefaultModel 改为 settings.hanaSettings（插件改名升级）；
// UI 重排后字典结构：nav = 页头标题，title/sub = 默认模型卡片，
// versionTitle/versionSub 等 = DSH 版本卡片。
const NS = "settings.hanaSettings";
const zh = {
  nav: "DSHana 设置",
  title: "默认模型",
  sub: "DSHana 任务默认模型（settings.yaml agent-default-model）\ndsh_run 不显式指定 provider/model 时使用",
  provider: "Provider",
  model: "模型",
  effort: "思考强度",
  save: "保存",
  saving: "保存中…",
  saved: "已保存，立即生效",
  current: "当前默认：",
  currentNone: "当前默认：（未设置）",
  loadFailed: "模型列表加载失败",
  readFailed: "当前默认读取失败",
  saveFailed: "保存失败：",
  selectFirst: "请先选择 Provider 与模型",
  unknown: "未知错误",
  // ---- DSH 版本卡片 ----
  versionTitle: "DSH 版本",
  versionSub: "DSH 版本随插件发版锁定，升级 DSH 请安装新版插件",
  versionLocal: "本地版本",
  versionNone: "未安装",
  checkFailed: "版本检查失败：",
  localMissing: "DSH 未安装（请先在 DSHana 标签页安装依赖）",
};
const en = {
  nav: "DSHana Settings",
  title: "Default Model",
  sub: "DSHana default task model (settings.yaml agent-default-model)\nused when dsh_run specifies no provider/model",
  provider: "Provider",
  model: "Model",
  effort: "Reasoning Effort",
  save: "Save",
  saving: "Saving…",
  saved: "Saved, effective immediately",
  current: "Current default: ",
  currentNone: "Current default: (unset)",
  loadFailed: "Failed to load model list",
  readFailed: "Failed to read current default",
  saveFailed: "Save failed: ",
  selectFirst: "Select a Provider and model first",
  unknown: "unknown error",
  // ---- DSH version card ----
  versionTitle: "DSH Version",
  versionSub:
    "DSH version is locked to the plugin release. Upgrade the plugin to upgrade DSH",
  versionLocal: "Local version",
  versionNone: "not installed",
  checkFailed: "Version check failed: ",
  localMissing:
    "DSH is not installed locally (install it from the DSHana tab first)",
};

// ---- 默认模型卡片：三级联动表单（设置中心分组卡片一）----
// props 组合（web-react standardKit + inject + ownerProps）：close（shell 提供，
// 本面板不用）、t（locale 选项绑定 NS）、connection（新版 connection handle，
// inject 提供——模型列表经 connection.rpc.call('/api', 'session/modelCatalog')）。
function DefaultModelBlock(props) {
  const { t, connection } = props;
  const [groups, setGroups] = react.useState(null);
  const [provider, setProvider] = react.useState("");
  const [model, setModel] = react.useState("");
  const [effort, setEffort] = react.useState("");
  const [current, setCurrent] = react.useState(null);
  const [status, setStatus] = react.useState("");
  const [statusKind, setStatusKind] = react.useState("");
  const [busy, setBusy] = react.useState(false);

  const setStatusBoth = (msg, kind) => {
    setStatus(msg || "");
    setStatusKind(kind || "");
  };

  // 加载：session/modelCatalog RPC + 当前默认回显（挂载即一次；切 tab 卸载重挂）
  react.useEffect(() => {
    let alive = true;
    const conn = connection;
    if (conn && typeof conn.rpc?.call === "function") {
      conn.rpc
        .call("/api", "session/modelCatalog", { args: {} })
        .then((response) => {
          if (!alive) return;
          const value =
            response && response.ok ? response.value : null;
          if (value && Array.isArray(value.groups)) setGroups(value.groups);
          else setStatusBoth(t("loadFailed"), "err");
        })
        .catch(() => {
          if (alive) setStatusBoth(t("loadFailed"), "err");
        });
    }
    fetch("/api/hana-settings.read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d && d.ok && d.value) setCurrent(d.value);
        else setStatusBoth(t("readFailed"), "err");
      })
      .catch(() => {
        if (alive) setStatusBoth(t("readFailed"), "err");
      });
    return () => {
      alive = false;
    };
  }, []);

  // 回显当前默认：read 到达后应用到表单（provider/model/effort 一起设——
  // React state 更新不触发 onChange，需显式联动，否则表单全空）
  react.useEffect(() => {
    if (current && current.provider) {
      setProvider(current.provider);
      if (current.model) setModel(current.model);
      if (current.reasoningEffort) setEffort(current.reasoningEffort);
    }
  }, [current]);

  // 无当前值且列表就绪：自动选第一个 provider + 第一个模型（表单始终可用，不空）
  react.useEffect(() => {
    if (!current && groups && groups.length > 0) {
      setProvider(groups[0].id);
      const ms = groups[0].models || [];
      if (ms.length > 0) {
        setModel(ms[0].id);
        setEffort((ms[0].reasoning && ms[0].reasoning.defaultEffort) || "");
      }
    }
  }, [groups, current]);

  // provider 切换：自动选中该 provider 的第一个模型 + 默认思考强度（三级联动一气呵成）
  const onProvider = (value) => {
    setProvider(value);
    const ms = modelsFor(value);
    if (ms.length > 0) {
      setModel(ms[0].id);
      setEffort((ms[0].reasoning && ms[0].reasoning.defaultEffort) || "");
    } else {
      setModel("");
      setEffort("");
    }
  };
  const onModel = (value) => {
    setModel(value);
    // 预选该模型的默认思考强度（显示与保存一致）
    const mi = modelInfo(provider, value);
    setEffort((mi && mi.reasoning && mi.reasoning.defaultEffort) || "");
  };

  const list = groups || [];
  const modelsFor = (p) => {
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].id === p) return list[i].models || [];
    }
    return [];
  };
  const modelInfo = (p, m) => {
    const ms = modelsFor(p);
    for (let i = 0; i < ms.length; i += 1) {
      if (ms[i].id === m) return ms[i];
    }
    return null;
  };
  const models = modelsFor(provider);
  const info = modelInfo(provider, model);
  const reasoning = info && info.reasoning;
  const efforts =
    reasoning && Array.isArray(reasoning.efforts)
      ? reasoning.efforts
      : null;

  // 当前值回显文本（effort 值前不加「思考强度」标签——下方下拉 label 已表意，避免冗余）
  const currentText = current
    ? t("current") +
    (current.provider || "?") +
    " / " +
    (current.model || "?") +
    (current.reasoningEffort ? " / " + current.reasoningEffort : "")
    : t("currentNone");

  const save = () => {
    if (busy) return;
    if (!provider || !model) {
      setStatusBoth(t("selectFirst"), "err");
      return;
    }
    setBusy(true);
    setStatusBoth(t("saving"), "");
    const body = { provider, model };
    if (effort) body.reasoningEffort = effort;
    fetch("/api/hana-settings.save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then((d) => {
        setBusy(false);
        if (d && d.ok) {
          setStatusBoth(t("saved"), "ok");
          // 保存成功后回读最新默认
          return fetch("/api/hana-settings.read", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          })
            .then((r2) => r2.json())
            .then((d2) => {
              if (d2 && d2.ok && d2.value) setCurrent(d2.value);
            })
            .catch(() => { });
        }
        setStatusBoth(
          t("saveFailed") + ((d && d.error) || t("unknown")),
          "err",
        );
        return null;
      })
      .catch((e) => {
        setBusy(false);
        setStatusBoth(
          t("saveFailed") + (e && e.message ? e.message : String(e)),
          "err",
        );
      });
  };

  return jsx_runtime.jsxs("section", {
    className: "hs-card",
    children: [
      jsx_runtime.jsxs("div", {
        className: "hs-card-head",
        children: [
          jsx_runtime.jsx("h2", {
            className: "hs-card-title",
            children: t("title"),
          }),
          jsx_runtime.jsx("p", {
            className: "hs-card-sub",
            children: t("sub"),
          }),
        ],
      }),
      jsx_runtime.jsxs("div", {
        className: "hs-card-body",
        children: [
          jsx_runtime.jsx("div", {
            className: "hs-row",
            children: [
              jsx_runtime.jsx("label", {
                className: "hs-label",
                htmlFor: "hs-provider",
                children: t("provider"),
              }),
              jsx_runtime.jsx("select", {
                id: "hs-provider",
                className: "hs-select",
                value: provider,
                onChange: (e) => onProvider(e.target.value),
                children: list.map((g) =>
                  jsx_runtime.jsx(
                    "option",
                    { value: g.id, children: g.name || g.id },
                    g.id,
                  ),
                ),
              }),
            ],
          }),
          jsx_runtime.jsx("div", {
            className: "hs-row",
            children: [
              jsx_runtime.jsx("label", {
                className: "hs-label",
                htmlFor: "hs-model",
                children: t("model"),
              }),
              jsx_runtime.jsx("select", {
                id: "hs-model",
                className: "hs-select",
                value: model,
                onChange: (e) => onModel(e.target.value),
                children: models.map((m) =>
                  jsx_runtime.jsx(
                    "option",
                    { value: m.id, children: m.name || m.id },
                    m.id,
                  ),
                ),
              }),
            ],
          }),
          efforts && efforts.length
            ? jsx_runtime.jsx("div", {
              className: "hs-row",
              children: [
                jsx_runtime.jsx("label", {
                  className: "hs-label",
                  htmlFor: "hs-effort",
                  children: t("effort"),
                }),
                jsx_runtime.jsx("select", {
                  id: "hs-effort",
                  className: "hs-select",
                  value:
                    effort ||
                    (reasoning && reasoning.defaultEffort) ||
                    "",
                  onChange: (e) => setEffort(e.target.value),
                  children: efforts.map((e) =>
                    jsx_runtime.jsx(
                      "option",
                      { value: e.id, children: e.name || e.id },
                      e.id,
                    ),
                  ),
                }),
              ],
            })
            : null,
          jsx_runtime.jsx("div", {
            className: "hs-actions",
            children: [
              jsx_runtime.jsx("button", {
                type: "button",
                className: "hs-save",
                disabled: busy || !provider || !model,
                onClick: save,
                children: t("save"),
              }),
              jsx_runtime.jsx("span", {
                className:
                  "hs-status" + (statusKind ? " hs-" + statusKind : ""),
                children: status,
              }),
            ],
          }),
          jsx_runtime.jsx("div", {
            className: "hs-current",
            children: currentText,
          }),
        ],
      }),
    ],
  });
}

// ---- DSH 版本卡片（设置中心分组卡片二）：纯展示——本地版本 ----
// T7d 起 check-version 只回 localVersion（dsh 版本严格锁插件声明，无远端检查/更新，
// 更新 dsh = 更新插件发版）：挂载时读一次即显示，无按钮无轮询；状态行仅在
// 异常（未安装/读取失败）时出现。
function DshVersionBlock(props) {
  const { t } = props;
  const [localVersion, setLocalVersion] = react.useState(null);
  const [status, setStatus] = react.useState("");
  const [statusKind, setStatusKind] = react.useState("");

  const setStatusBoth = (msg, kind) => {
    setStatus(msg || "");
    setStatusKind(kind || "");
  };

  // 挂载时读一次本地版本（后端只回 localVersion：直读 dsh-pkg package.json）
  react.useEffect(() => {
    let alive = true;
    fetch("/api/hana-settings.check-version", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        const v = d && d.ok && d.value ? d.value : null;
        if (v) {
          setLocalVersion(v.localVersion);
          // 后端只回 { localVersion, updateAvailable:false }，无 error 字段；
          // readLocalVersion 可能返回 null/undefined/""，统一按未安装处理
          if (!v.localVersion) {
            setStatusBoth(t("localMissing"), "err");
          }
          // 正常（本地已装）：状态行保持空——版本值已在信息行展示
        } else {
          setStatusBoth(
            t("checkFailed") + ((d && d.error) || t("unknown")),
            "err",
          );
        }
      })
      .catch((e) => {
        if (!alive) return;
        setStatusBoth(
          t("checkFailed") + (e && e.message ? e.message : String(e)),
          "err",
        );
      });
    return () => {
      alive = false;
    };
  }, []);

  return jsx_runtime.jsxs("section", {
    className: "hs-card",
    children: [
      jsx_runtime.jsxs("div", {
        className: "hs-card-head",
        children: [
          jsx_runtime.jsx("h2", {
            className: "hs-card-title",
            children: t("versionTitle"),
          }),
          jsx_runtime.jsx("p", {
            className: "hs-card-sub",
            children: t("versionSub"),
          }),
        ],
      }),
      jsx_runtime.jsxs("div", {
        className: "hs-card-body",
        children: [
          jsx_runtime.jsxs("div", {
            className: "hs-info",
            children: [
              jsx_runtime.jsx("div", {
                className: "hs-info-row",
                children: [
                  jsx_runtime.jsx("span", {
                    className: "hs-info-label",
                    children: t("versionLocal"),
                  }),
                  jsx_runtime.jsx("span", {
                    className: "hs-info-value",
                    children: localVersion || t("versionNone"),
                  }),
                ],
              }),
            ],
          }),
          // 状态整行（可换行，长错误完整显示）
          jsx_runtime.jsx("div", {
            className:
              "hs-status hs-status-line" +
              (statusKind ? " hs-" + statusKind : ""),
            children: status,
          }),
        ],
      }),
    ],
  });
}

// ---- 分页容器：设置中心式布局——页头品牌区 + 两个并列分组卡片（默认模型 / DSH 版本）----
function HanaSettingsSection(props) {
  const { t, connection } = props;
  return jsx_runtime.jsxs("div", {
    className: "hs-page",
    children: [
      jsx_runtime.jsxs("div", {
        className: "hs-header",
        children: [
          // 图标经 dangerouslySetInnerHTML 注入（ICON 是 SVG 字符串，作 children 会被转义成文本）
          jsx_runtime.jsx("div", {
            className: "hs-header-icon",
            dangerouslySetInnerHTML: { __html: ICON },
          }),
          jsx_runtime.jsx("div", {
            className: "hs-header-text",
            children: jsx_runtime.jsx("h1", {
              className: "hs-header-title",
              children: t("nav"),
            }),
          }),
        ],
      }),
      jsx_runtime.jsx(DefaultModelBlock, { t, connection }),
      jsx_runtime.jsx(DshVersionBlock, { t }),
    ],
  });
}

// ---- 客户端服务注入：slots（注册）+ locale（i18n）+ connection（llm.models）----
const inject = ["slots", "locale", "connection"];

/**
 * 客户端插件主体：注册设置命名空间字典 + 把「DSHana 设置」分页注册进
 * settings.section slot（id 驱动导航与 only 过滤，label 用 thunk 跟随 locale）。
 */
function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    "@dsh-hanako/settings: dictionaries",
  );
  const connection = ctx.get("connection");
  const injected = () => ({ connection });
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "dshana-settings",
        order: 100,
        label: () => t("nav"),
        locale: NS,
        inject: injected,
      },
      HanaSettingsSection,
    ),
  );
}

export { apply, inject };
