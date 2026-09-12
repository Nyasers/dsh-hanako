// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/options.test.mjs — src/runtime/options.js 纯函数单测（node --test）
// 覆盖：私有配置文件形态（argv[1] = config 路径）、配置 schema 校验（dataDir 必填、
// dshPort/bridgePort 1..65535 且不相同、bridgeKey 长度、readyMarker 换行）、--help 豁免、
// 非法 JSON / 读取失败。读取经注入的 readFile 打桩，不触盘。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRuntimeConfig, normalizeRuntimeConfig, UsageError, USAGE } from "../src/runtime/options.js";

const GOOD = {
  dataDir: "/hana/app-data/dshana",
  dshPort: 47120,
  bridgePort: 4317,
  bridgeKey: "k".repeat(32),
  controlKey: "c".repeat(32),
  readyMarker: "DSH_READY",
};

const read = (obj) => () => JSON.stringify(obj);

test("parseRuntimeConfig: 合法配置（注入读取）", () => {
  const o = parseRuntimeConfig(["/tmp/runtime.json"], read(GOOD));
  assert.equal(o.dataDir, GOOD.dataDir);
  assert.equal(o.dshPort, 47120);
  assert.equal(o.bridgePort, 4317);
  assert.equal(o.bridgeKey, GOOD.bridgeKey);
  assert.equal(o.controlKey, GOOD.controlKey);
  assert.equal(o.readyMarker, "DSH_READY");
  assert.equal(o.cordisSrc, null);
  assert.equal(o.depsRoot, null);
});

test("parseRuntimeConfig: 可选 cordisSrc/depsRoot", () => {
  const o = parseRuntimeConfig(["/tmp/runtime.json"], read({ ...GOOD, cordisSrc: "/app/cordis", depsRoot: "/app/node_modules" }));
  assert.equal(o.cordisSrc, "/app/cordis");
  assert.equal(o.depsRoot, "/app/node_modules");
});

test("normalizeRuntimeConfig: preflight 形态——只要 dataDir + dshHome + resultPath，不要端口/凭据", () => {
  const o = normalizeRuntimeConfig({ dataDir: "/d", dshHome: "/d/dsh-home", preflight: true, resultPath: "/d/integration/pf.json" });
  assert.deepEqual(o, { dataDir: "/d", dshHome: "/d/dsh-home", preflight: true, resultPath: "/d/integration/pf.json", cordisSrc: null, depsRoot: null });
  assert.equal(o.dshPort, undefined, "不要求端口");
  assert.equal(o.bridgeKey, undefined, "不要求凭据");
});

test("normalizeRuntimeConfig: preflight 缺 dshHome/resultPath / 非法 resultPath 都被拒", () => {
  assert.throws(() => normalizeRuntimeConfig({ dataDir: "/d", preflight: true, resultPath: "/d/pf.json" }), /dshHome/);
  assert.throws(() => normalizeRuntimeConfig({ dataDir: "/d", dshHome: "/h", preflight: true }), /resultPath/);
  assert.throws(() => normalizeRuntimeConfig({ dataDir: "/d", dshHome: "/h", preflight: true, resultPath: "rel.json" }), /resultPath/);
  assert.throws(() => normalizeRuntimeConfig({ ...GOOD, preflight: "yes" }), /preflight/);
});

test("parseRuntimeConfig: 预检配置文件经注入读取（不要求端口）", () => {
  const o = parseRuntimeConfig(["/tmp/pf.json"], read({ dataDir: "/d", dshHome: "/h", preflight: true, resultPath: "/d/r.json" }));
  assert.equal(o.preflight, true);
  assert.equal(o.resultPath, "/d/r.json");
});

