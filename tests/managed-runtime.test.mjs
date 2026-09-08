// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/managed-runtime.test.mjs — src/lib/managed-runtime.js 纯函数单测（node --test）
// 覆盖：servicePort 解析（显式端口契约）、子进程参数构造（与 src/runtime/options.js 对偶）、
// runtime 终态错误归类（退出码契约 → 用户可读分类）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseServicePort,
  buildRuntimeArgs,
  classifyRuntimeFailure,
  READY_MARKER,
  RUNTIME_ENTRY,
  DEFAULT_SERVICE_PORT,
} from "../src/lib/managed-runtime.js";

test("parseServicePort: 合法整数直通（number / 数字字符串；宿主 service 端口契约 1024..65535）", () => {
  assert.equal(parseServicePort(4317), 4317);
  assert.equal(parseServicePort("5000"), 5000);
  assert.equal(parseServicePort(1024), 1024);
  assert.equal(parseServicePort(65535), 65535);
});

test("parseServicePort: 非法回落默认（禁 <1024/0/负/越界/非数——显式端口契约）", () => {
  for (const bad of [0, -1, 1, 512, 1023, 65536, "0", "800", "abc", "", null, undefined, 1.5, NaN]) {
    assert.equal(parseServicePort(bad), DEFAULT_SERVICE_PORT, "raw=" + String(bad));
  }
  // 显式 fallback 参数生效（fallback 也须 ≥1024）
  assert.equal(parseServicePort("bad", 9000), 9000);
  assert.equal(parseServicePort("bad", 1), DEFAULT_SERVICE_PORT);
});

test("buildRuntimeArgs: 基础形态（与 options.js 对偶）", () => {
  const args = buildRuntimeArgs({ port: 4317, dataDir: "/hana/app-data/dsh-hanako", taskId: "task-1" });
  assert.deepEqual(args, ["--port", "4317", "--data-dir", "/hana/app-data/dsh-hanako", "--hana-task-id", "task-1", "--ready-marker", READY_MARKER]);
});

test("buildRuntimeArgs: 覆盖项（cordis-src/deps-root/no-ensure）只在显式传时出现", () => {
  const base = buildRuntimeArgs({ port: 8080, dataDir: "/x" });
  assert.ok(!base.includes("--deps-root"));
  assert.ok(!base.includes("--cordis-src"));
  assert.ok(!base.includes("--no-ensure"));
  const full = buildRuntimeArgs({
    port: 8080,
    dataDir: "/x",
    cordisSrc: "/install/cordis",
    depsRoot: "/deps/node_modules",
    noEnsure: true,
    readyMarker: "MY_READY",
  });
  assert.deepEqual(full, [
    "--port", "8080",
    "--data-dir", "/x",
    "--cordis-src", "/install/cordis",
    "--deps-root", "/deps/node_modules",
    "--ready-marker", "MY_READY",
    "--no-ensure",
  ]);
});

test("buildRuntimeArgs: 必填缺失抛错", () => {
  assert.throws(() => buildRuntimeArgs({ dataDir: "/x" }), /port/);
  assert.throws(() => buildRuntimeArgs({ port: 8080 }), /dataDir/);
});

test("classifyRuntimeFailure: 退出码契约归类（src/runtime/main.js EXIT 同步）", () => {
  assert.equal(classifyRuntimeFailure({ exitCode: 7 }).kind, "port-busy");
  assert.equal(classifyRuntimeFailure({ exitCode: 4 }).kind, "deps");
  assert.equal(classifyRuntimeFailure({ exitCode: 5 }).kind, "seed");
  assert.equal(classifyRuntimeFailure({ exitCode: 6 }).kind, "boot-failed");
  assert.equal(classifyRuntimeFailure({ state: "failed" }).kind, "boot-failed");
  assert.equal(classifyRuntimeFailure({ state: "exited", exitCode: 1 }).kind, "boot-failed");
  assert.equal(classifyRuntimeFailure(null).kind, "unknown");
  assert.equal(classifyRuntimeFailure({}).kind, "unknown");
  // userText 非空且含指引
  for (const info of [{ exitCode: 7 }, { exitCode: 4 }, { state: "failed" }, null]) {
    const c = classifyRuntimeFailure(info);
    assert.ok(c.userText && c.userText.length > 10, "userText " + c.kind);
  }
});

test("常量契约：entry 相对安装根 / marker 默认", () => {
  assert.equal(RUNTIME_ENTRY, "runtime/dsh-host.mjs");
  assert.equal(READY_MARKER, "DSH_READY");
});
