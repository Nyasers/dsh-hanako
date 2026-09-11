// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/stream-frames.test.mjs — src/runtime/stream-frames.js 有界读流助手单测
// 覆盖：行解析（NDJSON / SSE data: / 心跳注释 / 非 JSON 文本）、帧数上限归一与硬夹、
// 跨 chunk 半行余量、无尾换行末帧、收满即取消（不读到底）、空响应。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MAX_FRAMES, HARD_MAX_FRAMES, clampFrames, parseFrameLine, readFirstFrames } from "../src/runtime/stream-frames.js";

const enc = new TextEncoder();

/** 有序推送若干 chunk 后正常结束的流。 */
const closedStream = (chunks) => new ReadableStream({
  start(controller) {
    for (const c of chunks) controller.enqueue(enc.encode(c));
    controller.close();
  },
});

/** 只入队不关闭的流（模拟仍在推送）；记录 cancel 是否被调用。 */
const openStream = (chunks, onCancel) => new ReadableStream({
  start(controller) {
    for (const c of chunks) controller.enqueue(enc.encode(c));
  },
  cancel() { onCancel(); },
});

const res = (body) => ({ body });

test("clampFrames: 默认 / 非法回落 / 硬上限夹住", () => {
  assert.equal(clampFrames(undefined), DEFAULT_MAX_FRAMES);
  assert.equal(clampFrames(0), DEFAULT_MAX_FRAMES);
  assert.equal(clampFrames(-3), DEFAULT_MAX_FRAMES);
  assert.equal(clampFrames("abc"), DEFAULT_MAX_FRAMES);
  assert.equal(clampFrames(NaN), DEFAULT_MAX_FRAMES);
  assert.equal(clampFrames(2.7), 2);
  assert.equal(clampFrames(999), HARD_MAX_FRAMES);
  assert.equal(clampFrames("6"), 6);
});

test("parseFrameLine: NDJSON 与 SSE data: 都成帧；心跳/空行/非 JSON 都不成帧", () => {
  assert.deepEqual(parseFrameLine('{"type":"snapshot","cursor":7}'), { type: "snapshot", cursor: 7 });
  assert.deepEqual(parseFrameLine('data: {"type":"event","seq":3}'), { type: "event", seq: 3 });
  assert.deepEqual(parseFrameLine('data:{"type":"event"}'), { type: "event" });
  assert.equal(parseFrameLine(""), null);
  assert.equal(parseFrameLine("   "), null);
  assert.equal(parseFrameLine(": ping"), null);
  assert.equal(parseFrameLine("data: not json"), null);
  assert.equal(parseFrameLine("[dsh-host] 普通日志行"), null);
});

test("readFirstFrames: 跨 chunk 半行余量 + 无尾换行末帧", async () => {
  const r = res(closedStream([
    '{"n":1}\n{"n":',      // 第一帧完整，第二帧被切断
    '2}\n{"n":3}',         // 余量补齐第二帧，第三帧无尾换行
  ]));
  const frames = await readFirstFrames(r, 8);
  assert.deepEqual(frames, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test("readFirstFrames: SSE 心跳与非 JSON 行被跳过，不占帧位", async () => {
  const r = res(closedStream([
    ": keep-alive\n",
    "data: {\"type\":\"snapshot\",\"cursor\":9}\n",
    "[dsh-host] 噪声\n",
    "data: {\"type\":\"event\",\"seq\":10}\n",
  ]));
  const frames = await readFirstFrames(r, 4);
  assert.deepEqual(frames.map((f) => f.type), ["snapshot", "event"]);
  assert.equal(frames[0].cursor, 9);
});

test("readFirstFrames: 收满上限即取消，不把流读到底", async () => {
  let cancelled = false;
  const r = res(openStream(
    Array.from({ length: 10 }, (_, i) => `{"n":${i}}\n`),
    () => { cancelled = true; },
  ));
  const frames = await readFirstFrames(r, 2);
  assert.deepEqual(frames, [{ n: 0 }, { n: 1 }]);
  assert.equal(cancelled, true, "收满帧必须取消订阅");
});

test("readFirstFrames: 空/无 body 返回空数组", async () => {
  assert.deepEqual(await readFirstFrames(res(closedStream([])), 4), []);
  assert.deepEqual(await readFirstFrames(res(null), 4), []);
  assert.deepEqual(await readFirstFrames(null, 4), []);
});

test("readFirstFrames: 全非 JSON 流得空数组（不报错）", async () => {
  const r = res(closedStream([": a\n", "噪音\n", "data: 也不行\n"]));
  assert.deepEqual(await readFirstFrames(r, 4), []);
});
