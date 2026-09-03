// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/profile-seed.test.mjs — ensureProfileSeeded 形态/迁移/幂等断言（spec:
// dshana-profile-bundle D1/D2/D4/D5；tasks.md T2）。零依赖：node:test + node:assert。
// 2026-09-04 修订：profile 文件改由官方 @deepseek-ai/dsh-app-boot initProfile 生成
// （本模块不再自维护种子模板）——测试注入 stub initProfile（模拟官方语义：缺失才写，
// 记录调用参数），断言生成/幂等/不覆盖与 scope 链接。
// 覆盖：clean 初始化 / 老整树 junction 迁移 / 老整树实体拷贝迁移 / 用户内容拒绝 /
// scope 漂移修复 / scope 缺失只补链接 / 链接失败回退拷贝 / 幂等二次零变更 /
// 用户 patch 不覆盖 + 缺失补齐 / initProfile 必填抛错 / init-failed / 源缺失。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  lstatSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureProfileSeeded,
  PROFILE_BUNDLES,
  PROFILE_PATCH_RELOAD,
} from "../src/lib/profile-seed.js";

// 官方 initProfile 语义的 stub：缺失才写三文件（manifest/用户层模板/pnpm-workspace），
// 记录调用参数；manifest 为合法 dsh-profile-dshana（二次判定 readLegacyCopyInfo 会解析）。
const BUILTIN_FILES = ["package.json", "cordis.patch.yml", "pnpm-workspace.yaml"];
const MANIFEST_JSON =
  JSON.stringify(
    {
      name: "dsh-profile-dshana",
      private: true,
      version: "1.0.0",
      dependencies: {},
      dsh: { profile: { bundles: PROFILE_BUNDLES, patchReload: PROFILE_PATCH_RELOAD } },
    },
    null,
    2,
  ) + "\n";
const PATCH_TEMPLATE = "# profile user patch layer\n[]\n";
const WORKSPACE_YAML = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";
function makeStubInitProfile(calls = []) {
  return function stubInitProfile(dir, bundles, patchReload) {
    calls.push({ dir, bundles: [...bundles], patchReload });
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, "package.json"))) writeFileSync(join(dir, "package.json"), MANIFEST_JSON);
    if (!existsSync(join(dir, "cordis.patch.yml"))) writeFileSync(join(dir, "cordis.patch.yml"), PATCH_TEMPLATE);
    if (!existsSync(join(dir, "pnpm-workspace.yaml"))) writeFileSync(join(dir, "pnpm-workspace.yaml"), WORKSPACE_YAML);
  };
}

// 平台分支目录链接（junction/symlink(dir) 与生产同款）
function makeDirLink(target, link) {
  if (process.platform === "win32") symlinkSync(target, link, "junction");
  else symlinkSync(target, link, "dir");
}

function tmpRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "profile-seed-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// 构造 scope 源（@dsh-hanako 目录，含几个包文件）
function makeScopeSrc(root) {
  const scope = join(root, "scope-src");
  mkdirSync(join(scope, "logger"), { recursive: true });
  mkdirSync(join(scope, "dshana"), { recursive: true });
  writeFileSync(join(scope, "logger", "index.js"), "// logger fixture\n");
  writeFileSync(join(scope, "dshana", "package.json"), "{\"name\":\"@dsh-hanako/dshana\"}\n");
  return scope;
}

const profileDirOf = (root) => join(root, "dsh-home", "profiles", "dshana");

function collectLogs() {
  const logs = [];
  return { logs, push: (m) => logs.push(m) };
}

// 断言内置三文件内容（来自 stub initProfile）+ profileDir 为真实目录
function assertSeededFiles(profileDir) {
  const expect = {
    "package.json": MANIFEST_JSON,
    "cordis.patch.yml": PATCH_TEMPLATE,
    "pnpm-workspace.yaml": WORKSPACE_YAML,
  };
  for (const [name, content] of Object.entries(expect)) {
    assert.ok(existsSync(join(profileDir, name)), "应存在 " + name);
    assert.equal(readFileSync(join(profileDir, name), "utf8"), content, name + " 内容应来自 initProfile");
  }
  const st = lstatSync(profileDir);
  assert.ok(st.isDirectory() && !st.isSymbolicLink(), "profileDir 应为真实目录");
}

