// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/legacy-migrate.js — dsh-hanako 旧插件（v1）数据迁移逻辑（纯 node 内置依赖）
//
// 目标（迁移指南 §12 / DESIGN「步骤 4b/5 收口」）：旧插件数据布局
//   <hanakoHome>/plugin-data/dsh-hanako/{dsh-home, logs, config.json, node_modules, pnpm-dist}
// 迁入 App v2 数据区 ctx.dataDir = <hanakoHome>/app-data/dsh-hanako/，使：
//   · dsh-home/{sessions, storages, settings.yaml, .anonymous-user-id} → dataDir/dsh-home/…
//     （DSH_HOME 指向 dataDir/dsh-home，见 src/runtime/main.js env 设置——同 v1 语义）
//   · logs/* → dataDir/logs/*（App 统一日志同目录，时间戳文件不重名）
//   · config.json（v1 全局设置）→ 参考拷贝 dataDir/legacy-config.json + 映射建议输出
//     （v2 设置存宿主 preferences（contributes.settings 经 ctx.config），脚本不代写宿主态）
//   · profiles/dshana **不复制**：其 node_modules/@dsh-hanako 是 junction/拷贝指向 v1 插件
//     安装目录（已过时）；v2 每次受管 runtime 启动经 seed.js 用 installDir cordis/ 自愈重建
//     （junction 指向只读目录可读）。迁移后 v2 首个 runtime 启动即重新种子化 profile。
//
// 纪律：
//   · 源（旧插件数据）只读——备份是"复制到目标数据区的独立备份"，绝不删/改旧数据
//     （回退材料 = 旧插件数据原地保留；旧插件停用不删除）。
//   · 不覆盖唯一备份：备份目录已存在（内容非空）即跳过，换后缀新建，绝不覆盖旧备份。
//   · 幂等：目标 dataDir/dshana/migrated.json（source+at+stats+backupDir）存在且 source
//     一致 → already-migrated（--force 才允许覆盖目标重跑，仍不动源）。
//   · 停机指引（真机执行时主上下文与姐姐协调）：迁移窗口内旧插件应停止写入——脚本容忍
//     只读拷贝（jsonl 追加竞态最坏 = 尾部半行，DSH 读取侧逐行容错），但会话正被写时
//     拷贝数量/内容可能与最后实际不符；正式迁移前先停旧 DSH/会话写入再执行。
//   · Windows：路径统一 path.join/原生分隔符；junction 不在复制范围（profiles 跳过）；
//     node_modules/pnpm-dist（含 .node 原生文件）不复制（App 依赖走 dataDir/runtime 区，
//     pnpm 重装，旧文件锁不构成迁移阻塞）。日志/会话文件拷贝遇 native 文件锁只在旧插件
//     仍在跑时可能出现——同"停机指引"。
//
// 本模块 = 纯逻辑/只读验证（plan/verify/suggestion/marker），可单测；真实拷贝只发生在
// CLI（scripts/migrate-legacy.mjs --apply）——本刀不真跑（旧插件数据是活的）。
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

export const LEGACY_SUBDIR = "dsh-hanako"; // plugin-data 下的旧插件数据目录名
export const LEGACY_PLUGIN_DATA_REL = path.join("plugin-data", LEGACY_SUBDIR);
export const DSH_HOME_NAME = "dsh-home";

// 复制条目（v1 dsh-home 顶层；profiles 由 v2 seed 自愈重建——见头注释）
export const DSH_HOME_COPY_ENTRIES = [
  { name: "sessions", kind: "dir" },
  { name: "storages", kind: "dir" },
  { name: "settings.yaml", kind: "file" },
  { name: ".anonymous-user-id", kind: "file" },
];
export const DSH_HOME_SKIP_NAMES = ["profiles"];
export const MARKER_REL = path.join("dshana", "migrated.json");

