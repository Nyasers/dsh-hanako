// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/plugins/provider/lib/err-text.ts — 抛出值 → 可读文本
// （与 src/lib/err-text.ts 同款；本包自有 package 作用域，不跨包 import src/lib）
//
// `catch (e)` 的 e 在 strict 下是 unknown：`e && e.message` 的 truthiness 收窄会把它
// 变成 `{}`，访问 .message 即 TS2339。日志/兜底文案多处都要这一句，收敛到一处。

/** 取错误的可读文本：有 message 用之，否则 String(e)（含 throw 原始值/字符串的情形）。 */
export const errText = (e: unknown): string => ((e as any)?.message as string) || String(e);