// 断言 scope 为链接且指向 scopeSrc
function assertScopeLink(profileDir, scopeSrc) {
  const link = join(profileDir, "node_modules", "@dsh-hanako");
  const st = lstatSync(link);
  assert.ok(st.isSymbolicLink(), "scope 应为目录链接");
  assert.equal(realpathSync(link), realpathSync(scopeSrc), "scope 链接应指向 scopeSrc");
}

// 快照（用于幂等零变更断言）：内置三文件内容 + mtime + scope 链接 realpath
function snapshot(profileDir) {
  const files = {};
  for (const name of BUILTIN_FILES) {
    const p = join(profileDir, name);
    files[name] = { content: readFileSync(p, "utf8"), mtimeMs: lstatSync(p).mtimeMs };
  }
  return {
    files,
    scopeRealpath: realpathSync(join(profileDir, "node_modules", "@dsh-hanako")),
  };
}

test("clean：不存在 → initProfile(官方 bundles/patchReload) + 三文件 + scope 链接", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const profileDir = profileDirOf(root);
  const calls = [];
  const { logs, push } = collectLogs();
  const outcome = ensureProfileSeeded({
    profileDir,
    scopeSrc,
    initProfile: makeStubInitProfile(calls),
    log: push,
  });
  assert.equal(outcome, "linked");
  assertSeededFiles(profileDir);
  assertScopeLink(profileDir, scopeSrc);
  assert.equal(calls.length, 1, "initProfile 应调用一次");
  assert.deepEqual(calls[0].bundles, PROFILE_BUNDLES, "bundles 应含官方服务层 + dshana bundle");
  assert.equal(calls[0].patchReload, PROFILE_PATCH_RELOAD);
  // 链接对文件透明可读（子插件经 scope 暴露）
  assert.equal(
    readFileSync(join(profileDir, "node_modules", "@dsh-hanako", "logger", "index.js"), "utf8"),
    "// logger fixture\n",
  );
  assert.ok(logs.some((l) => l.includes("scope 链接")), "应记链接日志");
});

test("老整树 junction 迁移：删链接 → 真实目录 + initProfile + scope 链接", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const oldDist = join(root, "old-plugin-cordis");
  mkdirSync(oldDist, { recursive: true });
  writeFileSync(join(oldDist, "package.json"), "{\"name\":\"dsh-profile-dshana\",\"dependencies\":{}}\n");
  const profileDir = profileDirOf(root);
  mkdirSync(join(root, "dsh-home", "profiles"), { recursive: true });
  makeDirLink(oldDist, profileDir);
  assert.ok(lstatSync(profileDir).isSymbolicLink(), "前置：profileDir 应为 junction");
  const calls = [];
  const { logs, push } = collectLogs();
  const outcome = ensureProfileSeeded({
    profileDir,
    scopeSrc,
    initProfile: makeStubInitProfile(calls),
    log: push,
  });
  assert.equal(outcome, "linked");
  assertSeededFiles(profileDir);
  assertScopeLink(profileDir, scopeSrc);
  assert.equal(calls.length, 1);
  assert.ok(logs.some((l) => l.includes("老整树 junction")), "应记老整树迁移日志");
});

