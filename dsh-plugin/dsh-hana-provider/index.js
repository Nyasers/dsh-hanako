// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// dsh-hana-provider — 让 dsh 直接复用 Hana 宿主的 provider 配置并完全跟随（v0.9.3）。
//
// 语义：dsh 启动器 --patch 挂载本插件后，provider 目录来自宿主配置文件
// （models.json + provider-catalog.json），而不是 dsh 自己的 profile/settings：
//   · 目录：models.json 的 providers 对象 → { baseURL, api, apiKey, models, displayName }
//   · 凭据：models.json 的 apiKey 是引用（"hana-runtime-api-key:X"），实际 api_key
//     从 provider-catalog.json 对应条目直读；catalog 缺失的 provider 跳过并记日志
//   · 跟随：宿主侧 ctx.resources.watch 感知两文件变化（bus 派发 resource.changed，
//     resourceKey 格式 local_fs:<path>）→ POST /api/hana-provider.refresh 通知刷新 →
//     重读 → handle.replace() 原子更新，JSON 解析失败保留旧配置并记日志；不动 dsh
//     自身 profile，与用户 provider 共存（本插件不再自建 fs.watch）
//   · 诊断日志：经 dsh-hana-logger 统一日志服务（inject ['hanaLogger']）写入本次插件会话
//     日志文件（宿主 patch config 注入 {{LOG_PATH}}），refresh 成功/失败/收到刷新请求
//     写入同一文件（行格式 [<HH:mm:ss.SSS>] [provider] <内容>，与宿主侧 appendLog
//     一致）；服务未就绪/写失败时静默跳过（日志失败不阻断）
//
// compat 映射（定稿）：
//   · Hana compat.thinkingFormat → pi-ai compat.thinkingFormat 直通
//   · Hana compat.supportsDeveloperRole → pi-ai compat.supportsDeveloperRole 直通
//     （boolean 时；pi-ai 在 reasoning && supportsDeveloperRole 时用 developer role，
//     未传回退检测值默认 true——sensenova 等 API 只认 system，此值必须显式传下去）
//   · reasoningProfile / reasoningReplay / hanaVideoInput / hanaAudioInput → 丢弃
//     （pi-ai openai-completions 原生处理 deepseek reasoning_content 解析与回放）
//   · 模型 xhigh: true → compat.supportsReasoningEffort: true
//   · 模型 defaultThinkingLevel → pi-ai thinking 级别（off/minimal/low/medium/high/xhigh/max）
//   · 模型 reasoning → pi-ai model reasoning；id/name/contextWindow/maxTokens/input 直通
//
// 依赖解析：插件文件位于 dsh 安装树之外（插件安装目录 dsh-plugin），Node ESM
// 裸导入无法解析 pi-ai/dsh-llm（实测 ERR_MODULE_NOT_FOUND，node_modules 沿插件文件
// 向上找、够不到数据目录 dsh-pkg）——因此经 config.dshPkgDir 指向的 dsh-pkg 按 import
// 语义解析包入口（package.json 的 exports/main，见 resolvePkgEntry）+ file:// 动态导入；
// 回退 DSH_HOME 反推（dirname(DSH_HOME)/dsh-pkg）与裸导入兜底。任何依赖不可用 →
// 插件降级为空操作并记日志，不阻断 dsh 启动。
//
// 注册：ctx.llm.registerAdapter(routes, adapter) + registerConfigurableProviders(entries)
// （settingsNs 用本插件专用名，dsh 侧无对应 settings 分节 → models 页显示为「未配置」
// 行，配置只读跟随 Hana，编辑仍发生在宿主）。stream 委托 pi-ai provider。
//
// 服务依赖（关键）：必须 export const inject = ['llm', 'webServer', 'hanaLogger'] 声明依赖
// （同 dsh-llm-pi-ai 姿势）——cordis 服务注入经 inject 声明生效，无声明则 apply 内
// ctx.llm / ctx.webServer 抛 "cannot get property llm without inject"（被下方 try/catch
// 吞掉 → 插件静默停用）。webServer 用于注册 /api/hana-provider.refresh 路由（宿主 push
// 通知入口），经 ctx.inject(['webServer'], ...) 取用；logger 为 dsh-hana-logger 统一日志
// 服务（诊断日志写入本次会话日志，参考 dsh-hana-default-model 写法）。
// 另注意：勿给模块加 default 导出——Entry 加载器提取 default 会丢具名导出（inject 失效）。
//
// 容错纪律：apply 全程 try/catch 不抛出——依赖缺失/配置缺失/解析失败只记日志，
// 插件降级为空操作，不阻断 dsh 启动（边界要求）。

export const name = 'dsh-hana-provider'
export const inject = ['llm', 'webServer', 'hanaLogger']

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000
const DEFAULT_CONTEXT_WINDOW = 262144

