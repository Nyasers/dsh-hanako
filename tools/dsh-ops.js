// tools/dsh-ops.js — dsh 会话清单查询（只读）工具
// 直接解析 dsh web host 的会话持久化缓存 <dataDir>/dsh-home/storages/session_projcache.json
// （dsh 官方 session-persistence 单元的 proj cache，含全部历史会话摘要：标题/cwd/创建时间/
// 最近提示时间/token usage/会话统计）。不再读插件内存 op 快照、不再使用 ops.jsonl 记录/恢复历史；
// 历史会话由 dsh 侧持久化，因此重启后仍可查。
// 纯本地文件读，不调 dsh web host /api，sessionPermission 描述为只读（无副作用）。
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __here = dirname(fileURLToPath(import.meta.url));
// v0.6.0: PLUGIN_ROOT 向上查找含 manifest.json 的目录——源码形态（tools/ 下）与
// rspack bundle 形态（dist/tools/ 下）都能正确定位插件根（与 tools/dsh-run.js 同款定位）。
let PLUGIN_ROOT = __here;
while (!existsSync(join(PLUGIN_ROOT, "manifest.json"))) {
  const parent = dirname(PLUGIN_ROOT);
  if (parent === PLUGIN_ROOT) throw new Error("无法定位插件根：向上未找到 manifest.json");
  PLUGIN_ROOT = parent;
}

export const name = "dsh_ops";

export const description =
  "查询 dsh 会话清单与摘要（解析 dsh 官方会话持久化缓存 session_projcache.json，dsh 侧持久化、重启后仍可查）：" +
  "按最近提示时间（lastPromptAt）最新在前，limit 控制返回条数（默认 10，有效范围 1~100）。" +
  "返回 sessionId/标题/cwd/创建时间/最近提示时间/token usage/会话统计（turns/steps/llmMs），供对账与回溯。" +
  "需要按内容搜索历史会话用 dsh_search（命中拿 sessionId 再 resume）";

export const parameters = {
  type: "object",
  properties: {
    limit: {
      type: "integer",
      description: "返回条数（按 lastPromptAt 最新在前，取最近 N 条）：默认 10，有效范围 1~100，超出自动收敛到边界",
    },
  },
  required: [],
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "local_read",
    summary: "读取 dsh 会话持久化缓存 session_projcache.json（dsh 官方 proj cache，本地只读）",
    ruleId: "dsh-hanako-ops",
  }),
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

async function doExecute(input, ctx) {
  const g = globalThis.__dshHanako;
  const dataDir = g?.dataDir || join(PLUGIN_ROOT, "data");
  const cachePath = join(dataDir, "dsh-home", "storages", "session_projcache.json");
  const limit = clampLimit(input.limit);

  // 读 + JSON.parse 整个文件：任何异常（文件不存在 / JSON 损坏 / 结构不符）返回空结果，不抛错
  let sessions = null;
  try {
    const j = JSON.parse(readFileSync(cachePath, "utf8"));
    const tbl = j?.tables?.sessions;
    if (tbl && typeof tbl === "object" && !Array.isArray(tbl)) sessions = tbl;
  } catch { /* 数据源不可用：按空清单处理 */ }

  // 遍历 tables.sessions（对象 map），每条映射摘要对象：字段存在才带（null 兜底）
  const items = [];
  if (sessions) {
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
  }

  // 排序：lastPromptAt 降序（最新在前；缺失时兜底 createdAt，仍缺失排最后）
  items.sort((a, b) => (b.lastPromptAt ?? -Infinity) - (a.lastPromptAt ?? -Infinity));
  const top = items.slice(0, limit);

  if (top.length === 0) {
    return {
      content: [{ type: "text", text: "暂无 dsh 会话记录" }],
      details: { dsh: { count: 0, limit } },
    };
  }

  const lines = top.map((s) => `${s.sessionId} · ${String(s.title).slice(0, 40)} · ${String(s.cwd ?? "")}`);
  return {
    content: [
      { type: "text", text: `dsh 会话清单（共 ${items.length} 条，最新 ${top.length} 条）：\n${lines.join("\n")}` },
    ],
    details: { dsh: { count: items.length, limit, sessions: top } },
  };
}

export async function execute(input, ctx) {
  try {
    return await doExecute(input, ctx);
  } catch (e) {
    ctx.log?.error?.("[dsh-hanako] dsh_ops failed:", e?.stack || e?.message || String(e));
    throw e;
  }
}
