// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/profile-seed.test.mjs — ensureProfileSeeded 四态 + 幂等断言（spec:
// dshana-profile-bundle D1/D2/D4/D5；tasks.md T2）。零依赖：node:test + node:assert，
// 与 tests/errclass.test.mjs 同风格（验收命令 node --test tests/）。
// 覆盖：clean home 种子 / 老整树 junction 迁移 / 老整树实体拷贝迁移 / 用户内容拒绝 /
// scope 漂移修复 / scope 缺失只补链接 / 链接失败回退拷贝 / 幂等二次零变更 /
// 用户 patch 不覆盖 + 缺失补齐 / 源缺失 / seed 目录缺失 / 真实模板冒烟。
// 模板文件化（review 修订）：种子内容不再内嵌字符串——seedDir 注入的目录文件为
// 模板源（生产 = src-cordis/seed，构建期复制 dist/cordis/seed）；断言改为落盘文件
// 内容与注入 seedDir 文件逐字节一致。

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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureProfileSeeded,
} from "../src/tools/lib/profile-seed.js";

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));
// 真实模板目录（源码层 src-cordis/seed；生产运行时经构建复制为 dist/cordis/seed）
const REAL_SEED_DIR = join(TEST_FILE_DIR, "..", "src-cordis", "seed");
const SEED_NAMES = ["package.json", "cordis.patch.yml", "pnpm-workspace.yaml"]; // cordis.yml 不入种子（dsh boot prepareProfile 自维护空根）

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
function makeScopeSrc(root, extra = {}) {
  const scope = join(root, "scope-src");
  mkdirSync(join(scope, "logger"), { recursive: true });
  mkdirSync(join(scope, "provider"), { recursive: true });
  mkdirSync(join(scope, "dshana"), { recursive: true });
  writeFileSync(join(scope, "logger", "index.js"), "// logger fixture\n");
  writeFileSync(join(scope, "provider", "index.js"), "// provider fixture\n");
  writeFileSync(join(scope, "dshana", "package.json"), "{\"name\":\"@dsh-hanako/dshana\"}\n");
  for (const [p, c] of Object.entries(extra)) writeFileSync(join(scope, p), c);
  return scope;
}

// 构造种子模板目录（fixture：package.json 为合法 profile manifest——二次判定（漂移/剪枝后）
// 会 readLegacyCopyInfo 解析它，非法 JSON 会误判 refused；其余三件为带标记文本，与真实
// 模板同构；缺省 useReal 用真实模板 src-cordis/seed）
const FIXTURE_MANIFEST_JSON =
  JSON.stringify(
    {
      name: "dsh-profile-dshana",
      private: true,
      version: "1.0.0",
      dependencies: {},
      dsh: {
        profile: {
          bundles: ["@deepseek-ai/dsh-base", "@dsh-hanako/dshana"],
          patchReload: "live",
        },
      },
    },
    null,
    2,
  ) + "\n";
const FIXTURE_SEED_TEXT = (name) => `# fixture seed template for ${name}\ncontent-of-${name}\n`;
function makeSeedDir(root, { useReal = false, names = SEED_NAMES } = {}) {
  const seedDir = join(root, "seed-src");
  mkdirSync(seedDir, { recursive: true });
  const src = useReal ? REAL_SEED_DIR : null;
  for (const name of names) {
    const content = src
      ? readFileSync(join(src, name), "utf8")
      : name === "package.json"
        ? FIXTURE_MANIFEST_JSON
        : FIXTURE_SEED_TEXT(name);
    writeFileSync(join(seedDir, name), content, "utf8");
  }
  return seedDir;
}

const profileDirOf = (root) => join(root, "dsh-home", "profiles", "dshana");

function collectLogs(log) {
  const logs = [];
  return { logs, push: (m) => logs.push(m) };
}

// 断言四件套内容与注入 seedDir 同名文件逐字节一致
function assertSeededFiles(profileDir, seedDir) {
  for (const name of SEED_NAMES) {
    assert.ok(existsSync(join(profileDir, name)), "应存在 " + name);
    assert.equal(
      readFileSync(join(profileDir, name), "utf8"),
      readFileSync(join(seedDir, name), "utf8"),
      name + " 内容应来自 seedDir 模板",
    );
  }
}

