// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/bridge — dsh 侧进程间消息总线服务端（dshana.bus）
//
// 语义：在 dsh web host 内提供一条私有 WebSocket 消息总线（/api/dshana.bus），宿主
// 插件连接后双向收发 JSON 文本帧 { channel, payload }——替代旧的单向 HTTP 反向信道
// POST /child/post（v0.21.2 引入，已退役）。只做消息总线，不做代理：无 SW 拦截、无
// HTTP 隧道、无请求转发（bridge 历史教训：feat/bridge-channel 曾做三层通道因宿主
// 插件路由再分发丢失 upgrade raw socket/env 不可行，v7 改 HTTP 隧道复杂度爆炸整体
// revert；本次握手在 dsh webserver 内完成——registerUpgrade 的 handler 拥有 socket
// 完整协商权，不经过宿主路由再分发）。
//
// 传输层：复用 dsh webserver（dsh-host-webserver WebServer）的 upgrade 路由——
// 子插件 webServer.registerUpgrade({ path, handler }) 注册 /api/dshana.bus，
// webserver 的 server.on("upgrade") 按 pathname 分发，handler 签名 (req, socket, head)，
// 返回 disposer 在卸载时注销。handler 内做 RFC6455 握手 + 帧编解码（ws-lib.js 零依赖
// 手写原语：Sec-WebSocket-Key/Accept、帧解析、分片重组、256KB 单帧上限、连接级错误
// 处理与 socket 清理），零运行时依赖（node:http 事件 socket + node:crypto + node:buffer）。
//
// 协议（JSON 文本帧，{ channel, payload }）：
//   { "channel":"hello", "payload":{} }                     —— 首帧握手（身份宣告；免鉴权——
//                                                             总线与 mux、/api/session.* 同级，
//                                                             本机信任，不再比对 busToken；
//                                                             config 已清空）
//   { "channel":"hello-ok", "payload":{} }                  —— 服务端应答（握手成功）
//   { "channel":"config", "payload":{ dshPkgDir, dataDir } }—— 宿主下发配置（hello 后由宿主
//                                                             主动发；bridge 缓存供 getConfig()）
//   { "channel":"log", "payload":{ src, line } }            —— dsh 内部日志转发（宿主写会话文件）
//   { "channel":"update.request", "payload":{ at, fromVersion } }—— 设置页发起的更新请求
//   { "channel":"update.progress", "payload":{ state, at } }—— 宿主更新开始/进度回投
//   { "channel":"update.result", "payload":{ state, version?, error? } }—— 宿主更新结果回投
//   { "channel":"provider.refresh", "payload":{ routes } }  —— 宿主 provider 路由推送（替代 HTTP）
//   { "channel":"rpc.request", "payload":{ reqId, method, payload } }—— 宿主 Unary RPC 指令面
//                                                             收敛进总线（session.create/prompt/
//                                                             selectModel/cancel + respond 审批
//                                                             应答；翻译器自环调 /api/<method>，
//                                                             见 translateRpcRequest）
//   { "channel":"rpc.result", "payload":{ reqId, ok, value?, error? } }—— 翻译器回投（宿主按
//                                                             reqId 配对等待；ok:false 带 error）
//   { "channel":"bus.ping", "payload":{} } / { "channel":"bus.pong", "payload":{} } —— 心跳
// 首帧必须是 hello（免鉴权身份宣告，仍要求首帧即 hello）：非 hello 首帧立即关闭
// （close 1008）；5s 未发 hello 关闭（超时）。单连接语义：宿主是唯一客户端——新连接
// hello 通过后旧连接关闭（close 1001 replaced）。
//
// 提供 'dshanaBus' 服务（cordis provide）：
//   emit(channel, payload)  —— 向已通过 hello 的连接发 JSON 文本帧（未连接/未握手 no-op）
//   on(channel, handler)    —— 订阅消息分发（EventEmitter）；返回退订函数
//   status()                —— { connected, ready, path } 诊断
//   getConfig()             —— 返回宿主下发的配置（{ dshPkgDir, dataDir }）或 null
// inject：['webServer']（注册 upgrade 路由）。日志不再经 hanaLogger（避免与 logger 插件
// 的 dshanaBus 注入形成循环依赖）——bridge 自身日志经总线 log 帧直投宿主（已连接时），
// 未连接时退 ctx.logger（cordis 控制台）。config：{}（patch 静态注入，无任何占位符）。
//
// 容错纪律：apply 全程 try/catch 不抛出——依赖缺失/路由重复只记日志，插件降级为
// 空操作，不阻断 dsh 启动。注释风格同 @dsh-hanako/provider（中文/单引号/无分号）。

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { handleUpgrade } from './ws-lib.js'

