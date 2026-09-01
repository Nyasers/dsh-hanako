// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/web-app — 宿主专供 WebUI：serve fork 官方前端（无代理、无鉴权面）
//
// 形态（vX 定稿，SDD dshana-webui-headless）：对外 headless，3080 仅回环；web-app 是
// 给宿主专供的 WebUI 载体（宿主插件页 /webui 壳页 iframe 直嵌，或未来 V2 app route
// 同源直嵌）。它 serve 官方 dsh-web-frontend/dist（复用官方构建产物）到独立前缀
// /webui/，并把 SPA 内 URL（/api/、/plugins/、/assets/）改写为 /webui/... 前缀：
//   GET  /webui/                fork index.html（dist + 注入表，CORS）
//   GET  /webui/assets/*        前端静态（dist assets，CORS）
// 数据面（API/事件/WS）不走本插件——浏览器不直连 dsh HTTP（对外 headless），
// 走总线桥（宿主 V2 app route → callUnaryBus → bridge → dsh 服务，SDD D3/D4）。
// 代理逻辑（proxyApi/proxyPlugins/proxySse/pumpWs/ensureAuthCookie）与
// connection 依赖（launchToken/browser-auth 鉴权面）整体退役（SDD Non-Goals）。
//
// 凭据：子插件免鉴权（同源/回环资源，公开内容），无 token/PSS 传播。

import { createRequire } from 'node:module'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { readFile } from 'node:fs/promises'

/** Stable Cordis plugin name. */
export const name = 'web-app'

/** Services required before the fork seat can be claimed（无需 connection——无鉴权面）。 */
export const inject = ['webServer']

const HTML_MIME = 'text/html; charset=utf-8'
const MIME = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const MISS_CODES = new Set(['ENOENT', 'EISDIR', 'ENOTDIR'])

// 跨源 CORS：SPA 在宿主域（35058），资源在本进程（3080 回环）
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'Content-Type, X-Hana-Plugin-Surface-Session',
  'access-control-expose-headers': 'X-Hana-Resource-Id, X-Hana-File-MtimeMs',
}

/** 前端 dist 锚定（workspace knowledge：复用官方 frontend 包构建产物）。
 * 多基座解析（junction/symlink profile 下 createRequire 的 import.meta.url 是
 * realpath——profile 移出 dsh-home 后依赖链断裂，必须显式基座）：
 *   ① 宿主 config 的 dshPkgDir（dshanaBus.getConfig()，bridge 握手后下发）
 *   ② DSH_HOME 反推 dsh-pkg（dirname(dshHome)/dsh-pkg）
 *   ③ profiles/node_modules（dsh junction farm 全量依赖视图）
 *   ④ createRequire 裸解析兜底（实体 profile / 官方布局下可用）
 * 自包含化（SDD D5：构建期拷贝 dist 进插件产物）后此函数退役。
 */
let busConfigHolder = null
export function resolveDistIndex() {
  const require = createRequire(import.meta.url)
  const bases = []
  const home = process.env.DSH_HOME
  if (busConfigHolder && typeof busConfigHolder.dshPkgDir === 'string' && busConfigHolder.dshPkgDir) {
    bases.push(join(busConfigHolder.dshPkgDir, 'node_modules'))
  }
  if (home) {
    bases.push(join(dirname(home), 'dsh-pkg', 'node_modules'))
    bases.push(join(home, 'profiles', 'node_modules'))
  }
  for (const base of bases) {
    try {
      const pkg = require.resolve('@deepseek-ai/dsh-web-frontend/package.json', {
        paths: [base],
      })
      return join(dirname(pkg), 'dist', 'index.html')
    } catch {
      /* 该基座不可解析，试下一个 */
    }
  }
  try {
    return join(
      dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')),
      'dist',
      'index.html',
    )
  } catch {
    /* v8 ignore next -- 仅当 frontend 包缺失 */
    throw new Error('web-app: @deepseek-ai/dsh-web-frontend 不可解析（fork 资源缺失）')
  }
}

