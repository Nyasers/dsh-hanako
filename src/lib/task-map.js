// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/task-map.js — Hana taskId ↔ DSH session/rpc 映射（spec D3/T7）
//
// 状态分层（用户定案 2026-09-08）：高频小 KV 走宿主接口，不落文件——
//   · 主存：ctx.storage.agent(agentId?) 的 per-Agent 私有 scope（无参调用由宿主解析当前
//     工具调用的 Agent；映射读写都发生在 execute 内，apply() 顶层不碰 storage）；
//   · 兜底：ctx.storage 不可用时落 dataDir/state.json（仅兑底路径；宿主文档明确
//     apply 顶层 storage 不可用，且单测/离线诊断需要一个不依赖 ctx 的实现）。
//
// 单键布局：一个 scope 内只用一个键（dsh.taskMap）承载整张表——读写各一次 get/set，
// 天然原子；per-task 键会让「按 session 反查」变成 O(n) keys() 扫描。容量上限 200 条，
// 超出按 updatedAt 淘汰最旧（映射可重建：sessionId 在 jsonl 里、taskId 在宿主任务表里）。
//
// 键的关系（guide §5 的表）：DSH sessionId 定位 DSH 会话/历史；Hana taskId 定位本次后台
// 工作与来源会话；rpcId 定位一次模型推理（取消用）；runtimeId 定位受管进程与 service 代理；
// approvalId 定位待批准操作。taskId 与 sessionId 不是同一个 ID，禁止从「当前焦点」推导。

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

export const TASK_MAP_KEY = "dsh.taskMap";
export const TASK_MAP_VERSION = 1;
export const MAX_ENTRIES = 200;

const emptyMap = () => ({ version: TASK_MAP_VERSION, byTask: {}, bySession: {} });

function normalize(raw) {
  if (!raw || typeof raw !== "object") return emptyMap();
  const byTask = raw.byTask && typeof raw.byTask === "object" ? raw.byTask : {};
  const bySession = raw.bySession && typeof raw.bySession === "object" ? raw.bySession : {};
  return { version: TASK_MAP_VERSION, byTask, bySession };
}

/** 纯作用域适配：只要求 { get(key, fallback?), set(key, value) }。 */
export function createScopeStore(scope) {
  if (!scope || typeof scope.get !== "function" || typeof scope.set !== "function") {
    throw new Error("createScopeStore：需要 { get, set } 形态的作用域");
  }
  return {
    read() {
      try {
        return normalize(scope.get(TASK_MAP_KEY, null));
      } catch {
        return emptyMap();
      }
    },
    write(map) {
      scope.set(TASK_MAP_KEY, map);
    },
    kind: "host-storage",
  };
}

/**
 * 文件兜底作用域（dataDir/state.json 的 dsh.taskMap 段；原子写：临时文件 + rename）。
 * 与宿主 scope 同接口，调用方无感切换。
 */
export function createFileStore(dataDir, { file = null } = {}) {
  const stateFile = file || join(dataDir, "state.json");
  const readAll = () => {
    try {
      const j = JSON.parse(readFileSync(stateFile, "utf8"));
      return j && typeof j === "object" ? j : {};
    } catch {
      return {};
    }
  };
  return {
    read() {
      const all = readAll();
      return normalize(all[TASK_MAP_KEY]);
    },
    write(map) {
      const all = readAll();
      all[TASK_MAP_KEY] = map;
      try {
        mkdirSync(dirname(stateFile), { recursive: true });
        const tmp = stateFile + "." + process.pid + ".tmp";
        writeFileSync(tmp, JSON.stringify(all, null, 2) + "\n", "utf8");
        rmSync(stateFile, { force: true });
        renameSync(tmp, stateFile);
      } catch {
        /* 兜底写失败：映射丢失不阻断任务链（sessionId 仍在 jsonl 中可重建） */
      }
    },
    kind: "file",
    file: stateFile,
  };
}

/**
 * 解析本次工具调用的映射作用域。
 * opts: { agentId?, dataDir? }——agentId 省略 = 宿主解析当前 Agent（per-Agent 私有）。
 * 优先 ctx.storage.agent；不可用（apply 顶层/测试/宿主旧版）回退 dataDir/state.json。
 */
export function resolveTaskStore(ctx, opts = {}) {
  try {
    const storage = ctx?.storage;
    if (storage && typeof storage.agent === "function") {
      const scope = opts.agentId ? storage.agent(opts.agentId) : storage.agent();
      if (scope && typeof scope.get === "function" && typeof scope.set === "function") {
        return createScopeStore(scope);
      }
    }
  } catch {
    /* 落到文件兜底 */
  }
  const dataDir = opts.dataDir || ctx?.dataDir;
  if (typeof dataDir !== "string" || !dataDir) {
    throw new Error("resolveTaskStore：ctx.storage 不可用且无 dataDir 可兜底");
  }
  return createFileStore(dataDir);
}

