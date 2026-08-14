// card.js — dsh 任务反馈卡片前端（iframe 内执行）
// 轮询插件 /ops/status 拿任务快照，渲染状态徽标 / 耗时 / 任务描述 / 两级输出：
//   摘要区（默认展开，随轮询实时更新）＋ 完整输出区（超长时懒加载 /ops/output，默认折叠）。
// 输出是 Markdown（dsh 报告型输出），用内联轻量渲染器实时转 HTML（运行中即可见部分输出）。
// 含 mini host SDK（@hana/plugin-sdk 协议兼容，免构建）：ui.resize 高度自适应。

(function () {
  "use strict";

  var root = document.getElementById("dsh-root");
  var API = window.__API || "";
  var pageParams = new URLSearchParams(location.search);
  var opId = (root && root.dataset.op) || pageParams.get("opId") || "";
  // iframe 由宿主以带凭据的 URL 加载：本地连接带 token query，远程连接带 pluginSurfaceSession
  var LOOPBACK_TOKEN = pageParams.get("token") || "";
  var SURFACE_SESSION = pageParams.get("pluginSurfaceSession") || "";
  if (!opId) { renderFail("缺少任务 ID"); return; }

  function apiUrl(path) {
    var url = API + path;
    if (LOOPBACK_TOKEN) {
      url += (url.indexOf("?") === -1 ? "?" : "&") + "token=" + encodeURIComponent(LOOPBACK_TOKEN);
    }
    return url;
  }

  function apiFetch(path, init) {
    var headers = new Headers(init && init.headers);
    if (SURFACE_SESSION) headers.set("X-Hana-Plugin-Surface-Session", SURFACE_SESSION);
    return fetch(apiUrl(path), Object.assign({}, init || {}, { headers: headers }));
  }

  // ── mini host SDK：高度自适应（iframe 贴合内容）──
  var PARENT = window.parent;
  var HOST_ORIGIN = pageParams.get("hana-host-origin") || "*";
  function reportSize() {
    try {
      var h = Math.ceil(document.body ? document.body.scrollHeight : 0);
      if (!h || h < 24) h = 24;
      PARENT.postMessage(
        { protocol: "hana.plugin.ui", version: 1, kind: "event", type: "ui.resize", payload: { width: 400, height: h } },
        HOST_ORIGIN
      );
    } catch (e) { /* 忽略 */ }
  }

  // ── 轻量 Markdown 渲染（离线可用，无外部依赖；先转义再渲染，防注入）──
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function inlineMd(s) {
    var t = esc(s);
    // 代码 `x`（先于其他，避免标签被误转义后还匹配）
    t = t.replace(/`([^`]+)`/g, function (_, c) { return "<code>" + c + "</code>"; });
    // **加粗** / *斜体*
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    // [文本](url)
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t;
  }

  // 按行渲染：标题 / 列表 / 表格 / 引用 / 代码块 / 分隔线 / 段落
  function mdToHtml(src) {
    if (!src) return "";
    var lines = String(src).replace(/\r\n/g, "\n").split("\n");
    var out = [];
    var i = 0;
    var inList = false;
    var inTable = false;
    var tableBuf = [];
    var inCode = false;
    var codeBuf = [];
    var codeLang = "";

    function closeList() { if (inList) { out.push("</ul>"); inList = false; } }
    function closeTable() {
      if (!inTable) return;
      inTable = false;
      if (tableBuf.length) {
        var h = tableBuf.shift();
        // 分隔行（|---|）跳过
        if (/^\s*:?-{2,}\s*(\|\s*:?-{2,}\s*)*$/.test(h)) h = tableBuf.shift() || "";
        out.push('<table class="dsh-md-table"><thead><tr>' +
          h.split("|").map(function (c) { return "<th>" + inlineMd(c.trim()) + "</th>"; }).join("") +
          "</tr></thead><tbody>");
        tableBuf.forEach(function (row) {
          out.push("<tr>" + row.split("|").map(function (c) { return "<td>" + inlineMd(c.trim()) + "</td>"; }).join("") + "</tr>");
        });
        out.push("</tbody></table>");
      }
      tableBuf = [];
    }

    for (i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();

      // 代码块围栏
      if (/^```/.test(trimmed)) {
        closeList(); closeTable();
        if (inCode) {
          out.push('<pre class="dsh-code"><code>' + esc(codeBuf.join("\n")) + "</code></pre>");
          inCode = false; codeBuf = [];
        } else {
          inCode = true; codeLang = trimmed.replace(/^```/, "").trim();
        }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }

      // 空行：关闭列表/表格
      if (!trimmed) { closeList(); closeTable(); continue; }

      // 表格行（以 | 开头且含 |）
      if (/^\|/.test(trimmed) && trimmed.indexOf("|", 1) !== -1) {
        closeList();
        if (!inTable) { inTable = true; tableBuf = []; }
        tableBuf.push(trimmed);
        continue;
      } else {
        closeTable();
      }

      // 标题
      var h = trimmed.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); var lv = h[1].length; out.push("<h" + lv + ">" + inlineMd(h[2]) + "</h" + lv + ">"); continue; }

      // 无序列表
      var li = trimmed.match(/^[-*]\s+(.*)$/);
      if (li) {
        if (!inList) { inList = true; out.push("<ul>"); }
        out.push("<li>" + inlineMd(li[1]) + "</li>");
        continue;
      }
      closeList();

      // 引用
      var qt = trimmed.match(/^>\s?(.*)$/);
      if (qt) { out.push('<blockquote>' + inlineMd(qt[1]) + "</blockquote>"); continue; }

      // 分隔线
      if (/^([-*_])\1{2,}$/.test(trimmed)) { out.push('<hr>'); continue; }

      // 普通段落
      out.push("<p>" + inlineMd(line) + "</p>");
    }
    closeList(); closeTable();
    if (inCode) out.push('<pre class="dsh-code"><code>' + esc(codeBuf.join("\n")) + "</code></pre>");
    return out.join("");
  }

  // ── 状态机：轮询直至终态 ──
  var timer = null;
  var pollCount = 0;         // 轮询计数（运行中完整区展开时约每 3 秒刷新一次）
  var fullLoaded = false;    // 是否已拉取过全量输出（懒加载）
  var fullOpen = false;      // 完整输出区展开状态
  var fullOutputText = "";   // 全量输出缓存
  var lastFullRendered = ""; // 已注入 DOM 的全量文本（避免重复渲染大输出）
  var lastOp = null;         // 最近一次快照（懒加载完成后重渲染用）

  function poll() {
    pollCount += 1;
    apiFetch("/ops/status?opId=" + encodeURIComponent(opId), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) {
          renderFail((data && data.error) || "任务记录不存在");
          stop();
          return;
        }
        render(data.op);
        if (data.op.status !== "running") {
          stop();
          // 终态瞬间若完整区已展开：补拉一次最终全量（完整收尾）
          if (fullOpen && fullLoaded) fetchFullOutput();
        } else if (fullOpen && fullLoaded && pollCount % 3 === 0) {
          // 运行中且完整区展开：约每 3 秒（第 3 次轮询）刷新一次保持新鲜
          fetchFullOutput();
        }
      })
      .catch(function () { /* 瞬时网络错误静默重试 */ });
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  // ── 渲染 ──
  function render(op) {
    lastOp = op;
    var running = op.status === "running";
    var ok = op.status === "ok";
    var badge = running ? "运行中" : ok ? "完成" : "失败";
    var badgeCls = running ? "run" : ok ? "ok" : "fail";
    // 摘要文本：终态有 summary 用最终结论；否则（运行中）用输出尾部预览
    var summaryText = (op.summary && op.summary.text) || op.outputPreview || "";
    var hasSummary = !!(summaryText && summaryText.trim());
    var outLen = op.outputLength != null ? op.outputLength : 0;
    var showFullToggle = outLen > 600;

    var html = "";
    html += '<div class="dsh">';
    html += '<div class="dsh-row">';
    html += '<span class="dsh-icon">' + ICON + "</span>";
    html += '<span class="dsh-title" title="' + esc(op.task || "") + '">' + esc(op.task || "") + "</span>";
    html += '<span class="dsh-badge ' + badgeCls + '">' + badge + "</span>";
    html += '<span class="dsh-dur">' + fmtDuration(op.durationMs) + (running ? " · 进行中" : "") + "</span>";
    html += "</div>";
    html += '<div class="dsh-task">cwd: ' + esc(op.cwd || "—") + "</div>";
    html += '<div class="dsh-detail">';
    html += '<div class="dsh-d-row"><span class="dsh-d-label">任务</span><span class="dsh-d-value">' + esc(op.task || "—") + "</span></div>";
    html += '<div class="dsh-d-row"><span class="dsh-d-label">目录</span><span class="dsh-d-value">' + esc(op.cwd || "—") + "</span></div>";
    html += '<div class="dsh-d-row"><span class="dsh-d-label">状态</span><span class="dsh-d-value">' + badge + (op.stopReason ? "（" + esc(op.stopReason) + "）" : "") + "</span></div>";
    // Token 账目：仅 op 快照带 usage 时显示（格式：in / out / cache / thinking）
    var usageText = fmtUsage(op.usage);
    if (usageText) html += '<div class="dsh-d-row"><span class="dsh-d-label">Token</span><span class="dsh-d-value">' + esc(usageText) + "</span></div>";
    html += '<div class="dsh-d-row"><span class="dsh-d-label">开始</span><span class="dsh-d-value">' + esc(fmtTime(op.startedAt)) + "</span></div>";
    if (op.timeoutMs != null) html += '<div class="dsh-d-row"><span class="dsh-d-label">超时</span><span class="dsh-d-value">' + esc(fmtDuration(op.timeoutMs)) + "</span></div>";
    html += "</div>";

    if (op.error) {
      html += '<div class="dsh-error">' + esc(op.error) + "</div>";
    } else if (hasSummary) {
      // 摘要区：默认展开（终态为最终结论摘要；运行中为输出尾部预览，随轮询实时更新）
      html += '<div class="dsh-summary">' + mdToHtml(summaryText) + "</div>";
      html += '<div class="dsh-summary-meta">' + esc(summaryMeta(op)) + "</div>";
      // 完整输出区：仅超长时提供，懒加载 /ops/output，默认折叠
      if (showFullToggle) {
        var btnLabel = !fullOpen ? "完整输出 (" + outLen + " 字符) ▾"
          : fullLoaded ? "完整输出 ▴"
          : "加载中…";
        html += '<button class="dsh-output-toggle" id="dsh-output-toggle">' + btnLabel + "</button>";
        html += '<div class="dsh-output' + (fullOpen ? " open" : "") + '" id="dsh-output">' +
          (fullOpen && !fullLoaded ? '<div class="dsh-empty">加载中…</div>' : "") + "</div>";
      }
    } else if (!running) {
      html += '<div class="dsh-empty">（dsh 未返回文本）</div>';
    }
    html += "</div>";

    var replaced = false;
    if (root.innerHTML !== html) { root.innerHTML = html; replaced = true; }

    var toggle = document.getElementById("dsh-output-toggle");
    if (toggle) toggle.addEventListener("click", function () {
      if (!fullLoaded) {
        // 首次点击：展开并懒加载全量输出（加载后缓存，不再请求）
        fullOpen = true;
        toggle.textContent = "加载中…";
        var el = document.getElementById("dsh-output");
        if (el) el.classList.add("open");
        fetchFullOutput();
      } else {
        // 已加载：纯 toggle，不再请求（重新展开时直接重注入，避免折叠期 DOM 重建后内容被清空）
        fullOpen = !fullOpen;
        var out = document.getElementById("dsh-output");
        if (out) out.classList.toggle("open", fullOpen);
        if (out && fullOpen) { out.innerHTML = mdToHtml(fullOutputText); lastFullRendered = fullOutputText; }
        toggle.textContent = fullOpen ? "完整输出 ▴" : "完整输出 ▾";
        reportSize();
      }
    });

    // 完整输出增量注入：DOM 被重建或全量文本变化时才重渲染（避免每次轮询重渲染大输出）
    var outEl = document.getElementById("dsh-output");
    if (outEl && fullOpen && fullLoaded && (replaced || fullOutputText !== lastFullRendered)) {
      outEl.innerHTML = mdToHtml(fullOutputText);
      lastFullRendered = fullOutputText;
    }

    reportSize();
  }

  // 摘要区小字说明（JS 生成）
  function summaryMeta(op) {
    var len = op.outputLength != null ? op.outputLength : 0;
    if (op.status === "running") {
      return "运行中 · 实时尾部预览" + (len ? "（已产出 " + len + " 字符）" : "");
    }
    var src = "输出预览";
    if (op.summary) {
      src = op.summary.summaryOf === "final-message" ? "最终汇报"
        : op.summary.summaryOf === "head-tail" ? "首尾摘要（中间过程已折叠）"
        : op.summary.summaryOf === "full" ? "全文"
        : "摘要";
    }
    return "最终结论（" + src + "）· 完整输出 " + len + " 字符";
  }

  // 懒加载全量输出：缓存进 fullOutputText，加载后重渲染展示（运行中每约 3 秒刷新一次）
  function fetchFullOutput() {
    return apiFetch("/ops/output?opId=" + encodeURIComponent(opId), { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.ok) return;
        fullOutputText = data.output || "";
        fullLoaded = true;
        if (lastOp) render(lastOp);
        reportSize();
      })
      .catch(function () { /* 瞬时网络错误静默重试 */ });
  }

  function renderFail(msg) {
    root.innerHTML = '<div class="dsh"><div class="dsh-empty">' + esc(msg) + "</div></div>";
    reportSize();
  }

  // ── 工具函数 ──
  // token 账目格式化：usage 为 null/缺字段时返回空串（卡片仅在非空时渲染该行）
  function fmtUsage(u) {
    if (!u || typeof u !== "object") return "";
    var parts = [];
    if (u.inputTokens != null) parts.push("in " + u.inputTokens);
    if (u.outputTokens != null) parts.push("out " + u.outputTokens);
    if (u.cacheReadTokens != null) parts.push("cache " + u.cacheReadTokens);
    if (u.reasoningTokens != null) parts.push("thinking " + u.reasoningTokens);
    return parts.join(" / ");
  }

  function fmtDuration(ms) {
    if (ms == null) return "";
    if (ms < 1000) return ms + "ms";
    var s = ms / 1000;
    if (s < 60) return s.toFixed(1) + "s";
    return Math.round(s / 60) + "m " + Math.round(s % 60) + "s";
  }

  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    var ss = String(d.getSeconds()).padStart(2, "0");
    return hh + ":" + mm + ":" + ss;
  }

  var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>';

  // ── 启动 ──
  window.addEventListener("load", function () { setTimeout(reportSize, 60); });
  poll();
  timer = setInterval(poll, 1000);
})();
