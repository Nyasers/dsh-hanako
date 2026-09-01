// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/api-bridge — 免鉴权 connection 等价服务 + /api HTTP 载体
//
// 为什么存在：dshana profile 不装官方 @deepseek-ai/dsh-client-connection（其 BrowserAuth
// token/cookie 鉴权面 + Host/Origin fence 是「拔鉴权墙」的目标），但 dsh 数据面全挂在
// connection 的服务面上——gateway（dsh-api-remotes / typert）经 ctx.inject(['connection'])
// 激活并注册 interceptor，SPA 的 /api 一元 RPC 和 remote.mux 事件流都依赖它。官方 connection
// 的鉴权写死（Config 无开关）且包不在 dsh-base 依赖树，故本插件提供**同名 'connection' 服务**
// （requestRejection 恒 undefined = 免 401/403），并自挂 /api HTTP 载体（信封解析 →
// interceptor 分发 → server-response，协议与官方 rpcFetchHandler 完全一致）。
//
// 效果：gateway 与全部 api-* 插件零改动照常激活；remote.mux WS 由 gateway 自带（其 handler
// 调 connection.requestRejection 得 undefined → 放行）；SPA 直连 /api/* 免 token/cookie。
// bridge 的总线 RPC 自环（fetch /api/*）同样恢复。
//
// 接口面（对齐官方 HostConnectionHandle，见 deepseek-harness
// packages/client/connection/src/rpc.ts / rpc-host.ts）：
//   rpc.handle(channel, handler)        独立 channel 前缀路由（官方同语义）
//   rpc.intercept(channel, matches, handler)  共享通道 endpoint 认领 + 分发（gateway 用）
//   fetch.register(route)              精确 Fetch 路由（session 日志下载等非 JSON 端点）
//   requestRejection() → undefined     免鉴权核心（官方返回 401/403 处）
//   authorizeIndex() → true            根路径放行（无 token/cookie）
//   authenticatedUrl(u) → u            无 token 原样返回
//   state / reconnect / rpc.call / rpc.open  空实现（host 侧无消费方；client 侧浏览器不用本服务）
//
// 兼容：dsh 0.1.2 Remote payload 要求 { args } 信封（bridge 翻译器同款）；server-response
// 信封 { type, rpcId, result: { ok, value|error } } 与官方完全一致。
// 容错纪律：apply 全程 try/catch 不抛出——依赖缺失/路由重复只记日志，插件降级为空操作，
// 不阻断 dsh 启动。注释风格同 @dsh-hanako/provider（中文/单引号/无分号）。

export const name = '@dsh-hanako/api-bridge'
/** 依赖 webserver（注册 /api 载体）；connection 服务在 apply 同步段 provide（尽早可用）。 */
export const inject = ['webServer']

const API_PATH = '/api'
// 与官方 connection 同款上限（图片 base64 膨胀 + 信封余量）
const MAX_BODY_BYTES = 300 * 1024 * 1024
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/

// ---- 注册表（模块级单实例，与官方 HostConnectionService 同语义）----
// interceptors: channel -> { matches, handler }（共享通道，gateway 经此注册 /api）
// fetchRoutes: pathname -> { methods: Set, fetch }（精确 Fetch 路由）
// handleRoutes: channel -> handler（独立 channel 前缀路由）
const interceptors = new Map()
const fetchRoutes = new Map()
const handleRoutes = new Map()

function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(channel + '/')) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (
    segments.some(
      (s) => s === '' || s === '.' || s === '..' || !ENDPOINT_SEGMENT_PATTERN.test(s),
    )
  ) {
    return undefined
  }
  return endpoint
}

