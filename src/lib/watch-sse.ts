// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/watch-sse.ts — Hana tasks/approval watch SSE 消费
//
// 背景与分侧：watch(taskId/approvalId) 返回 SSE，
// 首条 snapshot（完整当前记录），后续 app-task（增量/终态记录）；缓冲溢出由服务端发 reset
// 事件（应重读快照对账）；断线重连应先 get() 对账再续 watch。**SSE 与 NDJSON 不是同一种
// 编码**：NDJSON（models.stream）是每行一个 JSON 对象；SSE 是 `event:/data:` 多行事件块，
// 不能复用 readNdjsonEvents。
//
// 消费侧判断（本刀结论 = 受管 runtime 子进程侧消费）：
//   · 需要「宿主审批 outcome → DSH approval/request 等待者」投递的，是受管 runtime 内的
//     approval-bridge（DSH 与 hana.tasks 同进程，只有它持有待应答的 ApprovalOutcome 承诺）；
//   · 需要「宿主 task canceled/aborted → DSH session.cancel」反向触发的，是受管 runtime 内
//     task-bridge 的宿主 watch（DSH 进程内才能向 DSH 发 cancel）；
//   · App 主进程不需要消费 SSE：应答走 ctx.tasks.respondApproval（结果即宿主权威），取消走
//     轮询 ctx.tasks.get（waitTaskTerminal），避免 App 侧再挂一条流。
//   两处消费都在子进程，故本模块打进受管 runtime bundle（src/runtime → ../lib 同图内联）。
//
// 容错纪律：watch 具体事件名/载荷字段以宿主 0.930.1 契约为准（本仓无宿主源码可核，
// 按指南措辞 snapshot/app-task/reset + AppTaskRecordV2 字段实现），解析层对未知事件名/
// 畸形 data 一律宽容降级（结构兜底）；断线重连指数退避；reset/断线都先 get() 对账；
// 记录终态判定与审批 outcome 映射独立成纯函数（可单测）。
export const TERMINAL_STATUSES = ["completed", "failed", "canceled", "aborted"];

/** 终态判定（纯函数）：宿主记录 status 是否已达终态。 */
export function recordIsTerminal(rec) {
  return !!(rec && TERMINAL_STATUSES.includes(String(rec.status)));
}

/** 审批终态 → ApprovalOutcome 投递判定（纯函数，防隐式放行）：
 *   allowed-once/rejected 按宿主 outcome 原样投给 DSH 等待者；
 *   终态无 outcome（被宿主在父任务结束/撤销时关闭）→ 'rejected'（fail closed）；
 *   未终态/无 approvalId → null（继续等）。 */
export function approvalOutcomeOf(rec) {
  if (!rec || !rec.approvalId) return null;
  if (rec.outcome === "allowed-once" || rec.outcome === "rejected") return rec.outcome;
  if (recordIsTerminal(rec)) return "rejected";
  return null;
}

/** 归一为记录对象（宽容：支持 {record}/{data}/{task}/{approval} 包装或裸记录）。 */
export function extractWatchRecord(obj) {
  if (!obj || typeof obj !== "object") return null;
  const pick = (v) => (v && typeof v === "object" ? v : null);
  for (const key of ["record", "task", "approval", "data"]) {
    const v = pick(obj[key]);
    if (v && (typeof v.taskId === "string" || typeof v.approvalId === "string")) return v;
  }
  if (typeof obj.taskId === "string" || typeof obj.approvalId === "string") return obj;
  return null;
}

/**
 * SSE 事件块解释（纯函数）：把一条事件（event 名 + data 文本）归成 watch 帧。
 * @returns { kind: 'snapshot'|'app-task'|'reset'|'other', record: object|null }
 *   snapshot —— 首条/对账后快照（当前完整记录）
 *   app-task —— 后续增量/终态记录（snapshot 与 app-task 的记录形态相同，消费方自行合并）
 *   reset   —— 缓冲溢出：应 get() 重读快照后继续
 */
export function interpretWatchFrame(eventName, dataText) {
  const name = String(eventName || "").toLowerCase();
  // reset 事件常不带 data：先按事件名判定
  if (name.includes("reset") || name.includes("resync")) return { kind: "reset", record: null };
  let obj = null;
  try {
    obj = JSON.parse(String(dataText == null ? "" : dataText).trim());
  } catch {
    return { kind: "other", record: null };
  }
  const record = extractWatchRecord(obj);
  const rawType = String((obj && obj.type) || (record && record.type) || "");
  const type = rawType.toLowerCase();
  const kinds = { snapshot: "snapshot", "app-task": "app-task", apptask: "app-task", task: "app-task", approval: "app-task", reset: "reset", resync: "reset" };
  if (kinds[type] === "reset") return { kind: "reset", record: null };
  if (name.includes("snapshot") || kinds[type] === "snapshot") return { kind: "snapshot", record };
  if (name.includes("task") || name.includes("approval") || kinds[type] === "app-task") {
    return { kind: "app-task", record };
  }
  if (record) return { kind: "app-task", record }; // 结构兜底（无 event 名/未知名）
  return { kind: "other", record: null };
}

/**
 * SSE 增量解码器（纯状态机，跨 chunk 余量）。用法：
 *   const dec = createSseDecoder();
 *   for await chunk: const evs = dec.push(text); // evs = 本段内完整事件
 *   const tail = dec.end();                      // flush 残留块（容忍无尾空行）
 * @returns {{ push(chunk: string): Event[], end(): Event[] }}  Event = { event?: string, data: string }
 */
