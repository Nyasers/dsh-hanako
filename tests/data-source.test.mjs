// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/data-source.test.mjs — src/lib/data-source.js 数据来源解析与自持设置存储单测
// 覆盖：设置校验（未知键/模式/shared 绝对路径/profile）、路径归一与 sourceId 稳定性、
// 存储读默认/往返/原子写/lastShared/损坏与版本拒绝、shared 目录校验（含 canonical 回写）。
// 注：期望值一律经 path.normalize 生成，测试在 win32/darwin/linux 下同义。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import {
  DEFAULT_SETTINGS,
  PRIVATE_HOME_NAME,
  PRIVATE_PROFILE,
  SETTINGS_VERSION,
  createDataSourceStore,
  defaultDshHome,
  normalizeHomeForId,
  privateHomeOf,
  sourceOf,
  validateSettings,
} from "../src/lib/data-source.ts";

/** 临时目录夹具（await 回调体，退出时清理）。 */
const withTempDir = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "dshana-ds-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const P = (p) => normalize(p);
// 两个超时的默认值（钉住数字：与 config.ts 的 APP_SETTING_DEFAULTS 一致，也是存储的缺省）
const TIMEOUT_DEFAULTS = { approvalTimeoutSec: 30, defaultTimeoutSec: 1800 };

test("validateSettings: private 默认落位，profile 被强制为内置名", () => {
  assert.deepEqual(validateSettings({ mode: "private", path: null, profile: "whatever" }), {
    mode: "private",
    path: null,
    profile: PRIVATE_PROFILE,
    ...TIMEOUT_DEFAULTS,
  });
  assert.deepEqual(validateSettings({ mode: "private" }), {
    mode: "private",
    path: null,
    profile: PRIVATE_PROFILE,
    ...TIMEOUT_DEFAULTS,
  });
  assert.deepEqual(DEFAULT_SETTINGS, { mode: "private", path: null, profile: PRIVATE_PROFILE, ...TIMEOUT_DEFAULTS });
});

test("validateSettings: 拒绝未知键 / 非法模式 / 非绝对 shared 路径 / NUL / 畸形 profile", () => {
  assert.throws(() => validateSettings({ mode: "private", extra: 1 }), /未知键/);
  assert.throws(() => validateSettings({ mode: "cloud" }), /private 或 shared/);
  assert.throws(() => validateSettings(null), /必须是对象/);
  assert.throws(() => validateSettings([]), /必须是对象/);
  const shared = (path, profile = "dshana") => () => validateSettings({ mode: "shared", path, profile });
  assert.throws(shared("relative/dir"), /绝对路径/);
  assert.throws(shared(""), /必须给出/);
  assert.throws(shared("C:/x\0y"), /NUL/);
  assert.throws(shared("/abs", "with space"), /简单名/);
  assert.throws(shared("/abs", "-lead"), /简单名/);
  assert.throws(shared("/abs", "a".repeat(65)), /简单名/);
  assert.throws(shared("/abs", ".."), /简单名/);
});

test("validateSettings: shared 路径做 normalize，profile 原样保留", () => {
  const s = validateSettings({ mode: "shared", path: "/data/dsh/", profile: "web-2" });
  assert.equal(s.mode, "shared");
  assert.equal(s.profile, "web-2");
  assert.equal(s.path, P("/data/dsh/"));
});

test("normalizeHomeForId: 斜杠与尾斜杠归一；win32 额外小写", () => {
  assert.equal(normalizeHomeForId("C:\\Users\\A\\.dsH\\", "win32"), "c:/users/a/.dsh");
  assert.equal(normalizeHomeForId("/Users/A/.dsh/", "darwin"), "/Users/A/.dsh");
  assert.equal(normalizeHomeForId("C:\\Users\\A\\.dsh", "win32"), "c:/users/a/.dsh");
});

test("sourceOf: private 恒为内置目录 + 常量 sourceId；shared 由 home+profile 决定", () => {
  const dataDir = "/app-data/dshana";
  const priv = sourceOf({ mode: "private" }, dataDir);
  assert.equal(priv.sourceId, "private");
  assert.equal(priv.home, privateHomeOf(dataDir));
  assert.equal(priv.home, join(dataDir, PRIVATE_HOME_NAME));
  assert.equal(priv.profileName, PRIVATE_PROFILE);
  assert.equal(priv.shared, false);

  const idOf = (home, profile = "web") => sourceOf({ mode: "shared", path: home, profile }, dataDir).sourceId;
  const a = sourceOf({ mode: "shared", path: "/ds h/", profile: "web" }, dataDir);
  assert.equal(a.home, P("/ds h/"));
  assert.equal(a.shared, true);
  assert.equal(a.profileName, "web");
  assert.equal(idOf("/ds h"), idOf("/ds h/"), "尾斜杠不产生伪 source 变更");
  assert.equal(idOf("/ds h"), idOf("\\ds h\\"), "反斜杠与正斜杠同义");
  assert.notEqual(idOf("/ds h"), idOf("/ds h", "other"), "profile 不同即不同源");
  assert.match(a.sourceId, /^[0-9a-f]{24}$/);
});

