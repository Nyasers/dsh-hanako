// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/err-text.mts — 抛出值 → 可读文本，以及"带结构化字段的 Error"（脚本侧 catch 到的形状统一走这里）
//
// 为什么单独成文件：`catch (e)` 的 e 在 strict 下是 unknown，`e && e.message` 的 truthiness
// 收窄会把它变成 `{}`，访问 .message 即 TS2339；`new Error` 上直接挂自定义字段（如 problems）
// 同样被判"属性不存在"。脚本域自己需要这两件事（src 域另有一份同形实现 src/lib/err-text.ts，
// 跨域引用会把 src 文件拉进 scripts 的检查程序，故不共用），散着抄会各自漂移，收敛成一处。

/** 取错误的可读文本：有 message 用之，否则 String(e)（含 throw 原始值/字符串的情形）。 */
export const errText = (e: unknown): string => ((e as any)?.message as string) || String(e);

/**
 * 带结构化字段的 Error：字段随错误一起抛出，供诊断/测试按字段归类（如漂移校验的 problems 清单）。
 * 内置 Error 类型上没有这些字段，直接赋值会被判"属性不存在"，故在这里一次给出带字段的形状。
 */
export function codedError(message: string, fields: Record<string, unknown> = {}): Error & Record<string, unknown> {
  return Object.assign(new Error(message), fields);
}