const DEFAULT_MAX_TOKENS = 32768
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const THINKING_FORMATS = ['openai', 'openrouter', 'deepseek', 'together', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling']
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const NS = 'dsh-hana-provider'
const DEP_SPECS = {
  piAi: '@earendil-works/pi-ai',
  piAiCompletions: '@earendil-works/pi-ai/api/openai-completions.lazy',
  piAiResponses: '@earendil-works/pi-ai/api/openai-responses.lazy',
  piAiAnthropic: '@earendil-works/pi-ai/api/anthropic-messages.lazy',
  llm: '@deepseek-ai/dsh-llm',
  timeout: '@deepseek-ai/dsh-timeout',
}

// ---- 依赖加载（见文件头「依赖解析」）----
// 解析 dsh-pkg/node_modules 内的包入口：尊重 package.json 的 exports/main。
// 不用 createRequire().resolve——pi-ai 的 exports 只有 "import" 条件，CJS resolve 会以
// "No exports main defined" 拒绝；这里按 import 语义手工解析（含 "./api/*" 通配模式）。
function resolvePkgEntry(nmDir, spec) {
  const parts = spec.split('/')
  const scoped = spec.startsWith('@')
  const name = scoped ? parts.slice(0, 2).join('/') : parts[0]
  const sub = scoped ? parts.slice(2).join('/') : parts.slice(1).join('/')
  const pkgDir = join(nmDir, ...name.split('/'))
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const exportsMap = pkg.exports
  if (exportsMap && typeof exportsMap === 'object') {
    const key = sub ? `./${sub}` : '.'
    // 先精确键，再通配模式键（如 "./api/*"）
    let entry = resolveCondition(exportsMap[key], pkgDir)
    if (!entry && sub) {
      for (const [pattern, target] of Object.entries(exportsMap)) {
        if (!pattern.includes('*')) continue
        const [prefix, suffix] = pattern.split('*')
        if (key.startsWith(prefix) && key.endsWith(suffix)) {
          const star = key.slice(prefix.length, key.length - suffix.length)
          entry = resolveCondition(target, pkgDir, star)
          if (entry) break
        }
      }
    }
    if (entry) return pathToFileURL(entry).href
  }
  return pathToFileURL(join(pkgDir, pkg.main || 'index.js')).href
}

function resolveCondition(cond, pkgDir, star) {
  if (typeof cond === 'string') return join(pkgDir, cond.replaceAll('*', star ?? ''))
  if (cond && typeof cond === 'object') {
    if (typeof cond.import === 'string') return join(pkgDir, cond.import.replaceAll('*', star ?? ''))
    if (typeof cond.default === 'string') return join(pkgDir, cond.default.replaceAll('*', star ?? ''))
    for (const value of Object.values(cond)) {
      const resolved = resolveCondition(value, pkgDir, star)
      if (resolved) return resolved
    }
  }
  return null
}

async function loadDeps(config) {
  const bases = []
  if (config && typeof config.dshPkgDir === 'string' && config.dshPkgDir) bases.push(config.dshPkgDir)
  const home = process.env.DSH_HOME
  if (home) bases.push(join(dirname(home), 'dsh-pkg'))
  const out = {}
  for (const [key, spec] of Object.entries(DEP_SPECS)) {
    let mod = null
    for (const base of bases) {
      try {
        mod = await import(resolvePkgEntry(join(base, 'node_modules'), spec))
        break
      } catch { /* 该基座不可解析，试下一个 */ }
    }
    if (mod === null) {
      // 裸导入兜底：插件若未来被置于 dsh 安装树内（node_modules 可达）仍可用
      try { mod = await import(spec) } catch { /* 依赖不可用 */ }
    }
    if (mod === null) return { error: new Error(`无法解析依赖 ${spec}（已尝试 config.dshPkgDir / DSH_HOME 基座与裸导入）`) }
    out[key] = mod
  }
  return out
}

// ---- 宿主配置直读（只读两文件，不写不改）----
function readJsonFile(path) {
  if (!existsSync(path)) return { value: null, error: `文件不存在：${path}` }
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), error: null }
  } catch (e) {
    return { value: null, error: `JSON 解析失败：${e?.message || e}` }
  }
}

