// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/task-map.test.mjs — T7 映射读写单测（node:test，零依赖）
// 覆盖：宿主 scope 读写、按 taskId/session 双向查找、更新/解绑、审批追加、容量淘汰、
//       文件兜底跨实例可恢复（= 跨 execute 可恢复的最小证据）。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createScopeStore,
  createFileStore,
  bindTask,
  findTask,
  findTasksBySession,
  listTasks,
  unbindTask,
  addApproval,
  MAX_ENTRIES,
  TASK_MAP_KEY,
} from "../src/lib/task-map.js";

function fakeScope() {
  const mem = new Map();
  return {
    get: (k, fallback) => (mem.has(k) ? mem.get(k) : fallback),
    set: (k, v) => mem.set(k, v),
    delete: (k) => mem.delete(k),
    keys: () => [...mem.keys()],
    _mem: mem,
  };
}

test("bind/find：taskId 主键 + session 反查", () => {
  const store = createScopeStore(fakeScope());
  bindTask(store, { taskId: "t1", dshSessionId: "session-a", rpcId: "r1", kind: "create" });
  bindTask(store, { taskId: "t2", dshSessionId: "session-a", rpcId: "r2", kind: "send" });
  bindTask(store, { taskId: "t3", dshSessionId: "session-b", rpcId: "r3", kind: "create" });

  assert.equal(findTask(store, "t1").dshSessionId, "session-a");
  assert.equal(findTask(store, "nope"), null);
  const a = findTasksBySession(store, "session-a");
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((x) => x.taskId).sort(), ["t1", "t2"]);
  assert.equal(findTasksBySession(store, "session-b").length, 1);
  assert.equal(findTasksBySession(store, "missing").length, 0);
});

test("bind 更新：同 taskId 覆盖字段且保留 createdAt", () => {
  const store = createScopeStore(fakeScope());
  const first = bindTask(store, { taskId: "t1", dshSessionId: "session-a", kind: "create" });
  const second = bindTask(store, { taskId: "t1", rpcId: "r9", status: "running" });
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(second.dshSessionId, "session-a"); // 未提供的字段保留
  assert.equal(second.rpcId, "r9");
  assert.equal(listTasks(store).length, 1);
});

test("session 变更时旧索引被清理", () => {
  const store = createScopeStore(fakeScope());
  bindTask(store, { taskId: "t1", dshSessionId: "session-a" });
  bindTask(store, { taskId: "t1", dshSessionId: "session-b" });
  assert.equal(findTasksBySession(store, "session-a").length, 0);
  assert.equal(findTasksBySession(store, "session-b").length, 1);
});

test("unbind：删除主键与索引，重复删除返回 false", () => {
  const store = createScopeStore(fakeScope());
  bindTask(store, { taskId: "t1", dshSessionId: "session-a" });
  assert.equal(unbindTask(store, "t1"), true);
  assert.equal(findTask(store, "t1"), null);
  assert.equal(findTasksBySession(store, "session-a").length, 0);
  assert.equal(unbindTask(store, "t1"), false);
});

test("addApproval：追加 approvalId 且去重", () => {
  const store = createScopeStore(fakeScope());
  bindTask(store, { taskId: "t1", dshSessionId: "session-a" });
  addApproval(store, "t1", "ap1");
  const after = addApproval(store, "t1", "ap1");
  assert.deepEqual(after.approvalIds, ["ap1"]);
  assert.deepEqual(addApproval(store, "t1", "ap2").approvalIds, ["ap1", "ap2"]);
  assert.equal(addApproval(store, "missing", "ap1"), null);
});

test("容量上限：超过 MAX_ENTRIES 淘汰最旧（按 updatedAt）", () => {
  const store = createScopeStore(fakeScope());
  for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
    bindTask(store, { taskId: "t" + i, dshSessionId: "s" + i, updatedAt: new Date(1000 + i).toISOString() });
  }
  const all = listTasks(store);
  assert.equal(all.length, MAX_ENTRIES);
  assert.equal(findTask(store, "t0"), null); // 最旧被淘汰
  assert.ok(findTask(store, "t" + (MAX_ENTRIES + 4)));
});

test("文件兜底：跨实例可恢复（= 跨 execute 可恢复）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dshana-taskmap-"));
  try {
    const s1 = createFileStore(dir);
    bindTask(s1, { taskId: "t1", dshSessionId: "session-a", rpcId: "r1" });
    // 新实例（模拟下一次工具调用/进程重载）从磁盘读回
    const s2 = createFileStore(dir);
    const found = findTask(s2, "t1");
    assert.ok(found);
    assert.equal(found.dshSessionId, "session-a");
    assert.equal(found.rpcId, "r1");
    assert.equal(findTasksBySession(s2, "session-a").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("宿主 scope 单键布局：整表只占一个键", () => {
  const scope = fakeScope();
  const store = createScopeStore(scope);
  bindTask(store, { taskId: "t1", dshSessionId: "s1" });
  bindTask(store, { taskId: "t2", dshSessionId: "s2" });
  assert.deepEqual(scope.keys(), [TASK_MAP_KEY]);
});
