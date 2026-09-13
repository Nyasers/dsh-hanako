// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/provider-messages.test.mjs — DSH Message → hana messages 转换纯函数单测
import { test } from "node:test";
import assert from "node:assert/strict";
import { toHanaMessages, collectToolNames, isToolResultMessage } from "../src-cordis/plugins/provider/lib/messages.ts";

const HANA_ENVELOPE = {
  kind: "hana",
  version: 1,
  response: { provider: "deepseek", model: "m", requestId: "r1" },
  // blocks 与 assistant content 按序对齐（回放信封契约）
  blocks: [
    { signature: "sig-reason" },
    { textSignature: "sig-text-1" },
    { thoughtSignature: "sig-thought", id: "call-1" },
  ],
};

test("assistant 历史：文本/推理/tool-call → hana assistant content（签名保留）", () => {
  const msgs = [
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "思考" },
        { type: "text", text: "回答" },
        { type: "tool-call", id: "call-1", name: "read", arguments: '{"path":"a.txt"}' },
      ],
      source: { kind: "model", provider: "deepseek", model: "m", replayState: HANA_ENVELOPE },
    },
  ];
  const { messages } = toHanaMessages({ messages: msgs, images: null });
  assert.equal(messages.length, 1);
  const content = messages[0].content;
  assert.equal(content[0].type, "reasoning");
  assert.equal(content[0].reasoning, "思考");
  assert.equal(content[0].signature, "sig-reason");
  assert.equal(content[1].type, "text");
  assert.equal(content[1].textSignature, "sig-text-1");
  assert.equal(content[2].type, "toolCall");
  assert.deepEqual(content[2].arguments, { path: "a.txt" });
  assert.equal(content[2].thoughtSignature, "sig-thought");
});

test("tool-result 消息：拆为独立 toolResult（toolName 反查 + content 数组 + isError）", () => {
  const msgs = [
    { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "bash", arguments: "{}" }], source: { kind: "model", provider: "p", model: "m" } },
    { role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }], isError: false }], source: { kind: "tool", callId: "c1" } },
  ];
  const { messages } = toHanaMessages({ messages: msgs, images: null });
  assert.equal(messages.length, 2);
  const tr = messages[1];
  assert.equal(tr.role, "toolResult");
  assert.equal(tr.toolCallId, "c1");
  assert.equal(tr.toolName, "bash");
  assert.deepEqual(tr.content, [{ type: "text", text: "ok" }]);
  assert.equal(tr.isError, false);
});

test("用户纯文本/图片消息与 system 文本", () => {
  const images = new Map([["att-1", { data: "aGVsbG8=", mimeType: "image/png" }]]);
  const msgs = [
    { role: "system", content: [{ type: "text", text: "sys" }] },
    { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", attachment: { attachmentId: "att-1", mediaType: "image/png" } }] },
  ];
  const { messages, systemPrompt } = toHanaMessages({ messages: msgs, images });
  assert.equal(systemPrompt, "sys");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content.length, 2);
  assert.equal(messages[0].content[1].type, "image");
  assert.equal(messages[0].content[1].data, "aGVsbG8=");
});

test("图片块无解析字节 → UNSUPPORTED_CONTENT", () => {
  const msgs = [{ role: "user", content: [{ type: "image", attachment: { attachmentId: "att-x", mediaType: "png" } }] }];
  assert.throws(() => toHanaMessages({ messages: msgs, images: null }), (e) => e.code === "UNSUPPORTED_CONTENT");
});

test("助手 arguments 非法 JSON 回落 {}；collectToolNames/isToolResultMessage", () => {
  const msgs = [
    { role: "assistant", content: [{ type: "tool-call", id: "c2", name: "x", arguments: "{bad" }], source: { kind: "model", provider: "p", model: "m" } },
  ];
  const { messages } = toHanaMessages({ messages: msgs, images: null });
  assert.deepEqual(messages[0].content[0].arguments, {});
  const names = collectToolNames(msgs);
  assert.equal(names.get("c2"), "x");
  assert.equal(isToolResultMessage(msgs[0]), false);
});
