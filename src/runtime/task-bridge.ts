// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/task-bridge.ts — 受管 runtime 内 DSH 事件 → Hana task 回投
//
// 位置与角色：本模块随 dist/runtime/dsh-host.mjs 打进受管 runtime（与 DSH 同进程），
// main.js 在 DSH boot 就绪后挂载。它订阅 DSH cordis ctx 的会话事件（进程内 ctx.on——
// `$events` 广播层只带 api-session/*，turn 生命周期在 ctx 事件源直订才可见），按
// <dataDir>/dshana/taskmaps/<sessionId>.json 映射（App 主进程写入，
// 见 src/lib/task-map.ts——本 bundle 直接复用同一实现）把事件回投宿主：
//   running 进度 → hana.tasks.update(taskId, { status:"running", progress })
//   终态（成功）  → hana.tasks.complete(taskId, minimal 定位结果)
//   终态（失败）  → hana.tasks.fail(taskId, message)
// 终态判定语义（api-session/status false / session/event turn/end + reason.kind=error；
// api-session/error 记 pendingFailure 不即终态）——同会话已由 App 侧串行化（一个会话同时
// 只跑一个任务，见 lib/session-serialize.js），
// 事件按 sessionId 路由到唯一当前任务，无跨任务串扰。
//
// 取消链：
//   · 取消确认 = DSH 真中止后：App 侧 cancel/执行超时先在映射写 cancel 标记（先于
//     session.cancel RPC）；本桥在 DSH turn/end(aborted) 或自然终态但已有 cancel 标记时
//     把宿主任务结算成 hana.tasks.cancel——绝不先标
//     canceled 而 DSH 还在跑。
//   · 宿主侧取消反向触发（Hana task canceled/aborted，来源会话停止按钮/App 生命周期）：
//     本桥对已 running 的任务经 hana.tasks.watch(taskId) SSE（watch-sse.js：snapshot 首条
//     + app-task；断线 get() 对账；reset 重读快照）观察宿主任务状态，取消到达时向本进程
//     DSH 发 session.cancel（rpcSessionCancel，127.0.0.1 回环）+ 定向中止该会话活动模型
//     requestId（model-requests.js）——只停本工作资源，单例 runtime 内不误停他人会话。
//   · 宿主取消路径可能先于 DSH turn/end 到达：DSH 回合随后中止事件照常到，settle 幂等。
//
// 容错纪律：订阅/回投失败只记日志不阻断 runtime；映射不存在（非 dshana 发起的
// 会话，如 DSH Web UI 直开）的事件直接忽略。
import { readTaskMap, markTaskMapEnded, markCancelRequested } from "#/lib/task-map.ts";
import { runWatchReconcile } from "#/lib/watch-sse.ts";
import { rpcSessionCancel } from "#/lib/dsh-rpc.ts";
import { cancelSessionModelRequests } from "#/lib/model-requests.ts";
import { errText } from "#/lib/err-text.ts";

// 事件白名单（与 v1 dsh-events 的会话事件子集一致；其余事件不订阅）
export const BRIDGE_EVENTS = [
  "api-session/status", // [sessionId, running] —— 整轮排空终态信号（false）
  "api-session/error", // [sessionId, message] —— 错误记录（不即终态，终态时判失败）
  "session/event", // (session, evObj) —— turn/end / assistant/message 等（进程内可见）
  "api-session/activity", // [sessionId, time] —— 心跳（忽略，占位订阅统一容错）
];

/**
 * 事件归类（纯函数，便于单测）：把 ctx.on 回调参数归一成任务桥可消费的帧。
 * @param event ctx 事件名（BRIDGE_EVENTS 子集）
 * @param args ctx.on 回调收到的参数
 * @returns 归一帧或 null（忽略）
 */
/** 归一化后的会话事件帧：kind 定类型，其余字段随 kind（消费方按 kind 分支读）。 */
export interface DshEventFrame {
  kind: string;
  sessionId: string;
  [key: string]: unknown;
}

