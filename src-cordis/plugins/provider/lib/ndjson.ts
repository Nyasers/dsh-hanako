// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/plugins/provider/lib/ndjson.ts — NDJSON 逐行读取器（纯函数/零依赖）
//
// hana.models.stream 的响应是 NDJSON（application/x-ndjson，每行一个 JSON 事件；详见
// SDK models.d.ts）。一个网络 chunk 可能包含多行或半行，解析必须保留
// 跨 chunk 的半行余量。本模块导出：
//   createNdjsonLineReader()  —— 行级 async iterable（喂 byte/text chunk）
//   parseNdjsonEvent(line)    —— 单行 JSON.parse（容错抛错带行号上下文）
//   splitLines 助手          —— 同步文本切行（纯函数，单测覆盖半行余量逻辑）
// 消费方：@dshana/provider v2 adapter（hana.models.stream 响应 → DSH llm 流）。
// 零宿主/零 DSH import：可被 node --test 直接 import（交付物 4 单测面）。

/**
 * 同步按 \n 切分文本并保留尾余量：把 pending 追加 chunk 后逐行 yield，
 * 最后一行（无换行结尾 = 半行）留在 pending 返回。纯函数形态便于单测：
 *   const { lines, rest } = consumeTextChunk(pending + chunk);
 * 若 chunk 以 \n 结束则 rest 为空串。
 */
export function consumeTextChunk(text) {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      lines.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return { lines, rest: text.slice(start) };
}

/** 单行 JSON.parse；空行/纯空白返回 null；损坏行抛错（message 带截断行预览）。 */
export function parseNdjsonEvent(line) {
  const s = String(line).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    const preview = s.length > 200 ? s.slice(0, 200) + "…" : s;
    const err = new Error("NDJSON 行解析失败：" + ((e && e.message) || e) + "（行预览：" + preview + "）");
    err.code = "HANA_NDJSON_PARSE";
    throw err;
  }
}

/**
 * 行级读取器：接收任意（文本或字节）chunk，内部维持半行余量，跨 chunk 拼接后按行
 * 产出。使用：
 *   const reader = createNdjsonLineReader();
 *   reader.push("{\"type\":\"start\"}\n{\"type\"");
 *   reader.push(":\"done\"}\n");
 *   for (const line of reader.drain()) …  // 或 reader.lines()
 */
export function createNdjsonLineReader() {
  let pending = "";
  return {
    /** 追加一块文本（string 或 Buffer/typed array → utf8 decode），返回本轮完整行。 */
    push(chunk) {
      const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      const { lines, rest } = consumeTextChunk(pending + text);
      pending = rest;
      return lines;
    },
    /** 流末尾冲洗余量（无换行结尾的半行也算一行）。返回余行；清空余量。 */
    flush() {
      const tail = pending;
      pending = "";
      return tail.trim() ? [tail] : [];
    },
    get pendingLength() {
      return pending.length;
    },
  };
}

/**
 * 从 fetch Response body 读取 NDJSON 事件（async generator）：HTTP 非 2xx 直接携状态与响应体
 * 报错（能力未授权/参数被拒时宿主返回的错误体不会是 NDJSON，不先查 ok 只会得到含糊的
 * STREAM_CLOSED）；body 缺失抛错；逐块 push 到 line reader，解析每行（空行跳过）；末尾 flush
 * 兜底。任一行解析失败抛错（调用方按模型失败处理）。@returns AsyncGenerator<object>
 */
export async function* readNdjsonEvents(response, { onLineError } = {}) {
  if (response && response.ok === false) {
    let detail = "";
    try {
      const body = await response.text();
      detail = body ? "：" + body.slice(0, 300) : "";
    } catch {
      /* 错误体不可读时只报状态 */
    }
    const err = new Error("模型请求失败：HTTP " + String(response.status || 0) + detail);
    err.code = "MODEL_HTTP_ERROR";
    err.status = response.status;
    throw err;
  }
  if (!response || !response.body || typeof response.body.getReader !== "function") {
    throw new Error("模型响应无 body（hana.models.stream 未返回流式 Response）");
  }
  const reader = response.body.getReader();
  const lineReader = createNdjsonLineReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of lineReader.push(value)) {
        const ev = parseNdjsonEvent(line);
        if (ev !== null) yield ev;
      }
    }
    for (const line of lineReader.flush()) {
      const ev = parseNdjsonEvent(line);
      if (ev !== null) yield ev;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 已关闭 */
    }
  }
}