async function readDistIndex(distIndex) {
  try {
    return await readFile(distIndex, 'utf8')
  } catch {
    return '<!doctype html><html><body><h1>web-app: dist 缺失</h1></body></html>'
  }
}

/** 官方 SPA 路径改写（graph 帧/JS 内 URL：/plugins/、/assets/、/api/ → /webui/...）。
 * 只改绝对路径（行首或前导非 [.\w]）——./assets（相对，iframe 内同源解析）不动，
 * 已带 /webui/ 前缀的（幂等）不动。 */
function rewriteUrls(text) {
  return String(text).replace(
    /(^|[^.\w])\/(plugins|assets|api)\//g,
    (m, pre, seg) => pre + '/webui/' + seg + '/',
  )
}

/** Serve one GET/HEAD request from the fork dist root（学 frontend-static serveStatic）。 */
async function serveStatic(pathname, res, distRoot, distIndex, renderIndex) {
  const target = resolve(normalize(join(distRoot, pathname)))
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403, CORS)
    res.end()
    return
  }
  let body
  let type
  try {
    if (target === distRoot || target === distIndex) {
      // index：注入表渲染后 URL 改写（官方 /plugins/、/assets/、/api/ → /webui/...
      // 子插件路径——SPA 全部资源走本进程，免鉴权）
      body = rewriteUrls(await renderIndex())
      type = HTML_MIME
    } else {
      body = await readFile(target)
      type = MIME[extname(target)] || 'application/octet-stream'
    }
  } catch (e) {
    if (e && typeof e === 'object' && e.code && MISS_CODES.has(e.code)) {
      res.writeHead(404, CORS)
      res.end()
      return
    }
    throw e
  }
  res.writeHead(200, {
    'content-type': type,
    'cache-control': type === HTML_MIME ? 'no-cache' : 'public, max-age=31536000, immutable',
    ...CORS,
  })
  res.end(body)
}

/** Mount the fork seat over the webserver（纯静态 serve，无代理/无鉴权面）。 */
export function apply(ctx, config) {
  try {
    // 宿主配置（dshPkgDir 等）：bridge 握手后经 dshanaBus.getConfig() 下发（provider 同款）。
    // 供 resolveDistIndex 多基座解析 frontend（junction profile 下 createRequire 依赖链断裂）。
    ctx.inject(['dshanaBus'], (busCtx) => {
      try {
        busConfigHolder = busCtx.dshanaBus?.getConfig?.() ?? null
      } catch {
        busConfigHolder = null
      }
    })
    const distIndex = resolveDistIndex()
    const distRoot = dirname(distIndex)
    ctx.inject(['webServer'], (httpCtx) => {
      const ws = httpCtx && httpCtx.webServer
      if (!ws || typeof ws.register !== 'function') return
      ws.register({
        kind: 'prefixes',
        path: '/webui',
        handler: async (req, res) => {
          try {
            const raw = String(req.url || '/')
            const rel =
              raw === '/webui' || raw === '/webui/'
                ? '/'
                : raw.slice('/webui'.length)
            const pathname = rel.split('?')[0]
            // 静态（fork dist）
            const renderIndex =
              typeof ws.renderIndex === 'function'
                ? async () => ws.renderIndex(await readDistIndex(distIndex))
                : () => readDistIndex(distIndex)
            await serveStatic(pathname, res, distRoot, distIndex, renderIndex)
          } catch (e) {
            try {
              res.writeHead(500, CORS)
              res.end(String((e && e.message) || e))
            } catch {
              /* 已关 */
            }
          }
        },
      })
    })
  } catch (e) {
    /* 资源缺失：宿主侧诊断兜底（不阻断启动） */
    try {
      ctx.logger?.warn?.('[@dsh-hanako/web-app] fork 资源不可用：' + ((e && e.message) || e))
    } catch {
      /* 忽略 */
    }
  }
}
