// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/legacy-migrate.test.mjs — src/lib/legacy-migrate.js 计划/验证/标记/建议单测
// （纯逻辑 + repo _tmp 内的真实小样本模拟 apply；不触碰真实旧插件数据）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, cpSync } from "node:fs";
import { join, basename } from "node:path";
import os from "node:os";
import {
  planLegacyMigration,
  countSessions,
  checkSessionStoreFiles,
  legacySettingsSuggestions,
  readMigrationMarker,
  writeMigrationMarker,
  verifyMigration,
  DSH_HOME_COPY_ENTRIES,
  targetDshHomeOf,
  legacyRootOf,
  markerPathOf,
} from "../src/lib/legacy-migrate.js";

function makeFixture() {
  // repo _tmp 下建样本（工作区可写；测试自清理）
  const base = mkdtempSync(join(process.cwd(), "_tmp", "legacy-migrate-"));
  const legacyRoot = join(base, "plugin-data", "dsh-hanako");
  const dshHome = join(legacyRoot, "dsh-home");
  const mk = (...p) => mkdirSync(join(...p), { recursive: true });
  mk(dshHome, "sessions", "--E-proj--", "session-1111");
  writeFileSync(join(dshHome, "sessions", "--E-proj--", "session-1111", "session.jsonl.zstd"), "");
  mk(dshHome, "sessions", "--E-proj2--", "session-2222");
  writeFileSync(join(dshHome, "sessions", "--E-proj2--", "session-2222", "session.jsonl.zstd"), "{\"x\":1}\n");
  mk(dshHome, "storages");
  writeFileSync(join(dshHome, "storages", "workspace.json"), JSON.stringify({ tables: { workspaces: {} } }));
  writeFileSync(join(dshHome, "settings.yaml"), "agent-default-model:\n  provider: deepseek\n");
  writeFileSync(join(dshHome, ".anonymous-user-id"), "anon-1\n");
  // profiles（junction 形态在 v1 真实数据里；测试以普通目录占位）——必须被跳过
  mk(dshHome, "profiles", "dshana", "node_modules", "@dsh-hanako", "provider");
  writeFileSync(join(dshHome, "profiles", "dshana", "node_modules", "@dsh-hanako", "provider", "package.json"), JSON.stringify({ name: "@dsh-hanako/provider" }));
  mk(legacyRoot, "logs");
  writeFileSync(join(legacyRoot, "logs", "2026.log.zst"), "x");
  writeFileSync(join(legacyRoot, "config.json"), JSON.stringify({ schemaVersion: 1, global: { webPort: 3080, approvalTimeoutSec: 45, defaultTimeoutSec: 3600, nodejsPath: "C:/x/node.exe" }, agents: {}, sessions: {} }));
  const dataDir = join(base, "app-data", "dsh-hanako");
  mkdirSync(dataDir, { recursive: true });
  return { base, legacyRoot, dshHome, dataDir };
}

test("planLegacyMigration: no-source（源缺失）", () => {
  const p = planLegacyMigration({ legacyRoot: join(process.cwd(), "_tmp", "no-such-legacy"), dataDir: join(process.cwd(), "_tmp", "tgt") });
  assert.equal(p.state, "no-source");
  assert.ok(p.reason);
});

test("planLegacyMigration: plan 态（backup + copy 条目；profiles 跳过）", () => {
  const fx = makeFixture();
  try {
    const p = planLegacyMigration({ legacyRoot: fx.legacyRoot, dataDir: fx.dataDir });
    assert.equal(p.state, "plan");
    assert.equal(p.sourceInfo.sessions.sessionFiles, 2);
    assert.ok(p.steps.some((s) => s.step === "backup"), "backup 步骤存在");
    for (const ent of DSH_HOME_COPY_ENTRIES) {
      assert.ok(p.steps.some((s) => s.step === "copy" && basename(s.from) === ent.name), "缺 copy 条目 " + ent.name);
    }
    assert.equal(p.skip.profiles.length > 0, true, "profiles 不迁移");
    assert.ok(p.warnings.length === 0);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("模拟 apply → marker → already-migrated（幂等）→ verify", () => {
  const fx = makeFixture();
  try {
    const p = planLegacyMigration({ legacyRoot: fx.legacyRoot, dataDir: fx.dataDir });
    assert.equal(p.state, "plan");
    // 备份
    const backupDir = join(fx.dataDir, "migration-backup");
    cpSync(p.steps.find((s) => s.step === "backup").from, backupDir, { recursive: true });
    // 复制条目（profiles 不在 copy 列表，天然跳过）
    for (const st of p.steps) if (st.step === "copy") cpSync(st.from, st.to, { recursive: true });
    // 标记
    writeMigrationMarker(fx.dataDir, { schemaVersion: 1, source: fx.legacyRoot, at: new Date().toISOString(), stats: { copied: p.steps.length }, backupDir });
    assert.ok(existsSync(markerPathOf(fx.dataDir)));
    // 幂等：再计划 = already-migrated
    const p2 = planLegacyMigration({ legacyRoot: fx.legacyRoot, dataDir: fx.dataDir });
    assert.equal(p2.state, "already-migrated");
    assert.equal(readMigrationMarker(fx.dataDir).source, fx.legacyRoot);
    // verify：会话数/workspace.json 可解析/marker 落位
    const v = verifyMigration({ dataDir: fx.dataDir, sourceInfo: { sessions: { sessionFiles: 2 } } });
    assert.equal(v.ok, true);
    assert.equal(countSessions(targetDshHomeOf(fx.dataDir)).sessionFiles, 2);
    assert.ok(checkSessionStoreFiles(targetDshHomeOf(fx.dataDir)).every((s) => s.ok));
    // target-present 语义：无标记但有数据 → 拒绝覆盖
    rmSync(markerPathOf(fx.dataDir), { force: true });
    const p3 = planLegacyMigration({ legacyRoot: fx.legacyRoot, dataDir: fx.dataDir });
    assert.equal(p3.state, "target-present");
    const p4 = planLegacyMigration({ legacyRoot: fx.legacyRoot, dataDir: fx.dataDir, force: true });
    assert.equal(p4.state, "plan");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("legacySettingsSuggestions: 可迁移键映射（新契约无落点的键不映射）", () => {
  const sug = legacySettingsSuggestions({ global: { approvalTimeoutSec: 45, defaultTimeoutSec: 3600, nodejsPath: "C:/x", servicePort: 4317, webPort: 5000 } });
  assert.deepEqual(sug.map((s) => s.key), ["approvalTimeoutSec", "defaultTimeoutSec"]);
  assert.deepEqual(legacySettingsSuggestions({ global: { webPort: 5000 } }), []);
  assert.deepEqual(legacySettingsSuggestions({}), []);
});

test("legacyRootOf: plugin-data/dsh-hanako 推导", () => {
  assert.equal(legacyRootOf("E:/Hanako/.hanako"), join("E:/Hanako/.hanako", "plugin-data", "dsh-hanako"));
});
