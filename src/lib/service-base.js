// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/service-base.js — 受管 runtime service base URL（叶子模块，供 App 侧多模块共用）
//
// 从 session-run.js 拆出（cancel-chain 与 session-run 都要用、互为消费者时避免环依赖）：
// 显式端口契约（指南 §10）：servicePort 由 App 设置解析（managed-runtime parseServicePort），
// base = http://127.0.0.1:<port>。
import { appConfig } from "./app-runtime.js";
import { parseServicePort } from "./managed-runtime.js";

/** 受管 runtime service base URL（App 主进程经 ctx.network.fetch 访问 DSH web /api）。 */
export function serviceBase(port) {
  return "http://127.0.0.1:" + parseServicePort(port !== undefined && port !== null ? port : appConfig("servicePort"));
}
