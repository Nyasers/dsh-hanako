// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/data-source-settings.test.mjs — 两个超时与数据模式同栈（一份设置、一个 revision）的语义。
//
// 盯四件事：
//   1. 缺省：设置里没有这两个键时，校验后补上默认（30 / 1800）；
//   2. 非法：负数、小数、字符串一律拒绝，不静默取整或回默认；
//   3. 往返：写进自持存储后读回来是同值同 revision；
//   4. 存量兼容：旧位置（<dataDir>/config.json 的 global.*）只在 settings.json 缺这两个键时当初始值，
//      读路径不落盘；一旦写过一次设置，自持存储就是唯一权威。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDataSourceStore, validateSettings } from "../src/lib/data-source.ts";

const TIMEOUT_DEFAULTS = { approvalTimeoutSec: 30, defaultTimeoutSec: 1800 };

async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "dshana-settings-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("validateSettings: 缺省补上两个超时的默认值", () => {
  const out = validateSettings({ mode: "private" });
  assert.equal(out.approvalTimeoutSec, TIMEOUT_DEFAULTS.approvalTimeoutSec);
  assert.equal(out.defaultTimeoutSec, TIMEOUT_DEFAULTS.defaultTimeoutSec);
});

test("validateSettings: 非法超时值一律拒绝（不取整、不回默认）", () => {
  for (const bad of [-1, 1.5, "abc", {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => validateSettings({ mode: "private", approvalTimeoutSec: bad }),
      /approvalTimeoutSec/,
      "应拒绝 approvalTimeoutSec=" + JSON.stringify(bad),
    );
  }
  assert.throws(() => validateSettings({ mode: "private", defaultTimeoutSec: -5 }), /defaultTimeoutSec/);
});

test("validateSettings: 0 是显式禁用，保留不改成默认", () => {
  const out = validateSettings({ mode: "private", approvalTimeoutSec: 0, defaultTimeoutSec: 0 });
  assert.equal(out.approvalTimeoutSec, 0);
  assert.equal(out.defaultTimeoutSec, 0);
});

test("store: 两个超时随设置一起落盘并与 revision 同步", async () => {
  await withTempDir(async (dir) => {
    const store = createDataSourceStore({ dataDir: dir });
    const first = await store.write({ mode: "private", approvalTimeoutSec: 45, defaultTimeoutSec: 900 });
    assert.equal(first.revision, 1);
    assert.equal(first.settings.approvalTimeoutSec, 45);
    assert.equal(first.settings.defaultTimeoutSec, 900);

    const onDisk = JSON.parse(readFileSync(join(dir, "integration", "settings.json"), "utf8"));
    assert.equal(onDisk.settings.approvalTimeoutSec, 45);

    const reread = await createDataSourceStore({ dataDir: dir }).read();
    assert.equal(reread.revision, 1);
    assert.equal(reread.settings.approvalTimeoutSec, 45);
    assert.equal(reread.settings.defaultTimeoutSec, 900);

    // 再写一次只改其中一个，另一个保持不变（不做整段重置）
    const second = await store.write({ mode: "private", approvalTimeoutSec: 15, defaultTimeoutSec: 900 });
    assert.equal(second.revision, 2);
    assert.equal(second.settings.approvalTimeoutSec, 15);
  });
});

test("存量兼容：旧位置只在缺键时当初始值，且不写回旧位置", async () => {
  await withTempDir(async (dir) => {
    // 旧栈：dataDir/config.json 的 global.*
    writeFileSync(join(dir, "config.json"), JSON.stringify({ global: { approvalTimeoutSec: 77, defaultTimeoutSec: 1234 } }), "utf8");

    // 1) settings.json 还没有 → 读到的初值来自旧位置（读路径不落盘）
    const fresh = await createDataSourceStore({ dataDir: dir }).read();
    assert.equal(fresh.settings.approvalTimeoutSec, 77);
    assert.equal(fresh.settings.defaultTimeoutSec, 1234);
    assert.equal(fresh.revision, 0, "读不制造 revision");
    assert.throws(
      () => readFileSync(join(dir, "integration", "settings.json"), "utf8"),
      /ENOENT/,
      "只读不该落盘",
    );

    // 2) 写一次设置（把值显式带上）→ 自持存储从此是权威
    const store = createDataSourceStore({ dataDir: dir });
    await store.write({ mode: "private", approvalTimeoutSec: 77, defaultTimeoutSec: 1234 });

    // 3) 旧位置被改也不再影响读（键已在 settings.json 里）
    writeFileSync(join(dir, "config.json"), JSON.stringify({ global: { approvalTimeoutSec: 999, defaultTimeoutSec: 999 } }), "utf8");
    const after = await createDataSourceStore({ dataDir: dir }).read();
    assert.equal(after.settings.approvalTimeoutSec, 77);
    assert.equal(after.settings.defaultTimeoutSec, 1234);

    // 4) 旧位置仍是旧位置：自持存储不往它写
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.equal(cfg.global.approvalTimeoutSec, 999, "自持存储不写 config.json");
  });
});
