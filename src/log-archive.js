// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/log-archive.js — 日志生命周期：旧日志归档压缩（vX 起独立于版本迁移）。
// 每次插件 onload 运行（建新会话文件之前），非版本迁移（migrate 体系已退役）。
// 旧日志策略（同 dsh session 持久化：全部保留，体积靠压缩）：把上一会话及更早的时间戳
// .log 用 Node 内置 node:zlib zstd 压缩为 .log.zst（标准 zstd 格式，magic 28b52ffd，任何
// zstd 工具/库可解），删除原 .log——全部保留不删除。另处理历史版本遗留的 latest.log 残留：
// 真实文件 rename 成时间戳日志名（随后走压缩），旧链接直接删（内容在真实文件里）。
// 幂等：已压缩的 .log.zst 不匹配正则自然跳过；latest.log 不存在时零动作；单个失败保留
// 原文件下次再试。须在建新会话文件之前执行（onload 调度先于 nextTimestampLogPath）。
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { join } from "node:path";

const LOG_NAME_RE = /^\d{8}-\d{6}(?:-\d+)?\.log$/;

/** 毫秒级时间戳（日志文件名与行前缀共用）：同一秒内多次会话天然不撞名 */
export function logFileStamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  const p3 = (n) => String(n).padStart(3, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p3(d.getMilliseconds())}`;
}

/** 下一个时间戳日志文件路径（now 毫秒级命名；极端同毫秒冲突加 -i 后缀） */
export function nextTimestampLogPath(logsDir) {
  const stamp = logFileStamp(new Date());
  let target = join(logsDir, stamp + ".log");
  let i = 1;
  while (existsSync(target)) {
    i += 1;
    target = join(logsDir, stamp + "-" + i + ".log");
  }
  return target;
}

/** 压缩旧日志（上一会话及更早的时间戳 .log → .log.zst，全部保留不删除） */
function compressArchivedLogs(logsDir) {
  let count = 0;
  try {
    if (!existsSync(logsDir)) return 0;
    for (const f of readdirSync(logsDir)) {
      if (!LOG_NAME_RE.test(f)) continue;
      const src = join(logsDir, f);
      try {
        const raw = readFileSync(src);
        writeFileSync(src + ".zst", zstdCompressSync(raw));
        unlinkSync(src);
        count += 1;
      } catch {
        /* 单个压缩失败跳过（保留原文件） */
      }
    }
  } catch {
    /* 扫描失败不阻断 */
  }
  return count;
}

/**
 * 归档旧日志（onload 每次运行执行）：latest.log 残留归档 + 时间戳 .log → .log.zst。
 * 返回 { archivedName, compressed } 供 onload 记日志。失败不抛出（内部逐项 try/catch）。
 */
export function archiveOldLogs(cfg) {
  const logsDir = join(cfg.dataDir, "logs");
  // 旧 latest.log 残留（历史版本遗留）：归档避免残留（内容保留，会被 zstd 压缩）；
  // 旧链接直接删（内容在真实文件里）
  const latest = join(logsDir, "latest.log");
  let archivedName = null;
  if (existsSync(latest)) {
    try {
      const st = lstatSync(latest);
      if (st.isSymbolicLink()) unlinkSync(latest);
      else {
        archivedName = nextTimestampLogPath(logsDir);
        renameSync(latest, archivedName);
      }
    } catch {
      /* 旧文件处理失败不阻断 */
    }
  }
  // 压缩旧日志（上一会话及更早的时间戳 .log → .log.zst，全部保留不删除）
  const compressed = compressArchivedLogs(logsDir);
  return { archivedName, compressed };
}
