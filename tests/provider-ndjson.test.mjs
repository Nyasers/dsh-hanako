// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/provider-ndjson.test.mjs — src-cordis/plugins/provider/lib/ndjson.js 单测
// 覆盖：跨 chunk 半行拼接、多行/整行边界、flush 兜底、空行跳过、坏行抛错语义。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  consumeTextChunk,
  parseNdjsonEvent,
  createNdjsonLineReader,
} from "../src-cordis/plugins/provider/lib/ndjson.js";

test("consumeTextChunk: 整行/多行/半行余量", () => {
  assert.deepEqual(consumeTextChunk("a\nb\nc\n"), { lines: ["a", "b", "c"], rest: "" });
  assert.deepEqual(consumeTextChunk("a\nb"), { lines: ["a"], rest: "b" });
  assert.deepEqual(consumeTextChunk(""), { lines: [], rest: "" });
});

test("parseNdjsonEvent: 正常/空白/坏行", () => {
  assert.deepEqual(parseNdjsonEvent('{"type":"start"}'), { type: "start" });
  assert.equal(parseNdjsonEvent("   "), null);
  assert.equal(parseNdjsonEvent(""), null);
  assert.throws(() => parseNdjsonEvent("{broken"), (e) => e.code === "HANA_NDJSON_PARSE");
});

test("createNdjsonLineReader: 跨 chunk 半行拼接", () => {
  const reader = createNdjsonLineReader();
  const text = '{"type":"start"}\n{"type":"text-delta","delta":"hel';
  const r1 = reader.push(text);
  assert.equal(r1.length, 1); // 第一行完整
  assert.equal(r1[0], '{"type":"start"}');
  assert.equal(reader.pendingLength > 0, true);
  const r2 = reader.push('lo"}\n{"type":"done"}\n');
  assert.equal(r2.length, 2);
  assert.deepEqual(JSON.parse(r2[0]), { type: "text-delta", delta: "hello" });
  assert.deepEqual(JSON.parse(r2[1]), { type: "done" });
  // flush 无余量
  assert.deepEqual(reader.flush(), []);
});

test("createNdjsonLineReader: flush 兜底无换行结尾的半行", () => {
  const reader = createNdjsonLineReader();
  reader.push('{"type":"done","requestId":"r1"}'); // 无 \n 结尾
  assert.equal(reader.pendingLength > 0, true);
  const tail = reader.flush();
  assert.equal(tail.length, 1);
  assert.equal(JSON.parse(tail[0]).type, "done");
});

test("createNdjsonLineReader: 只按 \n 切行（\r 由 trim 容错）", () => {
  const reader = createNdjsonLineReader();
  const CR = String.fromCharCode(13);
  const lines = reader.push('{"a":1}' + CR + "\n{" + '"b":2}' + "\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '{"a":1}' + CR); // CR 保留，解析前 trim 容错
  assert.equal(JSON.parse(lines[0].trim()).a, 1);
  assert.equal(JSON.parse(lines[1]).b, 2);
});
