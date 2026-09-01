// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/dsh-session.js — dsh 会话全生命周期工具（list/get/create/send/cancel）
// 继承 dsh_ops（清单）+ dsh_run（任务提交）+ dsh_cancel（取消）全部能力：
//   - list：解析 dsh 官方会话持久化缓存 <dataDir>/dsh-home/storages/session_projcache.json
//     （session-persistence 单元的 proj cache，含全部历史会话摘要）。纯本地文件读。
//   - get：凭 sessionId 直取会话内容——projcache 元数据 + summary（jsonl 最后一条
//     assistant/message 的 text，截断 ≤4000 字符）。
//   - create：新建会话 + 提交任务（原 dsh_run 无 sessionId 路径；task 必填）
//   - send：续已有会话发消息（原 dsh_run resume 路径；sessionId + task 必填）
//   - cancel：取消任务（原 dsh_cancel；sessionId 必填）
// create/send 复用 dsh-run.js 的 execute（提交主流程：submitTask + 事件流 + 卡片）；
// cancel 复用 dsh-cancel.js 的 execute。dsh-run/dsh-cancel 不再作为独立工具注册
// （index.js 移除），保留为内部模块供本工具调用。
// 权限模型：sessionId 即访问凭证——拿得到 id 即可 get/send/cancel。
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { textFromMessageBlocks } from "./lib/protocol.js";
import { execute as runExecute } from "./dsh-run.js";
import { execute as cancelExecute } from "./dsh-cancel.js";

const __here = dirname(fileURLToPath(import.meta.url));
// PLUGIN_ROOT 向上查找含 manifest.json 的目录——源码形态（tools/ 下）与
// rspack bundle 形态（dist/tools/ 下）都能正确定位插件根（与 tools/dsh-run.js 同款定位）。
let PLUGIN_ROOT = __here;
while (!existsSync(join(PLUGIN_ROOT, "manifest.json"))) {
  const parent = dirname(PLUGIN_ROOT);
  if (parent === PLUGIN_ROOT)
    throw new Error("无法定位插件根：向上未找到 manifest.json");
  PLUGIN_ROOT = parent;
}

export const name = "dsh_session";

export const description =
  "DSH 会话全生命周期工具（合并原 dsh_run / dsh_cancel）：list=会话清单（解析 session_projcache，dsh-home 唯一事实源，limit 默认 10）；" +
  "get=凭 sessionId 直取会话元数据 + 最终结论 summary；" +
  "create=新建会话 + 提交任务（task 必填，cwd 默认配置）；" +
  "send=续已有会话发消息（sessionId + task 必填，resume 语义）；" +
  "cancel=取消任务（sessionId 必填）。" +
  "权限模型：sessionId 即访问凭证。完整调用手册见 SKILL: skills/dsh-session/SKILL.md";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "get", "create", "send", "cancel"],
      description: "list=会话清单；get=凭 sessionId 取内容；create=新建会话+提交；send=续会话发消息；cancel=取消任务",
    },
    limit: {
      type: "integer",
      description: "仅 list 模式：返回条数（按 lastPromptAt 最新在前，取最近 N 条）：默认 10，有效范围 1~100，超出自动收敛到边界",
    },
    sessionId: {
      type: "string",
      description: "get/send/cancel 必传（形如 session-<uuid>，取自回调/卡片/ list 结果）：get=读取、send=续会话、cancel=取消",
    },
    task: {
      type: "string",
      description: "create/send 必传：任务描述/消息文本（create 新建会话首条，send 续会话消息）",
    },
    cwd: {
      type: "string",
      description: "仅 create：默认可写工作区目录（缺省用插件配置 defaultCwd）",
    },
    timeout: {
      type: "number",
      description: "仅 create/send：任务超时（秒），缺省用插件配置 defaultTimeoutSec",
    },
    agentPreset: {
      type: "string",
      description: "仅 create/send：agent 预设（standard/ptc/cordis/minimal）",
    },
    reasoningEffort: {
      type: "string",
      description: "仅 create/send：推理强度（off/high/max）",
    },
    provider: {
      type: "string",
      description: "仅 create/send：显式 provider（显式即成为 dsh 新默认）",
    },
    model: {
      type: "string",
      description: "仅 create/send：显式 model id（与 provider 一起传时覆盖 dsh 默认）",
    },
  },
  required: ["action"],
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "local_read",
    summary:
      "读取 DSH 会话持久化缓存 session_projcache.json 与会话 jsonl（zstd 容器本地解压，只读；dsh-home 唯一事实源，sessionId 即访问凭证）；create/send 经总线提交 dsh 任务、cancel 取消任务（写会话状态）",
    ruleId: "dsh-hanako-session",
  }),
};

