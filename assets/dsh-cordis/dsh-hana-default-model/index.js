// dsh-hana-default-model — 在 dsh Web UI 设置页提供「默认模型」配置分页（tab）（v0.9.5）。
//
// 语义：dsh 的 agent-default-model（settings.yaml）是任务默认模型的事实源，dsh_run
// 不显式指定时用它。dsh 设置页没有该段的配置 UI（settings.mutate 对 agent-default-model
// 段不可用——"not exposed to configuration clients"；saveDefaultModelSelection 也不是
// 独立 RPC，只在 dsh 的 session.selectModel 内部自动写回默认）。本插件补一个显式入口：
// 设置页新增「默认模型」分页，面板内容 = 三级联动表单，选项 = dsh 全部可用 provider
// （llm.models RPC，含宿主注入的 sensenova/agnes/deepseek 与 dsh 单独配置的
// deepseek-official 等），provider → model → 思考强度（reasoning.efforts，无 reasoning
// 的模型不显示思考下拉），保存即经 agentDefaultModel 服务写 settings.yaml + 更新内存态。
//
// 机制：经 dsh-host-webserver 的 tapIndex 扩展点向 index 响应注入自包含脚本（同
// dsh-hana-theme 的 BRIDGE 姿势）——脚本轮询 + MutationObserver 检测设置页模态
// （[role=dialog][aria-modal=true] 且含「设置」标题 nav，dsh SPA 设置页特征），在分页
// 导航（nav.navList，含 button.navCell tab 按钮，激活态 = aria-current + .active class）
// 末尾**追加「默认模型」tab**（复用 dsh tab 的 className/图标/标签结构，激活态与 dsh
// 一致），并在内容列（.content：header 固定 + .options 滚动区）的 .options 之后插入
// 对应面板（样式匹配 .options，默认隐藏）。点击切换走 DOM 级事件委托（document 监听，
// React 重渲染/重开后仍有效）：点自己的 tab → 隐藏 dsh 当前活动面板 + 显示自己的面板
// （并给 tab 加激活态、摘掉 dsh 原激活 tab 的高亮）；点 dsh 其他 tab → 隐藏自己的面板
// + 去掉自己 tab 的激活态，让 dsh 原生逻辑接管。React 兄弟节点间注入不被重渲染清掉
// （沿用已验证的注入姿势），关模态随 React 卸载、重开即重挂、闭包状态保留。找不到
// 分页导航容器（dsh 版本变化）时降级为不挂载并 console 提示，不破坏页面。另注册两条
// 路由：
//   POST /api/hana-default-model.read  → agentDefaultModel.currentSelection()
//   POST /api/hana-default-model.save  → agentDefaultModel.saveSelection(...)
// 路由经 webServer.register（kind: exact）注册——webserver 匹配 exact 优先于 apiproxy
// 的 /api 前缀，冲突只会发生在同 (kind, path) 重复注册（插件重载未清理场景），此时
// 降级记日志不阻断。错误统一返回 { ok:false, error } 结构。
//
// 服务依赖：export const inject = ['webServer', 'agentDefaultModel'] 声明依赖（cordis
// 服务注入经 inject 声明生效，无声明则 apply 内 ctx.webServer / ctx.agentDefaultModel
// 抛 "cannot get property ... without inject"），apply 内再经 ctx.inject 取作用域上下文。
// 容错纪律：apply 全程 try/catch 不抛出——依赖缺失/路由重复只记日志，插件降级为
// 空操作，不阻断 dsh 启动（边界要求）。注释风格同 dsh-hana-provider（中文/单引号/无分号）。

export const name = 'dsh-hana-default-model'
export const inject = ['webServer', 'agentDefaultModel']