test("老整树实体拷贝迁移：清内置残留 → initProfile 补齐 + scope 链接", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const profileDir = profileDirOf(root);
  // 老拷贝残留：实体目录含内置三文件 + scope 实体拷贝（含旧文件标记）+ cordis.yml 残留
  mkdirSync(join(profileDir, "node_modules", "@dsh-hanako", "logger"), { recursive: true });
  writeFileSync(join(profileDir, "node_modules", "@dsh-hanako", "logger", "legacy-marker.txt"), "old-copy\n");
  writeFileSync(join(profileDir, "package.json"), "{\n  \"name\": \"dsh-profile-dshana\",\n  \"private\": true,\n  \"dependencies\": {}\n}\n");
  writeFileSync(join(profileDir, "cordis.patch.yml"), "# 58 行老 roster 内容……\n- id: system-prompt\n");
  writeFileSync(join(profileDir, "cordis.yml"), "# 老拷贝残留\n[]\n");
  const calls = [];
  const { logs, push } = collectLogs();
  const outcome = ensureProfileSeeded({
    profileDir,
    scopeSrc,
    initProfile: makeStubInitProfile(calls),
    log: push,
  });
  assert.equal(outcome, "linked");
  assertSeededFiles(profileDir); // 清理后 initProfile 补齐（patch 为模板）
  assertScopeLink(profileDir, scopeSrc);
  assert.ok(!existsSync(join(profileDir, "node_modules", "@dsh-hanako", "logger", "legacy-marker.txt")), "旧实体拷贝应被清理");
  assert.ok(existsSync(join(profileDir, "cordis.yml")), "cordis.yml 残留保留（dsh 自维护文件，不由种子清理）");
  assert.ok(logs.some((l) => l.includes("老拷贝")), "应记老拷贝清理日志");
});

test("拒绝迁移：含用户依赖 / 未知 name / 空目录不初始化", (t) => {
  // A) 用户依赖非空
  const rootA = tmpRoot(t);
  const profileA = profileDirOf(rootA);
  mkdirSync(profileA, { recursive: true });
  writeFileSync(join(profileA, "package.json"), JSON.stringify({ name: "dsh-profile-dshana", dependencies: { "@user/plug": "1.0.0" } }));
  const callsA = [];
  const outA = ensureProfileSeeded({ profileDir: profileA, scopeSrc: makeScopeSrc(rootA), initProfile: makeStubInitProfile(callsA), log: () => {} });
  assert.equal(outA, "refused");
  assert.equal(callsA.length, 0, "拒绝态不应调 initProfile");
  assert.equal(
    readFileSync(join(profileA, "package.json"), "utf8"),
    JSON.stringify({ name: "dsh-profile-dshana", dependencies: { "@user/plug": "1.0.0" } }),
    "用户依赖内容不得改动",
  );
  assert.ok(!existsSync(join(profileA, "cordis.patch.yml")), "不应生成任何文件");
  // B) 未知 name
  const rootB = tmpRoot(t);
  const profileB = profileDirOf(rootB);
  mkdirSync(profileB, { recursive: true });
  writeFileSync(join(profileB, "package.json"), JSON.stringify({ name: "web", dependencies: {} }));
  const callsB = [];
  const outB = ensureProfileSeeded({ profileDir: profileB, scopeSrc: makeScopeSrc(rootB), initProfile: makeStubInitProfile(callsB), log: () => {} });
  assert.equal(outB, "refused");
  assert.equal(callsB.length, 0);
  // C) 空实体目录（无 package.json 无法分类）→ 拒绝，目录不被写入
  const rootC = tmpRoot(t);
  const profileC = profileDirOf(rootC);
  mkdirSync(profileC, { recursive: true });
  const callsC = [];
  const outC = ensureProfileSeeded({ profileDir: profileC, scopeSrc: makeScopeSrc(rootC), initProfile: makeStubInitProfile(callsC), log: () => {} });
  assert.equal(outC, "refused");
  assert.deepEqual(readdirSync(profileC), [], "空目录保持不动");
});

