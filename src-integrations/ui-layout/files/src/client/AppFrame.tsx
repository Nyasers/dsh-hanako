/**
 * Three-column shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * rightbar), the drag handles (pointer capture + rAF throttle), the column
 * solve (columns.ts), and the child-slot render decisions: the sidebar slot
 * receives live parameters from that solve. The root-scoped main slot selects
 * the Conversation or a global panel. Each column occupant owns its Session
 * binding and reports the geometry it needs.
 *
 * The right column is a track, not a box: its occupant draws its panel anchored
 * to the frame's right edge at the resolved normal width, and the
 * track only decides whether the centre makes room for it. The occupant reports
 * shown/track/fullscreen through `ctx.layout`; fullscreen keeps the reported
 * track but hides the outer resize handle. Everything arrives through the framework
 * shares — zero cordis or framework imports, zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import { computeColumns, RIGHTBAR_DEFAULT_RATIO, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT } from './columns.ts'
import { DocumentTitle } from './DocumentTitle.tsx'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'main' | 'rightbar' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>
  & PropsLocale<'common'>

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Subscribe to the main key without subscribing the column frame to each panel id. */
function MainPanel({ usePanelInfo, renderSlot }: Pick<PropsRuntime<'root'>, 'usePanelInfo'> & PropsRenderSlots<'main'>) {
  const panelId = usePanelInfo(info => info.activePanelId)
  return renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })
}

/**
 * Right column grid item. Zero-width unless the occupant asked for a track; the
 * occupant's panel is positioned against the column's right edge, which never
 * moves, so it can hang over the centre when there is no track.
 */
function RightbarColumn(props: { children?: ReactNode }) {
  return <div className={css.rightbarCol} data-rightbar-col>{props.children}</div>
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: { side: 'sidebar' | 'rightbar'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const endDrag = useCallback(() => {
    const active = capture.current
    if (active === null) return
    capture.current = null
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  useEffect(() => endDrag, [endDrag])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || capture.current !== null) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    capture.current = { element: e.currentTarget, id: e.pointerId }
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== e.pointerId) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== e.pointerId) return
    callbacks.current.onDrag(e.clientX - origin.current)
    endDrag()
  }, [endDrag])
  const onPointerCancel = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (capture.current?.id === e.pointerId) endDrag()
  }, [endDrag])

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
      onLostPointerCapture={onPointerCancel}
    />
  )
}

