/**
 * Settings shell root: the sidebar-foot trigger row plus the centered modal
 * panel (figma 501:29947, 1080x700) with the section nav rail. The shell is
 * a pure composition face — slot-owned text (trigger label, panel title,
 * close label, sections) arrives from registrants through slots; accessible
 * names resolve from localized content (trigger: shell locale; dialog:
 * aria-labelledby the title node; close: visually-hidden slot text). Modal
 * open state and the active section id are component-local viewing state;
 * the onboarding coordinator mounts exactly one ordered registrant while the
 * sessions-derived empty-Hero fact is active. Visible dialog chrome belongs
 * to the step, so a mounted-but-deciding step paints nothing here.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  ConnectionIndicator,
  IconAgentPresetOutline16, IconCloseOutline16, IconDataOutline16,
  IconPersonalizationOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConnectionIndicatorState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps, SettingsSectionRow } from './shell-contract.ts'
import css from './SettingsRoot.module.css'

const RECOVERY_CONFIRMATION_MS = 2_000

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutline16 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

type PanelProps = {
  rows: readonly SettingsSectionRow[]
  renderSlot: SettingsRootComponentProps['renderSlot']
  activeId: string | undefined
  onSelect: (id: string) => void
  onClose: () => void
  /** hana 集成：true = 占满宿主（settings 面的整列），不再是全视口模态。 */
  embedded?: boolean
}

/** hana 集成（integrations/ui-settings-general）：跨面共享的设置视图状态。 */
export type SettingsView = { open: boolean; section: string | null }

/** 宿主桥（我们的全局名是 __DSHANA__，样例叫 __HANA_DSH__）。 */
type HanaSettingsBridge = {
  role?: string
  readSettingsView?: () => Promise<SettingsView>
  writeSettingsView?: (next: SettingsView) => Promise<void>
  onSettingsViewChanged?: (listener: () => void) => () => void
}

/**
 * 读宿主桥。为什么需要它（见样例同款设计）：
 *   · role —— workspace 面不画触发器、只画面板；navigation（FP）面画触发器；settings 面直接 embedded
 *   · read/write/onChanged —— 「FP 点设置、主卡打开」靠的是一份共享的视图状态（键按卡片实例配对）
 * 桥缺席时全部退化为上游行为（本地状态、本地面板），不会崩。
 */
function hanaBridge(): HanaSettingsBridge | undefined {
  return (globalThis as { __DSHANA__?: HanaSettingsBridge }).__DSHANA__
}

/**
 * The modal layer: full-viewport mask + centered panel. Close paths: the
 * header button, a mask click, and document-level Escape (mounted only while
 * open, so the listener lifetime is the panel's).
 */
