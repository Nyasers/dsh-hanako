// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/settings 前端 client 模块（v0.13.0 由 default-model 插件改名升级并
// UI 重排；v0.18.1 统一收敛 @dsh-hanako scope，版本检查改 dsh 侧直查）：
// 设置面板「DSHana 设置」分页原生渲染——不再用 tapIndex DOM 注入，而是按 dsh client
// 插件规范注册 settings.section slot（ledger 驱动导航：ui-settings-general 的
// useSections 直接投影 ctx.slots.entries("settings.section")，注册即出现在设置面板
// 导航，无需任何 DOM hack）。本文件是 package.json exports["./client"] 指向的
// client bundle：window.__ModuleLoader__.load({ id, factory }) 格式（与
// dsh-client-ui-* 同构），id 必须等于包名（boot manifest 按包名注册、
// /plugins/<id>/client.js 按包名寻址）。
//
// 分页内容 = 设置中心式布局（同一 settings.section 内，两个并列分组卡片，不再是
// 「默认模型表单 + 版本块硬堆叠」）：
//   页头：DSHana 品牌区（图标 + 「DSHana 设置」标题）——让分页先有一个属于
//   「DSHana 设置」自身的身份，而不是一进来就是默认模型表单。
//   ① 默认模型卡片：组件语义与旧面板一致——llm.models RPC（经 connection.api，宿主
//      注入的 sensenova/agnes/deepseek 与 dsh 单独配置的 deepseek-official 全量）→
//      provider → model → 思考强度（reasoning.efforts，无 reasoning 的模型不显示思考
//      下拉）三级联动；当前默认回显（POST /api/hana-settings.read）；保存
//      （POST /api/hana-settings.save）→ agentDefaultModel 服务写 settings.yaml。
//   ② DSH 版本卡片：@deepseek-ai/dsh 版本检查与更新（v0.18.1 起检查改 **dsh 侧直查**——
//      后端 HTTP 直查 npm registry（fetch https://registry.npmjs.org/@deepseek-ai/dsh/latest
//      的 JSON version 字段，pnpm view 语义等价；官方源失败重试 npmmirror，15s 超时，
//      v0.18.2 起不再 spawn pnpm），不再经宿主桥接；更新经 **dshana.bus 消息总线**
//      （@dsh-hanako/bridge 提供 dshanaBus 服务）发 update.request 直投宿主执行——
//      挂载时自动调一次 POST /api/hana-settings.check-version
//      （本地版本后端直读 dsh-pkg package.json 零延迟；远端版本后端 HTTP 直查，慢时
//      返回 pending 由前端轮询兜底），显示本地/最新版本与状态；「检查更新」手动刷新；
//      「更新到最新」（仅 updateAvailable 时可用，两段式确认）→ POST
//      /api/hana-settings.request-update 经总线直投宿主（v0.22.1 起替代写更新请求文件
//      与 /child/post 反向信道，均已退役；bus 未就绪返回「消息总线未连接」），宿主
//      npm i latest + 重启 web host（web host 重启窗口连接失败视为仍在更新，
//      继续轮询）；更新期间每 2s 轮询 POST /api/hana-settings.update-status
//      （读 update-result.json）直到 done/error，轮询计时器卸载时清理。
// 样式用 dsw CSS 变量（--dsw-alias-*），对齐设置面板原生观感（hs-* 类，设置中心：
// 页头品牌区 + 圆角分组卡片 + 卡片头分隔线 + 版本信息面板；hs 前缀 = hana-settings，
// 替代改名前的 hdm（hana-default-model）标识）。
//
// 服务注入：inject = ['slots', 'locale', 'connection']——slots（注册）、locale
// （导航 label 与文案 i18n）、connection（llm.models RPC）。自定义路由
// （read/save/check-version/request-update/update-status）不走 RPC 信封
// （不在 ApiProxy 契约内），组件里直接 fetch。

