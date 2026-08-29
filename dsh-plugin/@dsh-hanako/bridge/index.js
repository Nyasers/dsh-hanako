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
import { handleUpgrade } from './ws-lib.js'

export const name = '@dsh-hanako/bridge'
export const inject = ['webServer']

// ---- 常量 ----
const BUS_PATH = '/api/dshana.bus' // upgrade 路由路径（宿主连 ws://127.0.0.1:<port> 该路径）
const HELLO_TIMEOUT_MS = 5000 // 握手超时（5s 未发 hello 关闭）
const HELLO_CLOSE_CODE = 1008 // 握手失败关闭码（非 hello 首帧/超时）
const REPLACED_CLOSE_CODE = 1001 // 旧连接被新连接顶掉

// ---- 插件 apply：注册 upgrade 路由 + 提供 dshanaBus 服务（全程容错，降级不阻断）----
export function apply(ctx, config) {
  try {
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
            conn.sendText(JSON.stringify(frame))
            return true
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
            emitter.on(key, cb)
            return () => emitter.off(key, cb)
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
        const provideDisposer = ctx.provide('dshanaBus', service)

        bridgeLog('bridge 插件已启动（dshana.bus 消息总线服务端，免鉴权）')

        return () => {
          // 卸载：注销 provide + upgrade 路由 + 关闭当前连接
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
