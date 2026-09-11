// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/stream-frames.js — 受管 runtime 内的「有界读流」助手（叶模块，可单测）
//
// 用途：DSH 网关的部分方法（`session/follow`、`session/control`）是**流**，而我们有些读路径
// 只需要它的**开场帧**——例如 `session/follow` 的 opening snapshot 同时给出 `cursor`
// （= `session/page` 必需的 `throughSeq`）与一小窗 `records`。这类读没有理由把流读到底，
// 读满 N 帧就主动取消订阅。
//
// 形态：按行解析，兼容 NDJSON（每行一个 JSON）与 SSE（`data:` 前缀行）；忽略空行、
// `:` 开头的心跳注释、以及非 JSON 行（日志文本）；无尾换行的最后一帧也收。
//
// 纪律：**永远有界**——帧数上限硬夹在 [1,16]，默认 4（开场快照通常就在第一帧，留几帧余量
// 但绝不放任读到底）；退出前必定 cancel reader。
export const DEFAULT_MAX_FRAMES = 4;
export const HARD_MAX_FRAMES = 16;

/** 帧数上限归一：非数/≤0 取默认，超过硬上限夹住。 */
export function clampFrames(raw, fallback = DEFAULT_MAX_FRAMES) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(HARD_MAX_FRAMES, Math.trunc(n));
}

/** 单行归一到帧对象；非帧返回 null（空行 / SSE 心跳注释 / 非 JSON 文本）。 */
export function parseFrameLine(line) {
  const raw = String(line ?? "").trim();
  if (!raw || raw.startsWith(":")) return null;
  const payload = raw.startsWith("data:") ? raw.slice(5).trim() : raw;
  if (!payload) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * 有界读流：收满 maxFrames 帧或流结束即停，返回帧数组（最多 maxFrames 个）。
 * @param {Response} response fetch 响应（需有 body.getReader）
 * @param {number} maxFrames 帧数上限（经 clampFrames 归一）
 */
export async function readFirstFrames(response, maxFrames = DEFAULT_MAX_FRAMES) {
  const limit = clampFrames(maxFrames);
  const frames = [];
  if (!response || !response.body || typeof response.body.getReader !== "function") return frames;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const take = (line) => {
    if (frames.length >= limit) return;
    const frame = parseFrameLine(line);
    if (frame !== null) frames.push(frame);
  };
  try {
    while (frames.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = pending.indexOf("\n")) >= 0) {
        take(pending.slice(0, idx));
        pending = pending.slice(idx + 1);
        if (frames.length >= limit) break;
      }
    }
    if (frames.length < limit) take(pending); // 无尾换行的最后一帧
  } finally {
    try { await reader.cancel(); } catch { /* 流已结束或不可取消 */ }
  }
  return frames;
}
