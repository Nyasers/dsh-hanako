// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// MainFrame —— main 视图（?dshana-view=main）的 root 帧组件（fpFullPanel V3 修正）。
//
// 角色：main = 无侧栏「主页」视图（V4 联动协议的宿主主页端——单向收敛后为选中态桥的
// receive 接收端：接收 sidebar 下行 select/clear 应用到本地，本地变化不回发，见
// sync-bridge.js 头）。V3 旧版（16293c5）以官方
// AppFrame + createMainLayoutStore(init sidebar:0) 实现——实机验证发现官方
// panels.sidebar=0 的语义是 **56px rail 折叠态**（SidebarRoot 仍在，可展开 280），并非
// 「隐藏 sidebar」。用户裁定：main 要**真无侧栏**（无 rail、无 SidebarRoot）——按
// SidebarOnlyFrame（8ee74f6）同款减法式自组本帧：.dv_frame 只留
// .dv_centerCol + .dv_detailsCol，.sidebarCol 及其整条渲染链从结构上减除。
//
// 减法式结构（同 SidebarOnlyFrame 模式）：复用官方 AppFrame 的列上下文 CSS（import
// vendor/AppFrame.module.css；同 bundle 幂等注入，full/main/sidebar 引用同一 vendor css
// 不重复注 style）。DOM = .frame（inline gridTemplateColumns 两列）> (.centerCol >
// conversation 槽) + (.detailsCol > SessionProvider > details 槽)；shell.overlay 槽照常
// 在 frame 内 overlayLayer 渲染（AppFrame 同构）。sidebar 槽在 client.js MAIN_CHILDREN
// 中**声明且本帧隐藏渲染**：声明保 ui-sidebar 直接 register 不炸（它是 register 非 inject
// 惰性，槽不声明会抛错致 client 链崩，实机踩过）；渲染端不调 renderSlot('sidebar') →
// occupant 挂载不渲染，SidebarRoot 与 rail 图标条不进入 DOM）；本帧也不 import
// ui-sidebar/primitives 源码。
//
// 例外（feat/settings-cross-edge 隐藏宿主）：sidebar 槽**隐藏渲染**到屏幕外 fixed 容器
// （data-sidebar-settings-host）——SidebarRoot 全家挂载（官方 full 视图 sidebar+
// conversation 同帧并存即官方常态，无新增冲突面；流内容被容器 overflow:hidden 裁剪不可
// 见），仅作 sidebar.settings occupant（SettingsRoot）的 mount 宿主：modal 为 fixed 全视口
// （SettingsRoot.module.css .overlay），DOM 虽在宿主内但 fixed 不受祖先 overflow 裁剪
// （无 transform 链）→ main 收到 open-settings 后程序 click 宿主内官方 trigger
// （button[aria-haspopup=dialog]）即官方打开。详见 sync-bridge.js 头「settings 跨边」。
//
// 几何（两列自解，不用官方三列 computeColumns——其解含 sidebar 列，sidebar=0 也会解出
// SIDEBAR_COLLAPSED 56px rail 占宽，不可用；窄视口折叠语义 SIDEBAR_AUTO_COLLAPSE 属
// sidebar，main 无 sidebar 故整体去掉）：
//   details 开 = 存在当前会话（useSessions current 且 blank!==false）且 panels.details>0
//     → details = clampWidth(panels.details, DETAILS_MIN 300, DETAILS_MAX 520)，
//     center = minmax(0,1fr) 吸收余宽（下限 0）；
//   details 关 = 0 宽（detailsCol 零宽保挂载不卸载，.frame[data-details-collapsed] 去
//     1px seam 边框，同官方）；center 全宽。
//
// 保留的官方渲染链（自 vendor AppFrame.tsx 减法复制；AppFrame 保留原样供 full 视图用）：
//   details 会话感知（detailsSession 判定 + 会话切换 actions.closeDetails）、viewport
//   框级自测（ResizeObserver + rAF）、DocumentTitle 投影（productTitle + 会话标题）、
//   details 拖拽 handle（.handle side=details：pointer capture + rAF 节流 dx）与
//   data-dragging 过渡暂停、overlay 层。sidebar 相关（sidebar 槽渲染、sidebar 拖拽
//   handle、narrow/setNarrow/rail 折叠、data-sidebar-collapsed）全部减除。
//   复制片段来自 MIT 上游（deepseek-ai/deepseek-harness，dsh-v0.1.2-rc.1，见
//   vendor/README.md 来源与许可）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import { clampWidth, DETAILS_MAX, DETAILS_MIN } from './vendor/columns.ts'
import { DocumentTitle } from './vendor/DocumentTitle.tsx'
import type { createLayoutStore } from './vendor/stores.ts'
import css from './vendor/AppFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share
 * （与官方 AppFrame 同源框架 shares；子槽并集不含 sidebar——main 无 sidebar 渲染点）。 */
