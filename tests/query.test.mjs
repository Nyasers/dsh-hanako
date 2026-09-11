// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/query.test.mjs — dshana_session 的 list/get 取数纯函数单测
// 重点：轮次边界（最后一次 user/message）→ 本轮最后一次 assistant 输出的挑选规则，
// 以及"本轮未产出 → 退更早并标出 / 不静默冒充"的行为；另覆盖官方摘要映射与标题形状识别。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  execute,
  lastRoundOutput,
  mapSummary,
  textFromMessageBlocks,
  titleFromProjections,
  titleFromRecords,
} from "../src/tools/subtool/query.js";

const SID = "session-11111111-2222-3333-4444-555555555555";

// ---------- 造记录的小工具（对齐官方 records 形状：{ type:'event', event:{ type, seq, time, data } }）----------
const ev = (type, data, seq = 0) => ({ type: "event", event: { type, seq, time: 0, data } });
const userMsg = (text = "prompt", seq = 0) => ev("user/message", { source: { kind: "user" }, content: [{ type: "text", text }] }, seq);
const assistantMsg = ({ text = "", turn = 1, interrupted = false, seq = 0 } = {}) =>
  ev("assistant/message", { turn, step: 1, message: { content: text ? [{ type: "text", text }] : [{ type: "tool_use", name: "bash" }] }, interrupted: interrupted || undefined }, seq);
// 非持久事件（follow 里的 assistant-stream 帧）：不参与结论判定
const streamFrame = () => ({ type: "assistant-stream", frame: { attemptId: "a" } });

test("textFromMessageBlocks: 只取 text 块并拼接，非数组/空得 \"\"", () => {
  assert.equal(textFromMessageBlocks([{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }]), "ab");
  assert.equal(textFromMessageBlocks([{ type: "tool_use" }]), "");
  assert.equal(textFromMessageBlocks(null), "");
  assert.equal(textFromMessageBlocks("nope"), "");
});

test("多轮会话：取最后一轮最后一次 assistant 输出（跳过纯工具调用步）", () => {
  const r = lastRoundOutput([
    userMsg("r1"), assistantMsg({ text: "结论一", turn: 1 }),
    userMsg("r2"), assistantMsg({ text: "", turn: 2 }),   // 该轮只有工具调用步，无文本
    assistantMsg({ text: "结论二", turn: 2 }),
    streamFrame(),                                        // 流式帧不该干扰
  ]);
  assert.deepEqual(r, { text: "结论二", turn: 2, interrupted: false, scope: "round", error: null });
});

test("本轮还在跑（最后一次 user 之后无输出）：退到更早并标 scope=earlier，不静默冒充", () => {
  const r = lastRoundOutput([
    userMsg("r1"), assistantMsg({ text: "结论一", turn: 1 }), userMsg("r2"),
  ]);
  assert.equal(r.scope, "earlier");
  assert.equal(r.text, "结论一");
});

test("窗口内无 user 消息：scope=window", () => {
  const r = lastRoundOutput([assistantMsg({ text: "孤零零的结论", turn: 3 })]);
  assert.equal(r.scope, "window");
  assert.equal(r.text, "孤零零的结论");
});

test("空记录 / 只有 user：scope=none、text 为空", () => {
  assert.deepEqual(lastRoundOutput([]), { text: "", turn: 0, interrupted: false, scope: "none", error: null });
  assert.deepEqual(lastRoundOutput([userMsg("x")]), { text: "", turn: 0, interrupted: false, scope: "none", error: null });
  assert.equal(lastRoundOutput(null).scope, "none");
});

test("本轮整轮无文本：保持 scope=round 且 text 为空（由调用方表述「无文本汇报」）", () => {
  const r = lastRoundOutput([userMsg("r1"), assistantMsg({ text: "", turn: 1 })]);
  assert.deepEqual(r, { text: "", turn: 1, interrupted: false, scope: "round", error: null });
});

test("中断标记透出（turn 被 cancel 时前缀文本仍算本轮输出）", () => {
  const r = lastRoundOutput([userMsg("r1"), assistantMsg({ text: "半句", turn: 1, interrupted: true })]);
  assert.equal(r.interrupted, true);
  assert.equal(r.scope, "round");
  assert.equal(r.text, "半句");
});

test("本轮以错误结束（真机形状：只有 assistant/attempt + turn/end）：错误原因透出，不假装无结论", () => {
  const attempt = ev("assistant/attempt", { turn: 1, step: 1, stream: [] }, 13);
  const ended = ev("turn/end", { turn: 1, reason: { kind: "error", error: { message: "llm-deepseek: no API key for provider route \"deepseek-official\"", code: "MISSING_CREDENTIAL" } } }, 15);
  const r = lastRoundOutput([userMsg("只回一个字：好", 9), attempt, ended]);
  assert.equal(r.scope, "none");
  assert.equal(r.text, "");
  assert.equal(r.error.code, "MISSING_CREDENTIAL");
  assert.match(r.error.message, /no API key/);
});

