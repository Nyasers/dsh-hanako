// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// routes/card.js — dsh-hanako 任务反馈卡片路由
//   GET /card/op?sessionId=&rpcId=&timeoutMs=       卡片页面（iframe 内容）
//   GET /ops/stream?sessionId=&rpcId=&timeoutMs=     SSE 推送源（卡片主链路：基线快照 + DSH 实时事件转发）
//   GET /ops/status?sessionId=&rpcId=&timeoutMs=     兜底状态 JSON（EventSource 建立失败时卡片回退一次；仅 jsonl 恢复路径）
//   GET /ops/output?sessionId=&rpcId=&timeoutMs=     兜底全量输出 JSON（兼容旧卡片懒加载；仅 jsonl 恢复路径）
//   GET /card/dep?taskId=                            安装/升级卡片页面（dsh_install 异步流程 action=install/update，data-kind="dep"）
//   GET /ops/dep-stream?taskId=                      安装/升级卡片 SSE 推送源（进程内 g.depTasks + g.deps.log）
//   GET /ops/dep-status?taskId=                      安装/升级卡片兜底状态 JSON
//
// 架构：卡片链路从「HTTP 轮询 + op Map」改为「SSE 服务端推送 + jsonl 唯一事实源」。
// 三层：卡片（iframe EventSource）<-> 插件（routes 转发）<-> DSH（events.mux WebSocket）。
// 插件零任务状态：op Map 退役（tools/dsh-run.js 不再写任务快照），dsh 会话日志
// （<dataDir>/dsh-home/sessions/<cwd分组>/<sessionId>/session.v*.jsonl.zstd 或 v0
// 原名 session.jsonl.zstd）为唯一事实源。
// 每次 dsh_run 提交对应一个 user/message 事件（data.source.kind==user，
// data.source.rpcId == 插件 callUnary 生成的 rpcId），按 rpcId 精确命中后，
// 取该 user prompt 到下一个 user prompt（或文件尾）的事件窗口重建 op 快照。
// 卡片资源（app/card.css / app/card.js）每次请求读盘，改样式即时生效。

import fs from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
// 卡片前端资产（构建期 asset/source 内联为字符串；样式/脚本免构建机路径、零磁盘读）
import cardCss from "../assets/card.css";
import cardJs from "../assets/card.js";
// 卡片页面 HTML 模板（构建期 template-loader 经 doT 编译为自包含渲染函数）
import { render as cardOpHtml } from "../assets/card-op.jinja2";
import { render as cardDepHtml } from "../assets/card-dep.jinja2";
import { subscribeDshCtxEmitEvents } from "../lib/dsh-events.js";

const CARD_ASSETS = { css: cardCss, js: cardJs };

