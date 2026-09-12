// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/integrations.test.mjs — 集成层漂移闸（scripts/integrations.mts）单测
// 重点：闸必须在「上游变了」时响，且报错要指名该 rebase 哪个文件、哈希改成什么。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dshVersionOf,
  extractRequires,
  loadIntegrations,
  sha256,
  stageIntegrations,
  tagForVersion,
  verifyIntegrations,
  REPO_ROOT,
} from "../scripts/integrations.mts";

const upstreamFile = "packages/client/ui-layout/src/client/index.ts";

test("tagForVersion: pin 的版本 → 上游 tag", () => {
  assert.equal(tagForVersion("0.1.5-rc.2"), "dsh-v0.1.5-rc.2");
  assert.equal(tagForVersion(" 0.1.2-rc.1 "), "dsh-v0.1.2-rc.1");
});

test("dshVersionOf: 取 pin 版本，缺失返回 null", () => {
  assert.equal(dshVersionOf({ dependencies: { "@deepseek-ai/dsh": "0.1.5-rc.2" } }), "0.1.5-rc.2");
  assert.equal(dshVersionOf({ dependencies: {} }), null);
  assert.equal(dshVersionOf(null), null);
});

test("sha256: 缓冲与字符串一致、可复现", () => {
  assert.equal(sha256("abc"), sha256(Buffer.from("abc", "utf8")));
  assert.equal(sha256("abc").length, 64);
});

test("闸通过：哈希与上游一致时计数正确", () => {
  const content = "export const inject = ['slots']\n";
  const integrations = [
    {
      dir: "ui-layout",
      package: "@deepseek-ai/dsh-client-ui-layout",
      upstreamDir: "packages/client/ui-layout",
      files: [{ path: "src/client/index.ts", upstreamSha256: sha256(content) }],
    },
  ];
  const r = verifyIntegrations(integrations, (rel) => (rel === upstreamFile ? Buffer.from(content) : null));
  assert.equal(r.packages, 1);
  assert.equal(r.files, 1);
  assert.deepEqual(r.empty, []);
});

test("闸会响：上游变了 → 抛错并指名 rebase 的文件与新哈希", () => {
  const recorded = sha256("旧的上游内容");
  const integrations = [
    {
      dir: "ui-layout",
      package: "@deepseek-ai/dsh-client-ui-layout",
      upstreamDir: "packages/client/ui-layout",
      files: [{ path: "src/client/index.ts", upstreamSha256: recorded }],
    },
  ];
  const now = "上游改过了";
  assert.throws(
    () => verifyIntegrations(integrations, () => Buffer.from(now)),
    (e) => {
      assert.match(e.message, /已过期/);
      assert.match(e.message, /src-integrations\/ui-layout\/files\/src\/client\/index\.ts/);
      assert.ok(e.message.includes(sha256(now)), "报错里要给出新哈希，便于直接更新清单");
      assert.equal(e.problems.length, 1);
      return true;
    },
  );
});

test("闸会响：上游文件不存在（路径被移动）", () => {
  const integrations = [
    {
      dir: "ui-sidebar",
      package: "@deepseek-ai/dsh-client-ui-sidebar",
      upstreamDir: "packages/client/ui-sidebar",
      files: [{ path: "src/client/index.ts", upstreamSha256: sha256("x") }],
    },
  ];
  assert.throws(() => verifyIntegrations(integrations, () => null), /上游不存在/);
});

test("闸会响：清单自身不合法（缺 upstreamSha256 / 缺 path / 缺 upstreamDir）", () => {
  const bad = [
    { dir: "a", package: "p", upstreamDir: "d", files: [{ path: "f.ts" }] },
    { dir: "b", package: "p", upstreamDir: "d", files: [{ upstreamSha256: sha256("x") }] },
    { dir: "c", package: "p", files: [] },
  ];
  assert.throws(() => verifyIntegrations(bad, () => Buffer.from("x")), (e) => {
    assert.match(e.message, /未记录合法的 upstreamSha256/);
    assert.match(e.message, /缺少 path/);
    assert.match(e.message, /缺少 upstreamDir/);
    return true;
  });
});

