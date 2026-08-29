// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/bridge — dsh 侧统一通道（bridge）客户端（M3）
//
// 语义：dsh web host 侧与宿主进程间开一条私有 WebSocket 通道（WS #2，127.0.0.1
// 随机端口，私有 token 首帧握手），替代旧的 127.0.0.1:3080 网络栈直连与
// update-request.json / update-result.json 文件桥接：
//   · http.request 帧 → **进程内执行 dsh webServer 路由**（webServer.match 定位
//     (req, res) handler，构造真实 node http.IncomingMessage/ServerResponse + 假
//     socket 就地 dispatch，不经 127.0.0.1:3080 网络栈），响应分帧回传；
//   · event 帧 → emit/on 分发（update.request 等自定义消息流，参照 dsh events.mux
//     风格）；宿主侧经 emitEvent 推 update.result 等，本插件 on() 订阅转发。
//
// 提供 'bridge' 服务（cordis provide）：handleHttp(req)（进程内直调，供设置页等
// 插件复用，不走 WS #2）、emit(type, payload)、on(type, cb)。
// inject：['webServer', 'hanaLogger']（webServer 定位路由 + 进程内 dispatch；
// hanaLogger 统一日志，行格式 [<HH:mm:ss.SSS>] [bridge] <内容>）。
//
// 连接管理：DSH_BRIDGE_URL / DSH_BRIDGE_TOKEN 由宿主 spawn env 注入（lifecycle.js
// ensureWebHost 启动 WS #2 后注入）；指数退避重连（1s 起、×2、封顶 30s，参照
// @dsh-hanako/theme 的 reconnect 姿势），握手失败（token 不匹配）不重连（配置错）；
// 心跳：应用级 { type:'ping' } 每 30s，90s 无任何消息判死重连。
//
// 容错纪律：apply 全程 try/catch 不抛出——依赖缺失/连接失败只记日志，插件降级为
// 空操作（handleHttp 抛错由调用方兜底），不阻断 dsh 启动。注释风格同
// @dsh-hanako/provider（中文/单引号/无分号）。
import { EventEmitter } from 'node:events'
import { IncomingMessage, ServerResponse } from 'node:http'

export const name = '@dsh-hanako/bridge'
export const inject = ['webServer', 'hanaLogger']

// ---- 常量 ----
const RECONNECT_BASE_MS = 1000 // 退避基数
const RECONNECT_MAX_MS = 30000 // 退避封顶
const HEARTBEAT_MS = 30000 // 应用级 ping 间隔
const DEAD_MS = 90000 // 无任何消息判死
const REQUEST_TIMEOUT_MS = 30000 // http.request 进程内执行超时
const CHUNK_THRESHOLD = 256 * 1024 // 分帧阈值
const CHUNK_SIZE = 224 * 1024 // 每段原始字节

// ---- 分帧（base64 分段；与宿主 src/lib/bridge.js 同协议）----
function encodeBody(body) {
  if (body === null || body === undefined) return null
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
  if (buf.length <= CHUNK_THRESHOLD)
    return { chunk: 0, data: buf.toString('base64'), done: true }
  return {
    chunk: 0,
    data: buf.subarray(0, CHUNK_SIZE).toString('base64'),
    done: false,
  }
}
function chunkBodyFrames(id, body) {
  if (body === null || body === undefined) return []
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
  if (buf.length <= CHUNK_THRESHOLD) return []
  const frames = []
  let chunk = 1
  let offset = CHUNK_SIZE
  while (offset < buf.length) {
    const part = buf.subarray(offset, offset + CHUNK_SIZE)
    offset += part.length
    frames.push({
      type: 'http.chunk',
      id,
      chunk: chunk++,
      data: part.toString('base64'),
      done: offset >= buf.length,
    })
  }
  return frames
}
function rebuildBody(metaBody, chunks) {
  const parts = []
  let total = 0
  if (
    metaBody &&
    typeof metaBody === 'object' &&
    typeof metaBody.data === 'string'
  ) {
    const b = Buffer.from(metaBody.data, 'base64')
    parts.push(b)
    total += b.length
  }
  for (const c of chunks) {
    const b = Buffer.from(c.data, 'base64')
    parts.push(b)
    total += b.length
  }
  return total === 0 ? null : Buffer.concat(parts, total)
}