// ---- 会话 jsonl 恢复（唯一事实源：op Map 退役后一切任务状态都从这里重建）----
// dsh 会话日志 = <dataDir>/dsh-home/sessions/<cwd分组>/<sessionId>/ 目录下 session.v<num>.jsonl.zstd
//（dsh Session format v2；v0 时代为原名 session.jsonl.zstd），追加式多帧 zstd
//（每次 append 一帧，帧以 magic 28 B5 2F FD 开头）。
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 多帧 zstd 逐帧解压：dsh 会话日志（session.jsonl.zstd / session.v*.jsonl.zstd）每帧独立可解，返回事件数组（坏帧跳过）。 */
function decodeSessionLog(filePath) {
  const buf = fs.readFileSync(filePath);
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
    starts.push(i);
    i += 4;
  }
  const chunks = [];
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      chunks.push(zstdDecompressSync(buf.subarray(starts[k], end)));
    } catch {
      /* 单帧损坏跳过 */
    }
  }
  const events = [];
  for (const c of chunks) {
    for (const line of c.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  return events;
}

/** 按 sessionId 定位会话日志文件（遍历 sessions/ 分组目录，不依赖 cwd 目录名编码）。
 * dsh Session format v0 = session.jsonl.zstd（原名）；v1+ = session.v<num>.jsonl.zstd
 *（如 session.v2.jsonl.zstd）。目录内取存在的最新代（v 数字最大优先，v0 兜底）。 */
function sessionLogPath(dataDir, sessionId) {
  const sessionsRoot = path.join(dataDir, "dsh-home", "sessions");
  if (!fs.existsSync(sessionsRoot)) return null;
  for (const group of fs.readdirSync(sessionsRoot)) {
    const dir = path.join(sessionsRoot, group, sessionId);
    if (!fs.existsSync(dir)) continue;
    const logName = findSessionLogName(dir);
    if (logName) return path.join(dir, logName);
  }
  return null;
}

/** 会话日志文件名探测（v0/vN 双命名代，取最新）；无则 null。 */
function findSessionLogName(sessionDir) {
  const v0 = "session.jsonl.zstd";
  let best = null;
  let bestV = -1;
  let names;
  try {
    names = fs.readdirSync(sessionDir);
  } catch {
    return null;
  }
  for (const n of names) {
    if (n === v0) {
      if (bestV < 0) {
        best = n;
        bestV = 0;
      }
      continue;
    }
    const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(n);
    if (m) {
      const v = Number(m[1]);
      if (v > bestV) {
        best = n;
        bestV = v;
      }
    }
  }
  return best;
}

function textFromBlocks(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((b) => (b && b.text) || "").join("");
  return "";
}

/** usage 累计（与 dsh-run 事件循环同口径：disjoint 四字段求和；缺失字段不初始化，API 未返回时不显示）。 */
function mergeUsage(acc, u) {
  if (!u) return acc;
  acc = acc || {};
  acc.inputTokens = (acc.inputTokens || 0) + (u.inputTokens ?? 0);
  acc.outputTokens = (acc.outputTokens || 0) + (u.outputTokens ?? 0);
  if (u.cacheReadTokens != null)
    acc.cacheReadTokens = (acc.cacheReadTokens || 0) + u.cacheReadTokens;
  if (u.reasoningTokens != null)
    acc.reasoningTokens = (acc.reasoningTokens || 0) + u.reasoningTokens;
  return acc;
}

/** 从会话 jsonl 按 rpcId 重建 op 快照（唯一事实源路径；运行中窗口无 turn/end → 归一化为 running 快照）。 */
function rebuildOpFromLog(dataDir, sessionId, rpcId) {
  const logPath = sessionLogPath(dataDir, sessionId);
  if (!logPath) return null;
  let events = [];
  try {
    events = decodeSessionLog(logPath);
  } catch {
    return null;
  }
  let header = null;
  const prompts = [];
  for (const ev of events) {
    if (ev.type === "session" && !header) header = ev;
    else if (ev.type === "user/message" && ev.data?.source?.kind === "user")
      prompts.push(ev);
  }
  let idx = prompts.findIndex((u) => u.data?.source?.rpcId === rpcId);
  if (idx < 0) {
    // ACP 通道兑底：ACP 会话的 jsonl 里 user/message 无 source.rpcId（ACP 协议无
    // requestId 概念——rpcId 是 HTTP client-request 信封才注入的宿主侧键）。特征 =
    // 全部 user prompt 都无 rpcId——此时退化取最后一个 prompt（最近任务，当前任务
    // 卡片场景即命中）；HTTP 会话（prompt 带 rpcId）匹配失败仍判不存在（原行为）。
    if (prompts.length && prompts.every((u) => u.data?.source?.rpcId == null)) {
      idx = prompts.length - 1;
    } else {
      return null;
    }
  }
  const prompt = prompts[idx];
  const startSeq = prompt.seq;
  const endSeq = idx + 1 < prompts.length ? prompts[idx + 1].seq : Infinity;
  const blockSeq = []; // 结构化输出：按消息顺序收集 blocks（text/reasoning/tool-call），reasoning 可折叠
  let msgTexts = []; // 纯文本拼接（outputLength/预览用 + 无 blocks 时兜底）
  let sawFinalFinish = false;
  let finalText = ""; // 最后一个 finish(reason.kind==stop) 之后的 assistant/message 文本 = 最终回答（摘要）
  let lastMsgText = "";
  let usage = null;
  let turnEnd = null;
  let lastErr = null;
  let modelCfg = null; // request/header 事件带实际模型配置（取窗口内首个）
  for (const ev of events) {
    if (ev.seq < startSeq || ev.seq >= endSeq) continue;
    if (ev.type === "assistant/chunk") {
      const c = ev.data?.chunk;
      if (c?.type === "finish" && c.reason?.kind === "stop")
        sawFinalFinish = true; // 工具循环结束的最终 LLM 调用
    } else if (ev.type === "assistant/message") {
      const blocks = Array.isArray(ev.data?.message?.content)
        ? ev.data.message.content
        : [];
      let msgText = "";
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string" && b.text) {
          blockSeq.push({ type: "text", text: b.text });
          msgText += b.text;
        } else if (
          b?.type === "reasoning" &&
          typeof b.text === "string" &&
          b.text
        ) {
          blockSeq.push({ type: "reasoning", text: b.text });
        } else if (b?.type === "tool-call" && b.name) {
          blockSeq.push({ type: "tool-call", name: b.name });
        }
      }
      if (msgText) {
        msgTexts.push(msgText);
        lastMsgText = msgText;
        if (sawFinalFinish) finalText = msgText;
      }
      usage = mergeUsage(usage, ev.data?.usage);
    } else if (ev.type === "turn/end") {
      turnEnd = ev;
    } else if (ev.type === "request/header") {
      const cfg = ev.data?.header?.config;
      if (cfg && !modelCfg) modelCfg = cfg; // 每个 turn 首个请求带模型配置，取窗口内第一个
    } else if (ev.type === "step/end" && ev.data?.error) {
      lastErr = ev.data.error;
    }
  }
  // 结构化输出（卡片渲染器识别 dsh-blocks-v1 前缀，reasoning 折叠展示）；无 blocks 时回退纯文本
  const output = blockSeq.length
    ? "dsh-blocks-v1::" + JSON.stringify(blockSeq)
    : msgTexts.join("\n\n");
  const textLen = msgTexts.join("").length;
  const taskText = textFromBlocks(prompt.data?.content);
  const startedAt = new Date(prompt.time).toISOString();
  // 窗口无 turn/end = 任务未进入终态（仍在运行 / 重启时被杀）——
  // jsonl 唯一事实源语义：没有终态事件就是未完成，快照归一化为 running（部分输出），
  // 卡片据此保持运行态展示（SSE 实时事件随后接管；本地超时倒计时兜底）。
  if (!turnEnd) {
    return {
      rpcId,
      task: taskText || "（任务描述不可用）",
      cwd: header?.cwd || "",
      agentPreset: header?.agentPreset || "",
      reasoningEffort: modelCfg?.reasoningEffort || "",
      provider: modelCfg?.provider || "",
      model: modelCfg?.model || "",
      timeoutMs: null,
      status: "running",
      startedAt,
      durationMs: null,
      stopReason: null,
      error: undefined,
      summary: null,
      usage,
      output,
      outputLength: textLen || output.length,
      outputPreview: output.slice(-1024), // 预览 1KB（滚动摘要显示量更足）
      recovered: true,
    };
  }
  const summaryText = finalText || lastMsgText;
  const stopReason = turnEnd.data?.reason?.kind || "end_turn";
  const isError =
    stopReason === "error" || stopReason === "aborted" || !!lastErr;
  return {
    rpcId,
    task: taskText || "（任务描述不可用）",
    cwd: header?.cwd || "",
    agentPreset: header?.agentPreset || "",
    reasoningEffort: modelCfg?.reasoningEffort || "",
    provider: modelCfg?.provider || "",
    model: modelCfg?.model || "",
    timeoutMs: null,
    status: isError ? "error" : "ok",
    startedAt,
    durationMs:
      turnEnd?.time != null ? Math.max(0, turnEnd.time - prompt.time) : null,
    stopReason,
    error: isError ? String(lastErr || stopReason) : undefined,
    summary: summaryText
      ? { text: summaryText, summaryOf: "final-message" }
      : null,
    usage,
    output,
    outputLength: textLen || output.length,
    outputPreview: output.slice(-1024), // 预览 1KB（滚动摘要显示量更足）
    recovered: true,
  };
}

