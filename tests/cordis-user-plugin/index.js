// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/cordis-user-plugin — dshana-profile-bundle AC3 验收测试插件（T4 代码准备）。
//
// 用途：走官方 profile 用户层通道的内部自验夹具（spec.md AC3 / tasks.md T4）——
// 极小 cordis 插件包，零依赖（无 import 任何外部包，纯内建），提供可探测服务
// hanaTestProbe（ping() -> "pong"）+ apply 激活日志。激活验证（落位 profile
// node_modules + profile cordis.patch.yml insert + 重启 web host 后 apply 可见/服务可
// 调用）是主上下文验收动作（T3/T5），本文件只做代码准备，不入 build/测试运行链。
//
// 形态对齐 @dsh-hanako/* 子插件：package.json { name, version, private, type: module,
// main: index.js, cordis: { name } } + index.js export name/provide/apply。cordis 插件
// 风格：中文注释 / 单引号 / 无分号。服务注册 = ctx.provide（effect 内注册带 disposer，
// 卸载/HMR 自动注销，防重复注册）。
export const name = 'cordis-user-plugin'
export const provide = ['hanaTestProbe']

export function apply(ctx, config) {
  try {
    ctx.effect(() => {
      const service = {
        ping: () => 'pong',
      }
      const disposer = ctx.provide('hanaTestProbe', service)
      console.log(
        '[cordis-user-plugin] apply 激活：hanaTestProbe 服务已注册（ping() -> "pong"，可用 ctx.inject 探测）',
      )
      return () => {
        try {
          if (typeof disposer === 'function') disposer()
        } catch {
          /* 注销失败忽略 */
        }
      }
    })
  } catch (e) {
    // 容错纪律同内置子插件：apply 不抛出，失败降级控制台 warn（插件停用不阻断 dsh）
    console.warn('[cordis-user-plugin] 停用：' + ((e && e.message) || e))
  }
}
