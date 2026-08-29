// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/logger — DSHana 统一日志服务（v0.10.8；v0.22.1+ 改总线转发）。
//
// 语义：theme / provider / settings 三个内嵌 cordis 插件原本各自内联一份几乎相同的
// 日志辅助函数，本插件收敛为单一实现——经 cordis 服务注入提供 log 接口
// （provide ['hanaLogger']，驼峰与属性访问一致、与内置服务（webServer/agentDefaultModel）
// 同风格；注意不能用 'logger'：那是 cordis 内置 LoggerService 的服务名，已被占用，
// provide 同名会抛“service has been registered”；也不能用连字符名——注入后属性按服务名
// 原样挂载（ctx['hana-logger']），驼峰才能 ctx.hanaLogger 直接访问），消费方声明
// inject ['hanaLogger'] 后经 ctx.inject(['hanaLogger'], (logCtx) =>
// logCtx.hanaLogger.log(src, msg)) 统一调用。
//
// v0.22.1+（bus 收敛）：不再写 logPath 文件（patch 静态化后无 logPath 占位符注入）——
// 改为收集 dsh 内部日志 → 经 dshanaBus 总线 emit("log", { src, line }) 直投宿主，
// 宿主侧 src/lib/bus.js 监听 log 通道 → g.appendLog(src, line) 写会话文件
// （行格式 [<HH:mm:ss.SSS>] [<src>] <内容> 由宿主侧统一，src 前缀不变）。
// bus 未连接（宿主未连/握手未完成）时：有界环形缓冲（≤500 行），连接后按序补发
// （逐条 emit，保证顺序；缓冲满丢最旧，不阻塞主流程）。发送失败（emit 返回 false/
// 异常）的记录不清除——保留在缓冲中，重连后下次补发重试；live 行发送失败同样入缓冲
// 待重试，不丢日志。
//
// 依赖：inject ['dshanaBus']（@dsh-hanako/bridge 提供的消息总线服务）。bridge 不再
// 注入 hanaLogger（避免循环依赖——bridge 自身日志经总线 log 帧直投宿主 + ctx.logger
// 兜底）。服务不自己记日志（无 [logger] 行），仅提供 log 接口；写失败静默返回。
//
// 容错纪律：apply 全程 try/catch 不抛出——依赖缺失降级为控制台输出（插件降级不阻断
// dsh 启动）。注释风格同 @dsh-hanako/provider（中文/单引号/无分号）。

export const name = '@dsh-hanako/logger'
export const inject = ['dshanaBus']
export const provide = ['hanaLogger']

// ---- 常量 ----
const BUFFER_CAP = 500 // 有界环形缓冲上限（≤500 行）

export function apply(ctx, config) {
  try {
    ctx.inject(['dshanaBus'], (httpCtx) => {
      httpCtx.effect(() => {
        let bus = null
        try {
          bus = httpCtx.dshanaBus
        } catch {
          /* 依赖缺失：下方降级控制台输出 */
        }
        // 有界环形缓冲（bus 未连接期间累积；连接后按序补发）
        const buffer = []
        let lastConnected = false

        // 发送单行：返回是否送达（bus.emit 结果为 false = 未入队/写失败；异常按未送达处理）
        const sendLine = (src, line) => {
          try {
            if (bus && typeof bus.emit === 'function') {
              return bus.emit('log', { src, line }) === true
            }
          } catch {
            /* 发送异常：按未送达处理（调用方保留记录待重试） */
          }
          return false
        }

        // 连接状态检查 + 缓冲补发：每次 log 调用时判断——未连接入缓冲，已连接先补发再直发。
        // 补发仅清除送达成功的记录（sendLine 返回 true）；发送失败的记录保留在缓冲中，
        // 重连后下次补发重试（有界缓冲满丢最旧仍由入缓冲侧保证，不丢已送达的顺序）。
        const flushBuffer = () => {
          if (!bus || typeof bus.status !== 'function') return
          try {
            if (bus.status().connected !== true) return
          } catch {
            return
          }
          if (buffer.length === 0) return
          const retained = []
          for (const item of buffer) {
            if (!sendLine(item.src, item.line)) retained.push(item)
          }
          // 只保留发送失败的记录：成功清掉，失败原序保留
          if (retained.length === 0) buffer.length = 0
          else buffer.splice(0, buffer.length, ...retained)
        }

        const service = {
          log(src, msg) {
            try {
              if (!msg) return
              let line = String(msg)
              // 多行文本逐行发送（行格式 [ts] [src] 前缀由宿主侧统一加，这里按行拆）
              const lines = line.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
              for (const l of lines) {
                const t = l.trimEnd()
                if (!t) continue
                const connected =
                  bus && typeof bus.status === 'function'
                    ? (() => {
                        try {
                          return bus.status().connected === true
                        } catch {
                          return false
                        }
                      })()
                    : false
                // 断连→连上：先补发缓冲（按序）
                if (connected && !lastConnected) {
                  lastConnected = true
                  flushBuffer()
                } else if (!connected) {
                  lastConnected = false
                }
                if (connected) {
                  // live 直发：发送失败（未入队/写失败）也保留入缓冲，重连后补发重试
                  if (!sendLine(src, t)) {
                    // 有界环形缓冲：满则丢最旧
                    if (buffer.length >= BUFFER_CAP) buffer.shift()
                    buffer.push({ src, line: t })
                  }
                } else {
                  // 有界环形缓冲：满则丢最旧
                  if (buffer.length >= BUFFER_CAP) buffer.shift()
                  buffer.push({ src, line: t })
                }
              }
            } catch {
              /* 日志失败不阻断 */
            }
          },
        }
        ctx.provide('hanaLogger', service)
      })
    })
  } catch (e) {
    try {
      ctx.logger?.warn?.('[@dsh-hanako/logger] 插件停用：' + ((e && e.message) || e))
    } catch {
      /* 日志失败不阻断 */
    }
  }
}