// 断言 scope 为链接且指向 scopeSrc
function assertScopeLink(profileDir, scopeSrc) {
  const link = join(profileDir, "node_modules", "@dsh-hanako");
  const st = lstatSync(link);
  assert.ok(st.isSymbolicLink(), "scope 应为目录链接");
  assert.equal(realpathSync(link), realpathSync(scopeSrc), "scope 链接应指向 scopeSrc");
}

// 快照（用于幂等零变更断言）：四件套内容 + mtime + scope 链接 realpath
function snapshot(profileDir) {
  const files = {};
  for (const name of SEED_NAMES) {
    const p = join(profileDir, name);
    files[name] = {
      content: readFileSync(p, "utf8"),
      mtimeMs: lstatSync(p).mtimeMs,
    };
  }
  const link = join(profileDir, "node_modules", "@dsh-hanako");
  return {
    files,
    scopeRealpath: realpathSync(link),
    profileDirReal: lstatSync(profileDir).isDirectory() && !lstatSync(profileDir).isSymbolicLink(),
  };
}

test("clean home：不存在 → 种子真实目录 + 四件套 + scope 链接指向源", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const seedDir = makeSeedDir(root);
  const profileDir = profileDirOf(root);
  const { logs, push } = collectLogs();
  const outcome = ensureProfileSeeded({ profileDir, scopeSrc, seedDir, log: push });
  assert.equal(outcome, "linked");
  // 真实目录（非链接）
  const st = lstatSync(profileDir);
  assert.ok(st.isDirectory() && !st.isSymbolicLink(), "profileDir 应为真实目录");
  assertSeededFiles(profileDir, seedDir);
  assertScopeLink(profileDir, scopeSrc);
  // 链接对文件透明可读（子插件经 scope 暴露）
  assert.equal(readFileSync(join(profileDir, "node_modules", "@dsh-hanako", "logger", "index.js"), "utf8"), "// logger fixture\n");
  assert.ok(logs.some((l) => l.includes("种子文件已写入")), "应有种子写入日志");
});

test("老整树 junction 迁移：删链接 → 真实目录 + 种子 + scope 链接", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const seedDir = makeSeedDir(root);
  // 老整树形态：profiles/dshana junction → 旧 dist/cordis 全树（含 profile 材料）
  const oldDist = join(root, "old-plugin-cordis");
  mkdirSync(oldDist, { recursive: true });
  writeFileSync(join(oldDist, "package.json"), "{\"name\":\"dsh-profile-dshana\",\"dependencies\":{}}\n");
  writeFileSync(join(oldDist, "cordis.patch.yml"), "# 旧 roster\n[]\n");
  const profileDir = profileDirOf(root);
  mkdirSync(join(root, "dsh-home", "profiles"), { recursive: true });
  makeDirLink(oldDist, profileDir);
  assert.ok(lstatSync(profileDir).isSymbolicLink(), "前置：profileDir 应为 junction");
  const { logs, push } = collectLogs();
  const outcome = ensureProfileSeeded({ profileDir, scopeSrc, seedDir, log: push });
  assert.equal(outcome, "linked");
  const st = lstatSync(profileDir);
  assert.ok(st.isDirectory() && !st.isSymbolicLink(), "迁移后 profileDir 应为真实目录");
  assertSeededFiles(profileDir, seedDir);
  assertScopeLink(profileDir, scopeSrc);
  assert.ok(logs.some((l) => l.includes("老整树 junction")), "应记老整树迁移日志");
});

