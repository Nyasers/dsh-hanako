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
// 机制（v0.9.5 正规化升级）：分页为**原生渲染**——不再用 tapIndex DOM 注入，而是按
// dsh client 插件规范声明前端 client 模块（package.json dsh.client 字段 + exports["./client"]
// 指向 client.js），client 侧注册 settings.section slot（id "default-model"）。设置面板
// 导航 = settings.section slot ledger 的投影（ui-settings-general 的 useSections 直接
// 读 ctx.slots.entries("settings.section")），注册即自动出现 tab，点击切换/内容渲染
// 全走 dsh 原生 React 逻辑，无任何 DOM hack。本文件只保留后端半边：两条路由 +
// agentDefaultModel 服务调用；前端表单逻辑见同目录 client.js。
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

// ---- 插件 apply：路由注册（全程容错，降级不阻断 dsh 启动；前端分页见 client.js）----
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
