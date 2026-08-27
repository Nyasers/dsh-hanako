// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/wake.js — 宿主 deferred 唤醒协议共用模块（lib 提取）
// 从 tools/dsh-run.js 剥离：registerDeferredWake / resolveDeferredWake / failDeferredWake /
// notifyApprovalWake。原三份内联副本（tools/dsh-run.js / tools/dsh-install.js /
// tools/dsh-update.js 各自内联一份，头注释明言"同 dsh-run.js 内联实现，不跨模块
// import"）统一归口到本模块，三入口共同 import，消除三重复。
//
// 为什么能跨模块 import（分发约束见 lib/state.js 头注释）：本模块是纯协议/纯函数/零
// 宿主状态（不碰 globalThis 单例，只发 bus.request 通道），rspack 入口（dsh-run /
// dsh-install / dsh-update）静态 import 本模块、内联进各自 bundle，?t= 重载整体刷新，
// 无"静态 import 固定 URL 缓存"问题；非 bundle 侧（routes/webui.js、index.js）不
// import 本模块（它们经 globalThis 单例调用，不在这里建依赖）。
//
// 协议背景（HRD wake.js 同协议）：工具发起时 deferred:register（登记 + 投递策略）→
// 终态 resolve/fail → 宿主投递 <hana-background-result> 给 Agent 会话（默认唤醒回合，
// 结果结构化直达）。容错纪律：唤醒是终态的旁路通知，任何失败都不抛回调用方（终局
// 落盘/安装/更新结果上报不受影响）。
//
// type 归属：registerDeferredWake 的 meta.type 由调用方传入（不要再写死）——三入口
// 需保留各自标识：dsh-run（默认）/ dsh-install / dsh-update。notifyApprovalWake 是
// dsh-run 审批挂起专用（meta.type = "dsh-approval"，独立 taskId 不占用任务完成通道）。

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

// ---- 审批挂起通知（宿主 deferred 通道，独立 taskId 不占用任务完成通道）----
// dsh 会话触发 approval/requested 时任务挂起等应答；插件把审批上下文投递给宿主，
// Agent 收到后调用 dsh_approve 工具应答（allowed-once / rejected）。
// 容错纪律同任务回调：通知失败不影响任务，审批仍可在 dsh Web UI 人工处理。
async function notifyApprovalWake({ bus, sessionPath, opId, approval, task }) {
  if (!bus?.request || !sessionPath) return;
  const taskId = `${opId}::approval::${approval.approvalId}`;
  try {
    await bus.request("deferred:register", {
      taskId,
      sessionPath,
      meta: {
        type: "dsh-approval",
        label: `DSH 审批: ${approval.toolName || "tool"}`,
      },
    });
    await bus.request("deferred:resolve", {
      taskId,
      result: {
        kind: "dsh-approval",
        opId,
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
  notifyApprovalWake,
};