/** The three-column frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  usePanelInfo,
  actions,
  renderSlot,
  t,
}: AppFrameProps) {
  const layoutInfo = useStore(state => state.layoutInfo)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const viewport = layoutInfo.viewportWidth

  // ---- hana 集成（integrations/ui-layout）----
  // 本文件所在的文档属于哪一个「面」，由宿主桥给出：window.__DSHANA__.role。
  // 名字是我们的（样例叫 __HANA_DSH__；我们写自己的 overlay，不沿用它的全局名）。
  // 缺省 / 未知 → workspace。四个面与样例（0.7.0 的 ui-layout 补丁）逐字一致：
  //   workspace   主卡：中列 + 右列；侧栏槽位改挂为**主卡内设置浮层**（settingsShell）
  //   navigation  FP 面板：**纯侧栏单列**，轨道整幅，占满整框
  //   settings    设置面：侧栏槽位横跨全部轨道（settingsCol）
  //   standalone  拆窗：侧栏 + 中列 + 右列，带拖柄
  // 宿主桥由壳页（src/ui/app-shell.js）在注入 DSH 前发布；未发布时按 workspace 退。
  const role = (window as { __DSHANA__?: { role?: string } }).__DSHANA__?.role
  const surface = role === 'navigation' || role === 'settings' || role === 'standalone' ? role : 'workspace'

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useLayoutEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    let disposed = false
    const measure = () => {
      const width = el.getBoundingClientRect().width
      if (width > 0) actions.setViewportWidth(width)
    }
    measure()
    const observer = new ResizeObserver(() => {
      if (disposed) return
      raf ??= requestAnimationFrame(() => {
        raf = null
        measure()
      })
    })
    observer.observe(el)
    return () => {
      disposed = true
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [actions])

  const narrow = surface === 'standalone' && viewport < SIDEBAR_AUTO_COLLAPSE
  // 实装反馈（2026-09-12）：拆窗面不再套用「收起」机制——独立窗口的侧栏始终在。
  // 依据：上游 stores.ts 的初值是 SIDEBAR_DEFAULT（280），所以「sidebar === 0」只可能是
  // 持久化的收起状态（主卡与 FP 都不渲染可折叠的侧栏轨，那个 0 往往来自别处的旧状态 /
  // 宿主快捷键）；原逻辑（source === 'standalone' && (narrow ? !narrowExpanded : sidebar === 0)）
  // 会把它当成收起 → frameSidebarPreference = 0 → 侧栏被零宽吞掉 = 她说的 omit。
  // 现在：宽度取持久值（> 0 尊重用户拖过的宽度），≤ 0 视为没设过 → 用默认宽度；
  // narrow 自动收起也一并去掉（拆窗是用户主动开的窗口，不该替他藏侧栏）。
  const sidebarCollapsed = false
  const sidebarPreference = layoutInfo.sidebar > 0 ? layoutInfo.sidebar : SIDEBAR_DEFAULT
  // 侧栏作为**轨道**只在 standalone 存在；其余面没有可折叠的侧栏轨（见 columns.ts 的
  // sidebarPresent）：workspace 的侧栏槽位是设置浮层，navigation 的侧栏就是整张面。
  const sidebarPresent = surface === 'standalone'
  const frameSidebarPreference = sidebarPresent ? sidebarPreference : 0
  const rightbarPreference = layoutInfo.rightbar ?? viewport * RIGHTBAR_DEFAULT_RATIO
  // Opening on a narrow frame collapses the left sidebar. Eligibility must
  // include that space before the occupant's first shown report arrives.
  const normal = computeColumns(viewport, !layoutInfo.rightbarShown && narrow ? 0 : frameSidebarPreference, rightbarPreference, sidebarPresent)
  const cols = computeColumns(viewport, frameSidebarPreference, layoutInfo.rightbarTrack ? rightbarPreference : 0, sidebarPresent)
  const colsRef = useRef(cols)
  colsRef.current = cols
  const rightbarWidth = useRef(normal.rightbar)
  rightbarWidth.current = normal.rightbar

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const rightbarBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onRightbarStart = useCallback(() => { rightbarBase.current = rightbarWidth.current; setDragging(true) }, [])
  const onRightbarDrag = useCallback((dx: number) => {
    actions.setRightbar(rightbarBase.current - dx)
  }, [actions])
  const productTitle = process.env.DSH_CLIENT_TITLE ?? t('brand.localBuild')
  // 侧栏槽位拿到的宽度：拆窗面按轨道宽；其余面（FP 纯侧栏、设置面）是整幅框宽。
  const renderedSidebarWidth = surface === 'standalone' ? cols.sidebar : viewport
  const sidebar = useMemo(() => renderSlot('sidebar', {
    collapsed: sidebarCollapsed,
    width: renderedSidebarWidth,
  }), [renderSlot, sidebarCollapsed, renderedSidebarWidth])
  const main = useMemo(() => (
    <MainPanel usePanelInfo={usePanelInfo} renderSlot={renderSlot} />
  ), [usePanelInfo, renderSlot])
  const overlays = useMemo(() => renderSlot('shell.overlay', {}), [renderSlot])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{
        // 轨道与样例同款：模板固定三条，列各自认领 grid-column（AppFrame.module.css）；
        // 只有 navigation 是单轨整幅。哪些列渲染由 surface 分支决定，不参与模板计算——
        // 「按渲染集拼轨道」曾把 centerCol 落进 56px 侧栏轨。
        gridTemplateColumns: surface === 'navigation'
          ? 'minmax(0, 1fr)'
          : `${cols.sidebar}px minmax(0, 1fr) ${cols.rightbar}px`,
      }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-rightbar-collapsed={cols.rightbar === 0 || undefined}
      data-rightbar-fullscreen={layoutInfo.rightbarFullscreen || undefined}
      data-rightbar-instant={layoutInfo.rightbarInstant || undefined}
      data-dragging={dragging || undefined}
      /* 自己的面标记（与 data-dshana-view / hana-dshana-role 同一命名习惯）：
         给 CSS 一个按面收紧的钩子——FP（navigation）只有一整幅侧栏，
         侧栏那条 border-right 没有分隔对象（AppFrame.module.css）。 */
      data-dshana-surface={surface}
    >
      <DocumentTitle
        productTitle={productTitle}
        useSessions={useSessions}
        usePanelInfo={usePanelInfo}
      />
      {(surface === 'navigation' || surface === 'standalone') && (
        <div className={css.sidebarCol}>
          {sidebar}
        </div>
      )}
      {(surface === 'workspace' || surface === 'standalone') && (
        <>
          <CenterColumn>{main}</CenterColumn>
          <RightbarColumn>
            {renderSlot('rightbar', { width: normal.rightbar, viewportWidth: viewport, canShow: normal.rightbar > 0 })}
          </RightbarColumn>
        </>
      )}
      {/* 主卡内设置（settingsShell）：样例在 workspace 面把侧栏槽位挂成绝对定位全框浮层，
          承载的是 SettingsRoot 的**面板态**——port 了 integrations/ui-settings-general 之后，
          SettingsRoot 对 workspace 只渲染 panel（不再画触发器），所以这里装的就是"FP 点设置、
          主卡打开"的落点；它自己按共享状态决定开不开。
          （未 port 之前这里只能关掉：上游 SettingsRoot 对任何 role 都画齿轮，挂进全框浮层会
          漂在主卡顶部。现在 role 分叉到位，可以按样例形态打开。） */}
      {surface === 'workspace' && (
        <div className={css.settingsShell}>
          {sidebar}
        </div>
      )}
      {surface === 'settings' && (
        <div className={css.settingsCol}>
          {sidebar}
        </div>
      )}
      <div className={css.overlayLayer} data-shell-overlay>
        {overlays}
      </div>
      {/* The collapsed rail is fixed-width: no resize handle while closed. */}
      {surface === 'standalone' && !sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {(surface === 'workspace' || surface === 'standalone') && layoutInfo.rightbarShown && !layoutInfo.rightbarFullscreen && normal.rightbar > 0 && (
        <DragHandle side="rightbar" left={viewport - normal.rightbar} onStart={onRightbarStart} onDrag={onRightbarDrag} onEnd={onDragEnd} />
      )}
    </div>
  )
}