function SettingsPanel({ rows, renderSlot, activeId, onSelect, onClose, embedded = false }: PanelProps) {
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const active = rows.find(r => r.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // Entering the dialog focuses the close button; the root restores its trigger on close.
  // embedded（占满整列）不是对话框，不抢焦点。
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { if (!embedded) closeButton.current?.focus() }, [embedded])

  return (
    <div className={embedded ? css.embedded : css.overlay} role={embedded ? 'region' : 'presentation'}>
      {!embedded && <div className={css.mask} aria-hidden="true" onClick={onClose} />}
      <div className={clsx(css.panel, embedded && css.embeddedPanel)} role={embedded ? undefined : 'dialog'} aria-modal={embedded ? undefined : 'true'} aria-labelledby={titleId}>
        <nav className={css.nav}>
          <div className={css.navTitle} id={titleId}>{renderSlot('settings.header', {})}</div>
          <div className={css.navList}>
            {rows.map(row => (
              <button
                key={row.id}
                type="button"
                className={clsx(css.navCell, row.id === active && css.active)}
                aria-current={row.id === active ? 'true' : undefined}
                onClick={() => { onSelect(row.id) }}
              >
                {navIcon(row.id)}
                <span className={css.navLabel}>{row.label}</span>
              </button>
            ))}
          </div>
        </nav>
        <div className={css.content}>
          <div className={css.header}>
            <div className={css.actions}>{renderSlot('settings.action', {})}</div>
            <button ref={closeButton} type="button" className={css.close} onClick={onClose}>
              <IconCloseOutline16 size={14} />
              <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
            </button>
          </div>
          <div className={css.options}>
            {active !== undefined && renderSlot('settings.section', { close: onClose }, { only: active })}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const {
    wide, reconnect, useConnectionState, useSections, useOnboardingSteps, useSessions, renderSlot, t,
  } = props
  // hana 集成：角色与共享的设置视图状态都来自宿主桥（见 hanaBridge 注释）。
  const bridge = hanaBridge()
  const role = bridge?.role ?? 'navigation'
  const readView = bridge?.readSettingsView
  const writeView = bridge?.writeSettingsView
  const onViewChanged = bridge?.onSettingsViewChanged
  const [open, setOpen] = useState(false)
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  const [showRecovery, setShowRecovery] = useState(false)
  const [viewFailure, setViewFailure] = useState<{ kind: 'read' | 'write'; revision: number } | null>(null)
  const triggerButton = useRef<HTMLButtonElement | null>(null)
  const wasOpen = useRef(open)
  const viewRevision = useRef(0)
  const pendingWrite = useRef<{ next: SettingsView; revision: number } | null>(null)
  const refreshSettingsView = useRef<(() => void) | undefined>(undefined)

  // 把视图状态写出去（revision 守卫：晚到的写不覆盖新状态；失败保留可重试信息）——同样例。
  const publish = useCallback((next: SettingsView) => {
    const revision = ++viewRevision.current
    pendingWrite.current = { next, revision }
    setViewFailure(null)
    if (writeView === undefined) {
      setViewFailure({ kind: 'write', revision })
      return
    }
    void writeView(next).then(() => {
      if (pendingWrite.current?.revision === revision) pendingWrite.current = null
    }, (error: unknown) => {
      if (revision !== viewRevision.current) return
      console.error('DSH settings view could not be synchronized.', error)
      setViewFailure({ kind: 'write', revision })
    })
  }, [writeView])

  const close = useCallback(() => {
    setOpen(false)
    setActiveId(undefined)
    publish({ open: false, section: null })
  }, [publish])
  // Restore after the close commit, when the dialog can no longer own focus.
  useEffect(() => {
    if (wasOpen.current && !open) triggerButton.current?.focus()
    wasOpen.current = open
  }, [open])
  const openSection = useCallback((id?: string) => {
    if (id !== undefined) setActiveId(id)
    setOpen(true)
    publish({ open: true, section: id ?? activeId ?? null })
  }, [activeId, publish])

  // 跟随共享状态：只有 workspace / standalone 订阅并应用——
  // FP（navigation）是发射端（点设置写出去），主卡是接收端（读进来以模态面板打开）。
  useEffect(() => {
    if (role === 'navigation' || role === 'settings' || readView === undefined || onViewChanged === undefined) {
      refreshSettingsView.current = undefined
      return
    }
    let active = true
    let generation = 0
    const refresh = () => {
      const request = ++generation
      const revision = viewRevision.current
      void readView().then((next) => {
        if (!active || request !== generation || revision !== viewRevision.current) return
        setOpen(next.open)
        setActiveId(next.section ?? undefined)
      }, (error: unknown) => {
        if (!active || request !== generation) return
        console.error('DSH settings view could not be read.', error)
        if (revision === viewRevision.current) setViewFailure({ kind: 'read', revision })
      })
    }
    const off = onViewChanged(refresh)
    refreshSettingsView.current = refresh
    refresh()
    return () => {
      active = false
      generation++
      if (refreshSettingsView.current === refresh) refreshSettingsView.current = undefined
      off()
    }
  }, [readView, onViewChanged, role])

  // The ledger tick keeps the nav rows fresh: registrants re-register with
  // freshly localized text on locale change, and the trigger/header/close
  // seats re-render through their own outlets' subscriptions.
  const rows = useSections(s => s)
  const connectionState = useConnectionState(state => state)
  const previousConnectionState = useRef(connectionState)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  // 引导态只有主卡 / 拆窗面持有（同样例）：FP 与设置面不抢 onboarding。
  const ownsOnboarding = role === 'workspace' || role === 'standalone'
  const onboardingStep = ownsOnboarding && onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  useLayoutEffect(() => {
    const previous = previousConnectionState.current
    previousConnectionState.current = connectionState
    if (connectionState !== 'connected') {
      setShowRecovery(false)
      return
    }
    if (previous !== 'disconnected' && previous !== 'connecting') return
    setShowRecovery(true)
    const timeout = window.setTimeout(() => { setShowRecovery(false) }, RECOVERY_CONFIRMATION_MS)
    return () => { window.clearTimeout(timeout) }
  }, [connectionState])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  let connectionIndicator: ConnectionIndicatorState | undefined
  if (connectionState === 'disconnected') {
    connectionIndicator = 'disconnected'
  } else if (connectionState === 'connecting') {
    connectionIndicator = 'connecting'
  } else if (showRecovery) {
    connectionIndicator = 'recovered'
  }

  // 设置面：整列 embedded，无触发器、无模态。
  if (role === 'settings') {
    return (
      <SettingsPanel
        rows={rows}
        renderSlot={renderSlot}
        activeId={activeId}
        onSelect={setActiveId}
        onClose={() => { /* settings 面常开，无关闭语义 */ }}
        embedded
      />
    )
  }

  const panel = open && (
    <SettingsPanel
      rows={rows}
      renderSlot={renderSlot}
      activeId={activeId}
      onSelect={(id: string) => { setActiveId(id); publish({ open: true, section: id }) }}
      onClose={close}
    />
  )
  // FP（navigation）**只发射状态、自己不渲染面板**：
  // 样例两面都画，但 FP 只有 160px 宽，面板在那边又窄又挤（真机反馈）。
  // 这里让步：面板归 workspace 面，FP 只留齿轮入口（点击照常 publish，主卡就会开）。
  const localPanel = role === 'navigation' ? null : panel
  const onboarding = onboardingStep !== undefined && renderSlot('settings.onboarding', {
    stepId: onboardingStep.id,
    complete: () => { completeOnboardingStep(onboardingStep.id) },
    openSection,
  }, { only: onboardingStep.id })
  const retryView = () => {
    if (viewFailure?.kind === 'write' && pendingWrite.current?.revision === viewFailure.revision) {
      publish(pendingWrite.current.next)
    } else if (viewFailure?.kind === 'read' && viewFailure.revision === viewRevision.current) {
      refreshSettingsView.current?.()
    }
  }
  const syncFailure = viewFailure !== null && (
    <p className={css.syncError} role="alert">
      {t(viewFailure.kind === 'read' ? 'view.readError' : 'view.writeError')}{' '}
      <button type="button" className={css.retry} onClick={retryView}>{t('view.retry')}</button>
    </p>
  )

  // 主卡面：**只画面板，不画触发器**——这就是「FP 点设置、主卡打开」的落点。
  if (role === 'workspace') return <>{panel}{syncFailure}{onboarding}</>

  return (
    <>
      <div className={clsx(css.triggerRow, !wide && css.railRow)}>
        <button
          ref={triggerButton}
          type="button"
          className={clsx(css.trigger, !wide && css.rail)}
          aria-label={t('trigger')}
          aria-haspopup="dialog"
          aria-expanded={role === 'navigation' ? false : open}
          onClick={() => { openSection() }}
        >
          {renderSlot('settings.trigger', { wide })}
        </button>
        <ConnectionIndicator
          state={wide ? connectionIndicator : undefined}
          disconnectedLabel={t('connection.error')}
          reconnectLabel={t('connection.retry')}
          connectingLabel={t('connection.connecting')}
          recoveredLabel={t('connection.connected')}
          reconnectActionLabel={t('connection.reconnect')}
          restartActionLabel={t('connection.restart')}
          onReconnect={reconnect}
        />
      </div>
      {localPanel}
      {syncFailure}
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. */}
      {onboarding}
    </>
  )
}