export const legacyRootOf = (hanakoHome) => path.join(hanakoHome, LEGACY_PLUGIN_DATA_REL);
export const legacyDshHomeOf = (legacyRoot) => path.join(legacyRoot, DSH_HOME_NAME);
export const targetDshHomeOf = (dataDir) => path.join(dataDir, DSH_HOME_NAME);
export const markerPathOf = (dataDir) => path.join(dataDir, MARKER_REL);

/** 读迁移标记；缺失/坏 JSON 返回 null（fail-safe，不抛）。 */
export function readMigrationMarker(dataDir) {
  try {
    const j = JSON.parse(readFileSync(markerPathOf(dataDir), "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

/** 写迁移标记（原子：tmp+rename）。 */
export function writeMigrationMarker(dataDir, marker) {
  mkdirSync(path.dirname(markerPathOf(dataDir)), { recursive: true });
  const tmp = markerPathOf(dataDir) + ".tmp";
  writeFileSync(tmp, JSON.stringify(marker, null, 2) + "\n", "utf8");
  renameSync(tmp, markerPathOf(dataDir));
}

/** 统计会话数：dshHome/sessions/** 下含 session.jsonl.zstd 的目录数。 */
export function countSessions(dshHome) {
  const sessionsDir = path.join(dshHome, "sessions");
  let dirs = 0;
  let total = 0;
  const walk = (dir) => {
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of list) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name === "session.jsonl.zstd") {
        total += 1;
        dirs += 1;
      }
    }
  };
  walk(sessionsDir);
  return { sessionFiles: total, sessionDirs: dirs };
}

/** 校验会话存储 JSON（workspace.json/session_projcache.json 若存在且可解析）。 */
export function checkSessionStoreFiles(dshHome) {
  const out = [];
  for (const name of ["workspace.json", "session_projcache.json"]) {
    const p = path.join(dshHome, "storages", name);
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      out.push({ file: name, ok: true, keys: Object.keys(j).slice(0, 8) });
    } catch (e) {
      out.push({ file: name, ok: false, error: String((e && e.message) || e).slice(0, 160) });
    }
  }
  return out;
}

/**
 * 迁移计划（只读分析；不执行任何拷贝）。返回：
 * { state, legacyRoot, dataDir, steps[], warnings[], reason?, sourceInfo? }
 * state: 'no-source' | 'already-migrated' | 'target-present' | 'plan'
 */