// 恢复缓存（按 rpcId，上限 20 条）：旧卡片轮询 stop 前会多次请求，避免重复解压大日志。
// 运行中快照不缓存——每次连接重建，避免断线重连拿到过期基线（运行中状态在 jsonl 里是增量事实）。
const recoveredCache = new Map();
function cachedRebuild(dataDir, sessionId, rpcId) {
  const key = sessionId + "::" + rpcId;
  if (recoveredCache.has(key)) return recoveredCache.get(key);
  const op = rebuildOpFromLog(dataDir, sessionId, rpcId);
  if (op && op.status !== "running") {
    if (recoveredCache.size >= 20) {
      const firstKey = recoveredCache.keys().next().value;
      if (firstKey) recoveredCache.delete(firstKey);
    }
    recoveredCache.set(key, op);
  }
  return op;
}

/** 取操作快照（op Map 已退役，仅 jsonl 恢复路径；sessionId+rpcId 为定位键）。
 * 恢复快照补齐 timeoutMs：URL 携带（会话日志无该配置项），仅当快照无值时覆盖。
 * includeFull=true 时额外带全量 output（/ops/stream 基线需要）。 */
function readOp({ sessionId, rpcId, timeoutMs }, includeFull) {
  const g = globalThis.__dshHanako;
  if (!rpcId || !sessionId || !g?.dataDir) return null;
  const op = cachedRebuild(g.dataDir, String(sessionId), String(rpcId));
  if (!op) return null;
  if (op.timeoutMs == null && timeoutMs != null)
    op.timeoutMs = Number(timeoutMs) || null;
  let output = String(op.output ?? "");
  // 预览：结构化的 outputPreview 优先，否则 output 尾部（结构化 blocks 取 text 块文本）
  const isBlocks = output.indexOf("dsh-blocks-v1::") === 0;
  let previewText = output;
  if (!output && op.outputPreview != null) {
    previewText = String(op.outputPreview);
  } else if (isBlocks) {
    try {
      const blocks = JSON.parse(output.slice("dsh-blocks-v1::".length));
      previewText = blocks
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text)
        .join("");
    } catch {
      /* 解析失败用原文 */
    }
  }
  const snap = {
    task: op.task || "",
    cwd: op.cwd || "",
    agentPreset: op.agentPreset || "",
    reasoningEffort: op.reasoningEffort || "",
    provider: op.provider || "",
    model: op.model || "",
    timeoutMs: op.timeoutMs ?? null,
    status: op.status, // running | ok | error
    startedAt: op.startedAt,
    durationMs: op.durationMs,
    stopReason: op.stopReason,
    recovered: !!op.recovered,
    error: op.error,
    summary: op.summary ?? null, // { text, summaryOf, fullLength } | null
    usage: op.usage ?? null, // DeepSeek adapter usage { inputTokens, outputTokens, cacheReadTokens, reasoningTokens } | null
    outputPreview: previewText.slice(-1024), // 预览 1KB（滚动摘要显示量更足）
    outputLength:
      op.outputLength ?? (isBlocks ? previewText.length : output.length),
  };
  if (includeFull) snap.output = output;
  return snap;
}

