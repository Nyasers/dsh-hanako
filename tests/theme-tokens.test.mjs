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
  // 下限是防误删的护栏（按当前规模校准，留出正常增删余量；当前 96 条）。
  assert.equal(TOKEN_MAP.length >= 90, true, "映射表条目过少（疑似被删）：" + TOKEN_MAP.length);
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
    "--dsw-alias-bg-skeleton": "--overlay-medium",
    "--dsw-alias-separator-primary": "--border",
    "--dsw-alias-label-quaternary": "--text-muted",
    "--dsw-hovercard-bg": "--bg-card",
  };
  for (const [k, v] of Object.entries(expect)) {
    assert.equal(map.get(k), v, k + " 映射缺失或改变");
  }
});

test("TOKEN_MAP：字体/静态调色板/阴影/几何/结构性深浅不参与映射（不随主题走）", () => {
  for (const [token] of TOKEN_MAP) {
    // tooltip/toast-bg 是"深底 + 硬编码反白字"的功能性配对，不该由 Hana 的主题色接管。
    assert.equal(
      /^--dsw-(font|static|elevation|shadow|corner|mask-blur|linear|alias-tooltip-bg|alias-toast-bg)/.test(token),
      false,
      token + " 不该在映射表里",
    );
    // alias-border-l* 里只放行 l3：它兼作“占用环”的轨道色（ContextMeter 的 .track）；
    // 其余档是 elevation 的描边色来源（结构性：浅色主题黑、深色主题白，随明暗翻转），保持原生。
    if (/^--dsw-alias-border-l/.test(token)) {
      assert.equal(token, "--dsw-alias-border-l3", token + " 只有 l3 允许映射");
    }
  }
});

test("TOKEN_MAP：层次位用叠色而非拿面去顶", () => {
  const map = new Map(TOKEN_MAP);
  // 这几个是"比底略深"的表面。Hana 只有一层 --bg-card，直接接上去差为 0（悬停与静止同色、
  // 按钮与输入框融为一体）；叠色（半透明，叠在卡片上）才能还原 dsh 的 5% 级明度差。
  for (const token of [
    "--dsw-specific-selector",
    "--dsw-alias-interactive-bg-hover-solid",
    "--dsw-alias-bg-skeleton",
  ]) {
    assert.equal(map.get(token), "--overlay-medium", token + " 应为叠色");
  }
});
