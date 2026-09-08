// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/index.js — dsh-hanako v2 App 入口（迁移规格：specs/current/dshana-v2-runtime-inproc/spec.md）
//
// 形态：v2 App 契约。本模块只做「注册面 + 运行时接线」，不内嵌 DSH：
//   - 模块导出 apply(ctx)，只用公开 App context 成员：
//       ctx.logger / ctx.dataDir（= {HANA_HOME}/app-data/{appId}）/ ctx.id /
//       ctx.tools.register / ctx.routes.register / ctx.config / ctx.storage /
//       ctx.tasks / ctx.runtime（第 2 步起使用 ctx.runtime 拉起受管 native runtime）；
//   - 不再导出旧插件 default class（new DshHanakoPlugin + onload() + this.ctx），也不再导出
//     pluginRoutes（旧宿主 routes/ 扫描转发面；v2 的页面/路由全部在 apply 内经 ctx.routes
//     .register 注册）。
//
// 第 2 步新增（T6）：工具 execute 外层接 single-flight 受管 runtime 启动——
//   create/send/cancel/approve 四个 action 需要真实 DSH（受管 runtime 内 runProfile），
//   list/get 是纯本地文件读（guide §12：DSH host 未启动时仍能读取持久化列表），不触发启动。
//   启动失败不静默：错误原样上抛（含 helper 缺失/授权缺失的可行动指引）。
//
// 与旧 onload 对照（迁移原则：不包兼容 adapter 继续读旧宿主对象）：
//   this.ctx.config       → ctx.config（get/getAll/set/setMany）——本文件把 getAll() 快照
//                           交给尚未迁移的 v1 形状调用链（见 toolContextOf，第 3 步移除）。
//   this.ctx.dataDir      → ctx.dataDir。
//   this.ctx.log          → ctx.logger。
//   this.ctx.registerTool → ctx.tools.register。
//   pluginRoutes(app,ctx) → ctx.routes.register(registrar)。
//
// 明确不在第 2 步迁移（见文末注释块）：
//   - send→task→inference/tool-loop→complete/fail 的完整闭环（第 3 步）；
//   - Web UI base prefix / ui 静态树 / 卡片 SSE（第 4 步）；
//   - activation（第 5 步）。

import * as dshSession from "./tools/session.js";
import registerWebuiRoutes from "./routes/webui.js";
import registerCardRoutes from "./routes/card.js";
import { bindAppContext } from "./lib/lifecycle.js";
import { ensureDshRuntime } from "./lib/runtime-host.js";
import { taskStoreInfo, resolveTaskStore, bindTask, findTasksBySession } from "./lib/task-map.js";

// 应用 id：manifest.id === 应用目录名（v2 硬性约束）。ctx.id 是 v2 公开成员；
// 双兜底保证 dev/直接 import 形态也能拿到稳定值。
const APP_ID = "dsh-hanako";

const HANAKO_TOOLS = [dshSession];

// 需要真实 DSH 运行时的 action（受管 runtime 未就绪时按需拉起）：
//   create/send → 提交任务（第 3 步换 ctx.tasks + ACP）；cancel/approve → 取消/审批应答。
//   list/get 是纯本地读（session_projcache + jsonl），不拉起 runtime。
const RUNTIME_ACTIONS = new Set(["create", "send", "cancel", "approve"]);
// 只有 create/send 产生新的后台工作（新建 Hana task）；cancel/approve 是对既有工作的操作，
// 复用映射里该会话最近的活动 taskId（取消链/审批链的定位键，spec D3「不把单次任务绑成全局焦点」）。
const TASK_CREATING_ACTIONS = new Set(["create", "send"]);

function appIdOf(ctx) {
  return typeof ctx?.id === "string" && ctx.id ? ctx.id : APP_ID;
}

// v2 App 路由对外 base：ctx.routes.register 的 registrar 收到的是**相对** route app，
// 页面 HTML/浏览器 API 的绝对 URL 需要 base（第 4 步 Web UI base prefix 验收内容）。
function routeBaseOf(appId) {
  return "/api/apps/" + appId + "/routes";
}

// App 内部状态（v2 语义下不再携带宿主对象）：给尚未迁移的 tools execute 内部链
// （subtool/* 读 g.dataDir 定位 dsh-home 等）保留最小可用字段；execute 链第 3 步重接后
// 可整体删除（含 globalThis.__dshHanako）。
function ensureInternalState(ctx) {
  let g = globalThis.__dshHanako;
  if (!g || typeof g !== "object") {
    g = globalThis.__dshHanako = {};
  }
  if (typeof ctx?.dataDir === "string") g.dataDir = ctx.dataDir;
  if (typeof g.appId !== "string") g.appId = appIdOf(ctx);
  return g;
}