export default function registerCardRoutes(app, ctx) {
  const base = "/api/plugins/" + ctx.pluginId;

  // 卡片页（iframe 内容）：sessionId+rpcId（重启恢复定位；op Map 退役后仅此可定位）
  app.get("/card/op", (c) => {
    const assets = CARD_ASSETS;
    const sessionId = String(c.req.query("sessionId") || "");
    const rpcId = String(c.req.query("rpcId") || "");
    const timeoutMs = String(c.req.query("timeoutMs") || "");
    const hc = c.req.query("hana-css") || "";
    const th = c.req.query("hana-theme") || "inherit";
    const hcLink = hc ? `<link rel="stylesheet" href="${esc(hc)}">` : "";
    // 页面模板来自 src/assets/card-op.jinja2（asset/source 内联，占位符保留）
    return c.html(
      cardOpHtml({
        hcLink,
        assets,
        esc,
        th,
        sessionId,
        rpcId,
        timeoutMs,
        base,
      }),
    );
  });

  // SSE 推送源（卡片主链路）：先推 baseline（jsonl 恢复快照，含全量 output），
  // 再对每个连接订阅一次 DSH 会话事件（进程内 ctx 直订——ACP 内部通道下会话事件走
  // session/event 通用广播，DSH WS events.mux 只转 api-session/*（HTTP 网关面），ACP
  // 会话不在其上——直订同一事件源零 WS/端口绕圈），过滤 sessionId === 本连接会话的帧，
  // 以 event 事件转译转发；连接关闭时退订。
  app.get("/ops/stream", (c) => {
    const sessionId = String(c.req.query("sessionId") || "");
    const rpcId = String(c.req.query("rpcId") || "");
    const timeoutMs = String(c.req.query("timeoutMs") || "");
    if (!sessionId || !rpcId)
      return c.json({ ok: false, error: "缺少 sessionId 或 rpcId" }, 400);
    const g = globalThis.__dshHanako;
    const baseline = readOp({ sessionId, rpcId, timeoutMs }, true);
    if (!baseline) return c.json({ ok: false, error: "任务记录不存在" }, 404);

    let offEvents = null; // ctx 进程内订阅退订函数（替代 WS events.mux）
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const send = (name, data) => {
          if (closed) return;
          try {
            controller.enqueue(
              enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          } catch {
            /* 连接已断 */
          }
        };
        const closeAll = () => {
          if (closed) return;
          closed = true;
          if (typeof offEvents === "function") {
            try {
              offEvents();
            } catch {
              /* 已退订 */
            }
            offEvents = null;
          }
          try {
            controller.close();
          } catch {
            /* 已关 */
          }
        };
        // a) 基线快照（jsonl 恢复；运行中窗口归一化为 running + 部分输出）
        send("baseline", baseline);
        // b) 转发 DSH 实时事件：进程内 ctx 直订（session/event 通用广播——jsonl 同源，
        // 含 turn/start、assistant/chunk、assistant/message、turn/end 等；card.js 前端已
        // 原生消费该帧格式）。emit 帧 {type:"emit",event,args} 的 session/event 参数为
        // [session, evObj]——转译 {type:"session/event", event: evObj, sessionId: session.id}
        // 投卡片。
        try {
          offEvents = subscribeDshCtxEmitEvents((frame) => {
            if (
              !frame ||
              frame.type !== "emit" ||
              frame.event !== "session/event"
            )
              return;
            const args = Array.isArray(frame.args) ? frame.args : [];
            const [session, evObj] = args;
            const sid = session && (session.id ?? null);
            if (!sid || sid !== sessionId) return; // 只转发本连接会话的帧
            if (!evObj || typeof evObj.type !== "string") return;
            send("event", {
              type: "session/event",
              event: evObj,
              sessionId: sid,
            });
          });
          if (!offEvents)
            throw new Error("ctx 未就绪，无法订阅 DSH 会话事件");
        } catch (e) {
          // ctx 订阅失败（boot 边缘/异常形态）：基线已推送，结束流（卡片侧
          // EventSource 自动重连 / 兜底 /ops/status jsonl 恢复路径）
          closeAll();
        }
      },
      cancel() {
        // 卡片断开（EventSource.close / 页面卸载）：退订 ctx 事件释放连接
        if (typeof offEvents === "function") {
          try {
            offEvents();
          } catch {
            /* 已退订 */
          }
          offEvents = null;
        }
      },
    });
    return c.body(stream, 200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
  });

  // 状态兜底源（降级：仅 jsonl 恢复路径，不再读 op Map）。
  // 定位：sessionId+rpcId（op Map 退役后唯一定位键）。
  app.get("/ops/status", (c) => {
    const sessionId = String(c.req.query("sessionId") || "");
    const rpcId = String(c.req.query("rpcId") || "");
    const timeoutMs = String(c.req.query("timeoutMs") || "");
    if (!sessionId || !rpcId)
      return c.json({ ok: false, error: "缺少 sessionId 或 rpcId" }, 400);
    const op = readOp({ sessionId, rpcId, timeoutMs });
    if (!op) return c.json({ ok: false, error: "任务记录不存在" }, 404);
    return c.json({ ok: true, op });
  });

  // 全量输出兜底拉取（兼容旧卡片懒加载；jsonl 恢复路径）
  app.get("/ops/output", (c) => {
    const sessionId = String(c.req.query("sessionId") || "");
    const rpcId = String(c.req.query("rpcId") || "");
    const timeoutMs = String(c.req.query("timeoutMs") || "");
    if (!sessionId || !rpcId)
      return c.json({ ok: false, error: "缺少 sessionId 或 rpcId" }, 400);
    const op = readOp({ sessionId, rpcId, timeoutMs }, true);
    if (!op) return c.json({ ok: false, error: "任务记录不存在" }, 404);
    return c.json({
      ok: true,
      output: op.output,
      outputLength: op.outputLength,
    });
  });

  // ── 安装/升级卡片（数据源 = 宿主单例 g.depTasks + g.deps.log）──
  // dsh_install 异步流程（action=install/update）登记 g.depTasks（Map：taskId → {
  // taskId, kind: install|update, state: running|ok|error, log, at, result }）；本卡片
  // 非 dsh 会话、无 jsonl，状态与 npm 实时日志全在宿主进程内。三条链路与任务卡片同构：
  //   GET /card/dep?taskId=      卡片页面（iframe 内容，data-kind="dep"）
  //   GET /ops/dep-stream?taskId= SSE 推送源（定时推快照 + log 增量；终态推送后关闭）
  //   GET /ops/dep-status?taskId= 兜底状态 JSON（EventSource 建立失败时卡片回退一次）

  /** 构建安装/升级任务快照（数据源：g.depTasks 条目 + g.deps.log 实时日志 +
   * entry.result——kind=update 时直接取 t.result（updateDsh 返回值，与旧
   * update-result.json 文件同源；v0.24 文件退役后 result 即权威终态）。只回非敏感字段。 */
  function buildDepSnapshot(g, t) {
    const snap = {
      taskId: t.taskId,
      kind: t.kind,
      state: t.state,
      at: t.at,
      result: t.result,
    };
    // 日志：终态定格（entry.log）优先；运行期读 g.deps.log 实时尾部（≤2000）
    snap.log = t.log != null ? t.log : String(g?.deps?.log || "").slice(-2000);
    if (t.kind === "update") {
      // 更新终态直接透出 t.result（与旧文件同源；update-result.json 已退役不再读——
      // 遗留文件由 migrate.js cleanup-update-result 步骤删除）
      const u = t.result;
      if (u && typeof u === "object") {
        snap.update = {
          state: u.state,
          version: u.version ?? null,
          error: String(u.error || "").slice(0, 400) || null,
          // 完成时间优先 g.update.time（updateDsh 终态时刻）；无则回退任务发起时刻 t.at
          at: g?.update?.time || t.at || null,
        };
      }
    }
    return snap;
  }

  // 安装/升级卡片页（iframe 内容）：taskId 定位 g.depTasks 条目
  app.get("/card/dep", (c) => {
    const assets = CARD_ASSETS;
    const taskId = String(c.req.query("taskId") || "");
    const hc = c.req.query("hana-css") || "";
    const th = c.req.query("hana-theme") || "inherit";
    const hcLink = hc ? `<link rel="stylesheet" href="${esc(hc)}">` : "";
    // 页面模板来自 src/assets/card-dep.jinja2（asset/source 内联，占位符保留）
    return c.html(
      cardDepHtml({
        hcLink,
        assets,
        esc,
        th,
        taskId,
        base,
      }),
    );
  });

  // 安装/升级卡片 SSE 推送源：进程内数据（g.depTasks），定时推快照；
  // 终态（ok/error）推送后关闭流；每 30s 无数据时推心跳（防代理超时断连）。
  app.get("/ops/dep-stream", (c) => {
    const taskId = String(c.req.query("taskId") || "");
    if (!taskId) return c.json({ ok: false, error: "缺少 taskId" }, 400);
    const g = globalThis.__dshHanako;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        let timer = null;
        let lastBeat = Date.now();
        const send = (name, data) => {
          if (closed) return;
          try {
            controller.enqueue(
              enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          } catch {
            closeAll();
          }
        };
        const closeAll = () => {
          if (closed) return;
          closed = true;
          if (timer) clearInterval(timer);
          try {
            controller.close();
          } catch {
            /* 已关 */
          }
        };
        const push = () => {
          const t = g?.depTasks?.get(taskId) || null;
          if (!t) {
            send("error", { error: "任务不存在" });
            closeAll();
            return;
          }
          send("snapshot", buildDepSnapshot(g, t));
          if (t.state !== "running") closeAll();
        };
        // 首帧立即推（卡片挂载即见当前状态）；之后每 1s 推一次（running 时 log 实时滚动）
        push();
        timer = setInterval(() => {
          if (closed) return;
          if (Date.now() - lastBeat >= 30000) {
            // 心跳：空注释行（SSE 注释帧），防代理/浏览器超时判定
            lastBeat = Date.now();
            try {
              controller.enqueue(enc.encode(": heartbeat\n\n"));
            } catch {
              closeAll();
            }
            return;
          }
          push();
        }, 1000);
      },
      cancel() {
        // 卡片断开（EventSource.close / 页面卸载）：停定时器释放
        closed = true;
        if (timer) clearInterval(timer);
      },
    });
    return c.body(stream, 200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
  });

  // 安装/升级卡片兜底状态 JSON（EventSource 建立失败时卡片回退一次）
  app.get("/ops/dep-status", (c) => {
    const taskId = String(c.req.query("taskId") || "");
    if (!taskId) return c.json({ ok: false, error: "缺少 taskId" }, 400);
    const g = globalThis.__dshHanako;
    const t = g?.depTasks?.get(taskId) || null;
    if (!t) return c.json({ ok: false, error: "任务不存在" }, 404);
    return c.json({ ok: true, task: buildDepSnapshot(g, t) });
  });
}

function esc(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