test("尚无 overlay 的集成被记为 empty（允许，但会被提示）", () => {
  const integrations = [
    { dir: "ui-layout", package: "p", upstreamDir: "d", files: [] },
    { dir: "ui-sidebar", package: "p", upstreamDir: "d", files: [] },
  ];
  const r = verifyIntegrations(integrations, () => null);
  assert.equal(r.files, 0);
  assert.deepEqual(r.empty, ["ui-layout", "ui-sidebar"]);
});

test("仓库真实清单：能解析、字段齐（当前为批次①两枚、尚无 overlay）", () => {
  const list = loadIntegrations(REPO_ROOT);
  assert.ok(list.length >= 2, "至少登记 ui-layout / ui-sidebar");
  for (const it of list) {
    assert.ok(it.package && it.upstreamDir && Array.isArray(it.files), `${it.dir} 字段应齐`);
    // 版本戳段不写在清单里：它只从主 package.json 派生（手写字段会被 loadIntegrations 拒）。
    assert.equal(it.hana, undefined);
    assert.equal(it.revision, undefined);
    assert.ok(Array.isArray(it.files));
  }
  const names = list.map((x) => x.dir);
  assert.ok(names.includes("ui-layout") && names.includes("ui-sidebar"));
});

test("patchVersion：补丁包版本戳只从主 package.json 派生（无手写修订号）", async () => {
  const { patchVersion, readPkg } = await import("../scripts/version-common.mts");
  const clean = String(readPkg("package.json").version).split("+")[0];
  assert.equal(patchVersion("0.1.5-rc.2"), `0.1.5-rc.2+dshana-${clean}`);
  assert.equal(patchVersion("0.1.5-rc.2+whatever"), `0.1.5-rc.2+dshana-${clean}`);
});

test("extractRequires：认未压缩产物的字面 require()", () => {
  const bundle = 'window.__ModuleLoader__.load({ id: "pkg", factory: (require) => { const a = require("react"); const b = require("react/jsx-runtime"); const c = require("react"); return module.exports; } });';
  assert.deepEqual(extractRequires(bundle), ["react", "react/jsx-runtime"]);
});

test("extractRequires：也认我们压缩过的产物（factory 参数被改名、引号含反引号）", () => {
  const bundle = "window.__ModuleLoader__.load({id:`@deepseek-ai/dsh-client-ui-layout`,factory:e=>{var t={exports:{}};let r=e(\"react\"),i=e(`react/jsx-runtime`),a=e('@deepseek-ai/dsh-client-store');return t.exports}});";
  assert.deepEqual(extractRequires(bundle), ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-store"]);
});

test("extractRequires：无 factory banner 时不炸、空输入得空表", () => {
  assert.deepEqual(extractRequires('const x = require("zustand")'), ["zustand"]);
  assert.deepEqual(extractRequires(""), []);
  assert.deepEqual(extractRequires(null), []);
});

test("stage：把 overlay 落进 _tmp/integrations/<短名>/ 并保内容", () => {
  const root = mkdtempSync(join(tmpdir(), "hana-int-"));
  try {
    const itRoot = join(root, "integrations", "demo");
    mkdirSync(join(itRoot, "files", "src"), { recursive: true });
    writeFileSync(join(itRoot, "files", "src", "x.ts"), "delta\n");
    const integrations = [{ dir: "demo", package: "p", upstreamDir: "d", root: itRoot, files: [{ path: "src/x.ts", upstreamSha256: sha256("d") }] }];
    const staged = stageIntegrations(integrations, root);
    assert.deepEqual(staged, [join("_tmp", "integrations", "demo", "src", "x.ts")]);
    const dst = join(root, "_tmp", "integrations", "demo", "src", "x.ts");
    assert.ok(existsSync(dst));
    assert.equal(readFileSync(dst, "utf8"), "delta\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stage：overlay 文件缺失时明确报错", () => {
  const root = mkdtempSync(join(tmpdir(), "hana-int-"));
  try {
    const itRoot = join(root, "integrations", "demo");
    mkdirSync(itRoot, { recursive: true });
    const integrations = [{ dir: "demo", package: "p", upstreamDir: "d", root: itRoot, files: [{ path: "src/missing.ts", upstreamSha256: sha256("d") }] }];
    assert.throws(() => stageIntegrations(integrations, root), /overlay 文件缺失/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
