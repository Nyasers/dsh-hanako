// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// lib/dsh-events.js — 宿主侧 DSH 事件进程内订阅（refactor/bus-inproc：总线内置化第一刀）
//
// 背景：DSH 0.1.2 的 Host 事件（api-session/*、settings/document-updated 等）源头是 cordis
// ctx 事件总线（官方 dsh-api-remotes 的 remoteEventSource 即 ctx.on 直订，再桥到 gateway 的
// remote.mux WS）。旧架构宿主经「remote.mux WS → @dsh-hanako/bus 插件 → dshana.bus WS → 宿主」
// 绕两圈收事件——那是跨进程假设的产物。进程内 boot（DSH 与宿主同进程，DSH ctx = g.web.ctx）
// 下宿主可直接 ctx.on 订阅同一事件源，零 WS、零总线、零延迟。端口形态（3080/随机端口直嵌）
// 同样成立：ctx 在手即可直订，总线只是载波不是事件源。
//
// 本模块 = 宿主侧事件订阅层（emit 模式）：web.ctx 可用时 ctx.on 直订白名单事件，帧格式与
// 总线 events 频道兼容（{ type:"emit", event, args }——run.js consume / webui.js 消费不变）。
// waterfall 模式（approval/request 等）需应答语义，见 lib/dsh-approval.js（瀑布适配未做时
// 回退：审批请求仍走总线/官方 approvalTimeoutSec 超时自动拒绝兜底）。
//
// 事件白名单（emit 模式，抄官方 dsh-api-remotes API_REMOTE_FORWARDED_EVENTS 的 emit 项）：
// api-session/*（任务状态/终态/错误）、settings/document-updated（主题偏好）、commands/change
// 等。订阅返回退订函数；ctx 未就绪返回 null（调用方回退总线 events，行为不变）。
import { getSingleton } from "./state.js";

// emit 模式白名单（与官方 remote-events 的 mode:"emit" 项对齐；waterfall 项不在此）
// session/event = DSH 会话事件通用广播（turn/start、step/start、assistant/message、
// turn/end 等，jsonl 同源）：api-session/* 是 HTTP 网关（session-controller）转发面，
// ACP 会话不经 session-controller——宿主直订 session/event 才能收 ACP 会话的活动/终态。
const CTX_EMIT_EVENTS = [
  "agent-preset/selected",
  "api-session/activity",
  "api-session/added",
  "api-session/error",
  "api-session/removed",
  "api-session/status",
  "commands/change",
  "credentials/reference-updated",
  "cordis/request-run",
  "cordis/request-run-resolved",
  "cordis/dynamic-package",
  "cordis/dynamic-retract",
  "cordis/inspect-query",
  "cordis/inspect-query-resolved",
  "llm/adapters-updated",
  "session/event",
  "settings/document-updated",
];

/**
 * 无端口形态判定 + 取 DSH cordis ctx（进程内 boot 的 runProfile ctx，挂在 g.web.ctx）。
 * ctx 的 on/emit 是 cordis 事件 API（与官方 remoteEventSource 同一订阅面）。
 */
export function inprocDshCtx() {
  try {
    const g = getSingleton();
    const ctx = g?.web?.ctx;
    return ctx && typeof ctx.on === "function" && typeof ctx.emit === "function" ? ctx : null;
  } catch {
    return null;
  }
}

/**
 * 进程内订阅 DSH emit 事件（ctx.on 直订，帧格式与总线 events 兼容）。
 * @param {(frame: {type:"emit", event:string, args:any[]}) => void} cb
 * @returns 退订函数；ctx 未就绪（端口形态 / boot 未完成）返回 null——调用方回退总线 events。
 *
 * 注意返回值契约（CodeRabbit 第二轮 #4）：truthy 退订函数只代表「ctx.on 订阅注册成功
 *（白名单 ≥1 事件挂上）」——不等于「DSH producer 可用」（事件真正从 ctx 广播要到 host
 * boot 收敛才保证）。调用方不得仅凭 truthy 判定事件源就绪；producer 可用性不足时仍应
 * 保留总线 events 兜底（见 protocol.js openMux / routes/webui.js 的双订模式）。
 */
export function subscribeDshCtxEmitEvents(cb) {
  const ctx = inprocDshCtx();
  if (!ctx) return null;
  const disposers = [];
  for (const event of CTX_EMIT_EVENTS) {
    try {
      const off = ctx.on(event, (...args) => {
        try {
          cb({ type: "emit", event, args });
        } catch {
          /* 消费者异常不阻断事件分发 */
        }
      });
      if (typeof off === "function") disposers.push(off);
    } catch {
      /* 单事件订阅失败（事件不存在/未注册）跳过——白名单保守覆盖 */
    }
  }
  // 全白名单 ctx.on 都失败（disposers 为空）时返回 null（CodeRabbit #8）：否则调用方
  // 拿到一个 truthy 空退订函数会误判「ctx 订阅成功」→ openMux 等地跳过总线兜底，结果
  // 收不到任何事件帧挂起。null 语义 = ctx 订阅不可用，调用方回退总线 events。
  if (disposers.length === 0) return null;
  return () => {
    for (const off of disposers) {
      try {
        off();
      } catch {
        /* 退订失败忽略 */
      }
    }
    disposers.length = 0;
  };
}