// ---- 注入设置页 index 的样式与脚本（幂等：已注入则跳过） ----
const STYLE = `<style id="dsh-hana-default-model-css">
#dsh-hana-default-model-panel{box-sizing:border-box;flex:1;min-height:0;padding:0 24px 24px;overflow-y:auto;flex-direction:column;gap:12px;display:flex}
#dsh-hana-default-model-panel .hdm-title{color:var(--dsw-alias-label-primary,#1f2329);margin:0;font-size:16px;font-weight:500;line-height:24px}
#dsh-hana-default-model-panel .hdm-sub{color:var(--dsw-alias-label-tertiary,#8a8f98);margin:0;font-size:12px;line-height:18px}
#dsh-hana-default-model-panel .hdm-row{display:flex;align-items:center;gap:10px}
#dsh-hana-default-model-panel .hdm-label{flex:none;width:72px;color:var(--dsw-alias-label-secondary,#5a5f66);font-size:13px}
#dsh-hana-default-model-panel .hdm-select{flex:1;min-width:0;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,#d8d8d8);border-radius:8px;background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#1f2329);font-family:inherit;font-size:13px;line-height:20px}
#dsh-hana-default-model-panel .hdm-actions{display:flex;align-items:center;gap:10px;margin-top:4px}
#dsh-hana-default-model-panel .hdm-save{box-sizing:border-box;height:28px;padding:0 14px;border:none;border-radius:14px;background:var(--dsw-alias-button-primary-fill,#537d96);color:var(--dsw-alias-label-primary-foreground,#ffffff);cursor:pointer;font-family:inherit;font-size:13px;line-height:28px}
#dsh-hana-default-model-panel .hdm-save:hover{background:var(--dsw-alias-button-primary-hover,#3f6179)}
#dsh-hana-default-model-panel .hdm-save[disabled]{opacity:.6;cursor:default}
#dsh-hana-default-model-panel .hdm-status{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px}
#dsh-hana-default-model-panel .hdm-status.hdm-ok{color:var(--dsw-alias-state-success-primary,#2e7d32)}
#dsh-hana-default-model-panel .hdm-status.hdm-err{color:var(--dsw-alias-state-error-primary,#c62828)}
#dsh-hana-default-model-panel .hdm-current{margin-top:4px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,#e5e5e5);color:var(--dsw-alias-label-secondary,#5a5f66);font-size:12px;line-height:18px}
#dsh-hana-default-model-tab{flex:none}
</style>`

