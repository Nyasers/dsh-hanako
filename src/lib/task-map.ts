// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/task-map.ts — Hana taskId ↔ DSH session 运行映射
//
// 映射必须落在「App 主进程与受管 runtime 子进程都能读」的位置：子进程（task-bridge、
// approval-bridge、provider）只经 connectAppRuntime 拿到 tasks/models/network.fetch，
// **没有** App ctx.storage；因此 dataDir 文件是跨进程关联的事实源。
//
//   文件：<dataDir>/dshana/taskmaps/<dshSessionId>.json（sessionId 即文件名，天然隔离并发
//         会话，不存在共享的「全局当前任务」）
//   内容：{ taskId, dshSessionId, action: "create"|"send", rpcId, task?, at, ...协调字段 }
//   生命周期：create/send 在 session.prompt 提交**前**写入（事件/模型流只会在 prompt 之后
//         发生，先写后跑无竞态）；终态后只标记 ended，不删文件——删除会把「用户自建会话
//         （无映射）」与「我们建的会话但状态丢了」压成同一个信号，而这两者在模型请求身份
//         上是两种判定（见 src-cordis/…/identity.js 三态）。删除只由 prune 按 TTL 做。
//   清理：App 启动/写前对过期残留做 prune（崩溃残留不阻塞，旧条目按 TTL 清）。
//
// 为什么是文件而不是 ctx.storage：storage 只有 global 与 agent 两个 scope（无会话级），
// 且子进程读不到，不能作为跨进程事实源；storage.agent 留给「App 侧需要跨重启检索」的将来。
// callToken 硬约束：本模块只落 taskId/sessionId 等定位键，**绝不落 callToken**。
//
// 同一文件还承载工作单元级协调字段（写方 = App 主进程 submitDshTask / 取消链；受管 runtime
// 的 approval-bridge 与 task-bridge；同 DSH 会话由 App 串行化 + DSH 侧事件单飞，写冲突窗口
// 极小，仍一律原子写 + 读-改-写收敛，见 patchTaskMap/updateTaskMap）：
//   timeoutSec / approvalTimeoutMs —— 提交期快照（DSH 子进程读不到 App settings，经映射文件
//     下传；approvalTimeoutMs = 0 表示宿主不自动拒绝）
//   cancel: { at, reason }          —— 取消已请求标记（cancel 工具/执行超时写；task-bridge
//     终态时据此把 aborted 判成 hana.tasks.cancel 而非 fail——取消确认 = DSH 真中止之后）
//   approvals: [ ... ]              —— 本工作单元挂起的宿主审批（DSH approval/request →
//     hana.tasks.requestApproval 后由 approval-bridge 追加；App approve 经它校验会话归属/
//     去重并回填 answered；watch 对账以宿主审批记录为准，本表是定位与用户侧去重视图）
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";

export const TASK_MAP_REL_DIR = "dshana/taskmaps"; // 相对 dataDir
export const TASK_MAP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 崩溃残留清理 TTL（7 天）
export const APPROVAL_STATUS_PENDING = "pending";
export const APPROVAL_STATUS_ANSWERED = "answered";

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

/** 读取会话→任务映射；不存在/损坏返回 null（不抛）。
 *
 *  与 cordis 侧（provider/lib/taskmap.js）的差别是有意的：那边**损坏即抛**
 *  （模型请求身份不能把“状态丢了”当成“用户自建会话”）；这边容忍，因为调用方
 *  （prune / 诊断 / 终态标记 / 审批归属校验）对 null 一律 fail-closed。
 */
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

/** 删除会话→任务映射（只由 prune 调用；幂等）。
 *
 *  注意：终态**不**走这里——终态用 markTaskMapEnded 留痕。删了文件就分不清
 *  “用户自建的会话”和“我们建的会话但状态丢了”（见 identity.js 三态判定）。
 */
export function removeTaskMap(dataDir, dshSessionId) {
  if (!isValidSessionId(dshSessionId)) return;
  try {
    rmSync(taskMapPath(dataDir, dshSessionId), { force: true });
  } catch {
    /* 删除失败忽略（残留由 prune 清理） */
  }
}

/** 终态标记（task-bridge / 提交失败路径调用）：映射留着，只写 ended。
 *
 *  语义：ended 存在 ⇒ “这是我们建的会话，但那条任务已经终结”（用户在 WebUI 接着跑
 *  就是这种情形）；映射整个不存在 ⇒ “这不是我们建的会话”。
 *  映射缺失时不创建（不抛）。
 */