export type MainFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'conversation' | 'details' | 'shell.overlay' | 'sidebar'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & PropsLocale<'common'>

/** Center column grid item（官方同构）。 */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close)。 */
function DetailsColumn(props: { children?: ReactNode }) {
  return <div className={css.detailsCol}>{props.children}</div>
}

/** 拖拽 handle：官方 DragHandle 减法复制（side 仅 details 使用；pointer capture +
 * rAF-throttled dx，side 键控 hover-reveal CSS 归属列）。 */
function DragHandle(props: { side: 'details'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  const onPointerCancel = useCallback(() => {
    // pointercancel：浏览器接管手势（平移/缩放/触屏打断）——同一指针流不再有
    // pointerup，capture 已隐式释放（onPointerUp 的 hasPointerCapture 守卫会提前
    // return，不能复用）。cleanup 必须照跑：残留 rAF/ dragging 会把帧卡在拖拽态
    // （data-dragging 不褪、过渡不恢复）。流的最后位置无意义，不补最后一拍 drag。
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    />
  )
}

/**
 * 两列无侧栏主帧（减法式）：.frame 内只留 center/details 两列 + overlay 层，无
 * .sidebarCol。官方三列让步链（含 SIDEBAR_COLLAPSED rail 占宽）不适用——几何自解两列
 * （见文件头「几何」段）；窄视口折叠语义（SIDEBAR_AUTO_COLLAPSE/setNarrow）无 sidebar
 * 故减除，不读 narrow/narrowExpanded。
 * @param props - 框架组合 props（与官方 AppFrame 同款 destructure：useStore/useSessions/
 *   actions/renderSlot/SessionProvider/t；register 按 root 条目注入，见 client.js）。
 */
export function MainFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
  SessionProvider,
  t,
}: MainFrameProps) {
  const panels = useStore(s => s)
  // details 会话感知：当前会话存在且非 blank（同官方 AppFrame 判定）→ details 列可用。
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  // 浏览器标题 = 当前会话标题（若有）投影（同官方）。
  const documentTitle = useSessions((s) => {
    const current = s.current
    return current === undefined ? undefined : s.byId[current]?.title
  })
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)

  // 会话切换即收 details（同官方 useLayoutEffect 段：跨会话不残留上一会话 details 列）。
  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // 帧框级测量（同官方 frame 自测语义：ResizeObserver + rAF 节流 + 取边框盒宽）。
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // 两列几何：details 开 = 有当前会话且 store 偏好 >0 → 偏好 clamp 进契约区间；
  // center 轨 minmax(0,1fr) 吸收余宽（下限 0）。details 关 = 0 宽、center 全宽。
  // 拖拽基准 = 拖动开始时的已渲染宽（被 clamp 过的列边不得回跳 store 偏好，官方同款）；
  // 手势期间帧级过渡暂停（data-dragging → CSS transition:none）。
  const detailsWidth = detailsSession !== undefined && panels.details > 0
    ? clampWidth(panels.details, DETAILS_MIN, DETAILS_MAX)
    : 0
  const colsRef = useRef({ details: detailsWidth, viewport })
  colsRef.current = { details: detailsWidth, viewport }

  const detailsBase = useRef(0)
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = colsRef.current.details; setDragging(true) }, [])
  const onDetailsDrag = useCallback((dx: number) => {
    actions.setDetails(detailsBase.current - dx)
  }, [actions])
  const productTitle = process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')

  // settings 宿主键盘可达性（CodeRabbit 闭环）：隐藏子树若可被顺序导航 Tab 到，焦点指示
  // 会消失到屏幕外。动态 inert——容器默认 inert（子树不可 Tab/不可点），仅当官方
  // settings dialog（role=dialog）挂载时解除（modal 打开后焦点/交互官方管理，主诉为关闭
  // 态漫游 Tab 丢焦点）；MutationObserver 监控容器内 dialog 出现/消失同步切换。
  const settingsHostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const host = settingsHostRef.current
    /* v8 ignore next -- effect 运行期 ref 恒已挂载（host 无条件渲染）。 */
    if (host === null) return
    host.inert = true
    const updateInert = () => {
      const hasDialog = host.querySelector('[role="dialog"]') !== null
      if (hasDialog !== host.inert) return // inert === !hasDialog 已一致
      host.inert = !hasDialog
    }
    const observer = new MutationObserver(updateInert)
    observer.observe(host, { childList: true, subtree: true })
    return () => { observer.disconnect() }
  }, [])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{ gridTemplateColumns: 'minmax(0, 1fr) ' + detailsWidth + 'px' }}
      data-details-collapsed={detailsWidth === 0 || undefined}
      data-dragging={dragging || undefined}
    >
      <DocumentTitle
        productTitle={productTitle}
        {...documentTitle === undefined ? {} : { title: documentTitle }}
      />
      {/* 减法：无 .sidebarCol。conversation（session-maybe）固定 center 列位；details
          （strict）由 SessionProvider 在无当前会话时 withheld——同官方结构。 */}
      <CenterColumn>{renderSlot('conversation', {})}</CenterColumn>
      <DetailsColumn>
        <SessionProvider>{renderSlot('details', {})}</SessionProvider>
      </DetailsColumn>
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {/* 仅 details 拖拽 handle（sidebar 无 rail/列，不存在 resize）。 */}
      {detailsWidth > 0 && <DragHandle side="details" left={viewport - detailsWidth} onStart={onDetailsStart} onDrag={onDetailsDrag} onEnd={onDragEnd} />}
      {/* settings 跨边隐藏宿主（见文件头「例外」段）：屏幕外 fixed 容器不占 grid 位、
          无视觉；SidebarRoot 全家在此挂载（官方 full 同帧并存常态），流内容被 overflow
          hidden 裁剪，仅 settings modal 宿主可见（fixed 全视口不受裁）。data 标记供
          client.js 定位宿主内官方 trigger。
          层叠陷阱（实机定案）：position:fixed 元素**总是创建 stacking context**（无论
          z-index）——容器 z-auto 沉层叠第 6 层，容器内 modal overlay 的 z1000 被压扁在
          容器 SC 内；conversation 的 positive z 元素（tabs z1、composerSeat z7）在文档级
          第 7 层 → 盖过整个容器（用户实测输入框层级在设置之上）。修法 = 容器自身提升
          z-index（1000，与官方 overlay 同层语义）：容器 SC 整体提到文档高层层叠，内部
          modal 正常盖 conversation；屏幕外定位不受 z 影响。
          键盘可达性：容器默认 inert（见上 effect），dialog 挂载时自动解除。 */}
      <div
        ref={settingsHostRef}
        data-sidebar-settings-host=""
        style={{ position: "fixed", left: -10000, top: 0, width: 280, height: 600, overflow: "hidden", zIndex: 1000 }}
      >
        {renderSlot("sidebar", { collapsed: false, width: 280 })}
      </div>
    </div>
  )
}