// ---- list：会话清单（继承 dsh_ops 全部能力）----
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

// 读 + JSON.parse 整个 projcache：任何异常（文件不存在 / JSON 损坏 / 结构不符）返回 null，
// 由调用方按空清单处理，不抛错
function readSessionProjcache(dataDir) {
  const cachePath = join(dataDir, "dsh-home", "storages", "session_projcache.json");
  try {
    const j = JSON.parse(readFileSync(cachePath, "utf8"));
    const tbl = j?.tables?.sessions;
    if (tbl && typeof tbl === "object" && !Array.isArray(tbl)) return tbl;
  } catch {
    /* 数据源不可用：按空清单处理 */
  }
  return null;
}

// 遍历 tables.sessions（对象 map），每条映射摘要对象：字段存在才带（null 兜底）
function mapSessionItems(sessions) {
  const items = [];
  if (!sessions) return items;
  for (const [sessionId, s] of Object.entries(sessions)) {
    if (!s || typeof s !== "object") continue;
    const identity = s.identity || {};
    const rows = s.rows || {};
    const createdAt = identity.createdAt;
    const lastPromptAt = rows.sessionListMetadata?.val?.lastPromptAt ?? createdAt;
    const item = { sessionId, title: String(rows.title?.val ?? "") }; // title null → ""
    if (identity.cwd != null) item.cwd = identity.cwd;
    if (createdAt != null) item.createdAt = createdAt;
    if (lastPromptAt != null) item.lastPromptAt = lastPromptAt;
    const usage = rows.tokenUsage?.val?.totals;
    if (usage != null) item.usage = usage;
    const stats = rows.sessionStats?.val;
    if (stats != null) {
      if (stats.turns != null) item.turns = stats.turns;
      if (stats.steps != null) item.steps = stats.steps;
      if (stats.llmMs != null) item.llmMs = stats.llmMs;
    }
    items.push(item);
  }
  return items;
}

// ---- get：凭 sessionId 直取会话内容（jsonl zstd 多帧容器解压）----
// cwd-key 编码：cwd 绝对路径 → "--" + 路径段按 "-" 连接 + "--"（如 E:\Hanako\workspace →
// --E-Hanako-workspace--，与 dsh session-persistence 落盘目录命名一致）
function encodeCwdKey(cwd) {
  // cwd-key = "--" + 路径（去盘符冒号，分隔符换 "-"）+ "--"：E:\Hanako\workspace →
  // --E-Hanako-workspace--（与 dsh session-persistence 落盘目录命名一致）
  const clean = String(cwd ?? "").replace(":", "").replace(/[\\/]/g, "-");
  return "--" + clean + "--";
}

// 定位会话目录：优先按 projcache identity.cwd 猜编码，失败则遍历 sessions/ 下全部
// 子目录找 sessionId 同名目录。返回目录路径或 null。
function locateSessionDir(dataDir, sessionId, projSessions) {
  const sessionsRoot = join(dataDir, "dsh-home", "sessions");
  if (!existsSync(sessionsRoot)) return null;
  // 1) projcache 有该会话条目 → 按 identity.cwd 编码猜
  if (projSessions && projSessions[sessionId]) {
    const cwd = projSessions[sessionId]?.identity?.cwd;
    if (cwd) {
      const guess = join(sessionsRoot, encodeCwdKey(cwd), sessionId);
      if (existsSync(join(guess, "session.jsonl.zstd"))) return guess;
    }
  }
  // 2) 遍历全部 cwd-key 子目录找 sessionId 同名目录
  let found = null;
  try {
    for (const keyDir of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!keyDir.isDirectory()) continue;
      const cand = join(sessionsRoot, keyDir.name, sessionId);
      if (existsSync(join(cand, "session.jsonl.zstd"))) {
        found = cand;
        break;
      }
    }
  } catch {
    /* 遍历失败返回 null */
  }
  return found;
}

