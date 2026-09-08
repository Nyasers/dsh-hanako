// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/task-bridge.js — 受管 runtime 内 DSH 事件 → Hana task 回投（App v2 步骤 3）
//
// 位置与角色：本模块随 dist/runtime/dsh-host.mjs 打进受管 runtime（与 DSH 同进程），
// main.js 在 DSH boot 就绪后挂载。它订阅 DSH cordis ctx 的会话事件（进程内 ctx.on——
// 与 v1 dsh-events.js 同源；$events 广播层只带 api-session/*，turn 生命周期在 ctx 事件
// 源直订才可见），按 <dataDir>/dshana/taskmaps/<sessionId>.json 映射（App 主进程写入，
// 见 src/lib/task-map.js——本 bundle 直接复用同一实现）把事件回投宿主：
//   running 进度 → hana.tasks.update(taskId, { status:"running", progress })
//   终态（成功）  → hana.tasks.complete(taskId, minimal 定位结果)
//   终态（失败）  → hana.tasks.fail(taskId, message)
// 终态判定语义与 v1 run.js consume 对齐（api-session/status false / session/event
// turn/end + reason.kind=error；api-session/error 记 pendingFailure 不即终态）——但注意
// v2 同会话已由 App 侧串行化（一个会话同时只跑一个任务，见 lib/session-serialize.js），
// 事件按 sessionId 路由到唯一当前任务，无跨任务串扰（决策 D）。
//
// 容错纪律：订阅/回投失败只记日志不阻断 runtime；映射不存在（非 dsh_session 发起的
// 会话，如 DSH Web UI 直开）的事件直接忽略。
import { readTaskMap, removeTaskMap } from "../lib/task-map.js";

// 事件白名单（与 v1 dsh-events 的会话事件子集一致；其余事件不订阅）
export const BRIDGE_EVENTS = [
  "api-session/status", // [sessionId, running] —— 整轮排空终态信号（false）
  "api-session/error", // [sessionId, message] —— 错误记录（不即终态，终态时判失败）
  "session/event", // (session, evObj) —— turn/end / assistant/message 等（进程内可见）
  "api-session/activity", // [sessionId, time] —— 心跳（忽略，占位订阅统一容错）
];

/**
 * 事件归类（纯函数，便于单测）：把 ctx.on 回调参数归一成任务桥可消费的帧。
 * @param {string} event ctx 事件名（BRIDGE_EVENTS 子集）
 * @param {any[]} args ctx.on 回调收到的参数
 * @returns 归一帧或 null（忽略）
 */
export function classifyDshEvent(event, args) {
  const list = Array.isArray(args) ? args : [];
  if (event === "api-session/status") {
    const sid = list[0];
    const running = list[1];
    if (typeof sid !== "string" || !sid) return null;
    return { kind: "status", sessionId: sid, running: running === true };
  }
  if (event === "api-session/error") {
    const sid = list[0];
    const message = list[1];
    if (typeof sid !== "string" || !sid) return null;
    return { kind: "error", sessionId: sid, message: String(message ?? "") };
  }
  if (event === "api-session/activity") {
    const sid = list[0];
    if (typeof sid !== "string" || !sid) return null;
    return { kind: "activity", sessionId: sid };
  }
  if (event === "session/event") {
    const session = list[0];
    const ev = list[1];
    const sid = session && typeof session.id === "string" ? session.id : null;
    if (!sid || !ev || typeof ev.type !== "string") return null;
    if (ev.type === "turn/end") {
      const reason = (ev.data && ev.data.reason) || null;
      const kind = reason && reason.kind;
      return {
        kind: "turn-end",
        sessionId: sid,
        errorKind: kind === "error" ? "error" : kind === "aborted" ? "aborted" : null,
        message:
          kind === "error"
            ? String(
                ((reason && (reason.failure && reason.failure.message)) || (reason && reason.error && reason.error.message) || ""),
              )
            : "",
      };
    }
    if (ev.type === "assistant/message") {
      // 文本收集（当前 minimal 结果不回带文本；占位留作未来摘要用）
      return { kind: "assistant", sessionId: sid };
    }
    return { kind: "turn-other", sessionId: sid };
  }
  return null;
}

/**
 * 每个会话的桥状态：同一会话在 v2 被 App 串行化（同刻唯一任务），故状态机按
 * sessionId 一个条目即可，不用 turn 级坐标（v1 的复杂终点源于跨任务共享会话）。
 */
class SessionBridge {
  constructor({ hana, dataDir, log }) {
    this.hana = hana;
    this.dataDir = dataDir;
    this.log = log;
    this.map = null; // task-map 记录（进入首个事件时载入）
    this.taskId = null;
    this.sessionId = null;
    this.pendingFailure = null; // api-session/error 记录（终态时判失败）
    this.started = false; // 已推 running 进度
    this.settled = false; // 已 complete/fail（幂等）
  }

  /** 首个事件载入映射；无映射（非 dsh_session 会话）返回 false。 */
  load() {
    if (this.map) return true;
    const m = readTaskMap(this.dataDir, this.sessionId);
    if (!m || !m.taskId) return false;
    this.map = m;
    this.taskId = m.taskId;
    return true;
  }