/**
 * v1 形状 ctx 适配（过渡，第 3 步退役）：第 1 步沿用的 tools/subtool/* 读的是 v1 形状
 * （ctx.config 为平面对象、ctx.sessionPath、ctx.bus、ctx.log）。v2 宿主把工具调用上下文
 * 放在 input.context（sessionPath/messageId/messageText/callToken），ctx.config 是 API。
 * 本函数合成一份两者兼有的对象：v2 成员原样透传（dataDir/runtime/storage/tasks/logger），
 * v1 成员按 input.context 与 config 快照补齐。第 3 步改为纯 v2 后删除。
 */
function toolContextOf(ctx, input) {
  const call = (input && typeof input === "object" && input.context) || {};
  let configSnapshot = {};
  try {
    const all = ctx?.config?.getAll?.();
    if (all && typeof all === "object") configSnapshot = all;
  } catch {
    /* 设置未登记（apply 早期）：空快照 */
  }
  return {
    ...ctx,
    dataDir: ctx?.dataDir,
    config: configSnapshot,
    log: ctx?.logger,
    logger: ctx?.logger,
    bus: ctx?.bus,
    sessionPath: call.sessionPath ?? null,
    messageId: call.messageId ?? null,
    messageText: call.messageText ?? null,
    callToken: call.callToken,
    document: call.document,
  };
}

/**
 * 在本次工具调用期间创建 Hana task（guide §5）：callToken 只在 create 时有效，工具返回后
 * 失效；此后只用稳定的 taskId。失败不阻断工具调用（映射缺失时任务照跑，仅失去来源会话绑定）。
 */
async function createHanaTask(ctx, input, toolCtx) {
  const callToken = toolCtx?.callToken;
  if (!callToken || typeof ctx?.tasks?.create !== "function") return null;
  try {
    const label = String(input?.task ?? "").slice(0, 120) || "DSH 任务";
    const task = await ctx.tasks.create({
      callToken,
      label,
      ...(typeof input?.sessionId === "string" && input.sessionId ? { externalId: input.sessionId } : {}),
      metadata: {
        app: "dsh-hanako",
        action: String(input?.action ?? ""),
        ...(typeof input?.cwd === "string" && input.cwd ? { cwd: input.cwd } : {}),
      },
    });
    return task || null;
  } catch (e) {
    safeLog(ctx?.logger, "warn", "[dsh-hanako] ctx.tasks.create 失败（映射降级）：" + (e?.message || e));
    return null;
  }
}

/** 复用既有映射：按会话找最近的活动 Hana taskId（cancel/approve 的定位键来源）。 */
function findExistingTaskId(ctx, input) {
  const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
  if (!sessionId) return null;
  try {
    const store = resolveTaskStore(ctx, { dataDir: ctx?.dataDir });
    const list = findTasksBySession(store, sessionId);
    const active = list.find((t) => t.status === "running") || list[0];
    return active?.taskId || null;
  } catch {
    return null;
  }
}

/** 工具 execute 外层：按 action 需要时 single-flight 拉起受管 DSH runtime（并绑定 taskId）。 */
function wrapTool(tool, ctx) {
  return async function execute(input) {
    const toolCtx = toolContextOf(ctx, input);
    const action = String(input?.action ?? "").trim();
    if (RUNTIME_ACTIONS.has(action)) {
      const task = TASK_CREATING_ACTIONS.has(action)
        ? await createHanaTask(ctx, input, toolCtx)
        : { taskId: findExistingTaskId(ctx, input) };
      if (task?.taskId) {
        toolCtx.hanaTaskId = task.taskId;
        try {
          const store = resolveTaskStore(ctx, { dataDir: ctx?.dataDir });
          bindTask(store, {
            taskId: task.taskId,
            // 只有新建工作的 action 才写 kind/status；cancel/approve 只复用既有条目（刷新 updatedAt）
            ...(TASK_CREATING_ACTIONS.has(action) ? { kind: action, status: "running" } : {}),
            ...(typeof input?.sessionId === "string" && input.sessionId ? { dshSessionId: input.sessionId } : {}),
            ...(typeof input?.cwd === "string" && input.cwd ? { cwd: input.cwd } : {}),
            ...(typeof input?.provider === "string" && input.provider ? { provider: input.provider } : {}),
            ...(typeof input?.model === "string" && input.model ? { model: input.model } : {}),
          });
        } catch (e) {
          safeLog(ctx?.logger, "warn", "[dsh-hanako] taskId 映射写入失败：" + (e?.message || e));
        }
      }
      try {
        await ensureDshRuntime(ctx, {
          taskId: task?.taskId,
          cwd: typeof input?.cwd === "string" ? input.cwd : undefined,
        });
      } catch (e) {
        // 启动失败必须显式上报（不静默降级）：message 已含 helper/授权指引
        if (task?.taskId) {
          try {
            await ctx.tasks?.fail?.(task.taskId, {
              message: "DSH 运行时不可用：" + String(e?.message || e).slice(0, 300),
            });
          } catch {
            /* 终态回投失败不阻断错误上报 */
          }
        }
        const err = new Error("[dsh-hanako] DSH 运行时不可用（action=" + action + "）：" + (e?.message || e));
        err.code = e?.code || "DSH_RUNTIME_UNAVAILABLE";
        err.cause = e;
        throw err;
      }
    }
    return tool.execute(input, toolCtx);
  };
}

