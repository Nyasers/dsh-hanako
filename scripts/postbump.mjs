// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/postbump.mjs — bump 收尾：git commit + annotated tag（版本文件提交）
// 职责单一：postbump 实际做两件事——①同步（manifest + cordis 源 = 主，由前置 syncver
// 完成：package.json scripts 编排 "postbump": "pnpm run syncver && node scripts/postbump.mjs"）
// ②提交（本脚本）。只提交版本文件（package.json + manifest.json + cordis 包），
// 若全无改动（未 bump 手跑/已同步提交过）跳过——防空 commit。
// 这是仓库自定义 bump 编排（prebump/bump/postbump）的收尾，与 npm/pnpm version 生命
// 周期无关——不要用 pnpm version / npm version 触发。
// 手动补跑：node scripts/postbump.mjs（假定 syncver 已跑）。
// 版本文件全集（含主 package.json）来自根级共享 version-common.mjs（与 syncver/bump 同源）
import { versionCommitFiles } from "./version-common.mjs";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (cmd, desc) => {
  console.log("[postbump] " + desc + "...");
  try {
    execSync(cmd, { stdio: "inherit", cwd: ROOT, shell: true });
  } catch (e) {
    console.error("[postbump] " + desc + " 失败: " + e.message);
    process.exit(1);
  }
};

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const version = pkg.version;
  if (typeof version !== "string" || !version) {
    console.error("[postbump] package.json version 缺失");
    process.exit(1);
  }
  const files = versionCommitFiles();
  const diff = execSync("git status --porcelain -- " + files.join(" "), {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (!diff) {
    console.log("[postbump] 版本文件无改动（未 bump 或已提交），跳过 git commit/tag");
    return;
  }
  run("git add " + files.join(" "), "git add");
  run("git commit -m \"chore: bump v" + version + "\"", "git commit");
  run("git tag -a v" + version + " -m \"v" + version + "\"", "git tag -a v" + version);
  console.log("\n[postbump] ✅ v" + version + " 提交完成（package.json + manifest.json + cordis 包已同步并提交）。推送（tag 触发 CI 发布）：");
  console.log("  git push origin master --tags");
}

main();