test("sourceOf: Windows 路径比较归一（\\ → /、小写、去尾斜杠）", () => {
  assert.equal(normalizeHomeForId("D:\\DSH\\HOME\\", "win32"), "d:/dsh/home");
  assert.equal(normalizeHomeForId("D:\\DSH\\HOME", "win32"), normalizeHomeForId("d:/dsh/home/", "win32"));
});

test("defaultDshHome: ~/.dsh", () => {
  assert.ok(defaultDshHome().endsWith(".dsh"));
});

test("store.read: 文件不存在回落 private 默认（revision 0）", async () => {
  await withTempDir(async (dir) => {
    const st = await createDataSourceStore({ dataDir: dir }).read();
    assert.equal(st.version, SETTINGS_VERSION);
    assert.equal(st.revision, 0);
    assert.deepEqual(st.settings, { ...DEFAULT_SETTINGS });
    assert.equal(st.lastShared, undefined);
  });
});

test("store.write: 原子落盘 + revision 递增 + lastShared 记录（不留 .pending）", async () => {
  await withTempDir(async (dir) => {
    const store = createDataSourceStore({ dataDir: dir });
    const first = await store.write({ mode: "shared", path: dir, profile: "web" });
    assert.equal(first.revision, 1);
    assert.deepEqual(first.lastShared, { path: P(dir), profile: "web" });

    const onDisk = JSON.parse(readFileSync(join(dir, "integration", "settings.json"), "utf8"));
    assert.equal(onDisk.revision, 1);
    assert.equal(onDisk.version, SETTINGS_VERSION);
    assert.deepEqual(readdirSync(join(dir, "integration")), ["settings.json"], "原子写不留 .pending 残片");

    const second = await store.write({ mode: "private" });
    assert.equal(second.revision, 2);
    assert.equal(second.settings.mode, "private");
    assert.deepEqual(second.lastShared, { path: P(dir), profile: "web" }, "切回 private 仍记 lastShared 供预填");

    const reread = await createDataSourceStore({ dataDir: dir }).read();
    assert.equal(reread.revision, 2);
    assert.deepEqual(reread.settings, {
      mode: "private",
      path: null,
      profile: PRIVATE_PROFILE,
      ...TIMEOUT_DEFAULTS,
    });
  });
});

test("store.read: 损坏 JSON / 版本不符 / revision 非法都明确抛错（不静默回落）", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "integration", "settings.json");
    mkdirSync(join(dir, "integration"), { recursive: true });
    writeFileSync(file, "{not json");
    await assert.rejects(() => createDataSourceStore({ dataDir: dir }).read(), /不是合法 JSON/);
    writeFileSync(file, JSON.stringify({ version: 99, revision: 0, settings: DEFAULT_SETTINGS }));
    await assert.rejects(() => createDataSourceStore({ dataDir: dir }).read(), /版本不受支持/);
    writeFileSync(file, JSON.stringify({ version: SETTINGS_VERSION, revision: -1, settings: DEFAULT_SETTINGS }));
    await assert.rejects(() => createDataSourceStore({ dataDir: dir }).read(), /revision 非法/);
    writeFileSync(file, JSON.stringify({ version: SETTINGS_VERSION, revision: 1, settings: { mode: "cloud" } }));
    await assert.rejects(() => createDataSourceStore({ dataDir: dir }).read(), /private 或 shared/);
  });
});

test("store.validate: shared 目录须存在且是目录；采纳宿主 canonical 路径", async () => {
  await withTempDir(async (dir) => {
    const calls = [];
    const canonical = (p) => p.replace(/[\\/]+$/, "") + "/canonical";
    const ctx = {
      dataDir: dir,
      resources: {
        stat: async (ref) => {
          calls.push(ref);
          if (ref.path.includes("missing")) return { exists: false };
          if (ref.path.includes("afile")) return { exists: true, isDirectory: false };
          return { exists: true, isDirectory: true, filePath: canonical(ref.path) };
        },
      },
    };
    const store = createDataSourceStore(ctx);
    const ok = await store.validate({ mode: "shared", path: "/some/dir/", profile: "web" });
    assert.equal(ok.path, canonical(P("/some/dir/")));
    assert.deepEqual(calls[0], { kind: "local-file", path: P("/some/dir/") });

    await assert.rejects(() => store.validate({ mode: "shared", path: "/x/missing", profile: "web" }), /目录不存在/);
    await assert.rejects(() => store.validate({ mode: "shared", path: "/x/afile", profile: "web" }), /不是目录/);
    const before = calls.length;
    const priv = await store.validate({ mode: "private" });
    assert.equal(priv.mode, "private");
    assert.equal(calls.length, before, "private 不触 resources.stat");
  });
});

test("store.validate: 宿主不支持 resources.stat 时给可操作报错", async () => {
  await withTempDir(async (dir) => {
    const store = createDataSourceStore({ dataDir: dir });
    await assert.rejects(
      () => store.validate({ mode: "shared", path: dir, profile: "web" }),
      /不支持 ctx\.resources\.stat/,
    );
  });
});