/** 读满请求体（限长；超限 413 并销毁连接，同官方 http-bridge 语义）。 */
async function readBody(req, res) {
  const chunks = []
  let received = 0
  for await (const chunk of req) {
    received += chunk.length
    if (received > MAX_BODY_BYTES) {
      res.writeHead(413, { connection: 'close' })
      res.end()
      req.destroy()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** 一元 RPC 分发（复刻官方 rpcFetchHandler + createSharedFetchHandler 的 /api 段，去鉴权）。 */
async function dispatchApiRpc(req, res, pathname) {
  if (req.method !== 'POST') {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const endpoint = endpointFromPath(API_PATH, pathname)
  const interceptor = interceptors.get(API_PATH)
  if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const mediaType = String(req.headers['content-type'] || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  if (mediaType !== 'application/json') {
    res.writeHead(415)
    res.end('content type must be application/json')
    return
  }
  const raw = await readBody(req, res)
  if (raw === null) return
  let body
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  // 信封校验（clientRequestSchema 语义）
  if (
    !body ||
    typeof body !== 'object' ||
    body.type !== 'client-request' ||
    typeof body.rpcId !== 'string' ||
    typeof body.method !== 'string'
  ) {
    res.writeHead(400)
    res.end('invalid client-request message')
    return
  }
  if (body.method !== endpoint) {
    res.writeHead(400)
    res.end(
      JSON.stringify({
        type: 'server-response',
        rpcId: body.rpcId,
        result: {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
            details: {},
          },
        },
      }),
    )
    return
  }
  // 客户端断开中止（同官方 http-bridge：挂 res 'close'，writableEnded 区分正常收尾）
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  let result
  try {
    result = await interceptor.handler(endpoint, body.payload ?? {}, abort.signal)
  } catch (e) {
    result = {
      ok: false,
      error: {
        code: 'api-bridge/dispatch',
        message: String((e && e.message) || e),
        details: {},
      },
    }
  }
  try {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
  } catch {
    /* 客户端已关：忽略 */
  }
}

/** 精确 Fetch 路由分发（session 日志下载等 GET/HEAD 非 JSON 端点）。 */
async function dispatchFetchRoute(req, res, route) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const request = new Request(new URL(req.url || '/', 'http://dsh.internal'), {
    method: req.method || 'GET',
    headers: req.headers,
    ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
  })
  const response = await route.fetch(request)
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (response.body === null) {
    res.end()
    return
  }
  for await (const chunk of response.body) {
    if (!res.write(chunk)) {
      await new Promise((resolve) => {
        const done = () => {
          res.off('drain', done)
          res.off('close', done)
          resolve()
        }
        res.once('drain', done)
        res.once('close', done)
      })
    }
  }
  res.end()
}

/** /api 前缀载体入口：精确 Fetch 路由优先，其次一元 RPC（免鉴权）。 */
async function handleApi(req, res) {
  const pathname = new URL(req.url || '/', 'http://dsh.internal').pathname
  const route = fetchRoutes.get(pathname)
  if (route && route.methods.has(req.method)) {
    await dispatchFetchRoute(req, res, route)
    return
  }
  await dispatchApiRpc(req, res, pathname)
}

// ---- connection 等价服务（免鉴权核心：requestRejection 恒 undefined）----
// 官方 HostConnectionService 以 super(ctx, 'connection') 注册服务名；这里 provide 同名。
const connection = {
  rpc: {
    /** 独立 channel 前缀路由（官方 assertChannel 排除 /api；/api 是共享通道走 intercept）。 */
    handle(channel, handler) {
      if (!CHANNEL_PATTERN.test(channel) || channel === API_PATH) {
        throw new Error(`api-bridge: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
      }
      if (handleRoutes.has(channel)) {
        throw new Error(`api-bridge: channel ${JSON.stringify(channel)} is already registered`)
      }
      handleRoutes.set(channel, handler)
      return () => {
        if (handleRoutes.get(channel) === handler) handleRoutes.delete(channel)
      }
    },
    /** 共享通道 endpoint 认领 + 分发（gateway 经此注册 /api；返回退订函数）。 */
    intercept(channel, matches, handler) {
      if (interceptors.has(channel)) {
        throw new Error(`api-bridge: channel ${JSON.stringify(channel)} is already intercepted`)
      }
      const entry = { matches, handler }
      interceptors.set(channel, entry)
      return () => {
        if (interceptors.get(channel) === entry) interceptors.delete(channel)
      }
    },
    /** host 侧无消费方（client 侧浏览器走 HTTP，不经本服务）——防御性拒绝。 */
    call() {
      return Promise.resolve({
        ok: false,
        error: { code: 'api-bridge/not-supported', message: 'rpc.call is client-side only', details: {} },
      })
    },
    /** 进程内流载体未实现（host 侧无消费方）。 */
    open() {
      return undefined
    },
  },
  fetch: {
    register(route) {
      if (!route || typeof route.path !== 'string' || !Array.isArray(route.methods) || typeof route.fetch !== 'function') {
        throw new Error('api-bridge: invalid Fetch route')
      }
      if (fetchRoutes.has(route.path)) {
        throw new Error(`api-bridge: Fetch route ${route.path} is already registered`)
      }
      fetchRoutes.set(route.path, { methods: new Set(route.methods), fetch: route.fetch })
      return () => {
        if (fetchRoutes.has(route.path)) fetchRoutes.delete(route.path)
      }
    },
  },
  // 免鉴权核心：官方在此返回 403（Host/Origin fence）/ 401（cookie 校验），恒放行。
  requestRejection() {
    return undefined
  },
  // index 根路径放行（无 token 换发；/ 由 @dsh-hanako/web-app serve）
  authorizeIndex() {
    return true
  },
  // 无 launchToken：URL 原样（不带 ?token=）
  authenticatedUrl(baseUrl) {
    return baseUrl
  },
  // client 侧（浏览器 bundle）才消费 state/reconnect；host 侧提供占位。
  state: { status: 'ready', connected: false },
  reconnect() {
    /* no-op（host 侧） */
  },
}

/** 独立 channel 路由分发（非 /api channel，防御实现：信封语义同 /api）。 */
async function handleChannelReq(req, res, channel) {
  const handler = handleRoutes.get(channel)
  const pathname = new URL(req.url || '/', 'http://dsh.internal').pathname
  const endpoint = endpointFromPath(channel, pathname)
  if (req.method !== 'POST' || handler === undefined || endpoint === undefined) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const raw = await readBody(req, res)
  if (raw === null) return
  let body
  try {
    body = JSON.parse(raw.toString('utf8'))
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  if (!body || typeof body !== 'object' || body.type !== 'client-request' || typeof body.rpcId !== 'string') {
    res.writeHead(400)
    res.end('invalid client-request message')
    return
  }
  let result
  try {
    result = await handler(endpoint, body.payload ?? {}, undefined)
  } catch (e) {
    result = {
      ok: false,
      error: { code: 'api-bridge/handle', message: String((e && e.message) || e), details: {} },
    }
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result }))
}

export function apply(ctx, config) {
  try {
    // connection 服务在 apply 同步段 provide（与官方 Service 基类构造即注册同语义，
    // 保证 gateway 的 inject(['connection']) 回调不落空）。
    const provideDisposer = ctx.provide('connection', connection)
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => {
        const disposers = []
        // /api 共享通道载体（一元 RPC + 精确 Fetch 路由）
        if (webCtx.webServer && typeof webCtx.webServer.register === 'function') {
          try {
            disposers.push(
              webCtx.webServer.register({
                kind: 'prefix',
                path: API_PATH,
                handler: (req, res) => {
                  handleApi(req, res).catch(() => {
                    try {
                      res.writeHead(500)
                      res.end('api-bridge handler failure')
                    } catch {
                      /* 已关 */
                    }
                  })
                },
              }),
            )
          } catch (e) {
            ctx.logger?.warn?.('[@dsh-hanako/api-bridge] /api 路由注册失败：' + ((e && e.message) || e))
          }
        } else {
          ctx.logger?.warn?.('[@dsh-hanako/api-bridge] webServer.register 不可用（宿主版本过旧），/api 载体不可用')
        }
        return () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose()
            } catch {
              /* 注销失败忽略 */
            }
          }
          try {
            provideDisposer()
          } catch {
            /* 注销失败忽略 */
          }
        }
      })
    })
  } catch (e) {
    try {
      ctx.logger?.warn?.('[@dsh-hanako/api-bridge] 插件停用：' + ((e && e.message) || e))
    } catch {
      /* 日志失败不阻断 */
    }
  }
}
