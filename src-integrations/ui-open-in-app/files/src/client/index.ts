/**
 * Browser half of open-in-app: one Session-header split button opening the
 * session's workspace directory (the summary's `cwd`) in the remembered
 * installed application. Availability arrives once per page from the host
 * apps route; the last choice persists in the browser through the controller's
 * persisted snapshot store.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { OPEN_IN_APP_ICON_PREFIX } from '@deepseek-ai/dsh-host-open-in-app/shared'
import { OpenInAppController } from './controller.ts'
import { OpenInAppAction, type OpenInAppActionInjected } from './OpenInAppAction.tsx'
import { en, NS, zh, type OpenInAppKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session-header "open workspace in application" copy. */
    'open-in-app': OpenInAppKey
  }
}

export type { OpenInAppActionInjected, OpenInAppActionProps } from './OpenInAppAction.tsx'

/** Required services for locale registration and the header-slot contribution. */
export const inject = ['sessions', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the header split button.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // hana 集成（src-integrations/ui-open-in-app）——样例的同一处改法：
  // 浏览器裸 fetch 打宿主源必被凭据闸 403（missing_credential）。改用官方 __DSH_TRANSPORT__
  // （把请求重写到 App 的私有运行时基址）当 carrier；拿不到时传 undefined，退回控制器
  // 默认的原生 fetch（与上游行为一致）。
  const bridgeFetch = (globalThis as {
    __DSH_TRANSPORT__?: { fetch?: (input: string | URL, init?: RequestInit) => Promise<Response> }
  }).__DSH_TRANSPORT__?.fetch
  const fetcher = bridgeFetch === undefined
    ? undefined
    : (input: string | URL, init?: RequestInit): Promise<Response> =>
      bridgeFetch(new URL(input, 'http://dsh.internal'), init)
  // 图标不是 fetch 而是 <img> 加载，transport 包不住它——只能换地址：用我们桥的
  // runtimeUrl() 把 /open-in-app/icon/<id> 映射到私有运行时基址（样例的 bridge.runtimeUrl
  // 就是干这个的）。桥不在场时原样返回，与上游行为一致。
  const bridgeUrl = (globalThis as {
    __DSHANA__?: { runtimeUrl?: (path: string) => string }
  }).__DSHANA__?.runtimeUrl
  const iconUrl = (path: string): string => {
    try {
      const mapped = bridgeUrl?.(path)
      if (typeof mapped === 'string' && mapped !== '') return mapped
    } catch { /* 桥异常则退回原路径 */ }
    return path
  }
  const controller = new OpenInAppController(fetcher)
  void controller.load()
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'open-in-app: dictionaries')
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'open-in-app',
    order: -10,
    locale: NS,
    inject: (): OpenInAppActionInjected => ({
      hooks: {
        openInAppApps: controller.apps,
        openInAppChoice: controller.choice,
      },
      launch: (appId, path) => controller.launch(appId, path),
      choose: (appId) => { controller.choose(appId) },
      iconUrl: appId => iconUrl(`${OPEN_IN_APP_ICON_PREFIX}/${appId}`),
    }),
  }, OpenInAppAction))
}