test("scope 漂移修复：错误链接 / 实体残留 → 重建指向 scopeSrc", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const wrong = join(root, "wrong-scope");
  mkdirSync(wrong, { recursive: true });
  const profileDir = profileDirOf(root);
  mkdirSync(join(profileDir, "node_modules"), { recursive: true });
  makeDirLink(wrong, join(profileDir, "node_modules", "@dsh-hanako"));
  const init = makeStubInitProfile([]);
  const out1 = ensureProfileSeeded({ profileDir, scopeSrc, initProfile: init, log: () => {} });
  assert.equal(out1, "linked");
  assertScopeLink(profileDir, scopeSrc);
  rmSync(join(profileDir, "node_modules", "@dsh-hanako"), { recursive: true, force: true });
  mkdirSync(join(profileDir, "node_modules", "@dsh-hanako", "junk"), { recursive: true });
  writeFileSync(join(profileDir, "node_modules", "@dsh-hanako", "junk", "x.txt"), "residue");
  const out2 = ensureProfileSeeded({ profileDir, scopeSrc, initProfile: init, log: () => {} });
  assert.equal(out2, "linked");
  assertScopeLink(profileDir, scopeSrc);
  assert.ok(!existsSync(join(profileDir, "node_modules", "@dsh-hanako", "junk", "x.txt")), "实体残留应被清理重建");
});

test("scope 缺失（pnpm 剪枝等）：不清理用户文件，只补链接", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const profileDir = profileDirOf(root);
  const calls = [];
  ensureProfileSeeded({ profileDir, scopeSrc, initProfile: makeStubInitProfile(calls), log: () => {} });
  // 用户编辑 patch + pnpm 剪枝把 scope 链接与 package.json 外的 node_modules 删了
  const userPatch = "# 用户自装插件\n- insert:\n  - id: my-plugin\n    name: my-plugin\n[]\n";
  writeFileSync(join(profileDir, "cordis.patch.yml"), userPatch);
  rmSync(join(profileDir, "node_modules"), { recursive: true, force: true });
  const calls2 = [];
  const out = ensureProfileSeeded({ profileDir, scopeSrc, initProfile: makeStubInitProfile(calls2), log: () => {} });
  assert.equal(out, "linked");
  assert.equal(
    readFileSync(join(profileDir, "cordis.patch.yml"), "utf8"),
    userPatch,
    "用户 patch 不得被覆盖（initProfile 缺失才写）",
  );
  assertScopeLink(profileDir, scopeSrc);
});

test("链接失败回退：createLink 抛错 → scope 目录整体拷贝落位", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const profileDir = profileDirOf(root);
  const out = ensureProfileSeeded({
    profileDir,
    scopeSrc,
    initProfile: makeStubInitProfile([]),
    log: () => {},
    createLink: () => {
      throw new Error("模拟链接失败（跨盘/权限）");
    },
  });
  assert.equal(out, "scope-copied");
  assertSeededFiles(profileDir);
  const link = join(profileDir, "node_modules", "@dsh-hanako");
  const st = lstatSync(link);
  assert.ok(st.isDirectory() && !st.isSymbolicLink(), "回退应为实体拷贝");
  assert.equal(readFileSync(join(link, "logger", "index.js"), "utf8"), "// logger fixture\n");
});

test("幂等：连续两次调用第二次零变更", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const profileDir = profileDirOf(root);
  const calls1 = [];
  ensureProfileSeeded({ profileDir, scopeSrc, initProfile: makeStubInitProfile(calls1), log: () => {} });
  const snap1 = snapshot(profileDir);
  const calls2 = [];
  const logs2 = [];
  const out2 = ensureProfileSeeded({ profileDir, scopeSrc, initProfile: makeStubInitProfile(calls2), log: (m) => logs2.push(m) });
  assert.equal(out2, "ensured", "第二次调用 scope 链接应已正确（未动）");
  assert.deepEqual(snapshot(profileDir), snap1, "第二次调用零变更（内容/mtime/链接均同）");
  assert.ok(logs2.length === 0, "第二次调用不应产生任何日志（无写入无重建）");
});

