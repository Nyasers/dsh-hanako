// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// dsh-hana-proxy — dsh 进程内向前转发的代理插件（cordis）。
//
// 语义：DSHana（Hana 宿主的常驻 dsh web host 插件）把 dsh Web UI 嵌进 iframe，浏览器
// 侧经宿主反代 route（/api/plugins/<id>/web/*）访问 dsh web server（浏览器零直连
// 127.0.0.1）。宿主对本代理 route 做全局鉴权（route-security.ts），要求请求携带宿主
// plugin surface session 凭证（X-Hana-Plugin-Surface-Session header / pluginSurfaceSession
// query），否则 missing_credential 403。本插件在 dsh 进程内提供同源前缀路由
// /api/hana-proxy/*：iframe 文档内需回宿主反代的请求经它中转，其凭证由 iframe 文档 JS
// 自带（本插件原样透传给宿主反代），host 转发前剥离，不落到 dsh host。
//
// 为何把转发收进独立 cordis 插件而非全部塞进宿主反代：宿主反代只收「已带凭证」的请求
// 并原样透传；dsh 前端根绝对 /api/* 请求若直接落宿主根，会被 host 的插件 route 前缀
// 拦截（文档 origin 与宿主 route 前缀不同源）。/api/hana-proxy 作为 dsh 同源入口，按
// 「origin + 文档基址 + 原路径」的映射把此类请求送回宿主反代（直连时基址为空 → 不代理）。
//
// config 注入（宿主 patch 模板渲染，见 dsh-hanako.patch.yml.tpl / tools/dsh-run.js）：
// 本插件**不需要任何配置占位**——不注入 HOST_BASE，也不注入 PROXY_ROUTE。
//
// 边界与映射（关键约束）：
//   · 页面文档：嵌入场景经宿主反代 route（/api/plugins/<id>/web/）下发；文档根 = 该基址。
//   · API 反代规则：/api/* → /api/plugins/<id>/web/api/*（即「宿主反代基址 + 原路径」）。
//   · 直连场景（WebUI 本身直连，文档根 = /）：/api/* 自然解析到 dsh web server 自己的
//     /api/*，**不经代理、无凭证需求**——因此直连时本插件也不应加任何前缀（反代）。
//   实现：转发前缀一律从入站请求的文档基址（Referer pathname）运行时推导——
//   · 嵌入场景 Referer = http://<host>/api/plugins/<id>/web/<dsh页面> → 基址
//     /api/plugins/<id>/web，转发目标 = origin + 基址 + 原路径（命中宿主反代）。
//   · 直连场景 Referer 根为 / 或缺失 → 基址为空串，转发目标 = origin + 原路径
//     （等价于不经代理，直接落 dsh 自身 API）。
// 这样「根为 / 时自然不经过代理」，且不依赖任何静态 PROXY_ROUTE 配置。
// 凭证不经 patch 下发（防泄密）：token 从入站请求运行时取回（①请求 URL query →
// ②请求 header → ③文档 Referer URL query，即 shell attach() 注入 iframe src 的凭证），
// 转发时**双通道携带**：header X-Hana-Plugin-Surface-Session + URL query
// pluginSurfaceSession（宿主反代 header/query 认证都认），保证转发的 API 请求必带凭证、
// 不因单通道被剥而 403。
//
// 注册：webServer.register({ kind, path: "/api/hana-proxy", handler }) —— kind 非 exact
// 落入前缀表，最长前缀命中（match多说 pathname !== prefix 且 startsWith(prefix + "/")），
// 覆盖 /api/hana-proxy/<rest>。上游失败回 502 JSON。
//
// 服务依赖：export const inject = ["webServer", "hanaLogger"]。诊断经 dsh-hana-logger 统一
// 日志服务（行格式 [hana-proxy]）。勿给模块加 default 导出（Entry 加载器提取 default 会丢
// 具名导出，inject 失效）。
//
// 容错纪律：apply 全程 try/catch 不抛出——凭证缺失/直连降级/转发失败只记日志回 502 或
// 原样回退，不阻断 dsh 启动（边界要求）。

export const name = "dsh-hana-proxy";
export const inject = ["webServer", "hanaLogger"];

const NS = "hana-proxy";
const SESS_HEADER = "X-Hana-Plugin-Surface-Session";
const SESS_QUERY = "pluginSurfaceSession";
// 上游转发剥掉的 hop-by-hop / 由 fetch 自理的头，避免跟上游 Host/content-length 冲突
const REQUEST_HOP = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-authenticate",
  "expect",
]);
const ROUTE = "/api/hana-proxy";