function touchIndex(map, entry) {
  const sid = entry.dshSessionId;
  if (!sid) return;
  const list = Array.isArray(map.bySession[sid]) ? map.bySession[sid] : [];
  if (!list.includes(entry.taskId)) list.push(entry.taskId);
  map.bySession[sid] = list;
}

function prune(map) {
  const tasks = Object.keys(map.byTask);
  if (tasks.length <= MAX_ENTRIES) return map;
  const sorted = tasks
    .map((id) => ({ id, at: map.byTask[id]?.updatedAt || "" }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const drop = sorted.slice(0, tasks.length - MAX_ENTRIES).map((x) => x.id);
  for (const id of drop) {
    const sid = map.byTask[id]?.dshSessionId;
    delete map.byTask[id];
    if (sid && Array.isArray(map.bySession[sid])) {
      map.bySession[sid] = map.bySession[sid].filter((t) => t !== id);
      if (map.bySession[sid].length === 0) delete map.bySession[sid];
    }
  }
  return map;
}

/**
 * 写入/更新一条映射（taskId 为主键；同 taskId 重复写 = 更新）。
 * entry: { taskId, dshSessionId?, rpcId?, runtimeId?, kind?, status?, cwd?, provider?, model?, approvalIds? }
 * 返回落库后的条目。
 */
export function bindTask(store, entry) {
  if (!entry || !entry.taskId) throw new Error("bindTask：entry.taskId 必填");
  const map = store.read();
  const prev = map.byTask[entry.taskId] || {};
  const next = {
    ...prev,
    ...entry,
    approvalIds: Array.isArray(entry.approvalIds)
      ? entry.approvalIds
      : Array.isArray(prev.approvalIds)
        ? prev.approvalIds
        : [],
    createdAt: prev.createdAt || entry.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // session 变更时清理旧索引（send 可能把同一 taskId 关联到同一 session，无副作用）
  if (prev.dshSessionId && prev.dshSessionId !== next.dshSessionId) {
    const list = map.bySession[prev.dshSessionId];
    if (Array.isArray(list)) {
      map.bySession[prev.dshSessionId] = list.filter((t) => t !== entry.taskId);
      if (map.bySession[prev.dshSessionId].length === 0) delete map.bySession[prev.dshSessionId];
    }
  }
  map.byTask[entry.taskId] = next;
  touchIndex(map, next);
  store.write(prune(map));
  return next;
}

/** 按 taskId 取映射（缺失 → null）。 */
export function findTask(store, taskId) {
  if (!taskId) return null;
  return store.read().byTask[taskId] || null;
}

/** 按 DSH sessionId 取该会话的全部任务映射（最新在前）。 */
export function findTasksBySession(store, sessionId) {
  if (!sessionId) return [];
  const map = store.read();
  const ids = Array.isArray(map.bySession[sessionId]) ? map.bySession[sessionId] : [];
  return ids
    .map((id) => map.byTask[id])
    .filter(Boolean)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** 全部映射（按 updatedAt 倒序；诊断/审计用）。 */
export function listTasks(store) {
  const map = store.read();
  return Object.values(map.byTask).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** 删除一条映射（任务终结后清理；返回是否删除）。 */
export function unbindTask(store, taskId) {
  const map = store.read();
  const prev = map.byTask[taskId];
  if (!prev) return false;
  delete map.byTask[taskId];
  const sid = prev.dshSessionId;
  if (sid && Array.isArray(map.bySession[sid])) {
    map.bySession[sid] = map.bySession[sid].filter((t) => t !== taskId);
    if (map.bySession[sid].length === 0) delete map.bySession[sid];
  }
  store.write(map);
  return true;
}

/** 追加一个 approvalId 到映射（审批协调态，第 3 步 approve 接线消费）。 */
export function addApproval(store, taskId, approvalId) {
  const cur = findTask(store, taskId);
  if (!cur) return null;
  const ids = Array.isArray(cur.approvalIds) ? cur.approvalIds.slice() : [];
  if (approvalId && !ids.includes(approvalId)) ids.push(approvalId);
  return bindTask(store, { ...cur, approvalIds: ids });
}

/** 文件兜底是否已启用（诊断用；主存为宿主 scope 时为 null）。 */
export function taskStoreInfo(store) {
  return { kind: store?.kind || "unknown", file: store?.file || null, key: TASK_MAP_KEY };
}