export const name = '@dsh-hanako/bridge'
// connection（dsh-client-connection 注册的 HostConnectionService 服务名，见其
// super(ctx, "connection")）：读 BrowserAuth.launchToken（dsh 0.1.2+ 浏览器鉴权
// 进程令牌）——自环 RPC 换发 cookie（vX；旧版 dsh 无此服务时保持免鉴权兼容）。
// 注意：插件名是 client-connection，服务名是 connection，inject 用服务名。
export const inject = ['webServer', 'connection']

// ---- 常量 ----
const BUS_PATH = '/api/dshana.bus' // upgrade 路由路径（宿主连 ws://127.0.0.1:<port> 该路径）
const HELLO_TIMEOUT_MS = 5000 // 握手超时（5s 未发 hello 关闭）
const HELLO_CLOSE_CODE = 1008 // 握手失败关闭码（非 hello 首帧/超时）
const REPLACED_CLOSE_CODE = 1001 // 旧连接被新连接顶掉

// ---- 总线 RPC 翻译器（宿主 Unary RPC 指令面收敛进总线；导出供单测）----
// 宿主经总线 rpc.request 帧投递 Unary RPC（session.create/prompt/selectModel/cancel 等 +
// respond 审批应答），翻译器在 dsh 进程内自环调 dsh web /api/<method>（本机 127.0.0.1
// 回环——子插件与 dsh 同进程，dsh 本体零改动），把 ServerResponse 翻译回 rpc.result 帧
// 回投宿主。数据面（events.mux 事件流）仍由宿主直连，不经总线。
// 安全：不设 method 白名单——与本机信任模型一致：本机进程本就可直接 POST 3080 /api/*
// （总线与 mux、/api/session.* 同级，免鉴权），总线只是换入口，攻击面未扩大。
// 回投纪律：所有异常路径（fetch 异常/超时/解析失败/HTTP 错误/rpcId 不匹配）都必须经
// reply 回投 rpc.result（ok:false），否则宿主侧 pending 等待挂死。
// req：{ reqId, method, payload }；port：dsh web 端口（取不到由调用方回退 3080）；
// reply(frame)：回投一帧 rpc.result 载荷（{ reqId, ok, value? } 或 { reqId, ok:false, error }），
// 不应抛出（插件侧接线已包 try/catch 隔离）。
// ---- 模块级鉴权状态（apply 经 connection 服务初始化；translateRpcRequest 消费）----
// launchToken：dsh 进程浏览器鉴权令牌（BrowserAuth.launchToken，dsh web 打印 URL 的
// token）。自环 RPC 用它换 cookie（0.1.2+ /api/* 需浏览器 cookie）。
// 旧版 dsh（无 connection 服务）为空 → 自环免鉴权（改造前行为）。
let launchToken = ''
// 自环换发的 cookie（launchToken → GET /?token= → dsh-auth-* signed cookie，30 天）。
// 缓存避免每次 RPC 都换发；web 重启后 launchToken 变化，旧 cookie 失效自动重换。
let authCookie = ''
let authCookieAt = 0

/** 自环 RPC 鉴权 cookie（dsh 0.1.2+ /api/* 需浏览器 cookie，无则 401）。
 * launchToken 经 GET /?token= 换发 signed cookie（authorizeIndex 流程，本机回环）；
 * 缓存复用（6h 内不重换）。launchToken 为空（旧版）返回空串（不加 Cookie 头）。 */