export function createSseDecoder() {
  let pending = "";
  const normalize = (s) => String(s).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parseBlock = (block) => {
    const ev = { data: "" };
    for (const rawLine of block.split("\n")) {
      const line = rawLine.trimEnd();
      if (line.startsWith(":")) continue; // 注释/心跳
      if (line.startsWith("event:")) ev.event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        const piece = line.slice(5);
        ev.data = ev.data ? ev.data + "\n" + (piece.startsWith(" ") ? piece.slice(1) : piece) : (piece.startsWith(" ") ? piece.slice(1) : piece);
      }
      // id:/retry: 忽略
    }
    if (ev.data !== "" || ev.event !== undefined) return ev;
    return null;
  };
  return {
    push(chunk) {
      pending += normalize(chunk);
      const out = [];
      for (;;) {
        const idx = pending.indexOf("\n\n");
        if (idx < 0) break;
        const block = pending.slice(0, idx);
        pending = pending.slice(idx + 2);
        const ev = parseBlock(block);
        if (ev) out.push(ev);
      }
      return out;
    },
    end() {
      const rest = pending;
      pending = "";
      if (!rest.trim()) return [];
      const ev = parseBlock(rest);
      return ev ? [ev] : [];
    },
  };
}

/** 一次 watch Response 的消费（生成器）：把 Response body（ReadableStream bytes）解码成事件。 */
export async function* consumeWatchResponse(response, { signal } = {}) {
  if (!response || !response.body || typeof response.body.getReader !== "function") {
    throw new Error("watch: Response 无 body（宿主流不可读）");
  }
  const reader = response.body.getReader();
  const decoder = createSseDecoder();
  const text = new TextDecoder();
  try {
    for (;;) {
      if (signal && signal.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      const events = decoder.push(text.decode(value, { stream: true }));
      for (const ev of events) yield ev;
    }
    for (const ev of decoder.end()) yield ev;
  } finally {
    try { reader.cancel && (await reader.cancel()); } catch { /* 已断 */ }
  }
}

/**
 * watch + get 对账循环（受管 runtime 消费侧驱动）：拉一次 watch Response 并逐帧回调；
 * 事件为终态/回调返回 false 时结束；流结束/reset 都先 get() 对账（snapshot 帧回调）
 * 再重连（指数退避）；isStopped() 为真时退出。所有注入（watch/get/onFrame/log）便于单测。
 * @param opts { watch, get, onFrame(rec, kind), shouldStop(), log?, retryBaseMs?, maxRetryMs? }
 * @returns 'stopped'|'terminal'|'failed'
 */
export async function runWatchReconcile(opts) {
  const { watch, get, onFrame, shouldStop, log } = opts || {};
  if (typeof watch !== "function" || typeof get !== "function" || typeof onFrame !== "function") {
    throw new Error("watch-sse: runWatchReconcile 需要 watch/get/onFrame 注入");
  }
  const retryBase = Number(opts.retryBaseMs) > 0 ? Number(opts.retryBaseMs) : 1000;
  const maxRetry = Number(opts.maxRetryMs) > 0 ? Number(opts.maxRetryMs) : 15000;
  let retry = 0;
  for (;;) {
    if (shouldStop && shouldStop()) return "stopped";
    // 对账：先 get 快照（首连与每次重连/断线）
    let snapshot = null;
    try {
      snapshot = await get();
    } catch (e) {
      note(log, "get() 对账失败：" + ((e && e.message) || e));
    }
    if (snapshot) {
      let keep = true;
      try { keep = (await onFrame(snapshot, "snapshot")) !== false; } catch (e) { note(log, "snapshot 帧处理异常：" + ((e && e.message) || e)); }
      if (!keep) return "terminal";
    }
    if (shouldStop && shouldStop()) return "stopped";
    let res = null;
    try {
      res = await watch();
    } catch (e) {
      note(log, "watch 连接失败（稍后重连）：" + ((e && e.message) || e));
      await backoff(() => shouldStop && shouldStop(), retry, retryBase, maxRetry, log);
      retry += 1;
      continue;
    }
    let settledByStream = false;
    let resetSeen = false;
    try {
      for await (const ev of consumeWatchResponse(res)) {
        if (shouldStop && shouldStop()) return "stopped";
        const frame = interpretWatchFrame(ev.event, ev.data);
        if (frame.kind === "reset") {
          // 缓冲溢出：中断当前流 → 外层循环先 get() 对账重读快照再续 watch
          note(log, "watch reset（缓冲溢出）——get() 对账重读快照");
          resetSeen = true;
          break;
        }
        if (frame.kind === "snapshot" || frame.kind === "app-task") {
          if (!frame.record) continue;
          let keep = true;
          try { keep = (await onFrame(frame.record, frame.kind)) !== false; } catch (e) { note(log, "记录帧处理异常：" + ((e && e.message) || e)); }
          if (!keep) { settledByStream = true; break; }
        }
      }
    } catch (e) {
      note(log, "watch 流中断：" + ((e && e.message) || e));
    }
    if (settledByStream) return "terminal";
    if (resetSeen) continue; // 外层 while：先 get() 对账（快照回调）再重连 watch
    if (shouldStop && shouldStop()) return "stopped";
    await backoff(() => shouldStop && shouldStop(), retry, retryBase, maxRetry, log);
    retry += 1;
  }
}

function backoff(_isStopped, retry, base, max, _log) {
  const ms = Math.min(base * 2 ** Math.min(retry, 6), max);
  return sleep(ms);
}
function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
function note(log, msg) {
  try { if (typeof log === "function") log("[watch-sse] " + msg); } catch { /* 忽略 */ }
}
