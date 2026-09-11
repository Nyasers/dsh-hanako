// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/theme 前端 client 模块：把「用户主题偏好」投影到文档属性。
//
// 为什么由本插件做（而不是去 patch 官方 ui-layout 的 ThemePresenter）：偏好是 DSH 侧的事实，
// 而 DSH 客户端插件本来就运行在 DSH 进程内、能直接读主题服务（ctx.theme）；投影是我们自己的
// 映射，不该写进官方文件。官方侧的分工也是这个姿势——ui-theme 的服务显式声明
// “it never touches the DOM”，写 DOM 的职责在 presenter；我们这边同理，本插件只做
// 「把偏好说给文档听」这一件事。
//
// 通道：document.documentElement 的 data-dsh-theme-preference（system | light | dark）。
// 消费方：本插件的注入桥（assets/theme-bridge.js，经 tapIndex 注入 DSH 文档）——它在
// `p === 'system'` 时才把宿主配色压成 DSH token。桥与本 client 半在同一份 DSH 文档里，
// 以属性为契约最省：不需要额外协议，也不跨进程；属性变化即事件（MutationObserver），无轮询。
//
// 约束：本模块只在浏览器面加载；无 document 的构建/测试环境直接跳过。
export const inject = ['theme']

/** 投影属性名（必须与 assets/theme-bridge.js 的读取端一致）。 */
const ATTRIBUTE = 'data-dsh-theme-preference'

/**
 * 注册偏好投影：注册即同步一次（事件可能在注册前已发生），此后跟随 `theme/change`。
 * @param ctx - client cordis context（inject 'theme' = 官方 ui-theme 提供的主题服务）。
 */
export function apply(ctx) {
  const root = typeof document === 'undefined' ? null : document.documentElement
  if (root === null) return
  const write = (preference) => {
    try { root.setAttribute(ATTRIBUTE, preference) } catch { /* 忽略 */ }
  }
  const sync = (snapshot) => {
    const preference = snapshot && typeof snapshot.preference === 'string' ? snapshot.preference : null
    if (preference !== null) write(preference)
  }
  // 注册即同步（getTheme() 是官方读法：返回当前不可变快照）
  try { sync(ctx.theme.getTheme()) } catch { /* 服务未就绪则不写，等事件 */ }
  ctx.effect(() => {
    const off = ctx.on('theme/change', sync)
    return () => {
      try { off() } catch { /* 忽略 */ }
      // 撤走自己写的那一个属性（别人的属性不动）
      try { root.removeAttribute(ATTRIBUTE) } catch { /* 忽略 */ }
    }
  }, 'theme: preference projection')
}
