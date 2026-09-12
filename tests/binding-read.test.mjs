// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/binding-read.test.mjs — "投影优先、文件回落"的读法（bindingStateOf）。
//
// 为什么要有回落：绑定事件的落点是会话事件日志，投影在 DSH 进程内折叠；但投影落地之前建的
// 老会话没有那条事件，只能读私有映射文件。两条路同源（都由控制面认领写入），所以谁先读到都行，
// 区别只在"要不要碰文件"。
import test from "node:test";
import assert from "node:assert/strict";
import { BINDING_KEY, bindingStateOf } from "../src/lib/binding-slot.ts";

/** 造一个 fake cordis ctx：只实现 get("sessionProjections") / get("sessions")。 */
function fakeCtx({ projection, sessions } = {}) {
  return {
    get(name) {
      if (name === "sessionProjections") return projection;
      if (name === "sessions") return sessions;
      return null;
    },
  };
}

const BOUND = { taskId: "task-1", rpcId: "rpc-9", timeoutSec: 60, approvalTimeoutMs: 30000, ended: null, cancel: null, at: 3 };

test("投影能读到（带 taskId）→ 直接返回，不碰文件", () => {
  let fileReads = 0;
  const session = { id: "session-1" };
  const ctx = fakeCtx({ projection: { stateOf: (s, key) => (s === session && key === BINDING_KEY ? BOUND : undefined) } });
  const got = bindingStateOf(ctx, "session-1", session, () => {
    fileReads += 1;
    return null;
  });
  assert.deepEqual(got, BOUND);
  assert.equal(fileReads, 0, "投影命中就不该读文件");
});

test("投影未注册（能力缺席）→ 回落文件", () => {
  const ctx = fakeCtx({ sessions: { get: () => ({ id: "session-1" }) } });
  const got = bindingStateOf(ctx, "session-1", null, () => ({ taskId: "task-legacy" }));
  assert.equal(got.taskId, "task-legacy");
});

test("投影有单元但这条会话没认领过（无 taskId）→ 回落文件", () => {
  const ctx = fakeCtx({
    projection: { stateOf: () => ({ ...BOUND, taskId: null }) },
    sessions: { get: () => ({ id: "session-1" }) },
  });
  const got = bindingStateOf(ctx, "session-1", null, () => ({ taskId: "task-legacy" }));
  assert.equal(got.taskId, "task-legacy");
});

test("会话不在场且拿不到 session 对象 → 回落文件（不抛）", () => {
  const ctx = fakeCtx({ projection: { stateOf: () => BOUND } });
  const got = bindingStateOf(ctx, "session-1", null, () => ({ taskId: "task-legacy" }));
  assert.equal(got.taskId, "task-legacy");
});

test("stateOf 抛错 → 不致命，仍回落文件", () => {
  const ctx = fakeCtx({
    projection: {
      stateOf: () => {
        throw new Error("宿主内部错");
      },
    },
    sessions: { get: () => ({ id: "session-1" }) },
  });
  const got = bindingStateOf(ctx, "session-1", null, () => ({ taskId: "task-legacy" }));
  assert.equal(got.taskId, "task-legacy");
});

test("没给回落函数 → 返回 null（不是 undefined，调用方按 null 判）", () => {
  const ctx = fakeCtx({});
  assert.equal(bindingStateOf(ctx, "session-1", null), null);
  assert.equal(bindingStateOf(null, "session-1", null), null);
});

test("给了 session 对象就不再走 sessions.get（省一次查表）", () => {
  let sessionsGets = 0;
  const ctx = {
    get(name) {
      if (name === "sessions") {
        sessionsGets += 1;
        return { get: () => null };
      }
      if (name === "sessionProjections") return { stateOf: () => BOUND };
      return null;
    },
  };
  const got = bindingStateOf(ctx, "session-1", { id: "session-1" }, () => null);
  assert.equal(got.taskId, "task-1");
  assert.equal(sessionsGets, 0);
});
