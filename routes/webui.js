// routes/webui.js — dsh-hanako 插件页：Hana 顶部 tab 内嵌 dsh Web UI
//   GET /webui            插件页（iframe 嵌 http://127.0.0.1:<port>/，含就绪探测/主题注入）
//   GET /webui/health     轻量就绪探测（浏览器端 3s 重试轮询源；Node fetch 无 CORS 问题）
//
// 机制：与 routes/card.js 同构——宿主把 app 挂在 /api/plugins/<pluginId> 命名空间下，
// 这里注册相对路径。渲染前服务端用 Node fetch 探测 dsh web host 的 /api/host.describe
// （1.5s 超时，低延迟不拖慢页面）；就绪则直接渲染 iframe，未就绪渲染提示区并让浏览器
// 每 3s 轮询本插件的 /webui/health，就绪后动态挂载 iframe。脚本首行 postMessage ready
// 是宿主原始握手（参照 PLUGINS.md；插件 bundle 不含 @hana/plugin-sdk，不依赖它）。

function esc(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 探测 dsh web host 是否就绪（host.describe RPC，1.5s 超时；任何失败视为未就绪） */
async function probeHost(port, log) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/host.describe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "probe",
        method: "host.describe",
        payload: {},
      }),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch (e) {
    log?.warn?.(`[dsh-hanako] probeHost 失败（port ${port}）：${e?.message || e}`);
    return false;
  }
}

/** 插件页 HTML 壳：ready=true 直接内联 iframe；否则提示区 + 轮询 health 后动态挂载
 * colorScheme：按宿主 hana-theme 映射的 color-scheme（dark/light）。dsh 主题为
 * system 时通过 prefers-color-scheme 解析，Chromium 会让跨源 iframe 继承父页面
 * 的 color-scheme，因此 dsh 会跟随宿主主题；dsh 内显式选了 light/dark 则不受影响。 */
function buildShell({ ready, hcLink, theme, api, port, colorScheme }) {
  const iframe = ready
    ? `<iframe id="dsh-frame" src="http://127.0.0.1:${port}/"></iframe>`
    : `<iframe id="dsh-frame"></iframe>`;
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="${colorScheme}">
<title>DSHana</title>
${hcLink}
<style>
html,body{height:100%;margin:0}
html{color-scheme:${colorScheme}}
iframe#dsh-frame{width:100%;height:100%;border:0;display:block}
#dsh-pending{position:fixed;inset:0;display:none;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px;color:#333;background:#fafafa}
body[data-pending="1"] #dsh-pending{display:flex}
body[data-pending="1"] iframe#dsh-frame{display:none}
</style>
</head>
<body data-hana-theme="${esc(theme)}" data-pending="${ready ? "0" : "1"}">
<div id="dsh-pending">dsh web host 未就绪，正在重试…</div>
${iframe}
<script>
window.parent.postMessage({ type: "ready" }, "*");
(function () {
  var api = ${JSON.stringify(api)};
  var frame = document.getElementById("dsh-frame");
  function attach() {
    // 就绪即停轮询：显式清掉 pending 定时器（不依赖递归链隐式断开）
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    frame.src = "http://127.0.0.1:${port}/";
    document.body.setAttribute("data-pending", "0");
  }
  function surfaceHeaders() {
    var params = new URLSearchParams(location.search);
    var sess = params.get("pluginSurfaceSession");
    return sess ? { "X-Hana-Plugin-Surface-Session": sess } : {};
  }
  var pollTimer = null;
  function poll() {
    if (document.hidden) { pollTimer = setTimeout(poll, 5000); return; }
    // 3s 超时兜底：web host 假死（TCP 挂起）时走 catch 继续重试，避免轮询永久卡住
    fetch(api + "/webui/health", { headers: surfaceHeaders(), signal: AbortSignal.timeout(3000) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) { attach(); } else { pollTimer = setTimeout(poll, 3000); }
      })
      .catch(function () { pollTimer = setTimeout(poll, 3000); });
  }
  window.addEventListener("beforeunload", function () {
    if (pollTimer) clearTimeout(pollTimer);
  });
  if (document.body.getAttribute("data-pending") === "1") poll();
})();
<\/script>
</body>
</html>`;
}

export default function registerWebuiRoutes(app, ctx) {
  const base = "/api/plugins/" + ctx.pluginId;
  // 端口：manifest 默认 + 用户配置合并后的 ctx.config；非对象容错回退 3080
  const cfg = ctx && typeof ctx.config === "object" && ctx.config ? ctx.config : {};
  const port = Number(cfg.webPort) || 3080;

  // 插件页：服务端先探测 host，就绪直接渲染 iframe；未就绪给提示 + 浏览器端轮询
  app.get("/webui", async (c) => {
    const ready = await probeHost(port, ctx.log);
    const hc = c.req.query("hana-css") || "";
    const th = c.req.query("hana-theme") || "inherit";
    const hcLink = hc ? `<link rel="stylesheet" href="${esc(hc)}">` : "";
    // 宿主深色主题（midnight/dark 等）→ iframe 内 prefers-color-scheme dark，dsh 的 system 跟随宿主
    const colorScheme = /midnight|dark/i.test(th) ? "dark" : "light";
    return c.html(
      buildShell({ ready, hcLink, theme: th, api: base, port, colorScheme })
    );
  });

  // 轻量就绪探测端点（浏览器端重试轮询复用同一探测逻辑；附带诊断字段便于排障）
  app.get("/webui/health", async (c) => {
    const ready = await probeHost(port, ctx.log);
    return c.json({ ok: ready, port, timestamp: Date.now() });
  });
}
