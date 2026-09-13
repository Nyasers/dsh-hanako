// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/provider-stream.test.mjs — done 事件 → DSH chunks 纯函数单测
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDoneChunks, usageToTokenUsage } from "../src-cordis/plugins/provider/lib/stream.js";

test("done(纯文本) → block-start/text-delta/block-end/usage/finish(stop)+回放信封", () => {
  const chunks = buildDoneChunks({
    doneEvent: {
      requestId: "r1",
      stopReason: "stop",
      usage: { input: 10, output: 5, totalTokens: 15, cacheRead: 2 },
      assistant: { role: "assistant", content: [{ type: "text", text: "hi", textSignature: "s1" }] },
    },
    provider: "deepseek",
    model: "m1",
    requestId: "r1",
  });
  assert.equal(chunks[0].type, "block-start");
  assert.equal(chunks[0].index, 0);
  assert.equal(chunks[0].blockType, "text");
  assert.deepEqual(chunks[1], { type: "text-delta", index: 0, text: "hi" });
  assert.deepEqual(chunks[2].block, { type: "text", text: "hi" });
  const usage = chunks.find((c) => c.type === "usage");
  assert.deepEqual(usage.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 2 });
  const finish = chunks.find((c) => c.type === "finish");
  assert.deepEqual(finish.reason, { kind: "stop" });
  assert.deepEqual(finish.replayState.response, { kind: "hana", version: 1, provider: "deepseek", model: "m1", requestId: "r1", stopReason: "stop" });
  assert.deepEqual(finish.replayState.blocks, [{ textSignature: "s1" }]);
});

test("done(toolUse：推理+tool-call) → tool-calls finish，arguments 为 JSON 字符串", () => {
  const chunks = buildDoneChunks({
    doneEvent: {
      requestId: "r2",
      stopReason: "toolUse",
      assistant: {
        role: "assistant",
        content: [
          { type: "reasoning", reasoning: "想", signature: "sg" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.txt" }, thoughtSignature: "ts" },
        ],
      },
    },
    provider: "p",
    model: "m",
    requestId: "r2",
  });
  assert.equal(chunks.filter((c) => c.type === "block-start").length, 2);
  const toolBlock = chunks.find((c) => c.type === "block-end" && c.block.type === "tool-call");
  assert.equal(toolBlock.block.arguments, JSON.stringify({ path: "a.txt" }));
  const finish = chunks.find((c) => c.type === "finish");
  assert.deepEqual(finish.reason, { kind: "tool-calls" });
  assert.deepEqual(finish.replayState.blocks[1], { id: "c1", thoughtSignature: "ts" });
});

test("done(length) → max-tokens；空内容+stop → EMPTY_RESPONSE", () => {
  const c1 = buildDoneChunks({ doneEvent: { requestId: "r3", stopReason: "length", assistant: { role: "assistant", content: [{ type: "text", text: "x" }] } }, provider: "p", model: "m", requestId: "r3" });
  assert.deepEqual(c1.find((c) => c.type === "finish").reason, { kind: "max-tokens" });
  assert.throws(
    () => buildDoneChunks({ doneEvent: { requestId: "r4", stopReason: "stop", assistant: { role: "assistant", content: [] } }, provider: "p", model: "m", requestId: "r4" }),
    (e) => e.code === "EMPTY_RESPONSE",
  );
});

test("usageToTokenUsage: 无 usage 返回 undefined；部分字段映射", () => {
  assert.equal(usageToTokenUsage(null), undefined);
  assert.deepEqual(usageToTokenUsage({ output: 3 }), { outputTokens: 3 });
});
