// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/clipboard — DSH Web UI 剪贴板桥（2026-09-12 起：只有一个 client 半）。
//
// 语义：嵌入场景（DSHana 卡）下 navigator.clipboard.writeText 被宿主的 Permissions-Policy
// 拒绝（真机 permissions.query({name:'clipboard-write'}) → 'denied'）。写权限的绕行在
// **client 半**（client.js）：它 shadow 掉 navigator.clipboard.writeText，原生失败时改走
// 壳页桥（经 __DSHANA__.clipboardWrite → 宿主 capability clipboard.writeText，在宿主主窗口
// 上下文执行，不受插件 iframe 权限链限制）。
//
// 为什么从注入脚本（tapIndex + assets/clipboard-bridge.js）搬进 client 半：同文档注入之后
// 前端与壳页共用一个 window，__DSHANA__ 直接可调，原来那套 postMessage + MessageChannel +
// 超时 + 回执校验的握手协议整套不再需要；注入点、index 改写、独立桥脚本一并删除。
//
// 本半（service 半）**无运行时行为**：构建按包扫 index.js（src-cordis/build.js 的逐包
// rspack），故显式留一个空实现并在注释里记明，不做多余的事（不注册路由、不注入 index）。
// 依赖数组为空——本包不消费任何 cordis 服务。

export const name = '@dsh-hanako/clipboard'

export function apply() {
  /* 就地留白：见文件头“本半无运行时行为”。 */
}