function safeLog(logger, level, msg) {
  try {
    if (typeof logger?.[level] === "function") logger[level](msg);
  } catch {
    /* 日志失败不阻断注册 */
  }
}

// ---- v2 App 入口：apply(ctx) ----
// ① routes（ctx.routes.register 单 registrar，webui+card 全部 handler）；
// ② tools（ctx.tools.register 逐工具注册；execute 外层接受管 runtime single-flight）。
// apply 同步返回，不启动任何后台链（guide §3：不要在 apply() 里等待长期运行的 DSH 服务）。
export function apply(ctx) {
  const appId = appIdOf(ctx);
  const logger = ctx?.logger;
  const log = (level, msg) => safeLog(logger, level, msg);

  ensureInternalState(ctx);
  // 受管 runtime 的一切能力都挂在 ctx 上；v1 形状调用点（tools/protocol/routes）经单例取用。
  bindAppContext(ctx);
  log("info", "[dsh-hanako] v2 App apply() 注册开始（appId=" + appId + "）");

  let toolsRegistered = 0;
  if (typeof ctx?.tools?.register === "function") {
    for (const tool of HANAKO_TOOLS) {
      try {
        ctx.tools.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          execute: wrapTool(tool, ctx),
          ...(tool.sessionPermission ? { sessionPermission: tool.sessionPermission } : {}),
        });
        toolsRegistered += 1;
        log("info", "[dsh-hanako] 工具注册:" + tool.name + "（ctx.tools.register；execute 接受管 runtime）");
      } catch (e) {
        log("error", "[dsh-hanako] 工具注册失败:" + (tool?.name || "?") + "（" + (e?.message || String(e)) + "）");
      }
    }
  } else {
    log("warn", "[dsh-hanako] ctx.tools.register 不可用，工具注册面未成立");
  }

  if (typeof ctx?.routes?.register === "function") {
    try {
      const base = routeBaseOf(appId);
      ctx.routes.register((routeApp) => {
        registerWebuiRoutes(routeApp, base);
        registerCardRoutes(routeApp, base);
      });
      log("info", "[dsh-hanako] 路由注册：ctx.routes.register（webui + card 全部 handler）");
    } catch (e) {
      log("error", "[dsh-hanako] 路由注册失败（" + (e?.message || String(e)) + "）");
    }
  } else {
    log("warn", "[dsh-hanako] ctx.routes.register 不可用，页面路由注册面未成立");
  }

  log(
    "info",
    "[dsh-hanako] v2 App 注册面完成（tools=" +
      toolsRegistered +
      "；taskId 映射存储=" +
      taskStoreInfo(safeTaskStore(ctx)).kind +
      "）；DSH 运行链路经 ctx.runtime 受管 native runtime",
  );
}

// 映射存储形态探测（诊断日志用；storage 不可用时返回文件兜底对象）
function safeTaskStore(ctx) {
  try {
    return { kind: ctx?.storage?.agent ? "host-storage" : "file" };
  } catch {
    return { kind: "file" };
  }
}

export default apply;

// ---------------------------------------------------------------------------
// 旧宿主依赖清单（第 2 步已迁移 / 待迁移）：
//   ✅ 已迁移（第 2 步）：DSH 运行时承载（ctx.runtime.start native → runtime/dsh-host.mjs）、
//      依赖区（dataDir/runtime + pnpm 12 载体）、dshana profile 种子化（runtime 进程内）、
//      dsh-home 定位（ctx.dataDir）、taskId↔session/rpc 映射存储（lib/task-map.js）。
//   3. send→task→inference/tool-loop→complete/fail：迁移点 = 宿主 task:register-handler
//      私有 bus verb、dsh_session create/send/cancel/approve 的 execute（subtool/run、
//      subtool/cancel、subtool/approve）里的 ctx.bus/ctx.signal/ctx.sessionPath 与
//      callUnaryBus 总线投递、approval 通知——改接 ctx.tasks（create/update/complete/
//      fail/cancel/requestApproval/respondApproval/watch）+ ctx.models；
//      DSH 侧 provider adapter 重写（NDJSON + done.assistant 签名回放）；
//      App→runtime 的 HTTP 兼容桥（lib/runtime-host.js syncCompatWeb）随之退役。
//   4. Web UI base prefix：/main、/sidebar、/webui/*、/card/*、/ops/* 的浏览器绝对 URL
//      （routeBaseOf 占位值）+ ui/ 静态树 + card SSE。
//   5. activation（on-demand + idleTimeoutMs + 声明工具）与空闲回收验收。
// ---------------------------------------------------------------------------
