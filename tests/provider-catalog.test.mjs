// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/provider-catalog.test.mjs — provider catalog 映射纯函数单测
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  supportedEfforts,
  defaultEffortOf,
  providerRoutes,
  listModelsForProvider,
  resolveModelInfo,
} from "../src-cordis/plugins/provider/lib/catalog.js";

const catalog = [
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "deepseek", input: ["text"], reasoning: true, contextWindow: 262144, maxTokens: 32768, defaultThinkingLevel: "high", thinkingLevels: ["off", "low", "medium", "high", "max"], xhigh: true },
  { id: "sensenova-text", name: "Sen Text", provider: "sensenova", input: ["text"], reasoning: false },
  { id: "vision", name: "Vision", provider: "deepseek", input: ["text", "image"], reasoning: true, defaultThinkingLevel: "high", thinkingLevels: { off: true, medium: false, high: true } },
];

test("providerRoutes: 去重排序", () => {
  assert.deepEqual(providerRoutes(catalog), ["deepseek", "sensenova"]);
});

test("supportedEfforts: 与 canonical 交集 + xhigh + fallback", () => {
  const e1 = supportedEfforts(catalog[0]);
  assert.ok(e1.includes("off") && e1.includes("high") && e1.includes("xhigh"));
  assert.ok(!e1.includes("minimal"));
  assert.deepEqual(supportedEfforts(catalog[1]), []); // 非推理模型
  assert.deepEqual(supportedEfforts(catalog[2]), ["off", "high"]); // map 过滤 false
  // reasoning true 且无任何 effort 线索 → 保守 [off, high]
  assert.deepEqual(supportedEfforts({ reasoning: true, provider: "x", id: "y" }), ["off", "high"]);
});

test("defaultEffortOf: defaultThinkingLevel 优先，否则 high/首个", () => {
  assert.equal(defaultEffortOf(catalog[0], ["off", "high", "max"]), "high");
  assert.equal(defaultEffortOf({ ...catalog[0], defaultThinkingLevel: "max" }, ["off", "high", "max"]), "max");
  assert.equal(defaultEffortOf({ ...catalog[0], defaultThinkingLevel: "medium" }, ["off", "high"]), "high"); // 不在集内
  assert.equal(defaultEffortOf({ ...catalog[0] }, []), undefined);
});

test("listModelsForProvider: 按 provider 过滤 + inputModalities", () => {
  const l = listModelsForProvider("deepseek", catalog);
  assert.equal(l.length, 2);
  assert.equal(l[0].id, "deepseek-v4-flash");
  assert.equal(l[0].provider, "deepseek");
  assert.deepEqual(l[1].inputModalities, ["text", "image"]);
});

test("resolveModelInfo: 元数据（context/defaultMaxTokens/reasoning/非推理无 reasoning）", () => {
  const i0 = resolveModelInfo(catalog[0]);
  assert.equal(i0.context.contextWindow, 262144);
  assert.equal(i0.defaultMaxTokens, 32768);
  assert.equal(i0.reasoning.defaultEffort, "high");
  const i1 = resolveModelInfo(catalog[1]);
  assert.equal(i1.reasoning, undefined);
  assert.equal(resolveModelInfo(null), null);
});
