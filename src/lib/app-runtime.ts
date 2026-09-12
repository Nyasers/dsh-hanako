// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/app-runtime.ts — dshana App v2 运行包持有者
//
// 为什么存在（替代 v1 的 globalThis.__dshHanako 宿主单例）：
// v1 时代工具代码通过 globalThis.__dshHanako 存取「宿主进程内」共享状态（dataDir、
// bus/resources/network、web host 启动器、自动链状态机……），那是宿主把 DSH 拉进主进程、
// 各独立加载单元（index.js / routes / tools bundle）之间跨单元共享的产物。App v2 里
// apply(ctx) 与工具 execute 同处一个隔离 App 进程、同一个 ESM 模块图（rspack 单 bundle），
// 不再需要 globalThis 跨单元通信；ctx 成员（dataDir/config/logger/……）由 apply 捕获进
// 模块级运行包，工具执行时经本模块读取即可。生命周期纪律见 src/index.ts 头注释。
//
// 本模块是叶子：只做「存/取运行包」+ 少量无状态取值助手，不 import 任何业务模块。
// 运行包字段（initAppRuntime 由 apply 写入）：
//   ctx        apply(ctx) 收到的 HanaPluginContextV2（宿主 0.930.1 契约，19 成员）
//   dataDir    ctx.dataDir（App dataDir = 宿主 app-data/<id>/；App 安装目录只读）
//   logger     宿主日志（ctx.logger，info/warn/error/debug）——App 侧唯一日志出口
//              （运行里不带 logPath/logTail 字段）
//   readConfig (key) => unknown     ctx.config.get 的安全包装（apply 完成后才可读，
//              工具执行期调用；设置贡献未登记/读取失败返回 undefined，不抛）
let runtime = null;

/** apply(ctx) 完成初始化后写入运行包；重复调用以后一次为准（测试/重载用）。 */
export function initAppRuntime(v) {
  runtime = v || null;
  return runtime;
}

/** 读取当前 App 进程运行包；apply 尚未运行（不应发生）或已卸载时返回 null。 */
export function getAppRuntime() {
  return runtime;
}

/**
 * 当前数据目录解析（工具/业务统一入口）：
 *  ① App v2：ctx.dataDir（权威，宿主 app-data/<id>/）；
 *  ② 兜底（无宿主 apply 的离线/dev 场景，如单测或直接跑 dist 代码）：调用方
 *     再回落 PLUGIN_ROOT/data（v1 布局，与 state.js 语义一致）。
 * 旧插件数据迁移接缝：未来迁移脚本/只读兜底可在 ① 缺失
 * 所需 DSH_HOME 且 legacy 数据存在时，经此处返回 legacy dataDir 或做导入，勿在各
 * 调用点重复拼路径。
 */
export function appDataDir() {
  const app = getAppRuntime();
  return app && typeof app.dataDir === "string" && app.dataDir ? app.dataDir : null;
}

/** 读取 App 自身 settings 的一个键（contributes.settings 声明；见文件头 readConfig）。 */
export function appConfig(key) {
  const app = getAppRuntime();
  if (!app || typeof app.readConfig !== "function") return undefined;
  return app.readConfig(key);
}

/** 安全取宿主日志器（app 进程内未初始化时返回 null，调用方自行忽略）。 */
export function appLogger() {
  const app = getAppRuntime();
  return app && app.logger ? app.logger : null;
}

/** 取 apply(ctx) 收到的宿主 ctx（HanaPluginContextV2；apply 未运行/已卸载返回 null）。
 * 业务模块（tools/session.js → lib/session-run.js 等）需要 ctx.tasks/ctx.network/
 * ctx.storage 等宿主能力时统一经此取，避免直接 import 业务模块形成环。 */
export function appCtx() {
  const app = getAppRuntime();
  return app && app.ctx ? app.ctx : null;
}

/**
 * 工具执行上下文：宿主 ctx 的浅拷贝 + 统一日志出口（工具代码读 ctx.log，宿主给的是
 * ctx.logger，名字不同所以要换）。
 *
 * 为什么是拷贝整份而不是枚举几项：工具业务要用 ctx.runtime（控制面请求）、ctx.tasks
 * （宿主任务句柄归属校验）、ctx.storage 等宿主能力，枚举式手抄漏一项就是静默降级
 * （控制面直接报“宿主不支持受管服务请求”、句柄归属恒判查不到），而且下次加能力还会漏。
 */
export function toolCtxFrom(ctx, log) {
  return { ...ctx, log };
}
