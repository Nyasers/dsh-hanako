// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/overlay-typecheck.test.mjs — 覆盖层类型检查的解析与选文件（scripts/overlay-typecheck.mts）
// 重点：诊断必须按"是不是我们的文件"分流——上游诊断只计数，我们的诊断必须拦。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  overlayTsconfig,
  overlayTsFiles,
  parseOverlayDiagnostics,
} from "../scripts/overlay-typecheck.mts";

test("overlayTsFiles：只挑 ts/tsx/mts/cts，容忍字符串与 {path} 两种形态", () => {
  assert.deepEqual(
    overlayTsFiles([
      { path: "src/client/AppFrame.tsx" },
      { path: "src/client/index.ts" },
      { path: "src/client/styles.css" },
      { path: "src/client/notes.md" },
      "src/client/extra.mts",
      null,
      {},
    ]),
    ["src/client/AppFrame.tsx", "src/client/index.ts", "src/client/extra.mts"],
  );
  assert.deepEqual(overlayTsFiles(undefined), []);
});

test("parseOverlayDiagnostics：四分流——我们的错/其它（计入不拦）/上游/配置级", () => {
  const out = [
    "src/client/AppFrame.tsx(139,42): error TS2304: Cannot find name 'role'.",
    "src/client/AppFrame.tsx(29,18): error TS2344: Type '\"root\"' does not satisfy the constraint.",
    "src/client/columns.ts(12,5): warning TS6133: 'x' is declared but its value is never read.",
    "src/slots.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    ".\\src\\client\\index.ts(7,9): error TS2552: Cannot find name 'sesion'. Did you mean 'session'?",
    "tsconfig.overlay.json(22,5): error TS5102: Option 'baseUrl' has been removed.",
    "  ",
    "some noise line without location",
  ].join("\n");
  const { mine, other, upstream, config } = parseOverlayDiagnostics(out, ["src/client/AppFrame.tsx", "src/client/index.ts"]);
  assert.deepEqual(mine.map((d) => d.code), ["TS2304", "TS2552"], "只有失败清单里的码判失败");
  assert.deepEqual(mine[0], {
    file: "src/client/AppFrame.tsx",
    line: 139,
    col: 42,
    severity: "error",
    code: "TS2304",
    message: "Cannot find name 'role'.",
  });
  assert.deepEqual(other.map((d) => d.code), ["TS2344"], "跨包契约类算计入不拦");
  assert.deepEqual(upstream.map((d) => d.file), ["src/client/columns.ts", "src/slots.ts"]);
  assert.equal(config.length, 1, "落不到源码文件里的诊断算配置级（检查器没真跑）");
  assert.equal(config[0].code, "TS5102");
});

test("parseOverlayDiagnostics：空输出/非字符串不炸", () => {
  assert.deepEqual(parseOverlayDiagnostics("", ["a.ts"]), { mine: [], other: [], upstream: [], config: [] });
  assert.deepEqual(parseOverlayDiagnostics(null, []), { mine: [], other: [], upstream: [], config: [] });
});

test("overlayTsconfig：noEmit + bundler 解析 + react-jsx（覆盖层要能在暂存树里被查）", () => {
  const cfg = overlayTsconfig();
  assert.equal(cfg.compilerOptions.noEmit, true);
  assert.equal(cfg.compilerOptions.moduleResolution, "bundler");
  assert.equal(cfg.compilerOptions.jsx, "react-jsx");
  assert.equal(cfg.compilerOptions.skipLibCheck, true);
  assert.deepEqual(cfg.include, ["src/**/*.ts", "src/**/*.tsx"]);
});
