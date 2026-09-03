// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// card.js — dsh 任务反馈卡片前端（iframe 内执行）
// 架构：卡片链路从「HTTP 轮询 + op Map」改为「SSE 服务端推送 + jsonl 唯一事实源」。
// 启动即连 GET /ops/stream（EventSource，带 token，参照 apiUrl 拼接）：
//   baseline 事件 = 插件按 sessionId+rpcId 从会话 jsonl 重建的快照（含全量 output；运行中窗口
//                  归一化为 running + 部分输出）——渲染快照并种子本地状态；
//   event 事件   = 插件转发 DSH events.mux 的实时帧（assistant/chunk → 文本增量节流渲染，
//                  assistant/message → blocksSeq + usage 累计，turn/end → 终态）。
// 终态后完整输出用本地 blocksSeq（dsh-blocks-v1::JSON）走 renderBody（reasoning 折叠保留）。
// 超时本地判定：URL data-timeout + 基线 startedAt 本地倒计时（插件侧 AbortController 照常终止）。
// 轮询已移除；EventSource 建立失败（如插件重启后 DSH 未就绪）回退请求一次 /ops/status。
// 「暂未就绪」重试：初始连接 404（jsonl 异步落盘秒级窗口）EventSource 关闭后不自动重连
// （readyState=CLOSED），卡片侧有限重试（每 2s 重建 EventSource，最多 30 次 ≈ 60s），
// 窗口耗尽仍失败才判「任务记录不存在」（与恢复卡片的真不存在语义一致）。
// 输出是 Markdown（dsh 报告型输出），用内联轻量渲染器实时转 HTML。
// 卡片类型分支——data-kind="dep"（/card/dep）= 安装/升级卡片（DSH 安装/DSH 升级，
// 数据源 = 宿主单例 g.depTasks + g.depsInstallLog，SSE /ops/dep-stream，非 dsh 会话无 jsonl），
// 走 initDepCard 独立状态机；缺省 = 任务卡片（/card/op）。两分支在文件顶部按 kind 分流。
// 含 mini host SDK（@hana/plugin-sdk 协议兼容，免构建）：ui.resize 高度自适应。

