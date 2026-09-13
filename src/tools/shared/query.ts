// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/shared/query.ts — dshana 的 list/get 只读查询实现（官方会话查询面）
//
// 注意：这是共享**实现**，不是操作模块（actions/ 里每个文件 = 一个同名 subcommand）。
// 消费方：actions/get.ts（已注册）、actions/list.ts（暂未注册）。
//
// 取数走官方查询面：不读 <DSH_HOME>/storages/session_projcache.json，也不解
// <DSH_HOME>/sessions/**/session.jsonl.zstd（日志已到 V3，projcache 行结构与 zstd 多帧容器
// 都是自家猜测的实现细节，读取交回官方）：
//   · list → session/list（一元）。items[].projections.values 带 title / sessionStats /
//            tokenUsage（投影缓存折叠的结果），items[].projections.asOfSeq 是折叠到的 seq。
//   · get  → session/list 取该会话的 asOfSeq（= 当前日志 tip；真机实测：写一条事件后
//            asOfSeq 与事件 seq 精确一致，且 page(asOfSeq+1) 被拒 "past cursor N"），
//            再用 session/page 在该 cut 上取尾部一窗按消息对齐的 records。
//   · session/follow（开场快照也带 records）是**流方法**，一元 POST 会被网关拒：
//     gateway/signature-invalid "stream Remote methods must be opened through the stream carrier"
//     ——载体是 WS mux（dsh-api-gateway 的 /api/remote.mux）。不为一次读去接 mux，故不依赖它。
//
// get 取数规则：一次 create/send = 一次 prompt = 一轮。以**最后一次 user/message**
// 为轮次边界，取该轮**最后一次 assistant/message 输出**即最终结论；本轮还没产出输出就明确报状态，
// 不悄悄把上一轮的旧结论当本轮结果（真取了更早的也会在正文里标出来，见 lastRoundOutput 的 scope）。
// 已知窄窗口：list 拿到 asOfSeq 与 page 取数之间若有新写入，读到的是 asOfSeq 那一刻的尾部——
// 单写者锁下这个窗口只有毫秒级，且 get 的语义本就是"回看最近一轮"，接受。
//
// 代价（已接受）：list/get 从此要求受管 runtime 就绪（未就绪先 ensureManagedRuntime），
// 不再有"离线直读文件"这条路。换来的是格式演进由官方承担。
//
// 权限模型：sessionId 即访问凭证——拿得到 id 就能读，拿不到天然无所有权，无需注册表。
import { ensureManagedRuntime } from "../../lib/managed-runtime.ts";
import { rpcViaControl } from "../../lib/controller.ts";
import type { ToolResult } from "../../types/tool.ts";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const SUMMARY_MAX = 4000; // summary 截断上限（超出加 …）
// 尾部窗口消息数：够装下"最后一轮"（prompt + 若干工具往返 + 收尾汇报）
const GET_MAX_MESSAGES = 40;

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

/** 受管 runtime 就绪（单例；未起则启动到 ready）。失败时给可读原因。 */
async function ensureReady() {
  try {
    return await ensureManagedRuntime({});
  } catch (e) {
    throw new Error("DSH 受管运行时未就绪（会话查询需要它在线）：" + ((e && e.message) || e));
  }
}

// ---------- 纯函数（导出供单测） ----------

/** 一条记录里的事件载荷；非持久事件（assistant-stream 帧等）返回 null。 */
function eventOf(record) {
  if (!record || typeof record !== "object") return null;
  if (record.type === "event" && record.event && typeof record.event === "object") return record.event;
  return null;
}