const BRIDGE = `<script id="dsh-hana-default-model">
(function () {
  // window 级防重：脚本体只执行一份（HMR/重复注入等路径可能重复执行），
  // 重复执行直接 return，防止 tab 重复注入/状态错乱
  if (window.__dshHanaDefaultModelInstalled) return
  window.__dshHanaDefaultModelInstalled = true
  var NS = 'dsh-hana-default-model'
  var TAB_ID = 'dsh-hana-default-model-tab'
  var PANEL_ID = 'dsh-hana-default-model-panel'
  // 固定 inline SVG 图标（芯片/模型风格）：不依赖 sample 结构（克隆 SVG 在图标嵌套
  // 较深时不可靠），viewBox/stroke 风格对齐 dsh navIcon
  var TAB_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 2.5v4M15 2.5v4M9 17.5v4M15 17.5v4M2.5 9h4M2.5 15h4M17.5 9h4M17.5 15h4"/><path d="M12 9.5v5M9.5 12h5"/></svg>'
  var groups = null
  var current = null
  var provider = ''
  var model = ''
  var effort = ''
  var busy = false
  var seq = 0
  var mounted = false
  var myTab = null
  var myPanel = null
  var navList = null
  var optionsEl = null
  var baseClass = ''
  var activeClass = ''

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
  }

  // dsh RPC 信封（同 dsh-hana-theme BRIDGE 的 settings.describe 姿势）
  function rpc(method, payload) {
    seq += 1
    return fetch('/api/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: NS + '-' + Date.now() + '-' + seq, method: method, payload: payload || {} })
    }).then(function (r) { return r.json() })
  }

  // 本插件自定义路由（纯 JSON，非 RPC 信封）
  function post(method, body) {
    return fetch('/api/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json() })
  }

  // 找设置面板：role=dialog + aria-modal + 含「设置/Settings」标题且有 nav（设置页特征）
  // 热路径（observer 每帧回调）优化：先查 nav（轻量）再聚合文本（较贵）——非设置
  // 对话框无 nav 直接跳过，不重复扫描
  function findPanel() {
    var dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
    for (var i = 0; i < dialogs.length; i++) {
      var d = dialogs[i]
      if (!d.querySelector || !d.querySelector('nav')) continue
      var txt = d.textContent || ''
      if (txt.indexOf('设置') !== -1 || txt.indexOf('Settings') !== -1) return d
    }
    return null
  }

  // 分页导航容器：panel 的直接 nav 子元素（设置面板左导航 rail）
  function findNav(panel) {
    if (!panel || !panel.children) return null
    for (var i = 0; i < panel.children.length; i++) {
      if (panel.children[i].tagName === 'NAV') return panel.children[i]
    }
    return null
  }

  // navList：nav 内含 button（tab 项）的子元素（navTitle 之后）
  function findNavList(nav) {
    if (!nav || !nav.children) return null
    for (var i = 0; i < nav.children.length; i++) {
      var c = nav.children[i]
      if (c.querySelector && c.querySelector('button')) return c
    }
    return null
  }

  // 内容列：panel 的最后一个直接子元素（div.content：header + options）
  function findContent(panel) {
    if (!panel || !panel.children || !panel.children.length) return null
    var last = panel.children[panel.children.length - 1]
    return last && last.tagName === 'DIV' ? last : null
  }

  // options：content 内活动分页内容区（header 之后；若我的面板已插入则在它前面）
  function findOptions(content) {
    if (!content || !content.children || content.children.length < 2) return null
    var last = content.children[content.children.length - 1]
    if (myPanel && last === myPanel) return content.children[content.children.length - 2]
    return last
  }

  // 捕获 dsh tab 的基础 class（未激活）与激活态 class（激活 tab 多出的类）
  function captureTabClasses(list) {
    var btns = list.querySelectorAll('button')
    if (!btns.length) return { base: '', active: '' }
    var normal = null
    var active = null
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('aria-current') === 'true') active = btns[i]
      else if (!normal) normal = btns[i]
    }
    if (!normal) normal = btns[0]
    var base = normal.className || ''
    var act = ''
    if (active) {
      var full = (active.className || '').split(/\s+/)
      var baseParts = base.split(/\s+/)
      for (var j = 0; j < full.length; j++) {
        if (full[j] && baseParts.indexOf(full[j]) === -1) { act = full[j]; break }
      }
    }
    return { base: base, active: act }
  }

  // 追加「默认模型」tab：复用 dsh tab 的 className/标签结构 + 固定 inline SVG 图标
  function buildTab(list) {
    var sample = list.querySelector('button')
    var tab = document.createElement('button')
    tab.type = 'button'
    tab.id = TAB_ID
    tab.setAttribute('data-hdm-tab', '1')
    if (sample) tab.className = sample.className || ''
    // 图标：固定 inline SVG（芯片/模型风格），不依赖 sample 结构——克隆在图标
    // 嵌套较深时不可靠（曾导致无图标），这里直接内联，可靠且风格统一
    tab.innerHTML = TAB_ICON
    var label = document.createElement('span')
    if (sample) {
      var labelSpan = sample.querySelector('span')
      if (labelSpan) label.className = labelSpan.className || ''
    }
    label.textContent = '默认模型'
    tab.appendChild(label)
    tab.title = '默认模型（agent-default-model）'
    return tab
  }

  function buildPanel() {
    var el = document.createElement('div')
    el.id = PANEL_ID
    el.style.display = 'none'
    el.innerHTML =
      '<div class="hdm-title">默认模型</div>' +
      '<div class="hdm-sub">dsh 任务默认模型（settings.yaml agent-default-model），dsh_run 不显式指定 provider/model 时使用</div>' +
      '<div class="hdm-row"><label class="hdm-label" for="hdm-provider">Provider</label><select id="hdm-provider" class="hdm-select"></select></div>' +
      '<div class="hdm-row"><label class="hdm-label" for="hdm-model">模型</label><select id="hdm-model" class="hdm-select"></select></div>' +
      '<div class="hdm-row hdm-effort-row"><label class="hdm-label" for="hdm-effort">思考强度</label><select id="hdm-effort" class="hdm-select"></select></div>' +
      '<div class="hdm-actions"><button id="hdm-save" type="button" class="hdm-save">保存</button><span class="hdm-status"></span></div>' +
      '<div class="hdm-current"></div>'
    // 事件委托：change（三级联动）+ click（保存），面板元素常驻，重渲染不清绑定
    el.addEventListener('change', function (e) {
      var t = e.target
      if (t.id === 'hdm-provider') { provider = t.value; model = ''; effort = ''; render() }
      else if (t.id === 'hdm-model') { model = t.value; effort = ''; render() }
      else if (t.id === 'hdm-effort') { effort = t.value }
    })
    el.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'hdm-save') save()
    })
    return el
  }

  function providerList() { return groups ? groups : [] }
  function modelsFor(p) {
    var list = providerList()
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === p) return list[i].models || []
    }
    return []
  }
  function modelInfo(p, m) {
    var list = modelsFor(p)
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === m) return list[i]
    }
    return null
  }

  function setStatus(msg, kind) {
    if (!myPanel) return
    var s = myPanel.querySelector('.hdm-status')
    if (!s) return
    s.textContent = msg || ''
    s.className = 'hdm-status' + (kind ? ' hdm-' + kind : '')
  }

  function render() {
    if (!myPanel) return
    var provSel = myPanel.querySelector('#hdm-provider')
    var modelSel = myPanel.querySelector('#hdm-model')
    var effortSel = myPanel.querySelector('#hdm-effort')
    var effortRow = myPanel.querySelector('.hdm-effort-row')
    var curEl = myPanel.querySelector('.hdm-current')
    if (!provSel || !modelSel || !effortSel) return
    var list = providerList()
    // provider 下拉
    provSel.innerHTML = list.map(function (g) {
      return '<option value="' + esc(g.id) + '">' + esc(g.name || g.id) + '</option>'
    }).join('')
    if (provider) {
      provSel.value = provider
      if (provSel.value !== provider) { provider = provSel.value; model = '' }
    }
    if (!provider && list.length) { provider = list[0].id; provSel.value = provider }
    // model 下拉（按 provider 联动过滤）
    var models = modelsFor(provider)
    modelSel.innerHTML = models.map(function (m) {
      return '<option value="' + esc(m.id) + '">' + esc(m.name || m.id) + '</option>'
    }).join('')
    if (model) {
      modelSel.value = model
      if (modelSel.value !== model) model = ''
    }
    if (!model && models.length) { model = models[0].id; modelSel.value = model }
    // effort 下拉（按模型 reasoning.efforts 动态填充；无 reasoning 不显示）
    var info = modelInfo(provider, model)
    var reasoning = info && info.reasoning
    if (reasoning && reasoning.efforts && reasoning.efforts.length) {
      effortRow.style.display = ''
      effortSel.innerHTML = reasoning.efforts.map(function (e) {
        return '<option value="' + esc(e.id) + '">' + esc(e.name || e.id) + '</option>'
      }).join('')
      var want = effort || reasoning.defaultEffort || ''
      if (want) effortSel.value = want
      effort = effortSel.value || ''
    } else {
      effortRow.style.display = 'none'
      effort = ''
    }
    // 当前值回显
    if (curEl) {
      curEl.textContent = current
        ? '当前默认：' + (current.provider || '?') + ' / ' + (current.model || '?') + (current.reasoningEffort ? ' / 思考 ' + current.reasoningEffort : '')
        : '当前默认：（未设置）'
    }
  }

  function save() {
    if (busy) return
    if (!provider || !model) { setStatus('请先选择 Provider 与模型', 'err'); return }
    busy = true
    setStatus('保存中…', '')
    var body = { provider: provider, model: model }
    if (effort) body.reasoningEffort = effort
    post('hana-default-model.save', body).then(function (d) {
      busy = false
      if (d && d.ok) {
        setStatus('已保存，立即生效', 'ok')
        refreshCurrent()
      } else {
        setStatus('保存失败：' + ((d && d.error) || '未知错误'), 'err')
      }
    }).catch(function (e) {
      busy = false
      setStatus('保存失败：' + (e && e.message ? e.message : String(e)), 'err')
    })
  }

  function refreshCurrent() {
    post('hana-default-model.read', {}).then(function (d) {
      if (d && d.ok && d.value) { current = d.value; applyCurrent(); render() }
    }).catch(function () {})
  }

  function applyCurrent() {
    if (!current) return
    if (current.provider) provider = current.provider
    if (current.model) model = current.model
    effort = current.reasoningEffort || ''
  }

  function loadData() {
    // llm.models：权威列表（models 页同源），groups → provider/model/effort 三级
    rpc('llm.models', {}).then(function (d) {
      var v = d && d.result && d.result.value
      if (v && Array.isArray(v.groups)) groups = v.groups
      render()
    }).catch(function () { setStatus('模型列表加载失败', 'err') })
    // 当前默认回显
    post('hana-default-model.read', {}).then(function (d) {
      if (d && d.ok && d.value) { current = d.value; applyCurrent() }
      render()
    }).catch(function () { setStatus('当前默认读取失败', 'err') })
  }

  // 激活自己的 tab：隐藏 dsh 当前活动面板，显示自己的面板，tab 加激活态
  function activateMyTab() {
    if (!myTab || !myPanel || !optionsEl) return
    if (myTab.getAttribute('aria-current') === 'true') return
    optionsEl.style.display = 'none'
    myPanel.style.display = ''
    // 摘掉 dsh 当前激活 tab 的高亮（避免双激活）
    if (navList) {
      var dshActive = navList.querySelector('button[aria-current="true"]')
      if (dshActive && dshActive !== myTab) {
        dshActive.removeAttribute('aria-current')
        dshActive.className = baseClass
      }
    }
    myTab.className = baseClass + (activeClass ? ' ' + activeClass : '')
    myTab.setAttribute('aria-current', 'true')
  }

  // 停用自己的 tab：恢复 dsh 面板显示，隐藏自己的面板（dsh 原生接管）
  function deactivateMyTab() {
    if (!myTab) return
    myTab.removeAttribute('aria-current')
    myTab.className = baseClass || myTab.className
    if (myPanel) myPanel.style.display = 'none'
    if (optionsEl) optionsEl.style.display = ''
  }

  // 重置到未激活态（重开设置面板后从非激活开始）
  function resetTab() {
    if (myTab) {
      myTab.removeAttribute('aria-current')
      myTab.className = baseClass || myTab.className
    }
    if (myPanel) myPanel.style.display = 'none'
    if (optionsEl) optionsEl.style.display = ''
  }

  function mount(panel) {
    var nav = findNav(panel)
    var list = findNavList(nav)
    var content = findContent(panel)
    if (!list || !content) {
      // 分页导航结构未找到（dsh 版本变化）：降级不挂载，console 提示（只提示一次）
      if (!mounted) console.log('[dsh-hana-default-model] 未找到设置面板分页导航（dsh 版本变化？），跳过挂载')
      return
    }
    // 幂等（DOM 为准）：navList 已有我们追加的 tab（data-hdm-tab）则复用并更新引用，
    // 不重复 append——同一 navList 永不重复注入；新模态（新 navList 无 data-hdm-tab）
    // 才 buildTab，旧模态销毁后的残留引用（myTab 指向已分离元素）被新元素替换
    var existingTab = list.querySelector('[data-hdm-tab]')
    var fresh = !existingTab
    if (existingTab) {
      myTab = existingTab
    } else {
      if (!mounted) {
        var cls = captureTabClasses(list)
        baseClass = cls.base
        activeClass = cls.active
        mounted = true
      }
      myTab = buildTab(list)
    }
    // 面板同样幂等：content 已有 #PANEL_ID 则复用，否则新建（残留引用被新元素替换）
    var existingPanel = content.querySelector('#' + PANEL_ID)
    if (existingPanel) {
      myPanel = existingPanel
    } else {
      myPanel = buildPanel()
    }
    // 更新引用（重开后 navList/content 是新元素，options 需重新捕获）
    navList = list
    var opts = findOptions(content)
    if (!opts) return
    optionsEl = opts
    // 放置到正确位置（appendChild 幂等：已在目标父级则不重复放置）
    if (myTab.parentElement !== navList) navList.appendChild(myTab)
    if (myPanel.parentElement !== content) content.appendChild(myPanel)
    // 新建（新模态）→ 重置未激活态 + 加载数据；复用（同模态重复扫描）→ 保持状态不打扰
    if (fresh) {
      resetTab()
      loadData()
    }
  }

  function unmount() {
    if (myTab && myTab.parentElement) myTab.parentElement.removeChild(myTab)
    if (myPanel && myPanel.parentElement) myPanel.parentElement.removeChild(myPanel)
  }

  // 主检测：查设置面板锚点并挂载（幂等——已挂载/无锚点立即返回），
  // 供 MutationObserver 即时回调与低频轮询兜底共用
  function scan() {
    try {
      var panel = findPanel()
      if (panel) mount(panel)
      else unmount()
    } catch (e) { /* 单轮失败不阻断 */ }
  }

  // document 级点击委托：自己 tab → 激活；分页导航内其他 tab → 停用（让 dsh 接管）
  document.addEventListener('click', function (e) {
    if (!mounted) return
    try {
      var t = e.target
      if (!t || !t.nodeType || t.nodeType !== 1) return
      var el = t
      while (el && el.nodeType === 1 && el !== document) {
        if (el === myTab) { activateMyTab(); return }
        if (el === navList) {
          var cur = t
          var btn = null
          while (cur && cur.nodeType === 1 && cur !== navList) {
            if (cur.tagName === 'BUTTON') { btn = cur; break }
            cur = cur.parentElement
          }
          if (btn && btn !== myTab) deactivateMyTab()
          return
        }
        el = el.parentElement
      }
    } catch (err) { /* 单次点击处理失败不影响 */ }
  })

  // MutationObserver 即时响应为主：设置面板打开的瞬间（navList 出现的第一观察
  // 回调）同步挂载 tab/面板，无防抖/轮询延迟；回调只做轻量锚点查询，未命中立即
  // 返回，不重复扫描（findPanel 先查 nav 再聚合文本）
  try {
    var mo = new MutationObserver(scan)
    mo.observe(document.documentElement, { childList: true, subtree: true })
  } catch (e) { /* 观察器不可用则仅靠轮询兜底 */ }

  // 低频轮询兜底（1s）：防 observer 漏检/SPA 路由切换/React 异常渲染路径；
  // 命中已挂载则跳过（幂等保持），正常路径以 observer 即时为准
  setInterval(scan, 1000)

  // 启动即扫一次（页面加载时设置面板可能已存在——如恢复会话/直接打开）
  scan()
})()
</script>`