/** 读入站请求 body（保持原始字节串，供上游原样回放；≤8MB 防内存滥用） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8e6) {
        req.destroy(new Error("body 过大"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : null));
    req.on("error", reject);
  });
}

/** 从入站请求提取 surface session token。来源按权威度降序：
 *   ① 入站请求自身 URL query（pluginSurfaceSession）
 *   ② 入站请求 header（X-Hana-Plugin-Surface-Session）
 *   ③ 文档 Referer URL query——iframe 文档自身 URL（宿主 iframe ticket 把凭证放进 src
 *      query，见壳页面 attach()），文档内转发请求的 Referer 常带该 query；凭证被宿主
 *      转发层剥掉后这是最后可回源的通道。
 * 无则空串。 */
function sessionToken(req) {
  try {
    const u = new URL(req.url ?? "/", "http://dsh.local");
    const q = u.searchParams.get(SESS_QUERY);
    if (q) return q;
  } catch { /* 忽略 */ }
  const h = req.headers || {};
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const hd = first(h[SESS_HEADER.toLowerCase()]);
  if (hd) return String(hd);
  const referer = first(h.referer);
  if (typeof referer === "string" && referer) {
    try {
      const rt = new URL(referer).searchParams.get(SESS_QUERY);
      if (rt) return rt;
    } catch { /* 忽略非法 Referer */ }
  }
  return "";
}

/** 运行时推导转发目标 origin。HOST_BASE 不应注入配置：HOST 是运行时动态的（宿主 origin
 * 随打开方式/反代链/端口变化），静态值会过时。按权威度降序取：
 *   ① X-Forwarded-Proto + X-Forwarded-Host（宿主反代在转发链路里显式标注的最权威来源）
 *   ② Origin 头（iframe 文档 origin = 宿主 origin，浏览器 CORS/同源请求均带）
 *   ③ Referer 头（页面导航/文档请求兜底）
 *   ④ req.Host 头兜底（浏览器必带；仅能得 http:// 前缀，无 scheme 时假定 http）
 * 全部缺失返回空串 → 调用方拒绝转发（无法确定送往哪个宿主 origin）。 */
