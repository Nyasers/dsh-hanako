// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/err-text.ts — 抛出值 → 可读文本（catch 到的东西类型未知，字段访问统一经这里）
//
// 为什么单独成文件：`catch (e)` 的 e 在 strict 下是 unknown，`e && e.message` 的
// truthiness 收窄会把它变成 `{}`，访问 .message 即 TS2339。日志/兜底文案处二十余次
// 都要这一句，散着抄会各自漂移，故收敛成一处。

/** 取错误的可读文本：有 message 用之，否则 String(e)（含 throw 原始值/字符串的情形）。 */
export const errText = (e: unknown): string => ((e as any)?.message as string) || String(e);
