// routes/card.js — dsh-hanako 任务反馈卡片路由
//   GET /card/op?opId=xxx   卡片页面（iframe 内容：轮询状态 + 渲染任务详情）
//   GET /ops/status?opId=xxx 任务状态 JSON（卡片轮询源；瘦身快照：摘要 + 尾部预览）
//   GET /ops/output?opId=xxx 全量输出 JSON（卡片懒加载完整输出）
//
// 机制：与 download-progress / hana-remote-dev 同构——工具返回时挂 details.card
// { route: "/card/op?opId=xxx" }，宿主把 route 渲染成 iframe 卡片。卡片轮询
// /ops/status 获取任务快照（running → ok/error，含耗时 / 摘要区 / 完整输出懒加载）。
// 操作注册表在 tools/dsh-run.js 的 globalThis.__dshHanako.ops（跨加载实例共享）。
// 卡片资源（app/card.css / app/card.js）每次请求读盘，改样式即时生效。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");

function readCardAssets() {
  return {
    css: fs.readFileSync(path.join(APP, "card.css"), "utf-8"),
    js: fs.readFileSync(path.join(APP, "card.js"), "utf-8"),
  };
}

/** 取操作快照。includeFull=true 时额外带全量 output；否则返回瘦身快照
 * （摘要 + 输出尾部 600 字符预览，PTC 式压缩：中间步骤不进轮询体）。 */
function readOp(opId, includeFull) {
  const g = globalThis.__dshHanako;
  if (!g || !g.ops) return null;
  const op = g.ops.get(String(opId || ""));
  if (!op) return null;
  const output = String(op.output ?? "");
  const snap = {
    opId: op.opId,
    task: op.task || "",
    cwd: op.cwd || "",
    timeoutMs: op.timeoutMs ?? null,
    status: op.status, // running | ok | error
    startedAt: op.startedAt,
    durationMs: op.durationMs,
    stopReason: op.stopReason,
    error: op.error,
    summary: op.summary ?? null, // { text, summaryOf, fullLength } | null
    usage: op.usage ?? null, // DeepSeek adapter usage { inputTokens, outputTokens, cacheReadTokens, reasoningTokens } | null
    outputPreview: output.slice(-600), // 最终结论在尾部；运行中尾部即最新产出
    outputLength: output.length,
  };
  if (includeFull) snap.output = output;
  return snap;
}

export default function registerCardRoutes(app, ctx) {
  const base = "/api/plugins/" + ctx.pluginId;

  // 卡片页（iframe 内容）：opId 参数 + 宿主注入的主题样式（同 download-progress 机制）
  app.get("/card/op", (c) => {
    const assets = readCardAssets();
    const opId = String(c.req.query("opId") || "");
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
<div id="dsh-root" data-op="${esc(opId)}"></div>
<script>window.__API="${base}";<\/script>
<script>${assets.js}<\/script>
</body>
</html>`);
  });

  // 状态轮询源（瘦身快照：摘要 + 尾部预览，不带全量输出）
  app.get("/ops/status", (c) => {
    const opId = String(c.req.query("opId") || "");
    if (!opId) return c.json({ ok: false, error: "缺少 opId" }, 400);
    const op = readOp(opId);
    if (!op) return c.json({ ok: false, error: "任务记录不存在" }, 404);
    return c.json({ ok: true, op });
  });

  // 全量输出拉取（卡片懒加载：摘要区展开完整输出时才请求）
  app.get("/ops/output", (c) => {
    const opId = String(c.req.query("opId") || "");
    if (!opId) return c.json({ ok: false, error: "缺少 opId" }, 400);
    const op = readOp(opId, true);
    if (!op) return c.json({ ok: false, error: "任务记录不存在" }, 404);
    return c.json({ ok: true, opId, output: op.output, outputLength: op.outputLength });
  });
}

function esc(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
