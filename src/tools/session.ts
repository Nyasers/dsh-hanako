// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/tools/session.ts — dshana_session 会话工具
//
// 六个 action：list / get / create / send / cancel / approve。
//   · list/get 走官方查询面（subtool/query.js：session/list + session/page）；
//   · create/send 走 lib/session-run.js：ctx.tasks.create → ensureManagedRuntime → loopback RPC
//     （session.create / selectModel / prompt）→ 写会话↔任务映射 → 终态由 runtime 的
//     task-bridge 回投来源会话；同会话多次 send 由 App 侧串行化；
//     create/send 的返回值在 details.dsh 之外另带 details.card（会话流卡字面量，卡页 =
//     ui/card.html，见 sessionCard），dsh 的形状不变；
//   · cancel 走 lib/cancel-chain.js（写 cancel 标记 + DSH session.cancel + 等 DSH 真中止后
//     宿主任务 canceled；宿主任务 canceled/aborted 的反向触发在 runtime 的 task-bridge）；
//   · approve 走 lib/approve-respond.js（ctx.tasks.respondApproval 结算宿主审批，决策只投给
//     该 approvalId 对应的 DSH 等待者）。
//
// 调用模型：**句柄默认、凭证显式**——cancel/approve/get 可传 taskId/approvalId，本工具反查
// 私有映射得到 DSH 会话，再以宿主任务记录的 parentSessionPath 校验归属（lib/task-ownership.js）；
// 显式传 sessionId 即“我要跨对话”，跳过归属校验。agent 面因此不需裸传 DSH 会话 id。
//
// 数据目录取 ctx.dataDir（宿主 app-data/<id>/）；工具名 "dshana_session" 以本文件 name 为单一
// 事实源（v2 注册不自动加前缀，重名会被宿主当场拒掉）。
import { execute as queryExecute } from "./subtool/query.ts"; // list/get 只读查询（subtool）
import { submitDshTask } from "../lib/session-run.ts"; // create/send 提交链
import { cancelSessionWork } from "../lib/cancel-chain.ts"; // cancel 编排
import { respondApprovalAction } from "../lib/approve-respond.ts"; // approve 应答编排
import { findTaskMapByTaskId, findTaskMapByApprovalId, isValidSessionId } from "../lib/task-map.ts"; // 句柄反查（只在 App 侧）
import { taskOwnership, ownershipRefusalText } from "../lib/task-ownership.ts"; // 归属校验通则（宿主 parentSessionPath）
import { APP_ID } from "../lib/boot-state.ts"; // App id 单一事实源（卡字面量的 pluginId 必须等于它）

// 注：本模块不自己定位 App 根/数据目录——数据目录由 query subtool 经 ctx 取。

/**
 * 目标解析（句柄优先、凭证显式）：
 *   · 显式 sessionId ⇒ 凭证路径：直接用，跳过归属校验（故意跨对话的能力保留）；
 *   · taskId / approvalId ⇒ 句柄路径：App 侧反查私有映射（DSH 会话坐标不进 agent 面），
 *     再以宿主任务记录的 parentSessionPath 校验归属；
 * 解析不出来一律显式失败：不猜、不降级。
 */
async function resolveTarget(input, ctx) {
  const explicit = String((input && input.sessionId) || "").trim();
  const dataDir = ctx && typeof ctx.dataDir === "string" ? ctx.dataDir : null;
  if (explicit) {
    if (!isValidSessionId(explicit)) {
      throw new Error("sessionId 形态不对（应为 session-<uuid>）：" + explicit);
    }
    return { sessionId: explicit, explicit: true, taskId: null, ownership: "explicit-session-id" };
  }
  const taskIdIn = String((input && input.taskId) || "").trim();
  const approvalIdIn = String((input && input.approvalId) || "").trim();
  let entry = null;
  if (taskIdIn) entry = dataDir ? findTaskMapByTaskId(dataDir, taskIdIn) : null;
  else if (approvalIdIn) entry = dataDir ? findTaskMapByApprovalId(dataDir, approvalIdIn) : null;
  if (!entry) {
    throw new Error(
      taskIdIn || approvalIdIn
        ? "找不到该句柄对应的 DSH 会话（任务可能已被回收或映射已清理）：" + (taskIdIn || approvalIdIn) + "。要跨对话操作请显式传 sessionId。"
        : "需要目标：传 taskId（默认，句柄路径）或 sessionId（显式凭证路径）",
    );
  }
  const taskId = String(entry.taskId || "");
  const sessionPath = input && input.context ? input.context.sessionPath : null;
  let record = null;
  try {
    record = taskId && ctx && ctx.tasks && typeof ctx.tasks.get === "function" ? await ctx.tasks.get(taskId) : null;
  } catch (e) {
    throw new Error("宿主任务记录读取失败（归属无法校验，按 fail-closed 处理）：" + ((e && e.message) || e));
  }
  const verdict = taskOwnership({ taskRecord: record, sessionPath, explicitSessionId: false });
  if (!verdict.ok) throw new Error(ownershipRefusalText(verdict.reason));
  return { sessionId: String(entry.dshSessionId || ""), explicit: false, taskId, ownership: verdict.reason };
}