function requestOrigin(req) {
  const h = req.headers || {};
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const xfp = first(h["x-forwarded-proto"]);
  const xfh = first(h["x-forwarded-host"]);
  if (xfp && xfh) {
    const proto = String(xfp).split(",")[0].trim();
    const hostOnly = String(xfh).split(",")[0].trim();
    if (proto && hostOnly) return `${proto}://${hostOnly}`;
  }
  const origin = first(h.origin);
  if (typeof origin === "string" && /^https?:\/\//i.test(origin)) return origin;
  const referer = first(h.referer);
  if (typeof referer === "string" && referer) {
    try {
      const u = new URL(referer);
      if (u.origin && /^https?:\/\//i.test(u.origin)) return u.origin;
    } catch {
      /* 忽略非法 Referer */
    }
  }
  const host = first(h.host);
  if (typeof host === "string" && host) return `http://${host}`;
  return "";
}

/** 运行时推导「文档基址」（即宿主反代前缀 /api/plugins/<id>/web）。从 Referer 的路径段
 * 提取：嵌入场景文档 URL = <host>/api/plugins/<id>/web/<dsh页面路径>，pathname 前缀即
 * 反代基址。直连场景（Referer 根为 /、只有 /<页面>，或缺失）→ 返回空串 = 文档根为 /，
 * 反代前缀为空（/api/* 自然落 dsh 自身，不经代理）。不依赖任何静态配置。
 * 返回始终无尾斜杠："/api/plugins/<id>/web" 或 ""。 */
function documentBase(req) {
  const h = req.headers || {};
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  const referer = first(h.referer);
  if (typeof referer === "string" && referer) {
    try {
      const p = new URL(referer).pathname;
      // 嵌入：/api/plugins/<id>/web/... 或恰好 /api/plugins/<id>/web
      const m = p.match(/^(\/api\/plugins\/[^/]+\/web)(?=\/|$)/i);
      if (m) return m[1];
      return ""; // 直连：Referer 根在 / 或非反代前缀路径 → 不代理
    } catch {
      /* 忽略非法 Referer */
    }
  }
  return ""; // 无 Referer：按直连处理（不代理）
}

export function apply(ctx, config) {
  try {
    ctx.inject(["webServer", "hanaLogger"], (httpCtx) => {
      httpCtx.effect(() => {
        const log = (msg) => {
          try {
            httpCtx.hanaLogger.log(NS, msg);
          } catch {
            /* 日志失败不阻断 */
          }
        };
        const disposers = [];

        async function handler(req, res) {
          try {
            const u = new URL(req.url ?? "/", "http://dsh.local");
            let rest = u.pathname;
            if (rest.startsWith(ROUTE + "/")) rest = rest.slice(ROUTE.length);
            else if (rest === ROUTE) rest = "/";
            // 保留原 query（含凭证 query；宿主反代转发前剥离 query 凭证）。

            // 转发目标 = origin + 文档基址 + 原路径：origin 运行时推导（HOST 动态），基址由
            // Referer 推导（嵌入场景 = /api/plugins/<id>/web；直连根 / 或缺失 = 空串，
            // 即不经代理）。边界：直连（WebUI 本身直连，根为 /）必不加反代前缀。
            const origin = requestOrigin(req);
            if (!origin) {
              log(
                `无法推导转发目标 origin（缺 Origin/Referer/X-Forwarded*/Host），拒绝转发`,
              );
              if (res.headersSent) {
                res.destroy();
                return;
              }
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({ ok: false, error: "无法推导转发目标 origin" }),
              );
              return;
            }
            const base = documentBase(req); // 空串 = 直连 → 不加反代前缀
            const sess = sessionToken(req);
            // 转发目标 URL：origin + 文档基址 + 原路径 + 原 query。有凭证时再补一条
            // pluginSurfaceSession query（若原 query 未含）——宿主反代 header/query 双通道
            // 认证都认，双通道保证转发的 API 请求必带凭证（避免因单通道被剥而 403）。
            const target = new URL(origin + base + (rest || "/") + u.search);
            if (sess && !target.searchParams.has(SESS_QUERY)) {
              target.searchParams.set(SESS_QUERY, sess);
            }
            const upstream = target.toString();

            // 构造上游请求头：复制入站（剥 hop-by-hop），有凭证则补附宿主反代要求的凭据头
            const reqHeaders = new Headers();
            for (const [k, v] of Object.entries(req.headers)) {
              if (!REQUEST_HOP.has(String(k).toLowerCase())) {
                if (Array.isArray(v)) {
                  for (const one of v) reqHeaders.append(k, one);
                } else if (v !== undefined) {
                  reqHeaders.append(k, String(v));
                }
              }
            }
            if (sess) reqHeaders.set(SESS_HEADER, sess); // header 通道（host 主鉴权优先认）
            // Host 交由 fetch 自行设置（Node fetch 从 URL 取），这里不覆盖

            const method = String(req.method || "GET").toUpperCase();
            const hasBody = method !== "GET" && method !== "HEAD";
            const body = hasBody ? await readBody(req) : undefined;

            const upstreamRes = await fetch(upstream, {
              method,
              headers: reqHeaders,
              ...(hasBody ? { body, duplex: "half" } : {}),
              redirect: "manual",
            });

            const out = new Headers();
            upstreamRes.headers.forEach((val, key) => {
              if (!REQUEST_HOP.has(key.toLowerCase())) out.set(key, val);
            });
            if (typeof upstreamRes.headers.getSetCookie === "function") {
              const sc = upstreamRes.headers.getSetCookie();
              if (sc.length) {
                out.delete("set-cookie");
                for (const s of sc) out.append("set-cookie", s);
              }
            }
            out.delete("content-length");

            res.writeHead(upstreamRes.status, Object.fromEntries(out));
            for await (const chunk of upstreamRes.body) res.write(chunk);
            res.end();
          } catch (e) {
            log(`转发失败：${e?.message || e}`);
            if (res.headersSent) {
              res.destroy();
              return;
            }
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ ok: false, error: "dsh-hana-proxy 转发失败" }),
            );
          }
        }

        try {
          disposers.push(
            httpCtx.webServer.register({ kind: "proxy", path: ROUTE, handler }),
          );
        } catch (e) {
          log(`路由 ${ROUTE} 注册失败：${e?.message || e}`);
          try {
            ctx.logger?.warn?.(
              `[dsh-hana-proxy] 路由注册失败：${e?.message || e}`,
            );
          } catch {
            /* 忽略 */
          }
        }

        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* 清理失败不阻断 */
            }
          }
        };
      });
    });
  } catch (e) {
    try {
      ctx.logger?.warn?.(`[dsh-hana-proxy] 插件停用：${e?.message || e}`);
    } catch {
      /* 忽略 */
    }
  }
}
