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
// 实现取舍（2026-09-12 真机反馈后修改：**改成真流式**）：
//   原实现是「done 时一次性产出完整块序列」——`text-delta`/`reasoning-delta` 直接跳过。理由当时
//   是 done.assistant 权威、避免与流内拆分形态错位；代价是 DSH Web UI 看不到逐字输出（她指出
//   “没有流式传输”）。现在按本模块当时留的扩展点增量 emit：
//     · 过程：text-delta / reasoning-delta（契约字段是 **delta**，不是 text）→ block-start + 对应 delta，
//       按增量到达顺序分配 index，同类型连续增量共用一个 block；
//     · 终态：done 时仍由 buildDoneChunks 产出**权威** block-end（含 textSignature/signature/
//       thoughtSignature）、usage、finish——DSH assembler 里 block-end 的 block 是权威载荷
//       （`partial.block = chunk.block`，delta 只累积到 block-end 之前），所以这样既能实时打字，
//       又能拿到签名。已经流过 delta 的 index 只补 block-end，不再重复 block-start/delta。
//     · tool-call：仍只从 done 产出（增量事件没有可靠的“完成”信号，重复执行是真实风险——
//       指南 §4 亦明写“同一个 tool call 不要在收到事件和处理 done.assistant 时重复执行”）。
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
 * 增量状态机：hana NDJSON 的 text-delta / reasoning-delta → 立即可产的 DSH chunk。
 * 契约字段是 `delta`（AppModelTextDeltaEventV2 / AppModelReasoningDeltaEventV2）。
 * index 按增量**到达顺序**分配：同类型连续增量共用一块；类型切换就开新块。
 * 终态由 buildDoneChunks 收尾（权威 block-end + 签名），本状态机只负责过程。
 * @returns {{startedIndexes: Set<number>, push: (ev: object) => object[]}}
 */
export function createHanaStreamState() {
  const started = new Set();
  let current = null;
  let nextIndex = 0;
  return {
    get startedIndexes() {
      return started;
    },
    /** @returns chunk[]：这一步立刻要产出的（可能为空） */
    push(ev) {
      if (!ev || typeof ev !== "object") return [];
      if (ev.type !== "text-delta" && ev.type !== "reasoning-delta") return [];
      const delta = typeof ev.delta === "string" ? ev.delta : "";
      if (delta === "") return [];
      const blockType = ev.type === "text-delta" ? "text" : "reasoning";
      const out = [];
      if (current === null || current.type !== blockType) {
        current = { index: nextIndex, type: blockType };
        nextIndex += 1;
        started.add(current.index);
        out.push({ type: "block-start", index: current.index, blockType });
      }
      out.push({ type: ev.type, index: current.index, text: delta });
      return out;
    },
  };
}

/**
 * done 事件 → 完整 DSH chunk 序列（block-start/block-end/usage/finish）。
 * @param {object} o { doneEvent, provider, model, requestId, startedIndexes? }
 *   startedIndexes：已由增量状态机流过 delta 的 index 集合；这些 index 只补权威 block-end，
 *   不再重复 block-start/delta。
 * @returns chunk 数组；内容为空且 stopReason=stop 抛错（code EMPTY_RESPONSE，adapter 映射）
 */
export function buildDoneChunks({ doneEvent, provider, model, requestId, startedIndexes }) {
  const streamed = startedIndexes instanceof Set ? startedIndexes : null;
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
    if (streamed !== null && streamed.has(index)) {
      // 增量已经流过这一块：只补权威 block-end（签名与最终文本以它为准）
      chunks.push({ type: "block-end", index, block: contentBlock });
    } else {
      chunks.push({ type: "block-start", index, blockType });
      if (delta) chunks.push(delta);
      chunks.push({ type: "block-end", index, block: contentBlock });
    }
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
