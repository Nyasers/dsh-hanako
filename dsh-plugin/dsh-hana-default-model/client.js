// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// dsh-hana-default-model 前端 client 模块（v0.9.5 正规化升级）：设置面板「默认模型」
// 分页原生渲染——不再用 tapIndex DOM 注入，而是按 dsh client 插件规范注册
// settings.section slot（ledger 驱动导航：ui-settings-general 的 useSections 直接
// 投影 ctx.slots.entries("settings.section")，注册即出现在设置面板导航，无需任何
// DOM hack）。本文件是 package.json exports["./client"] 指向的 client bundle：
// window.__ModuleLoader__.load({ id, factory }) 格式（与 dsh-client-ui-* 同构），
// id 必须等于包名（boot manifest 按包名注册、/plugins/<id>/client.js 按包名寻址）。
//
// 组件语义与旧 tapIndex 面板一致：llm.models RPC（经 connection.api，宿主
// 注入的 sensenova/agnes/deepseek 与 dsh 单独配置的 deepseek-official 全量）→
// provider → model → 思考强度（reasoning.efforts，无 reasoning 的模型不显示思考
// 下拉）三级联动；当前默认回显（POST /api/hana-default-model.read）；保存
// （POST /api/hana-default-model.save）→ agentDefaultModel 服务写 settings.yaml。
// 样式用 dsw CSS 变量（--dsw-alias-*），对齐设置面板原生观感。
//
// 服务注入：inject = ['slots', 'locale', 'connection']——slots（注册）、locale
// （导航 label 与文案 i18n）、connection（llm.models RPC）。自定义路由
// （read/save）不走 RPC 信封（不在 ApiProxy 契约内），组件里直接 fetch。