(function () {
  "use strict";

  var root = document.getElementById("dsh-root");
  var API = window.__API || "";
  var pageParams = new URLSearchParams(location.search);
  // iframe 由宿主以带凭据的 URL 加载：本地连接带 token query，远程连接带 pluginSurfaceSession
  // （两个分支共用——dep 卡片与任务卡片都需要；须在 kind 分流前声明，var 提升但赋值在
  // 分支 return 后不执行，提前声明保证 dep 路径也能取到）
  var LOOPBACK_TOKEN = pageParams.get("token") || "";
  var SURFACE_SESSION = pageParams.get("pluginSurfaceSession") || "";
  // 卡片类型分支——data-kind="dep" = 安装/升级卡片（/card/dep，数据源
  // /ops/dep-stream 宿主单例 g.depTasks + g.depsInstallLog，非 dsh 会话无 jsonl）；
  // 缺省 = 任务卡片（/card/op，jsonl 恢复 + DSH 实时事件）。initDepCard 为函数声明
  // （提升），可复用下方 apiUrl/apiFetch/reportSize/esc/fmt* 公共辅助。
  var kind = (root && root.dataset.kind) || pageParams.get("kind") || "";
  if (kind === "dep") {
    initDepCard();
    return;
  }
  // 重启恢复定位：卡片 URL 带 sessionId+rpcId（session.create + prompt 后生成），
  // 插件零任务状态（op Map 退役），/ops/stream 按它们从会话 jsonl 重建基线快照
  var sessionId =
    (root && root.dataset.session) || pageParams.get("sessionId") || "";
  var rpcId = (root && root.dataset.rpc) || pageParams.get("rpcId") || "";
  var timeoutMs =
    (root && root.dataset.timeout) || pageParams.get("timeoutMs") || "";
  if (!sessionId || !rpcId) {
    renderFail("缺少任务 ID");
    return;
  }

  function apiUrl(path) {
    var url = API + path;
    if (LOOPBACK_TOKEN) {
      url +=
        (url.indexOf("?") === -1 ? "?" : "&") +
        "token=" +
        encodeURIComponent(LOOPBACK_TOKEN);
    }
    return url;
  }

  function apiFetch(path, init) {
    var headers = new Headers(init && init.headers);
    if (SURFACE_SESSION)
      headers.set("X-Hana-Plugin-Surface-Session", SURFACE_SESSION);
    return fetch(
      apiUrl(path),
      Object.assign({}, init || {}, { headers: headers }),
    );
  }

  // ── mini host SDK：高度自适应（iframe 贴合内容）──
  var PARENT = window.parent;
  var HOST_ORIGIN = pageParams.get("hana-host-origin") || "*";
  function reportSize() {
    try {
      // +16px 余量：实测宿主 card iframe = 上报 - 16（上报 584→iframe 568，600→584），
      // 补回宿主减去的 16 让 iframe 贴合 html（内容顶满 600 时上报 616 → iframe 600）
      var h = Math.ceil(document.body ? document.body.scrollHeight : 0) + 16;
      if (!h || h < 40) h = 40;
      PARENT.postMessage(
        {
          protocol: "hana.plugin.ui",
          version: 1,
          kind: "event",
          type: "ui.resize",
          payload: { width: 400, height: h },
        },
        HOST_ORIGIN,
      );
    } catch (e) {
      /* 忽略 */
    }
  }

  // ── 轻量 Markdown 渲染（离线可用，无外部依赖；先转义再渲染，防注入）──
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function inlineMd(s) {
    var t = esc(s);
    // 代码 `x`（先于其他，避免标签被误转义后还匹配）
    t = t.replace(/`([^`]+)`/g, function (_, c) {
      return "<code>" + c + "</code>";
    });
    // **加粗** / *斜体*
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    // [文本](url)
    t = t.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>',
    );
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

    function closeList() {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
    }
    function closeTable() {
      if (!inTable) return;
      inTable = false;
      if (tableBuf.length) {
        var h = tableBuf.shift();
        // 分隔行（|---|）跳过
        if (/^\s*:?-{2,}\s*(\|\s*:?-{2,}\s*)*$/.test(h))
          h = tableBuf.shift() || "";
        out.push(
          '<table class="dsh-md-table"><thead><tr>' +
          h
            .split("|")
            .map(function (c) {
              return "<th>" + inlineMd(c.trim()) + "</th>";
            })
            .join("") +
          "</tr></thead><tbody>",
        );
        tableBuf.forEach(function (row) {
          out.push(
            "<tr>" +
            row
              .split("|")
              .map(function (c) {
                return "<td>" + inlineMd(c.trim()) + "</td>";
              })
              .join("") +
            "</tr>",
          );
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
        closeList();
        closeTable();
        if (inCode) {
          out.push(
            '<pre class="dsh-code"><code>' +
            esc(codeBuf.join("\n")) +
            "</code></pre>",
          );
          inCode = false;
          codeBuf = [];
        } else {
          inCode = true;
          codeLang = trimmed.replace(/^```/, "").trim();
        }
        continue;
      }
      if (inCode) {
        codeBuf.push(line);
        continue;
      }

      // 空行：关闭列表/表格
      if (!trimmed) {
        closeList();
        closeTable();
        continue;
      }

      // 表格行（以 | 开头且含 |）
      if (/^\|/.test(trimmed) && trimmed.indexOf("|", 1) !== -1) {
        closeList();
        if (!inTable) {
          inTable = true;
          tableBuf = [];
        }
        tableBuf.push(trimmed);
        continue;
      } else {
        closeTable();
      }

      // 标题
      var h = trimmed.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        closeList();
        var lv = h[1].length;
        out.push("<h" + lv + ">" + inlineMd(h[2]) + "</h" + lv + ">");
        continue;
      }

      // 无序列表
      var li = trimmed.match(/^[-*]\s+(.*)$/);
      if (li) {
        if (!inList) {
          inList = true;
          out.push("<ul>");
        }
        out.push("<li>" + inlineMd(li[1]) + "</li>");
        continue;
      }
      closeList();

      // 引用
      var qt = trimmed.match(/^>\s?(.*)$/);
      if (qt) {
        out.push("<blockquote>" + inlineMd(qt[1]) + "</blockquote>");
        continue;
      }

      // 分隔线
      if (/^([-*_])\1{2,}$/.test(trimmed)) {
        out.push("<hr>");
        continue;
      }

      // 普通段落
      out.push("<p>" + inlineMd(line) + "</p>");
    }
    closeList();
    closeTable();
    if (inCode)
      out.push(
        '<pre class="dsh-code"><code>' +
        esc(codeBuf.join("\n")) +
        "</code></pre>",
      );
    return out.join("");
  }

  // 结构化输出渲染（dsh-blocks-v1::JSON，text 正常渲染 / reasoning 折叠 / tool-call 小字）；
  // 普通 markdown（运行时 chunk 流输出）原样走 mdToHtml
  function renderBody(text) {
    var PREFIX = "dsh-blocks-v1::";
    if (typeof text === "string" && text.indexOf(PREFIX) === 0) {
      try {
        var blocks = JSON.parse(text.slice(PREFIX.length));
        if (!Array.isArray(blocks)) return mdToHtml(text);
        var out = "";
        for (var i = 0; i < blocks.length; i++) {
          var b = blocks[i];
          if (b.type === "text" && b.text) out += mdToHtml(b.text);
          else if (b.type === "reasoning" && b.text)
            out +=
              '<details class="dsh-reasoning"><summary>思考过程</summary>' +
              mdToHtml(b.text) +
              "</details>";
          else if (b.type === "tool-call" && b.name)
            out += '<div class="dsh-toolcall">' + esc(b.name) + "</div>";
        }
        return out;
      } catch (e) {
        /* 解析失败回退 markdown */
      }
    }
    return mdToHtml(text);
  }

  // ── 本地状态（SSE 增量事实；基线快照种子 + 实时事件累加）──
  var SUMMARY_SHOWN = 1024; // 运行中摘要区尾部预览量（与 /ops/status outputPreview 同量级）
  var S = {
    base: null, // 基线快照静态字段（task/cwd/model/startedAt/timeoutMs…）
    status: "pending", // pending | running | ok | error（timeout 以 error + stopReason=timeout 呈现）
    stopReason: null,
    error: null,
    collected: "", // chunk 文本增量（运行中摘要区 + 无 blocks 时终态完整输出兜底）
    blocksSeq: [], // assistant/message 的 blocks（text/reasoning/tool-call）：终态完整输出
    lastMsgText: "", // 最近一条 assistant/message 文本（turn/end 前无 finalText 时兜底）
    finalText: "", // 最终汇报（turn/step 消息覆盖更新，turn/end 时定型）
    usage: null, // 词元累计（disjoint，缺失字段不初始化）
    outputLength: 0, // 已产出字符数
    durationMs: null, // 终态耗时（基线提供 / 本地推算）
    seenIds: {}, // assistant/message 去重（防 mux 边界重放）
    sawChunk: false, // 本连接是否见过 chunk（chunk 流已提供文本时消息文本不再重复追加）
    // 视图状态
    fullOpen: false,
    taskOpen: false,
    lastSummaryText: "",
    lastFullRendered: "",
  };

  var es = null; // EventSource
  var fallbackDone = false; // /ops/status 兜底只做一次
  var retryTimer = null; // 「暂未就绪」重试定时器（jsonl 异步落盘秒级窗口）
  var retryCount = 0; // 已重试次数（上限 RETRY_MAX；窗口耗尽 = 记录真不存在）
  var RETRY_DELAY = 2000; // 重试间隔（ms）
  var RETRY_MAX = 30; // 最多 30 次 ≈ 60s 恢复窗口
  var summaryTimer = null; // chunk 渲染节流（约 100ms）
  var tickTimer = null; // 运行中 1s tick（头部耗时走动 + 本地超时判定）
  var timeoutDeadline = null;
  var lastFullText = ""; // 最近一次渲染的完整输出文本（toggle 点击时读最新值，防闭包过期）

  // 从基线快照的 output（全量）种子本地状态：结构化 blocks → blocksSeq + 文本；纯文本 → collected。
  // 运行中基线 = 连接前已发生的事件（jsonl 重建），实时帧只含连接后事件，两者无重叠。
  function seedFromOutput(output) {
    S.blocksSeq = [];
    S.collected = "";
    S.seenIds = {};
    S.sawChunk = false;
    if (!output) return;
    var PREFIX = "dsh-blocks-v1::";
    if (typeof output === "string" && output.indexOf(PREFIX) === 0) {
      try {
        var blocks = JSON.parse(output.slice(PREFIX.length));
        if (Array.isArray(blocks)) {
          S.blocksSeq = blocks.filter(function (b) {
            return b && typeof b === "object";
          });
          S.collected = blocks
            .filter(function (b) {
              return b && b.type === "text" && b.text;
            })
            .map(function (b) {
              return b.text;
            })
            .join("");
          return;
        }
      } catch (e) {
        /* 解析失败按纯文本 */
      }
    }
    S.collected = String(output);
  }

  function mergeUsageLocal(u) {
    if (!u || typeof u !== "object") return;
    S.usage = S.usage || {};
    S.usage.inputTokens = (S.usage.inputTokens || 0) + (u.inputTokens ?? 0);
    S.usage.outputTokens = (S.usage.outputTokens || 0) + (u.outputTokens ?? 0);
    if (u.cacheReadTokens != null)
      S.usage.cacheReadTokens =
        (S.usage.cacheReadTokens || 0) + u.cacheReadTokens;
    if (u.reasoningTokens != null)
      S.usage.reasoningTokens =
        (S.usage.reasoningTokens || 0) + u.reasoningTokens;
  }

  // 从 assistant/chunk 提取文本增量（参照 tools/dsh-run.js textFromChunk：chunk.delta/block/text）
  function textFromChunk(d) {
    if (!d || typeof d !== "object") return "";
    var c = d.chunk || d;
    var t = (c.delta && c.delta.text) || (c.block && c.block.text) || c.text;
    return typeof t === "string" ? t : "";
  }

  // ── SSE 连接 ──
  function streamQuery() {
    var q = "sessionId=" + encodeURIComponent(sessionId);
    if (rpcId) q += "&rpcId=" + encodeURIComponent(rpcId);
    if (timeoutMs) q += "&timeoutMs=" + encodeURIComponent(timeoutMs);
    return q;
  }

  function startStream() {
    try {
      es = new EventSource(apiUrl("/ops/stream?" + streamQuery()));
    } catch (e) {
      // 建立失败：兜底一次 /ops/status；已兜底过则进入有限重试
      if (!fallbackDone) {
        fallbackDone = true;
        fallbackStatus();
      } else {
        scheduleRetry();
      }
      return;
    }
    es.addEventListener("baseline", function (e) {
      var snap = null;
      try {
        snap = JSON.parse(e.data);
      } catch (err) {
        /* 坏帧忽略 */
      }
      if (snap) onBaseline(snap);
    });
    es.addEventListener("event", function (e) {
      var frame = null;
      try {
        frame = JSON.parse(e.data);
      } catch (err) {
        /* 坏帧忽略 */
      }
      if (frame) onEvent(frame);
    });
    es.onerror = function () {
      // 建立失败/流中断：初始连接非 200（404 = jsonl 尚未落盘）EventSource 关闭后不自动
      // 重连（readyState=CLOSED）；已建立后断开则由 EventSource 自动重连接管。
      // 从未收到基线时兜底一次 /ops/status；仍失败进入有限重试（「暂未就绪」≠「真不存在」）。
      if (S.base) return; // 基线已到：后续中断由 EventSource 自动重连
      if (!fallbackDone) {
        fallbackDone = true;
        fallbackStatus();
      } else {
        scheduleRetry();
      }
    };
  }

  function closeStream() {
    if (es) {
      try {
        es.close();
      } catch (e) {
        /* 已关 */
      }
      es = null;
    }
  }

  // 兜底：EventSource 建立失败时请求一次 /ops/status（快照渲染，无实时增量）；
  // 失败（404/网络）不立即判失败——进入有限重试（jsonl 落盘后重试即命中）。
  function fallbackStatus() {
    apiFetch("/ops/status?" + opQuery(), { cache: "no-store" })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.ok) {
          scheduleRetry(); // 暂未就绪：进入重试，不渲染错误
          return;
        }
        onBaseline(data.op); // 复用基线处理（种子 + 终态判定；无 SSE 实时事件）
      })
      .catch(function () {
        scheduleRetry(); // 网络/解析失败同样按「暂未就绪」重试
      });
  }

  // 「暂未就绪」有限重试：fallbackStatus 失败（或 ES 建立失败）后不立即 renderFail，
  // 每 RETRY_DELAY 重建 EventSource 重试全链路（基线 + 实时事件），最多 RETRY_MAX 次
  // （≈60s 窗口）。重试期间保持占位「正在连接任务状态…」，成功（S.base 就绪）即停止；
  // 窗口耗尽仍失败 → renderFail（语义不变：记录真不存在）。重试前 closeStream 清理旧
  // 连接（含自动重连中的 CONNECTING），防止叠加多个 EventSource。
  function scheduleRetry() {
    if (retryTimer) return; // 已有待触发重试，不叠加
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (S.base) return; // 等待期间基线已就绪（如 ES 自动重连成功），无需再试
      if (retryCount >= RETRY_MAX) {
        closeStream();
        renderFail("任务记录不存在");
        return;
      }
      retryCount++;
      closeStream(); // 清掉旧 ES（含自动重连中的 CONNECTING 连接），防叠加
      startStream(); // 重建 EventSource：jsonl 落盘后基线即命中，全链路恢复
    }, RETRY_DELAY);
  }

  function stopRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function opQuery() {
    var q = "";
    if (sessionId)
      q += (q ? "&" : "") + "sessionId=" + encodeURIComponent(sessionId);
    if (rpcId) q += (q ? "&" : "") + "rpcId=" + encodeURIComponent(rpcId);
    if (timeoutMs)
      q += (q ? "&" : "") + "timeoutMs=" + encodeURIComponent(timeoutMs);
    return q;
  }

  // ── 事件处理 ──
  function onBaseline(snap) {
    if (!snap) {
      renderFail("任务记录不存在");
      closeStream();
      return;
    }
    stopRetry(); // 基线已就绪：取消可能挂起的重试定时器
    S.base = snap;
    S.usage = snap.usage || null;
    S.outputLength = snap.outputLength || 0;
    seedFromOutput(snap.output); // 快照 output 全文（/ops/stream 带；/ops/status 兜底可能缺 → 空种子）
    if (snap.status === "ok" || snap.status === "error") {
      // 终态恢复（插件重启后旧卡片）：直接终态渲染并关闭流
      S.status = snap.status;
      S.stopReason = snap.stopReason || null;
      S.error = snap.error || null;
      if (snap.summary && snap.summary.text) {
        S.finalText = snap.summary.text;
        S.lastMsgText = snap.summary.text;
      }
      S.durationMs = snap.durationMs != null ? snap.durationMs : null;
      finishLocal();
      closeStream();
    } else {
      // 运行中：渲染快照（部分输出），保持流接收实时事件
      S.status = "running";
      render();
      startTicker();
    }
  }

  function onEvent(frame) {
    if (!frame || typeof frame.type !== "string") return;
    if (frame.type === "session/event") {
      var ev = frame.event;
      var d = ev && ev.data;
      if (!d) return;
      if (ev.type === "assistant/chunk") {
        var t = textFromChunk(d);
        if (t) {
          S.sawChunk = true;
          S.collected += t;
          S.outputLength += t.length;
          scheduleSummaryRender(); // 节流（约 100ms）重渲染摘要区
        }
      } else if (ev.type === "assistant/message") {
        var msg = d.message;
        var id = msg && typeof msg.id === "string" ? msg.id : "";
        if (id && S.seenIds[id]) return; // 去重（mux 边界重放）
        if (id) S.seenIds[id] = true;
        var blocks = Array.isArray(msg && msg.content) ? msg.content : [];
        var msgText = "";
        for (var i = 0; i < blocks.length; i++) {
          var b = blocks[i];
          if (!b) continue;
          if (b.type === "text" && typeof b.text === "string" && b.text) {
            S.blocksSeq.push({ type: "text", text: b.text });
            msgText += b.text;
          } else if (
            b.type === "reasoning" &&
            typeof b.text === "string" &&
            b.text
          ) {
            S.blocksSeq.push({ type: "reasoning", text: b.text });
          } else if (b.type === "tool-call" && b.name) {
            S.blocksSeq.push({ type: "tool-call", name: b.name });
          }
        }
        if (msgText) {
          S.lastMsgText = msgText;
          // chunk 流已提供文本时跳过拼接，避免重复（同 dsh-run 事件循环）
          if (!S.sawChunk) {
            S.collected += msgText;
            S.outputLength += msgText.length;
          }
          // 若 frame.data 含 turn/step：覆盖更新 finalText（turn/end 前最后一条即最终汇报）
          if (d.turn != null && d.step != null) S.finalText = msgText;
        }
        mergeUsageLocal(d.usage);
        scheduleSummaryRender();
      } else if (ev.type === "turn/end") {
        onTurnEnd(d);
      }
      // step/end 等：running 期间忽略（耗时由 startedAt 实时推算）
    }
    // approval/* 等帧：卡片不展示，插件侧照常处理
  }

  function onTurnEnd(d) {
    if (S.status !== "running") return;
    var reason = d && d.reason;
    var kind = reason && reason.kind;
    // status → ok/error（reason.kind）：completed/max-tokens = 正常终态；其余（error/aborted 等）= 失败
    if (kind === "completed") {
      S.status = "ok";
      S.stopReason = "end_turn";
    } else if (kind === "max-tokens") {
      S.status = "ok";
      S.stopReason = "max_tokens";
    } else {
      S.status = "error";
      S.stopReason = kind || "end_turn";
      var f = (reason && (reason.failure || reason.error)) || {};
      S.error = String(
        f.message || (reason && reason.message) || "DSH 任务失败（无错误详情）",
      );
    }
    if (!S.finalText) S.finalText = S.lastMsgText;
    if (S.base && S.base.startedAt)
      S.durationMs = Date.now() - new Date(S.base.startedAt).getTime();
    finishLocal();
    closeStream();
  }

  // 终态收尾：outputLength 权威化（blocks 文本总长）+ 终态渲染 + 停 ticker
  function finishLocal() {
    if (S.blocksSeq.length) {
      var n = 0;
      for (var i = 0; i < S.blocksSeq.length; i++) {
        var b = S.blocksSeq[i];
        if (b && b.type === "text" && b.text) n += b.text.length;
      }
      if (n) S.outputLength = n;
    } else {
      S.outputLength = S.collected.length;
    }
    stopTicker();
    render();
  }

  // chunk 渲染节流：约 100ms 合并一次摘要区重渲染
  function scheduleSummaryRender() {
    if (summaryTimer) return;
    summaryTimer = setTimeout(function () {
      summaryTimer = null;
      render();
    }, 100);
  }

  // 运行中 1s tick：头部耗时实时走动 + 本地超时倒计时判定
  function startTicker() {
    if (tickTimer) return;
    var tms =
      S.base && S.base.timeoutMs != null
        ? Number(S.base.timeoutMs)
        : timeoutMs
          ? Number(timeoutMs)
          : null;
    if (tms && S.base && S.base.startedAt)
      timeoutDeadline = new Date(S.base.startedAt).getTime() + tms;
    tickTimer = setInterval(function () {
      if (S.status !== "running") return;
      if (timeoutDeadline && Date.now() >= timeoutDeadline) {
        // 本地超时判定：插件侧 AbortController 照常终止任务，卡片只做展示
        S.status = "error";
        S.stopReason = "timeout";
        S.error = "dsh_run 超时（" + Math.round(tms / 1000) + "s）";
        finishLocal();
        closeStream();
        return;
      }
      var durEl = root.querySelector(".dsh-dur");
      if (durEl && S.base && S.base.startedAt) {
        durEl.textContent =
          fmtDuration(Date.now() - new Date(S.base.startedAt).getTime()) +
          " · 进行中";
      }
    }, 1000);
  }

  function stopTicker() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    timeoutDeadline = null;
  }

  // ── 渲染：由本地状态构建展示快照（静态字段来自基线，动态字段来自 S），复用 render(op) ──
  function buildDisplayOp() {
    var b = S.base || {};
    var running = S.status === "running";
    var summaryText = running
      ? S.collected.slice(-SUMMARY_SHOWN)
      : S.finalText || S.lastMsgText || S.collected.slice(-SUMMARY_SHOWN);
    // 完整输出：终态用本地 blocksSeq（dsh-blocks-v1 结构化，reasoning 折叠）；运行中用 chunk 流全文
    var fullText = S.blocksSeq.length
      ? "dsh-blocks-v1::" + JSON.stringify(S.blocksSeq)
      : S.collected;
    S.lastSummaryText = summaryText;
    return {
      op: {
        task: b.task || "",
        cwd: b.cwd || "",
        agentPreset: b.agentPreset || "",
        reasoningEffort: b.reasoningEffort || "",
        provider: b.provider || "",
        model: b.model || "",
        timeoutMs:
          b.timeoutMs != null
            ? b.timeoutMs
            : timeoutMs
              ? Number(timeoutMs)
              : null,
        status: S.status,
        startedAt: b.startedAt || null,
        durationMs: running ? null : S.durationMs,
        stopReason: S.stopReason,
        error: S.error,
        summary:
          !running && summaryText
            ? { text: summaryText, summaryOf: "final-message" }
            : null,
        usage: S.usage,
        outputLength: S.outputLength,
      },
      summaryText: summaryText,
      fullText: fullText,
      running: running,
    };
  }

  function render() {
    var built = buildDisplayOp();
    var op = built.op;
    var fullOutputText = built.fullText;
    var running = built.running;
    lastFullText = fullOutputText; // 供 toggle 点击读最新完整输出
    var ok = op.status === "ok";
    var badge = running ? "运行中" : ok ? "完成" : "失败";
    var badgeCls = running ? "run" : ok ? "ok" : "fail";
    // 运行中耗时实时计算（op.durationMs 是终态值；用 startedAt 推算当前用时）
    var durMs =
      running && op.startedAt
        ? Date.now() - new Date(op.startedAt).getTime()
        : op.durationMs;
    // 摘要文本：终态有 summary 用最终结论；否则（运行中）用输出尾部预览
    var summaryText =
      (op.summary && op.summary.text) ||
      op.outputPreview ||
      built.summaryText ||
      "";
    var hasSummary = !!(summaryText && summaryText.trim());
    var outLen = op.outputLength != null ? op.outputLength : 0;

    var html = "";
    html += '<div class="dsh">';
    html += '<div class="dsh-row">';
    html += '<span class="dsh-icon">' + ICON + "</span>";
    html +=
      '<span class="dsh-title" title="DSHana">DSHana' +
      (op.agentPreset ? " · " + esc(op.agentPreset) : "") +
      "</span>";
    html += '<span class="dsh-badge ' + badgeCls + '">' + badge + "</span>";
    html +=
      '<span class="dsh-dur">' +
      fmtDuration(durMs) +
      (running ? " · 进行中" : "") +
      "</span>";
    html += "</div>";
    html += '<div class="dsh-detail">';
    html +=
      '<div class="dsh-d-row"><span class="dsh-d-label">任务</span><span class="dsh-d-value dsh-task-expand' +
      (S.taskOpen ? " open" : "") +
      '" title="' +
      (S.taskOpen ? "点击收起" : "点击展开/收起") +
      '">' +
      esc(op.task || "—") +
      "</span></div>";
    html +=
      '<div class="dsh-d-row"><span class="dsh-d-label">目录</span><span class="dsh-d-value">' +
      esc(op.cwd || "—") +
      "</span></div>";
    // 模型：provider / model / effort（无值时省略该行；缺省补齐在 dsh-run 侧完成）
    var modelText = [op.provider, op.model, op.reasoningEffort]
      .filter(Boolean)
      .join(" / ");
    if (modelText)
      html +=
        '<div class="dsh-d-row"><span class="dsh-d-label">模型</span><span class="dsh-d-value">' +
        esc(modelText) +
        "</span></div>";
    // 时间行：开始时间 / 超时预算（无超时或恢复态只显示开始时间；超时预算并入避免独立行）
    var timeText = esc(fmtTime(op.startedAt));
    if (op.timeoutMs != null)
      timeText += " / " + esc(fmtDuration(op.timeoutMs));
    html +=
      '<div class="dsh-d-row"><span class="dsh-d-label">时间</span><span class="dsh-d-value">' +
      timeText +
      "</span></div>";
    // 词元账目：始终显示（无 usage 时显示「—」，保持详情区行数稳定，卡片高度不随词元有无波动）
    var usageText = fmtUsage(op.usage);
    html +=
      '<div class="dsh-d-row"><span class="dsh-d-label">词元</span><span class="dsh-d-value">' +
      esc(usageText || "—") +
      "</span></div>";
    // 状态：置于末行（badge + 停止原因）
    html +=
      '<div class="dsh-d-row"><span class="dsh-d-label">状态</span><span class="dsh-d-value">' +
      badge +
      (op.stopReason ? "（" + esc(op.stopReason) + "）" : "") +
      "</span></div>";
    html += "</div>";

    if (op.error) {
      html += '<div class="dsh-error">' + esc(op.error) + "</div>";
    } else if (hasSummary) {
      // 切换按钮：置于摘要区上方（右对齐），始终显示；文案 = 当前视图名（运行中「滚动摘要」/ 终态「最终结论」/ 完整输出）
      var btnLabel = !S.fullOpen
        ? running
          ? "滚动摘要"
          : "最终结论"
        : "完整输出";
      html +=
        '<button class="dsh-output-toggle" id="dsh-output-toggle">' +
        btnLabel +
        "</button>";
      // 共用容器：默认摘要视图，fullOpen 时显示完整输出（本地 blocks/chunk 流），按钮切换内容
      var bodyHtml = S.fullOpen
        ? renderBody(fullOutputText)
        : mdToHtml(summaryText);
      html += '<div class="dsh-summary" id="dsh-body">' + bodyHtml + "</div>";
      html +=
        '<div class="dsh-summary-meta">' + esc(summaryMeta(op)) + "</div>";
    } else if (!running) {
      html += '<div class="dsh-empty">（DSH 未返回文本）</div>';
    }
    html += "</div>";

    var replaced = false;
    if (root.innerHTML !== html) {
      root.innerHTML = html;
      replaced = true;
    }

    var toggle = document.getElementById("dsh-output-toggle");
    if (toggle)
      toggle.addEventListener("click", function () {
        // 完整输出已本地就绪（blocks/chunk 流），视图切换无需再请求
        S.fullOpen = !S.fullOpen;
        var body = document.getElementById("dsh-body");
        if (body)
          body.innerHTML = S.fullOpen
            ? renderBody(lastFullText)
            : mdToHtml(S.lastSummaryText);
        toggle.textContent = S.fullOpen
          ? "完整输出"
          : running
            ? "滚动摘要"
            : "最终结论";
        reportSize();
      });

    // 任务值：默认单行截断，点击展开/收起全文（状态存 JS 变量，重建后保持）
    var taskExpand = root.querySelector(".dsh-task-expand");
    if (taskExpand)
      taskExpand.addEventListener("click", function () {
        S.taskOpen = !S.taskOpen;
        taskExpand.classList.toggle("open", S.taskOpen);
        taskExpand.title = S.taskOpen ? "点击收起" : "点击展开";
        reportSize();
      });

    // 完整输出增量注入：完整输出视图下，DOM 被重建或全量文本变化时才重渲染（避免每次 tick 重渲染大输出）
    var bodyEl = document.getElementById("dsh-body");
    if (
      bodyEl &&
      S.fullOpen &&
      (replaced || fullOutputText !== S.lastFullRendered)
    ) {
      bodyEl.innerHTML = renderBody(fullOutputText);
      S.lastFullRendered = fullOutputText;
    }

    // 运行中：实时刷新头部耗时（tick 渲染时重算，内容未变化重建被跳过时 dur 也能持续走动）
    var durEl = root.querySelector(".dsh-dur");
    if (durEl && running && op.startedAt) {
      durEl.textContent =
        fmtDuration(Date.now() - new Date(op.startedAt).getTime()) +
        " · 进行中";
    }

    // 摘要/输出容器：运行中（.live）隐藏滚动条并固定滚底跟随最新输出；终态与完整输出恢复正常滚动
    var summaryEl = root.querySelector(".dsh-summary");
    if (summaryEl) {
      summaryEl.classList.toggle("live", running);
      if (running) summaryEl.scrollTop = summaryEl.scrollHeight;
    }

    reportSize();
  }

  // 摘要区小字说明（JS 生成）
  function summaryMeta(op) {
    var len = op.outputLength != null ? op.outputLength : 0;
    if (op.status === "running") {
      return (
        "运行中 · 实时尾部预览" + (len ? "（已产出 " + len + " 字符）" : "")
      );
    }
    var src = "输出预览";
    if (op.summary) {
      src =
        op.summary.summaryOf === "final-message"
          ? "最终汇报"
          : op.summary.summaryOf === "head-tail"
            ? "首尾摘要（中间过程已折叠）"
            : op.summary.summaryOf === "full"
              ? "全文"
              : "摘要";
    }
    return "最终结论（" + src + "）· 完整输出 " + len + " 字符";
  }

  function renderFail(msg) {
    root.innerHTML =
      '<div class="dsh"><div class="dsh-empty">' + esc(msg) + "</div></div>";
    reportSize();
  }

  // ── 安装/升级卡片（data-kind="dep"，/card/dep）──
  // 数据源 = 宿主单例 g.depTasks（tools/dsh-install.js 异步流程 action=install/update
  // 登记）+ g.depsInstallLog（npm 实时日志尾部）。链路：SSE /ops/dep-stream（首帧 +
  // 每 1s 快照，终态推送后关闭）；EventSource 建立失败回退一次 /ops/dep-status。
  // 渲染：标题（DSH 安装 / DSH 升级）+ 状态徽标（安装中/升级中/完成/失败）+ npm 日志
  // 尾部实时滚动（预格式文本，运行中隐藏滚动条 + 固定滚底）+ 完成结果/错误信息。
  // 不触碰任务卡片逻辑（kind 分支在文件顶部 return，各自独立状态机）。
  function initDepCard() {
    var taskId = (root && root.dataset.task) || pageParams.get("taskId") || "";
    if (!taskId) {
      renderFail("缺少任务 ID");
      return;
    }
    var S = {
      state: "running",
      kind: "install",
      log: "",
      result: null,
      at: "",
      update: null,
    };
    var es = null;
    var fallbackDone = false;
    // 连接占位（基线到达前避免空白闪烁）
    root.innerHTML =
      '<div class="dsh"><div class="dsh-empty">正在连接安装/升级状态…</div></div>';
    reportSize();

    function render() {
      var running = S.state === "running";
      var isInstall = S.kind !== "update";
      var title = isInstall ? "DSH 安装" : "DSH 升级";
      var badge = running
        ? isInstall
          ? "安装中"
          : "升级中"
        : S.state === "ok"
          ? "完成"
          : "失败";
      var badgeCls = running ? "run" : S.state === "ok" ? "ok" : "fail";
      var logText = S.log || "";
      // 完成结果行（result/update 字段）
      var resultText = "";
      var r = S.result || null;
      var u = S.update || null;
      if (S.state === "ok") {
        if (isInstall) {
          var ver = r && r.version;
          resultText =
            "已安装" +
            (ver ? " v" + ver : "") +
            (r && r.autoStart === true
              ? "，web host 已自动启动"
              : r && r.autoStart === false
                ? "，web host 自动启动失败（可在 DSHana 标签页手动启动）"
                : "");
        } else {
          var uver = (u && u.version) || (r && r.version);
          resultText =
            "更新完成" +
            (uver ? " v" + uver : "") +
            (u && u.error ? "（web host 重启失败：" + u.error + "）" : "") +
            "，请重启 DSHana 使完全生效";
        }
      } else if (S.state === "error") {
        var errText =
          (isInstall ? r && r.error : (u && u.error) || (r && r.error)) || "";
        resultText =
          (isInstall ? "安装失败：" : "更新失败：") + (errText || "未知错误");
      }
      var html = "";
      html += '<div class="dsh">';
      html += '<div class="dsh-row">';
      html += '<span class="dsh-icon">' + ICON + "</span>";
      html +=
        '<span class="dsh-title" title="DSHana">' + esc(title) + "</span>";
      html += '<span class="dsh-badge ' + badgeCls + '">' + badge + "</span>";
      html +=
        '<span class="dsh-dur">' +
        (S.at ? "开始于 " + esc(fmtTime(S.at)) : "") +
        "</span>";
      html += "</div>";
      if (logText) {
        html +=
          '<div class="dsh-dep-log' +
          (running ? " live" : "") +
          '" id="dsh-dep-log">' +
          esc(logText) +
          "</div>";
      }
      if (resultText) {
        html +=
          '<div class="dsh-dep-result' +
          (S.state === "error" ? " dsh-error" : "") +
          '">' +
          esc(resultText) +
          "</div>";
      }
      html += "</div>";
      if (root.innerHTML !== html) {
        root.innerHTML = html;
        // 运行中：日志固定滚底跟随最新输出
        if (running) {
          var logEl = document.getElementById("dsh-dep-log");
          if (logEl) logEl.scrollTop = logEl.scrollHeight;
        }
      }
      reportSize();
    }

    function onSnapshot(snap) {
      if (!snap) return;
      S.state = snap.state || "running";
      S.kind = snap.kind || "install";
      S.log = snap.log || "";
      S.result = snap.result || null;
      S.at = snap.at || "";
      S.update = snap.update || null;
      render();
      if (S.state !== "running") {
        closeStream();
      }
    }

    function closeStream() {
      if (es) {
        try {
          es.close();
        } catch (e) {
          /* 已关 */
        }
        es = null;
      }
    }

    function fallbackStatus() {
      apiFetch("/ops/dep-status?taskId=" + encodeURIComponent(taskId), {
        cache: "no-store",
      })
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          if (!data || !data.ok) {
            renderFail((data && data.error) || "任务不存在");
            return;
          }
          onSnapshot(data.task);
        })
        .catch(function () {
          renderFail("任务不存在");
        });
    }

    try {
      es = new EventSource(
        apiUrl("/ops/dep-stream?taskId=" + encodeURIComponent(taskId)),
      );
    } catch (e) {
      fallbackStatus();
      return;
    }
    es.addEventListener("snapshot", function (e) {
      var snap = null;
      try {
        snap = JSON.parse(e.data);
      } catch (err) {
        /* 坏帧忽略 */
      }
      if (snap) onSnapshot(snap);
    });
    es.addEventListener("error", function (e) {
      // 流中断/任务不存在：从未拿到快照时兜底一次 /ops/dep-status
      if (S.state === "running" && !fallbackDone) {
        fallbackDone = true;
        closeStream();
        fallbackStatus();
      }
    });
    // 高度自适应增强与任务卡片同款（字体就绪补报 + ResizeObserver 跟随内容变化）
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        setTimeout(reportSize, 50);
      });
    }
    if (typeof ResizeObserver !== "undefined") {
      var roTimer = null;
      new ResizeObserver(function () {
        clearTimeout(roTimer);
        roTimer = setTimeout(reportSize, 60);
      }).observe(document.body);
    }
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

  var ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>';

  // ── 启动 ──
  window.addEventListener("load", function () {
    setTimeout(reportSize, 60);
  });
  // 高度自适应增强：宿主字体异步加载时首次上报高度常偏小（终态后流关闭即定格），
  // 字体就绪后补报一次 + ResizeObserver 跟随内容尺寸变化自动重报（防抖），根治刚出现时带滚动条
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      setTimeout(reportSize, 50);
    });
  }
  if (typeof ResizeObserver !== "undefined") {
    var roTimer = null;
    new ResizeObserver(function () {
      clearTimeout(roTimer);
      roTimer = setTimeout(reportSize, 60);
    }).observe(document.body);
  }
  // 连接占位（基线到达前避免空白闪烁）
  root.innerHTML =
    '<div class="dsh"><div class="dsh-empty">正在连接任务状态…</div></div>';
  reportSize();
  startStream();
})();
