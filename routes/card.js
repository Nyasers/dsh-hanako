// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// routes/card.js — dsh-hanako 任务反馈卡片路由
//   GET /card/op?opId=&sessionId=&rpcId=&timeoutMs=  卡片页面（iframe 内容）
//   GET /ops/stream?sessionId=&rpcId=&timeoutMs=     SSE 推送源（卡片主链路：基线快照 + DSH 实时事件转发）
//   GET /ops/status?opId=&sessionId=&rpcId=          兜底状态 JSON（EventSource 建立失败时卡片回退一次；仅 jsonl 恢复路径）
//   GET /ops/output?opId=&sessionId=&rpcId=          兜底全量输出 JSON（兼容旧卡片懒加载；仅 jsonl 恢复路径）
//
// v0.10.46 架构改造：卡片链路从「HTTP 轮询 + op Map」改为「SSE 服务端推送 + jsonl 唯一事实源」。
// 三层：卡片（iframe EventSource）<-> 插件（routes 转发）<-> DSH（events.mux WebSocket）。
// 插件零任务状态：op Map 退役（tools/dsh-run.js 不再写任务快照），dsh 会话日志
// （<dataDir>/dsh-home/sessions/<cwd分组>/<sessionId>/session.jsonl.zstd）为唯一事实源。
// 每次 dsh_run 提交对应一个 user/message 事件（data.source.kind==user，
// data.source.rpcId == 插件 callUnary 生成的 rpcId），按 rpcId 精确命中后，
// 取该 user prompt 到下一个 user prompt（或文件尾）的事件窗口重建 op 快照。
// 卡片资源（app/card.css / app/card.js）每次请求读盘，改样式即时生效。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");

function readCardAssets() {
  return {
    css: fs.readFileSync(path.join(APP, "card.css"), "utf-8"),
    js: fs.readFileSync(path.join(APP, "card.js"), "utf-8"),
  };
}

// ---- 会话 jsonl 恢复（唯一事实源：op Map 退役后一切任务状态都从这里重建）----
// dsh 会话日志 = <dataDir>/dsh-home/sessions/<cwd分组>/<sessionId>/session.jsonl.zstd，
// 追加式多帧 zstd（每次 append 一帧，帧以 magic 28 B5 2F FD 开头）。
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 多帧 zstd 逐帧解压：dsh session.jsonl.zstd 每帧独立可解，返回事件数组（坏帧跳过）。 */
function decodeSessionLog(filePath) {
  const buf = fs.readFileSync(filePath);
  const starts = [];
  let i = 0;
  while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) { starts.push(i); i += 4; }
  const chunks = [];
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try { chunks.push(zstdDecompressSync(buf.subarray(starts[k], end))); } catch { /* 单帧损坏跳过 */ }
  }
  const events = [];
  for (const c of chunks) {
    for (const line of c.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
    }
  }
  return events;
}

/** 按 sessionId 定位会话日志文件（遍历 sessions/ 分组目录，不依赖 cwd 目录名编码）。 */
function sessionLogPath(dataDir, sessionId) {
  const sessionsRoot = path.join(dataDir, "dsh-home", "sessions");
  if (!fs.existsSync(sessionsRoot)) return null;
  for (const group of fs.readdirSync(sessionsRoot)) {
    const p = path.join(sessionsRoot, group, sessionId, "session.jsonl.zstd");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function textFromBlocks(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b && b.text) || "").join("");
  return "";
}

/** usage 累计（与 dsh-run 事件循环同口径：disjoint 四字段求和；缺失字段不初始化，API 未返回时不显示）。 */
function mergeUsage(acc, u) {
  if (!u) return acc;
  acc = acc || {};
  acc.inputTokens = (acc.inputTokens || 0) + (u.inputTokens ?? 0);
  acc.outputTokens = (acc.outputTokens || 0) + (u.outputTokens ?? 0);
  if (u.cacheReadTokens != null) acc.cacheReadTokens = (acc.cacheReadTokens || 0) + u.cacheReadTokens;
  if (u.reasoningTokens != null) acc.reasoningTokens = (acc.reasoningTokens || 0) + u.reasoningTokens;
  return acc;
}

