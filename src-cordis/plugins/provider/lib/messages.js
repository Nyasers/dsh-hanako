// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/plugins/provider/lib/messages.js — DSH llm Message[] → hana.models 消息（纯函数）
//
// 目标消息形状（迁移核对记录，host models.stream 逐消息校验）：
//   user      content: string | [{ type:"text", text } | { type:"image", data(base64),
//             mimeType }]
//   assistant content: [{ type:"text", text, textSignature? } | { type:"reasoning",
//             reasoning, signature?, redacted? } | { type:"toolCall", id, name,
//             arguments: OBJECT, thoughtSignature? }]
//   toolResult role:"toolResult" { toolCallId, toolName, isError, content: text/image[] }
// DSH 侧等价（@deepseek-ai/dsh-llm）：
//   user/assistant Message.content 是 ContentBlock[]（text/reasoning/image/tool-call/
//   tool-result）；tool 结果 = user 角色消息且 content 为 [ToolResultBlock{toolCallId,
//   content, isError}]；assistant 消息 source.replayState 是我们存的 'hana' 回放信封
//   （每块一个 metadata，见 lib/replay.js）。
// 转换纪律：DSH 文本/推理块原样搬进 hana 内容项；tool-call 的 arguments 是 JSON **字符串**，
// 需 parse 成对象（失败回落 {}）；tool-result 拆成独立 toolResult 消息（toolName 从同批
// 前置 assistant 的 tool-call 反查）；图片块必须已解析为 base64（images 参数），缺失抛错。
// 零依赖纯函数（node --test 可直接 import）。抛错带 .code 供 adapter 映射 LlmError。

export function isToolResultMessage(message) {
  return (
    message &&
    message.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((b) => b && b.type === "tool-result")
  );
}

/** 预扫描 assistant 消息的 tool-call 块：callId → toolName（toolResult 反查用）。 */
export function collectToolNames(messages) {
  const map = new Map();
  for (const m of messages || []) {
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === "tool-call" && typeof b.id === "string" && b.id) {
        map.set(b.id, typeof b.name === "string" ? b.name : "");
      }
    }
  }
  return map;
}

function parseArgumentsJson(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "object") return raw;
  try {
    const v = JSON.parse(String(raw));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * assistant 消息 → hana assistant content 项（含回放签名）。
 * @param {object} message DSH assistant Message
 * @returns {Array} hana assistant content 项
 */
export function assistantToHanaContent(message) {
  const blocks = Array.isArray(message && message.content) ? message.content : [];
  const replay =
    message &&
    message.source &&
    message.source.replayState &&
    typeof message.source.replayState === "object" &&
    message.source.replayState.kind === "hana"
      ? message.source.replayState
      : null;
  const metaBlocks = replay && Array.isArray(replay.blocks) ? replay.blocks : null;
  const out = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i];
    if (!b) continue;
    const meta = metaBlocks && metaBlocks[i] && typeof metaBlocks[i] === "object" ? metaBlocks[i] : null;
    if (b.type === "text") {
      const item = { type: "text", text: String(b.text ?? "") };
      if (meta && typeof meta.textSignature === "string" && meta.textSignature) {
        item.textSignature = meta.textSignature;
      }
      out.push(item);
    } else if (b.type === "reasoning") {
      const item = { type: "reasoning", reasoning: String(b.text ?? "") };
      if (meta && typeof meta.signature === "string" && meta.signature) {
        item.signature = meta.signature;
      }
      if (b.redacted === true) item.redacted = true;
      out.push(item);
    } else if (b.type === "tool-call") {
      const item = {
        type: "toolCall",
        id: String(b.id ?? ""),
        name: String(b.name ?? ""),
        arguments: parseArgumentsJson(b.arguments),
      };
      if (meta && typeof meta.thoughtSignature === "string" && meta.thoughtSignature) {
        item.thoughtSignature = meta.thoughtSignature;
      }
      out.push(item);
    }
    // 其余类型（image 等）在 assistant 侧为前向兼容，不转换
  }
  return out;
}

function normalizeImage(block, images) {
  const attId =
    block && block.attachment && typeof block.attachment.attachmentId === "string"
      ? block.attachment.attachmentId
      : null;
  const info = attId && images && images.get(attId) ? images.get(attId) : null;
  if (!info || typeof info.data !== "string" || typeof info.mimeType !== "string") {
    const err = new Error(
      "消息含图片块但未解析到图片字节（attachmentId=" + String(attId || "?") + "）；DSH→Hana 图片需要 attachment 服务解析（base64+MIME），本部署暂不可用",
    );
    err.code = "UNSUPPORTED_CONTENT";
    throw err;
  }
  return { type: "image", data: info.data, mimeType: info.mimeType };
}

function textBlockToHana(b) {
  return { type: "text", text: String(b.text ?? "") };
}

/**
 * DSH 消息数组 → hana models.stream 消息数组。
 * @param {object} o { messages: DSH Message[], images: Map<string,{data,mimeType}>|null }
 * @returns {{ messages: Array, systemPrompt?: string }}
 */
export function toHanaMessages({ messages, images }) {
  const list = Array.isArray(messages) ? messages : [];
  const toolNames = collectToolNames(list);
  const out = [];
  let systemPrompt = undefined;
  for (const m of list) {
    if (!m || typeof m.role !== "string") continue;
    if (m.role === "system") {
      const text = textOf(m);
      if (text) systemPrompt = (systemPrompt ? systemPrompt + "\n" : "") + text;
      continue;
    }
    if (m.role === "assistant") {
      const content = assistantToHanaContent(m);
      if (content.length > 0) out.push({ role: "assistant", content });
      continue;
    }
    // user（可能携带 tool-result / 文本 / 图片）
    if (m.role === "user") {
      const contentBlocks = Array.isArray(m.content) ? m.content : [];
      const textItems = [];
      const imageItems = [];
      for (const b of contentBlocks) {
        if (!b) continue;
        if (b.type === "tool-result") {
          if (textItems.length || imageItems.length) {
            // 与工具结果混排的纯文本：先落一条 user 消息
            out.push({ role: "user", content: [...textItems, ...imageItems] });
            textItems.length = 0;
            imageItems.length = 0;
          }
          const inner = Array.isArray(b.content) ? b.content : [];
          const resultContent = [];
          for (const ib of inner) {
            if (!ib) continue;
            if (ib.type === "image") resultContent.push(normalizeImage(ib, images));
            else if (ib.type === "text") resultContent.push(textBlockToHana(ib));
          }
          if (resultContent.length === 0) resultContent.push({ type: "text", text: "" });
          out.push({
            role: "toolResult",
            toolCallId: String(b.toolCallId ?? ""),
            toolName: toolNames.get(String(b.toolCallId ?? "")) || "tool",
            content: resultContent,
            isError: b.isError === true,
          });
          continue;
        }
        if (b.type === "image") {
          imageItems.push(normalizeImage(b, images));
          continue;
        }
        if (b.type === "text") {
          textItems.push(textBlockToHana(b));
        }
      }
      if (textItems.length || imageItems.length) {
        out.push({ role: "user", content: [...textItems, ...imageItems] });
      }
      continue;
    }
    // 其他角色：跳过
  }
  return { messages: out, systemPrompt };
}

function textOf(m) {
  const content = Array.isArray(m && m.content) ? m.content : [];
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}