/** 卡页文件名（App ui/ 静态树内；宿主把流内卡的 route 解析成 /api/apps/<appId>/ui<route>）。 */
const SESSION_CARD_ROUTE = "/card.html";

/**
 * 会话流卡的卡片字面量（create / send 的返回值 details.card）。
 *
 * 宿主契约（server 0.951.4 bundle 实证，见 APPS.md「形式归属」）：工具结果的 details.card
 * 被运行时透传成流内 plugin_card 块，随后由卡 iframe 加载 route。三条硬要求：
 *   · pluginId 必填且必须等于本工具的归属 App id（不等于会被当场丢掉）；
 *   · route 必须是宿主能解析到本 App 的写法——App 卡走 ui/ 静态树
 *     （/api/apps/<appId>/ui<route>），不是 ctx.routes 的 /routes/ 命名空间；
 *   · aspectRatio 要有限正数（渲染期算成 "n / 1" 的比例占位）。
 * 卡页需要的数据全压在查询串里（提交时快照，卡页不做轮询），?ts= 防缓存；
 * 卡页只向 App 后端做一次 card-state 取数，换个更准的状态行。
 */
function sessionCard({ action, sessionId, taskId, cwd }) {
  const now = Date.now();
  const params = [
    "ts=" + now,
    "at=" + now,
    "action=" + encodeURIComponent(action),
    "sid=" + encodeURIComponent(sessionId),
    "status=running",
  ];
  if (cwd) params.push("cwd=" + encodeURIComponent(cwd));
  const what = action === "send" ? "续发消息" : "新建会话";
  return {
    pluginId: APP_ID,
    route: SESSION_CARD_ROUTE + "?" + params.join("&"),
    title: "DSHana " + what + "已提交",
    description: sessionId.slice(0, 12) + "… · " + (cwd || "未指定工作目录") + " · taskId " + taskId,
    aspectRatio: 4,
  };
}

export const name = "dshana_session";

