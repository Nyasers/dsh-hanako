// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/managed-runtime.test.mjs — src/lib/managed-runtime.js 纯函数单测（node --test）
// 覆盖：端口选取（区间随机 + 两端口不相等）、就绪标记（opaque）、子进程配置构造（与
// src/runtime/options.js 对偶）、runtime 终态错误归类（退出码契约 → 用户可读分类）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  choosePort,
  pickPorts,
  makeReadyMarker,
  buildRuntimeConfig,
  classifyRuntimeFailure,
  READY_MARKER,
  RUNTIME_ENTRY,
  PORT_MIN,
  PORT_MAX,
} from "../src/lib/managed-runtime.js";

test("choosePort: 落在 [PORT_MIN, PORT_MAX) 的确定整数（宿主 service 端口契约 1024..65535）", () => {
  assert.equal(choosePort(() => PORT_MIN), PORT_MIN);
  assert.equal(choosePort(() => PORT_MAX - 1), PORT_MAX - 1);
  assert.ok(PORT_MIN >= 1024 && PORT_MAX <= 65535);
  for (let i = 0; i < 200; i++) {
    const p = choosePort();
    assert.ok(Number.isInteger(p) && p >= PORT_MIN && p < PORT_MAX, "port=" + p);
  }
});

test("pickPorts: 中继端口与 DSH 内部端口不相等（撞车时继续取）", () => {
  const seq = [40000, 40000, 40001];
  let i = 0;
  const rng = () => seq[i++];
  const { bridgePort, dshPort } = pickPorts(rng);
  assert.equal(bridgePort, 40000);
  assert.equal(dshPort, 40001);
  for (let n = 0; n < 100; n++) {
    const p = pickPorts();
    assert.notEqual(p.bridgePort, p.dshPort);
    assert.ok(p.bridgePort >= PORT_MIN && p.bridgePort < PORT_MAX);
    assert.ok(p.dshPort >= PORT_MIN && p.dshPort < PORT_MAX);
  }
});

test("makeReadyMarker: 前缀 + 随机 opaque；不含换行；两次不同", () => {
  const a = makeReadyMarker();
  const b = makeReadyMarker();
  assert.ok(a.startsWith(READY_MARKER + ":"));
  assert.ok(a.length > READY_MARKER.length + 16);
  assert.ok(!/[\r\n]/.test(a));
  assert.notEqual(a, b);
});

test("buildRuntimeConfig: 基础形态（与 options.js normalizeRuntimeConfig 对偶）", () => {
  const c = buildRuntimeConfig({ dataDir: "/hana/app-data/dsh-hanako", dshPort: 47120, bridgePort: 4317, bridgeKey: "k".repeat(32), controlKey: "c".repeat(32) });
  assert.deepEqual(c, {
    dataDir: "/hana/app-data/dsh-hanako",
    dshPort: 47120,
    bridgePort: 4317,
    bridgeKey: "k".repeat(32),
    controlKey: "c".repeat(32),
    readyMarker: READY_MARKER,
  });
});

test("buildRuntimeConfig: 覆盖项（cordisSrc/depsRoot）只在显式传时出现", () => {
  const base = buildRuntimeConfig({ dataDir: "/x", dshPort: 1, bridgePort: 2, bridgeKey: "k".repeat(32), controlKey: "c".repeat(32) });
  assert.ok(!("depsRoot" in base));
  assert.ok(!("cordisSrc" in base));
  const full = buildRuntimeConfig({
    dataDir: "/x",
    dshPort: 8080,
    bridgePort: 8081,
    bridgeKey: "k".repeat(32),
    controlKey: "c".repeat(32),
    cordisSrc: "/install/cordis",
    depsRoot: "/deps/node_modules",
    readyMarker: "MY_READY",
  });
  assert.deepEqual(full, {
    dataDir: "/x",
    dshPort: 8080,
    bridgePort: 8081,
    bridgeKey: "k".repeat(32),
    controlKey: "c".repeat(32),
    cordisSrc: "/install/cordis",
    depsRoot: "/deps/node_modules",
    readyMarker: "MY_READY",
  });
});

test("buildRuntimeConfig: 必填缺失/非法抛错", () => {
  assert.throws(() => buildRuntimeConfig({ dshPort: 1, bridgePort: 2, bridgeKey: "k".repeat(32), controlKey: "c".repeat(32) }), /dataDir/);
  assert.throws(() => buildRuntimeConfig({ dataDir: "/x", bridgePort: 2, bridgeKey: "k".repeat(32), controlKey: "c".repeat(32) }), /dshPort/);
  assert.throws(() => buildRuntimeConfig({ dataDir: "/x", dshPort: 1, bridgeKey: "k".repeat(32), controlKey: "c".repeat(32) }), /bridgePort/);
  assert.throws(() => buildRuntimeConfig({ dataDir: "/x", dshPort: 1, bridgePort: 2, controlKey: "c".repeat(32) }), /bridgeKey/);
  assert.throws(() => buildRuntimeConfig({ dataDir: "/x", dshPort: 1, bridgePort: 2, bridgeKey: "k".repeat(32) }), /controlKey/);
});

test("buildRuntimeConfig: dshHome（当前数据源 W3）只在显式传时出现", () => {
  const base = buildRuntimeConfig({ dataDir: "/x", dshPort: 1, bridgePort: 2, bridgeKey: "k".repeat(32), controlKey: "c".repeat(32) });
  assert.ok(!("dshHome" in base), "未传时不出现（子进程自回落 <dataDir>/dsh-home）");
  const withHome = buildRuntimeConfig({ dataDir: "/x", dshHome: "/x/dsh-home", dshPort: 1, bridgePort: 2, bridgeKey: "k".repeat(32), controlKey: "c".repeat(32) });
  assert.equal(withHome.dshHome, "/x/dsh-home");
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

test("常量契约：entry 相对安装根 / marker 前缀 / 端口区间", () => {
  assert.equal(RUNTIME_ENTRY, "runtime/dsh-host.mjs");
  assert.equal(READY_MARKER, "DSH_READY");
  assert.equal(PORT_MIN, 38000);
  assert.equal(PORT_MAX, 52000);
});
