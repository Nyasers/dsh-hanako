// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/web-app — fork 官方 web 前端到独立前缀（/webui/）+ 完整资源服务
//
// 学官方 @deepseek-ai/dsh-web-app（resolveDistIndex + 静态 serve）。提供 fork SPA
// 的全部资源面（dsh 进程内，宿主插件页 /webui 只做页面壳 + 基址改写）：
//   GET  /webui/                fork index.html（dist + 注入表，CORS）
//   GET  /webui/assets/*        前端静态（dist assets，CORS）
//   GET  /webui/plugins/*       代理官方 /plugins/*（合并 bundle/单文件，CORS）
//   GET  /webui/plugins/events  代理官方 SSE（graph 帧 URL 改写，CORS）
//   POST /webui/api/*           代理官方 /api/*（进程内自环带 cookie，CORS）
//   WS   /webui/api/events.host|events.mux  代理官方 WS（registerUpgrade + 双向泵）
//
// 凭据：子插件免鉴权（跨源 SPA 直接访问）；转发官方时进程内自环（launchToken →
// dsh-auth cookie，缓存 6h）。跨源 CORS 头放开（allow-origin: *——本机回环资源）。

import { createRequire } from 'node:module'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { readFile } from 'node:fs/promises'
import { handleUpgrade } from '../bridge/ws-lib.js'

/** Stable Cordis plugin name. */
export const name = 'web-app'

/** Services required before the fork seat can be claimed. */
export const inject = ['webServer', 'connection']

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

// 跨源 CORS：SPA 在宿主域（35058），资源在本进程（3080）
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'Content-Type, X-Hana-Plugin-Surface-Session',
  'access-control-expose-headers': 'X-Hana-Resource-Id, X-Hana-File-MtimeMs',
}

// ---- 自环 cookie（launchToken → dsh-auth，缓存 6h；转发官方 API/SSE/WS 用）----
let launchToken = ''
let authCookie = ''
let authCookieAt = 0

async function ensureAuthCookie(port) {
  if (authCookie && Date.now() - authCookieAt < 6 * 3600 * 1000) return authCookie
  if (!launchToken) return ''
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/?token=' + encodeURIComponent(launchToken), {
      redirect: 'manual',
    })
    const setCookies =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie')]
          : []
    authCookie = setCookies.map((s) => String(s).split(';')[0]).filter(Boolean).join('; ')
    authCookieAt = Date.now()
    return authCookie
  } catch {
    return authCookie || ''
  }
}

/** 前端 dist 锚定（workspace knowledge：复用官方 frontend 包构建产物）。 */
export function resolveDistIndex() {
  const require = createRequire(import.meta.url)
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

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(Buffer.alloc(0)))
  })
}

/** 代理官方 /api/*（进程内自环带 cookie，CORS 放开）。
 * 0.1.2 API 路径用斜杠（/api/settings/describe）；SPA 发点号（settings.describe）——
 * 转换（同 bridge 翻译器；query 保留）。 */
async function proxyApi(req, res, rel, port) {
  const cookie = await ensureAuthCookie(port)
  let body = await readBody(req)
  // 信封 method 转换（点号 → 斜杠，同路径转换；仅 JSON body 的 "method" 字段）
  if (body.length && String(req.headers['content-type'] || '').includes('json')) {
    try {
      const txt = body.toString('utf8').replace(
        /"method":"([^"]+)"/g,
        (m, mv) => '"method":"' + mv.replace(/\./g, '/') + '"',
      )
      body = Buffer.from(txt, 'utf8')
    } catch {
      /* 转换失败用原 body */
    }
  }
  const qIdx = rel.indexOf('?')
  const pathPart = qIdx === -1 ? rel : rel.slice(0, qIdx)
  const queryPart = qIdx === -1 ? '' : rel.slice(qIdx)
  const targetRel = pathPart.replace(/\./g, '/') + queryPart
  const r = await fetch('http://127.0.0.1:' + port + targetRel, {
    method: req.method || 'GET',
    headers: {
      'content-type': req.headers['content-type'] || 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: body.length ? body : undefined,
  })
  const ct = r.headers.get('content-type') || 'application/json'
  const buf = Buffer.from(await r.arrayBuffer())
  res.writeHead(r.status, { 'content-type': ct, ...CORS })
  res.end(buf)
}

/** 代理官方 /plugins/*（合并 bundle/单文件；events 走 SSE 转发）。
 * JS/JSON 响应做 URL 改写：/api/、/plugins/、/assets/ → /webui/...（SPA 资源统一走
 * 子插件免鉴权——官方 /api 在跨 site iframe 里有 cookie 墙，必须经子插件代理）。 */
