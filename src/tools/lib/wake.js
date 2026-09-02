// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/wake.js — 宿主 deferred 唤醒协议共用模块（lib 提取）
// 从 tools/dsh-run.js 剥离：registerDeferredWake / resolveDeferredWake / failDeferredWake /
// notifyApprovalWake。原三份内联副本（tools/dsh-run.js / tools/dsh-install.js /
// 已并入 dsh-install 的 tools/dsh-update.js 各自内联一份，头注释明言"同 dsh-run.js
// 内联实现，不跨模块 import"）统一归口到本模块，dsh-run / dsh-install 两入口共同
// import，消除三重复。
//
// 为什么能跨模块 import（分发约束见 lib/state.js 头注释）：本模块是纯协议/纯函数/零
// 宿主状态（不碰 globalThis 单例，只发 bus.request 通道），rspack 入口（dsh-run /
// dsh-install）静态 import 本模块、内联进各自 bundle，?t= 重载整体刷新，
// 无"静态 import 固定 URL 缓存"问题；非 bundle 侧（routes/webui.js、index.js）不
// import 本模块（它们经 globalThis 单例调用，不在这里建依赖）。
//
// 协议背景（HRD wake.js 同协议）：工具发起时 deferred:register（登记 + 投递策略）→
// 终态 resolve/fail → 宿主投递 <hana-background-result> 给 Agent 会话（默认唤醒回合，
// 结果结构化直达）。容错纪律：唤醒是终态的旁路通知，任何失败都不抛回调用方（终局
// 落盘/安装/更新结果上报不受影响）。
//
// type 归属：registerDeferredWake 的 meta.type 由调用方传入（不要再写死）——dsh-run
// （默认）/ dsh-install（install/update 动作统一用 "dsh-install"；原 dsh-update 标识
// 已废弃，工具并入 dsh_install）。notifyApprovalWake 是 dsh-run 审批挂起专用
// （meta.type = "dsh-approval"，独立 taskId 不占用任务完成通道）。

async function registerDeferredWake({
  bus,
  sessionPath,
  taskId,
  label,
  type = "dsh-run",
}) {
  if (!bus?.request || !sessionPath || !taskId) return false;
  try {
    await bus.request("deferred:register", {
      taskId,
      sessionPath,
      meta: {
        type,
        label: String(label || ""),
        deliveryIntent: "trigger_parent_turn",
        notifyAgentOnFailure: true,
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveDeferredWake({ bus, taskId, result }) {
  if (!bus?.request || !taskId) return false;
  try {
    await bus.request("deferred:resolve", { taskId, result });
    return true;
  } catch {
    return false;
  }
}

async function failDeferredWake({ bus, taskId, error }) {
  if (!bus?.request || !taskId) return false;
  try {
    await bus.request("deferred:fail", { taskId, error });
    return true;
  } catch {
    return false;
  }
}

// ---- 非正常终态的 minimal 结果构造 ----
// 宿主对 deferred:fail 只呈现 error.message 纯文本（实测丢定位键）；deferred:resolve 的
// result JSON 完整回传（正常完成已验证）。非正常终态（取消/超时/错误）统一走 resolve
// 形态，带与正常结束同构的定位键 { status, rpcId, sessionId } + 简短 message，主上下文
// 凭定位键直接 dsh_session get 对账，无需额外搜索。定位键优先级：err.sessionId（submitTask
// 内已附加，session.prompt 失败时 loc 为 null 也保留已创建的会话）→ loc.sessionId → rpcId。
// status 语义：DSH_ABORTED=取消 → cancelled；DSH_TIMEOUT → timeout；其他 → failed。
// 纯函数（零宿主状态），供 dsh-run.js catch 分支调用；dsh-install 仍用
// failDeferredWake（安装/更新失败无需会话定位，message 语义足够）。
function abnormalWakeResult({ err, loc, taskRpcId }) {
  const code = err && typeof err === "object" ? err.code : undefined;
  const errSessionId = err && typeof err === "object" ? err.sessionId : undefined;
  const status =
    code === "DSH_ABORTED" ? "cancelled" : code === "DSH_TIMEOUT" ? "timeout" : "failed";
  return {
    status,
    rpcId: taskRpcId || "",
    sessionId: errSessionId || (loc && loc.sessionId) || "",
    message: String((err && err.message) || err).slice(0, 300),
  };
}

// ---- 审批挂起通知（宿主 deferred 通道，独立 taskId 不占用任务完成通道）----
// dsh 会话触发 approval/requested 时任务挂起等应答；插件把审批上下文投递给宿主，
// Agent 收到后调用 dsh_approve 工具应答（allowed-once / rejected）。
// rpcId = 任务 rpcId（prompt 提交产生的 RPC id，与 jsonl data.source.rpcId 同值；
// 区别于审批帧的 respondRpcId——那是 server-request 信封自己的 RPC id，respond 路由用）。
// 容错纪律同任务回调：通知失败不影响任务，审批仍可在 dsh Web UI 人工处理。
//
// 投递形态（宿主 0.814.0+ interlude 插话式 deferred）：meta.interlude=true 时宿主走
// pre_reply_interlude 插话队列。实测（2026-09）：interlude 同样不能在 Agent 结束回合前
// 插入时间线——消息在回合收尾时才落地，不会在回合进行中送达。故审批通知与任务回调
// 一样，Agent 必须先结束当前回合才能收到；interlude + deliveryIntent=trigger_parent_turn
// 组合只保留「唤醒语义 + 回帖时间线」，不提供回合内插话。
async function notifyApprovalWake({ bus, sessionPath, rpcId, approval, task }) {
  if (!bus?.request || !sessionPath) return;
  const taskId = `${rpcId}::approval::${approval.approvalId}`;
  try {
    await bus.request("deferred:register", {
      taskId,
      sessionPath,
      meta: {
        type: "dsh-approval",
        label: `DSH 审批: ${approval.toolName || "tool"}`,
        interlude: true,
        deliveryIntent: "trigger_parent_turn",
      },
    });
    await bus.request("deferred:resolve", {
      taskId,
      result: {
        kind: "dsh-approval",
        rpcId,
        sessionId: approval.sessionId,
        approvalId: approval.approvalId,
        toolName: approval.toolName,
        callId: approval.callId,
        reason: approval.reason ?? null,
        args: approval.args ?? null, // tool/call 参数原文（命令/路径），Agent 审批决策依据
        taskPreview: String(task ?? "").slice(0, 120),
      },
    });
  } catch {
    /* 通知失败忽略（审批仍可在 web UI 处理）*/
  }
}

export {
  registerDeferredWake,
  resolveDeferredWake,
  failDeferredWake,
  abnormalWakeResult,
  notifyApprovalWake,
};
