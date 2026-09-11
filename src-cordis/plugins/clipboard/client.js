// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/clipboard 前端 client 半（2026-09-12 改：由注入脚本搬到这里）。
//
// 为什么仍然盖在 navigator.clipboard.writeText 这一层（她定的方向，我核对过调用点）：
// 嵌入场景里这条 API 被宿主的 Permissions-Policy 关死（真机
// navigator.permissions.query({name:'clipboard-write'}) → 'denied'，宿主侧暂不好改）。
// 而 copy 的调用点散在多处：
//   · ui-primitives 的 helper —— CodeBlock / DiffBlock / ReadBlock / HoverCard /
//     use-copy-feedback 都以**同包相对导入**使用它（构建期就内联了），外面够不着；
//   · ui-chat 的 MessageIconActions 从包根 named import；
//   · ui-primitives 的 JsonTree 那处**绕过 helper 直接调** navigator。
// 所以能一次盖住全部调用点、又不进别人包产物的层，只有这个实例方法本身。
// （模块级 shadow 已评估并否决：够不着包内调用点，还会漏掉 JsonTree。）
//
// 为什么从 tapIndex 注入脚本搬到这里（同文档注入的红利）：
// 壳页把 DSH 前端**注入同一个文档**之后，本 client 半与壳页在同一个 window 里，
// window.__DSHANA__ 直接可调——原来那套 postMessage + MessageChannel + 2.5s 超时 +
// 回执 origin 校验的握手协议（iframe 套 iframe 时代的产物，配套壳页的 __dshCopy 监听）
// 整套删除，注入脚本也不再需要。少了协议、少了注入点、少了 index 改写。
//
// 行为（刻意保持与旧注入脚本一致）：每次调用**先试原生**——宿主将来放开策略、或非嵌入
// 场景下原生直接成功，本 shim 就是透明的；原生失败才走桥（宿主能力 hana.clipboard.writeText，
// 在宿主主窗口上下文执行，不受插件 iframe 权限链限制）。桥也不可用时**抛回错误**，
// 不静默假装成功（上游 writeClipboard 语义：失败返回 false，调用方据此给失败反馈）。
//
// 约束：只在浏览器面加载；无 navigator 的构建/测试环境直接跳过。
export function apply(ctx) {
  if (typeof navigator === 'undefined') return
  const clipboard = navigator.clipboard
  if (clipboard === undefined || clipboard === null) return
  const original = typeof clipboard.writeText === 'function' ? clipboard.writeText.bind(clipboard) : null

  const bridgeWrite = (text) => {
    const b = typeof globalThis === 'undefined' ? null : globalThis.__DSHANA__
    const fn = b && typeof b.clipboardWrite === 'function' ? b.clipboardWrite : null
    if (fn === null) return Promise.reject(new Error('clipboard bridge unavailable'))
    return Promise.resolve(fn(text))
  }
  const shadow = (text) => {
    if (original === null) return bridgeWrite(text)
    let p
    try {
      p = original(text)
    } catch {
      return bridgeWrite(text)
    }
    if (p && typeof p.then === 'function') {
      return p.then(
        () => undefined,
        () => bridgeWrite(text),
      )
    }
    return bridgeWrite(text)
  }

  ctx.effect(() => {
    try {
      clipboard.writeText = shadow
    } catch {
      /* 实例不可写：保持原生行为（降级不阻断） */
    }
    return () => {
      // 撤走自己写的那个方法（别人的属性不动）；只恢复我们自己覆盖过的那种情况
      try {
        if (original !== null && clipboard.writeText === shadow) clipboard.writeText = original
      } catch {
        /* 忽略 */
      }
    }
  }, 'clipboard: shadow navigator.clipboard.writeText')
}
