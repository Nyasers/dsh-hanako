// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/theme-tokens.test.mjs — DSH token 映射表（src-cordis/plugins/theme/token-map.ts）形状单测。
//
// 这张表是主题跟随的唯一数据面（服务端序列化进 assets/theme-bridge.js，浏览器侧逐条写成
// body{--dsw-*: <宿主 var>!important}）。改错一个 token 名或写错宿主变量名，在真机上只会
// 表现为“某处颜色不跟主题走”，很难定位——所以在这里把形状钉死：
//   · LHS 必须是 --dsw-*（DSH 自己的 token 名）；RHS 必须是宿主主题变量（--foo）或 ~ 字面量；
//   · 宿主变量名必须在上面的允许清单里（防止 --txet 这种手误）；
//   · LHS 不重复（重复会让后一条静默覆盖前一条）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { TOKEN_MAP } from "../src-cordis/plugins/theme/token-map.ts";

// 宿主主题变量的允许清单（壳页从 hana.theme 拿到的 --* 变量；未选中的颜色绝不发明）
const HOST_VARS = new Set([
  "--bg",
  "--bg-card",
  "--sidebar-bg",
  "--text",
  "--text-light",
  "--text-muted",
  "--border",
  "--accent",
  "--accent-hover",
  "--accent-light",
  "--danger",
  "--green",
  "--user-bg",
  "--overlay-medium",
  "--overlay-strong",
  "--drop-overlay-bg",
]);

test("TOKEN_MAP：LHS 均为 --dsw-* 且不重复", () => {
  assert.equal(Array.isArray(TOKEN_MAP), true);
  const seen = new Set();
  for (const row of TOKEN_MAP) {
    assert.equal(Array.isArray(row) && row.length === 2, true, "每行必须是 [token, value]：" + JSON.stringify(row));
    const [token] = row;
    assert.match(token, /^--[a-z0-9-]+$/, "LHS 必须是 CSS 变量名：" + token);
    assert.equal(seen.has(token), false, "LHS 重复：" + token);
    seen.add(token);
  }
  assert.equal(TOKEN_MAP.length >= 100, true, "映射表条目过少（疑似被删）：" + TOKEN_MAP.length);
});

test("TOKEN_MAP：RHS 是宿主主题变量或 ~ 字面量，且变量名在允许清单内", () => {
  const literals = [];
  for (const [token, value] of TOKEN_MAP) {
    if (value.startsWith("~")) {
      literals.push(token);
      continue;
    }
    assert.equal(HOST_VARS.has(value), true, token + " 指向了未知宿主变量：" + value);
  }
  // 只有滚动条这类与主题无关的可见构件允许用字面量
  assert.deepEqual(literals, [
    "--dsw-alias-scrollbar-bg-l1",
    "--dsw-alias-scrollbar-bg-l2",
    "--dsw-alias-scrollbar-hover-l1",
    "--dsw-alias-scrollbar-hover-l2",
  ]);
});

test("TOKEN_MAP：alias 语义层的补漏条目在位", () => {
  const map = new Map(TOKEN_MAP);
  const expect = {
    "--dsw-alias-link": "--accent",
    "--dsw-alias-interactive-bg-hover-danger": "--overlay-medium",
    "--dsw-alias-label-error": "--danger",
    "--dsw-alias-tooltip-bg": "--bg-card",
    "--dsw-alias-toast-bg": "--bg-card",
    "--dsw-alias-bg-skeleton": "--overlay-medium",
    "--dsw-alias-separator-primary": "--border",
    "--dsw-alias-label-quaternary": "--text-muted",
    "--dsw-hovercard-bg": "--bg-card",
  };
  for (const [k, v] of Object.entries(expect)) {
    assert.equal(map.get(k), v, k + " 映射缺失或改变");
  }
});

test("TOKEN_MAP：字体/静态调色板/阴影/几何不参与映射（不随主题走）", () => {
  for (const [token] of TOKEN_MAP) {
    assert.equal(/^--dsw-(font|static|elevation|shadow|corner|mask-blur|linear)/.test(token), false, token + " 不该在映射表里");
  }
});