// zstd 多帧容器解压：dsh 逐批 append（每批一帧，帧 magic 0xFD2FB528），
// zstdDecompressSync 一次只解一帧，需按 magic 定位帧起点逐帧解压再拼接。
// 返回完整 jsonl 文本；解压失败返回 null（不抛 stack）。
function decompressZstdFrames(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); // 0xFD2FB528 小端字节序
  const frameStarts = [];
  for (let i = 0; i <= buf.length - 4; i++) {
    if (
      buf[i] === MAGIC[0] &&
      buf[i + 1] === MAGIC[1] &&
      buf[i + 2] === MAGIC[2] &&
      buf[i + 3] === MAGIC[3]
    )
      frameStarts.push(i);
  }
  if (frameStarts.length === 0) return null;
  const parts = [];
  try {
    for (let i = 0; i < frameStarts.length; i++) {
      const start = frameStarts[i];
      const end = i + 1 < frameStarts.length ? frameStarts[i + 1] : buf.length;
      parts.push(zstdDecompressSync(buf.subarray(start, end)).toString("utf8"));
    }
  } catch {
    return null;
  }
  return parts.join("");
}

// 解析 jsonl：逐行 JSON.parse（容错跳过坏行），返回最后一条 type==="assistant/message"
// 的文本（data.message.content 中 type==="text" 的 text 拼接，同 protocol.js
// textFromMessageBlocks 语义）。返回 { text, turns }。
function lastAssistantText(jsonlText) {
  let text = "";
  let turns = 0;
  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // 容错跳过坏行
    }
    if (obj?.type === "assistant/message") {
      const d = obj.data || {};
      if (d.turn != null) turns = Math.max(turns, Number(d.turn) || 0);
      const t = textFromMessageBlocks(d.message?.content);
      if (t) text = t; // 每条覆盖，结束时即最终汇报
    }
  }
  return { text, turns };
}

const SUMMARY_MAX = 4000; // summary 截断上限（超出加 …）

function truncateSummary(text) {
  const chars = [...text];
  if (chars.length <= SUMMARY_MAX) return text;
  return chars.slice(0, SUMMARY_MAX).join("") + "…";
}

async function doGet(input, ctx, g, dataDir, projSessions) {
  const sessionId = String(input.sessionId ?? "").trim();
  if (!sessionId) throw new Error("get 模式必须传 sessionId");
  // 校验 sessionId 格式（session-<UUID>，与 dsh session 创建方生成格式一致）：sessionId
  // 会拼入 locateSessionDir 的文件路径，非法值（路径分隔符 / 穿越段 / 畸形 id）可导致
  // 读取 sessions/ 之外的外部 session.jsonl.zstd——精确匹配 UUID 结构（8-4-4-4-12 hex），
  // 同时拒绝 session-abc / session--- 等畸形值；正则即锁死格式与长度，无需额外长度检查。
  if (!/^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    throw new Error(
      `sessionId 格式非法（应为 session-<UUID>）：${sessionId}`,
    );
  }

  // 定位会话目录（projcache 猜编码优先，失败遍历 sessions/ 全部子目录）
  const sessionDir = locateSessionDir(dataDir, sessionId, projSessions);
  if (!sessionDir) {
    return {
      ok: false,
      error: "找不到会话 " + sessionId + " 的日志文件（<dataDir>/dsh-home/sessions/ 下无对应目录），无法取会话内容",
      content: [
        {
          type: "text",
          text: "找不到会话 " + sessionId + " 的日志文件，无法取会话内容。可用 dsh_session action=list 查会话清单。",
        },
      ],
      details: { dsh: { action: "get", sessionId, ok: false } },
    };
  }

  // 解压 jsonl.zstd（多帧容器逐帧解压）
  let jsonlText = null;
  try {
    const buf = readFileSync(join(sessionDir, "session.jsonl.zstd"));
    jsonlText = decompressZstdFrames(buf);
  } catch {
    jsonlText = null;
  }
  if (jsonlText === null) {
    return {
      ok: false,
      error: "会话 " + sessionId + " 的日志文件解压失败（session.jsonl.zstd 损坏或格式异常）",
      content: [
        {
          type: "text",
          text: "会话 " + sessionId + " 的日志文件解压失败，无法取会话内容。可在 DSH Web UI（webPort）打开该会话查看。",
        },
      ],
      details: { dsh: { action: "get", sessionId, ok: false } },
    };
  }

  // 元数据（projcache 条目 → 同 list 字段；字段存在才带）
  const meta = { sessionId };
  const entry = projSessions?.[sessionId];
  if (entry) {
    const identity = entry.identity || {};
    const rows = entry.rows || {};
    if (identity.cwd != null) meta.cwd = identity.cwd;
    if (identity.createdAt != null) meta.createdAt = identity.createdAt;
    const lastPromptAt = rows.sessionListMetadata?.val?.lastPromptAt ?? identity.createdAt;
    if (lastPromptAt != null) meta.lastPromptAt = lastPromptAt;
    if (rows.title?.val != null) meta.title = String(rows.title.val);
    const usage = rows.tokenUsage?.val?.totals;
    if (usage != null) meta.usage = usage;
    const stats = rows.sessionStats?.val;
    if (stats != null) {
      if (stats.turns != null) meta.turns = stats.turns;
      if (stats.steps != null) meta.steps = stats.steps;
      if (stats.llmMs != null) meta.llmMs = stats.llmMs;
    }
  }

  const { text, turns } = lastAssistantText(jsonlText);
  const summary = truncateSummary(text || "（会话无最终文本汇报）");

  const textOut =
    "会话 " + sessionId + "（" + String(meta.title ?? "") + " · " + String(meta.cwd ?? "") + "）：\n" +
    "最终结论（" + turns + " turn）：\n" + summary;
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
        turns,
        meta,
      },
    },
  };
}

