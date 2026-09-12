// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/session-serialize.ts — 同 DSH session 提交串行化
//
// 背景：DSH 的 queue 模式接受并发 prompt 并把后到
// 的排队到当前 turn 之后；但任务回投/终态判定按「每 send = 一个新 Hana task」工作单元
// 推进，两个同时运行的同一 session 提交会互相消费对方的事件与终态。因此对同一 DSH
// session 的 create/send 做 App 进程内串行化：后到任务等前一个任务提交链路完全退出后
// 再执行，保留「同一会话顺序续跑」语义。
//
// 模块级 Map 键 = dshSessionId
// （create 在 session.create 返回前按新 sessionId 同步占位，防 create 返回后立即 send
// 重叠）。不同 session 互不共享队列。
const sessionTurnQueues = new Map();

export async function withSessionTurn(sessionKey, run) {
  const previous = sessionTurnQueues.get(sessionKey) || Promise.resolve();
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => gate);
  sessionTurnQueues.set(sessionKey, next);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (sessionTurnQueues.get(sessionKey) === next) {
      sessionTurnQueues.delete(sessionKey);
    }
  }
}

/**
 * create 路径在拿到新 sessionId 前同步占住该 session 队列槽位（尾部链；任务提交链路
 * 完全退出后释放），与 withSessionTurn 同尾链格式。
 * @returns 释放函数（幂等）
 */
export function enterSessionTurn(sessionKey) {
  if (sessionTurnQueues.has(sessionKey)) {
    throw new Error("dshana_session 内部错误：新会话 " + sessionKey + " 已有排队提交");
  }
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const next = Promise.resolve().then(() => gate);
  sessionTurnQueues.set(sessionKey, next);
  return () => {
    release();
    if (sessionTurnQueues.get(sessionKey) === next) {
      sessionTurnQueues.delete(sessionKey);
    }
  };
}
