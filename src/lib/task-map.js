// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/task-map.js — Hana taskId ↔ DSH session 运行映射（App v2 步骤 3，决策 C）
//
// 六映射表（迁移指南 §5）的步骤 3 子集：taskId ↔ dshSessionId（↔ rpcId 定位键）。映射
// 必须落「App 主进程与受管 runtime 子进程都能读」的位置——子进程（DSH 事件→Hana task
// 回投的 task-bridge）只经 connectAppRuntime 拿到 tasks/models/network.fetch，**没有**
// App ctx.storage；因此 dataDir 文件是跨进程关联的单一事实源：
//
//   文件：<dataDir>/dshana/taskmaps/<dshSessionId>.json（sessionId 即文件名，天然隔离
//         并发会话，不存在共享「全局当前任务」——决策 D）
//   内容：{ taskId, dshSessionId, action: "create"|"send", rpcId, task?, at }
//   生命周期：create/send 在 session.prompt 提交**前**写入（事件/模型流只会在 prompt 后
//         发生，先写后跑无竞态）；task-bridge 终态（complete/fail）后删除。
//   清理：App 启动/写前对过期残留做 prune（崩溃残留不阻塞，旧条目按 TTL 清）。
//
// 取舍（决策 C，详见 DESIGN「步骤 3 架构决策」）：ctx.storage.agent 有 512KB 软限/16MB
// 硬限，且子进程读不到，不能作为跨进程事实源；本刀不复刻「storage 镜像副本」——单一
// 事实源只有 dataDir 文件，避免双写漂移。storage.agent 仅当未来 App 侧需要跨重启检索
// 任务/会话关系时再补索引。callToken 硬约束（指南 §5）：本模块只落 taskId/sessionId 等
// 定位键，**绝不落 callToken**。
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

export const TASK_MAP_REL_DIR = "dshana/taskmaps"; // 相对 dataDir
export const TASK_MAP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 崩溃残留清理 TTL（7 天）

/** dshSessionId 形态校验（与 tools/subtool/query.js 同正则，防路径穿越/畸形名）。 */
const SESSION_ID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidSessionId(sessionId) {
  return typeof sessionId === "string" && SESSION_ID_RE.test(sessionId);
}

export function taskMapDir(dataDir) {
  return join(dataDir, ...TASK_MAP_REL_DIR.split("/"));
}

export function taskMapPath(dataDir, dshSessionId) {
  if (!isValidSessionId(dshSessionId)) {
    throw new Error("task-map: 非法 dshSessionId：" + String(dshSessionId));
  }
  return join(taskMapDir(dataDir), dshSessionId + ".json");
}

/**
 * 写入会话→任务映射（create/send 提交前调用）。原子写（先写同目录 .tmp 再 rename）；
 * 写失败抛错由调用方决定（映射是任务回投的必要前提，失败应视为提交失败）。
 */
export function writeTaskMap(dataDir, entry) {
  const rec = {
    taskId: String((entry && entry.taskId) || ""),
    dshSessionId: String((entry && entry.dshSessionId) || ""),
    action: entry && entry.action === "send" ? "send" : "create",
    rpcId: String((entry && entry.rpcId) || ""),
    at: Date.now(),
  };
  if (!rec.taskId || !isValidSessionId(rec.dshSessionId)) {
    throw new Error("task-map: taskId 与 dshSessionId 必填且格式合法");
  }
  if (entry && typeof entry.task === "string" && entry.task) {
    rec.task = entry.task.slice(0, 500);
  }
  const p = taskMapPath(dataDir, rec.dshSessionId);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(rec), "utf8");
  renameSync(tmp, p);
  return rec;
}

/** 读取会话→任务映射；不存在/损坏返回 null（不抛）。 */
export function readTaskMap(dataDir, dshSessionId) {
  if (!isValidSessionId(dshSessionId)) return null;
  try {
    const p = taskMapPath(dataDir, dshSessionId);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (!j || typeof j.taskId !== "string" || !j.taskId) return null;
    if (!isValidSessionId(String(j.dshSessionId || ""))) return null;
    return j;
  } catch {
    return null;
  }
}

/** 删除会话→任务映射（task-bridge 终态后调用；幂等）。 */
export function removeTaskMap(dataDir, dshSessionId) {
  if (!isValidSessionId(dshSessionId)) return;
  try {
    rmSync(taskMapPath(dataDir, dshSessionId), { force: true });
  } catch {
    /* 删除失败忽略（残留由 prune 清理） */
  }
}

/** 列出全部映射（诊断/恢复用；按 at 降序）。 */
export function listTaskMaps(dataDir) {
  const dir = taskMapDir(dataDir);
  let names = [];
  try {
    names = existsSync(dir) ? readdirSync(dir) : [];
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const j = readTaskMap(dataDir, n.slice(0, -".json".length));
    if (j) out.push(j);
  }
  out.sort((a, b) => (b.at || 0) - (a.at || 0));
  return out;
}

/** 清理过期残留（默认 7 天 TTL；损坏条目一并清；返回清除条数）。 */
export function pruneTaskMaps(dataDir, olderThanMs = TASK_MAP_TTL_MS) {
  let removed = 0;
  const dir = taskMapDir(dataDir);
  let names = [];
  try {
    names = existsSync(dir) ? readdirSync(dir) : [];
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const sessionId = n.slice(0, -".json".length);
    const j = readTaskMap(dataDir, sessionId);
    if (j && typeof j.at === "number" && now - j.at > olderThanMs) {
      removeTaskMap(dataDir, sessionId);
      removed += 1;
    } else if (!j) {
      // 损坏/半写残留也清（不构成回投前提）
      removeTaskMap(dataDir, sessionId);
      removed += 1;
    }
  }
  return removed;
}