// compat 映射（定稿表）：Hana 模型条目 → pi-ai Model 字段
function mapModel(raw, api) {
  const m = raw && typeof raw === 'object' ? raw : {}
  const compat = m.compat && typeof m.compat === 'object' ? m.compat : {}
  const out = {
    id: String(m.id || ''),
    name: String(m.name || m.id || ''),
    input: Array.isArray(m.input) ? m.input.filter((x) => x === 'text' || x === 'image') : ['text'],
    contextWindow: Number.isInteger(m.contextWindow) && m.contextWindow > 0 ? m.contextWindow : DEFAULT_CONTEXT_WINDOW,
    maxTokens: Number.isInteger(m.maxTokens) && m.maxTokens > 0 ? m.maxTokens : DEFAULT_MAX_TOKENS,
    reasoning: m.reasoning === true,
  }
  // defaultThinkingLevel → pi-ai thinking 级别（直通，非法值丢弃保解析不炸）
  if (typeof m.defaultThinkingLevel === 'string' && THINKING_LEVELS.includes(m.defaultThinkingLevel)) {
    out.defaultThinkingLevel = m.defaultThinkingLevel
  }
  // compat 映射仅对 openai-completions 协议生效（pi-ai 其余协议无这些开关）
  if (api === 'openai-completions') {
    const c = {}
    if (typeof compat.thinkingFormat === 'string' && THINKING_FORMATS.includes(compat.thinkingFormat)) {
      c.thinkingFormat = compat.thinkingFormat
    }
    if (m.xhigh === true) c.supportsReasoningEffort = true
    // supportsDeveloperRole 必须直通（勿丢）：pi-ai openai-completions 在
    // model.reasoning && compat.supportsDeveloperRole 时把 system 提示发成
    // developer role，未传时回退检测值（标准模型默认 true）——sensenova 等
    // 厂商 API 只认 system，Hana 配置里的 supportsDeveloperRole:false 就是要
    // 压住它；丢了会 400（实测 "developer is not one of [...]"）
    if (typeof compat.supportsDeveloperRole === 'boolean') {
      c.supportsDeveloperRole = compat.supportsDeveloperRole
    }
    if (Object.keys(c).length > 0) out.compat = c
  }
  // 丢弃：reasoningProfile / reasoningReplay /
  // hanaVideoInput / hanaAudioInput（不进入 pi-ai Model）
  return out
}

// 读两文件 → route 目录（纯数据，不依赖 pi-ai）
function readHostConfig(modelsPath, catalogPath) {
  const result = { routes: [], skipped: [], errors: [] }
  const modelsFile = readJsonFile(modelsPath)
  if (modelsFile.error) {
    result.errors.push(`models.json：${modelsFile.error}`)
    return result
  }
  const catalogFile = readJsonFile(catalogPath)
  if (catalogFile.error) {
    result.errors.push(`provider-catalog.json：${catalogFile.error}`)
    return result
  }
  const providers = modelsFile.value && modelsFile.value.providers
  const creds = (catalogFile.value && catalogFile.value.providers) || {}
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    result.errors.push('models.json 缺少 providers 对象')
    return result
  }
  for (const [id, p] of Object.entries(providers)) {
    if (!p || typeof p !== 'object') {
      result.skipped.push({ id, reason: '条目非对象' })
      continue
    }
    // 凭据规则：models.json 的 apiKey 是引用，实际 api_key 从 catalog 对应条目直读；
    // catalog 缺失的 provider 跳过并记日志（openai-codex / xai-oauth 即此情形）
    const cred = creds[id]
    const apiKey = cred && typeof cred.api_key === 'string' ? cred.api_key.trim() : ''
    if (!apiKey) {
      result.skipped.push({ id, reason: 'provider-catalog.json 无凭据（api_key）' })
      continue
    }
    const baseURL = String(p.baseUrl || (cred && cred.base_url) || '').trim()
    if (!baseURL) {
      result.skipped.push({ id, reason: 'baseURL 为空' })
      continue
    }
    const api = String(p.api || (cred && cred.api) || '').trim() || 'openai-completions'
    if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(api)) {
      result.skipped.push({ id, reason: `协议 ${api} 不支持（本插件仅 openai-completions/openai-responses/anthropic-messages）` })
      continue
    }
    const models = (Array.isArray(p.models) ? p.models : []).map((m) => mapModel(m, api)).filter((m) => m.id)
    if (models.length === 0) {
      result.skipped.push({ id, reason: 'models 列表为空' })
      continue
    }
    result.routes.push({
      id,
      displayName: id,
      baseURL,
      api,
      apiKey,
      // 补全 pi-ai Model 必需字段（协议/归属/端点/成本），与 dsh-llm-pi-ai 的
      // resolveRouteModels 同一姿势
      models: models.map((m) => ({ ...m, api, provider: id, baseUrl: baseURL, cost: NO_COST })),
    })
  }
  return result
}

// ---- 路由 HTTP 辅助（宿主 push 通知入口 /api/hana-provider.refresh 用，同 dsh-hana-default-model）----
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