test("缺文件补齐 + 用户改动不覆盖", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const profileDir = profileDirOf(root);
  ensureProfileSeeded({ profileDir, scopeSrc, initProfile: makeStubInitProfile([]), log: () => {} });
  // 用户编辑 patch、误删 pnpm-workspace.yaml（cordis.yml 由 dsh boot 自维护，不在补齐范围）
  const userPatch = "# 用户改动后的用户层\n[]\n";
  writeFileSync(join(profileDir, "cordis.patch.yml"), userPatch);
  rmSync(join(profileDir, "pnpm-workspace.yaml"));
  const out = ensureProfileSeeded({ profileDir, scopeSrc, initProfile: makeStubInitProfile([]), log: () => {} });
  assert.equal(out, "ensured");
  assert.equal(readFileSync(join(profileDir, "cordis.patch.yml"), "utf8"), userPatch, "用户 patch 不得被覆盖");
  assert.equal(
    readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8"),
    WORKSPACE_YAML,
    "缺失的 pnpm-workspace.yaml 应由 initProfile 补齐",
  );
  assert.ok(!existsSync(join(profileDir, "cordis.yml")), "本模块不创建 cordis.yml（dsh boot 自维护）");
});

test("initProfile 必填：未注入 → 抛参数错误", (t) => {
  const root = tmpRoot(t);
  const profileDir = profileDirOf(root);
  assert.throws(
    () => ensureProfileSeeded({ profileDir, scopeSrc: makeScopeSrc(root), log: () => {} }),
    /initProfile 必填/,
  );
});

test("initProfile 失败：stub 抛错 → init-failed", (t) => {
  const root = tmpRoot(t);
  const profileDir = profileDirOf(root);
  const logs = [];
  const out = ensureProfileSeeded({
    profileDir,
    scopeSrc: makeScopeSrc(root),
    initProfile: () => {
      throw new Error("模拟 initProfile 失败（权限等）");
    },
    log: (m) => logs.push(m),
  });
  assert.equal(out, "init-failed");
  assert.ok(!existsSync(profileDir), "失败态不建目录（initProfile 抛错前未 mkdir）");
});

test("manifest 随包归一：补缺失期望项、CLI 追加保留、patchReload 归期望（幂等）", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const profileDir = profileDirOf(root);
  ensureProfileSeeded({ profileDir, scopeSrc, initProfile: makeStubInitProfile([]), log: () => {} });
  // 模拟异常/旧态 + 用户 CLI 追加：删期望项 dsh-base、patchReload 改 startup、加 @user/extra
  const mp = join(profileDir, "package.json");
  const j = JSON.parse(readFileSync(mp, "utf8"));
  j.dsh.profile.bundles = ["@dsh-hanako/dshana", "@user/extra"];
  j.dsh.profile.patchReload = "startup";
  writeFileSync(mp, JSON.stringify(j, null, 2) + "\n");
  const logs = [];
  const out = ensureProfileSeeded({ profileDir, scopeSrc, initProfile: makeStubInitProfile([]), log: (m) => logs.push(m) });
  assert.equal(out, "ensured");
  const after = JSON.parse(readFileSync(mp, "utf8"));
  assert.deepEqual(after.dsh.profile.bundles, [...PROFILE_BUNDLES, "@user/extra"], "期望内置项补齐 + CLI 追加保留（顺序：期望在前）");
  assert.equal(after.dsh.profile.patchReload, "live", "patchReload 归一为期望");
  assert.ok(logs.some((l) => l.includes("随包归一")), "应记归一日志");
  // 幂等：再次 ensure 一致不写
  const snap = readFileSync(mp, "utf8");
  const logs2 = [];
  ensureProfileSeeded({ profileDir, scopeSrc, initProfile: makeStubInitProfile([]), log: (m) => logs2.push(m) });
  assert.equal(readFileSync(mp, "utf8"), snap, "归一后二次 ensure 零写");
});
test("源缺失：scopeSrc 不存在 → missing-source，initProfile 不被调用", (t) => {
  const root = tmpRoot(t);
  const profileDir = profileDirOf(root);
  const calls = [];
  const out = ensureProfileSeeded({
    profileDir,
    scopeSrc: join(root, "no-such-scope"),
    initProfile: makeStubInitProfile(calls),
    log: () => {},
  });
  assert.equal(out, "missing-source");
  assert.equal(calls.length, 0);
  assert.ok(!existsSync(profileDir), "profile 不应被创建");
});
