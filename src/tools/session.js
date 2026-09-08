// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/session.js — dsh_session 会话工具（App v2 迁移步骤 1 形态）
//
// v2 变化（相对 v1 tools/session.js，迁移指南 §13 步骤 1）：
//  1. 工具名注册策略：保留原名 "dsh_session"（v1 宿主注册出的 "dsh-hanako_dsh_session"
//     是宿主按插件 id 自动加前缀的工件，不是作者意图名；v2 ctx.tools.register 不自动
//     加前缀、工具名全局唯一）。理由：全仓文档/SKILL/参数描述均以 dsh_session 为名，
//     改名会让模型可见 API 与既有手册脱节；冲突面（宿主内置/其它 App/MCP 工具是否占用
//     dsh_session）在步骤 1 暂无法从本仓库查证，若宿主加载时报重名，只需改本文件 name
//     一处（如 dshana_session），其余字段不变。
//  2. 数据读路径迁到 ctx.dataDir（宿主 app-data/<id>/；v1 的宿主插件 dataDir / 包根
//     data/ 布局不再是权威）。list/get 读 dsh-home 的唯一事实源
//     （storages/session_projcache.json + sessions/.../session.jsonl.zstd）——DSH host
//     未启动仍可读（离线可读验收点）。旧插件数据 → App dataDir 的迁移接缝见
//     lib/app-runtime.js appDataDir() 注释，本次只留口、不做迁移脚本。
//  3. action 参数契约与返回语义不变（list/get/create/send/cancel/approve + 同 schema）。
//     但 create/send/cancel/approve 依赖 DSH 受管运行时（ctx.runtime.start +
//     connectAppRuntime + Hana task 映射），那是迁移步骤 2+ 的接线内容：步骤 1 这些
//     action 一律返回明确「未接线」错误（先于字段校验，让 Agent 第一时间知道真正阻塞），
//     list/get 正常离线工作。v1 的 run/cancel/approve subtool 实现保留在源码树
//     （tools/subtool/）供后续步骤复用改造，不再被本模块静态 import。
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execute as queryExecute } from "./subtool/query.js"; // list/get 只读查询（subtool）
import { appDataDir } from "../lib/app-runtime.js";

const __here = dirname(fileURLToPath(import.meta.url));
// APP_ROOT 向上查找含 manifest.json 的目录——源码形态（src/tools/ 下）与
// dist bundle 形态（dist/index.js 内联，import.meta.url = dist/）都能正确定位 App 根。
let APP_ROOT = __here;
while (!existsSync(join(APP_ROOT, "manifest.json"))) {
  const parent = dirname(APP_ROOT);
  if (parent === APP_ROOT)
    throw new Error("无法定位 App 根：向上未找到 manifest.json");
  APP_ROOT = parent;
}

/** 当前数据目录（权威 ctx.dataDir；离线/无宿主兜底包根 data/，与 v1 同语义） */
function dataDirOf() {
  const d = appDataDir();
  if (d) return d;
  const g = globalThis.__dshHanako; // v1 残留单例兜底（仅离线/未迁移路径，读不写）
  return (g && g.dataDir) || join(APP_ROOT, "data");
}

export const name = "dsh_session";