test("老整树实体拷贝迁移：清内置残留 → 种子 + scope 链接", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const seedDir = makeSeedDir(root);
  const profileDir = profileDirOf(root);
  // 老拷贝残留：实体目录含内置文件 + node_modules/@dsh-hanako 实体拷贝（含旧文件标记）
  mkdirSync(join(profileDir, "node_modules", "@dsh-hanako", "logger"), { recursive: true });
  writeFileSync(join(profileDir, "node_modules", "@dsh-hanako", "logger", "legacy-marker.txt"), "old-copy\n");
  writeFileSync(join(profileDir, "package.json"), "{\n  \"name\": \"dsh-profile-dshana\",\n  \"private\": true,\n  \"dependencies\": {}\n}\n");
  writeFileSync(join(profileDir, "cordis.patch.yml"), "# 58 行老 roster 内容……\n- id: system-prompt\n");
  // cordis.yml 残留（dsh 自维护文件，不在种子清理范围——boot 会写回空根覆盖）
  writeFileSync(join(profileDir, "cordis.yml"), "# 老拷贝残留\n[]\n");
  writeFileSync(join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\n");
  const { logs, push } = collectLogs();
  const outcome = ensureProfileSeeded({ profileDir, scopeSrc, seedDir, log: push });
  assert.equal(outcome, "linked");
  assertSeededFiles(profileDir, seedDir); // 旧内容被模板替换（种子后 cordis.patch.yml 为模板空用户层）
  assertScopeLink(profileDir, scopeSrc);
  assert.ok(!existsSync(join(profileDir, "node_modules", "@dsh-hanako", "logger", "legacy-marker.txt")), "旧实体拷贝应被清理");
  assert.ok(existsSync(join(profileDir, "cordis.yml")), "cordis.yml 残留保留（dsh 自维护文件，不由种子清理）");
  assert.ok(logs.some((l) => l.includes("老拷贝")), "应记老拷贝清理日志");
});

test("拒绝迁移：含用户依赖 / 未知 name / 空目录不种子", (t) => {
  // A) 用户依赖非空
  const rootA = tmpRoot(t);
  const profileA = profileDirOf(rootA);
  mkdirSync(profileA, { recursive: true });
  writeFileSync(join(profileA, "package.json"), JSON.stringify({ name: "dsh-profile-dshana", dependencies: { "@user/plug": "1.0.0" } }));
  const scopeA = makeScopeSrc(rootA);
  const seedA = makeSeedDir(rootA);
  const logsA = [];
  const outA = ensureProfileSeeded({ profileDir: profileA, scopeSrc: scopeA, seedDir: seedA, log: (m) => logsA.push(m) });
  assert.equal(outA, "refused");
  assert.equal(readFileSync(join(profileA, "package.json"), "utf8"), JSON.stringify({ name: "dsh-profile-dshana", dependencies: { "@user/plug": "1.0.0" } }), "用户依赖内容不得改动");
  assert.ok(!existsSync(join(profileA, "cordis.yml")), "不应种子任何文件");
  assert.ok(logsA.some((l) => l.includes("拒绝")), "应记拒绝日志");
  // B) 未知 name
  const rootB = tmpRoot(t);
  const profileB = profileDirOf(rootB);
  mkdirSync(profileB, { recursive: true });
  writeFileSync(join(profileB, "package.json"), JSON.stringify({ name: "web", dependencies: {} }));
  const scopeB = makeScopeSrc(rootB);
  const seedB = makeSeedDir(rootB);
  const logsB = [];
  const outB = ensureProfileSeeded({ profileDir: profileB, scopeSrc: scopeB, seedDir: seedB, log: (m) => logsB.push(m) });
  assert.equal(outB, "refused");
  assert.ok(logsB.some((l) => l.includes("拒绝")), "应记拒绝日志");
  // C) 空实体目录（无 package.json 无法分类）→ 拒绝，目录不被写入
  const rootC = tmpRoot(t);
  const profileC = profileDirOf(rootC);
  mkdirSync(profileC, { recursive: true });
  const scopeC = makeScopeSrc(rootC);
  const seedC = makeSeedDir(rootC);
  const logsC = [];
  const outC = ensureProfileSeeded({ profileDir: profileC, scopeSrc: scopeC, seedDir: seedC, log: (m) => logsC.push(m) });
  assert.equal(outC, "refused");
  assert.deepEqual(readdirSync(profileC), [], "空目录保持不动");
});