test("parseRuntimeConfig: 可选 dshHome（当前数据源 W3）——须绝对路径且不含 NUL", () => {
  const o = parseRuntimeConfig(["/tmp/runtime.json"], read({ ...GOOD, dshHome: "/hana/app-data/dshana/dsh-home" }));
  assert.equal(o.dshHome, "/hana/app-data/dshana/dsh-home");
  assert.ok(!("dshHome" in normalizeRuntimeConfig(GOOD)), "未传时不出现该键（子进程自回落）");
  assert.throws(
    () => normalizeRuntimeConfig({ ...GOOD, dshHome: "relative/home" }),
    (e) => e instanceof UsageError && /dshHome/.test(e.message),
  );
  assert.throws(() => normalizeRuntimeConfig({ ...GOOD, dshHome: "/x\0y" }), /dshHome/);
});

test("parseRuntimeConfig: readyMarker 缺省 DSH_READY", () => {
  const o = normalizeRuntimeConfig({ ...GOOD, readyMarker: undefined });
  assert.equal(o.readyMarker, "DSH_READY");
});

test("normalizeRuntimeConfig: 端口契约——0/负/越界/非数/dshPort==bridgePort 均拒绝", () => {
  for (const bad of [0, -1, 65536, 1.5, "abc", null]) {
    assert.throws(() => normalizeRuntimeConfig({ ...GOOD, bridgePort: bad }), (e) => e instanceof UsageError, "bridgePort=" + String(bad));
    assert.throws(() => normalizeRuntimeConfig({ ...GOOD, dshPort: bad }), (e) => e instanceof UsageError, "dshPort=" + String(bad));
  }
  assert.throws(() => normalizeRuntimeConfig({ ...GOOD, dshPort: GOOD.bridgePort }), (e) => e instanceof UsageError && /不能相同/.test(e.message));
});

test("normalizeRuntimeConfig: dataDir 必填", () => {
  assert.throws(() => normalizeRuntimeConfig({ ...GOOD, dataDir: "" }), (e) => e instanceof UsageError && /dataDir/.test(e.message));
  assert.throws(() => normalizeRuntimeConfig({ ...GOOD, dataDir: 5 }), (e) => e instanceof UsageError);
});

test("normalizeRuntimeConfig: bridgeKey/controlKey 必填且不短于 16 字符", () => {
  assert.throws(() => normalizeRuntimeConfig({ ...GOOD, bridgeKey: "short" }), (e) => e instanceof UsageError && /bridgeKey/.test(e.message));
  assert.throws(() => normalizeRuntimeConfig({ ...GOOD, bridgeKey: "" }), (e) => e instanceof UsageError);
  assert.throws(() => normalizeRuntimeConfig({ ...GOOD, controlKey: "short" }), (e) => e instanceof UsageError && /controlKey/.test(e.message));
  assert.throws(() => normalizeRuntimeConfig({ ...GOOD, controlKey: "" }), (e) => e instanceof UsageError);
});

test("normalizeRuntimeConfig: readyMarker 含换行拒绝（宿主按整行匹配）", () => {
  for (const m of ["A\nB", "A\rB"]) {
    assert.throws(() => normalizeRuntimeConfig({ ...GOOD, readyMarker: m }), (e) => e instanceof UsageError && /readyMarker/.test(e.message));
  }
});

test("parseRuntimeConfig: 缺配置文件路径 / 多参数 / 非法 JSON / 读取失败 → UsageError", () => {
  assert.throws(() => parseRuntimeConfig([]), (e) => e instanceof UsageError);
  assert.throws(() => parseRuntimeConfig(["--port", "8080"]), (e) => e instanceof UsageError);
  assert.throws(() => parseRuntimeConfig(["/tmp/x", "extra"], read(GOOD)), (e) => e instanceof UsageError && /未知参数/.test(e.message));
  assert.throws(() => parseRuntimeConfig(["/tmp/x"], () => "{not json"), (e) => e instanceof UsageError && /JSON/.test(e.message));
  assert.throws(() => parseRuntimeConfig(["/tmp/x"], () => { throw new Error("ENOENT"); }), (e) => e instanceof UsageError);
});

test("parseRuntimeConfig: --help 豁免", () => {
  const o = parseRuntimeConfig(["--help"]);
  assert.equal(o.help, true);
  assert.match(USAGE, /runtime-config\.json/);
});