async function proxyPlugins(req, res, rel, port) {
  const cookie = await ensureAuthCookie(port)
  const r = await fetch('http://127.0.0.1:' + port + rel, {
    method: req.method || 'GET',
    headers: cookie ? { cookie } : {},
  })
  const ct = r.headers.get('content-type') || 'application/octet-stream'
  const cacheHeaders = { 'content-type': ct, 'cache-control': 'public, max-age=31536000, immutable', ...CORS }
  if (ct.includes('javascript') || ct.includes('json')) {
    const text = rewriteUrls(await r.text())
    res.writeHead(r.status, cacheHeaders)
    res.end(text)
    return
  }
  const buf = Buffer.from(await r.arrayBuffer())
  res.writeHead(r.status, cacheHeaders)
  res.end(buf)
}

/** 代理官方 SSE（/plugins/events）：帧流转发 + 帧内 URL 改写（graph 的 /plugins/ → /webui/plugins/）。 */
async function proxySse(req, res, port) {
  const cookie = await ensureAuthCookie(port)
  const r = await fetch('http://127.0.0.1:' + port + '/plugins/events', {
    headers: cookie ? { cookie } : {},
  })
  res.writeHead(r.status, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...CORS,
  })
  try {
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() || ''
      for (const p of parts) {
        if (!p) continue
        try {
          res.write(rewriteUrls(p) + '\n\n')
        } catch {
          /* 客户端断开 */
        }
      }
    }
    if (buf) {
      try {
        res.write(rewriteUrls(buf) + '\n\n')
      } catch {
        /* 忽略 */
      }
    }
  } catch {
    /* 上游断开 */
  }
  try {
    res.end()
  } catch {
    /* 已关 */
  }
}

/** WS 双向泵：浏览器 ↔ 官方 events.host/events.mux（进程内带 cookie 连官方）。 */
async function pumpWs(conn, port, wsPath) {
  const cookie = await ensureAuthCookie(port)
  let up = null
  try {
    up = new WebSocket('ws://127.0.0.1:' + port + wsPath, cookie ? { headers: { Cookie: cookie } } : {})
  } catch (e) {
    try {
      conn.close(1011, 'upstream connect failed')
    } catch {
      /* 忽略 */
    }
    return
  }
  let closed = false
  const closeAll = () => {
    if (closed) return
    closed = true
    try {
      up && up.close()
    } catch {
      /* 忽略 */
    }
    try {
      conn.close(1000, 'closed')
    } catch {
      /* 忽略 */
    }
  }
  conn.on('message', (text) => {
    try {
      if (up && up.readyState === 1) up.send(String(text))
    } catch {
      /* 忽略 */
    }
  })
  conn.on('close', () => {
    try {
      up && up.close()
    } catch {
      /* 忽略 */
    }
  })
  up.onmessage = (e) => {
    try {
      conn.sendText(typeof e.data === 'string' ? e.data : String(e.data))
    } catch {
      /* 客户端断开 */
    }
  }
  up.onclose = () => closeAll()
  up.onerror = () => closeAll()
}

/** Mount the fork seat + resource proxies over the webserver. */
export function apply(ctx, config) {
  try {
    const distIndex = resolveDistIndex()
    const distRoot = dirname(distIndex)
    const portOf = (httpCtx) =>
      httpCtx && httpCtx.webServer && typeof httpCtx.webServer.port === 'number'
        ? httpCtx.webServer.port
        : 3080
    ctx.inject(['connection'], (connCtx) => {
      try {
        launchToken = connCtx.get?.('connection')?.browserAuth?.launchToken || ''
      } catch {
        launchToken = ''
      }
    })
    ctx.inject(['webServer'], (httpCtx) => {
      const ws = httpCtx && httpCtx.webServer
      if (!ws || typeof ws.register !== 'function') return
      const port = portOf(httpCtx)
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
            // 代理面（API/plugins）用完整 rel（含 query——/plugins/?? 合并列表与 rev 不能被
            // split('?') 切断）；静态 serve 用 pathname（不含 query）
            if (rel.startsWith('/api/') || rel.startsWith('/plugins/')) {
              const pathname = rel.split('?')[0]
              if (pathname === '/plugins/events') return proxySse(req, res, port)
              if (rel.startsWith('/api/')) return proxyApi(req, res, rel, port)
              return proxyPlugins(req, res, rel, port)
            }
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
      // WS 代理：events.host / events.mux / remote.mux（浏览器实时通道——官方端点，
      // 进程内带 cookie 连；跨 site iframe 的官方 WS 有 cookie 墙，必须经子插件）
      if (ws && typeof ws.registerUpgrade === 'function') {
        for (const wsPath of ['/api/events.host', '/api/events.mux', '/api/remote.mux']) {
          try {
            ws.registerUpgrade({
              path: '/webui' + wsPath,
              handler: (req, socket, head) => {
                handleUpgrade(req, socket, head, {
                  onConnection: (conn) => {
                    pumpWs(conn, port, wsPath).catch(() => {
                      try {
                        conn.close(1011, 'pump failed')
                      } catch {
                        /* 忽略 */
                      }
                    })
                  },
                  onError: () => {
                    try {
                      socket.destroy()
                    } catch {
                      /* 已关 */
                    }
                  },
                })
              },
            })
          } catch (e) {
            /* 重复注册忽略 */
          }
        }
      }
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
