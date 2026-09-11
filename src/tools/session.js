// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/session.js — dshana_session 会话工具（App v2 迁移步骤 3 形态）
//
// 状态（迁移指南 §13 步骤 1-4a）：list/get 走官方查询面（query subtool，需 runtime 就绪）；create/send 已接线
// （lib/session-run.js submitDshTask：ctx.tasks.create + ensureManagedRuntime + loopback
// HTTP RPC + task-map 映射 + 同会话串行化；终态由受管 runtime task-bridge 回投）；
// cancel/approve 步骤 4a 已接线（取消链 = cancel-chain.js：映射 cancel 标记 + DSH
// session.cancel + 等 DSH 真中止后宿主任务 canceled；宿主任务 canceled/aborted 反向
// 触发在受管 runtime task-bridge；审批链 = approval-bridge requestApproval + watch 对账，
// approve 应答经 approve-respond.js ctx.tasks.respondApproval——决策只投给正确等待者）。
//
// v2 变化（相对 v1 tools/session.js，迁移指南 §13 步骤 1/3）：
//  1. 工具名注册策略：工具名 "dshana_session"（本文件 name 为单一事实源）。
//     v1 宿主注册出的 "dsh-hanako_dsh_session" 是宿主按插件 id 自动加前缀的工件，不是作者
//     意图名；v2 ctx.tools.register 不自动加前缀、工具名全局唯一。改名（dsh_session →
//     dshana_session）随 sample-align W4 落地：借用官方样例 hana_dsh_* 的命名空间习惯，
//     同时保持单工具形态；全仓文档/SKILL/参数描述同步。若宿主加载时报重名，只需改本文件
//     name 一处，其余字段不变。
//  2. 数据读路径迁到 ctx.dataDir（宿主 app-data/<id>/；v1 的宿主插件 dataDir / 包根
//     data/ 布局不再是权威）。list/get 走**官方查询面**（session/list + session/page，
//     见 tools/subtool/query.js 头注释）——不再是文件直读，也不再具备"离线可读"性
//     （W4 裁决：会话格式演进交回官方）。旧插件数据 → App dataDir 的迁移接缝见
//     lib/app-runtime.js appDataDir() 注释，本次只留口、不做迁移脚本。
//  3. action 参数契约与返回语义不变（list/get/create/send/cancel/approve + 同 schema）。
//     但 create/send/cancel/approve 依赖 DSH 受管运行时（ctx.runtime.start +
//     connectAppRuntime + Hana task 映射），那是迁移步骤 2+ 的接线内容：步骤 1 这些
//     action 一律返回明确「未接线」错误（先于字段校验，让 Agent 第一时间知道真正阻塞），
//     list/get 步骤 1 时离线工作（W4 起改为经官方查询面取数，见 subtool/query.js 头注释，
//     从此需要受管 runtime 就绪）。v1 的 run/cancel/approve subtool 实现保留在源码树
//     （tools/subtool/）供后续步骤复用改造，不再被本模块静态 import。
import { execute as queryExecute } from "./subtool/query.js"; // list/get 只读查询（subtool）
import { submitDshTask } from "../lib/session-run.js"; // create/send 提交链（步骤 3 接线）
import { cancelSessionWork } from "../lib/cancel-chain.js"; // cancel 编排（步骤 4a）
import { respondApprovalAction } from "../lib/approve-respond.js"; // approve 应答编排（步骤 4a）

// 注：list/get 改走官方查询面后，本模块不再自己定位 App 根/数据目录——旧 APP_ROOT 上溯与
// dataDirOf()（含 v1 单例兜底）随文件直读路径一并退场（数据目录由 query subtool 经 ctx 取）。

export const name = "dshana_session";

export const description =
  "DSH 会话全生命周期工具（合并原 dsh_run / dsh_cancel）：list=会话清单（官方 session/list，需 DSH 运行时在线，limit 默认 10）；" +
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
// 权限 ledger + 后续步骤的 tasks 审批链（迁移步骤 4 接线 requestApproval/respondApproval
// 时按宿主 0.930.1 契约声明）。见 src/index.js apply 注释。

// 步骤 4a 状态：cancel/approve 已接线（见文件头注释与 DESIGN「步骤 4a 架构决策」）。
// 真机边界（宿主取消 UI 反向触发 / DSH 超窗未确认的取消升级 / 审批通知形态）写入
// DESIGN「已测/未测边界」，装包后由主上下文验收。