async function doExecute(input, ctx) {
  const g = globalThis.__dshHanako;
  const dataDir = g?.dataDir || join(PLUGIN_ROOT, "data");
  const action = String(input.action ?? "").trim();

  if (action === "list") {
    const limit = clampLimit(input.limit);
    // 会话清单以 dsh-home 为唯一事实源（session_projcache.json）；sessionId 即访问
    // 凭证——list 暴露的 id 即可 get/resume，拿不到 id 天然无所有权，无需额外注册表。
    const sessions = readSessionProjcache(dataDir);
    const items = mapSessionItems(sessions);
    // 排序：lastPromptAt 降序（最新在前；缺失时兜底 createdAt，仍缺失排最后）
    items.sort(
      (a, b) =>
        (b.lastPromptAt ?? b.createdAt ?? -Infinity) -
        (a.lastPromptAt ?? a.createdAt ?? -Infinity),
    );
    const top = items.slice(0, limit);
    if (top.length === 0) {
      return {
        content: [{ type: "text", text: "暂无 DSH 会话记录" }],
        details: { dsh: { action: "list", count: 0, limit } },
      };
    }
    const lines = top.map(
      (s) =>
        `${s.sessionId} · ${String(s.title).slice(0, 40)} · ${String(s.cwd ?? "")}`,
    );
    return {
      content: [
        {
          type: "text",
          text: `DSH 会话清单（共 ${items.length} 条，最新 ${top.length} 条）：\n${lines.join("\n")}`,
        },
      ],
      details: {
        dsh: { action: "list", count: items.length, limit, sessions: top },
      },
    };
  }

  if (action === "get") {
    const sessionId = String(input.sessionId ?? "").trim();
    if (!sessionId) throw new Error("get 模式必须传 sessionId");
    // projcache 只在需要时读一次（get 定位 cwd-key + 元数据共用）；
    // 权限模型：sessionId 即凭证——凭 id 在 dsh-home 存在即读，不存在报错（见 doGet）。
    const projSessions = readSessionProjcache(dataDir);
    return doGet(input, ctx, g, dataDir, projSessions);
  }

  if (action === "create" || action === "send") {
    const sessionId = String(input.sessionId ?? "").trim();
    if (action === "create" && sessionId)
      throw new Error("create 是新建会话，不允许传 sessionId（续会话请用 send）");
    if (action === "send" && !sessionId)
      throw new Error("send 必须传 sessionId（续已有会话；新建请用 create）");
    if (!String(input.task ?? "").trim())
      throw new Error(action + " 必须传 task（任务描述/消息文本）");
    // 复用 dsh-run 的 execute（提交主流程：submitTask + 事件流 + 卡片 + 审批接线）；
    // create 不传 sessionId（新建）、send 传 sessionId（resume 语义）。
    return runExecute(input, ctx);
  }

  if (action === "cancel") {
    const sessionId = String(input.sessionId ?? "").trim();
    if (!sessionId) throw new Error("cancel 必须传 sessionId");
    return cancelExecute(input, ctx);
  }

  throw new Error(`action 必须是 list / get / create / send / cancel（收到 "${action}"）`);
}

export async function execute(input, ctx) {
  try {
    return await doExecute(input, ctx);
  } catch (e) {
    ctx.log?.error?.(
      "[dsh-hanako] dsh_session failed:",
      e?.stack || e?.message || String(e),
    );
    throw e;
  }
}