function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// ---- 组装：pi-ai provider + LlmAdapter（参考 dsh-llm-pi-ai 的 buildProvider/routeAuth/apply 段）----
// 凭据由本插件直读 catalog，走 pi-ai 的 apiKey override 通道（options.apiKey 优先级最高，
// provider.auth 的 resolve 只在无 override 时被问询），因此 auth 提供最简 api-key 形状即可
function harnessApiKeyAuth(name) {
  return {
    name,
    resolve: ({ credential }) => Promise.resolve({
      auth: credential && credential.key !== undefined ? { apiKey: credential.key } : {},
      source: name,
    }),
  }
}

export async function apply(ctx, config) {
  // 全程容错：任何失败只记日志，插件降级为空操作，不阻断 dsh 启动
  try {
    const deps = await loadDeps(config)
    if (!deps || deps.error) {
      ctx.logger.error(`[dsh-hana-provider] 依赖加载失败，插件停用：${deps?.error?.message || deps?.error || '未知错误'}`)
      return
    }
    const { LlmAdapter, LlmError, CallId, ReasoningEffortId, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError, CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, QUOTA_EXCEEDED_CODE } = deps.llm
    const { createProvider, getSupportedThinkingLevels, isContextOverflow } = deps.piAi
    const { idleWatchdog, timeoutOf } = deps.timeout
    const apiFactories = {
      'openai-completions': () => deps.piAiCompletions.openAICompletionsApi(),
      'openai-responses': () => deps.piAiResponses.openAIResponsesApi(),
      'anthropic-messages': () => deps.piAiAnthropic.anthropicMessagesApi(),
    }
    const modelsPath = config && config.modelsPath
    const catalogPath = config && config.catalogPath
    if (!modelsPath || !catalogPath) {
      ctx.logger.warn('[dsh-hana-provider] 配置缺少 modelsPath/catalogPath，插件停用（patch config 未渲染？）')
      return
    }
    // 诊断日志：经 dsh-hana-logger 统一日志服务（inject ['hanaLogger']）写入本次会话日志，
    // 行格式 [<HH:mm:ss.SSS>] [provider] <内容>（与宿主侧 appendLog 一致）；
    // 服务未就绪/写失败静默（日志失败不阻断）
    let loggerSvc = null
    ctx.inject(['hanaLogger'], (logCtx) => {
      loggerSvc = logCtx.hanaLogger
    })
    const providerLog = (msg) => {
      try {
        loggerSvc?.log('provider', msg)
      } catch { /* 日志失败不阻断 */ }
    }

    // ---- 消息转换：harness message → pi-ai Context（复刻 dsh-llm-pi-ai 的
    // textOnlyContext / toPiContextWithImages / foreignAssistant 语义）----
    const flattenText = (message) => message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    const toolResultText = (blocks) => blocks.map((b) => b.type === 'text' ? b.text : b.type === 'tool-result' ? toolResultText(b.content) : '').join('')
    const parseArguments = (raw) => {
      try {
        const parsed = JSON.parse(raw)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
      } catch { /* 容忍模型畸形参数 */ }
      return {}
    }
    const emptyPiUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })
    // 历史 assistant 一律按「外来消息」转换（replay 按定稿表丢弃——pi-ai 的
    // openai-completions 实现原生处理 deepseek reasoning_content 解析与回放）
    const foreignAssistant = (message) => {
      const source = message.source && message.source.kind === 'model' ? message.source : undefined
      const content = []
      for (const block of message.content) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text })
        else if (block.type === 'reasoning') content.push({ type: 'thinking', thinking: block.text })
        else if (block.type === 'tool-call') content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) })
        else if (block.type === 'image') throw new LlmError('pi-ai 历史无法表达结构化图像输出', 'UNSUPPORTED_CONTENT')
      }
      return {
        role: 'assistant',
        content,
        api: 'dsh-foreign',
        provider: source && source.provider ? source.provider : 'dsh-foreign',
        model: source && source.model ? source.model : 'dsh-foreign',
        usage: emptyPiUsage(),
        stopReason: content.some((piece) => piece.type === 'toolCall') ? 'toolUse' : 'stop',
        timestamp: 0,
      }
    }
    const userContent = async (blocks, attachments) => {
      const content = []
      for (const block of blocks) {
        if (block.type === 'text') {
          if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        } else if (block.type === 'image') {
          const stored = await attachments.readImage(block.attachment)
          content.push({ type: 'image', data: Buffer.from(stored.data).toString('base64'), mimeType: stored.ref.mediaType })
        } else if (block.type === 'tool-result') {
          const nested = await userContent(block.content, attachments)
          if (typeof nested === 'string') {
            if (nested.length > 0) content.push({ type: 'text', text: nested })
          } else content.push(...nested)
        }
      }
      if (content.every((b) => b.type === 'text')) return content.map((b) => b.text).join('')
      return content
    }
    const piContext = (options, messages) => ({
      ...(options.system !== undefined ? { systemPrompt: options.system } : {}),
      messages,
      ...(Array.isArray(options.tools) && options.tools.length > 0 ? { tools: options.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) } : {}),
    })
    const textOnlyContext = (options) => {
      const toolNames = new Map()
      const messages = []
      for (const message of options.messages) {
        if (contentHasImage(message.content)) throw new LlmError('图像输入需要 durable attachment 服务', 'UNSUPPORTED_CONTENT')
        if (message.role === 'system') {
          messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
          continue
        }
        if (message.role === 'assistant') {
          const assistant = foreignAssistant(message)
          for (const block of assistant.content) if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
          messages.push(assistant)
          continue
        }
        const text = flattenText(message)
        const results = message.content.filter((b) => b.type === 'tool-result')
        if (text.length > 0 || results.length === 0) messages.push({ role: 'user', content: text, timestamp: 0 })
        for (const result of results) {
          messages.push({ role: 'toolResult', toolCallId: result.toolCallId, toolName: toolNames.get(result.toolCallId) ?? 'unknown', content: [{ type: 'text', text: toolResultText(result.content) || '(no output)' }], isError: result.isError ?? false, timestamp: 0 })
        }
      }
      return piContext(options, messages)
    }
    const toPiContextWithImages = async (options, attachments) => {
      const toolNames = new Map()
      const messages = []
      for (const message of options.messages) {
        if (message.role === 'system') {
          if (contentHasImage(message.content)) throw new LlmError('pi-ai 无法在历史 system 消息中表达图像', 'UNSUPPORTED_CONTENT')
          messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
          continue
        }
        if (message.role === 'assistant') {
          const assistant = foreignAssistant(message)
          for (const block of assistant.content) if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
          messages.push(assistant)
          continue
        }
        const content = await userContent(message.content.filter((b) => b.type !== 'tool-result'), attachments)
        const results = message.content.filter((b) => b.type === 'tool-result')
        if (content.length > 0 || results.length === 0) messages.push({ role: 'user', content, timestamp: 0 })
        for (const result of results) {
          const resultContent = await userContent(result.content, attachments)
          messages.push({ role: 'toolResult', toolCallId: result.toolCallId, toolName: toolNames.get(result.toolCallId) ?? 'unknown', content: typeof resultContent === 'string' ? [{ type: 'text', text: resultContent || '(no output)' }] : resultContent, isError: result.isError ?? false, timestamp: 0 })
        }
      }
      return piContext(options, messages)
    }
    const toPiContext = (options, attachments) => attachments === undefined ? textOnlyContext(options) : toPiContextWithImages(options, attachments)

    // ---- 流转换：pi-ai 事件 → harness StreamChunks（复刻 dsh-llm-pi-ai 的
    // toStreamChunks / mapUsage / mapStopReason / classifyPiAiError 语义）----
    const mapUsage = (usage) => ({
      inputTokens: usage.input,
      outputTokens: usage.output,
      ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
      ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
    })
    const classifyPiAiError = (message) => {
      if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
      if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
      if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
      if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
      if (/\b5\d\d\b/.test(message)) return 'SERVER'
      if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
      if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
      if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message) || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message) || /\bterminated\b|premature close/i.test(message)) return 'TRANSPORT'
      return 'PI_AI_ERROR'
    }
    const mapStopReason = (message, contextWindow) => {
      const piAiOverflow = isContextOverflow(message, contextWindow)
      const harnessOverflow = message.stopReason === 'error' && message.errorMessage !== undefined && isContextWindowExceededError(message.errorMessage)
      if (piAiOverflow || harnessOverflow) {
        return { kind: 'error', failure: { message: message.errorMessage ?? `pi-ai 检测到模型 "${message.model}" 上下文溢出`, code: CONTEXT_WINDOW_EXCEEDED_CODE } }
      }
      switch (message.stopReason) {
        case 'stop':
          if (message.content.length === 0) return { kind: 'error', failure: { message: `模型 "${message.model}" 返回了无内容的完成响应`, code: EMPTY_RESPONSE_CODE } }
          return { kind: 'stop' }
        case 'length': return { kind: 'max-tokens' }
        case 'toolUse': return { kind: 'tool-calls' }
        case 'aborted': return { kind: 'aborted', failure: { message: message.errorMessage ?? 'pi-ai 流被中止', code: 'ABORTED' } }
        case 'error': {
          const text = message.errorMessage ?? 'pi-ai 流错误'
          return { kind: 'error', failure: { message: text, code: classifyPiAiError(text) } }
        }
      }
    }
    const toStreamChunks = async function* (events, contextWindow) {
      const toolIds = new Map()
      for await (const event of events) {
        switch (event.type) {
          case 'start': break
          case 'text_start':
            yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
            break
          case 'text_delta':
            yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
            break
          case 'text_end':
            yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
            break
          case 'thinking_start':
            yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
            break
          case 'thinking_delta':
            yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
            break
          case 'thinking_end':
            yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
            break
          case 'toolcall_start': {
            const partial = event.partial && event.partial.content ? event.partial.content[event.contentIndex] : undefined
            const id = partial && partial.type === 'toolCall' ? partial.id : ''
            const toolName = partial && partial.type === 'toolCall' ? partial.name : ''
            toolIds.set(event.contentIndex, { id, name: toolName })
            yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
            break
          }
          case 'toolcall_delta': {
            const known = toolIds.get(event.contentIndex)
            yield { type: 'tool-call-delta', index: event.contentIndex, id: CallId(known ? known.id : ''), ...(known && known.name && known.name.length > 0 ? { name: known.name } : {}), argumentsDelta: event.delta }
            break
          }
          case 'toolcall_end':
            yield { type: 'block-end', index: event.contentIndex, block: { type: 'tool-call', id: CallId(event.toolCall.id), name: event.toolCall.name, arguments: JSON.stringify(event.toolCall.arguments) } }
            break
          case 'done':
            yield { type: 'usage', usage: mapUsage(event.message.usage) }
            yield { type: 'finish', reason: mapStopReason(event.message, contextWindow) }
            return
          case 'error':
            yield { type: 'usage', usage: mapUsage(event.error.usage) }
            yield { type: 'finish', reason: mapStopReason(event.error, contextWindow) }
            return
        }
      }
      throw new LlmError('pi-ai 事件流在 done/error 前结束', 'STREAM_CLOSED')
    }

    // ---- 推理级别校验（与 dsh-llm-pi-ai 同语义：不支持的级别在请求路径拒绝）----
    const resolveReasoningLevel = (model, effort) => {
      if (effort === undefined || effort === 'off') return undefined
      if (getSupportedThinkingLevels(model).includes(effort)) return effort
      throw new LlmError(`pi-ai provider "${model.provider}" 模型 "${model.id}" 不支持推理级别 "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT')
    }
    const reasoningInfo = (model, defaultLevel) => {
      if (!model.reasoning) return {}
      return {
        reasoning: {
          efforts: getSupportedThinkingLevels(model).map((level) => ({ id: ReasoningEffortId(level), name: level.charAt(0).toUpperCase() + level.slice(1) })),
          ...(defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) }),
        },
      }
    }

    // ---- LlmAdapter 实现（一次 snapshot 一次操作，replace 原子换快照：
    // 在飞的 stream 已捕获旧快照，配置变化只影响下一个请求）----
    class HanaProviderAdapter extends LlmAdapter {
      constructor({ snapshot, resolveAttachments }) {
        super()
        this.snapshot = snapshot
        this.resolveAttachments = resolveAttachments
      }
      replaceSnapshot(next) { this.snapshot = next }
      current() { return this.snapshot }
      routeOf(provider) {
        const route = this.current().byId.get(provider)
        if (route === undefined) throw new LlmError(`dsh-hana-provider 不持有 provider "${provider}"`, 'NO_ADAPTER')
        return route
      }
      modelOf(provider, model) {
        const route = this.routeOf(provider)
        const found = route.models.find((m) => m.id === model)
        if (found === undefined) throw new LlmError(`dsh-hana-provider: provider "${provider}" 无模型 "${model}"`, 'UNKNOWN_MODEL')
        return found
      }
      providerInfo(provider) {
        return { id: provider, name: this.routeOf(provider).displayName }
      }
      listModels(provider) {
        const route = this.routeOf(provider)
        return Promise.resolve(route.models.map((m) => ({ provider, id: m.id, name: m.name, inputModalities: [...m.input] })))
      }
      resolveModel(provider, model, _signal) {
        const m = this.modelOf(provider, model)
        const levels = getSupportedThinkingLevels(m)
        const defaultLevel = m.defaultThinkingLevel !== undefined && levels.includes(m.defaultThinkingLevel) ? m.defaultThinkingLevel : undefined
        return Promise.resolve({
          provider,
          id: model,
          name: m.name,
          inputModalities: [...m.input],
          context: { contextWindow: m.contextWindow },
          ...(m.maxTokens ? { defaultMaxTokens: m.maxTokens } : {}),
          ...reasoningInfo(m, defaultLevel),
        })
      }
      async *stream(options) {
        const snapshot = this.current()
        const route = snapshot.byId.get(options.provider)
        if (route === undefined) throw new LlmError(`dsh-hana-provider 不持有 provider "${options.provider}"`, 'NO_ADAPTER')
        const model = route.models.find((m) => m.id === options.model)
        if (model === undefined) throw new LlmError(`dsh-hana-provider: provider "${options.provider}" 无模型 "${options.model}"`, 'UNKNOWN_MODEL')
        if (options.stop !== undefined) throw new LlmError('dsh-hana-provider 不支持 GenerateOptions.stop', 'UNSUPPORTED_OPTION')
        const requested = options.reasoningEffort !== undefined ? options.reasoningEffort : model.defaultThinkingLevel
        const reasoning = resolveReasoningLevel(model, requested)
        const containsImage = options.messages.some((message) => contentHasImage(message.content))
        if (containsImage && !model.input.includes('image')) throw new LlmError(`模型 "${model.id}" 不支持图像输入`, 'UNSUPPORTED_CONTENT')
        const attachments = containsImage ? this.resolveAttachments() : undefined
        if (containsImage && attachments === undefined) throw new LlmError('pi-ai 图像输入需要 durable attachment 服务', 'UNSUPPORTED_CONTENT')
        const context = attachments === undefined ? toPiContext(options) : await toPiContext(options, attachments)
        const consumer = new AbortController()
        const upstream = options.signal === undefined ? consumer.signal : AbortSignal.any([options.signal, consumer.signal])
        const watchdog = idleWatchdog(upstream, DEFAULT_STREAM_IDLE_TIMEOUT_MS, 'LLM_STREAM_IDLE_TIMEOUT')
        try {
          const provider = snapshot.providers.get(options.provider)
          const events = provider.streamSimple(model, context, {
            apiKey: route.apiKey,
            ...(reasoning === undefined ? {} : { reasoning }),
            ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
            ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
            ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
            maxRetries: 0,
            signal: watchdog.signal,
            headers: attributionHeaders(),
          })
          const iterator = toStreamChunks(events, model.contextWindow)[Symbol.asyncIterator]()
          let exhausted = false
          try {
            while (true) {
              const result = await watchdog.next(iterator)
              const timeout = timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')
              if (timeout !== undefined) throw new LlmError(`pi-ai 流空闲超时（${DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms）`, 'TIMEOUT', { cause: timeout })
              if (result.done) {
                exhausted = true
                return
              }
              yield result.value
            }
          } finally {
            if (!exhausted) {
              consumer.abort('dsh-hana-provider 流消费停止')
              try { await iterator.return(undefined) } catch { /* pi-ai SDK 拆卸失败忽略 */ }
            }
          }
        } catch (error) {
          if (timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT') !== undefined) throw new LlmError(`pi-ai 流空闲超时（${DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms）`, 'TIMEOUT', { cause: error })
          if (options.signal && options.signal.aborted) throw new LlmError('pi-ai 请求被调用方中止', 'ABORTED', { cause: error })
          throw error
        } finally {
          consumer.abort('dsh-hana-provider 流消费停止')
          try { watchdog[Symbol.dispose]() } catch { /* 双保险 */ }
        }
      }
    }

    // ---- 快照构建：读配置 → 建 provider 实例（失败仅该 route 丢弃，不拖垮整体）----
    const buildSnapshot = (host) => {
      const byId = new Map()
      const providers = new Map()
      for (const route of host.routes) {
        try {
          providers.set(route.id, createProvider({
            id: route.id,
            name: route.displayName,
            baseUrl: route.baseURL,
            auth: { apiKey: harnessApiKeyAuth(route.displayName) },
            models: route.models,
            api: apiFactories[route.api](),
          }))
          byId.set(route.id, route)
        } catch (e) {
          host.errors.push(`provider "${route.id}" 构造失败：${e?.message || e}`)
        }
      }
      return { byId, providers }
    }

    // ---- 注册状态机：首次注册，之后 replace() 原子更新（同 dsh-llm-pi-ai 姿势）----
    let adapter = null
    let registration = null
    let directory = null
    let snapshot = null

    const applySnapshot = (host) => {
      const built = buildSnapshot(host)
      const routes = [...built.byId.keys()]
      const entries = [...built.byId.values()].map((route) => ({ provider: route.id, displayName: route.displayName, settingsNs: NS, settingsPath: ['providers', route.id] }))
      // 先注册后换快照：任一步抛错（如 DUPLICATE_ADAPTER）时旧注册与旧快照原样保留
      if (registration === null) {
        // 空目录不注册（registerAdapter/registerConfigurableProviders 都拒绝空列表）
        if (routes.length > 0) {
          if (adapter === null) adapter = new HanaProviderAdapter({ snapshot: built, resolveAttachments: () => ctx.get('attachments') })
          registration = ctx.llm.registerAdapter(routes, adapter)
        }
      } else {
        registration.replace(routes)
      }
      // directory 注册前过滤与 dsh 已有 configurable provider 撞名的条目（如宿主 deepseek 与
      // dsh-llm-pi-ai 内置 configurable deepseek 同名）。registerConfigurableProviders 是
      // all-or-nothing：一个撞名整体抛错，曾导致 refresh 每次都失败、snapshot 永不更新、
      // 热跟随失效（refresh 链路本身正常）。adapter 注册不受影响（deepseek 照常可用）。
      const declared = new Set((ctx.llm.listConfigurableProviders?.() || []).map((e) => e.provider))
      const filteredEntries = entries.filter((e) => !declared.has(e.provider))
      if (directory === null) {
        if (filteredEntries.length > 0) directory = ctx.llm.registerConfigurableProviders(filteredEntries)
      } else {
        directory.replace(filteredEntries)
      }
      // 注册全部成功才原子换快照（在飞的 stream 已捕获旧快照，新请求用新快照）
      snapshot = built
      if (adapter !== null) adapter.replaceSnapshot(built)
    }

    const refresh = (source = '启动/路由') => {
      const t0 = Date.now()
      const host = readHostConfig(modelsPath, catalogPath)
      // 解析失败（文件缺失/损坏）：保留旧配置并记日志（首次则目录为空，插件静默降级）
      if (host.errors.length > 0 && host.routes.length === 0) {
        ctx.logger.warn(`[dsh-hana-provider] 读取宿主配置失败，保留旧配置：${host.errors.join('；')}`)
        providerLog(`refresh 失败（${source}）：${host.errors.join('；')}`)
        return
      }
      for (const error of host.errors) ctx.logger.warn(`[dsh-hana-provider] 宿主配置部分异常：${error}`)
      for (const skipped of host.skipped) ctx.logger.info(`[dsh-hana-provider] 跳过 provider "${skipped.id}"：${skipped.reason}`)
      try {
        applySnapshot(host)
        const modelCount = [...snapshot.byId.values()].reduce((n, r) => n + (r.models ? r.models.length : 0), 0)
        const elapsed = Date.now() - t0
        ctx.logger.info(`[dsh-hana-provider] 已同步 ${snapshot.byId.size} 个 provider（跳过 ${host.skipped.length}，异常 ${host.errors.length}）`)
        providerLog(`refresh 完成（${source}）：${snapshot.byId.size} 个 provider / ${modelCount} 个模型（跳过 ${host.skipped.length}，异常 ${host.errors.length}），耗时 ${elapsed}ms`)
      } catch (e) {
        // replace 抛错（如 DUPLICATE_ADAPTER：与用户已有 provider 同名）：保留旧注册
        ctx.logger.error(`[dsh-hana-provider] 应用配置失败，保留旧配置：${e?.message || e}`)
        providerLog(`refresh 应用失败（${source}），保留旧配置：${e?.message || e}`)
      }
    }

    // ---- 宿主 push 通知路由（v0.10.7：宿主侧 ctx.resources.watch 感知配置变化后
    // POST /api/hana-provider.refresh 通知刷新；本插件不再自建 fs.watch）----
    // 路由经 webServer.register（kind: exact）注册——webserver 匹配 exact 优先于
    // apiproxy 的 /api 前缀，冲突只发生在同 (kind, path) 重复注册（插件重载未清理场景），
    // 此时降级记日志不阻断。错误统一返回 { ok:false, error } 结构（同 dsh-hana-default-model）。
    ctx.inject(['webServer'], (httpCtx) => {
      httpCtx.effect(() => {
        const disposers = []
        const registerRoute = (path, handler) => {
          try {
            disposers.push(httpCtx.webServer.register({ kind: 'exact', path, handler }))
          } catch (e) {
            // 重复注册（插件重载未清理）：降级记日志，不阻断
            try {
              ctx.logger?.warn?.(`[dsh-hana-provider] 路由 ${path} 注册失败：${e?.message || e}`)
            } catch { /* 日志失败不阻断 */ }
          }
        }

        // POST /api/hana-provider.refresh：宿主 push 通知 → 重读配置 refresh()
        registerRoute('/api/hana-provider.refresh', async (req, res) => {
          try {
            await readJsonBody(req)
            providerLog('收到 /api/hana-provider.refresh 请求（宿主 push 通知）')
            refresh('宿主 push')
            json(res, { ok: true })
          } catch (e) {
            providerLog(`路由处理失败：${e?.message || e}`)
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

    // 启动时刷新一次（宿主 push 未建立/未触发时也有完整目录；随后靠路由通知增量刷新）
    refresh('启动')
  } catch (e) {
    // 顶层兜底：apply 永不抛出（边界要求——不阻断 dsh 启动）
    ctx.logger.error(`[dsh-hana-provider] 插件初始化失败，已降级为空操作：${e?.message || e}`)
  }
}