// ---- 进程内 HTTP dispatch（webServer.match + 真实 node http 对象 + 假 socket）----
// dsh webServer 路由是 node (req, res) handler（webServer.register({ kind, path,
// handler })）。进程内执行 = 构造真实 http.IncomingMessage / http.ServerResponse
// + 假 socket（捕获写入字节），调 webServer.match(pathname).handler(req, res)，
// 全程不经 127.0.0.1:3080 网络栈。
function makeFakeSocket() {
  const sock = new EventEmitter()
  const chunks = []
  sock.write = (chunk, enc, cb) => {
    if (chunk)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc || 'utf8'))
    if (typeof cb === 'function') cb()
    return true
  }
  sock.end = (chunk, enc, cb) => {
    if (chunk)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc || 'utf8'))
    if (typeof cb === 'function') cb()
    sock.destroyed = true
    return true
  }
  sock.destroy = () => {
    sock.destroyed = true
  }
  sock.setNoDelay = () => {}
  sock.setTimeout = () => {}
  sock.destroyed = false
  sock.remoteAddress = '127.0.0.1'
  sock.remotePort = 0
  sock.getChunks = () => Buffer.concat(chunks)
  return sock
}

// 进程内执行一个 HTTP 请求：返回 { status, headers, body: Buffer|null }
async function dispatchInProcess(webServer, method, path, headers, bodyBuf) {
  return new Promise((resolve, reject) => {
    try {
      const sock = makeFakeSocket()
      const req = new IncomingMessage(sock)
      req.url = path
      req.method = String(method || 'GET').toUpperCase()
      req.headers = headers && typeof headers === 'object' ? { ...headers } : {}
      // 剥离 Origin：dsh web 的 API 层对 POST 做跨源校验（CSRF 防护，带宿主
      // Origin 的请求返回 403 forbidden）。进程内执行无跨源概念，Origin 必须
      // 移除（保留其它头，含 surface session / cookie 语义由 dsh 侧自行处理）。
      for (const k of Object.keys(req.headers)) {
        if (k.toLowerCase() === 'origin') delete req.headers[k]
      }
      // 补 Host：dsh 的 API 可信校验（dsh-client-connection isTrustedApiRequest）要求
      // Host header 存在且为 loopback/trusted（缺失即 403 forbidden）——隧道转发的
      // 请求无 Host（浏览器/SW 不携带），补 webServer 实际监听地址。
      if (!Object.keys(req.headers).some((k) => k.toLowerCase() === 'host')) {
        const hostPort = (webServer && webServer.port) || 3080
        req.headers.host = '127.0.0.1:' + hostPort
      }
      req.socket = sock
      // body 喂入（IncomingMessage 是 Readable）
      if (bodyBuf && bodyBuf.length > 0) req.push(bodyBuf)
      req.push(null)

      const res = new ServerResponse(req)
      const outHeaders = {}
      const origSetHeader = res.setHeader.bind(res)
      res.setHeader = (name, value) => {
        outHeaders[String(name).toLowerCase()] = String(value)
        return origSetHeader(name, value)
      }
      const origWriteHead = res.writeHead.bind(res)
      res.writeHead = (status, ...rest) => {
        if (typeof rest[0] === 'object' && rest[0] !== null) {
          for (const [k, v] of Object.entries(rest[0])) {
            outHeaders[String(k).toLowerCase()] = String(v)
          }
        }
        return origWriteHead(status, ...rest)
      }
      const origWrite = res.write.bind(res)
      res.write = (chunk, enc, cb) => {
        sock.write(chunk, enc, cb)
        return true
      }
      // res.end 覆盖：把剩余响应体写入假 socket 后触发 settle（幂等）——流式/回调式
      // handler 在响应体完整写完后才 resolve，不以 handler promise 完成为准
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        const body = sock.getChunks()
        const status = Number(res.statusCode) || 200
        resolve({ status, headers: outHeaders, body: body.length > 0 ? body : null })
      }
      res.end = (chunk, enc, cb) => {
        sock.end(chunk, enc, cb)
        settle()
        return res
      }

      const timeout = setTimeout(() => {
        try {
          res.destroy()
        } catch {
          /* 忽略 */
        }
        reject(new Error('进程内执行超时（' + Math.round(REQUEST_TIMEOUT_MS / 1000) + 's）'))
      }, REQUEST_TIMEOUT_MS)
      timeout.unref?.()

      let pathname = path
      try {
        pathname = new URL(path, 'http://dsh.internal').pathname
      } catch {
        /* 保留原 path */
      }
      const route = webServer.match(pathname)
      if (!route || typeof route.handler !== 'function') {
        // match 未命中 → 走 webServer 的 fallback 席位（SPA dist 服务/静态资源）：
        // 与真实 server 的 handle() 同语义（L180-197：match → handler，未命中 →
        // fallback，fallback 未注册才 404）。此前只 match 导致首页/静态资源 404。
        if (typeof webServer.fallback === 'function') {
          // fallback 与 route handler 同语义：内部走 res.end（被覆盖触发 settle），
          // 这里 promise 仅捕同步/异步错误
          Promise.resolve()
            .then(function () { return webServer.fallback(req, res) })
            .catch(function (e) {
              clearTimeout(timeout)
              resolve({ status: 500, headers: {}, body: Buffer.from(String(e?.message || e)) })
            })
          return
        }
        clearTimeout(timeout)
        resolve({ status: 404, headers: {}, body: Buffer.from('not found') })
        return
      }
      // handler promise 仅用于捕获同步/异步错误——成功 settle 由 res.end 触发
      try {
        const invoke = route.handler(req, res)
        Promise.resolve(invoke).catch((err) => {
          clearTimeout(timeout)
          reject(err)
        })
      } catch (err) {
        clearTimeout(timeout)
        reject(err)
      }
    } catch (err) {
      reject(err)
    }
  })
}

