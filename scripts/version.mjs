// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/version.mjs — dsh-hanako 版本 bump 自动化（v0.13.4 基建）
//
// 使用时机：所有功能改动已提交、工作区干净、确认要发版时。工作区有未提交改动
// 直接拒绝（bump 是发版动作，不允许混入其他改动）。
//
// 职责边界：只做版本号的机械同步——package.json（单一事实源）bump → manifest.json
// 同步（v0.13.1~0.13.3 手改漏同步的坑）→ pack 验证（版本一致性强制校验）→
// commit + annotated tag。push 手动（tag 触发 CI 发布）。
// 不碰 CHANGELOG：条目描述是发版内容，由发版人在 bump 前写好并提交（本脚本只在
// 版本号层面保证契约一致，CHANGELOG 是否齐全由人负责）。
//
// 用法：
//   node scripts/version.mjs patch                 # 0.13.4 -> 0.13.5
//   node scripts/version.mjs minor                 # -> 0.14.0
//   node scripts/version.mjs major                 # -> 1.0.0
//   node scripts/version.mjs 0.13.5                # 显式版本号
//   node scripts/version.mjs patch --dry-run       # 预览，不落盘不改 git
//   npm run version -- patch                       # 等价

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const versionArg = args.find((a) => !a.startsWith("--"));

if (!versionArg) {
  console.error("用法: node scripts/version.mjs patch|minor|major|<x.y.z> [--dry-run]");
  process.exit(1);
}

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const write = (p, data) => {
  fs.writeFileSync(path.join(ROOT, p), JSON.stringify(data, null, 2) + "\n", "utf8");
};

function calcNewVersion(current, arg) {
  if (arg === "patch" || arg === "minor" || arg === "major") {
    const [major, minor, patch] = current.split(".").map(Number);
    if (arg === "patch") return `${major}.${minor}.${patch + 1}`;
    if (arg === "minor") return `${major}.${minor + 1}.0`;
    return `${major + 1}.0.0`;
  }
  return arg;
}

function run(cmd, desc) {
  console.log(`[version] ${desc}...`);
  if (dryRun) {
    console.log(`  [dry-run] ${cmd}`);
    return;
  }
  try {
    execSync(cmd, { stdio: "inherit", cwd: ROOT, shell: true });
  } catch (e) {
    console.error(`[version] ${desc} 失败: ${e.message}`);
    process.exit(1);
  }
}

function main() {
  const pkg = read("package.json");
  const current = pkg.version;
  const next = calcNewVersion(current, versionArg);

  console.log(`[version] 当前 ${current} -> 新版本 ${next}${dryRun ? "（dry-run，不落盘）" : ""}`);
  if (next === current) {
    console.error("[version] 版本号未变化");
    process.exit(1);
  }
  if (!/^\d+\.\d+\.\d+$/.test(next)) {
    console.error(`[version] 无效版本号: ${next}`);
    process.exit(1);
  }

  // 工作区必须干净（bump 是发版动作，不允许混入其他改动——先提交功能改动再发版）
  const dirty = execSync("git status --porcelain", { cwd: ROOT }).toString().trim();
  if (dirty) {
    console.error(`[version] 工作区有未提交改动，先提交（或还原）再发版：\n${dirty}`);
    process.exit(1);
  }

  // 1) package.json bump（单一事实源）
  if (!dryRun) {
    pkg.version = next;
    write("package.json", pkg);
  }
  console.log(`[version] 1/4 package.json -> ${next}`);

  // 2) manifest.json 同步（v0.13.1~0.13.3 漏同步的坑，脚本保证同步）
  if (!dryRun) {
    const manifest = read("manifest.json");
    manifest.version = next;
    write("manifest.json", manifest);
  }
  console.log(`[version] 2/4 manifest.json -> ${next}`);

  // 3) pack 验证（内含版本一致性强制校验：package.json == manifest.json == 打包版本，
  //    不一致直接 fail；打包版本只读 package.json，不传参）
  run(`node scripts/pack.mjs`, "3/3 打包验证");

  // 4) git commit + annotated tag（CHANGELOG 由发版人自行维护，bump 前写好并提交；
  //    本脚本只提交版本号两个文件）
  run(`git add package.json manifest.json`, "git add");
  run(`git commit -m "chore: bump v${next}"`, "git commit");
  run(`git tag -a v${next} -m "v${next}"`, `git tag -a v${next}`);

  console.log(`\n[version] ✅ v${next} bump 完成。推送（tag 触发 CI 发布）：`);
  console.log(`  git push origin master --tags`);
}

main();