async function doExecute(input, ctx) {
  const action = String(input.action ?? "").trim();

  if (action === "list" || action === "get") {
    // 只读查询（list/get）由 query subtool 处理：经控制面走官方查询面（session/list + session/page），
    // **需要受管 runtime 就绪**（不再有离线直读文件的路径；数据目录 = App ctx.dataDir）
    return queryExecute(input, ctx);
  }

  if (action === "create" || action === "send") {
    // 步骤 3 接线（v1 run subtool 提交链路的 v2 等价，见 lib/session-run.js 头注释）：
    // ctx.tasks.create(callToken) → ensureManagedRuntime → session.create/list/selectModel/
    // prompt（loopback HTTP RPC，v1 信封复用）→ task-map 写映射 → fire-and-forget 返回。
    // callToken 由宿主工具调用上下文提供（input.context.callToken，v2 契约），只在
    // ctx.tasks.create 消费一次，不落盘不落日志（指南 §5）。
    const callToken = (input && input.context && input.context.callToken) || "";
    // submitDshTask 返回 { promise, ready }：ready 在 prompt 被 DSH 接受后 resolve 定位键
    // （sessionId/rpcId/taskId），提交阶段失败则 reject（错误上抛给工具面）；promise 是后台
    // 生命周期（等 task 终态、释放串行锁），本处不 await。
    const { ready } = submitDshTask({ action, input, callToken, log: ctx && ctx.log });
    const loc = await ready;
    const actionName = loc.action === "send" ? "send（续会话）" : "create（新建会话）";
    const sid = String(loc.sessionId || "");
    const rpc = String(loc.rpcId || "");
    const text =
      "任务已提交给 DSH（" + actionName + "）：rpcId " + rpc + "，sessionId " + sid +
      (loc.cwd ? "，cwd " + loc.cwd : "") +
      "。任务将在后台执行（Hana task " + loc.taskId + "），完成/失败结果会作为后台结果投递到" +
      "本会话；需要看执行过程或最终结论时用 dshana_session action=get（sessionId " + sid + "）。";
    return {
      content: [{ type: "text", text }],
      details: {
        dsh: {
          action: loc.action,
          sessionId: sid,
          rpcId: rpc,
          taskId: loc.taskId,
          status: "running",
          cwd: loc.cwd || undefined,
        },
      },
    };
  }

  if (action === "cancel") {
    // 步骤 4a 取消链（cancel-chain.js）：sessionId 必填；映射写 cancel 标记 → DSH
    // session.cancel（loopback RPC）→ 确认窗口内等宿主任务 canceled（= DSH 真中止后，
    // task-bridge 结算）→ 未确认则升级宿主 ctx.tasks.cancel 并如实告知。会话无活动任务
    // 时发幂等 cancel（防「宿主清映射、DSH 仍在跑」），返回无副作用说明。
    const sessionId = String((input && input.sessionId) || "").trim();
    if (!sessionId) {
      throw new Error("cancel 需要 sessionId（dshana_session 提交返回/回调/卡片 URL 里带；取消一律显式传 sessionId）");
    }
    const out = await cancelSessionWork({ sessionId, reason: "user", log: ctx && ctx.log });
    const sid = String(out.sessionId || sessionId);
    let text;
    let status = "cancelling";
    if (out.status === "canceled") {
      status = "canceled";
      text = out.escalated
        ? "已取消任务（session " + sid.slice(0, 12) + "…）：DSH 未在确认窗口内确认中止，宿主任务已升级标记 canceled——若 DSH 仍显示运行中请重试取消或检查 runtime 日志"
        : "任务已取消（session " + sid.slice(0, 12) + "…）：DSH 已确认中止，结果/终态通知将投递到发起会话";
    } else if (out.status === "no-active-work") {
      status = "idle";
      text = "会话 " + sid.slice(0, 12) + "… 当前没有运行中的 DSH 任务（映射为空）；已发送幂等 session.cancel，无副作用";
    } else if (out.status === "already-requested") {
      text = "该会话已有取消请求在处理中（reason=" + String(out.reason || "user") + "），等待 DSH 中止确认；勿重复取消";
    } else if (out.status === "dsh-rpc-failed") {
      status = "dsh-unreachable";
      text = "已请求取消（session " + sid.slice(0, 12) + "…），但 DSH 侧取消调用失败：" + String(out.dshError || "unknown") + "。宿主任务将以取消兜底终结；若 DSH 进程仍运行请检查 runtime 日志";
    } else {
      text = "已请求取消（session " + sid.slice(0, 12) + "…）：DSH 正在中止（模型/工具/终端），终态将随后台任务通知确认——canceled 只在 DSH 真中止后标记";
    }
    return {
      content: [{ type: "text", text }],
      details: { dsh: { action: "cancel", sessionId: sid, taskId: out.taskId || undefined, status, reason: out.reason || "user", dshAccepted: out.dshAccepted === true } },
    };
  }

  if (action === "approve") {
    // 步骤 4a 审批应答（approve-respond.js）：sessionId/approvalId 必填；校验审批归属
    // （task-map approvals 表：属于该会话且 pending）→ ctx.tasks.respondApproval 结算宿主
    // 审批 → 受管 runtime approval-bridge watch 把 outcome 只投给该 approvalId 对应的
    // DSH 等待者（allowed-once/rejected 原样，绝不自动放行）。
    const res = await respondApprovalAction({ input, log: ctx && ctx.log });
    return res;
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
    ctx?.log?.error?.("[dsh-hanako] dshana_session failed:", e?.stack || e?.message || String(e));
    throw e;
  }
}