// ---- 插件主体 ----
export function apply(ctx, config) {
  try {
    ctx.inject(['webServer', 'hanaLogger'], (httpCtx) => {
      httpCtx.effect(() => {
        let bridgeLog = () => {}
        try {
          bridgeLog = (msg) => httpCtx.hanaLogger.log('bridge', msg)
        } catch {
          /* 日志失败不阻断 */
        }
        const emitter = new EventEmitter()
        let ws = null
        let handshook = false
        let stopFlag = false
        let reconnectAttempt = 0
        let reconnectTimer = null
        let heartbeatTimer = null
        let lastMessageAt = Date.now()
        // http.request 帧的进程内执行挂起表（id → entry）
        const inflight = new Map()

        const clearTimers = () => {
          if (reconnectTimer) {
            clearTimeout(reconnectTimer)
            reconnectTimer = null
          }
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer)
            heartbeatTimer = null
          }
        }

        const sendFrame = (frame) => {
          if (!ws || ws.readyState !== 1 || !handshook) return false
          try {
            ws.send(JSON.stringify(frame))
            return true
          } catch {
            return false
          }
        }

        // 进程内执行一个 http.request 帧 → 回 http.response / http.error。
        // body 分帧重组：初始帧带 body（done=false 表示大请求体首段），后续经
        // http.chunk 帧到达（onFrame 收集），全部收齐（done=true）后才 dispatch，
        // 大请求体不截断。
        const dispatchEntry = async (id, entry) => {
          try {
            const result = await dispatchInProcess(
              httpCtx.webServer,
              entry.method,
              entry.path,
              entry.headers,
              rebuildBody(entry.metaBody, entry.chunks),
            )
            entry.resolve(result)
          } catch (err) {
            entry.reject(err)
          }
        }
        const handleHttpRequestFrame = (frame) => {
          const id = String(frame.id || '')
          if (!id || inflight.has(id)) {
            sendFrame({ type: 'http.error', id: id || '?', message: '请求 id 缺失或重复' })
            return
          }
          const entry = {
            resolve: null,
            reject: null,
            method: String(frame.method || 'GET').toUpperCase(),
            path: String(frame.path || '/'),
            headers: frame.headers && typeof frame.headers === 'object' ? frame.headers : {},
            // body 统一存 metaBody：done=true 单段由 rebuildBody 解码；done=false 首段
            // 等 http.chunk 续段一起重组（dispatchEntry 的 rebuildBody 统一处理）
            metaBody: frame.body && typeof frame.body === 'object' ? frame.body : null,
            chunks: [],
            nextChunk: 1,
          }
          const promise = new Promise((resolve, reject) => {
            entry.resolve = resolve
            entry.reject = reject
          })
          inflight.set(id, entry)
          promise
            .then((result) => {
              inflight.delete(id)
              sendFrame({
                type: 'http.response',
                id,
                status: result.status,
                headers: result.headers,
                body: encodeBody(result.body),
              })
              for (const cf of chunkBodyFrames(id, result.body)) sendFrame(cf)
            })
            .catch((err) => {
              inflight.delete(id)
              sendFrame({
                type: 'http.error',
                id,
                message: String((err && err.message) || err).slice(0, 1000),
              })
            })
          // 初始帧 body done=true（或无 body）：直接 dispatch；done=false：等 http.chunk
          if (frame.body && frame.body.done === false) return
          dispatchEntry(id, entry)
        }

        const onFrame = (text) => {
          let frame
          try {
            frame = JSON.parse(text)
          } catch {
            return
          }
          lastMessageAt = Date.now()
          if (frame && frame.type === 'pong') return
          if (frame && frame.type === 'ping') {
            sendFrame({ type: 'pong' })
            return
          }
          // hello-ok：认证成功——此后 sendFrame / status().connected 才正常
          if (frame && frame.type === 'hello-ok') {
            handshook = true
            reconnectAttempt = 0 // 重连成功后重置退避
            bridgeLog('WS #2 握手成功（hello-ok）')
            return
          }
          if (frame && frame.type === 'http.request') {
            handleHttpRequestFrame(frame)
            return
          }
          if (frame && frame.type === 'http.chunk') {
            const id = String(frame.id || '')
            const entry = inflight.get(id)
            if (!entry) return // 超时/已清理：丢弃
            if (entry.metaBody && frame.chunk === entry.nextChunk) {
              entry.chunks.push(frame)
              entry.nextChunk += 1
              if (frame.done) dispatchEntry(id, entry)
            } else {
              entry.reject(new Error('分帧序列错误'))
            }
            return
          }
          if (frame && frame.type === 'event') {
            if (frame.name && typeof frame.name === 'string') {
              emitter.emit(frame.name, frame.payload)
            }
            return
          }
        }

        const openWs = () => {
          if (stopFlag) return
          const url = process.env.DSH_BRIDGE_URL
          const token = process.env.DSH_BRIDGE_TOKEN
          if (!url || !token) {
            // env 未注入（宿主旧版/未启动 bridge）：退避重试
            scheduleReconnect('bridge env 未注入')
            return
          }
          let sock
          try {
            sock = new WebSocket(url)
          } catch (err) {
            bridgeLog('WebSocket 构造失败：' + ((err && err.message) || err))
            scheduleReconnect('构造失败')
            return
          }
          ws = sock
          handshook = false
          sock.addEventListener('open', () => {
            lastMessageAt = Date.now()
            try {
              sock.send(JSON.stringify({ type: 'hello', token }))
            } catch (err) {
              /* 忽略 */
            }
          })
          sock.addEventListener('message', (ev) => {
            if (typeof ev.data !== 'string') return
            onFrame(ev.data)
          })
          sock.addEventListener('close', (ev) => {
            if (ws === sock) ws = null
            const code = ev && typeof ev.code === 'number' ? ev.code : 1006
            const reason = (ev && ev.reason) || ''
            bridgeLog('WS #2 连接关闭（code=' + code + ' ' + reason + '）')
            // 握手阶段被拒（token 错/hello 拒绝）：不重连（配置错误）
            if (!handshook && code === 1008) return
            scheduleReconnect('连接关闭')
          })
          sock.addEventListener('error', (err) => {
            bridgeLog('WS #2 连接错误：' + ((err && err.message) || String(err)))
          })
        }

        const scheduleReconnect = (reason) => {
          if (stopFlag) return
          if (reconnectTimer) return
          const delay = Math.min(
            RECONNECT_MAX_MS,
            RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt),
          )
          reconnectAttempt += 1
          bridgeLog('WS #2 重连（' + reason + '，' + Math.round(delay / 1000) + 's 后）')
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null
            openWs()
          }, delay)
          reconnectTimer.unref?.()
        }

        const startHeartbeat = () => {
          heartbeatTimer = setInterval(() => {
            if (!ws || !handshook) return
            sendFrame({ type: 'ping' })
            if (Date.now() - lastMessageAt > DEAD_MS) {
              bridgeLog('WS #2 心跳超时（90s 无消息），断开重连')
              try {
                ws.close()
              } catch {
                /* 忽略 */
              }
            }
          }, HEARTBEAT_MS)
          heartbeatTimer.unref?.()
        }

        // 启动连接
        openWs()
        startHeartbeat()

        // ---- provide 'bridge' 服务 ----
        const service = {
          // handleHttp：进程内直接执行（不经 WS #2）——供设置页等插件直调；
          // req = { method, path, headers, body? } → { status, headers, body: Buffer|null }
          handleHttp: async (req) => {
            if (!httpCtx.webServer || typeof httpCtx.webServer.match !== 'function') {
              throw new Error('webServer 不可用')
            }
            const bodyBuf = req && req.body ? Buffer.from(req.body) : null
            return dispatchInProcess(
              httpCtx.webServer,
              (req && req.method) || 'GET',
              (req && req.path) || '/',
              (req && req.headers) || {},
              bodyBuf,
            )
          },
          // emit：向宿主推事件（update.request 等）
          emit: (type, payload) =>
            sendFrame({ type: 'event', name: type, payload: payload ?? {} }),
          // on：订阅宿主事件（update.result 等）；返回退订函数
          on: (type, cb) => {
            emitter.on(type, cb)
            return () => emitter.off(type, cb)
          },
          // 连接状态（诊断）
          status: () => ({
            connected: !!ws && handshook,
            reconnecting: reconnectAttempt > 0 && (!ws || !handshook),
            url: process.env.DSH_BRIDGE_URL || null,
          }),
        }
        ctx.provide('bridge', service)

        bridgeLog('bridge 插件已启动（WS #2 client）')

        return () => {
          stopFlag = true
          clearTimers()
          if (ws) {
            try {
              ws.close()
            } catch {
              /* 忽略 */
            }
            ws = null
          }
          emitter.removeAllListeners()
        }
      })
    })
  } catch (err) {
    try {
      ctx.logger?.warn?.('[@dsh-hanako/bridge] 插件停用：' + ((err && err.message) || err))
    } catch {
      /* 日志失败不阻断 */
    }
  }
}