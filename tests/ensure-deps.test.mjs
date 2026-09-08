// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/ensure-deps.test.mjs — src/runtime/ensure-deps.js 纯函数单测（node --test）
// 覆盖：声明/已装版本读取、幂等比对、.runtime-ok marker 读写（pnpm 网络安装路径不在单测
// 内——无网络环境，真机装包后验证；代码路径复用 v1 src/lib/pnpm.js）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  declaredRuntimeVersions,
  installedRuntimeVersions,
  versionsMatch,
  depsBinIntact,
  markerPath,
  readMarker,
  writeMarker,
  MANIFEST_FILES,
} from "../src/runtime/ensure-deps.js";

function makeTmp() {
  return mkdtempSync(join(tmpdir(), "dsh-ensure-"));
}

test("declaredRuntimeVersions: 读 installRoot package.json 的 dsh/cordis 声明", () => {
  const dir = makeTmp();
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { "@deepseek-ai/dsh": "0.1.2-rc.1", "@deepseek-ai/cordis": "4.0.2", "other": "1.0.0" } }),
    );
    assert.deepEqual(declaredRuntimeVersions(dir), { dsh: "0.1.2-rc.1", cordis: "4.0.2" });
    assert.deepEqual(declaredRuntimeVersions(join(dir, "missing")), { dsh: null, cordis: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installedRuntimeVersions + versionsMatch: 幂等比对语义", () => {
  const dir = makeTmp();
  try {
    const deps = join(dir, "node_modules");
    mkdirSync(join(deps, "@deepseek-ai", "dsh"), { recursive: true });
    mkdirSync(join(deps, "@deepseek-ai", "cordis"), { recursive: true });
    writeFileSync(join(deps, "@deepseek-ai", "dsh", "package.json"), JSON.stringify({ version: "0.1.2-rc.1" }));
    writeFileSync(join(deps, "@deepseek-ai", "cordis", "package.json"), JSON.stringify({ version: "4.0.2" }));
    const inst = installedRuntimeVersions(deps);
    assert.deepEqual(inst, { dsh: "0.1.2-rc.1", cordis: "4.0.2" });
    const decl = { dsh: "0.1.2-rc.1", cordis: "4.0.2" };
    assert.equal(versionsMatch(decl, inst), true);
    assert.equal(versionsMatch({ dsh: "0.2.0", cordis: "4.0.2" }, inst), false);
    assert.equal(versionsMatch({ dsh: null, cordis: "4.0.2" }, inst), false);
    // 缺包 → null
    rmSync(join(deps, "@deepseek-ai", "cordis"), { recursive: true, force: true });
    assert.equal(installedRuntimeVersions(deps).cordis, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("depsBinIntact: dsh lib/bin.js 存在性", () => {
  const dir = makeTmp();
  try {
    assert.equal(depsBinIntact(dir), false);
    mkdirSync(join(dir, "@deepseek-ai", "dsh", "lib"), { recursive: true });
    writeFileSync(join(dir, "@deepseek-ai", "dsh", "lib", "bin.js"), "export {};\n");
    assert.equal(depsBinIntact(dir), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("marker 读写：写后读回 manifest 一致，缺文件读 null", () => {
  const dir = makeTmp();
  try {
    assert.equal(readMarker(dir), null);
    assert.ok(markerPath(dir).endsWith(".runtime-ok"));
    writeMarker(dir, { dsh: "0.1.2-rc.1", cordis: "4.0.2" }, "2026-09-10T00:00:00.000Z");
    const marker = readMarker(dir);
    assert.deepEqual(marker.manifest, { dsh: "0.1.2-rc.1", cordis: "4.0.2" });
    assert.equal(marker.at, "2026-09-10T00:00:00.000Z");
    assert.equal(existsSync(markerPath(dir)), true);
    // 声明变化 → 版本比对不一致（触发重装）
    assert.equal(versionsMatch({ dsh: "0.1.2-rc.1", cordis: "4.0.2" }, marker.manifest), true);
    assert.equal(versionsMatch({ dsh: "0.1.3", cordis: "4.0.2" }, marker.manifest), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MANIFEST_FILES: 三件套清单稳定（installRoot 源 → runtimeDir 覆盖）", () => {
  assert.deepEqual(MANIFEST_FILES, ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"]);
});
