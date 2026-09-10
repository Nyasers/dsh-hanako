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
  buildRuntimeConfig,
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

test("buildRuntimeConfig: 基础形态（与 options.js normalizeRuntimeConfig 对偶）", () => {
  const c = buildRuntimeConfig({ dataDir: "/hana/app-data/dsh-hanako", dshPort: 47120, bridgePort: 4317, bridgeKey: "k".repeat(32) });
  assert.deepEqual(c, {
    dataDir: "/hana/app-data/dsh-hanako",
    dshPort: 47120,
    bridgePort: 4317,
    bridgeKey: "k".repeat(32),
    readyMarker: READY_MARKER,
  });
});

test("buildRuntimeConfig: 覆盖项（cordisSrc/depsRoot）只在显式传时出现", () => {
  const base = buildRuntimeConfig({ dataDir: "/x", dshPort: 1, bridgePort: 2, bridgeKey: "k".repeat(32) });
  assert.ok(!("depsRoot" in base));
  assert.ok(!("cordisSrc" in base));
  const full = buildRuntimeConfig({
    dataDir: "/x",
    dshPort: 8080,
    bridgePort: 8081,
    bridgeKey: "k".repeat(32),
    cordisSrc: "/install/cordis",
    depsRoot: "/deps/node_modules",
    readyMarker: "MY_READY",
  });
  assert.deepEqual(full, {
    dataDir: "/x",
    dshPort: 8080,
    bridgePort: 8081,
    bridgeKey: "k".repeat(32),
    cordisSrc: "/install/cordis",
    depsRoot: "/deps/node_modules",
    readyMarker: "MY_READY",
  });
});

test("buildRuntimeConfig: 必填缺失/非法抛错", () => {
  assert.throws(() => buildRuntimeConfig({ dshPort: 1, bridgePort: 2, bridgeKey: "k".repeat(32) }), /dataDir/);
  assert.throws(() => buildRuntimeConfig({ dataDir: "/x", bridgePort: 2, bridgeKey: "k".repeat(32) }), /dshPort/);
  assert.throws(() => buildRuntimeConfig({ dataDir: "/x", dshPort: 1, bridgeKey: "k".repeat(32) }), /bridgePort/);
  assert.throws(() => buildRuntimeConfig({ dataDir: "/x", dshPort: 1, bridgePort: 2, bridgeKey: "short" }), /bridgeKey/);
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
