// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/react-version.test.mjs — react 与 react-dom 必须逐字同版。
//
// React 19 在装载时校验两者版本相等，不等就直接抛 Minified React error #527
// （args 里带着两个版本号）。这一条挂在运行期，构建和单测都看不见——真机上才炸。
// 所以这里立门：既查装出来的两份实际版本，也查 manifest 钉的是精确版本
// （浮动区间会让下一次安装把两者拆开：react 先发新版，react-dom 还没跟上）。
//
// 页面侧的证据在 dist/ui/settings.js（React 与 React DOM 一起打进产物），
// 版本一致由本测试在安装层保证。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function installed(name) {
  const file = join(ROOT, "node_modules", name, "package.json");
  return JSON.parse(readFileSync(file, "utf8")).version;
}

function declared(name) {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return deps[name];
}

test("react 与 react-dom 版本逐字相同", () => {
  const react = installed("react");
  const dom = installed("react-dom");
  assert.equal(
    react,
    dom,
    "react 与 react-dom 版本不一致（React 19 会在装载时抛 error #527）：react=" + react + " react-dom=" + dom,
  );
});

test("manifest 里 react/react-dom 钉的是精确版本", () => {
  for (const name of ["react", "react-dom"]) {
    const spec = declared(name);
    assert.ok(spec, "package.json 未声明 " + name);
    assert.match(String(spec), /^\d+\.\d+\.\d+$/, name + " 必须钉精确版本（当前 " + spec + "）：浮动区间会让安装把两者拆开");
  }
});