export function markTaskMapEnded(dataDir, dshSessionId, status) {
  const st = String(status || "terminal").slice(0, 40);
  return updateTaskMap(dataDir, dshSessionId, (cur) => ({
    ...cur,
    ended: { at: Date.now(), status: st },
  }));
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

/** 按 taskId 反查映射（句柄路径）。同名多条时活动（未 ended）优先，否则最新一条。
 *
 *  没命中返回 null：recycle / prune 过的旧任务就是这种情况，调用方必须显式失败，
 *  不能拿一个猜出来的会话继续操作。
 */
export function findTaskMapByTaskId(dataDir, taskId) {
  const want = String(taskId || "").trim();
  if (!want) return null;
  const all = listTaskMaps(dataDir); // 已按 at 降序
  return all.find((m) => m && m.taskId === want && !m.ended) || all.find((m) => m && m.taskId === want) || null;
}

/** 按 approvalId 反查映射（审批句柄路径）：返回该审批所在的会话记录（不管 pending 与否）。 */
export function findTaskMapByApprovalId(dataDir, approvalId) {
  const want = String(approvalId || "").trim();
  if (!want) return null;
  const all = listTaskMaps(dataDir);
  return (
    all.find((m) => Array.isArray(m.approvals) && m.approvals.some((a) => a && a.approvalId === want)) || null
  );
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
    if (j && typeof j.at === "number" && now - j.at >= olderThanMs) {
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
// ---- 映射补丁 / 取消标记 / 审批协调（原子读-改-写；跨进程共享同一文件）----

/** 原子写一条映射记录（.tmp + rename；entry 须含合法 dshSessionId）。 */
function atomicWriteEntry(dataDir, entry) {
  const p = taskMapPath(dataDir, entry.dshSessionId);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(entry), "utf8");
  renameSync(tmp, p);
}

/**
 * 读-改-写：对既有映射做一次更新（App/受管 runtime 两方共用）。fn 同步执行，
 * 可原地修改 entry 或返回新对象；映射缺失返回 null（不创建）。写失败抛错由调用方定夺。
 */
export function updateTaskMap(dataDir, dshSessionId, fn) {
  if (!isValidSessionId(dshSessionId)) return null;
  const cur = readTaskMap(dataDir, dshSessionId);
  if (!cur) return null; // 映射缺失：不创建
  if (typeof fn !== "function") return cur;
  const next = fn(cur);
  if (!next) return cur; // fn 返回 falsy = 放弃写入
  atomicWriteEntry(dataDir, next);
  return next;
}

/** 浅补丁合并（新增/覆盖键；数组字段整体替换由调用方给全量）。映射缺失返回 null。 */
export function patchTaskMap(dataDir, dshSessionId, patch) {
  if (!patch || typeof patch !== "object") return null;
  return updateTaskMap(dataDir, dshSessionId, (cur) => ({ ...cur, ...patch }));
}

/** 归一化审批记录（跨进程写入同一 schema）。 */
export function normalizeApproval(ap) {
  return {
    approvalId: String((ap && ap.approvalId) || ""),
    toolName: String((ap && ap.toolName) || "tool"),
    ...(ap && typeof ap.callId === "string" && ap.callId ? { callId: ap.callId } : {}),
    ...(ap && typeof ap.reason === "string" && ap.reason ? { reason: ap.reason } : {}),
    ...(ap && typeof ap.args === "string" && ap.args ? { args: ap.args } : {}),
    status: ap && ap.status === APPROVAL_STATUS_ANSWERED ? APPROVAL_STATUS_ANSWERED : APPROVAL_STATUS_PENDING,
    ...(ap && ap.outcome ? { outcome: String(ap.outcome) } : {}),
    at: (ap && typeof ap.at === "number") ? ap.at : Date.now(),
  };
}

/**
 * 追加一条挂起审批到会话映射（approval-bridge 收到 DSH approval/request 并取得宿主
 * approvalId 后调用）。approvalId 必填且非空；映射缺失返回 null。
 */
export function addApproval(dataDir, dshSessionId, ap) {
  const approvalId = String((ap && ap.approvalId) || "").trim();
  if (!approvalId) throw new Error("task-map: addApproval 需要非空 approvalId");
  return updateTaskMap(dataDir, dshSessionId, (cur) => {
    const list = Array.isArray(cur.approvals) ? cur.approvals.filter((a) => a && a.approvalId !== approvalId) : [];
    return { ...cur, approvals: [...list, normalizeApproval({ ...ap, approvalId })] };
  });
}

/** 标记审批已结算（App approve 应答成功 / approval-bridge watch 终态后回填）。 */
export function settleApproval(dataDir, dshSessionId, approvalId, outcome) {
  const id = String(approvalId || "").trim();
  if (!id) return null;
  return updateTaskMap(dataDir, dshSessionId, (cur) => {
    const list = Array.isArray(cur.approvals) ? cur.approvals : [];
    const idx = list.findIndex((a) => a && a.approvalId === id);
    if (idx < 0) return null; // 不在表：放弃写入（fn 返回 falsy 外层即不写）
    const next = list.slice();
    next[idx] = {
      ...next[idx],
      status: APPROVAL_STATUS_ANSWERED,
      outcome: outcome === "rejected" ? "rejected" : "allowed-once",
      at: Date.now(),
    };
    return { ...cur, approvals: next };
  });
}

/** 读一条挂起审批（approve 工具校验会话归属/去重用；已结算/不存在返回 null）。 */
export function findPendingApproval(entry, approvalId) {
  if (!entry || !Array.isArray(entry.approvals)) return null;
  const id = String(approvalId || "").trim();
  if (!id) return null;
  const ap = entry.approvals.find((a) => a && a.approvalId === id) || null;
  return ap && ap.status === APPROVAL_STATUS_PENDING ? ap : null;
}

/** 标记取消已请求（cancel 工具 / 执行超时调用；幂等覆盖 reason 与时间戳）。 */
export function markCancelRequested(dataDir, dshSessionId, reason) {
  return updateTaskMap(dataDir, dshSessionId, (cur) => ({
    ...cur,
    cancel: { at: Date.now(), reason: String(reason || "user").slice(0, 200) },
  }));
}

