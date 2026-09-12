// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/task-map.test.mjs — src/lib/task-map.js 映射表读写单测（node --test）
// 覆盖：路径布局/合法性、原子写读删、损坏容错、prune TTL 清理、callToken 不落盘语义。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidSessionId,
  taskMapDir,
  taskMapPath,
  writeTaskMap,
  readTaskMap,
  removeTaskMap,
  markTaskMapEnded,
  addApproval,
  findTaskMapByTaskId,
  findTaskMapByApprovalId,
  listTaskMaps,
  pruneTaskMaps,
} from "../src/lib/task-map.ts";

const SID = "session-11111111-2222-3333-4444-555555555555";
let dir;
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dshana-taskmap-"));
});
test.afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("sessionId 校验：session-<uuid> 才合法（防路径穿越）", () => {
  assert.equal(isValidSessionId(SID), true);
  assert.equal(isValidSessionId("session-abc"), false);
  assert.equal(isValidSessionId("../../etc/passwd"), false);
  assert.equal(isValidSessionId(""), false);
  assert.equal(isValidSessionId(SID.toUpperCase()), true);
});

test("路径布局：dataDir/dshana/taskmaps/<sessionId>.json", () => {
  assert.ok(taskMapPath(dir, SID).endsWith(join("dshana", "taskmaps", SID + ".json")));
  assert.throws(() => taskMapPath(dir, "bad-id"), /非法 dshSessionId/);
});

test("写读删：原子写 + 回读 + 幂等删", () => {
  const rec = writeTaskMap(dir, { taskId: "task-1", dshSessionId: SID, action: "create", rpcId: "r_1", task: "hello" });
  assert.equal(rec.dshSessionId, SID);
  assert.ok(typeof rec.at === "number");
  const j = JSON.parse(readFileSync(taskMapPath(dir, SID), "utf8"));
  assert.equal(j.taskId, "task-1");
  // 映射文件不含 callToken（硬约束：callToken 不落盘）
  assert.equal("callToken" in j, false);
  const got = readTaskMap(dir, SID);
  assert.equal(got.taskId, "task-1");
  assert.equal(got.action, "create");
  removeTaskMap(dir, SID);
  assert.equal(readTaskMap(dir, SID), null);
  removeTaskMap(dir, SID); // 幂等
});

test("send action 保留 + 缺省回落 create", () => {
  const a = writeTaskMap(dir, { taskId: "t2", dshSessionId: SID, action: "send" });
  assert.equal(a.action, "send");
  removeTaskMap(dir, SID);
  const b = writeTaskMap(dir, { taskId: "t3", dshSessionId: SID });
  assert.equal(b.action, "create");
});

test("损坏/半写文件：read 返回 null、list 跳过、prune 清除", () => {
  writeTaskMap(dir, { taskId: "t1", dshSessionId: SID });
  const bad = "session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  writeFileSync(taskMapPath(dir, bad), "{broken", "utf8");
  assert.equal(readTaskMap(dir, bad), null);
  assert.equal(listTaskMaps(dir).length, 1);
  assert.ok(pruneTaskMaps(dir, 0) >= 1);
  assert.equal(readTaskMap(dir, SID), null); // 0 TTL：全部过期清除
});

test("终态标记：ended 写入且**不删文件**（与删除语义区分开）", () => {
  writeTaskMap(dir, { taskId: "t1", dshSessionId: SID });
  const before = existsSync(taskMapPath(dir, SID));
  assert.equal(before, true);
  const after = markTaskMapEnded(dir, SID, "task-terminal");
  assert.equal(after.ended.status, "task-terminal");
  assert.ok(typeof after.ended.at === "number");
  assert.equal(existsSync(taskMapPath(dir, SID)), true, "终态不删文件（删了就分不出用户会话与状态丢失）");
  const got = readTaskMap(dir, SID);
  assert.equal(got.taskId, "t1");
  assert.equal(got.ended.status, "task-terminal");
  // 终态后重新 send（重建记录）⇒ ended 消失（先写后跑，无克态）
  const fresh = writeTaskMap(dir, { taskId: "t2", dshSessionId: SID, action: "send" });
  assert.equal("ended" in fresh, false);
  assert.equal("ended" in readTaskMap(dir, SID), false);
  // 映射缺失时不创建（幂等且不报错）
  assert.equal(markTaskMapEnded(dir, "session-99999999-8888-7777-6666-555555555555"), null);
  // prune 仍能按 TTL 收走（终态不等于永久滞留）
  assert.ok(pruneTaskMaps(dir, 0) >= 1);
});

test("句柄反查：findTaskMapByTaskId（活动优先）/ findTaskMapByApprovalId", () => {
  const other = "session-bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
  writeTaskMap(dir, { taskId: "task-1", dshSessionId: SID, action: "create" });
  writeTaskMap(dir, { taskId: "task-2", dshSessionId: other, action: "create" });
  addApproval(dir, other, { approvalId: "ap-1", toolName: "bash" });

  assert.equal(findTaskMapByTaskId(dir, "task-1").dshSessionId, SID);
  assert.equal(findTaskMapByTaskId(dir, "task-2").dshSessionId, other);
  assert.equal(findTaskMapByTaskId(dir, "nope"), null, "找不到必须显式 null（调用方给明确错误）");
  assert.equal(findTaskMapByTaskId(dir, ""), null);

  assert.equal(findTaskMapByApprovalId(dir, "ap-1").dshSessionId, other);
  assert.equal(findTaskMapByApprovalId(dir, "ap-none"), null);

  // 活动（未 ended）优先：同名任务的新映射把旧的比下去
  markTaskMapEnded(dir, SID, "task-terminal");
  writeTaskMap(dir, { taskId: "task-1", dshSessionId: other, action: "send" });
  assert.equal(findTaskMapByTaskId(dir, "task-1").dshSessionId, other, "活动那条优先");
  // 全部都 ended 时仍然能查到（取最新一条，供 get/诊断用）
  markTaskMapEnded(dir, other, "task-terminal");
  assert.equal(findTaskMapByTaskId(dir, "task-1").dshSessionId, other);
});

test("prune：TTL 保留新鲜、清过期", () => {
  writeTaskMap(dir, { taskId: "fresh", dshSessionId: SID });
  const old = "session-cccccccc-dddd-eeee-ffff-111111111111";
  writeTaskMap(dir, { taskId: "old", dshSessionId: old });
  // 手工把 old 的 at 拨回 8 天前
  const p = taskMapPath(dir, old);
  const j = JSON.parse(readFileSync(p, "utf8"));
  j.at = Date.now() - 8 * 24 * 60 * 60 * 1000;
  writeFileSync(p, JSON.stringify(j), "utf8");
  const removed = pruneTaskMaps(dir);
  assert.ok(removed >= 1);
  assert.equal(readTaskMap(dir, old), null);
  assert.equal(readTaskMap(dir, SID).taskId, "fresh");
});
