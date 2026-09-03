// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/dsh-session.js — dsh 会话全生命周期工具（list/get/create/send/cancel）
// 继承 dsh_ops（清单）+ dsh_run（任务提交）+ dsh_cancel（取消）全部能力：
//   - list：解析 dsh 官方会话持久化缓存 <dataDir>/dsh-home/storages/session_projcache.json
//     （session-persistence 单元的 proj cache，含全部历史会话摘要）。纯本地文件读。
//   - get：凭 sessionId 直取会话内容——projcache 元数据 + summary（jsonl 最后一条
//     assistant/message 的 text，截断 ≤4000 字符）。
//   - create：新建会话 + 提交任务（原 dsh_run 无 sessionId 路径；task 必填）
//   - send：续已有会话发消息（原 dsh_run resume 路径；sessionId + task 必填）
//   - cancel：取消任务（原 dsh_cancel；sessionId 必填）
// create/send 复用 dsh-run.js 的 execute（提交主流程：submitTask + 事件流 + 卡片）；
// cancel 复用 dsh-cancel.js 的 execute。dsh-run/dsh-cancel 不再作为独立工具注册
// （index.js 移除），保留为内部模块供本工具调用。
// 权限模型：sessionId 即访问凭证——拿得到 id 即可 get/send/cancel。
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execute as runExecute } from "./subtool/run.js";
import { execute as queryExecute } from "./subtool/query.js"; // list/get 只读查询（subtool）
import { execute as cancelExecute } from "./subtool/cancel.js";
import { execute as approveExecute } from "./subtool/approve.js"; // 审批应答（会话操作，并入统一工具，2026-09-04）

const __here = dirname(fileURLToPath(import.meta.url));
// PLUGIN_ROOT 向上查找含 manifest.json 的目录——源码形态（tools/ 下）与
// rspack bundle 形态（dist/tools/ 下）都能正确定位插件根（与 tools/dsh-run.js 同款定位）。
let PLUGIN_ROOT = __here;
while (!existsSync(join(PLUGIN_ROOT, "manifest.json"))) {
  const parent = dirname(PLUGIN_ROOT);
  if (parent === PLUGIN_ROOT)
    throw new Error("无法定位插件根：向上未找到 manifest.json");
  PLUGIN_ROOT = parent;
}

export const name = "dsh_session";

export const description =
  "DSH 会话全生命周期工具（合并原 dsh_run / dsh_cancel）：list=会话清单（解析 session_projcache，dsh-home 唯一事实源，limit 默认 10）；" +
  "get=凭 sessionId 直取会话元数据 + 最终结论 summary；" +
  "create=新建会话 + 提交任务（task/cwd 必填，cwd 每次调用显式指定）；" +
  "send=续已有会话发消息（sessionId + task 必填，resume 语义）；" +
  "cancel=取消任务（sessionId 必填）。" +
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
      description: "仅 create/send：任务超时（秒），缺省用插件配置 defaultTimeoutSec",
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

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "local_read",
    summary:
      "读取 DSH 会话持久化缓存 session_projcache.json 与会话 jsonl（zstd 容器本地解压，只读；dsh-home 唯一事实源，sessionId 即访问凭证）；create/send 经总线提交 dsh 任务、cancel 取消任务、approve 应答会话挂起审批（写会话/审批状态）",
    ruleId: "dsh-hanako-session",
  }),
};

async function doExecute(input, ctx) {
  const g = globalThis.__dshHanako;
  const dataDir = g?.dataDir || join(PLUGIN_ROOT, "data");
  const action = String(input.action ?? "").trim();

  if (action === "list" || action === "get") {
    // 只读查询（list/get）由 query subtool 处理（纯本地：projcache + jsonl zstd）
    return queryExecute(input, ctx);
  }

  if (action === "create" || action === "send") {
    const sessionId = String(input.sessionId ?? "").trim();
    if (action === "create" && sessionId)
      throw new Error("create 是新建会话，不允许传 sessionId（续会话请用 send）");
    if (action === "send" && !sessionId)
      throw new Error("send 必须传 sessionId（续已有会话；新建请用 create）");
    if (!String(input.task ?? "").trim())
      throw new Error(action + " 必须传 task（任务描述/消息文本）");
    if (action === "create" && !String(input.cwd ?? "").trim())
      throw new Error("create 必须传 cwd（沙箱工作目录；defaultCwd 配置已删除无回退，send 沿用会话已有 cwd）");
    // 复用 dsh-run 的 execute（提交主流程：submitTask + 事件流 + 卡片 + 审批接线）；
    // create 不传 sessionId（新建）、send 传 sessionId（resume 语义）。
    return runExecute(input, ctx);
  }

  if (action === "cancel") {
    const sessionId = String(input.sessionId ?? "").trim();
    if (!sessionId) throw new Error("cancel 必须传 sessionId");
    return cancelExecute(input, ctx);
  }

  if (action === "approve") {
    // 审批应答（会话操作：应答挂在某 session 挂起的审批上，sessionId 定位）——复用
    // dsh-approve 的 execute（activeApprovals 校验 + 总线应答），并入统一工具不再单独注册
    return approveExecute(input, ctx);
  }

  throw new Error(`action 必须是 list / get / create / send / cancel / approve（收到 "${action}"）`);
}

export async function execute(input, ctx) {
  try {
    return await doExecute(input, ctx);
  } catch (e) {
    ctx.log?.error?.(
      "[dsh-hanako] dsh_session failed:",
      e?.stack || e?.message || String(e),
    );
    throw e;
  }
}