  async onFrame(frame) {
    if (this.settled) return;
    if (!this.load()) return; // 非本 App 发起会话：忽略
    if (frame.kind === "status") {
      if (frame.running) {
        await this.markRunning();
        return;
      }
      // running=false：整轮排空终态（v1 finishFromProjection 语义）
      await this.settle(this.pendingFailure ? { ok: false, message: this.pendingFailure } : { ok: true });
      return;
    }
    if (frame.kind === "error") {
      if (frame.message) this.pendingFailure = frame.message;
      return;
    }
    if (frame.kind === "turn-end") {
      if (frame.errorKind) {
        await this.settle({
          ok: false,
          message: frame.errorKind === "aborted" ? "DSH 回合被中止（aborted）" : frame.message || "DSH 回合失败（reason.kind=error）",
        });
      } else {
        // 正常回合结束 = 成功终态（v1 turn/end completed 语义；pendingFailure 兜底）
        await this.settle(this.pendingFailure ? { ok: false, message: this.pendingFailure } : { ok: true });
      }
      return;
    }
    if (frame.kind === "assistant" || frame.kind === "activity" || frame.kind === "turn-other") {
      await this.markRunning(); // 有活动即视为运行中（进度更新）
    }
  }

  async markRunning() {
    if (this.started || !this.taskId) return;
    this.started = true;
    try {
      if (this.hana && this.hana.tasks && typeof this.hana.tasks.update === "function") {
        await this.hana.tasks.update(this.taskId, {
          status: "running",
          progress: { phase: "running", dshSessionId: this.sessionId },
        });
      }
    } catch (e) {
      this.note("tasks.update(running) 失败：" + ((e && e.message) || e));
    }
  }

  async settle(decision) {
    if (this.settled || !this.taskId) return;
    this.settled = true;
    const { ok, message } = decision || {};
    try {
      if (this.hana && this.hana.tasks) {
        if (ok) {
          const result = {
            dsh: {
              action: (this.map && this.map.action) || null,
              sessionId: this.sessionId,
              rpcId: (this.map && this.map.rpcId) || "",
              status: "completed",
              ok: true,
            },
          };
          await this.hana.tasks.complete(this.taskId, result);
        } else {
          const msg = String(message || "dsh 任务失败").slice(0, 2000);
          await this.hana.tasks.fail(this.taskId, msg);
        }
      }
    } catch (e) {
      // 终态回投失败：任务可能已被他方终态（App 卸载/取消）——幂等语义，忽略并清映射
      this.note("任务终态回投失败（task=" + this.taskId + "）：" + ((e && e.message) || e));
    } finally {
      try {
        removeTaskMap(this.dataDir, this.sessionId);
      } catch {
        /* 忽略 */
      }
    }
  }

  note(msg) {
    try {
      if (typeof this.log === "function") this.log("[task-bridge] " + msg);
    } catch {
      /* 日志失败不阻断 */
    }
  }
}

/**
 * 挂载任务桥：订阅 ctx 会话事件并把归属本 App task-map 的事件回投宿主。
 * @returns 卸载函数（幂等）
 */
const BRIDGE_PRUNE_AT = 128; // bridges 有界（已终态条目在超限时清理）

export function startTaskBridge({ ctx, hana, dataDir, log }) {
  const offs = [];
  const bridges = new Map(); // sessionId → SessionBridge（终态后惰性清理）
  const pruneSettled = () => {
    if (bridges.size < BRIDGE_PRUNE_AT) return;
    for (const [sid, b] of bridges) {
      if (b && b.settled) bridges.delete(sid);
    }
  };
  const onEvent = (event, handler) => {
    try {
      const off = ctx.on(event, handler);
      if (typeof off === "function") offs.push(off);
    } catch {
      /* 单事件订阅失败跳过 */
    }
  };
  for (const event of BRIDGE_EVENTS) {
    onEvent(event, (...args) => {
      let frame = null;
      try {
        frame = classifyDshEvent(event, args);
      } catch {
        frame = null;
      }
      if (!frame) return;
      try {
        let b = bridges.get(frame.sessionId);
        if (!b) {
          pruneSettled();
          b = new SessionBridge({ hana, dataDir, log });
          b.sessionId = frame.sessionId;
          bridges.set(frame.sessionId, b);
        }
        void b.onFrame(frame).catch((e) => {
          try {
            log && log("[task-bridge] 帧处理失败：" + ((e && e.message) || e));
          } catch { /* 忽略 */ }
        });
      } catch (e) {
        try {
          log && log("[task-bridge] 事件分发异常：" + ((e && e.message) || e));
        } catch { /* 忽略 */ }
      }
    });
  }
  const stop = () => {
    for (const off of offs) {
      try {
        off();
      } catch {
        /* 忽略 */
      }
    }
    offs.length = 0;
    bridges.clear();
  };
  try {
    log && log("[task-bridge] 已挂载（" + BRIDGE_EVENTS.length + " 个会话事件订阅，事件→Hana task 回投）");
  } catch { /* 忽略 */ }
  return stop;
}
