// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/typecheck.mts — 逐域类型检查（我们有源码的域）
//
// 与覆盖层检查（scripts/overlay-typecheck.mts）共用同一份诊断分类（scripts/ts-diagnostics.mts）：
// 只有"自相矛盾"码判失败，跨包契约/环境类只计数。区别在跑法与"谁算我们的文件"：
//   · 覆盖层：在 _tmp 的暂存树里跑（覆盖层要盖进别人的包才成立），ours = 我们覆盖的那几个文件；
//   · 源码域：在仓库根跑（tsconfig 就在根级，路径相对它解析），ours = 该域目录下的文件。
//
// 用法：node scripts/typecheck.mts [域名…]   （不给域名 = 跑全部）
// 退出码：0 全过；1 有失败项；2 跑不起来（缺 tsc / tsconfig）。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyDiagnostics, formatDiagnostics, parseTsDiagnostics } from "./ts-diagnostics.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 逐域清单：tsconfig 在仓库根（相对路径相对它解析），ours 判定"哪些诊断算我们的"。 */
const DOMAINS = [
  {
    name: "src-cordis",
    config: "tsconfig.cordis.json",
    ours: (file) => file.startsWith("src-cordis/"),
  },
  {
    name: "src",
    config: "tsconfig.src.json",
    ours: (file) => file.startsWith("src/"),
  },
  {
    name: "scripts",
    config: "tsconfig.scripts.json",
    ours: (file) => file.startsWith("scripts/"),
  },
];

/**
 * 跑一个域的类型检查。有失败项抛错（fail-closed）。
 * @returns {{ checked: string, mine: number, other: number, upstream: number }}
 */
export function typecheckDomain(domain, { repoRoot = ROOT, log = (_msg) => {} } = {}) {
  const configPath = join(repoRoot, domain.config);
  if (!existsSync(configPath)) throw new Error(`缺 tsconfig：${configPath}`);
  const tscPath = join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tscPath)) throw new Error(`缺 TypeScript（devDependency）：${tscPath}`);
  const r = spawnSync(process.execPath, [tscPath, "-p", configPath, "--pretty", "false"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) throw new Error(`${domain.name} 类型检查无法运行：${r.error.message}`);
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const { mine, other, upstream, config } = classifyDiagnostics(parseTsDiagnostics(out), domain.ours);
  if (config.length) {
    throw new Error(
      `${domain.name} 类型检查未能运行：tsconfig/编译器报错 ${config.length} 条\n` + formatDiagnostics(config),
    );
  }
  if (r.status !== 0 && mine.length === 0 && other.length === 0 && upstream.length === 0) {
    throw new Error(`${domain.name} 类型检查未能运行：tsc 退出 ${r.status} 但无诊断可解析\n${out.slice(0, 800)}`);
  }
  if (upstream.length) log(`[types] ${domain.name}: 忽略 ${upstream.length} 条域外源码诊断`);
  if (other.length) {
    log(
      `[types] ${domain.name}: ${other.length} 条非失败诊断（计入不拦：${[...new Set(other.map((d) => d.code))].sort().join(", ")}）`,
    );
  }
  if (mine.length) {
    throw new Error(
      `${domain.name} 类型检查未通过（${mine.length} 条）：\n` + formatDiagnostics(mine)
        + "\n（构建只转译不检查，所以在这一步拦。）",
    );
  }
  log(`[types] ${domain.name}: 通过`);
  return { checked: domain.name, mine: 0, other: other.length, upstream: upstream.length };
}

function main() {
  const only = process.argv.slice(2);
  const list = only.length ? DOMAINS.filter((d) => only.includes(d.name)) : DOMAINS;
  if (only.length && list.length === 0) {
    console.error(`[types] 未知域名：${only.join(", ")}（已知：${DOMAINS.map((d) => d.name).join(", ")}）`);
    process.exit(2);
  }
  try {
    for (const domain of list) typecheckDomain(domain, { log: (m) => console.log(m) });
  } catch (e) {
    console.error(`[types] 失败：${(e && e.message) || e}`);
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("typecheck.mts");
if (invokedDirectly) main();
