// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/migrate-legacy.mjs — dsh-hanako v1 旧插件数据迁移 CLI（独立运行；零第三方依赖）
//
// 用法：
//   node scripts/migrate-legacy.mjs --check \
//       --hanako-home <HANA_HOME> [--target <App dataDir>]
//   node scripts/migrate-legacy.mjs --apply --source <legacy plugin-data/dsh-hanako> \
//       --target <App dataDir> [--force] [--backup-dir <dir>]
//
// 环境变量缺省：--source 缺省取 DSHANA_LEGACY_HOME；--target 缺省取 DSHANA_DATA_DIR。
// App dataDir = <hanakoHome>/app-data/dsh-hanako（ctx.dataDir；由主上下文在真机提供）。
//
// 本脚本不真跑于本刀（旧插件数据是活的）——只交付代码与 --check 只读验证路径；--apply 的
// 停机指引：迁移窗口内旧插件应先停止写入（主上下文与姐姐协调），脚本对源只读、不删除。
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";
import {
  planLegacyMigration,
  legacyRootOf,
  readMigrationMarker,
  writeMigrationMarker,
  verifyMigration,
  countSessions,
  legacySettingsSuggestions,
  DSH_HOME_COPY_ENTRIES,
  targetDshHomeOf,
} from "../src/lib/legacy-migrate.js";
import fs from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.log(`
migrate-legacy — 把 v1 插件数据（dsh-home/config）迁入 App v2 数据区（旧 logs 不迁移）

  --hanako-home <dir>   宿主 home（旧源 = <dir>/plugin-data/dsh-hanako）
  --source <dir>        旧插件数据根（plugin-data/dsh-hanako；优先于 --hanako-home）
  --target <dir>        App 数据区（ctx.dataDir，例如 <hanakoHome>/app-data/dsh-hanako）
  --backup-dir <dir>    备份目录（默认 <target>/migration-backup；已存在不覆盖）
  --check               只读分析并退出（默认）
  --apply               执行复制 + 标记（幂等；不删除源/备份）
  --force               目标已有数据/标记时仍按本次规划执行（不覆盖已有备份）
`);
}

function parseArgs(argv) {
  const opts = { mode: "check", force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hanako-home") opts.hanakoHome = argv[++i];
    else if (a === "--source") opts.source = argv[++i];
    else if (a === "--target") opts.target = argv[++i];
    else if (a === "--backup-dir") opts.backupDir = argv[++i];
    else if (a === "--apply") opts.mode = "apply";
    else if (a === "--check") opts.mode = "check";
    else if (a === "--force") opts.force = true;
    else if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else { console.error("未知参数：" + a); usage(); process.exit(2); }
  }
  const source = opts.source || (opts.hanakoHome ? legacyRootOf(opts.hanakoHome) : process.env.DSHANA_LEGACY_HOME || null);
  const target = opts.target || process.env.DSHANA_DATA_DIR || null;
  if (!source) { console.error("[migrate-legacy] 缺数据源：--source / --hanako-home / DSHANA_LEGACY_HOME 至少其一"); process.exit(2); }
  if (!target) { console.error("[migrate-legacy] 缺目标：--target 或 DSHANA_DATA_DIR（App ctx.dataDir）"); process.exit(2); }
  return { ...opts, source, target };
}

function cp(from, to, note) {
  fs.mkdirSync(dirname(to), { recursive: true });
  fs.cpSync(from, to, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (src) => !/node_modules(\\|\/)/.test(src) && basename(src) !== "profiles",
  });
  console.log("[migrate-legacy]    copy: " + from + " -> " + to + (note ? "（" + note + "）" : ""));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log("[migrate-legacy] mode=" + opts.mode + " source=" + opts.source + " target=" + opts.target);
  const plan = planLegacyMigration({ legacyRoot: opts.source, dataDir: opts.target, force: opts.force });
  console.log("[migrate-legacy] 计划状态：" + plan.state);
  for (const w of plan.warnings || []) console.log("[migrate-legacy] 警告：" + w);
  if (plan.state === "no-source" || plan.state === "target-present") {
    console.error("[migrate-legacy] 中止：" + plan.reason);
    process.exit(plan.state === "no-source" ? 1 : 3);
  }
  if (plan.state === "already-migrated") {
    console.log("[migrate-legacy] 已迁移（幂等跳过）。旧插件数据保留原样可回退；重跑需 --force。");
    return;
  }
  const sourceInfo = plan.sourceInfo;
  console.log("[migrate-legacy] 源会话数：" + (sourceInfo && sourceInfo.sessions ? sourceInfo.sessions.sessionFiles : 0));
  for (const st of plan.steps) console.log("[migrate-legacy]   - " + st.step + ": " + st.from + " -> " + st.to);

  // 设置建议（只读 config.json 映射——不代写宿主 preferences）
  const cfgPath = join(opts.source, "config.json");
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const sug = legacySettingsSuggestions(cfg);
      if (sug.length) {
        console.log("[migrate-legacy] v1 设置建议（在 App 设置页手动确认/应用）：");
        for (const s of sug) console.log("    " + s.key + " = " + JSON.stringify(s.value) + "  ← " + s.source);
      }
    } catch (e) {
      console.warn("[migrate-legacy] config.json 解析失败（跳过设置建议）：" + ((e && e.message) || e));
    }
  }

  if (opts.mode !== "apply") {
    console.log("[migrate-legacy] --check 完成（未执行任何复制/写）。真机执行 --apply 前请先停旧插件写入（主上下文与姐姐协调）；对源只读。");
    return;
  }

  // ---- 执行 ----
  console.log("[migrate-legacy] 停机指引：请先停旧 DSH 写入（停止相关会话/任务）再执行；本脚本对源只读，不删除任何旧数据。");
  const backupDir = opts.backupDir || join(opts.target, "migration-backup");
  for (const st of plan.steps) {
    if (st.step === "backup") {
      if (fs.existsSync(backupDir)) {
        console.log("[migrate-legacy]    备份目录已存在，跳过复制（不覆盖唯一备份）：" + backupDir);
      } else {
        cp(st.from, backupDir, "旧 dsh-home 唯一备份");
      }
      continue;
    }
    if (st.step === "copy") cp(st.from, st.to, st.note || "");
  }
  // 迁移标记（幂等）
  const stats = { source: opts.source, copied: plan.steps.length, targetDshHome: targetDshHomeOf(opts.target) };
  writeMigrationMarker(opts.target, { schemaVersion: 1, source: opts.source, at: new Date().toISOString(), stats, backupDir });
  // 迁移后只读验证
  const v = verifyMigration({ dataDir: opts.target, sourceInfo });
  console.log("[migrate-legacy] 迁移后验证：" + (v.ok ? "通过" : "未全过（见下）"));
  for (const c of v.checks) {
    console.log("    " + c.name + ": " + (c.ok ? "ok" : "FAIL") + (c.expected !== undefined ? "（期望 " + c.expected + "，实际 " + c.actual + "）" : ""));
  }
  if (!v.ok) {
    console.error("[migrate-legacy] 验证未全过——保留备份 " + backupDir + " 与旧插件数据，人工核对后决定是否回退/重跑。");
    process.exitCode = 4;
    return;
  }
  console.log("[migrate-legacy] 完成：会话/缓存/设置已入 App 数据区；profiles 由 v2 runtime 首次启动自愈重建；旧插件数据原样保留（回退材料）。迁移后停用旧插件（不删除）以防双写。");
}

main();
