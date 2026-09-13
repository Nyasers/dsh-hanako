// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/plugins/provider/lib/stream.js — hana NDJSON 终态事件 → DSH llm StreamChunk
// （纯函数/状态机）
//
// DSH LlmAdapter.stream 契约（@deepseek-ai/dsh-llm types）：产出 StreamChunk 序列
//   block-start(index, blockType) → deltas(index) → block-end(index, 完整 block) →
//   usage → finish(reason, replayState?)；工具 arguments 保持 JSON **字符串**。
// hana NDJSON 事件（models.d.ts）：start/text-delta/reasoning-delta/tool-call/done/error；
// done.assistant 是完整可回放的 assistant 消息（含各块的 textSignature/signature/
// thoughtSignature 续接签名），stopReason ∈ stop|length|toolUse|deferred。
//
// 实现取舍（步骤 3）：文本增量**不**逐块实时转发，而是在 done 时按 done.assistant.content
// 顺序一次性产出完整块序列——done.assistant 是权威内容（含签名），以它为块序与 block-end
// 载荷最不会与流内 delta 拆分形态错位；DSH agent 循环对 chunk 的消费只在组装层（无实时
// 需求时等价）。真机验收后若要 DSH Web UI 实时打字，可在本模块状态机上增量 emit（扩展点，
// 见模块尾注释）。
// 零依赖纯函数（node --test 可直接 import）。

/** hana usage → llm TokenUsage（映射直通；输入侧 uncached 语义由宿主投影保证）。 */
export function usageToTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const out = {};
  if (typeof usage.input === "number") out.inputTokens = usage.input;
  if (typeof usage.output === "number") out.outputTokens = usage.output;
  if (typeof usage.totalTokens === "number") out.totalTokens = usage.totalTokens;
  if (typeof usage.cacheRead === "number") out.cacheReadTokens = usage.cacheRead;
  if (typeof usage.cacheWrite === "number") out.cacheWriteTokens = usage.cacheWrite;
  if (typeof usage.reasoning === "number") out.reasoningTokens = usage.reasoning;
  return Object.keys(out).length ? out : undefined;
}

function blockTypeOfItem(item) {
  if (item.type === "text") return "text";
  if (item.type === "reasoning") return "reasoning";
  if (item.type === "toolCall") return "tool-call";
  return null;
}

function blockContentOfItem(item) {
  if (item.type === "text") return { type: "text", text: String(item.text ?? "") };
  if (item.type === "reasoning") return { type: "reasoning", text: String(item.reasoning ?? "") };
  if (item.type === "toolCall") {
    let args = item.arguments;
    if (typeof args !== "string") {
      try {
        args = args === undefined || args === null ? "{}" : JSON.stringify(args);
      } catch {
        args = "{}";
      }
    }
    return { type: "tool-call", id: String(item.id ?? ""), name: String(item.name ?? ""), arguments: args };
  }
  return null;
}

function deltaOfItem(index, item) {
  if (item.type === "text") return { type: "text-delta", index, text: String(item.text ?? "") };
  if (item.type === "reasoning") return { type: "reasoning-delta", index, text: String(item.reasoning ?? "") };
  if (item.type === "toolCall") {
    let args = item.arguments;
    if (typeof args !== "string") {
      try {
        args = args === undefined || args === null ? "{}" : JSON.stringify(args);
      } catch {
        args = "{}";
      }
    }
    return { type: "tool-call-delta", index, id: String(item.id ?? ""), name: String(item.name ?? ""), argumentsDelta: args };
  }
  return null;
}

function blockMetaOfItem(item) {
  if (item.type === "text") return typeof item.textSignature === "string" && item.textSignature ? { textSignature: item.textSignature } : null;
  if (item.type === "reasoning") {
    const m = {};
    if (typeof item.signature === "string" && item.signature) m.signature = item.signature;
    if (item.redacted === true) m.redacted = true;
    return Object.keys(m).length ? m : null;
  }
  if (item.type === "toolCall") {
    const m = { id: String(item.id ?? "") };
    if (typeof item.thoughtSignature === "string" && item.thoughtSignature) m.thoughtSignature = item.thoughtSignature;
    return m;
  }
  return null;
}

/**
 * done 事件 → 完整 DSH chunk 序列（block-start/block-end/usage/finish）。
 * @param {object} o { doneEvent, provider, model, requestId }
 * @returns chunk 数组；内容为空且 stopReason=stop 抛错（code EMPTY_RESPONSE，adapter 映射）
 */
export function buildDoneChunks({ doneEvent, provider, model, requestId }) {
  const assistant = doneEvent && doneEvent.assistant && typeof doneEvent.assistant === "object" ? doneEvent.assistant : null;
  const content = assistant && Array.isArray(assistant.content) ? assistant.content : [];
  const stopReason = doneEvent && doneEvent.stopReason;
  if (content.length === 0 && stopReason === "stop") {
    const err = new Error("模型返回空响应（EMPTY_RESPONSE）");
    err.code = "EMPTY_RESPONSE";
    throw err;
  }
  const chunks = [];
  const blocks = [];
  let index = 0;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const blockType = blockTypeOfItem(item);
    if (!blockType) continue; // 未知内容类型跳过（forward-compat）
    const contentBlock = blockContentOfItem(item);
    const delta = deltaOfItem(index, item);
    chunks.push({ type: "block-start", index, blockType });
    if (delta) chunks.push(delta);
    chunks.push({ type: "block-end", index, block: contentBlock });
    blocks.push(blockMetaOfItem(item) || {});
    index += 1;
  }
  const usage = usageToTokenUsage(doneEvent && doneEvent.usage);
  if (usage) chunks.push({ type: "usage", usage });
  const reasonKind =
    stopReason === "toolUse" ? "tool-calls" : stopReason === "length" ? "max-tokens" : stopReason === "stop" ? "stop" : null;
  if (reasonKind === null) {
    // deferred 等非标准终态：宿主模型不应产出；交给调用方按失败处理
    const err = new Error("模型返回非标准终态（stopReason=" + String(stopReason) + "）");
    err.code = "MODEL_DEFERRED";
    throw err;
  }
  chunks.push({
    type: "finish",
    reason: { kind: reasonKind },
    replayState: {
      response: {
        kind: "hana",
        version: 1,
        provider,
        model,
        requestId,
        stopReason,
      },
      blocks,
    },
  });
  return chunks;
}