test("有输出但该轮也报了错：文本照给，错误并列透出（不互相掩盖）", () => {
  const ended = ev("turn/end", { turn: 2, reason: { kind: "error", error: { message: "网络中断", code: "E_NET" } } }, 20);
  const r = lastRoundOutput([userMsg("r2"), assistantMsg({ text: "半成品结论", turn: 2 }), ended]);
  assert.equal(r.text, "半成品结论");
  assert.equal(r.scope, "round");
  assert.equal(r.error.message, "网络中断");
});

test("更早轮次的错误不当作本轮错误（turn 对齐）", () => {
  const older = ev("turn/end", { turn: 1, reason: { kind: "error", error: { message: "旧错误", code: "E1" } } }, 20);
  const r = lastRoundOutput([userMsg("r2"), assistantMsg({ text: "结论二", turn: 2 }), older]);
  assert.equal(r.turn, 2);
  assert.equal(r.error, null);
});

test("标题事件按形状识别：非空 title + source.kind ∈ {fallback,provider,user}，末尾覆盖", () => {
  // 真机实测的形状：{ title, messageSeqs, source:{ kind:'user' } }
  const records = [
    ev("session/title", { title: "旧标题", messageSeqs: [], source: { kind: "fallback" } }),
    ev("assistant/message", { turn: 1, step: 1, message: { content: [] } }),
    ev("session/title", { title: "新标题", messageSeqs: [1], source: { kind: "user" } }),
  ];
  assert.equal(titleFromRecords(records), "新标题");
  // 形状不符的都不认
  assert.equal(titleFromRecords([ev("x/y", { title: "无 source" })]), "");
  assert.equal(titleFromRecords([ev("x/y", { title: "怪来源", source: { kind: "other" } })]), "");
  assert.equal(titleFromRecords([ev("x/y", { title: "", source: { kind: "user" } })]), "");
  assert.equal(titleFromRecords(null), "");
});

test("列表标题走投影 values.title（真机实测该键存在，空白会话为 null）", () => {
  assert.equal(titleFromProjections({ projections: { values: { title: "T" } } }), "T");
  assert.equal(titleFromProjections({ projections: { values: { title: null } } }), "");
  assert.equal(titleFromProjections({ projections: { values: {} } }), "");
  assert.equal(titleFromProjections({}), "");
});

test("mapSummary: 官方摘要 → 清单条目（投影带 title/stats/usage，asOfSeq 一并带出）", () => {
  const usage = { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const item = mapSummary({
    sessionId: SID,
    updatedAt: 1700000000000,
    running: true,
    blank: false,
    cwd: "E:\\work",
    projections: {
      asOfSeq: 7,
      values: {
        title: "探针会话",
        sessionListMetadata: { blank: false, lastPromptAt: 1700000001000 },
        sessionStats: { turns: 2, steps: 5, llmMs: 1234, toolMs: 9 },
        tokenUsage: usage,
      },
    },
  });
  assert.equal(item.sessionId, SID);
  assert.equal(item.title, "探针会话");
  assert.equal(item.cwd, "E:\\work");
  assert.equal(item.running, true);
  assert.equal(item.blank, false);
  assert.equal(item.updatedAt, 1700000000000);
  assert.equal(item.asOfSeq, 7);
  assert.equal(item.lastPromptAt, 1700000001000);
  assert.equal(item.turns, 2);
  assert.equal(item.steps, 5);
  assert.equal(item.llmMs, 1234);
  assert.deepEqual(item.usage, usage);
});

test("mapSummary: 裸摘要不硬造字段（没有投影就不编 stats/asOfSeq）", () => {
  const bare = mapSummary({ sessionId: SID });
  assert.equal("updatedAt" in bare, false);
  assert.equal("asOfSeq" in bare, false);
  assert.equal("turns" in bare, false);
  assert.equal(bare.cwd, "");
  assert.equal(bare.title, "");
  assert.equal(bare.running, false);
});

test("mapSummary: 畸形输入不炸（null / 非对象 / 投影非对象）", () => {
  assert.equal(mapSummary(null).sessionId, "");
  assert.equal(mapSummary("x").cwd, "");
  assert.equal(mapSummary({ sessionId: SID, projections: "bad" }).asOfSeq, undefined);
  assert.equal(mapSummary({ sessionId: SID, projections: { asOfSeq: NaN } }).asOfSeq, undefined);
});

test("action 分派：未知 action 报错，list/get 之外不静默", async () => {
  await assert.rejects(() => execute({ action: "bogus" }, {}), /只处理 list \/ get/);
});