test("scope 漂移修复：错误链接 / 实体残留 → 重建指向 scopeSrc", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const seedDir = makeSeedDir(root);
  const wrong = join(root, "wrong-scope");
  mkdirSync(wrong, { recursive: true });
  const profileDir = profileDirOf(root);
  mkdirSync(join(profileDir, "node_modules"), { recursive: true });
  // 先造漂移：错误链接
  makeDirLink(wrong, join(profileDir, "node_modules", "@dsh-hanako"));
  const out1 = ensureProfileSeeded({ profileDir, scopeSrc, seedDir, log: () => { } });
  assert.equal(out1, "linked");
  assertScopeLink(profileDir, scopeSrc);
  // 再造成实体残留（pnpm 重建等）
  rmSync(join(profileDir, "node_modules", "@dsh-hanako"), { recursive: true, force: true });
  mkdirSync(join(profileDir, "node_modules", "@dsh-hanako", "junk"), { recursive: true });
  writeFileSync(join(profileDir, "node_modules", "@dsh-hanako", "junk", "x.txt"), "residue");
  const out2 = ensureProfileSeeded({ profileDir, scopeSrc, seedDir, log: () => { } });
  assert.equal(out2, "linked");
  assertScopeLink(profileDir, scopeSrc);
  assert.ok(!existsSync(join(profileDir, "node_modules", "@dsh-hanako", "junk", "x.txt")), "实体残留应被清理重建");
});

test("scope 缺失（pnpm 剪枝等）：不清理用户文件，只补链接", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const seedDir = makeSeedDir(root);
  const profileDir = profileDirOf(root);
  // 先种子出全新形态
  ensureProfileSeeded({ profileDir, scopeSrc, seedDir, log: () => { } });
  // 用户编辑 patch + pnpm 剪枝把 scope 链接删了（scope 路径整个不存在）
  writeFileSync(join(profileDir, "cordis.patch.yml"), "# 用户自装插件\n- insert:\n  - id: my-plugin\n    name: my-plugin\n[]\n");
  rmSync(join(profileDir, "node_modules"), { recursive: true, force: true });
  const out = ensureProfileSeeded({ profileDir, scopeSrc, seedDir, log: () => { } });
  assert.equal(out, "linked");
  // 用户 patch 内容保留（未重种子覆盖）
  assert.equal(readFileSync(join(profileDir, "cordis.patch.yml"), "utf8"), "# 用户自装插件\n- insert:\n  - id: my-plugin\n    name: my-plugin\n[]\n", "用户 patch 不得被覆盖");
  assertScopeLink(profileDir, scopeSrc);
});

test("链接失败回退：createLink 抛错 → scope 目录整体拷贝落位", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const seedDir = makeSeedDir(root);
  const profileDir = profileDirOf(root);
  const logs = [];
  const out = ensureProfileSeeded({
    profileDir,
    scopeSrc,
    seedDir,
    log: (m) => logs.push(m),
    createLink: () => {
      throw new Error("模拟链接失败（跨盘/权限）");
    },
  });
  assert.equal(out, "scope-copied");
  assertSeededFiles(profileDir, seedDir);
  const link = join(profileDir, "node_modules", "@dsh-hanako");
  const st = lstatSync(link);
  assert.ok(st.isDirectory() && !st.isSymbolicLink(), "回退应为实体拷贝");
  assert.equal(readFileSync(join(link, "logger", "index.js"), "utf8"), "// logger fixture\n");
  assert.ok(logs.some((l) => l.includes("拷贝回退")), "应记拷贝回退日志");
});

test("幂等：连续两次调用第二次零变更", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const seedDir = makeSeedDir(root);
  const profileDir = profileDirOf(root);
  const logs1 = [];
  ensureProfileSeeded({ profileDir, scopeSrc, seedDir, log: (m) => logs1.push(m) });
  const snap1 = snapshot(profileDir);
  const logs2 = [];
  const out2 = ensureProfileSeeded({ profileDir, scopeSrc, seedDir, log: (m) => logs2.push(m) });
  assert.equal(out2, "ensured", "第二次调用 scope 链接应已正确（未动）");
  assert.deepEqual(snapshot(profileDir), snap1, "第二次调用零变更（内容/mtime/链接均同）");
  assert.ok(logs2.length === 0, "第二次调用不应产生任何日志（无写入无重建）");
});