window.__ModuleLoader__.load({
  id: "@dsh-hanako/settings",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ---- 依赖：seed/static 词与已注册 factory（与 dsh-client-ui-* 同构）----
    let react = require("react");
    let jsx_runtime = require("react/jsx-runtime");

    // ---- 页头品牌图标：齿轮（设置语义，stroke 跟随 currentColor）----
    // 注入方式：dangerouslySetInnerHTML（ICON 是 SVG 字符串，作 children 会被 React
    // 转义成文本；注入为 HTML 才能渲染成图形）
    const ICON =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

    // ---- 样式：dsw CSS 变量 + 固定 data-plugin-css 注入（幂等，同 shipped 姿势）----
    // 设置中心布局：滚动容器 .hs-page → 页头品牌区 .hs-header → 两个并列分组卡片
    // .hs-card（卡片头 .hs-card-head 分隔线 + 内容区 .hs-card-body）。
    // 类前缀 hs- = hana-settings（替代改名前的 hdm = hana-default-model）。
    const CSS =
      ".hs-page{box-sizing:border-box;flex:1;min-height:0;overflow-y:auto;flex-direction:column;gap:14px;display:flex;padding:6px 4px 14px}" +
      // ---- 页头：DSHana 品牌区（图标 + 标题）----
      ".hs-header{display:flex;align-items:center;gap:10px;padding:2px 2px 8px}" +
      ".hs-header-icon{flex:none;width:34px;height:34px;border-radius:9px;background:var(--dsw-alias-button-primary-fill,#537d96);color:var(--dsw-alias-label-primary-foreground,#ffffff);display:flex;align-items:center;justify-content:center}" +
      ".hs-header-icon svg{width:17px;height:17px}" +
      ".hs-header-text{flex:1;min-width:0}" +
      ".hs-header-title{color:var(--dsw-alias-label-primary,#1f2329);margin:0;font-size:17px;font-weight:600;line-height:24px}" +
      // ---- 分组卡片（默认模型 / DSH 版本）：纸面分层 + 圆角 + 卡片头分隔线----
      ".hs-card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,#e5e5e5);border-radius:10px;background:var(--dsw-alias-bg-base,#ffffff);padding:14px 16px;display:flex;flex-direction:column;gap:12px}" +
      ".hs-card-head{display:flex;flex-direction:column;gap:2px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1,#f0f0f0)}" +
      ".hs-card-title{color:var(--dsw-alias-label-primary,#1f2329);margin:0;font-size:14px;font-weight:600;line-height:20px}" +
      ".hs-card-sub{color:var(--dsw-alias-label-tertiary,#8a8f98);margin:0;font-size:12px;line-height:17px;white-space:pre-line}" +
      ".hs-card-body{display:flex;flex-direction:column;gap:10px}" +
      // ---- 表单行（默认模型卡片）----
      ".hs-row{display:flex;align-items:center;gap:10px}" +
      ".hs-label{flex:none;width:72px;color:var(--dsw-alias-label-secondary,#5a5f66);font-size:13px}" +
      ".hs-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:20px}" +
      ".hs-select{flex:1;min-width:0;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,#d8d8d8);border-radius:8px;background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#1f2329);font-family:inherit;font-size:13px;line-height:20px}" +
      ".hs-select:focus{outline:none;border-color:var(--dsw-alias-button-primary-fill,#537d96)}" +
      // ---- 版本信息面板（DSH 版本卡片：本地/最新版本 双行信息块）----
      ".hs-info{display:flex;flex-direction:column;gap:8px;padding:10px 12px;background: var(--dsw-alias-bg-module-platform,#EFE8DB);border-radius:8px}" +
      ".hs-info-row{display:flex;align-items:center;justify-content:space-between;gap:12px}" +
      ".hs-info-label{flex:none;color:var(--dsw-alias-label-secondary,#5a5f66);font-size:12px}" +
      ".hs-info-value{min-width:0;color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;font-variant-numeric:tabular-nums;word-break:break-all;text-align:right}" +
      // ---- 操作区与按钮----
      ".hs-actions{display:flex;align-items:center;gap:10px}" +
      ".hs-save{box-sizing:border-box;height:28px;padding:0 14px;border:none;border-radius:14px;background:var(--dsw-alias-button-primary-fill,#537d96);color:var(--dsw-alias-label-primary-foreground,#ffffff);cursor:pointer;font-family:inherit;font-size:13px;line-height:28px}" +
      ".hs-save:hover{background:var(--dsw-alias-button-primary-hover,#3f6179)}" +
      ".hs-save[disabled]{opacity:.6;cursor:default}" +
      ".hs-btn{box-sizing:border-box;height:28px;padding:0 14px;border:1px solid var(--dsw-alias-border-l1,#d8d8d8);border-radius:14px;background:transparent;color:var(--dsw-alias-label-primary,#1f2329);cursor:pointer;font-family:inherit;font-size:13px;line-height:26px}" +
      ".hs-btn:hover{background:var(--dsw-alias-bg-hover,#f2f3f5)}" +
      ".hs-btn[disabled]{opacity:.6;cursor:default}" +
      // ---- 状态行（表单行内 = 单行截断；版本卡片整行 = 可换行 hs-status-line）----
      ".hs-status{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px}" +
      ".hs-status.hs-ok{color:var(--dsw-alias-state-success-primary,#2e7d32)}" +
      ".hs-status.hs-err{color:var(--dsw-alias-state-error-primary,#c62828)}" +
      ".hs-status.hs-info{color:var(--dsw-alias-label-secondary,#5a5f66)}" +
      ".hs-status-line{white-space:pre-wrap;word-break:break-all}" +
      ".hs-current{margin-top:2px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,#f0f0f0);color:var(--dsw-alias-label-secondary,#5a5f66);font-size:12px;line-height:18px}";
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
      versionSub:
        "@deepseek-ai/dsh 版本检查与更新（检查 DSH 侧直查远端 registry，结果与 dsh_update 工具 / DSHana 标签页一致）",
      versionLocal: "本地版本",
      versionLatest: "最新版本",
      versionNone: "未安装",
      versionUnknown: "未知",
      check: "检查更新",
      checking: "检查中…",
      upToDate: "已是最新版本",
      updateAvailableMsg: "可更新至 v",
      checkFailed: "版本检查失败：",
      localMissing: "本地未安装 DSH（依赖缺失，请先在 DSHana 标签页安装）",
      update: "更新到最新",
      updateConfirm: "更新将重启 DSHana，正在执行的任务会中断，确定继续？",
      updateConfirmShort: "再次点击确认更新",
      updatingMsg: "更新中…（将重启 DSHana，正在执行的任务会中断）",
      updateDone: "更新完成 v",
      restartNote: "，请重启 DSHana 使完全生效",
      updateFailed: "更新失败：",
      updateTimeout:
        "更新超时：web host 长时间不可达，请检查 DSHana 标签页诊断",
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
        "@deepseek-ai/dsh version check & update (check queries the registry directly from DSH, same result as dsh_update tool / DSHana tab)",
      versionLocal: "Local version",
      versionLatest: "Latest version",
      versionNone: "not installed",
      versionUnknown: "unknown",
      check: "Check updates",
      checking: "Checking…",
      upToDate: "Up to date",
      updateAvailableMsg: "Update available: v",
      checkFailed: "Version check failed: ",
      localMissing:
        "DSH is not installed locally (install it from the DSHana tab first)",
      update: "Update to latest",
      updateConfirm:
        "Updating will restart DSHana and interrupt running tasks. Continue?",
      updateConfirmShort: "Click again to confirm",
      updatingMsg:
        "Updating… (DSHana will restart, running tasks will be interrupted)",
      updateDone: "Update complete v",
      restartNote: ". Please restart DSHana for full effect",
      updateFailed: "Update failed: ",
      updateTimeout:
        "Update timed out: web host unreachable for too long, check the DSHana tab diagnostics",
    };

    // ---- 默认模型卡片：三级联动表单（设置中心分组卡片一）----
    // props 组合（web-react standardKit + inject + ownerProps）：close（shell 提供，
    // 本面板不用）、t（locale 选项绑定 NS）、api（connection.api，inject 提供）。
    function DefaultModelBlock(props) {
      const { t, api } = props;
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

      // 加载：llm.models RPC + 当前默认回显（挂载即一次；切 tab 卸载重挂）
      react.useEffect(() => {
        let alive = true;
        if (api && typeof api.llm?.models === "function") {
          api.llm
            .models({})
            .then((response) => {
              if (!alive) return;
              const value =
                response && response.result && response.result.ok
                  ? response.result.value
                  : null;
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
                .catch(() => {});
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

    // ---- DSH 版本卡片：@deepseek-ai/dsh 版本检查与更新（设置中心分组卡片二）----
    // v0.18.1 起检查改 **dsh 侧直查**：本分页 POST /api/hana-settings.check-version，
    // 后端 HTTP 直查 npm registry（fetch https://registry.npmjs.org/@deepseek-ai/dsh/latest
    // 的 JSON version 字段，pnpm view 语义等价；官方源失败重试 npmmirror，15s 超时，
    // v0.18.2 起不再 spawn pnpm）→ 返回 { localVersion, latestVersion,
    // updateAvailable, error? }；本地版本后端直读 dsh-pkg package.json（零延迟，
    // 挂载即显示）。不再写 update-request.json / 读 check-result.json（v0.18.1 起
    // 废弃宿主桥接——resources.watch 链路不可靠曾致检查永不完成）。
    // 返回 value 形状：{ localVersion, latestVersion?, updateAvailable?, error? } 或
    // { state:'pending', localVersion }（后端 HTTP 查询慢时前端轮询兜底——保留 pending
    // 分支，applyCheck 语义不变）。
    // 挂载时自动检查一次：先拿到本地版本即时显示，pending 则每 1.5s 轮询
    // check-version 直至结果（CHECK_POLL_MAX 次上限，防查询慢/异常时无限轮询）。
    // 「更新到最新」→ request-update（宿主 5s 轮询到后 npm i latest + 重启 web host）→
    // 每 2s 轮询 update-status 直到 done/error；web host 重启窗口连接失败（fetch reject /
    // 非 ok 响应）视为仍在更新，连续失败超过 UPDATE_POLL_MAX_FAILURES 次才放弃。
    const CHECK_POLL_INTERVAL_MS = 1500;
    const CHECK_POLL_MAX = 12;
    const UPDATE_POLL_INTERVAL_MS = 2000;
    // web host 更新期间全程停机（closeProcess → npm i → 重启），轮询会持续连接失败；
    // 上限 300 次（10 分钟）——覆盖慢速网络下 npm i 数分钟 + 重启窗口，仅当 web host
    // 长时间不回来（更新彻底失败且未重启）才放弃
    const UPDATE_POLL_MAX_FAILURES = 300;
    function DshVersionBlock(props) {
      const { t } = props;
      const [checking, setChecking] = react.useState(false);
      const [updating, setUpdating] = react.useState(false);
      const [armUpdate, setArmUpdate] = react.useState(false);
      const armTimerRef = react.useRef(null);
      const [localVersion, setLocalVersion] = react.useState(null);
      const [latestVersion, setLatestVersion] = react.useState(null);
      const [updateAvailable, setUpdateAvailable] = react.useState(false);
      const [status, setStatus] = react.useState("");
      const [statusKind, setStatusKind] = react.useState("");
      const pollTimerRef = react.useRef(null);

      const setStatusBoth = (msg, kind) => {
        setStatus(msg || "");
        setStatusKind(kind || "");
      };

      const stopPoll = () => {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
      };

      // 卸载清理轮询计时器（切 tab 卸载时不再轮询）
      react.useEffect(() => {
        return () => stopPoll();
      }, []);

      const doCheck = () => {
        return fetch("/api/hana-settings.check-version", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
          .then((r) => r.json())
          .catch((e) => ({
            ok: false,
            error: e && e.message ? e.message : String(e),
          }));
      };

      // 应用一次 check-version 结果；返回 'pending'（宿主检查未完成，需继续轮询）或 'done'
      const applyCheck = (d) => {
        if (d && d.ok && d.value) {
          const v = d.value;
          // 本地版本后端直读 dsh-pkg，即时可用（pending 态也带上）
          setLocalVersion(v.localVersion);
          if (v.state === "pending") {
            setStatusBoth(t("checking"), "info");
            return "pending";
          }
          setLatestVersion(v.latestVersion);
          setUpdateAvailable(v.updateAvailable === true);
          if (v.error) {
            setStatusBoth(t("checkFailed") + v.error, "err");
          } else if (v.localVersion === null) {
            setStatusBoth(t("localMissing"), "err");
          } else if (v.updateAvailable === true) {
            setStatusBoth(
              t("updateAvailableMsg") + (v.latestVersion || "?"),
              "ok",
            );
          } else {
            setStatusBoth(t("upToDate"), "ok");
          }
          return "done";
        }
        setStatusBoth(
          t("checkFailed") + ((d && d.error) || t("unknown")),
          "err",
        );
        return "done";
      };

      // 统一检查入口：一次 check-version，pending 则轮询直至结果（或达上限）。
      // 返回 Promise（结束时 resolve，永 reject——doCheck 内部已 catch）
      const checkWithPoll = () => {
        return new Promise((resolve) => {
          doCheck().then((d) => {
            if (applyCheck(d) !== "pending") {
              resolve();
              return;
            }
            stopPoll();
            let attempts = 0;
            pollTimerRef.current = setInterval(() => {
              attempts += 1;
              doCheck().then((d2) => {
                if (
                  applyCheck(d2) !== "pending" ||
                  attempts >= CHECK_POLL_MAX
                ) {
                  stopPoll();
                  resolve();
                }
              });
            }, CHECK_POLL_INTERVAL_MS);
          });
        });
      };

      // 挂载时自动检查一次：本地版本即时显示，远端经桥接（pending 轮询直至结果）
      react.useEffect(() => {
        let alive = true;
        checkWithPoll().then(() => {
          if (alive) return;
        });
        return () => {
          alive = false;
          stopPoll();
        };
      }, []);

      const onCheck = () => {
        if (checking || updating) return;
        setChecking(true);
        setStatusBoth(t("checking"), "info");
        checkWithPoll()
          .then(() => setChecking(false))
          .catch(() => setChecking(false));
      };

      const onUpdate = () => {
        if (updating || !updateAvailable) return;
        if (!armUpdate) {
          // 两段式确认：宿主沙箱 iframe 无 allow-modals，window.confirm 被浏览器忽略
          // （Ignored call to 'confirm()'），改二次点击确认；5s 无操作自动复位
          setArmUpdate(true);
          clearTimeout(armTimerRef.current);
          armTimerRef.current = setTimeout(() => setArmUpdate(false), 5000);
          return;
        }
        clearTimeout(armTimerRef.current);
        setArmUpdate(false);
        setUpdating(true);
        setStatusBoth(t("updatingMsg"), "info");
        fetch("/api/hana-settings.request-update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
          .then((r) => r.json())
          .then((d) => {
            if (!d || !d.ok) {
              setUpdating(false);
              setStatusBoth(
                t("updateFailed") + ((d && d.error) || t("unknown")),
                "err",
              );
              return;
            }
            // 每 2s 轮询 update-status 直到 done/error；web host 重启窗口连接失败视为仍在更新
            let failures = 0;
            stopPoll();
            pollTimerRef.current = setInterval(() => {
              fetch("/api/hana-settings.update-status", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
              })
                .then((r) => r.json())
                .then((d2) => {
                  if (!d2 || !d2.ok) {
                    failures += 1;
                    if (failures > UPDATE_POLL_MAX_FAILURES) {
                      stopPoll();
                      setUpdating(false);
                      setStatusBoth(
                        t("updateFailed") + t("updateTimeout"),
                        "err",
                      );
                    }
                    return;
                  }
                  const v = d2.value || {};
                  if (v.state === "done") {
                    stopPoll();
                    setUpdating(false);
                    setStatusBoth(
                      t("updateDone") + (v.version || "?") + t("restartNote"),
                      "ok",
                    );
                    // 更新完成：刷新版本信息（新 web host 已起，读到新本地版本）
                    doCheck().then((c) => {
                      if (c && c.ok && c.value) {
                        setLocalVersion(c.value.localVersion);
                        setLatestVersion(c.value.latestVersion);
                        setUpdateAvailable(c.value.updateAvailable === true);
                      }
                    });
                  } else if (v.state === "error") {
                    stopPoll();
                    setUpdating(false);
                    setStatusBoth(
                      t("updateFailed") + (v.error || t("unknown")),
                      "err",
                    );
                  }
                  // state 'updating'/'idle'：继续轮询
                })
                .catch(() => {
                  // web host 重启窗口连接失败：继续轮询（连续失败超上限才放弃）
                  failures += 1;
                  if (failures > UPDATE_POLL_MAX_FAILURES) {
                    stopPoll();
                    setUpdating(false);
                    setStatusBoth(
                      t("updateFailed") + t("updateTimeout"),
                      "err",
                    );
                  }
                });
            }, UPDATE_POLL_INTERVAL_MS);
          })
          .catch((e) => {
            setUpdating(false);
            setStatusBoth(
              t("updateFailed") + (e && e.message ? e.message : String(e)),
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
                  jsx_runtime.jsxs("div", {
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
                  jsx_runtime.jsxs("div", {
                    className: "hs-info-row",
                    children: [
                      jsx_runtime.jsx("span", {
                        className: "hs-info-label",
                        children: t("versionLatest"),
                      }),
                      jsx_runtime.jsx("span", {
                        className: "hs-info-value",
                        children: latestVersion || t("versionUnknown"),
                      }),
                    ],
                  }),
                ],
              }),
              // 状态整行（可换行，长错误/更新进度完整显示）
              jsx_runtime.jsx("div", {
                className:
                  "hs-status hs-status-line" +
                  (statusKind ? " hs-" + statusKind : ""),
                children: status,
              }),
              jsx_runtime.jsx("div", {
                className: "hs-actions",
                children: [
                  jsx_runtime.jsx("button", {
                    type: "button",
                    className: "hs-btn",
                    disabled: checking || updating,
                    onClick: onCheck,
                    children: t("check"),
                  }),
                  jsx_runtime.jsx("button", {
                    type: "button",
                    className: "hs-save",
                    disabled: !updateAvailable || checking || updating,
                    onClick: onUpdate,
                    children: armUpdate ? t("updateConfirmShort") : t("update"),
                  }),
                ],
              }),
            ],
          }),
        ],
      });
    }

    // ---- 分页容器：设置中心式布局——页头品牌区 + 两个并列分组卡片（默认模型 / DSH 版本）----
    function HanaSettingsSection(props) {
      const { t, api } = props;
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
          jsx_runtime.jsx(DefaultModelBlock, { t, api }),
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
      const injected = () => ({ api: connection.api });
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

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