const TAP = (html) => {
  if (html.includes('id="dsh-hana-default-model"')) return html
  return html.replace('</head>', STYLE + BRIDGE + '</head>')
}

// ---- 读请求 body（JSON）----
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1e6) {
        req.destroy(new Error('body 过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(new Error('body 不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

// ---- 写 JSON 响应 ----
function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// ---- 插件 apply：路由 + tapIndex 注入（全程容错，降级不阻断 dsh 启动）----
export function apply(ctx) {
  try {
    ctx.inject(['webServer', 'agentDefaultModel'], (httpCtx) => {
      httpCtx.effect(() => {
        const disposers = []
        const registerRoute = (path, handler) => {
          try {
            disposers.push(httpCtx.webServer.register({ kind: 'exact', path, handler }))
          } catch (e) {
            // 重复注册（插件重载未清理）：降级记日志，不阻断
            try {
              ctx.logger?.warn?.(`[dsh-hana-default-model] 路由 ${path} 注册失败：${e?.message || e}`)
            } catch { /* 日志失败不阻断 */ }
          }
        }

        // POST /api/hana-default-model.read：返回当前默认（{ provider, model, reasoningEffort? }）
        registerRoute('/api/hana-default-model.read', async (req, res) => {
          try {
            await readJsonBody(req)
            const value = httpCtx.agentDefaultModel.currentSelection()
            json(res, { ok: true, value })
          } catch (e) {
            json(res, { ok: false, error: e?.message || String(e) })
          }
        })

        // POST /api/hana-default-model.save：保存默认（reasoningEffort 空/缺省 = 不传）
        registerRoute('/api/hana-default-model.save', async (req, res) => {
          try {
            const body = await readJsonBody(req)
            const provider = typeof body?.provider === 'string' ? body.provider : ''
            const model = typeof body?.model === 'string' ? body.model : ''
            const reasoningEffort = typeof body?.reasoningEffort === 'string' && body.reasoningEffort ? body.reasoningEffort : ''
            if (!provider || !model) {
              json(res, { ok: false, error: 'provider 与 model 不能为空' })
              return
            }
            await httpCtx.agentDefaultModel.saveSelection({
              provider,
              model,
              ...(reasoningEffort ? { reasoningEffort } : {})
            })
            json(res, { ok: true })
          } catch (e) {
            json(res, { ok: false, error: e?.message || String(e) })
          }
        })

        // tapIndex 注入配置块脚本
        try {
          disposers.push(httpCtx.webServer.tapIndex(TAP))
        } catch (e) {
          try {
            ctx.logger?.warn?.(`[dsh-hana-default-model] tapIndex 注入失败：${e?.message || e}`)
          } catch { /* 日志失败不阻断 */ }
        }

        return () => {
          for (const dispose of disposers) {
            try { dispose() } catch { /* 清理失败不阻断 */ }
          }
        }
      })
    })
  } catch (e) {
    try {
      ctx.logger?.warn?.(`[dsh-hana-default-model] 插件停用：${e?.message || e}`)
    } catch { /* 日志失败不阻断 */ }
  }
}