export const description =
  "DSH 会话全生命周期工具（合并原 dsh_run / dsh_cancel）：list=会话清单（官方 session/list，需 DSH 运行时在线，limit 默认 10）；" +
  "get=读取会话元数据 + 最终结论 summary（sessionId 或 taskId）；" +
  "create=新建会话 + 提交任务（task/cwd 必填，cwd 每次调用显式指定）；" +
  "send=续已有会话发消息（sessionId + task 必填，resume 语义）；" +
  "cancel=取消任务（taskId 优先，sessionId 可显式跨对话）；" +
  "approve=应答会话挂起的审批（approvalId 即可，工具自己解析会话）。" +
  "调用模型：句柄默认（taskId/approvalId，按宿主记录的来源会话校验归属）、凭证显式（sessionId = 我要跨对话）。完整调用手册见 SKILL: skills/dsh-session/SKILL.md";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "get", "create", "send", "cancel", "approve"],
      description:
        "list=会话清单；get=读取会话（sessionId 或 taskId）；create=新建会话+提交；send=续会话发消息；cancel=取消任务（taskId 优先）；approve=应答挂起审批（approvalId 即可）",
    },
    limit: {
      type: "integer",
      description: "仅 list 模式：返回条数（按 lastPromptAt 最新在前，取最近 N 条）：默认 10，有效范围 1~100，超出自动收敛到边界",
    },
    sessionId: {
      type: "string",
      description:
        "显式凭证路径（形如 session-<uuid>）：send 必传；get/cancel/approve 可用。显式传入即视为“我要跨对话操作”，跳过归属校验",
    },
    taskId: {
      type: "string",
      description:
        "句柄路径（宿主 task id：dshana_session 返回/任务通知里带）：get/cancel/approve 可传，工具自己解析会话并校验归属（与 sessionId 至少给一个）",
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
      description: "仅 create 必传：沙箱工作目录（bash 与文件系统工具的活动范围，绝对路径；无 defaultCwd 回退，每次调用显式指定）",
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
// 权限面 = 能力授予（manifest capabilities，如 app/tools.expose-to-model）+ 宿主
// 权限 ledger + tasks 审批链（requestApproval/respondApproval 按宿主 0.930.1 契约声明）。
// 见 src/index.ts apply 注释。

// cancel/approve 已接线。
// 真机边界（宿主取消 UI 反向触发 / DSH 超窗未确认的取消升级 / 审批通知形态）装包后
// 由主上下文验收。

/**
 * action 实现体。deps 只给单测注入提交链（缺省用真实 submitDshTask）；线上路径经 execute
 * 调用时 deps 为 undefined，行为不变。
 */
export async function doExecute(input, ctx, deps) {
  const action = String(input.action ?? "").trim();

  if (action === "list") {
    // 会话清单：不需要目标（官方 session/list，需受管 runtime 就绪）
    return queryExecute(input, ctx);
  }

  if (action === "get") {
    // 读取会话内容：句柄优先（taskId）→ 解析出 DSH 会话并校验归属；sessionId 为显式凭证路径
    // （只读查询经控制面走官方查询面 session/list + session/page）
    const target = await resolveTarget(input, ctx);
    return queryExecute({ ...input, sessionId: target.sessionId }, ctx);
  }

  if (action === "create" || action === "send") {
    // 提交链（见 lib/session-run.js 头注释）：
    // ctx.tasks.create(callToken) → ensureManagedRuntime → session.create/list/selectModel/
    // prompt（loopback HTTP RPC，v1 信封复用）→ task-map 写映射 → fire-and-forget 返回。
    // callToken 由宿主工具调用上下文提供（input.context.callToken，v2 契约），只在
    // ctx.tasks.create 消费一次，不落盘不落日志。
    const callToken = (input && input.context && input.context.callToken) || "";
    // 提交面（deps 可注入以单测 create/send 分支；缺省用真实 submitDshTask）返回
    // { promise, ready }：ready 在 prompt 被 DSH 接受后 resolve 定位键
    // （sessionId/rpcId/taskId），提交阶段失败则 reject（错误上抛给工具面）；promise 是后台
    // 生命周期（等 task 终态、释放串行锁），本处不 await。
    const submit = deps && typeof deps.submitDshTask === "function" ? deps.submitDshTask : submitDshTask;
    const { ready } = submit({ action, input, callToken, log: ctx && ctx.log });
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
        // 会话流卡（新增字段；dsh 的形状不动——SKILL 与句柄契约都读它）
        card: sessionCard({ action: loc.action, sessionId: sid, taskId: loc.taskId, cwd: loc.cwd }),
      },
    };
  }

  if (action === "cancel") {
    // 取消链（cancel-chain.js）：**句柄优先**——taskId/approvalId 由本工具解析会话并
    // 校验归属；显式 sessionId 走凭证路径（跳过归属校验，故意跨对话用）。映射写 cancel 标记 →
    // DSH session.cancel（loopback RPC）→ 确认窗口内等宿主任务 canceled（= DSH 真中止后，
    // task-bridge 结算）→ 未确认则升级宿主 ctx.tasks.cancel 并如实告知。会话无活动任务
    // 时发幂等 cancel（防「宿主清映射、DSH 仍在跑」），返回无副作用说明。
    const target = await resolveTarget(input, ctx);
    const sessionId = target.sessionId;
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
    // 审批应答（approve-respond.js）：approvalId 是唯一句柄——会话由本工具解析（句柄
    // 路径校验归属），sessionId 仅作显式凭证路径。校验审批归属（task-map approvals 表：属于
    // 该会话且 pending）→ ctx.tasks.respondApproval 结算宿主审批 → 受管 runtime approval-bridge
    // watch 把 outcome 只投给该 approvalId 对应的 DSH 等待者（allowed-once/rejected 原样）。
    const aid = String((input && input.approvalId) || "").trim();
    if (!aid) {
      throw new Error("approve 需要 approvalId（审批通知里带；同一任务可挂起多个审批，逐个应答）");
    }
    const target = await resolveTarget(input, ctx);
    const res = await respondApprovalAction({
      input: { ...input, sessionId: target.sessionId },
      log: ctx && ctx.log,
    });
    return res;
  }

  throw new Error(
    "action 必须是 list / get / create / send / cancel / approve（收到 " + action + "）",
  );
}

export async function execute(input, ctx) {
  try {
    return await doExecute(input, ctx, null);
  } catch (e) {
    // ctx 为 App apply 注入的工具上下文（见 index.js makeToolCtx：log = 统一日志文件 +
    // 宿主 logger）；缺失时静默（防御）
    ctx?.log?.error?.("[dshana] dshana_session failed:", e?.stack || e?.message || String(e));
    throw e;
  }
}
