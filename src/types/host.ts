// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/types/host.ts — 宿主契约类型面（App 侧唯一入口）
//
// 为什么单独一份：src 域此前没有 TS 语法能力（rspack 未配 swc），宿主给的形状只能写进注释、
// 参数形状只能靠 JSDoc 手抄，抄漏一处就是静默降级。swc 就位后（见 src/rspack.config.mts），
// 把「宿主给什么」收成一处具名类型，供 lib / tools / routes / runtime 引用。
//
// 只进类型层：本文件被 `import type` 引用，swc 剥掉后 bundle 里不留 @hana/app-sdk 的运行时
// 依赖（该包是 devDependency，运行时由宿主提供；运行时真需要的那处值导入见
// src/runtime/main.ts 的 connectAppRuntime）。
//
// 我们自己的形状不在这里：归属某个模块的语义形状（如归属校验结论、解析出的目标）由该模块
// 自己导出，就近可读，避免把这里做成什么都装的桶。

import type { AppEntryContext } from "@hana/app-sdk";

/** 隔离 App 的入口上下文：`apply(ctx)` 收到的那个。 */
export type { AppEntryContext } from "@hana/app-sdk";
/** 宿主进程内上下文（AppEntryContext 的完整相）。 */
export type { HanaPluginContextV2 } from "@hana/app-sdk";
/** 宿主日志器（ctx.logger）。 */
export type { HanaPluginLoggerV2 } from "@hana/app-sdk";
/** 宿主任务面（ctx.tasks）。 */
export type { AppTasksV2 } from "@hana/app-sdk";

/** 宿主任务记录（ctx.tasks.get / list 的返回；归属校验读的就是 parentSessionPath）。 */
export type { AppTaskRecordV2 } from "@hana/app-sdk";
export type { AppTaskCreateInputV2 } from "@hana/app-sdk";
export type { AppTaskUpdateInputV2 } from "@hana/app-sdk";
export type { AppCreatedTaskRecordV2 } from "@hana/app-sdk";
export type { AppTaskStatus } from "@hana/app-sdk";
export type { AppTaskDelivery } from "@hana/app-sdk";
export type { AppTaskScopeV2 } from "@hana/app-sdk";

/** 审批任务（ctx.tasks.requestApproval / respondApproval 的返回）。 */
export type { AppTaskApprovalRecordV2 } from "@hana/app-sdk";
export type { AppTaskApprovalRequestV2 } from "@hana/app-sdk";
export type { AppTaskApprovalOutcome } from "@hana/app-sdk";

/**
 * 工具侧统一日志出口：抹平「宿主 ctx.logger」与「App 入口 ctx.log」的名字差异
 * （见 lib/app-runtime.ts toolCtxFrom 与 index.ts 的 toolLog）。
 */
export interface ToolLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * 工具执行上下文：apply 期宿主入口 ctx 的浅拷贝 + 统一日志出口。
 * tools/actions/<action>.ts 的 `run(input, ctx, deps)` 收到的就是它。
 */
export type ToolCtx = AppEntryContext & { log: ToolLogger };