export function planLegacyMigration({ legacyRoot, dataDir, force = false }) {
  const warnings = [];
  if (!legacyRoot || !dataDir) {
    return { state: "no-source", reason: "legacyRoot/dataDir 必填", warnings };
  }
  const legacyDshHome = legacyDshHomeOf(legacyRoot);
  if (!existsSync(legacyDshHome) || !statSync(legacyDshHome).isDirectory()) {
    return {
      state: "no-source",
      legacyRoot,
      dataDir,
      reason: "旧插件数据源不存在：" + legacyDshHome,
      warnings,
    };
  }
  const marker = readMigrationMarker(dataDir);
  if (marker && !force && marker.source === legacyRoot) {
    return {
      state: "already-migrated",
      legacyRoot,
      dataDir,
      marker,
      warnings: warnings.concat([
        "已迁移（migrated.json source=" + marker.source + "）。旧插件数据保持原样可回退；需重跑用 --force（不删除旧备份）。",
      ]),
    };
  }
  if (marker && marker.source !== legacyRoot) {
    warnings.push("发现旧标记指向 " + marker.source + "（当前源 " + legacyRoot + " 不同）——按新源重新规划，不覆盖已迁移备份。");
  }
  const targetDshHome = targetDshHomeOf(dataDir);
  const targetHas = DSH_HOME_COPY_ENTRIES.some(({ name }) => {
    const p = path.join(targetDshHome, name);
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  });
  const steps = [];
  if (targetHas) {
    if (!force) {
      return {
        state: "target-present",
        legacyRoot,
        dataDir,
        reason: "目标 dataDir/dsh-home 已有数据（可能已迁移或 v2 已使用）。不带 --force 拒绝覆盖——请先确认真实来源。",
        warnings,
      };
    }
    warnings.push("目标已存在数据且 --force：覆盖式重跑（仍不动源与旧备份）。");
  }
  // backup 目录（目标数据区内；唯一备份不覆盖）
  const backupDir = path.join(dataDir, "migration-backup");
  if (existsSync(backupDir)) {
    warnings.push("备份目录已存在：" + backupDir + "（不覆盖唯一备份；内容将被跳过）。");
  }
  steps.push({ step: "backup", from: legacyDshHome, to: backupDir, note: "旧数据只读复制到目标数据区备份（唯一；存在即跳过，不覆盖）。" });
  for (const { name, kind } of DSH_HOME_COPY_ENTRIES) {
    const from = path.join(legacyDshHome, name);
    if (!existsSync(from)) {
      warnings.push("源缺少 " + name + "（kind=" + kind + "）——跳过该条目");
      continue;
    }
    steps.push({ step: "copy", kind, from, to: path.join(targetDshHome, name) });
  }
  const legacyLogs = path.join(legacyRoot, "logs");
  if (existsSync(legacyLogs)) {
    steps.push({ step: "copy", kind: "dir", from: legacyLogs, to: path.join(dataDir, "logs"), note: "旧插件日志（*.log.zst/当前 .log）并入 App 统一日志目录，不重名不覆盖。" });
  }
  const legacyConfig = path.join(legacyRoot, "config.json");
  if (existsSync(legacyConfig)) {
    steps.push({ step: "copy", kind: "file", from: legacyConfig, to: path.join(dataDir, "legacy-config.json"), note: "参考拷贝（v1 设置不代写宿主 preferences；建议项见 --apply 输出）。" });
  }
  const sourceInfo = {
    sessions: countSessions(legacyDshHome),
    stores: checkSessionStoreFiles(legacyDshHome),
    dshHome: legacyDshHome,
    profilesSkipped: true,
  };
  return {
    state: "plan",
    legacyRoot,
    dataDir,
    steps,
    warnings,
    sourceInfo,
    skip: { profiles: "v2 runtime seed 每次启动用 installDir cordis/ 自愈重建 profile（junction 指向过时 v1 安装目录，不迁移）", nodeModules: "App 依赖走 dataDir/runtime 安装区 pnpm 重装；.node 文件锁不迁移" },
  };
}

/** v1 config.json 全局键 → v2 contributes.settings 建议（只读映射；webPort 不同契约不映射）。 */
export function legacySettingsSuggestions(configJson) {
  const g = configJson && configJson.global && typeof configJson.global === "object" ? configJson.global : {};
  const out = [];
  for (const key of ["approvalTimeoutSec", "defaultTimeoutSec", "nodejsPath", "servicePort"]) {
    const val = g[key];
    if (val !== undefined && val !== null && val !== "") out.push({ key, value: val, source: "config.json.global." + key });
  }
  if (typeof g.webPort === "number" && g.webPort !== 3080) {
    out.push({ key: "servicePort", value: g.webPort, source: "config.json.global.webPort（旧 Web 端口；v2 显式端口契约，仅在 1024..65535 时可用，宿主禁 0/随机）", approx: true });
  }
  return out;
}

/** 迁移后验证（只读）：目标会话数 ≥ 期望、stores 可解析、marker 落位。 */
export function verifyMigration({ dataDir, sourceInfo }) {
  const out = { ok: true, checks: [] };
  const targetDshHome = targetDshHomeOf(dataDir);
  const t = countSessions(targetDshHome);
  const exp = sourceInfo && typeof sourceInfo.sessions?.sessionFiles === "number" ? sourceInfo.sessions.sessionFiles : null;
  out.checks.push({ name: "session-count", expected: exp, actual: t.sessionFiles, ok: exp === null || t.sessionFiles >= exp });
  const stores = checkSessionStoreFiles(targetDshHome);
  out.checks.push({ name: "store-json", ok: stores.every((s) => s.ok), detail: stores });
  const marker = readMigrationMarker(dataDir);
  out.checks.push({ name: "marker", ok: Boolean(marker && marker.source), detail: marker });
  out.ok = out.checks.every((c) => c.ok);
  return out;
}