async function ensureAuthCookie(port) {
  const base = 'http://127.0.0.1:' + (Number(port) || 3080)
  if (authCookie && Date.now() - authCookieAt < 6 * 3600 * 1000) return authCookie
  if (!launchToken) return ''
  try {
    const res = await fetch(base + '/?token=' + encodeURIComponent(launchToken), {
      redirect: 'manual',
    })
    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie')]
          : []
    const cookie = setCookies
      .map((s) => String(s).split(';')[0])
      .filter(Boolean)
      .join('; ')
    authCookie = cookie
    authCookieAt = Date.now()
    return cookie
  } catch {
    // 换发失败：回退旧 cookie（可能仍有效）或空
    return authCookie || ''
  }
}

export async function translateRpcRequest(req, port, reply) {
  const reqId = req && typeof req === 'object' ? req.reqId : undefined
  const method = req && typeof req === 'object' ? req.method : undefined
  // 校验：reqId/method 必须是非空 string，否则忽略（防垃圾帧）
  if (typeof reqId !== 'string' || !reqId || typeof method !== 'string' || !method) {
    return
  }
  const base = 'http://127.0.0.1:' + (Number(port) || 3080)
  // vX（dsh 0.1.2+ 鉴权）：/api/* 需要浏览器 cookie（launchToken 换发）；
  // 无鉴权旧版 launchToken 为空 → ensureAuthCookie 返回空串，行为不变。
  const cookie = await ensureAuthCookie(port)
  const headers = {
    'content-type': 'application/json',
    ...(cookie ? { cookie } : {}),
  }
  try {
    if (method === 'authCookie') {
      // 返回当前自环 cookie（launchToken 换发，缓存 6h；旧版无 connection 服务
      // 返回空串 → 宿主免鉴权回退）。宿主侧无 launchToken 源（token 在 dsh 进程
      // 内 BrowserAuth），remote.mux 等 WS 端点需 Cookie 头——经总线代取。
      reply({ reqId, ok: true, value: await ensureAuthCookie(port) })
      return
    }
    if (method === 'launchToken') {
      // 返回进程内 launchToken（BrowserAuth，重启换新）：宿主渲染插件页拼
      // iframe URL（/?token= 免 cookie 换发，SPA 随后经 cookie 正常访问）——
      // 跨域宿主（LAN 虚拟域名）下 Set-Cookie 落不到 dsh 域，必须走 token 换发。
      reply({ reqId, ok: true, value: launchToken })
      return
    }
    if (method === 'respond') {
      // 审批应答：/api/respond 要 client-response 信封（rpcId 路由 web host pending 表），
      // 响应是 rpcReceipt { accepted } 而非 ServerResponse——与 Unary 响应结构不同，
      // 单独构造信封/解析；value 原样回投 { accepted }，宿主侧校验 j.accepted 语义不变
      // （与直连 HTTP 完全一致）。
      const envelope = { type: 'client-response', ...(req.payload || {}) }
      const res = await fetch(base + '/api/respond', {
        method: 'POST',
        headers,
        body: JSON.stringify(envelope),
      })
      if (!res.ok) throw new Error('/api/respond HTTP ' + res.status)
      const j = await res.json()
      reply({ reqId, ok: true, value: j && typeof j === 'object' ? j : {} })
      return
    }
    // Unary：client-request 信封，响应 ServerResponse（rpcId 回显 + result.ok/value
    // 或 result.ok=false+error）。vX（dsh 0.1.2）：RPC 路径与信封 method 均为
    // <namespace>/<method> 斜杠格式（/api/session/create + method "session/create"），
    // 宿主侧传 "session.create" 点号格式——翻译时转换（0.1.1 无斜杠拆分，同路径兼容）。
    const endpoint = method.includes('.') ? method.replace(/\./g, '/') : method
    // vX（dsh 0.1.2）：Remote payload 要求 { args: <参数名>: <参数> }（typert
    // Remote descriptor 的参数名；session/* 均声明为 request）。rpcId 注入
    // request.requestId（0.1.2 create 用它写 jsonl data.source.rpcId，与宿主
    // 定位键对齐）。非 session/* 的 method 暂以裸 args 透传（respond 走特殊分支）。
    const isSession = method.startsWith('session.') || method.startsWith('session/')
    const args = isSession
      ? { request: { ...(req.payload || {}), requestId: reqId } }
      : req.payload
    const res = await fetch(base + '/api/' + endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'client-request',
        rpcId: reqId,
        method: endpoint,
        payload: { args },
      }),
    })
    if (!res.ok) throw new Error('dsh /api/' + method + ' HTTP ' + res.status)
    const full = await res.json()
    if (!full || typeof full !== 'object' || full.rpcId !== reqId) {
      reply({
        reqId,
        ok: false,
        error: { code: 'rpc-id-mismatch', message: 'dsh /api/' + method + ' rpcId 不匹配' },
      })
      return
    }
    if (!full.result || !full.result.ok) {
      const e = full.result.error || {}
      reply({ reqId, ok: false, error: { code: e.code || 'unknown', message: e.message || '' } })
      return
    }
    reply({ reqId, ok: true, value: full.result.value })
  } catch (err) {
    reply({
      reqId,
      ok: false,
      error: { code: 'bridge-error', message: String((err && err.message) || err) },
    })
  }
}

