// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/types/globals.d.ts — 我们注入到页面上的自定义全局
//
// 这些名字由 src/ui/dsh-inject.ts 在注入 DSH index 之前挂到 window 上（DSH 客户端集成
// 与壳页桥都按它们判断环境）。它们不是标准 DOM，类型层要单独承认，否则每个引用处都报
// "Property does not exist on type 'Window & typeof globalThis'"。
//
// 只声明"存在与大致形状"：具体字段由写入方（installTransport）与读取方（各类集成）自行约束。

export {};

declare global {
  interface Window {
    /** DSH 传输面：fetch / openStream / loadBundle（内核 connection 客户端的 opt-in 通道）。 */
    __DSH_TRANSPORT__?: Record<string, unknown>;
    /** 文件上传面（当前复用 runtime fetch）。 */
    __DSH_FILE_UPLOAD__?: { fetch: unknown };
    /** 壳页桥：role（本文件属于哪个面）+ runtimeUrl（换基址）+ 壳页传入的额外面板。 */
    __DSHANA__?: Record<string, unknown>;
  }
}
