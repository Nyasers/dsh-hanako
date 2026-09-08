// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/runtime-layout.test.mjs — 受管 runtime 依赖区布局单测（T4/T5 支撑）
// 覆盖：三件套固定覆盖幂等、声明摘要变化检测、依赖就位静态核对。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runtimePaths,
  readRuntimeDeclaration,
  syncRuntimeDeclaration,
  declarationDigest,
  inspectInstalledDeps,
  readInstalledDshVersion,
  installStateMatches,
  PNPM_VERSION,
} from "../src/lib/runtime-layout.js";

function makeInstallDir(root, { dsh = "0.1.2-rc.1", lock = null } = {}) {
  const dir = join(root, "install");
  mkdirSync(join(dir, "runtime"), { recursive: true });
  writeFileSync(
    join(dir, "runtime", "package.json"),
    JSON.stringify({ name: "dsh-hanako-runtime", version: "0.0.0", dependencies: { "@deepseek-ai/dsh": dsh, "@deepseek-ai/cordis": "4.0.2" } }, null, 2),
    "utf8",
  );
  writeFileSync(join(dir, "runtime", "pnpm-workspace.yaml"), "allowBuilds:\n  koffi: true\n", "utf8");
  if (lock) writeFileSync(join(dir, "runtime", "pnpm-lock.yaml"), lock, "utf8");
  return dir;
}

test("syncRuntimeDeclaration：首写 + 幂等 + 锁文件缺失即清理旧残留", () => {
  const root = mkdtempSync(join(tmpdir(), "dshana-layout-"));
  try {
    const installDir = makeInstallDir(root, { lock: "lockfileVersion: '9.0'\n" });
    const paths = runtimePaths(join(root, "data"));
    const first = syncRuntimeDeclaration(installDir, paths.root);
    assert.equal(first.ok, true);
    assert.equal(first.changed, true);
    assert.ok(existsSync(paths.declaration));
    assert.ok(existsSync(paths.workspace));
    assert.ok(existsSync(paths.lockfile));

    const second = syncRuntimeDeclaration(installDir, paths.root);
    assert.equal(second.changed, false, "第二次调用应零变更（幂等）");

    // installDir 撤掉锁文件 → 旧锁清理（不留旧版）
    rmSync(join(installDir, "runtime", "pnpm-lock.yaml"), { force: true });
    const third = syncRuntimeDeclaration(installDir, paths.root);
    assert.equal(third.changed, true);
    assert.equal(existsSync(paths.lockfile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("declarationDigest：dsh 版本或锁文件变化即摘要变化", () => {
  const root = mkdtempSync(join(tmpdir(), "dshana-digest-"));
  try {
    const a = readRuntimeDeclaration(makeInstallDir(join(root, "a"), { dsh: "0.1.2-rc.1" }));
    const b = readRuntimeDeclaration(makeInstallDir(join(root, "b"), { dsh: "0.1.3" }));
    const c = readRuntimeDeclaration(makeInstallDir(join(root, "c"), { dsh: "0.1.2-rc.1", lock: "x" }));
    assert.notDeepEqual(declarationDigest(a), declarationDigest(b));
    assert.notDeepEqual(declarationDigest(a), declarationDigest(c));
    assert.equal(declarationDigest(a).pnpm, PNPM_VERSION);
    assert.equal(installStateMatches({ declaration: declarationDigest(a) }, a), true);
    assert.equal(installStateMatches({ declaration: declarationDigest(b) }, a), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inspectInstalledDeps：缺失 → ok=false；就位（含载体标记 + 安装态）→ ok=true", () => {
  const root = mkdtempSync(join(tmpdir(), "dshana-inspect-"));
  try {
    const installDir = makeInstallDir(root);
    const declaration = readRuntimeDeclaration(installDir);
    const paths = runtimePaths(join(root, "data"));
    assert.equal(inspectInstalledDeps(paths.root, declaration).ok, false);

    // 造出「已安装」形态：cliBin + dsh 包版本 + 载体标记 + 安装态标记
    const dshDir = join(paths.root, "node_modules", "@deepseek-ai", "dsh");
    mkdirSync(join(dshDir, "lib"), { recursive: true });
    writeFileSync(join(dshDir, "lib", "bin.js"), "// cli\n", "utf8");
    writeFileSync(join(dshDir, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.2-rc.1" }), "utf8");
    mkdirSync(paths.pnpmDir, { recursive: true });
    writeFileSync(paths.pnpmMarker, "{}", "utf8");
    writeFileSync(
      paths.installState,
      JSON.stringify({ declaration: declarationDigest(declaration), installed: "0.1.2-rc.1" }),
      "utf8",
    );
    assert.equal(readInstalledDshVersion(paths.root), "0.1.2-rc.1");
    const ok = inspectInstalledDeps(paths.root, declaration);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.carrierOk, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
