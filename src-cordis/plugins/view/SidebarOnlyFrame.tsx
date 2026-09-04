// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// SidebarOnlyFrame —— sidebar 视图（?dshana-view=sidebar）的 root 帧组件。
//
// 角色（fpFullPanel V2）：宿主 fp 面板经 manifest functionPanel.embedUrl 把本页嵌入
// 窄面板 iframe，本帧 = 该 iframe 内的唯一内容面（无 rail 折叠语义，collapsed 恒
// false = 恒 wide 渲染）。单列容器占满宿主面板（高 100% / 宽自适应），容器宽经
// ResizeObserver 实测后作为 sidebar 槽 owner geometry（{ collapsed: false, width }）
// 传给 renderSlot('sidebar')——官方 SidebarRoot（ui-sidebar roster 条目注册进 sidebar
// 槽，官方 bundle 自带 SidebarRoot + primitives）按该 width 渲染自身列宽。
//
// 设计要点：
//  - 不自组官方组件：本帧只声明/渲染 'sidebar' 子槽（declaring is claiming——
//    conversation/details/shell.overlay 不声明，其 ui-* occupant 经 slots.inject 等待
//    声明生命周期，子树不注册不挂载）；SidebarRoot 及其内部子槽（sidebar.brand.* /
//    sidebar.workspaces / sidebar.settings / sidebar.footer.action）全由 roster 里
//    ui-sidebar / ui-workspace / ui-settings-general 的官方 bundle 自注册提供。
//  - 不 import ui-sidebar / primitives 源码：避免把 primitives 依赖树拖进本包。
//  - 高度/滚动语义：fp 面板高度 = iframe viewport，本帧 height:100% 撑满；纵向滚动由
//    SidebarRoot 内嵌滚动区（ui-workspace 会话列表等）自理（开放问题 3 已解除：官方
//    CSS 原生自适应窄宽，无渲染下限），本帧 overflow:hidden 仅兜底防溢出。
//  - 与 AppFrame sidebar 列渲染的差异：AppFrame 经 computeColumns 让步链产出列宽并
//    支持 56px rail 折叠态；本帧无 center/details 列可让步，列宽 = 容器实测宽直传
//    （不做 SIDEBAR_MIN/MAX 截断——宿主 fp 面板宽度是唯一约束，截断会造成溢出或与
//    容器脱节）。
//  - 唯一交互残留：SidebarRoot 顶行 rail toggle（panel 图标）点击 → ctx.layout
//    .toggleSidebar() 只翻转 layout store 偏好（本帧不读 store 几何，无视觉效果）。
//
// 已知限制（V2 如实记录，不做 V4 预实现）：
//  - sidebar.settings occupant（ui-settings-general）点击会弹全视口 1080x700 设置
//    modal，在本 iframe 内必然溢出——跨边联动（modal 改在主页打开）属 V4 联动协议。
//  - main 视图（V3）不做，?dshana-view=main 仍回退完整视图。
import { useEffect, useRef, useState } from 'react'
import css from './SidebarOnlyFrame.module.css'

/**
 * 单列 sidebar 帧：容器宽实测 → renderSlot('sidebar', { collapsed: false, width })。
 * @param props - 框架组合 props（本帧只消费 renderSlot 子槽渲染 share）。
 */
export function SidebarOnlyFrame(props: {
  renderSlot: (name: 'sidebar', owner: { collapsed: boolean; width: number }) => unknown
}) {
  const frameRef = useRef<HTMLDivElement | null>(null)
  // 首帧以 iframe viewport 宽兜底（iframe 内 innerWidth = 宿主面板内容宽），
  // ResizeObserver 首报即校正为容器实测宽；宿主面板宽度可调，观察持续跟随。
  const [width, setWidth] = useState(() => window.innerWidth)

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
    <div ref={frameRef} className={css.frame}>
      {/* sidebar 槽渲染点：collapsed=false 恒 wide（fp 面板唯一内容面，无 rail 语义）；
          width = 容器实测宽，直通 SidebarRoot 列宽（差异说明见文件头）。 */}
      {props.renderSlot('sidebar', { collapsed: false, width })}
    </div>
  )
}
