// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/tagver.mjs — 版本提交命令（独立原子命令，与 syncver 对称）
// 职责：git add 版本文件（package.json + manifest.json + cordis 包）+ commit
// "chore: bump v…" + annotated tag v…。bump 编排引用（package.json 的 postbump =
// "pnpm run syncver && pnpm run tagver"——同步与提交两个独立命令，postbump 仅编排），
// 也可手动补跑（假定 syncver 已同步）。
// 门禁：主版本相对 HEAD 未变化（未真实 bump / bump --dry-run / 工作区杂改动）即跳过
// 提交——防空 commit（历史两次误提交事故根因）。
// 这是仓库自定义 bump 编排（prebump/bump/postbump）的收尾，与 npm/pnpm version 生命
// 周期无关——不要用 pnpm version / npm version 触发。
import { versionCommitFiles } from "./version-common.mjs";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (cmd, desc) => {
  console.log("[tagver] " + desc + "...");
  try {
    execSync(cmd, { stdio: "inherit", cwd: ROOT, shell: true });
  } catch (e) {
    console.error("[tagver] " + desc + " 失败: " + e.message);
    process.exit(1);
  }
};

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const version = pkg.version;
  if (typeof version !== "string" || !version) {
    console.error("[tagver] package.json version 缺失");
    process.exit(1);
  }
  // 硬门禁：仅当主版本相对 HEAD 确实变化（bump 真实改版）才提交——防 bump --dry-run /
  // 工作区杂改动（package.json 其它未提交内容）被误当 bump 提交（历史事故两次）
  let headVersion = null;
  try {
    headVersion = JSON.parse(
      execSync("git show HEAD:package.json", { cwd: ROOT, encoding: "utf8" }),
    ).version;
  } catch {
    /* HEAD 无 package.json（首提交前）→ 视为版本未变，走跳过 */
  }
  if (headVersion === version) {
    console.log("[tagver] 主版本相对 HEAD 未变化（未真实 bump），跳过 git commit/tag");
    return;
  }
  // 预检：目标 tag 已存在则 fail-before（不 staging、不 commit——避免留下未打 tag 的发版 commit）
  const tagRef = "refs/tags/v" + version;
  try {
    const existing = execSync("git rev-parse -q --verify " + tagRef, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (existing) {
      console.error("[tagver] tag " + tagRef + " 已存在（" + existing.slice(0, 12) + "），拒绝重复发版——如确需重打先删旧 tag");
      process.exit(1);
    }
  } catch {
    /* tag 不存在：正常，继续 */
  }
  const files = versionCommitFiles();
  run("git add " + files.join(" "), "git add");
  run("git commit -m \"chore: bump v" + version + "\"", "git commit");
  run("git tag -a v" + version + " -m \"v" + version + "\"", "git tag -a v" + version);
  console.log("\n[tagver] ✅ v" + version + " 提交完成（package.json + manifest.json + cordis 包已同步并提交）。推送（tag 触发 CI 发布）：");
  console.log("  git push origin master --tags");
}

main();
