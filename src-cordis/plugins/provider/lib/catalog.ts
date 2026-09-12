// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/plugins/provider/lib/catalog.ts — hana.models.list 目录 → DSH llm 目录（纯函数）
//
// 宿主 models.list 返回的每条 AppModelInfoV2 投影字段（迁移核对记录）：
//   id, name, provider, input[], reasoning, thinkingLevels, [customThinkingLevels],
//   defaultThinkingLevel, contextWindow, maxTokens, [xhigh], [toolUse], [serviceTiers] …
// provider/model 选择 = models.stream 里逐条相等匹配 n.provider===provider && n.id===model，
// 因此 DSH 侧 provider route 与 model id 原样透传宿主字符串（不做二次命名/映射）。
//
// DSH LlmAdapter 目录语义（@deepseek-ai/dsh-llm types）：listModels 返回 { provider, id,
// name, inputModalities? }；resolveModel 返回 LlmResolvedModelInfo 追加 context/
// defaultMaxTokens/reasoning{efforts,defaultEffort}。reasoning effort 是 adapter 自有
// 词汇，但**透传到宿主** models.stream.reasoningEffort 会被宿主按模型 thinking levels 校验
// （Loe 归一 + UNSUPPORTED_REASONING）——本模块只声明宿主接受面内的 effort。
// 零依赖纯函数（node --test 可直接 import）。

/** 宿主/pi-ai 共用 thinking effort 词表（off..max 升序；DSH agent 默认 high 必须可接受）。 */
export const CANONICAL_EFFORT_IDS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * 宿主 models.stream 对**请求字段** maxTokens 的硬上限（宿主写死的默认 limits.maxTokens，
 * 校验器原文："maxTokens must be a positive integer no larger than 65536."）。这是
 * App 接口自己的闸，不是模型能力：模型 published 上限可能远大于它（如 1M 上下文 / 384k 输出）。
 * 另有一条按模型的 "maxTokens exceeds the selected model's published limit."。
 */
export const HOST_MAX_OUTPUT_TOKENS = 65536;

/**
 * 一条目录项 published 的 max output tokens（正整数才有效，否则 null）。
 * 这是**模型真实能力**（DSH 目录应当看到的值），不夹宿主的请求上限。
 */
export function modelPublishedMaxTokens(item) {
  return item && Number.isInteger(item.maxTokens) && item.maxTokens > 0 ? item.maxTokens : null;
}

function asStringSet(value) {
  const set = new Set();
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === "string" && v) set.add(v);
      else if (v && typeof v === "object" && typeof v.level === "string" && v.level) set.add(v.level);
      else if (v && typeof v === "object" && typeof v.id === "string" && v.id) set.add(v.id);
    }
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (v === true || v === undefined) set.add(k);
      else if (typeof v === "string" && v) set.add(v);
    }
  }
  return set;
}

/**
 * 一条目录项的可用 thinking effort（升序、去重；空 = 模型不支持显式 effort）。
 * 来源优先级：defaultThinkingLevel / xhigh / thinkingLevels / customThinkingLevels，
 * 与 CANONICAL_EFFORT_IDS 交集过滤。取不到且条目声明 reasoning 时给保守面 [off, high]
 * （DSH agent 默认 high 必须可被接受——v1 provider 同款保证）。
 */
export function supportedEfforts(item) {
  if (!item || item.reasoning !== true) return [];
  const raw = new Set();
  if (typeof item.defaultThinkingLevel === "string" && item.defaultThinkingLevel) {
    raw.add(item.defaultThinkingLevel);
  }
  if (item.xhigh === true) raw.add("xhigh");
  for (const s of asStringSet(item.thinkingLevels)) raw.add(s);
  for (const s of asStringSet(item.customThinkingLevels)) raw.add(s);
  const inter = CANONICAL_EFFORT_IDS.filter((id) => raw.has(id));
  if (inter.length > 0) return inter;
  const fallback = ["off", "high"];
  if (item.reasoning === true) return fallback;
  return [];
}

/** 目录项默认 effort：defaultThinkingLevel 在 supportedEfforts 内取之；否则 reasoning 模型给 high。 */
export function defaultEffortOf(item, efforts) {
  if (!item || !Array.isArray(efforts) || efforts.length === 0) return undefined;
  if (typeof item.defaultThinkingLevel === "string") {
    if (efforts.includes(item.defaultThinkingLevel)) return item.defaultThinkingLevel;
  }
  return efforts.includes("high") ? "high" : efforts[0];
}

/** 按 provider 分组（provider 路由集合；DSH registerAdapter 第一参数）。 */
export function providerRoutes(models) {
  const out = [];
  const seen = new Set();
  for (const m of models || []) {
    const p = m && typeof m.provider === "string" ? m.provider : "";
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  out.sort();
  return out;
}

/** listModels(provider) 输出（id/name/inputModalities；advisory）。 */
export function listModelsForProvider(provider, models) {
  return (models || [])
    .filter((m) => m && m.provider === provider && typeof m.id === "string" && m.id)
    .map((m) => {
      const out = { provider, id: m.id, name: typeof m.name === "string" && m.name ? m.name : m.id };
      if (Array.isArray(m.input) && m.input.length) {
        out.inputModalities = m.input.filter((x) => x === "text" || x === "image");
      }
      return out;
    });
}

/** 一条目录项 resolveModel 输出（LlmResolvedModelInfo 形状）。 */
export function resolveModelInfo(item) {
  if (!item || typeof item.provider !== "string" || typeof item.id !== "string") return null;
  const efforts = supportedEfforts(item);
  const info = {
    provider: item.provider,
    id: item.id,
    name: typeof item.name === "string" && item.name ? item.name : item.id,
  };
  if (Number.isInteger(item.contextWindow) && item.contextWindow > 0) {
    info.context = { contextWindow: item.contextWindow };
  }
  if (Number.isInteger(item.maxTokens) && item.maxTokens > 0) {
    // 目录声明模型真实上限（不夹宿主请求上限）：DSH 要看到“这模型能出多少”。
    // 宿主那边 65536 的请求闸由 adapter 在 stream() 里处理（超限不传字段）。
    info.defaultMaxTokens = item.maxTokens;
  }
  if (efforts.length > 0) {
    const reasoning = {
      efforts: efforts.map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) })),
    };
    const def = defaultEffortOf(item, efforts);
    if (def) reasoning.defaultEffort = def;
    info.reasoning = reasoning;
  }
  return info;
}