window.__ModuleLoader__.load({
  id: 'dsh-hana-default-model',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ---- 依赖：seed/static 词与已注册 factory（与 dsh-client-ui-* 同构）----
    let react = require('react')
    let jsx_runtime = require('react/jsx-runtime')

    // ---- 样式：dsw CSS 变量 + 固定 data-plugin-css 注入（幂等，同 shipped 姿势）----
    const CSS = '.hdm-section{box-sizing:border-box;flex:1;min-height:0;overflow-y:auto;flex-direction:column;gap:12px;display:flex}' +
      '.hdm-title{color:var(--dsw-alias-label-primary,#1f2329);margin:0;font-size:18px;font-weight:600;line-height:26px}' +
      '.hdm-sub{color:var(--dsw-alias-label-tertiary,#8a8f98);margin:0;font-size:13px;line-height:19px;white-space:pre-line}' +
      '.hdm-row{display:flex;align-items:center;gap:10px}' +
      '.hdm-label{flex:none;width:72px;color:var(--dsw-alias-label-secondary,#5a5f66);font-size:13px}' +
      '.hdm-select{flex:1;min-width:0;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,#d8d8d8);border-radius:8px;background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#1f2329);font-family:inherit;font-size:13px;line-height:20px}' +
      '.hdm-actions{display:flex;align-items:center;gap:10px;margin-top:4px}' +
      '.hdm-save{box-sizing:border-box;height:28px;padding:0 14px;border:none;border-radius:14px;background:var(--dsw-alias-button-primary-fill,#537d96);color:var(--dsw-alias-label-primary-foreground,#ffffff);cursor:pointer;font-family:inherit;font-size:13px;line-height:28px}' +
      '.hdm-save:hover{background:var(--dsw-alias-button-primary-hover,#3f6179)}' +
      '.hdm-save[disabled]{opacity:.6;cursor:default}' +
      '.hdm-status{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px}' +
      '.hdm-status.hdm-ok{color:var(--dsw-alias-state-success-primary,#2e7d32)}' +
      '.hdm-status.hdm-err{color:var(--dsw-alias-state-error-primary,#c62828)}' +
      '.hdm-current{margin-top:4px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,#e5e5e5);color:var(--dsw-alias-label-secondary,#5a5f66);font-size:12px;line-height:18px}'
    const tagId = 'dsh-hana-default-model/DefaultModelSection.css'
    // JSON.stringify 自带引号（选择器属性值引号），外面不能再套引号（否则 style[data-plugin-css=""...""] 非法选择器）
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-hana-default-model'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ---- i18n：设置命名空间字典（zh 为准，en 对照）----
    const NS = 'settings.hanaDefaultModel'
    const zh = {
      'nav': '默认模型',
      'title': '默认模型',
      'sub': 'DSHana 任务默认模型（settings.yaml agent-default-model）\ndsh_run 不显式指定 provider/model 时使用',
      'provider': 'Provider',
      'model': '模型',
      'effort': '思考强度',
      'save': '保存',
      'saving': '保存中…',
      'saved': '已保存，立即生效',
      'current': '当前默认：',
      'currentNone': '当前默认：（未设置）',
      'loadFailed': '模型列表加载失败',
      'readFailed': '当前默认读取失败',
      'saveFailed': '保存失败：',
      'selectFirst': '请先选择 Provider 与模型',
      'unknown': '未知错误'
    }
    const en = {
      'nav': 'Default Model',
      'title': 'Default Model',
      'sub': 'DSHana default task model (settings.yaml agent-default-model)\nused when dsh_run specifies no provider/model',
      'provider': 'Provider',
      'model': 'Model',
      'effort': 'Reasoning Effort',
      'save': 'Save',
      'saving': 'Saving…',
      'saved': 'Saved, effective immediately',
      'current': 'Current default: ',
      'currentNone': 'Current default: (unset)',
      'loadFailed': 'Failed to load model list',
      'readFailed': 'Failed to read current default',
      'saveFailed': 'Save failed: ',
      'selectFirst': 'Select a Provider and model first',
      'unknown': 'unknown error'
    }

    // ---- 三级联动表单组件（settings.section 分页内容）----
    // props 组合（web-react standardKit + inject + ownerProps）：close（shell 提供，
    // 本面板不用）、t（locale 选项绑定 NS）、api（connection.api，inject 提供）。
    function DefaultModelSection(props) {
      const { t, api } = props
      const [groups, setGroups] = react.useState(null)
      const [provider, setProvider] = react.useState('')
      const [model, setModel] = react.useState('')
      const [effort, setEffort] = react.useState('')
      const [current, setCurrent] = react.useState(null)
      const [status, setStatus] = react.useState('')
      const [statusKind, setStatusKind] = react.useState('')
      const [busy, setBusy] = react.useState(false)

      const setStatusBoth = (msg, kind) => {
        setStatus(msg || '')
        setStatusKind(kind || '')
      }

      // 加载：llm.models RPC + 当前默认回显（挂载即一次；切 tab 卸载重挂）
      react.useEffect(() => {
        let alive = true
        if (api && typeof api.llm?.models === 'function') {
          api.llm.models({}).then((response) => {
            if (!alive) return
            const value = response && response.result && response.result.ok ? response.result.value : null
            if (value && Array.isArray(value.groups)) setGroups(value.groups)
            else setStatusBoth(t('loadFailed'), 'err')
          }).catch(() => {
            if (alive) setStatusBoth(t('loadFailed'), 'err')
          })
        }
        fetch('/api/hana-default-model.read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        }).then((r) => r.json()).then((d) => {
          if (!alive) return
          if (d && d.ok && d.value) setCurrent(d.value)
          else setStatusBoth(t('readFailed'), 'err')
        }).catch(() => {
          if (alive) setStatusBoth(t('readFailed'), 'err')
        })
        return () => { alive = false }
      }, [])

      // 回显当前默认：read 到达后应用到表单（provider/model/effort 一起设——
      // React state 更新不触发 onChange，需显式联动，否则表单全空）
      react.useEffect(() => {
        if (current && current.provider) {
          setProvider(current.provider)
          if (current.model) setModel(current.model)
          if (current.reasoningEffort) setEffort(current.reasoningEffort)
        }
      }, [current])

      // 无当前值且列表就绪：自动选第一个 provider + 第一个模型（表单始终可用，不空）
      react.useEffect(() => {
        if (!current && groups && groups.length > 0) {
          setProvider(groups[0].id)
          const ms = groups[0].models || []
          if (ms.length > 0) {
            setModel(ms[0].id)
            setEffort((ms[0].reasoning && ms[0].reasoning.defaultEffort) || '')
          }
        }
      }, [groups, current])

      // provider 切换：自动选中该 provider 的第一个模型 + 默认思考强度（三级联动一气呵成）
      const onProvider = (value) => {
        setProvider(value)
        const ms = modelsFor(value)
        if (ms.length > 0) {
          setModel(ms[0].id)
          setEffort((ms[0].reasoning && ms[0].reasoning.defaultEffort) || '')
        } else {
          setModel('')
          setEffort('')
        }
      }
      const onModel = (value) => {
        setModel(value)
        // 预选该模型的默认思考强度（显示与保存一致）
        const mi = modelInfo(provider, value)
        setEffort((mi && mi.reasoning && mi.reasoning.defaultEffort) || '')
      }

      const list = groups || []
      const modelsFor = (p) => {
        for (let i = 0; i < list.length; i += 1) {
          if (list[i].id === p) return list[i].models || []
        }
        return []
      }
      const modelInfo = (p, m) => {
        const ms = modelsFor(p)
        for (let i = 0; i < ms.length; i += 1) {
          if (ms[i].id === m) return ms[i]
        }
        return null
      }
      const models = modelsFor(provider)
      const info = modelInfo(provider, model)
      const reasoning = info && info.reasoning
      const efforts = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : null

      // 当前值回显文本（effort 值前不加「思考强度」标签——下方下拉 label 已表意，避免冗余）
      const currentText = current
        ? t('current') + (current.provider || '?') + ' / ' + (current.model || '?') + (current.reasoningEffort ? ' / ' + current.reasoningEffort : '')
        : t('currentNone')

      const save = () => {
        if (busy) return
        if (!provider || !model) {
          setStatusBoth(t('selectFirst'), 'err')
          return
        }
        setBusy(true)
        setStatusBoth(t('saving'), '')
        const body = { provider, model }
        if (effort) body.reasoningEffort = effort
        fetch('/api/hana-default-model.save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }).then((r) => r.json()).then((d) => {
          setBusy(false)
          if (d && d.ok) {
            setStatusBoth(t('saved'), 'ok')
            // 保存成功后回读最新默认
            return fetch('/api/hana-default-model.read', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({})
            }).then((r2) => r2.json()).then((d2) => {
              if (d2 && d2.ok && d2.value) setCurrent(d2.value)
            }).catch(() => {})
          }
          setStatusBoth(t('saveFailed') + ((d && d.error) || t('unknown')), 'err')
          return null
        }).catch((e) => {
          setBusy(false)
          setStatusBoth(t('saveFailed') + (e && e.message ? e.message : String(e)), 'err')
        })
      }

      return jsx_runtime.jsxs('div', {
        className: 'hdm-section',
        children: [
          jsx_runtime.jsx('h2', { className: 'hdm-title', children: t('title') }),
          jsx_runtime.jsx('p', { className: 'hdm-sub', children: t('sub') }),
          jsx_runtime.jsx('div', {
            className: 'hdm-row',
            children: [
              jsx_runtime.jsx('label', { className: 'hdm-label', htmlFor: 'hdm-provider', children: t('provider') }),
              jsx_runtime.jsx('select', {
                id: 'hdm-provider',
                className: 'hdm-select',
                value: provider,
                onChange: (e) => onProvider(e.target.value),
                children: list.map((g) => jsx_runtime.jsx('option', { value: g.id, children: g.name || g.id }, g.id))
              })
            ]
          }),
          jsx_runtime.jsx('div', {
            className: 'hdm-row',
            children: [
              jsx_runtime.jsx('label', { className: 'hdm-label', htmlFor: 'hdm-model', children: t('model') }),
              jsx_runtime.jsx('select', {
                id: 'hdm-model',
                className: 'hdm-select',
                value: model,
                onChange: (e) => onModel(e.target.value),
                children: models.map((m) => jsx_runtime.jsx('option', { value: m.id, children: m.name || m.id }, m.id))
              })
            ]
          }),
          efforts && efforts.length
            ? jsx_runtime.jsx('div', {
              className: 'hdm-row',
              children: [
                jsx_runtime.jsx('label', { className: 'hdm-label', htmlFor: 'hdm-effort', children: t('effort') }),
                jsx_runtime.jsx('select', {
                  id: 'hdm-effort',
                  className: 'hdm-select',
                  value: effort || (reasoning && reasoning.defaultEffort) || '',
                  onChange: (e) => setEffort(e.target.value),
                  children: efforts.map((e) => jsx_runtime.jsx('option', { value: e.id, children: e.name || e.id }, e.id))
                })
              ]
            })
            : null,
          jsx_runtime.jsx('div', {
            className: 'hdm-actions',
            children: [
              jsx_runtime.jsx('button', {
                type: 'button',
                className: 'hdm-save',
                disabled: busy || !provider || !model,
                onClick: save,
                children: t('save')
              }),
              jsx_runtime.jsx('span', { className: 'hdm-status' + (statusKind ? ' hdm-' + statusKind : ''), children: status })
            ]
          }),
          jsx_runtime.jsx('div', { className: 'hdm-current', children: currentText })
        ]
      })
    }

    // ---- 客户端服务注入：slots（注册）+ locale（i18n）+ connection（llm.models）----
    const inject = ['slots', 'locale', 'connection']

    /**
    * 客户端插件主体：注册设置命名空间字典 + 把「默认模型」分页注册进
    * settings.section slot（id 驱动导航与 only 过滤，label 用 thunk 跟随 locale）。
    */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-hana-default-model: dictionaries')
      const connection = ctx.get('connection')
      const injected = () => ({ api: connection.api })
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'default-model',
        order: 100,
        label: () => t('nav'),
        locale: NS,
        inject: injected
      }, DefaultModelSection))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  }
})
