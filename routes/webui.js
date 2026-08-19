// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// routes/webui.js — dsh-hanako 插件页：Hana 顶部 tab 内嵌 dsh Web UI
//   GET /webui            插件页（iframe 嵌 http://127.0.0.1:<port>/，含就绪探测/主题注入/失败自检）
//   GET /webui/health     轻量就绪探测（浏览器端 3s 重试轮询源；Node fetch 无 CORS 问题；
//                         未就绪时附带 diagnostics 字段供页面渲染自检）
//   POST /webui/start        手动启动 web host（process 卡片「手动启动」按钮；ready/starting/触发启动三态）
//   POST /webui/install-deps 自动安装 dsh 依赖（deps 卡片「安装依赖」按钮；installing/触发安装）
//   GET  /webui/verify-deps  运行级依赖检测（node cliBin --version；进标签页自动一次 + 手动「检测依赖」按钮）
//   GET  /webui/check-update 版本检查（v0.13.0: deps 卡片「检查更新」按钮；经宿主能力层 g.checkDshUpdate）
//   POST /webui/update-dsh   更新 DSH（v0.13.0: deps 卡片「更新 DSH」按钮；经宿主能力层 g.updateDsh，
//                            异步触发，更新会重启 web host、正在执行的任务中断）
//
// 机制：与 routes/card.js 同构——宿主把 app 挂在 /api/plugins/<pluginId> 命名空间下，
// 这里注册相对路径。渲染前服务端用 Node fetch 探测 dsh web host 的 /api/host.describe
// （1.5s 超时，低延迟不拖慢页面）；就绪则直接渲染 iframe，未就绪渲染提示区并让浏览器
// 每 3s 轮询本插件的 /webui/health，就绪后动态挂载 iframe。脚本首行 postMessage ready
// 是宿主原始握手（参照 PLUGINS.md；插件 bundle 不含 @hana/plugin-sdk，不依赖它）。
//
// 连接失败自检（v0.8.3）：web host 未就绪时逐项检查 ① nodejs 配置 ② dsh 依赖
// ③ DSH 进程状态，明确指出哪一项坏了、为什么、怎么修。诊断由服务端收集（Node 侧
// 才能读 config.json、进程单例与 fs 状态；浏览器 iframe 读不到插件进程）——收集函数
// 挂在 globalThis 单例（tools/dsh-run.js 的 collectDiagnostics），这里经单例调用而
// 非静态 import：Hana 以 ?t= 时间戳加载 tools 模块，静态 import 会命中 Node ESM 固定
// URL 缓存读到旧模块（见 tools/dsh-run.js 头部注释），与 index.js 经单例取 closeProcess
// 同一套纪律。工具模块未加载（冷启动窗口）时单例函数缺失，返回 null 由轮询补上。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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
    log?.warn?.(
      `[dsh-hanako] probeHost 失败（port ${port}）：${e?.message || e}`,
    );
    return false;
  }
}

/** 读连接失败自检（服务端收集：config.json + 单例 + fs；经单例调用 tools 的收集函数）。
 * 工具模块未加载（冷启动窗口）时返回 null，页面先渲染占位，轮询刷新后填充。
 * 只回布尔与截断文本（不返回凭据）；stderr 尾部在收集端已截断 ≤800。 */
function readDiagnostics(ctx, cfg, port) {
  const g = globalThis.__dshHanako;
  if (g && typeof g.collectDiagnostics === "function") {
    try {
      return g.collectDiagnostics({ dataDir: ctx?.dataDir, webPort: port });
    } catch (e) {
      ctx.log?.warn?.(
        "[dsh-hanako] 收集连接自检失败:",
        e?.message || String(e),
      );
      return null;
    }
  }
  return null;
}

/** 插件页 HTML 壳：ready=true 直接内联 iframe；否则提示区（标题 + 自检列表 + 重试）+ 轮询 health 后动态挂载
 * colorScheme：按宿主 hana-theme 映射的 color-scheme（dark/light）。dsh 主题为
 * system 时通过 prefers-color-scheme 解析，Chromium 会让跨源 iframe 继承父页面
 * 的 color-scheme，因此 dsh 会跟随宿主主题；dsh 内显式选了 light/dark 则不受影响。
 * diagnostics：未就绪时服务端收集的首帧自检数据（JSON 对象或 null）；浏览器端
 * 渲染进提示区，并在每次 health 轮询未就绪时用新 diagnostics 刷新。 */