test("缺文件补齐 + 用户改动不覆盖", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const seedDir = makeSeedDir(root);
  const profileDir = profileDirOf(root);
  ensureProfileSeeded({ profileDir, scopeSrc, seedDir, log: () => { } });
  // 用户编辑 patch、误删 pnpm-workspace.yaml（cordis.yml 由 dsh boot 自维护，不在补齐范围）
  const userPatch = "# 用户改动后的用户层\n[]\n";
  writeFileSync(join(profileDir, "cordis.patch.yml"), userPatch);
  rmSync(join(profileDir, "pnpm-workspace.yaml"));
  const out = ensureProfileSeeded({ profileDir, scopeSrc, seedDir, log: () => { } });
  assert.equal(out, "ensured");
  assert.equal(readFileSync(join(profileDir, "cordis.patch.yml"), "utf8"), userPatch, "用户 patch 不得被覆盖");
  assert.equal(
    readFileSync(join(profileDir, "pnpm-workspace.yaml"), "utf8"),
    readFileSync(join(seedDir, "pnpm-workspace.yaml"), "utf8"),
    "缺失的 pnpm-workspace.yaml 应从 seedDir 补齐",
  );
  assert.ok(!existsSync(join(profileDir, "cordis.yml")), "ensure 不创建 cordis.yml（dsh boot 自维护）");
});

test("源缺失：scopeSrc 不存在 → missing-source，profile 不动", (t) => {
  const root = tmpRoot(t);
  const seedDir = makeSeedDir(root);
  const profileDir = profileDirOf(root);
  const logs = [];
  const out = ensureProfileSeeded({
    profileDir,
    scopeSrc: join(root, "no-such-scope"),
    seedDir,
    log: (m) => logs.push(m),
  });
  assert.equal(out, "missing-source");
  assert.ok(!existsSync(profileDir), "profile 不应被创建");
  assert.ok(logs.some((l) => l.includes("源缺失")), "应记源缺失日志");
});

test("seed 目录缺失：seedDir 不存在 → missing-seed，profile 不动", (t) => {
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const profileDir = profileDirOf(root);
  const logs = [];
  const out = ensureProfileSeeded({
    profileDir,
    scopeSrc,
    seedDir: join(root, "no-such-seed"),
    log: (m) => logs.push(m),
  });
  assert.equal(out, "missing-seed");
  assert.ok(!existsSync(profileDir), "profile 不应被创建");
  assert.ok(logs.some((l) => l.includes("种子模板目录缺失")), "应记 seed 缺失日志");
});

test("真实模板冒烟：src-cordis/seed 四件套齐全、可解析、种子化内容与文件一致", (t) => {
  // 模板源（源码层）必须包含种子四件套且内容可解析——guard build/seed 契约
  for (const name of SEED_NAMES) {
    assert.ok(existsSync(join(REAL_SEED_DIR, name)), "真实模板应含 " + name);
  }
  const manifest = JSON.parse(readFileSync(join(REAL_SEED_DIR, "package.json"), "utf8"));
  assert.equal(manifest.name, "dsh-profile-dshana");
  assert.deepEqual(manifest.dsh.profile.bundles, ["@deepseek-ai/dsh-base", "@dsh-hanako/dshana"]);
  assert.equal(manifest.dsh.profile.patchReload, "live");
  assert.ok(readFileSync(join(REAL_SEED_DIR, "cordis.patch.yml"), "utf8").includes("用户 patch 层"), "用户层模板应有引导注释");
  // 用真实模板走一遍 clean home 种子，落盘与模板文件逐字节一致
  const root = tmpRoot(t);
  const scopeSrc = makeScopeSrc(root);
  const seedDir = makeSeedDir(root, { useReal: true });
  const profileDir = profileDirOf(root);
  const out = ensureProfileSeeded({ profileDir, scopeSrc, seedDir, log: () => { } });
  assert.equal(out, "linked");
  assertSeededFiles(profileDir, seedDir);
  // 辅助：seedDir 文件名与 SEED_NAMES 对齐（防 build 复制漏文件）
  const names = readdirSync(seedDir).sort();
  assert.deepEqual(names, [...SEED_NAMES].sort(), "seedDir 应恰好为种子四件套");
});
