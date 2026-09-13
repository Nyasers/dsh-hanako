// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/plugins/provider/lib/taskmap.js — 会话→任务映射读取（provider 子集）
//
// App 主进程（src/lib/task-map.js）在 session.prompt 提交前把 { taskId, dshSessionId,
// action, rpcId, at } 写成 <dataDir>/dshana/taskmaps/<sessionId>.json（单一事实源，决策 C）。
// provider adapter 需要给 models.stream 提供 taskId 作宿主 scope（任务属主校验）：DSH 侧
// 经 options.sessionId（dshSessionId）反查同一文件。dataDir = 受管 runtime 进程 env 的
// DSHANA_HOME（main.js 设置）。子进程与 App 共用该目录（runtime writeRoots 含 dataDir）。
// 本模块是 src/lib/task-map.js 的只读子集（cordis 构建树不 import src/lib）。
// 零依赖纯函数。

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const SESSION_ID_RE = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** dataDir（process.env.DSHANA_HOME，main.js 设置）→ 任务映射目录。 */
export function taskMapDir(dataDir) {
  return join(dataDir, "dshana", "taskmaps");
}

/** 读取会话任务映射；不存在/损坏/格式不合法返回 null（不抛）。 */
export function readTaskMap(dataDir, sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return null;
  try {
    const p = join(taskMapDir(dataDir), sessionId + ".json");
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (!j || typeof j.taskId !== "string" || !j.taskId) return null;
    if (typeof j.dshSessionId !== "string" || !SESSION_ID_RE.test(j.dshSessionId)) return null;
    return j;
  } catch {
    return null;
  }
}