export function classifyDshEvent(event: string, args: unknown[]): DshEventFrame | null {
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
    const session = list[0] as { id?: unknown } | null;
    const ev = list[1] as { type?: unknown; data?: any } | null;
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
  settled = false; // 已 complete/fail/cancel（幂等）
  // ---- 注入面与状态（构造期写入）----
  hana: any;
  dataDir: string;
  log?: (msg: string) => void;
  serviceBaseUrl: string | null;
  bridgeKey: string | null;
  cancelModelRequests?: (sessionId: string) => unknown;
  map: any; // task-map 记录（进入首个事件时载入）
  taskId: string | null;
  sessionId: string | null;
  pendingFailure: string | null; // api-session/error 记录（终态时判失败）
  started: boolean; // 已推 running 进度
  hostWatchStarted: boolean; // 宿主任务 watch 已启动
  hostWatchStopped: boolean; // watch 停止标记
  hostCancelDone: boolean; // 宿主取消反向触发只做一次
  constructor({ hana, dataDir, log, serviceBaseUrl, bridgeKey, cancelModelRequests }) {
    this.hana = hana;
    this.dataDir = dataDir;
    this.log = log;
    this.serviceBaseUrl = typeof serviceBaseUrl === "string" && serviceBaseUrl ? serviceBaseUrl : null;
    this.bridgeKey = typeof bridgeKey === "string" && bridgeKey ? bridgeKey : null;
    this.cancelModelRequests = cancelModelRequests; // (sessionId) => Promise（可注入便于测试）
    this.map = null; // task-map 记录（进入首个事件时载入）
    this.taskId = null;
    this.sessionId = null;
    this.pendingFailure = null; // api-session/error 记录（终态时判失败）
    this.started = false; // 已推 running 进度
    this.settled = false; // 已 complete/fail/cancel（幂等）
    this.hostWatchStarted = false; // 宿主任务 watch 已启动
    this.hostWatchStopped = true; // watch 停止标记
    this.hostCancelDone = false; // 宿主取消反向触发只做一次
  }

  /** 首个事件载入映射；无映射（非 dshana 会话）返回 false。 */
  load() {
    if (this.map) return true;
    const m = readTaskMap(this.dataDir, this.sessionId);
    if (!m || !m.taskId) return false;
    this.map = m;
    this.taskId = m.taskId;
    return true;
  }

  /** 取消标记已请求（App cancel 工具/执行超时写；先于 DSH session.cancel）。 */
  mapCancelRequested() {
    return !!(this.map && this.map.cancel && this.map.cancel.at);
  }

  async onFrame(frame) {
    if (this.settled) return;
    if (!this.load()) return; // 非本 App 发起会话：忽略
    this.ensureHostWatch(); // 映射就绪即开始宿主任务 watch（宿主取消反向触发覆盖整个任务期）
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
          aborted: frame.errorKind === "aborted",
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
      this.note("tasks.update(running) 失败：" + ((e as any)?.message || e));
    }
  }

  /** 宿主取消反向 watch（映射就绪即挂一次；终态/停桥时回收）。 */
  ensureHostWatch() {
    if (!this.hostWatchStarted && this.serviceBaseUrl && this.hana && this.hana.tasks) {
      this.startHostWatch();
    }
  }

  /** 观察宿主任务状态：canceled/aborted → 向本进程 DSH 发 cancel + 定向中止模型流。 */
  startHostWatch() {
    this.hostWatchStarted = true;
    this.hostWatchStopped = false;
    const taskId = this.taskId;
    void (async () => {
      try {
        await runWatchReconcile({
          watch: () => this.hana.tasks.watch(taskId),
          get: () => this.hana.tasks.get(taskId),
          onFrame: async (rec) => {
            if (this.settled || this.hostWatchStopped) return false;
            const st = rec && String((rec as any).status || "");
            if (st === "canceled" || st === "aborted") {
              await this.onHostCancel(rec);
              return false; // 本 watcher 使命完成（settle 会停桥/清映射）
            }
            return true;
          },
          shouldStop: () => this.settled || this.hostWatchStopped,
          retryBaseMs: 2000,
          maxRetryMs: 20000,
          log: (m) => this.note(m),
        });
      } catch (e) {
        this.note("宿主任务 watch 异常（反向取消不可用）：" + ((e as any)?.message || e));
      }
    })();
  }

  stopHostWatch() {
    this.hostWatchStopped = true;
  }

  /** 宿主任务已 canceled/aborted：DSH session.cancel（只本会话）+ 定向模型取消，然后结算。 */
  async onHostCancel(rec) {
    if (this.hostCancelDone || this.settled) return;
    this.hostCancelDone = true;
    this.note(
      "宿主任务 " + (rec && rec.status) + "（task=" + this.taskId + "）——反向触发 DSH cancel（session=" +
      (this.sessionId || "").slice(0, 12) + "）",
    );
    // ① 取消标记先落进映射文件，**先于** DSH cancel。这个动作只能在 runtime 里做：App 进程
    //     没有 sessions 句柄（宿主 ctx 也不提供 get），而子进程/重启后的终态判定读的是
    //     映射——不落就等于“没取消过”。幂等：重复写只是覆盖同一 reason/时间戳。
    try {
      markCancelRequested(this.dataDir, this.sessionId, "user");
    } catch (e) {
      this.note("取消标记写入映射失败（继续收尾）：" + ((e as any)?.message || e));
    }
    // ② 通知 DSH session.cancel（本机回环 RPC）；失败记录（DSH 可能已自行中止）
    try {
      const fetchImpl = (url, init) => fetch(url, {
        ...init,
        headers: {
          ...((init && init.headers) || {}),
          ...(this.bridgeKey ? { "x-hana-dsh-bridge": this.bridgeKey } : {}),
        },
      });
      await rpcSessionCancel(fetchImpl, this.serviceBaseUrl, this.sessionId, { timeoutMs: 10000 });
    } catch (e) {
      this.note("反向 session.cancel 失败（继续收尾）：" + ((e as any)?.message || e));
    }
    // ③ 定向中止该会话的活动模型流（只停本工作，不误停他人会话）
    try {
      if (typeof this.cancelModelRequests === "function") {
        await this.cancelModelRequests(this.sessionId as string);
      }
    } catch (e) {
      this.note("定向模型取消失败（继续收尾）：" + ((e as any)?.message || e));
    }
    // ④ 结算：宿主任务已是终态，标记 cancelOverride 走 cancel/fail 幂等收尾 + 清映射
    await this.settle({ ok: false, aborted: true, cancelOverride: true, message: "宿主任务已取消/中止" });
  }

  /**
   * 终态回投。决策：
   *   ok=true 且无取消请求 → complete(result)；
   *   ok=true/false 但取消已请求（cancel 标记 / cancelOverride）→ hana.tasks.cancel
   *     （v1 cancelledRequested 语义：取消请求先到则终态按取消结算，防取消被误判完成）；
   *   ok=false（aborted 未请求取消）→ fail（aborted 文案）；
   *   ok=false（error）→ fail(message)。
   */
  async settle(decision) {
    if (this.settled || !this.taskId) return;
    this.settled = true;
    this.stopHostWatch();
    const { ok, message } = decision || {};
    // 本进程亲手请求过取消（hostCancelDone）也算：那是我们发出的动作，不依赖映射的回读是否及时。
    const cancel =
      this.mapCancelRequested() || this.hostCancelDone || (decision && decision.cancelOverride === true);
    try {
      if (this.hana && this.hana.tasks) {
        if (cancel && typeof this.hana.tasks.cancel === "function") {
          const msg = String(message || (ok ? "已请求取消" : "DSH 任务取消")).slice(0, 2000);
          await this.hana.tasks.cancel(this.taskId, msg);
        } else if (ok) {
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
      // 终态回投失败：任务可能已被他方终态（App 卸载/取消/宿主已终态）——幂等语义，忽略并清映射
      this.note("任务终态回投失败（task=" + this.taskId + "）：" + ((e as any)?.message || e));
    } finally {
      try {
        // 终态只标记 ended，**不删文件**：删了就分不出“用户自建会话”与“我们建的但状态丢了”，
        // 而这两者在模型请求身份上是两种判定（见 provider/lib/identity.js 三态）。
        markTaskMapEnded(this.dataDir, this.sessionId, "task-terminal");
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
 * @param opts { ctx, hana, dataDir, log, serviceBaseUrl? , cancelModelRequests? }
 *   serviceBaseUrl —— 受管 DSH web 回环基址（宿主任务取消反向触发 session.cancel 用；
 *   缺省 = 不做反向 watch）；cancelModelRequests —— (sessionId) 定向模型取消（缺省回落
 *   lib/model-requests.js 实现）。
 * @returns 卸载函数（幂等）
 */
const BRIDGE_PRUNE_AT = 128; // bridges 有界（已终态条目在超限时清理）

/** startTaskBridge 的选项。 */
export interface TaskBridgeOptions {
  /** 宿主/受管 runtime 的 ctx（事件订阅面）。 */
  ctx: any;
  /** DSH hana 句柄（模型取消等反向调用）。 */
  hana: any;
  /** App dataDir（task-map 位置）。 */
  dataDir: string;
  log?: (msg: string) => void;
  /** 受管 DSH web 回环基址（缺省 = 不做反向 watch）。 */
  serviceBaseUrl?: string;
  bridgeKey?: string;
  /** 定向模型取消（缺省回落 lib/model-requests.ts 实现）。 */
  cancelModelRequests?: (sessionId: string) => unknown;
}

export function startTaskBridge({
  ctx,
  hana,
  dataDir,
  log,
  serviceBaseUrl,
  bridgeKey,
  cancelModelRequests,
}: TaskBridgeOptions): () => void {
  const offs: Array<() => void> = [];
  const bridges = new Map(); // sessionId → SessionBridge（终态后惰性清理）
  const doCancelModels = typeof cancelModelRequests === "function"
    ? cancelModelRequests
    : (sessionId) => cancelSessionModelRequests(hana, sessionId);
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
      let frame: DshEventFrame | null = null;
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
          b = new SessionBridge({ hana, dataDir, log, serviceBaseUrl, bridgeKey, cancelModelRequests: doCancelModels });
          b.sessionId = frame.sessionId;
          bridges.set(frame.sessionId, b);
        }
        void b.onFrame(frame).catch((e) => {
          try {
            log && log("[task-bridge] 帧处理失败：" + errText(e));
          } catch { /* 忽略 */ }
        });
      } catch (e) {
        try {
          log && log("[task-bridge] 事件分发异常：" + errText(e));
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
    for (const b of bridges.values()) {
      try { b.stopHostWatch(); } catch { /* 忽略 */ }
    }
    bridges.clear();
  };
  try {
    log && log("[task-bridge] 已挂载（" + BRIDGE_EVENTS.length + " 个会话事件订阅，事件→Hana task 回投）");
  } catch { /* 忽略 */ }
  return stop;
}

export { SessionBridge };