/** 消息块取文本（AssistantMessage.content 中 type==="text" 的 text 拼接）。 */
export function textFromMessageBlocks(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

/**
 * 从（page 尾部窗口的）records 里取"本轮最后一次 assistant 输出"。
 * 轮次边界 = 最后一次 user/message（不区分直人 prompt 与合成注入：真机上同一轮里
 * user/message 会出现两次——人写 prompt + 运行时上下文注入，但都排在本轮输出之前，
 * 故"最后一次 user/message 之后的 assistant 输出"就是本轮输出）。
 * 返回 { text, turn, interrupted, scope, error }：
 *   scope = "round"   取到的是最后一次 user 消息之后的输出（正常路径）
 *           "earlier" 最后一次 user 消息之后还没有输出 → 退到更早的最近输出（调用方必须标出）
 *           "window"  窗口内根本没有 user 消息 → 退到窗口内最后的输出
 *           "none"    窗口内没有任何 assistant/message（会话无最终文本汇报）
 *   error = 本轮以错误结束时的 { message, code }（真机实测：模型失败时 DSH 写
 *           assistant/attempt + turn/end{reason:{kind:'error'}}，此时没有 assistant/message，
 *           只有把错误透出来，调用方才能说清"为什么没结论"）
 */
export function lastRoundOutput(records) {
  const list = Array.isArray(records) ? records : [];
  const assistant = [];
  const turnErrors = new Map(); // turn → { message, code }（只记 reason.kind==='error'）
  let lastUserIndex = -1;
  list.forEach((rec, i) => {
    const ev = eventOf(rec);
    if (!ev) return;
    if (ev.type === "user/message") {
      lastUserIndex = i;
      return;
    }
    if (ev.type === "turn/end") {
      const d = (ev.data && typeof ev.data === "object") ? ev.data : {};
      const reason = d.reason;
      if (reason && reason.kind === "error" && reason.error) {
        turnErrors.set(Number(d.turn) || 0, {
          message: String(reason.error.message ?? ""),
          code: reason.error.code ? String(reason.error.code) : undefined,
        });
      }
      return;
    }
    if (ev.type !== "assistant/message") return;
    const d = (ev.data && typeof ev.data === "object") ? ev.data : {};
    assistant.push({
      index: i,
      text: textFromMessageBlocks(d.message && d.message.content),
      turn: Number(d.turn) || 0,
      interrupted: d.interrupted === true,
    });
  });

  const lastError = turnErrors.size > 0 ? [...turnErrors.values()][turnErrors.size - 1] : null;
  if (assistant.length === 0) {
    return { text: "", turn: 0, interrupted: false, scope: "none", error: lastError };
  }

  const inRound = lastUserIndex >= 0 ? assistant.filter((a) => a.index > lastUserIndex) : [];
  const pool = inRound.length > 0 ? inRound : assistant;
  const scope = inRound.length > 0 ? "round" : (lastUserIndex >= 0 ? "earlier" : "window");

  // 最后一次 assistant 输出可能是纯工具调用步（无 text）——同轮内往前找最近一次有文本的；
  // 整轮都没文本时保留最后一次（由调用方按"本轮无文本输出"表述）。
  let picked = pool[pool.length - 1];
  for (let i = pool.length - 1; i >= 0; i--) {
    if (pool[i].text) { picked = pool[i]; break; }
  }
  // 只报"被展示的那一轮"的错误，不把更早轮次的失败当前一轮的结论。
  const pickedError = turnErrors.get(picked.turn) || null;
  return { text: picked.text, turn: picked.turn, interrupted: picked.interrupted, scope, error: pickedError || null };
}

/** 标题事件识别：data 带非空 title，且 source.kind 是 fallback/provider/user 三者之一。 */
function isTitleEventData(data) {
  if (!data || typeof data !== "object") return false;
  if (typeof data.title !== "string" || !data.title) return false;
  const kind = data.source && data.source.kind;
  return kind === "fallback" || kind === "provider" || kind === "user";
}

/** 标题：优先取 list 投影（providers 折叠出的 values.title），退回日志里的标题事件。 */
export function titleFromRecords(records) {
  const list = Array.isArray(records) ? records : [];
  let title = "";
  for (const rec of list) {
    const ev = eventOf(rec);
    if (ev && isTitleEventData(ev.data)) title = ev.data.title; // 末尾覆盖 = 最新
  }
  return title;
}

export function titleFromProjections(summary) {
  const values = summary && summary.projections && summary.projections.values;
  if (!values || typeof values !== "object") return "";
  return typeof values.title === "string" ? values.title : "";
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 官方列表摘要 → 我们的清单条目（字段存在才带）。 */
export function mapSummary(s) {
  const src = s && typeof s === "object" ? s : {};
  const proj = src.projections && typeof src.projections === "object" ? src.projections : null;
  const values = proj && proj.values && typeof proj.values === "object" ? proj.values : null;
  const item = {
    sessionId: String(src.sessionId ?? ""),
    title: titleFromProjections(src),
    cwd: typeof src.cwd === "string" ? src.cwd : "",
    running: src.running === true,
    blank: src.blank === true,
  };
  const updatedAt = num(src.updatedAt);
  if (updatedAt !== null) item.updatedAt = updatedAt;
  const asOfSeq = num(proj && proj.asOfSeq);
  if (asOfSeq !== null) item.asOfSeq = asOfSeq;
  if (values) {
    const lastPromptAt = num(values.sessionListMetadata && values.sessionListMetadata.lastPromptAt);
    if (lastPromptAt !== null) item.lastPromptAt = lastPromptAt;
    const stats = values.sessionStats;
    if (stats && typeof stats === "object") {
      const turns = num(stats.turns);
      const steps = num(stats.steps);
      const llmMs = num(stats.llmMs);
      item.turns = turns === null ? 0 : turns;
      item.steps = steps === null ? 0 : steps;
      item.llmMs = llmMs === null ? 0 : llmMs;
    }
    const usage = values.tokenUsage;
    if (usage && typeof usage === "object") item.usage = usage;
  }
  return item;
}

function truncateSummary(text) {
  const chars = [...String(text ?? "")];
  if (chars.length <= SUMMARY_MAX) return String(text ?? "");
  return chars.slice(0, SUMMARY_MAX).join("") + "…";
}

// ---------- 官方读面 ----------

/** session/list → 全部清单条目。 */
async function listSummaries(ctx) {
  const value = await rpcViaControl(ctx, { method: "session/list", payload: {}, timeoutMs: 30000 });
  const raw = value && Array.isArray(value.items) ? value.items : [];
  return raw.map(mapSummary).filter((s) => s.sessionId);
}

/** 目标会话的清单条目（含 asOfSeq 与投影元数据）。找不到返回 null。 */
async function findSummary(ctx, sessionId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const found = (await listSummaries(ctx)).find((s) => s.sessionId === sessionId) || null;
    if (found) return found;
  }
  return null;
}

// ---------- 操作实现 ----------

async function doList(input, ctx) {
  const limit = clampLimit(input.limit);
  await ensureReady();
  const items = await listSummaries(ctx);
  // 官方 list 无"条数"入参（SessionListRequest 只有 cursor），返回的 items 视为一次全量；
  // 展示条数由我们这侧按 limit 截断（最新在前）。
  items.sort(
    (a, b) => (b.lastPromptAt ?? b.updatedAt ?? -Infinity) - (a.lastPromptAt ?? a.updatedAt ?? -Infinity),
  );
  const top = items.slice(0, limit);
  if (top.length === 0) {
    return {
      content: [{ type: "text", text: "暂无 DSH 会话记录" }],
      details: { dsh: { action: "list", count: 0, limit } },
    };
  }
  const lines = top.map(
    (s) => `${s.sessionId} · ${String(s.title).slice(0, 40)} · ${String(s.cwd ?? "")}`,
  );
  return {
    content: [
      {
        type: "text",
        text: `DSH 会话清单（共 ${items.length} 条，最新 ${top.length} 条）：\n${lines.join("\n")}`,
      },
    ],
    details: { dsh: { action: "list", count: items.length, limit, sessions: top } },
  };
}

async function doGet(input, ctx) {
  const sessionId = String(input.sessionId ?? "").trim();
  if (!sessionId) throw new Error("get 模式必须传 sessionId");
  // sessionId 格式锁死（session-<UUID>，与 dsh 生成格式一致）：畸形值直接拒，
  // 不把垃圾 id 送到 DSH（旧实现还靠它防路径穿越，本实现已不拼文件路径，格式闸保留）。
  if (!/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error(`sessionId 格式非法（应为 session-<UUID>）：${sessionId}`);
  }

  await ensureReady();

  const notFound = (extra) => ({
    ok: false,
    error: "找不到会话 " + sessionId + "（" + extra + "）",
    content: [
      {
        type: "text",
        text: "找不到会话 " + sessionId + " 的内容（" + extra + "）。可用 dshana action=list 查会话清单。",
      },
    ],
    details: { dsh: { action: "get", sessionId, ok: false } },
  });

  let item = null;
  let page = null;
  try {
    item = await findSummary(ctx, sessionId);
    if (!item) return notFound("会话列表中无此 id");
    if (typeof item.asOfSeq !== "number") {
      return notFound("会话投影未提供读位点（asOfSeq）");
    }
    page = await rpcViaControl(ctx, {
      method: "session/page",
      payload: { address: { kind: "session", sessionId }, throughSeq: item.asOfSeq, maxMessages: GET_MAX_MESSAGES },
      timeoutMs: 30000,
    });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    return {
      ok: false,
      error: "会话 " + sessionId + " 查询失败：" + msg,
      content: [
        {
          type: "text",
          text: "会话 " + sessionId + " 查询失败（" + msg + "）。可用 dshana action=list 确认会话仍在，或稍后重试。",
        },
      ],
      details: { dsh: { action: "get", sessionId, ok: false } },
    };
  }

  const records = page && Array.isArray(page.records) ? page.records : [];
  const meta = { sessionId };
  if (item.cwd) meta.cwd = item.cwd;
  if (typeof item.updatedAt === "number") meta.updatedAt = item.updatedAt;
  if (typeof item.lastPromptAt === "number") meta.lastPromptAt = item.lastPromptAt;
  const title = item.title || titleFromRecords(records);
  if (title) meta.title = title;
  if (typeof item.turns === "number") meta.turns = item.turns;
  if (typeof item.steps === "number") meta.steps = item.steps;
  if (typeof item.llmMs === "number") meta.llmMs = item.llmMs;
  if (item.usage) meta.usage = item.usage;

  const { text, turn, interrupted, scope, error } = lastRoundOutput(records);
  const summary = truncateSummary(text || "（会话无最终文本汇报）");
  meta.scope = scope;
  meta.asOfSeq = item.asOfSeq;
  meta.recordCount = records.length;
  if (page.hasMore === true) meta.hasMore = true;
  if (error) meta.error = error;

  // 口径提示：不让"更早的结论"冒充本轮结果；被中断的轮次、以错误结束的轮次都标出来。
  const notes = [];
  if (scope === "earlier") notes.push("最后一次 user 消息之后暂无 assistant 输出，以下为更早的最近结论");
  if (scope === "window") notes.push("窗口内未出现 user 消息，以下为窗口内最后的 assistant 输出");
  if (interrupted) notes.push("该轮被中断，以上是中断前已产出的文本");
  if (error) notes.push("本轮以错误结束" + (error.code ? "（" + error.code + "）" : "") + "：" + error.message);
  if (page.hasMore === true) notes.push("该会话还有更早的轮次未读取（需要时走 session/page 向前翻）");

  const textOut =
    "会话 " + sessionId + "（" + String(meta.title ?? "") + " · " + String(meta.cwd ?? "") + "）：\n" +
    "最终结论（" + turn + " turn）：\n" + summary +
    (notes.length ? "\n（" + notes.join("；") + "）" : "");
  return {
    ok: true,
    content: [{ type: "text", text: textOut }],
    details: {
      dsh: {
        action: "get",
        sessionId,
        ok: true,
        summary,
        summaryLength: summary.length,
        turns: turn,
        interrupted,
        scope,
        error: error || null,
        meta,
      },
    },
  };
}

// query 操作入口（session.js 按 action=list/get 路由到本模块）：只读查询，经控制面走官方面
export async function execute(input, ctx): Promise<ToolResult> {
  const action = String(input.action ?? "").trim();
  if (action === "list") return doList(input, ctx);
  if (action === "get") return doGet(input, ctx);
  throw new Error(`query 操作只处理 list / get（收到 "${action}"）`);
}
