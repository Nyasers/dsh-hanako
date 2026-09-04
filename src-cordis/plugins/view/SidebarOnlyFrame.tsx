// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// SidebarOnlyFrame —— sidebar 视图（?dshana-view=sidebar）的 root 帧组件。
//
// 角色（fpFullPanel V2，减法式修正）：宿主 fp 面板经 manifest functionPanel.embedUrl
// 把本页嵌入窄面板 iframe，本帧 = 该 iframe 内的唯一内容面（无 rail 折叠语义，
// collapsed 恒 false = 恒 wide 渲染）。
//
// 减法式结构（相对 V2 加法式自组壳的修正）：**复用官方 AppFrame 的 frame/sidebarCol
// 列上下文**（import vendor AppFrame.module.css）——DOM = .frame > .sidebarCol >
// (sidebar 槽)，center/details 列从结构上减掉（“.dv_frame 里只留 .dv_sidebarCol”）。
// SidebarRoot 因此与 full 视图的 sidebar 列同构渲染：sidebarCol 层的专属 fill 背景、
// border-right、overflow 裁剪语义不丢失（V2 自组壳让 SidebarRoot 裸挂 frame，丢列层）。
// .frame 为 grid（官方 gridTemplateRows:100% + overflow:hidden + base 背景），本帧单列
// 布局以 inline gridTemplateColumns: minmax(0,1fr) 占满（子槽收窄见下）。
//
// 设计要点：
//  - 不自组官方组件：本帧只声明/渲染 'sidebar' 子槽（declaring is claiming——
//    conversation/details/shell.overlay 不声明，其 ui-* occupant 经 slots.inject 等待
//    声明生命周期，子树不注册不挂载）；SidebarRoot 及其内部子槽（sidebar.brand.* /
//    sidebar.workspaces / sidebar.settings / sidebar.footer.action）全由 roster 里
//    ui-sidebar / ui-workspace / ui-settings-general 的官方 bundle 自注册提供。
//  - 不 import ui-sidebar / primitives 源码：避免把 primitives 依赖树拖进本包。
//  - 高度/滚动语义：fp 面板高度 = iframe viewport，本帧 height:100% 撑满（.frame
//    height:100% 官方既有）；纵向滚动由 SidebarRoot 内嵌滚动区（ui-workspace 会话列表
//    等）自理（开放问题 3 已解除：官方 CSS 原生自适应窄宽，无渲染下限），.frame/.sidebarCol
//    的 overflow:hidden 兑底防溢出。
//  - 列宽直传：无 center/details 列可让步，列宽 = 容器实测宽直传 renderSlot
//    （不做 SIDEBAR_MIN/MAX 截断——宿主 fp 面板宽度是唯一约束，截断会造成溢出或与
//    容器脱节）。
//  - 唯一交互残留：SidebarRoot 顶行 rail toggle（panel 图标）点击 → ctx.layout
//    .toggleSidebar() 只翻转 layout store 偏好（本帧不读 store 几何，无视觉效果）。
//
// 已知限制（如实记录）：
//  - V4 联动单向收敛后（client.js effect 3 + sync-bridge.js）：sidebar 视图 = 发射端——
//    会话选中变化经 BroadcastChannel 下行广播（含启动握手 boot 宣告），main 主页接收并
//    open 跟随（receive），反向不回发（main 无切换 UI）；full 不参与桥。会话增删/重命名/
//    workspace 列表走 dsh 数据面天然一致，不走桥（详见 sync-bridge.js 头「单向收敛」段）。
//  - sidebar.settings occupant（ui-settings-general）的 trigger → 1080x700 modal 打开是
//    SettingsRoot 组件内本地态，官方无可编程 open/关闭面、main 视图无其宿主（无侧栏）、
//    槽规则封死干净拦截面——V4 调研结论 = 跨边不可行（待上游支持），本地弹出溢出保持
//    现状并记录（见 sync-bridge.js 头「settings 跨边」段）。
//  - main 视图为 V3 修正（client.js：自组 MainFrame 减法式——.dv_frame 只留
//    .dv_centerCol + .dv_detailsCol、无 sidebar，见 MainFrame.tsx），本帧只服务 sidebar 视图。
import { useEffect, useRef, useState } from 'react'
// 复用官方 AppFrame 的列上下文 CSS（.frame/.sidebarCol）：sidebar 视图与 full 视图的
// sidebar 列同构渲染。同 bundle 幂等注入（css-modules 虚拟 loader 按包+文件去重，
// full/sidebar 两视图引用同一 vendor css 不重复注 style）。
import css from './vendor/AppFrame.module.css'

/**
 * 单列 sidebar 帧（减法式）：.frame 内只留 .sidebarCol → renderSlot('sidebar')。
 * @param props - 框架组合 props（本帧只消费 renderSlot 子槽渲染 share）。
 */
export function SidebarOnlyFrame(props: {
  renderSlot: (name: 'sidebar', owner: { collapsed: boolean; width: number }) => unknown
}) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  // 首帧以 iframe viewport 宽兜底（iframe 内 innerWidth = 宿主面板内容宽），
  // ResizeObserver 首报即校正为容器实测宽；宿主面板宽度可调，观察持续跟随。
  const [width, setWidth] = useState(() => window.innerWidth)

  // sidebar 减法（logoRow）：fp 窄栏顶部品牌 logo 行（SidebarRoot logoRow——wide 态 = brand/
  // New Session 快捷）在宿主 fp 面板冗余，剪除。官方 class 为 css-modules hash_local 产物
  // （如 hHd-Xa_logoRow），local 名后缀稳定 → [class$="_logoRow"] 属性后缀匹配不受 hash
  // 变化影响；作用域限定本帧 data-sidebar-frame，不影响 full 视图的 sidebar 列。
  // 样式动态注入（style 标签 + !important 压官方 css 注入序），卸载即清。
  useEffect(() => {
    if (typeof document === 'undefined') return
    const tagId = 'dshana-sidebar-subtract-logoRow'
    if (document.querySelector('style[data-dshana-subtract="' + tagId + '"]') !== null) return
    const tag = document.createElement('style')
    tag.dataset.dshanaSubtract = tagId
    tag.textContent =
      '[data-sidebar-frame] [class$="_logoRow"] { display: none !important }'
    document.head.appendChild(tag)
    return () => {
      try { if (tag.parentNode) tag.parentNode.removeChild(tag) } catch { /* 已脱离 */ }
    }
  }, [])

  // 容器框级测量（同 AppFrame frame 自测语义：rAF 节流 + 取边框盒宽）。
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- effect 运行期 ref 恒已挂载（frame div 无条件渲染）。 */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const measured = el.getBoundingClientRect().width
        if (measured > 0) setWidth(measured)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      data-sidebar-frame=""
      style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
    >
      {/* 减法：.frame 内只留官方 .sidebarCol 列（fill/边框/裁剪上下文与 full 视图 sidebar
          列同构），center/details 列从结构上减除；sidebar 槽渲染点 collapsed 恒 false
          （fp 面板唯一内容面，无 rail 语义），width = 容器实测宽直通 SidebarRoot。 */}
      <div className={css.sidebarCol}>
        {props.renderSlot('sidebar', { collapsed: false, width })}
      </div>
    </div>
  )
}
