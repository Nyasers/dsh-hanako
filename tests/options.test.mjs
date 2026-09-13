// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/options.test.mjs — src/runtime/options.js 纯函数单测（node --test）
// 覆盖：参数形态（--flag value / --flag=value）、必选校验、显式端口契约（禁 0/越界）、
// ready-marker 整行约束、未知参数与 help 豁免。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, UsageError, USAGE } from "../src/runtime/options.js";

test("parseArgs: 完整合法参数（--flag value 与 --flag=value 混用）", () => {
  const o = parseArgs([
    "--port", "4317",
    "--data-dir=/hana/app-data/dsh-hanako",
    "--hana-task-id", "task-1",
    "--ready-marker", "DSH_READY",
  ]);
  assert.equal(o.port, 4317);
  assert.equal(o.dataDir, "/hana/app-data/dsh-hanako");
  assert.equal(o.taskId, "task-1");
  assert.equal(o.readyMarker, "DSH_READY");
  assert.equal(o.noEnsure, false);
  assert.equal(o.depsRoot, null);
  assert.equal(o.cordisSrc, null);
});

test("parseArgs: 默认值（readyMarker 默认 DSH_READY / noEnsure 默认 false）", () => {
  const o = parseArgs(["--port", "8080", "--data-dir", "/tmp/x"]);
  assert.equal(o.readyMarker, "DSH_READY");
  assert.equal(o.noEnsure, false);
});

test("parseArgs: 可选 flag 传值（deps-root/cordis-src/no-ensure）", () => {
  const o = parseArgs([
    "--port", "8080", "--data-dir", "/tmp/x",
    "--deps-root", "/tmp/deps/node_modules",
    "--cordis-src", "/app/cordis",
    "--no-ensure",
  ]);
  assert.equal(o.depsRoot, "/tmp/deps/node_modules");
  assert.equal(o.cordisSrc, "/app/cordis");
  assert.equal(o.noEnsure, true);
});

test("parseArgs: 端口契约——0 / 负 / 越界 / 非数均拒绝（显式端口契约禁随机）", () => {
  for (const bad of ["0", "-1", "65536", "abc", "1.5", ""]) {
    assert.throws(
      () => parseArgs(["--port", bad, "--data-dir", "/tmp/x"]),
      (e) => e instanceof UsageError && /--port/.test(e.message),
      "port=" + bad,
    );
  }
});

test("parseArgs: 缺必选（--port / --data-dir）→ UsageError", () => {
  assert.throws(() => parseArgs(["--port", "8080"]), (e) => e instanceof UsageError);
  assert.throws(() => parseArgs(["--data-dir", "/tmp/x"]), (e) => e instanceof UsageError);
  assert.throws(() => parseArgs([]), (e) => e instanceof UsageError);
});

test("parseArgs: 未知参数拒绝", () => {
  assert.throws(
    () => parseArgs(["--port", "8080", "--data-dir", "/x", "--bogus"]),
    (e) => e instanceof UsageError && /未知参数/.test(e.message),
  );
});

test("parseArgs: ready-marker 含换行拒绝（宿主按整行匹配）", () => {
  const withLf = "A" + String.fromCharCode(10) + "B";
  const withCr = "A" + String.fromCharCode(13) + "B";
  for (const m of [withLf, withCr]) {
    assert.throws(
      () => parseArgs(["--port", "8080", "--data-dir", "/x", "--ready-marker", m]),
      (e) => e instanceof UsageError && /ready-marker/.test(e.message),
    );
  }
});

test("parseArgs: --help 豁免必选校验", () => {
  const o = parseArgs(["--help"]);
  assert.equal(o.help, true);
  assert.match(USAGE, /--port <port>/);
});