/** 从会话 jsonl 按 rpcId 重建 op 快照（唯一事实源路径；运行中窗口无 turn/end → 归一化为 running 快照）。 */
function rebuildOpFromLog(dataDir, sessionId, rpcId) {
  const logPath = sessionLogPath(dataDir, sessionId);
  if (!logPath) return null;
  let events = [];
  try { events = decodeSessionLog(logPath); } catch { return null; }
  let header = null;
  const prompts = [];
  for (const ev of events) {
    if (ev.type === "session" && !header) header = ev;
    else if (ev.type === "user/message" && ev.data?.source?.kind === "user") prompts.push(ev);
  }
  const idx = prompts.findIndex((u) => u.data?.source?.rpcId === rpcId);
  if (idx < 0) return null;
  const prompt = prompts[idx];
  const startSeq = prompt.seq;
  const endSeq = idx + 1 < prompts.length ? prompts[idx + 1].seq : Infinity;
  const blockSeq = [];   // 结构化输出：按消息顺序收集 blocks（text/reasoning/tool-call），reasoning 可折叠
  let msgTexts = [];     // 纯文本拼接（outputLength/预览用 + 无 blocks 时兜底）
  let sawFinalFinish = false;
  let finalText = "";    // 最后一个 finish(reason.kind==stop) 之后的 assistant/message 文本 = 最终回答（摘要）
  let lastMsgText = "";
  let usage = null;
  let turnEnd = null;
  let lastErr = null;
  let modelCfg = null; // request/header 事件带实际模型配置（取窗口内首个）
  for (const ev of events) {
    if (ev.seq < startSeq || ev.seq >= endSeq) continue;
    if (ev.type === "assistant/chunk") {
      const c = ev.data?.chunk;
      if (c?.type === "finish" && c.reason?.kind === "stop") sawFinalFinish = true; // 工具循环结束的最终 LLM 调用
    } else if (ev.type === "assistant/message") {
      const blocks = Array.isArray(ev.data?.message?.content) ? ev.data.message.content : [];
      let msgText = "";
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string" && b.text) {
          blockSeq.push({ type: "text", text: b.text });
          msgText += b.text;
        } else if (b?.type === "reasoning" && typeof b.text === "string" && b.text) {
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
  const output = blockSeq.length ? "dsh-blocks-v1::" + JSON.stringify(blockSeq) : msgTexts.join("\n\n");
  const textLen = msgTexts.join("").length;
  const taskText = textFromBlocks(prompt.data?.content);
  const startedAt = new Date(prompt.time).toISOString();
  // v0.10.46：窗口无 turn/end = 任务未进入终态（仍在运行 / 重启时被杀）——
  // jsonl 唯一事实源语义：没有终态事件就是未完成，快照归一化为 running（部分输出），
  // 卡片据此保持运行态展示（SSE 实时事件随后接管；本地超时倒计时兜底）。
  if (!turnEnd) {
    return {
      opId: "recovered-" + rpcId,
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
  const isError = stopReason === "error" || stopReason === "aborted" || !!lastErr;
  return {
    opId: "recovered-" + rpcId,
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
    durationMs: turnEnd?.time != null ? Math.max(0, turnEnd.time - prompt.time) : null,
    stopReason,
    error: isError ? String(lastErr || stopReason) : undefined,
    summary: summaryText ? { text: summaryText, summaryOf: "final-message" } : null,
    usage,
    output,
    outputLength: textLen || output.length,
    outputPreview: output.slice(-1024), // 预览 1KB（v0.10.41：300→1KB，滚动摘要显示量更足）
    recovered: true,
  };
}

// 恢复缓存（按 rpcId，上限 20 条）：旧卡片轮询 stop 前会多次请求，避免重复解压大日志。
// v0.10.46：运行中快照不缓存——每次连接重建，避免断线重连拿到过期基线（运行中状态在 jsonl 里是增量事实）。
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

/** 取操作快照（v0.10.46：op Map 已退役，仅 jsonl 恢复路径；sessionId+rpcId 为定位键）。
 * 恢复快照补齐 timeoutMs：URL 携带（会话日志无该配置项），仅当快照无值时覆盖。
 * includeFull=true 时额外带全量 output（/ops/stream 基线需要）。 */
function readOp({ sessionId, rpcId, timeoutMs }, includeFull) {
  const g = globalThis.__dshHanako;
  if (!rpcId || !sessionId || !g?.dataDir) return null;
  const op = cachedRebuild(g.dataDir, String(sessionId), String(rpcId));
  if (!op) return null;
  if (op.timeoutMs == null && timeoutMs != null) op.timeoutMs = Number(timeoutMs) || null;
  let output = String(op.output ?? "");
  // 预览：结构化的 outputPreview 优先，否则 output 尾部（结构化 blocks 取 text 块文本）
  const isBlocks = output.indexOf("dsh-blocks-v1::") === 0;
  let previewText = output;
  if (!output && op.outputPreview != null) {
    previewText = String(op.outputPreview);
  } else if (isBlocks) {
    try {
      const blocks = JSON.parse(output.slice("dsh-blocks-v1::".length));
      previewText = blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("");
    } catch { /* 解析失败用原文 */ }
  }
  const snap = {
    opId: op.opId,
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
    outputPreview: previewText.slice(-1024), // 预览 1KB（v0.10.41：300→1KB，滚动摘要显示量更足）
    outputLength: op.outputLength ?? (isBlocks ? previewText.length : output.length),
  };
  if (includeFull) snap.output = output;
  return snap;
}

export default function registerCardRoutes(app, ctx) {
  const base = "/api/plugins/" + ctx.pluginId;

  // 卡片页（iframe 内容）：opId 参数（兼容旧卡片）+ sessionId/rpcId（重启恢复定位）
  app.get("/card/op", (c) => {
    const assets = readCardAssets();
    const opId = String(c.req.query("opId") || "");
    const sessionId = String(c.req.query("sessionId") || "");
    const rpcId = String(c.req.query("rpcId") || "");
    const timeoutMs = String(c.req.query("timeoutMs") || "");
    const hc = c.req.query("hana-css") || "";
    const th = c.req.query("hana-theme") || "inherit";
    const hcLink = hc ? `<link rel="stylesheet" href="${esc(hc)}">` : "";
    return c.html(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>dsh 任务</title>
${hcLink}
<style>${assets.css}<\/style>
</head>
<body data-hana-theme="${esc(th)}">
<div id="dsh-root" data-op="${esc(opId)}" data-session="${esc(sessionId)}" data-rpc="${esc(rpcId)}" data-timeout="${esc(timeoutMs)}"></div>
<script>window.__API="${base}";<\/script>
<script>${assets.js}<\/script>
</body>
</html>`);
  });

  // SSE 推送源（卡片主链路）：先推 baseline（jsonl 恢复快照，含全量 output），
  // 再对每个连接开一条到 DSH events.mux 的 WebSocket（openMux 同款），过滤
  // frame.sessionId === 本连接 sessionId 的帧，以 event 事件原样转发；连接关闭时关 WS。
  app.get("/ops/stream", (c) => {
    const sessionId = String(c.req.query("sessionId") || "");
    const rpcId = String(c.req.query("rpcId") || "");
    const timeoutMs = String(c.req.query("timeoutMs") || "");
    if (!sessionId || !rpcId) return c.json({ ok: false, error: "缺少 sessionId 或 rpcId" }, 400);
    const g = globalThis.__dshHanako;
    const baseline = readOp({ sessionId, rpcId, timeoutMs }, true);
    if (!baseline) return c.json({ ok: false, error: "任务记录不存在" }, 404);
    // web host 端口：单例优先（运行中 dsh web），否则配置兜底
    const web = g?.web;
    const port = web?.port || Number(ctx?.config?.webPort) || 3080;

    let ws = null;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const send = (name, data) => {
          if (closed) return;
          try { controller.enqueue(enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { /* 连接已断 */ }
        };
        const closeAll = () => {
          if (closed) return;
          closed = true;
          try { if (ws) ws.close(); } catch { /* 已关 */ }
          try { controller.close(); } catch { /* 已关 */ }
        };
        // a) 基线快照（jsonl 恢复；运行中窗口归一化为 running + 部分输出）
        send("baseline", baseline);
        // b) 转发 DSH 实时事件：events.mux WebSocket（与 tools/dsh-run.js openMux 同款连接）
        try {
          if (typeof WebSocket !== "function") throw new Error("宿主环境无全局 WebSocket，无法订阅 dsh 事件流");
          ws = new WebSocket(`ws://127.0.0.1:${port}/api/events.mux`);
          ws.onmessage = (ev) => {
            let frame = {};
            let envelope = null;
            try { envelope = JSON.parse(ev.data); frame = envelope?.payload || envelope || {}; } catch { return; }
            // server-request 信封（approval/requested 等应答类帧）：外层 rpcId 补进 frame
            if (envelope && typeof envelope === "object" && typeof envelope.rpcId === "string" && typeof frame.rpcId !== "string") {
              frame.rpcId = envelope.rpcId;
            }
            if (!frame || typeof frame.type !== "string") return;
            if (frame.sessionId && frame.sessionId !== sessionId) return; // 只转发本连接会话的帧
            send("event", frame);
          };
          ws.onerror = () => { /* 错误由 onclose 收尾 */ };
          ws.onclose = () => closeAll();
        } catch (e) {
          // WS 建立失败：基线已推送，结束流（卡片侧 EventSource 会自动重连 / 兜底 /ops/status）
          closeAll();
        }
      },
      cancel() {
        // 卡片断开（EventSource.close / 页面卸载）：关 WS 释放连接
        if (ws) { try { ws.close(); } catch { /* 已关 */ } }
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
  // 定位：sessionId+rpcId（新卡片）；opId-only 的旧卡片在 op Map 退役后无法恢复，返回 404。
  app.get("/ops/status", (c) => {
    const opId = String(c.req.query("opId") || "");
    const sessionId = String(c.req.query("sessionId") || "");
    const rpcId = String(c.req.query("rpcId") || "");
    const timeoutMs = String(c.req.query("timeoutMs") || "");
    if (!opId && !rpcId) return c.json({ ok: false, error: "缺少 opId 或 rpcId" }, 400);
    const op = readOp({ opId, sessionId, rpcId, timeoutMs });
    if (!op) return c.json({ ok: false, error: "任务记录不存在" }, 404);
    return c.json({ ok: true, op });
  });

  // 全量输出兜底拉取（兼容旧卡片懒加载；jsonl 恢复路径）
  app.get("/ops/output", (c) => {
    const opId = String(c.req.query("opId") || "");
    const sessionId = String(c.req.query("sessionId") || "");
    const rpcId = String(c.req.query("rpcId") || "");
    const timeoutMs = String(c.req.query("timeoutMs") || "");
    if (!opId && !rpcId) return c.json({ ok: false, error: "缺少 opId 或 rpcId" }, 400);
    const op = readOp({ opId, sessionId, rpcId, timeoutMs }, true);
    if (!op) return c.json({ ok: false, error: "任务记录不存在" }, 404);
    return c.json({ ok: true, opId: op.opId, output: op.output, outputLength: op.outputLength });
  });
}

function esc(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