function buildShell({
  ready,
  hcLink,
  theme,
  api,
  port,
  colorScheme,
  diagnostics,
}) {
  // v0.13.2 曾给 dsh-frame 显式声明 sandbox/allow（allow-downloads 等 token + clipboard/fullscreen
  // 权限），期望绕过宿主沙箱限制；实测证明跨源继承链（宿主插件 iframe 与主窗口跨源且无 allow）
  // 下内层声明无法生效，属无效方案，v0.13.3 整体回滚为裸嵌（见 CHANGELOG）。
  // 剪贴板问题的正规解法是 dsh-hana-clipboard 插件（tapIndex 注入桥 → 宿主 capability）
  // + 下方壳页面桥（hostRequest + __dshCopy 监听）。
  const iframe = ready
    ? `<iframe id="dsh-frame" src="http://127.0.0.1:${port}/"></iframe>`
    : `<iframe id="dsh-frame"></iframe>`;
  // 嵌入首帧自检 JSON：把 </ 转义成 <\/，防诊断文本（路径/stderr）里的 </script> 提前闭合脚本
  const initDiag = diagnostics
    ? JSON.stringify(diagnostics).replace(/<\//g, "<\\/")
    : "null";
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
/* v0.8.5: 诊断区全部改用宿主 hana 主题 CSS 变量（hcLink 注入样式表定义，变量清单见
 * 下方主题桥 postMessage 的 vars）；fallback 用纸张风色值，明暗随宿主主题，不再用
 * 硬编码色板与 prefers-color-scheme media query。 */
#dsh-pending{position:fixed;inset:0;display:none;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:14px;color:var(--text,#2A2622);background:var(--bg,#F5EFE4);padding:24px;box-sizing:border-box;overflow:auto}
body[data-pending="1"] #dsh-pending{display:flex}
body[data-pending="1"] iframe#dsh-frame{display:none}
.diag-box{max-width:680px;width:100%}
.diag-title{font-size:18px;font-weight:600;margin:0 0 6px}
.diag-sub{font-size:13px;color:var(--text-muted,#6B6158);margin:0 0 14px}
.diag-list{list-style:none;margin:0 0 10px;padding:0;display:flex;flex-direction:column;gap:10px}
.diag-item{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border,#D8CFBE);border-radius:8px;background:var(--bg-card,#FBF7EE);padding:10px 12px}
.diag-mark{font-size:16px;line-height:20px;width:20px;text-align:center;flex:none}
.diag-item.ok .diag-mark{color:var(--green,#4A6B4A)}
.diag-item.bad .diag-mark{color:var(--danger,#8B2C1F)}
.diag-body{min-width:0;flex:1}
.diag-name{font-weight:600;margin-bottom:4px}
.diag-detail{white-space:pre-wrap;word-break:break-all;color:var(--text-light,#4A433C);margin-bottom:4px}
.diag-fix{color:var(--accent,#537D96);background:var(--accent-light,rgba(83,125,150,0.08));border-radius:4px;padding:6px 8px}
.diag-btn{font-family:inherit;font-size:13px;color:var(--accent,#537D96);background:var(--bg-card,#FBF7EE);border:1px solid var(--accent,#537D96);border-radius:6px;padding:6px 12px;margin-top:6px;cursor:pointer}
.diag-btn:hover:not(:disabled){color:var(--accent-hover,#3F6179);border-color:var(--accent-hover,#3F6179)}
.diag-btn:disabled{color:var(--text-muted,#6B6158);border-color:var(--border,#D8CFBE);cursor:default}
.diag-btn-msg{display:block;font-size:12px;color:var(--danger,#8B2C1F);margin-top:4px}
.diag-progress{white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;font-size:12px;color:var(--text-light,#4A433C);background:var(--accent-light,rgba(83,125,150,0.08));border-radius:4px;padding:6px 8px;margin-bottom:4px;max-height:120px;overflow:auto}
.diag-progress-time{font-size:11px;color:var(--text-muted,#6B6158);margin-bottom:4px}
.diag-logpath{font-family:ui-monospace,SFMono-Regular,Consolas,"Courier New",monospace;font-size:12px;color:var(--text-muted,#6B6158);word-break:break-all;margin-top:4px}
.diag-retry{font-size:13px;color:var(--text-muted,#6B6158);text-align:center}
</style>
</head>
<body data-hana-theme="${esc(theme)}" data-pending="${ready ? "0" : "1"}">
<div id="dsh-pending">
  <div class="diag-box">
    <div class="diag-title">dsh web host 未就绪</div>
    <div class="diag-sub">连接失败自检（每 3 秒自动刷新，就绪后自动进入）</div>
    <ul class="diag-list" id="diag-list"></ul>
    <div class="diag-retry">正在重试…</div>
  </div>
</div>
${iframe}
<script>
window.parent.postMessage({ type: "ready" }, "*");
(function () {
  var api = ${JSON.stringify(api)};
  var initDiag = ${initDiag};
  var frame = document.getElementById("dsh-frame");
  // v0.13.3: dsh WebUI 剪贴板桥——dsh 前端复制被宿主插件 iframe 权限链拦截时
  // （navigator.clipboard 抛 NotAllowedError，跨源继承 deny，详见 CHANGELOG v0.13.2/0.13.3），
  // dsh 页面（跨源 iframe）postMessage 到这里，壳页面经宿主 capability clipboard.writeText
  // 写剪贴板（参照 hana-remote-dev 卡片实现；manifest ui.hostCapabilities 声明后宿主才放行）。
  // 宿主主窗口上下文执行 navigator.clipboard，不受插件 iframe Permissions-Policy 链限制。
  var HOST_ORIGIN = "*";
  var cbSeq = 0;
  function hostRequest(type, payload) {
    var id = "dsh-cb-" + (++cbSeq);
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { cleanup(); reject(new Error("host 请求超时: " + type)); }, 8000);
      function onMsg(e) {
        if (e.source !== window.parent) return;
        var m = e.data;
        if (!m || m.id !== id || m.type !== type) return;
        cleanup();
        if (m.kind === "response") resolve(m.payload);
        else if (m.kind === "error") reject(new Error((m.error && m.error.message) || "host error"));
      }
      function cleanup() {
        window.removeEventListener("message", onMsg);
        clearTimeout(timer);
      }
      window.addEventListener("message", onMsg);
      window.parent.postMessage(
        { protocol: "hana.plugin.ui", version: 1, id: id, kind: "request", type: type, payload: payload },
        HOST_ORIGIN
      );
    });
  }
  // 监听 dsh iframe（跨源）发来的复制请求（patch 后的 dsh 前端 __dshCopyBridge）→ 宿主能力 → 回执
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.__dshCopy !== true) return;
    if (!frame || e.source !== frame.contentWindow) return;
    var req = m;
    hostRequest("clipboard.writeText", { text: req.text })
      .then(function () { e.source.postMessage({ __dshCopyResult: { id: req.id, ok: true } }, "*"); })
      .catch(function () { e.source.postMessage({ __dshCopyResult: { id: req.id, ok: false } }, "*"); });
  });
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
  // v0.8.3: 连接失败自检渲染——服务端收集的 checks 列表（每项：状态图标/检查项名/
  // 详情/修复指引）；escHtml 兜底转义（诊断文本含路径与 stderr，需防注入）
  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function renderDiagList(diag) {
    var list = document.getElementById("diag-list");
    if (!list) return;
    if (!diag || !diag.checks || diag.checks.length === 0) {
      // 工具模块冷启动未加载/收集暂不可用：占位，下一轮轮询刷新
      list.innerHTML = '<li class="diag-item"><div class="diag-body"><div class="diag-detail">正在收集自检信息…</div></div></li>';
      return;
    }
    var html = "";
    for (var i = 0; i < diag.checks.length; i++) {
      var d = diag.checks[i];
      var mark = d.ok ? "✓" : "✗";
      html += '<li class="diag-item ' + (d.ok ? "ok" : "bad") + '" data-check="' + escHtml(d.key) + '">'
        + '<span class="diag-mark">' + mark + '</span>'
        + '<div class="diag-body">'
        + '<div class="diag-name">' + escHtml(d.name) + '</div>'
        + (d.key === "deps" && d.version ? '<div class="diag-detail">' + escHtml(versionLine(d)) + '</div>' : "") // v0.13.0: deps 版本行（当前/最新/可更新）
        + (d.detail ? '<div class="diag-detail">' + escHtml(d.detail) + '</div>' : "")
        + (d.key === "deps" && d.installing ? progressHtml(d) : "") // v0.8.8: 安装实时进度
        + (d.key === "deps" && d.updating ? updateProgressHtml(d) : "") // v0.13.0: 更新 DSH 进度/结果
        + (d.key === "process" && d.logPath ? '<div class="diag-logpath">本次会话日志：' + escHtml(d.logPath) + '</div>' : "") // v0.10.8: 时间戳会话文件路径
        + (d.fix ? '<div class="diag-fix">修复：' + escHtml(d.fix) + '</div>' : "")
        + actionButtonHtml(d)
        + '</div></li>';
    }
    list.innerHTML = html;
    syncActionButtons(diag); // 按检查项状态刷新卡片内操作按钮（启动中/安装中禁用，失败/缺失可用）
  }
  // v0.8.6: 操作按钮嵌入诊断卡片（data-check 定位，事件委托在列表上）——
  // process 卡片：进程未在跑（从未启动/启动失败/已退出）→「手动启动 web host」；
  // 启动中（alive=true 未 ready）→ 禁用「启动中…」；健康（ready+alive）不渲染按钮。
  //   v0.8.8: t2（依赖）未通过（deps.ok=false / installing / verifyRunning）时启动按钮
  //   不开放——禁用 + msg「依赖未就绪，请先安装/重新安装依赖」。
  // deps 卡片：依赖缺失 →「安装依赖」；已装 → 常驻「检测依赖」（verify-deps，检测中禁用
  // 「检测中…」）；存在但运行级验证失败 → 另加「重新安装依赖」（install-deps action）。
  // 门禁链：t1（依赖）未通过 → t2（进程）启动按钮锁（依赖未就绪，启动必失败）。
  // 状态机：startRequested/depsRequested/verifyRequested 只覆盖
  // 「请求已发出但诊断尚未反映状态」的短暂窗口，诊断确认后一律以检查项为准。
  var startRequested = false;
  var depsRequested = false;
  var verifyRequested = false;
  // 卡片内操作按钮 HTML：deps 可返回多个按钮（重新安装 + 检测）
  function actionButtonHtml(d) {
    if (!d) return "";
    if (d.key === "process") {
      // 进程健康（已就绪且在跑）不渲染；否则卡片内给「手动启动」（启动中禁用）
      if (d.alive && d.ready) return "";
      var running = d.alive;
      return '<button type="button" class="diag-btn" data-action="start" data-check="process"'
        + (running ? " disabled" : "") + '>' + (running ? "启动中…" : "手动启动 web host") + '</button>'
        + '<span class="diag-btn-msg"></span>';
    }
    if (d.key === "deps") {
      var html = "";
      if (!d.installed) {
        // 缺失：安装依赖（安装中禁用）
        html += '<button type="button" class="diag-btn" data-action="install-deps" data-check="deps"'
          + (d.installing ? " disabled" : "") + '>' + (d.installing ? "安装中…" : "安装依赖") + '</button>';
      } else {
        // 已装：验证失败 → 重新安装依赖（同一 install-deps action）
        if (d.verified === false && !d.verifyRunning) {
          html += '<button type="button" class="diag-btn" data-action="install-deps" data-check="deps"'
            + (d.installing ? " disabled" : "") + '>' + (d.installing ? "安装中…" : "重新安装依赖") + '</button>';
        }
        // 常驻「检测依赖」（v0.8.8: 检测中/安装中禁用）
        if (!d.installing) {
          html += '<button type="button" class="diag-btn" data-action="verify-deps" data-check="deps"'
            + (d.verifyRunning ? " disabled" : "") + '>' + (d.verifyRunning ? "检测中…" : "检测依赖") + '</button>';
        }
        // v0.13.0: 「检查更新」常驻（检查中/更新中/安装中禁用）；「更新 DSH」仅可更新时出现
        // （更新中禁用显示「更新中…」）。两者共用 deps 卡片的 diag-btn-msg 提示区。
        if (!d.installing) {
          html += '<button type="button" class="diag-btn" data-action="check-update" data-check="deps"'
            + (d.checking || d.updating ? " disabled" : "") + '>' + (d.checking ? "检查中…" : "检查更新") + '</button>';
        }
        if (d.check && d.check.updateAvailable && !d.installing) {
          html += '<button type="button" class="diag-btn" data-action="update-dsh" data-check="deps"'
            + (d.updating ? " disabled" : "") + '>' + (d.updating ? "更新中…" : "更新 DSH") + '</button>';
        }
      }
      return html ? html + '<span class="diag-btn-msg"></span>' : "";
    }
    return "";
  }
  function listBtn(check, action) {
    var list = document.getElementById("diag-list");
    if (!list) return null;
    var sel = '[data-check="' + check + '"] .diag-btn';
    if (action) sel += '[data-action="' + action + '"]';
    return list.querySelector(sel);
  }
  function checkByKey(diag, key) {
    if (diag && diag.checks) {
      for (var i = 0; i < diag.checks.length; i++) {
        if (diag.checks[i].key === key) return diag.checks[i];
      }
    }
    return null;
  }
  // v0.8.8: 安装/检测进度时间格式化（HH:MM:SS）
  function fmtTime(iso) {
    if (!iso) return "";
    var t = new Date(iso);
    if (isNaN(t.getTime())) return "";
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(t.getHours()) + ":" + p(t.getMinutes()) + ":" + p(t.getSeconds());
  }
  // v0.8.8: deps 安装中实时进度块（npm i 输出尾部 + 更新时间，随 3s 轮询刷新滚动）
  function progressHtml(d) {
    var html = '<pre class="diag-progress">' + escHtml(d.installLog || "正在准备…") + '</pre>';
    if (d.installAt) html += '<div class="diag-progress-time">更新于 ' + escHtml(fmtTime(d.installAt)) + '</div>';
    return html;
  }
  // v0.13.0: deps 版本行（当前版本 / 最新版本 / 可更新状态，数据源 = 诊断 version/check 字段）
  function versionLine(d) {
    var s = "当前版本 " + (d.version ? "v" + d.version : "未安装");
    var c = d.check;
    if (c && c.latest) {
      s += " · 最新 v" + c.latest;
      s += c.updateAvailable ? "（可更新）" : "（已最新）";
    }
    if (c && c.error) s += " · 检查失败：" + c.error;
    return s;
  }
  // v0.13.0: 更新 DSH 进度/结果块（update-result.json 内容，随 3s 轮询刷新）
  function updateProgressHtml(d) {
    var r = d.updateResult || null;
    var text = "正在更新 DSH…（将重启 DSHana，正在执行的任务会中断）";
    if (r && r.state === "done") text = "更新完成 v" + (r.version || "?") + (r.error ? "（web host 重启失败：" + r.error + "）" : "") + "，请重启 DSHana 使完全生效";
    else if (r && r.state === "error") text = "更新失败：" + (r.error || "未知错误");
    var html = '<pre class="diag-progress">' + escHtml(text) + '</pre>';
    if (r && r.at) html += '<div class="diag-progress-time">更新于 ' + escHtml(fmtTime(r.at)) + '</div>';
    return html;
  }
  function setBtnMsg(check, text) {
    var list = document.getElementById("diag-list");
    var el = list ? list.querySelector('[data-check="' + check + '"] .diag-btn-msg') : null;
    if (el) el.textContent = text;
  }
  function syncActionButtons(diag) {
    var proc = null, deps = null;
    if (diag && diag.checks) {
      for (var i = 0; i < diag.checks.length; i++) {
        if (diag.checks[i].key === "process") proc = diag.checks[i];
        else if (diag.checks[i].key === "deps") deps = diag.checks[i];
      }
    }
    // 依赖未通过 → 启动按钮不开放（依赖未就绪，启动必失败）：
    // deps.ok=false（未装/验证失败）、安装中（installing）、检测中（verifyRunning）均视为未通过
    var depsBlocked = deps && (deps.ok === false || deps.installing === true || deps.verifyRunning === true);
    var pBtn = listBtn("process");
    if (pBtn) {
      if (depsBlocked) {
        // 依赖未就绪：禁用 + msg 提示原因（用户先去安装/重新安装/等待检测）
        startRequested = false;
        pBtn.disabled = true;
        pBtn.textContent = "手动启动 web host";
        setBtnMsg("process", "依赖未就绪，请先安装/重新安装依赖");
      } else if (startRequested && !(proc && !proc.alive)) {
        // 请求已发出：进程未确认停止（含 alive 确认中）→ 保持禁用；确认在跑则转入「启动中…」
        if (proc && proc.alive) startRequested = false;
        pBtn.disabled = true;
        pBtn.textContent = proc && proc.alive ? "启动中…" : "正在启动…";
      } else {
        startRequested = false;
        if (proc && proc.alive) {
          pBtn.disabled = true;
          pBtn.textContent = "启动中…";
        } else {
          pBtn.disabled = false;
          pBtn.textContent = "手动启动 web host";
        }
      }
    }
    var installBtn = listBtn("deps", "install-deps");
    if (installBtn && deps) {
      if (deps.installing) {
        depsRequested = false;
        installBtn.disabled = true;
        installBtn.textContent = "安装中…";
      } else if (depsRequested) {
        // 请求已发出但诊断尚未确认 installing/installed：保持禁用
        installBtn.disabled = true;
        installBtn.textContent = "正在安装…";
      } else {
        depsRequested = false;
        installBtn.disabled = false;
        installBtn.textContent = deps.installed ? "重新安装依赖" : "安装依赖";
      }
    }
    var verifyBtn = listBtn("deps", "verify-deps");
    if (verifyBtn && deps) {
      if (deps.verifyRunning) {
        verifyRequested = false;
        verifyBtn.disabled = true;
        verifyBtn.textContent = "检测中…";
      } else if (verifyRequested) {
        // 请求已发出但诊断尚未反映 running：保持禁用
        verifyBtn.disabled = true;
        verifyBtn.textContent = "正在检测…";
      } else {
        verifyRequested = false;
        verifyBtn.disabled = false;
        verifyBtn.textContent = "检测依赖";
      }
    }
    // v0.13.0: 「检查更新」/「更新 DSH」按钮状态同步（以诊断 checking/updating 为准；
    // 按钮处理器自身已做乐观禁用，这里兜底页面刷新/轮询后状态一致）
    var checkBtn = listBtn("deps", "check-update");
    if (checkBtn && deps) {
      checkBtn.disabled = deps.checking || deps.updating || deps.installing;
      checkBtn.textContent = deps.checking ? "检查中…" : "检查更新";
    }
    var updBtn = listBtn("deps", "update-dsh");
    if (updBtn && deps) {
      updBtn.disabled = deps.updating;
      updBtn.textContent = deps.updating ? "更新中…" : "更新 DSH";
    }
  }
  function startWebHost() {
    var btn = listBtn("process");
    if (!btn || btn.disabled) return; // 幂等：已在启动中
    startRequested = true;
    btn.disabled = true;
    btn.textContent = "正在启动…";
    setBtnMsg("process", "");
    fetch(api + "/webui/start", {
      method: "POST",
      headers: surfaceHeaders(),
      signal: AbortSignal.timeout(5000),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok && d.state === "ready") { attach(); return; } // 已就绪：直接切 iframe
        if (d && d.ok) { return; } // starting：保持禁用，轮询检测就绪
        // 失败：恢复按钮并提示错误
        startRequested = false;
        btn.disabled = false;
        btn.textContent = "手动启动 web host";
        setBtnMsg("process", d && d.error ? d.error : "启动请求失败，请稍后重试");
      })
      .catch(function () {
        startRequested = false;
        btn.disabled = false;
        btn.textContent = "手动启动 web host";
        setBtnMsg("process", "启动请求超时或网络错误，请重试");
      });
  }
  function installDeps() {
    var btn = listBtn("deps");
    if (!btn || btn.disabled) return; // 幂等：已在安装中
    depsRequested = true;
    btn.disabled = true;
    btn.textContent = "正在安装…";
    setBtnMsg("deps", "");
    fetch(api + "/webui/install-deps", {
      method: "POST",
      headers: surfaceHeaders(),
      signal: AbortSignal.timeout(5000),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) { return; } // installing：保持禁用，轮询诊断刷新（安装中/完成）
        // 失败：恢复按钮并提示错误
        depsRequested = false;
        btn.disabled = false;
        btn.textContent = "安装依赖";
        setBtnMsg("deps", d && d.error ? d.error : "安装请求失败，请稍后重试");
      })
      .catch(function () {
        depsRequested = false;
        btn.disabled = false;
        btn.textContent = "安装依赖";
        setBtnMsg("deps", "安装请求超时或网络错误，请重试");
      });
  }
  // v0.8.8: 运行级依赖检测（GET /webui/verify-deps，只读）——进标签页自动一次 + 手动
  // 「检测依赖」按钮。服务端 await 检测（≤10s），结果写入 g.depsSmoke；拿到 ok 响应后
  // 触发一次 health 读取诊断刷新 deps 卡片（检测中显示「正在检测依赖完整性…」，结果
  // 回来显示通过/失败）。不随 3s 轮询重复触发。
  function refreshDiag() {
    fetch(api + "/webui/health", { headers: surfaceHeaders(), signal: AbortSignal.timeout(3000) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) { attach(); return; }
        if (d && d.diagnostics) renderDiagList(d.diagnostics);
      })
      .catch(function () {});
  }
  function runVerifyDeps(btn) {
    if (!btn || btn.disabled) return; // 幂等：已在检测中
    verifyRequested = true;
    btn.disabled = true;
    btn.textContent = "正在检测…";
    setBtnMsg("deps", "");
    fetch(api + "/webui/verify-deps", {
      headers: surfaceHeaders(),
      signal: AbortSignal.timeout(15000), // 服务端 await 检测 ≤10s，留足余量
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        verifyRequested = false;
        if (d && d.ok) {
          // 结果已写入服务端 g.depsSmoke：刷新一次诊断（通过/失败状态进 deps 卡片）
          refreshDiag();
          return;
        }
        var b = listBtn("deps", "verify-deps");
        if (b) { b.disabled = false; b.textContent = "检测依赖"; }
        setBtnMsg("deps", d && d.error ? d.error : "检测请求失败，请稍后重试");
      })
      .catch(function () {
        verifyRequested = false;
        var b = listBtn("deps", "verify-deps");
        if (b) { b.disabled = false; b.textContent = "检测依赖"; }
        setBtnMsg("deps", "检测请求超时或网络错误，请重试");
      });
  }
  function verifyDeps() {
    runVerifyDeps(listBtn("deps", "verify-deps"));
  }
  // v0.13.0: 版本检查（GET /webui/check-update，只读）——「检查更新」按钮。服务端
  // await 检查（npm view ≤~15s，官方源失败自动重试 npmmirror），结果缓存进 g.checkResult
  // 并写 check-result.json；拿到 ok 响应后触发一次 health 读取诊断刷新 deps 卡片
  // （版本行显示最新版本/可更新状态，update-dsh 按钮按需出现）。
  function checkUpdate() {
    var btn = listBtn("deps", "check-update");
    if (!btn || btn.disabled) return; // 幂等：已在检查中
    btn.disabled = true;
    btn.textContent = "检查中…";
    setBtnMsg("deps", "");
    fetch(api + "/webui/check-update", {
      headers: surfaceHeaders(),
      signal: AbortSignal.timeout(20000),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) {
          // 结果已写入服务端 g.checkResult：刷新一次诊断（版本行/按钮状态进 deps 卡片）
          refreshDiag();
          return;
        }
        var b = listBtn("deps", "check-update");
        if (b) { b.disabled = false; b.textContent = "检查更新"; }
        setBtnMsg("deps", d && d.error ? d.error : "检查请求失败，请稍后重试");
      })
      .catch(function () {
        var b = listBtn("deps", "check-update");
        if (b) { b.disabled = false; b.textContent = "检查更新"; }
        setBtnMsg("deps", "检查请求超时或网络错误，请重试");
      });
  }
  // v0.13.0: 更新 DSH（POST /webui/update-dsh）——「更新 DSH」按钮。点击前 confirm 提示
  // （更新会重启 web host，正在执行的任务中断）；触发后服务端异步执行（停 web host →
  // npm i latest → 起 web host），页面靠 3s 轮询诊断刷新 updateProgressHtml（updating/
  // done/error）与按钮状态。
  function updateDsh() {
    var btn = listBtn("deps", "update-dsh");
    if (!btn || btn.disabled) return; // 幂等：已在更新中
    if (!window.confirm("更新将重启 DSHana，正在执行的任务会中断，确定继续？")) return;
    btn.disabled = true;
    btn.textContent = "更新中…";
    setBtnMsg("deps", "");
    fetch(api + "/webui/update-dsh", {
      method: "POST",
      headers: surfaceHeaders(),
      signal: AbortSignal.timeout(5000),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) { refreshDiag(); return; } // updating：保持禁用，轮询诊断刷新
        var b = listBtn("deps", "update-dsh");
        if (b) { b.disabled = false; b.textContent = "更新 DSH"; }
        setBtnMsg("deps", d && d.error ? d.error : "更新请求失败，请稍后重试");
      })
      .catch(function () {
        var b = listBtn("deps", "update-dsh");
        if (b) { b.disabled = false; b.textContent = "更新 DSH"; }
        setBtnMsg("deps", "更新请求超时或网络错误，请重试");
      });
  }
  // 进标签页自动检测一次（仅依赖已装时；不随轮询重复——只在这里调一次）
  function autoVerifyDeps() {
    var deps = checkByKey(initDiag, "deps");
    if (!deps || !deps.installed) return; // 未装：先安装，安装成功会自动重验
    runVerifyDeps(listBtn("deps", "verify-deps"));
  }
  // 事件委托：卡片按钮点击（列表 innerHTML 每轮轮询重建，监听挂在 ul 上持久）
  function onDiagClick(e) {
    var t = e.target;
    var btn = t && t.closest ? t.closest(".diag-btn") : null;
    if (!btn) return;
    var action = btn.getAttribute("data-action");
    if (action === "start") startWebHost();
    else if (action === "install-deps") installDeps();
    else if (action === "verify-deps") verifyDeps();
    else if (action === "check-update") checkUpdate();
    else if (action === "update-dsh") updateDsh();
  }
  var pollTimer = null;
  function poll() {
    if (document.hidden) { pollTimer = setTimeout(poll, 5000); return; }
    // 3s 超时兜底：web host 假死（TCP 挂起）时走 catch 继续重试，避免轮询永久卡住
    fetch(api + "/webui/health", { headers: surfaceHeaders(), signal: AbortSignal.timeout(3000) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) { attach(); }
        else {
          // 未就绪：刷新自检列表（health 未就绪时附带 diagnostics 字段；为 null 时保留占位）
          if (d && d.diagnostics) renderDiagList(d.diagnostics);
          pollTimer = setTimeout(poll, 3000);
        }
      })
      .catch(function () { pollTimer = setTimeout(poll, 3000); });
  }
  window.addEventListener("beforeunload", function () {
    if (pollTimer) clearTimeout(pollTimer);
  });
  // v0.8.1: 主题桥——dsh 页面（跨源 iframe）postMessage 索取 Hana 主题，
  // 这里回传主题 id（location.search hana-theme）+ 实时变量值（hana-css 已
  // link，getComputedStyle 读到当前主题生效值）；注入脚本与内置表合并后覆盖。
  window.addEventListener("message", function (e) {
    if (e.data && e.data.dshHanaThemeRequest) {
      var cs = getComputedStyle(document.documentElement);
      function v(name, fb) { var x = cs.getPropertyValue(name).trim(); return x || fb; }
      var params = new URLSearchParams(location.search);
      e.source.postMessage({
        dshHanaTheme: {
          themeId: params.get("hana-theme") || "inherit",
          vars: {
            bg: v("--bg", "#F5EFE4"),
            bgCard: v("--bg-card", "#FBF7EE"),
            sidebarBg: v("--sidebar-bg", "#EFE8DB"),
            text: v("--text", "#2A2622"),
            textLight: v("--text-light", "#4A433C"),
            textMuted: v("--text-muted", "#6B6158"),
            accent: v("--accent", "#537D96"),
            accentHover: v("--accent-hover", "#3F6179"),
            accentLight: v("--accent-light", "rgba(83,125,150,0.08)"),
            userBg: v("--user-bg", "rgba(83,125,150,0.08)"),
            border: v("--border", "#D8CFBE"),
            green: v("--green", "#4A6B4A"),
            danger: v("--danger", "#8B2C1F"),
            overlayStrong: v("--overlay-strong", "rgba(42,38,34,0.15)"),
            overlayMedium: v("--overlay-medium", "rgba(42,38,34,0.08)"),
            dropOverlayBg: v("--drop-overlay-bg", "rgba(245,239,228,0.85)"),
          },
        },
      }, "*");
    }
  });
  if (document.body.getAttribute("data-pending") === "1") {
    renderDiagList(initDiag); // 首屏即渲染服务端带回的初始自检（null 时显示占位）+ 同步卡片内按钮
    var diagList = document.getElementById("diag-list");
    if (diagList) diagList.addEventListener("click", onDiagClick); // 卡片按钮事件委托
    autoVerifyDeps(); // v0.8.8: 进标签页依赖运行级检测一次（结果经 refreshDiag 进 deps 卡片）
    poll();
  }
})();
<\/script>
</body>
</html>`;
}

export default function registerWebuiRoutes(app, ctx) {
  const base = "/api/plugins/" + ctx.pluginId;
  // 端口：manifest 默认 + 用户配置合并后的 ctx.config；非对象容错回退 3080
  const cfg =
    ctx && typeof ctx.config === "object" && ctx.config ? ctx.config : {};
  const port = Number(cfg.webPort) || 3080;

  // 插件页：服务端先探测 host，就绪直接渲染 iframe；未就绪给提示（含自检诊断）+ 浏览器端轮询
  app.get("/webui", async (c) => {
    const ready = await probeHost(port, ctx.log);
    const hc = c.req.query("hana-css") || "";
    const th = c.req.query("hana-theme") || "inherit";
    const hcLink = hc ? `<link rel="stylesheet" href="${esc(hc)}">` : "";
    // 宿主深色主题（midnight/dark 等）→ iframe 内 prefers-color-scheme dark，dsh 的 system 跟随宿主
    const colorScheme = /midnight|dark/i.test(th) ? "dark" : "light";
    // 未就绪时服务端同步收集一次自检（首屏即渲染，轮询再刷新）；就绪不收集保持轻量
    const diagnostics = ready ? null : readDiagnostics(ctx, cfg, port);
    return c.html(
      buildShell({
        ready,
        hcLink,
        theme: th,
        api: base,
        port,
        colorScheme,
        diagnostics,
      }),
    );
  });

  // 轻量就绪探测端点（浏览器端重试轮询复用同一探测逻辑；未就绪时附带自检诊断字段便于排障）
  app.get("/webui/health", async (c) => {
    const ready = await probeHost(port, ctx.log);
    const body = { ok: ready, port, timestamp: Date.now() };
    // 未就绪时附带诊断（可为 null——工具模块冷启动未加载，下一轮轮询补上）；就绪时保持轻量
    if (!ready) body.diagnostics = readDiagnostics(ctx, cfg, port);
    return c.json(body);
  });

  // 手动启动 web host（process 卡片「手动启动」按钮调用）：读单例按当前状态返回——
  // 已就绪 → ready；启动中（readyPromise 挂起）→ starting；否则异步触发
  // g.startWebHost(ctx.config, dataDir)（不 await 其就绪，页面靠轮询检测）→ starting。
  // 单例缺失/无函数/异常一律容错回 {ok:false}，本路由不抛异常。
  app.post("/webui/start", (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.startWebHost !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.web?.ready) return c.json({ ok: true, state: "ready" });
      if (g.web?.readyPromise) return c.json({ ok: true, state: "starting" });
      // 异步触发（startWebHostFromPlugin 内部已 try/catch 记 webLastError 返回布尔；
      // 这里再 .catch 兜底——路由不等待就绪、不抛异常）。dataDir 缺省用单例记录值，
      // 避免路由 ctx 无 dataDir 时误落 PLUGIN_ROOT/data。
      Promise.resolve(
        g.startWebHost(ctx.config, ctx.dataDir || g.dataDir),
      ).catch(() => {});
      return c.json({ ok: true, state: "starting" });
    } catch (e) {
      ctx.log?.warn?.(
        "[dsh-hanako] 手动启动 web host 失败:",
        e?.message || String(e),
      );
      return c.json({ ok: false, error: "启动请求失败，请稍后重试" });
    }
  });

  // 自动安装 dsh 依赖（deps 卡片「安装依赖」按钮调用）：读单例按状态返回——
  // 部署中（g.depsInstalling）→ {ok:true,state:"installing"}；否则异步触发
  // g.installDeps(ctx.config, dataDir)（不 await 其完成，页面靠轮询诊断刷新）→ installing。
  // 单例缺失/无函数/异常一律容错回 {ok:false}，本路由不抛异常。
  app.post("/webui/install-deps", (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.installDeps !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.depsInstalling) return c.json({ ok: true, state: "installing" });
      // 异步触发（installDepsFromPlugin 内部已 try/catch 记 depsInstallError 返回结果；
      // 这里再 .catch 兜底——路由不等待完成、不抛异常）。dataDir 缺省用单例记录值。
      Promise.resolve(
        g.installDeps(ctx.config, ctx.dataDir || g.dataDir),
      ).catch(() => {});
      return c.json({ ok: true, state: "installing" });
    } catch (e) {
      ctx.log?.warn?.(
        "[dsh-hanako] 自动安装依赖失败:",
        e?.message || String(e),
      );
      return c.json({ ok: false, error: "安装请求失败，请稍后重试" });
    }
  });

  // 运行级依赖检测（v0.8.8: deps 卡片「检测依赖」按钮 + 进标签页自动一次；GET 只读）：
  // 检测中（g.depsSmoke.running）→ {ok:true,running:true}；否则 await verifyDepsSmoke(cfg)
  // （≤10s 返回）→ {ok:true, verified, version, error, running:false}。结果写入 g.depsSmoke，
  // 前端随后经 health 读取诊断刷新 deps 卡片。单例缺失/无函数/异常一律容错回 {ok:false}。
  app.get("/webui/verify-deps", async (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.verifyDeps !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.depsSmoke?.running) return c.json({ ok: true, running: true });
      const smoke = await g.verifyDeps({
        dataDir: ctx.dataDir || g.dataDir,
        webPort: port,
      });
      return c.json({
        ok: true,
        running: false,
        verified: smoke.ok,
        version: smoke.version,
        error: smoke.error || null,
      });
    } catch (e) {
      ctx.log?.warn?.(
        "[dsh-hanako] 运行级依赖检测失败:",
        e?.message || String(e),
      );
      return c.json({ ok: false, error: "检测请求失败，请稍后重试" });
    }
  });

  // 版本检查（v0.13.0: deps 卡片「检查更新」按钮 + Agent 工具 dsh_update 共用能力层；
  // GET 只读）：检查中（g.checking）→ {ok:true,running:true}；否则 await
  // g.checkDshUpdate(cfg)（npm view ≤~15s，官方源失败重试 npmmirror）→
  // {ok:true, localVersion, latestVersion, updateAvailable, error?}。结果缓存进
  // g.checkResult 并写 check-result.json，前端随后经 health 读取诊断刷新 deps 卡片。
  // 单例缺失/无函数/异常一律容错回 {ok:false}，本路由不抛异常。
  app.get("/webui/check-update", async (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.checkDshUpdate !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.checking) return c.json({ ok: true, running: true });
      const r = await g.checkDshUpdate({
        dataDir: ctx.dataDir || g.dataDir,
        webPort: port,
      });
      return c.json({
        ok: true,
        running: false,
        localVersion: r.localVersion,
        latestVersion: r.latestVersion,
        updateAvailable: r.updateAvailable,
        error: r.error || null,
      });
    } catch (e) {
      ctx.log?.warn?.("[dsh-hanako] 版本检查失败:", e?.message || String(e));
      return c.json({ ok: false, error: "版本检查失败，请稍后重试" });
    }
  });

  // 更新 DSH（v0.13.0: deps 卡片「更新 DSH」按钮 + Agent 工具 dsh_update 共用能力层）：
  // 更新中（g.updating）→ {ok:true,state:"updating"}；否则异步触发 g.updateDsh(cfg)
  // （不 await 其完成——npm i 可能耗时数分钟，前端轮询 health 诊断/设置页
  // update-result.json 看进度）→ {ok:true,state:"updating"}。更新会重启 web host，
  // 正在执行的 dsh 任务会中断（前端按钮已有确认文案）。单例缺失/无函数/异常一律容错
  // 回 {ok:false}，本路由不抛异常。
  app.post("/webui/update-dsh", (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.updateDsh !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.updating) return c.json({ ok: true, state: "updating" });
      // 异步触发（updateDsh 内部已 try/catch 写 update-result.json 返回结果；
      // 这里再 .catch 兜底——路由不等待完成、不抛异常）。dataDir 缺省用单例记录值。
      Promise.resolve(
        g.updateDsh({ dataDir: ctx.dataDir || g.dataDir, webPort: port }),
      ).catch(() => {});
      return c.json({ ok: true, state: "updating" });
    } catch (e) {
      ctx.log?.warn?.("[dsh-hanako] 更新 DSH 失败:", e?.message || String(e));
      return c.json({ ok: false, error: "更新请求失败，请稍后重试" });
    }
  });
}
