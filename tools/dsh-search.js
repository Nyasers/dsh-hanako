// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/dsh-search.js — dsh 跨会话内容搜索（只读）工具
// 调 dsh web host POST /api/session.search（client-request 信封，rpcId 回显校验）：
// payload { query }（trim 后 1~500 字符、不得含 NUL），响应 value { items: [{sessionId, snippet}], hasMore }。
// snippet ≤240 Unicode code points，最多 20 条。用途：Agent 按关键词搜历史会话内容，命中后用
// dsh_run 的 sessionId 参数 resume 该会话继续（上下文继承，知识复用）。只读查询，不改变任何会话。

function hostBase() {
  const g = globalThis.__dshHanako;
  const web = g?.web;
  if (!web?.ready || !web.port) throw new Error("dsh web host 未就绪（请先通过 dsh_run 提交任务拉起）");
  return `http://127.0.0.1:${web.port}`;
}

export const name = "dsh_search";

export const description =
  "跨会话搜索历史会话内容（session.search RPC）：给 query 关键词（1~500 字符，自动 trim），" +
  "返回命中的历史会话（sessionId + 内容摘要 snippet ≤240 字符，最多 20 条 + hasMore 指示是否还有更多）。" +
  "命中后可用 dsh_run 的 sessionId 参数 resume 该会话继续（上下文继承，知识复用）。" +
  "只读查询，不改变任何会话。";

export const parameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "搜索关键词（1~500 字符），会 trim；跨全部历史会话内容匹配",
    },
  },
  required: ["query"],
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "external_api",
    summary: "向 dsh web host 发起只读的跨会话内容搜索（session.search），查询 dsh 历史会话，不改变任何会话",
    ruleId: "dsh-hanako-search",
  }),
};

async function doExecute(input, ctx) {
  const query = String(input.query ?? "").trim();
  if (!query) throw new Error("query 必填（1~500 字符）");
  if (query.length > 500) throw new Error(`query 过长（${query.length} 字符，最多 500）`);
  if (query.includes("\0")) throw new Error("query 不得包含 NUL 字符");

  const base = hostBase();
  const rpcId = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${base}/api/session.search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId,
      method: "session.search",
      payload: { query },
    }),
  });
  if (!res.ok) throw new Error(`/api/session.search HTTP ${res.status}`);
  const full = await res.json();
  if (!full || full.rpcId !== rpcId) throw new Error("/api/session.search rpcId 不匹配");
  if (!full.result?.ok) {
    const e = full.result?.error || {};
    throw new Error(`dsh session.search 失败：${e.code || "unknown"} ${e.message || ""}`);
  }

  const value = full.result.value || {};
  const items = Array.isArray(value.items) ? value.items : [];
  const hasMore = !!value.hasMore;
  const count = items.length;

  if (count === 0) {
    return {
      content: [{ type: "text", text: `未找到匹配 "${query}" 的会话` }],
      details: { dsh: { query, count: 0, hasMore: false } },
    };
  }

  const maxSnippet = 240; // 与 host schema 对齐：snippet ≤240 Unicode code points（防御性再截断）
  const lines = items.map((item) => {
    const sessionId = String(item.sessionId ?? "").trim();
    let snippet = String(item.snippet ?? "");
    const chars = [...snippet];
    if (chars.length > maxSnippet) snippet = chars.slice(0, maxSnippet).join("") + "…";
    return `- ${sessionId}\n  ${snippet}`;
  });

  return {
    content: [
      {
        type: "text",
        text:
          `匹配 "${query}" 的历史会话（共 ${count} 条${hasMore ? "，还有更多" : ""}）：\n` +
          lines.join("\n") +
          "\n可用 dsh_run 的 sessionId 参数 resume 命中会话继续",
      },
    ],
    details: { dsh: { query, count, hasMore } },
  };
}

export async function execute(input, ctx) {
  try {
    return await doExecute(input, ctx);
  } catch (e) {
    ctx.log?.error?.("[dsh-hanako] dsh_search failed:", e?.stack || e?.message || String(e));
    throw e;
  }
}