// ---- 插件 apply：注册 upgrade 路由 + 提供 dshanaBus 服务（全程容错，降级不阻断）----
export function apply(ctx, config) {
  try {
    // launchToken：从 connection 服务（HostConnectionService）的 BrowserAuth 读
    // （dsh 0.1.2+ 浏览器鉴权进程令牌），自环 RPC 用它换 cookie。旧版 dsh 无此
    // 服务 → 保持空，自环免鉴权兼容（改造前行为）。
    ctx.inject(['connection'], (connCtx) => {
      try {
        launchToken = connCtx.get?.('connection')?.browserAuth?.launchToken || ''
      } catch {
        launchToken = ''
      }
    })
    ctx.inject(['webServer'], (httpCtx) => {
      httpCtx.effect(() => {
        let bridgeLog = (msg) => {
          // 未连接/降级时的兜底日志（cordis 控制台）；已连接时经总线 log 帧直投宿主
          try {
            ctx.logger?.info?.('[@dsh-hanako/bridge] ' + msg)
          } catch {
            /* 日志失败不阻断 */
          }
        }
        const emitter = new EventEmitter()
        let conn = null // 当前已握手连接（单连接语义）
        let upgradeDisposer = null
        // 宿主下发的配置（hello 后经 config 帧到达；提供 getConfig() 供 settings/provider 取路径）
        let busConfig = null

        // ---- 向当前连接发 JSON 文本帧（未连接/未握手 no-op）----
        const sendFrame = (frame) => {
          if (!conn || conn.readyState !== 1) return false
          try {
            // 返回语义：true 仅表示消息已入串行写队列（排队成功），不保证已写 socket；
            // socket 已死时 sendText 同步返回 false（传播写入失败，调用方按未排队处理）。
            const r = conn.sendText(JSON.stringify(frame))
            return r !== false
          } catch {
            return false
          }
        }

        // ---- 连接接入：首帧 hello（免鉴权）+ 单连接顶替 + 帧分发 ----
        const onConnection = (wsConn) => {
          let authed = false
          // 握手超时：5s 未发合法 hello 关闭（客户端异常）
          const helloTimer = setTimeout(() => {
            if (!authed && wsConn.readyState === 1) {
              try {
                wsConn.close(HELLO_CLOSE_CODE, 'hello timeout')
              } catch {
                /* 忽略 */
              }
            }
          }, HELLO_TIMEOUT_MS)
          helloTimer.unref?.()

          const onMessage = (text) => {
            let frame
            try {
              frame = JSON.parse(text)
            } catch {
              // 非法 JSON：忽略本帧（容错；单帧坏数据不杀连接，与「非法 JSON 帧容错」一致）
              return
            }
            if (!authed) {
              // 首帧必须是 hello（免鉴权身份宣告：不再比对 token——总线与 mux、
              // /api/session.* 同级，本机信任；payload 可为空对象）
              if (!frame || frame.channel !== 'hello') {
                try {
                  wsConn.close(HELLO_CLOSE_CODE, 'hello required')
                } catch {
                  /* 忽略 */
                }
                return
              }
              authed = true
              clearTimeout(helloTimer)
              // 单连接语义：新连接 hello 通过后旧连接关闭（宿主唯一客户端，重连顶替）
              if (conn && conn !== wsConn) {
                try {
                  conn.close(REPLACED_CLOSE_CODE, 'replaced')
                } catch {
                  /* 忽略 */
                }
              }
              conn = wsConn
              sendFrame({ channel: 'hello-ok', payload: {} })
              bridgeLog = (msg) => {
                // 已连接：经总线 log 帧直投宿主（会话文件行格式 [ts] [bridge] 由宿主侧统一）
                sendFrame({ channel: 'log', payload: { src: 'bridge', line: msg } })
              }
              bridgeLog('dshana.bus 握手成功（宿主已连接，免鉴权）')
              return
            }
            // 已握手：channel 分发 + 心跳 + config 缓存
            if (frame && typeof frame.channel === 'string') {
              if (frame.channel === 'bus.ping') {
                sendFrame({ channel: 'bus.pong', payload: {} })
                return
              }
              if (frame.channel === 'bus.pong') return
              if (frame.channel === 'config') {
                // 宿主下发配置（dshPkgDir/dataDir 替代 patch 注入）：缓存供 getConfig()
                const p = frame.payload && typeof frame.payload === 'object' ? frame.payload : {}
                if (p && (typeof p.dshPkgDir === 'string' || typeof p.dataDir === 'string')) {
                  busConfig = { ...p }
                  bridgeLog('宿主配置已下发（dshPkgDir/dataDir，供 getConfig()）')
                }
                return
              }
              // 对端可控 channel 隔离：加 ch: 前缀分发，避免触发 EventEmitter 保留事件
              // （error / newListener / removeListener）；分发异常（监听器抛错）不冒泡崩进程。
              try {
                emitter.emit('ch:' + frame.channel, frame.payload ?? {})
              } catch {
                bridgeLog('消息分发异常（channel=' + frame.channel + '），已隔离')
              }
            }
          }
          const onClose = () => {
            wsConn.off('message', onMessage)
            clearTimeout(helloTimer)
            if (conn === wsConn) {
              conn = null
              bridgeLog('dshana.bus 连接断开')
            }
          }
          wsConn.on('message', onMessage)
          wsConn.once('close', onClose)
        }

        // ---- 注册 upgrade 路由（webserver 内完成握手，不经过宿主路由再分发）----
        if (
          httpCtx.webServer &&
          typeof httpCtx.webServer.registerUpgrade === 'function'
        ) {
          try {
            upgradeDisposer = httpCtx.webServer.registerUpgrade({
              path: BUS_PATH,
              handler: (req, socket, head) => {
                handleUpgrade(req, socket, head, {
                  onConnection,
                  onError: (err) => {
                    bridgeLog('dshana.bus 连接错误：' + ((err && err.message) || err))
                  },
                })
              },
            })
            bridgeLog('dshana.bus upgrade 路由已注册（' + BUS_PATH + '）')
          } catch (e) {
            // 重复注册（插件重载未清理）：降级记日志，不阻断
            bridgeLog('upgrade 路由注册失败：' + ((e && e.message) || e))
          }
        } else {
          bridgeLog('webServer.registerUpgrade 不可用（宿主版本过旧），消息总线不可用')
        }

        // provide 'dshanaBus' 服务（保存 disposer：effect 重执行/卸载时移除旧注册，防重复注册）
        const service = {
          // emit：向已通过 hello 的连接发 JSON 文本帧（未连接/未握手 no-op，返回是否送达）
          emit: (channel, payload) =>
            sendFrame({ channel, payload: payload ?? {} }),
          // on：订阅消息分发（update.request / provider.refresh / update.result 等）；返回退订函数。
          // 与分发端一致：channel 映射为 ch:<channel> 后再挂监听（隔离保留事件）。
          on: (channel, cb) => {
            if (typeof channel !== 'string' || typeof cb !== 'function') return () => {}
            const key = 'ch:' + channel
            // 每个订阅回调独立异常隔离包装：一个监听器抛错不影响后续监听器执行
            // （EventEmitter 的 emit 同步串行调用，裸 cb 抛错会中断后续监听器）。
            const wrapped = (payload) => {
              try {
                cb(payload)
              } catch (e) {
                bridgeLog('监听器异常（channel=' + channel + '）：' + ((e && e.message) || e))
              }
            }
            emitter.on(key, wrapped)
            return () => emitter.off(key, wrapped)
          },
          // 连接状态（诊断 / settings request-update 判空）
          status: () => ({
            connected: !!conn && conn.readyState === 1,
            ready: !!conn && conn.readyState === 1,
            path: BUS_PATH,
          }),
          // 宿主下发的配置（未下发返回 null——settings/provider 据此报「总线配置未就绪」）
          getConfig: () => (busConfig ? { ...busConfig } : null),
        }
        // ---- 总线 RPC 接线：订阅宿主 rpc.request → 翻译器执行 → 回投 rpc.result ----
        // service.on 的监听器异常隔离是每回调包装（新订阅沿用该模式）；翻译器内部
        // 全 try/catch，绝不外抛（回投失败也只记日志，不冒泡崩进程）。
        service.on('rpc.request', (req) => {
          translateRpcRequest(
            req,
            httpCtx.webServer && typeof httpCtx.webServer.port === 'number'
              ? httpCtx.webServer.port
              : undefined, // 取不到端口由翻译器回退 3080（与宿主默认 webPort 一致）
            (frame) => {
              try {
                service.emit('rpc.result', frame)
              } catch {
                bridgeLog('rpc.result 回投失败（reqId=' + ((frame && frame.reqId) || '?') + '）')
              }
            },
          )
        })

        // ---- 事件流订阅（remote.mux + $events）：bridge 在 dsh 进程内代宿主订阅，
        // 经总线 events 频道转发——宿主无需 WS 连接/鉴权（launchToken 在进程内
        // BrowserAuth，ensureAuthCookie 换发无竞态）。0.1.2 的 $events 只广播
        // api-session/*（added/removed/status/error/activity）；waterfall 帧（审批等）
        // bridge 回投 next 后照转（宿主审批应答适配后续接入）。 ----
        const evtPort = httpCtx.webServer?.port ?? 3080
        let evtWs = null
        let evtClientId = ''
        let evtRetry = 0
        let evtRetryTimer = null
        let evtDisposed = false

        const evtEmit = (frame) => {
          try {
            service.emit('events', frame)
          } catch {
            /* 转发失败不阻断（宿主退订/未连接 no-op） */
          }
        }

        const evtConnect = async () => {
          if (evtDisposed) return
          try {
            const cookie = await ensureAuthCookie(evtPort)
            evtWs = new WebSocket(
              'ws://127.0.0.1:' + evtPort + '/api/remote.mux',
              cookie ? { headers: { Cookie: cookie } } : {},
            )
            evtWs.addEventListener('open', () => {
              evtRetry = 0
              bridgeLog('事件流 remote.mux 已连接（$events 订阅）')
              try {
                evtWs.send(
                  JSON.stringify({
                    type: 'open',
                    streamId: randomUUID(),
                    endpoint: '$events',
                    payload: { args: {} },
                  }),
                )
              } catch (e) {
                bridgeLog('事件流 open 帧发送失败：' + ((e && e.message) || e))
              }
            })
            evtWs.addEventListener('message', (e) => {
              let item = null
              try {
                item = JSON.parse(e.data)
              } catch {
                return
              }
              const value = item && typeof item === 'object' ? item.value : null
              if (!value || typeof value.type !== 'string') return
              if (value.type === 'ready') {
                evtClientId =
                  typeof value.clientId === 'string' ? value.clientId : ''
                evtEmit({ type: 'ready' }) // 宿主就绪信号
                return
              }
              if (value.type === 'waterfall') {
                // 回投 next（宿主只读不处理，否则服务端挂起；fire-and-forget）
                if (evtClientId && typeof value.eventId === 'string') {
                  try {
                    fetch('http://127.0.0.1:' + evtPort + '/api/$events/result', {
                      method: 'POST',
                      headers: {
                        'content-type': 'application/json',
                        ...(cookie ? { cookie } : {}),
                      },
                      body: JSON.stringify({
                        type: 'client-request',
                        rpcId: 'ev_' + Date.now().toString(36),
                        method: '$events/result',
                        payload: {
                          args: {
                            clientId: evtClientId,
                            eventId: value.eventId,
                            outcome: { kind: 'next' },
                          },
                        },
                      }),
                    }).catch(() => {})
                  } catch {
                    /* 回投失败忽略（服务端超时自愈） */
                  }
                }
                evtEmit({
                  type: 'waterfall',
                  event: value.event,
                  eventId: value.eventId,
                  agentId: value.agentId,
                  request: value.request,
                })
                return
              }
              if (value.type === 'emit') {
                evtEmit({ type: 'emit', event: value.event, args: value.args })
              }
              // cancel 帧：忽略（宿主无取消订阅语义，重连自愈）
            })
            evtWs.addEventListener('close', () => {
              evtWs = null
              if (evtDisposed) return
              evtRetry = Math.min(evtRetry + 1, 8)
              const delay = Math.min(1000 * 2 ** evtRetry, 30000)
              bridgeLog(
                '事件流断开，' + delay + 'ms 后重连（第 ' + evtRetry + ' 次）',
              )
              evtRetryTimer = setTimeout(() => evtConnect(), delay)
              evtRetryTimer.unref?.()
            })
            evtWs.addEventListener('error', () => {
              /* 错误由 close 兜底 */
            })
          } catch (e) {
            bridgeLog('事件流连接失败：' + ((e && e.message) || e))
            evtRetry = Math.min(evtRetry + 1, 8)
            evtRetryTimer = setTimeout(
              () => evtConnect(),
              Math.min(1000 * 2 ** evtRetry, 30000),
            )
            evtRetryTimer.unref?.()
          }
        }
        evtConnect()

        const provideDisposer = ctx.provide('dshanaBus', service)

        bridgeLog('bridge 插件已启动（dshana.bus 消息总线服务端，免鉴权）')

        return () => {
          // 卸载：注销 provide + upgrade 路由 + 关闭当前连接 + 事件流订阅
          evtDisposed = true
          if (evtRetryTimer) {
            clearTimeout(evtRetryTimer)
            evtRetryTimer = null
          }
          if (evtWs) {
            try {
              evtWs.close()
            } catch {
              /* 忽略 */
            }
            evtWs = null
          }
          if (provideDisposer && typeof provideDisposer === 'function') {
            try {
              provideDisposer()
            } catch {
              /* 注销失败忽略 */
            }
          }
          if (upgradeDisposer) {
            try {
              upgradeDisposer()
            } catch {
              /* 注销失败忽略 */
            }
            upgradeDisposer = null
          }
          if (conn) {
            try {
              conn.close(1001, 'plugin closing')
            } catch {
              /* 忽略 */
            }
            conn = null
          }
          emitter.removeAllListeners()
        }
      })
    })
  } catch (e) {
    try {
      ctx.logger?.warn?.('[@dsh-hanako/bridge] 插件停用：' + ((e && e.message) || e))
    } catch {
      /* 日志失败不阻断 */
    }
  }
}