export const description =
  "DSH 会话全生命周期工具（合并原 dsh_run / dsh_cancel）：list=会话清单（解析 session_projcache，dsh-home 唯一事实源，limit 默认 10）；" +
  "get=凭 sessionId 直取会话元数据 + 最终结论 summary；" +
  "create=新建会话 + 提交任务（task/cwd 必填，cwd 每次调用显式指定）；" +
  "send=续已有会话发消息（sessionId + task 必填，resume 语义）；" +
  "cancel=取消任务（sessionId 必填）；" +
  "approve=应答会话挂起的审批（allowed-once/rejected）。" +
  "权限模型：sessionId 即访问凭证。完整调用手册见 SKILL: skills/dsh-session/SKILL.md";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "get", "create", "send", "cancel", "approve"],
      description:
        "list=会话清单；get=凭 sessionId 取内容；create=新建会话+提交；send=续会话发消息；cancel=取消任务；approve=应答会话挂起的审批（allowed-once/rejected）",
    },
    limit: {
      type: "integer",
      description: "仅 list 模式：返回条数（按 lastPromptAt 最新在前，取最近 N 条）：默认 10，有效范围 1~100，超出自动收敛到边界",
    },
    sessionId: {
      type: "string",
      description: "get/send/cancel/approve 必传（形如 session-<uuid>，取自回调/卡片/list 结果）：get=读取、send=续会话、cancel=取消、approve=应答该会话的审批",
    },
    approvalId: {
      type: "string",
      description: "仅 approve：审批 id（审批通知里带；同一任务可能挂起多个审批，逐个应答）",
    },
    outcome: {
      type: "string",
      enum: ["allowed-once", "rejected"],
      description: "仅 approve：allowed-once=放行单次（安全默认，仅本次操作）/ rejected=拒绝该请求",
    },
    task: {
      type: "string",
      description: "create/send 必传：任务描述/消息文本（create 新建会话首条，send 续会话消息）",
    },
    cwd: {
      type: "string",
      description: "仅 create 必传：沙箱工作目录（bash 与文件系统工具的活动范围，绝对路径；defaultCwd 配置已删除，每次调用显式指定）",
    },
    timeout: {
      type: "number",
      description: "仅 create/send：任务超时（秒），缺省用 App 设置 defaultTimeoutSec",
    },
    agentPreset: {
      type: "string",
      description: "仅 create/send：agent 预设（standard/ptc/cordis/minimal）",
    },
    reasoningEffort: {
      type: "string",
      description: "仅 create/send：推理强度（off/high/max）",
    },
    provider: {
      type: "string",
      description: "仅 create/send：显式 provider（显式即成为 dsh 新默认）",
    },
    model: {
      type: "string",
      description: "仅 create/send：显式 model id（与 provider 一起传时覆盖 dsh 默认）",
    },
  },
  required: ["action"],
};

// 迁移说明：v1 本模块导出的 sessionPermission（external_side_effect + describeSideEffect）
// 是 v1 宿主权限模型的声明形态（函数型 describeSideEffect 无法跨 v2 App 进程序列化）。
// v2 的权限面 = 能力授予（manifest capabilities，如 app/tools.expose-to-model）+ 宿主
// 权限 ledger + 后续步骤的 hooks/tasks 审批链；步骤 1 注册时不再携带该字段，留待 create/
// send 等外效 action 真正接线时按宿主 0.930.1 契约重新声明。见 src/index.js apply 注释。

// 步骤 1 未接线 action 的统一错误文案（让 Agent 明确知道阻塞在迁移步骤 2，而不是
// 参数/权限问题；字段校验在错误之后不再执行，避免误导性提示）
const NOT_WIRED = (action) =>
  "action=" +
  action +
  " 依赖 DSH 受管运行时（App v2 迁移步骤 2 接线：ctx.runtime.start 启动 DSH + " +
  "connectAppRuntime + Hana task 映射），当前骨架尚未启动 DSH——本阶段仅 list/get 可" +
  "离线使用（读 App dataDir 的 dsh-home），create/send/cancel/approve 将在后续迁移步" +
  "骤接通，届时参数与返回语义不变";

async function doExecute(input, ctx) {
  const action = String(input.action ?? "").trim();

  if (action === "list" || action === "get") {
    // 只读查询（list/get）由 query subtool 处理（纯本地：projcache + jsonl zstd 解压，
    // 不依赖 DSH host，离线可读；数据目录 = App ctx.dataDir）
    return queryExecute(input, ctx);
  }

  if (action === "create" || action === "send") {
    // 迁移步骤 2+ 接线前，create/send 不落地（v1 的 run subtool 提交链路依赖进程内
    // web host 与宿主总线，不能原样跨到 App 隔离进程）
    throw new Error(NOT_WIRED(action));
  }

  if (action === "cancel") {
    throw new Error(NOT_WIRED(action));
  }

  if (action === "approve") {
    throw new Error(NOT_WIRED(action));
  }

  throw new Error(
    "action 必须是 list / get / create / send / cancel / approve（收到 " + action + "）",
  );
}

export async function execute(input, ctx) {
  try {
    return await doExecute(input, ctx);
  } catch (e) {
    // ctx 为 App apply 注入的工具上下文（见 index.js makeToolCtx：log = 统一日志文件 +
    // 宿主 logger）；缺失时静默（防御）
    ctx?.log?.error?.("[dsh-hanako] dsh_session failed:", e?.stack || e?.message || String(e));
    throw e;
  }
}
