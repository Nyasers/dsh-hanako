// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/version-hook.mjs — pnpm version 的 version 生命周期钩子（git 收口，完整版号一次成型）
//
// 编排链（替代原自定义 bump 管线 prebump/bump/postbump，2026-09-04 定稿）：
//   pnpm version <patch|minor|major|prerelease|<semver>> --no-git-tag-version
//     preversion（pnpm run build 构建验证）→ pnpm 算号写主（裸号）→ version（本脚本）→ postversion（未定义）
//
// 为什么 git 收口在本钩子内、且必须 --no-git-tag-version：
//   pnpm version 自动 commit/tag 表达不了 build 段——算号即剥离 build metadata（实测 11.24/11.25
//   一致），自动 tag 名与 commit message 的 %s 都锁死在内存裸号上，version 钩子改写 package.json
//   后它们也不重读。tag/commit message 只能裸号（如 v1.0.0-beta.5）则与 package.json 完整版及
//   CI 资产名（带 +dsh-<依赖> 段）对不上，版本单一事实源断裂。故关闭自动 git 操作，收口在
//   version 钩子内做（此时版本号已落盘、git 未动，是唯一能表达完整版的时机）。
//
// 版本规则（2026-09-03 定稿，自 bump.mjs 迁移）：build metadata 保留且恒为 dsh 依赖段
//   `+dsh-<dependencies.@deepseek-ai/dsh>`（本脚本自动重算，不接受自定义——版本号一眼可见
//   跑在哪个 dsh 上，防手误漂移）；pnpm version 算号剥 build，此处拼回完整版再同步派生。
//   bump 子命令映射：beta/hotfix 末段递增 = prerelease（裸跑，保留 preid 递增末段）；毕业 =
//   patch/minor/major（node-semver 语义，实测与旧 bump.mjs 一致）；从正式版开 pre 线 =
//   prerelease --preid=beta / prepatch --preid=hotfix；beta 中途插 hotfix 混合段（beta.2 →
//   beta.2-hotfix.1）与 dsh 刷新（只动 build 段）走显式 semver（后者配 --allow-same-version）。
//
// 职责（version 钩子内按序）：
//   1. 读 package.json version（pnpm 已写裸号）+ dsh 依赖声明 → 拼回完整版写主
//   2. syncver 派生同步（manifest + cordis 包 = 主，幂等）
//   3. changelog 增量生成（conventional-changelog，标题带完整版）
//   4. HEAD 版本门禁（完整版相对 HEAD 未变化 → 拒绝，防 --allow-same-version 空转/误跑）
//   5. tag preflight（v<完整版> 已存在 → 拒绝重复发版）
//   6. git add 版本文件全集 + CHANGELOG → commit "chore: bump v<完整版>" → annotated tag v<完整版>
//
// 门禁/职责沿袭 scripts/tagver.mjs（已并入本脚本）：HEAD 版本门禁 + tag preflight（本地 ref
//  + 远程 origin ls-remote，防克隆未 fetch 远程 tag 导致孤儿 bump commit）；push 手动
// （--atomic 分支与 tag 同成败，tag 触发 CI 发布）。
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { versionCommitFiles, readPkg, writePkg } from "./version-common.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (cmd, desc) => {
  console.log("[version-hook] " + desc + "...");
  try {
    execSync(cmd, { stdio: "inherit", cwd: ROOT, shell: true });
  } catch (e) {
    console.error("[version-hook] " + desc + " 失败: " + e.message);
    process.exit(1);
  }
};

function main() {
  const pkg = readPkg("package.json");
  const bare = pkg.version;
  const dshDep = pkg?.dependencies?.["@deepseek-ai/dsh"];
  if (typeof bare !== "string" || !bare || !dshDep) {
    console.error("[version-hook] package.json version 或 @deepseek-ai/dsh 依赖声明缺失（bare=" + bare + ", dsh=" + dshDep + "）");
    process.exit(1);
  }
  // 1) 拼回完整版（build 段 = dsh 依赖段，版本规则见文件头）写主
  const full = bare + "+dsh-" + dshDep;
  pkg.version = full;
  writePkg("package.json", pkg);
  console.log("[version-hook] 主版本拼回完整版: " + bare + " -> " + full);
  // 2) 派生同步（manifest + cordis 包）
  run("node scripts/syncver.mjs", "syncver 派生同步");
  // 3) changelog 增量生成（读主 version = 完整版）
  run("node scripts/changelog.mjs", "changelog 增量生成");
  // 4) HEAD 门禁：完整版相对 HEAD 未变化（未真实 bump / 同版本重跑）→ 拒绝提交
  let headVersion = null;
  try {
    headVersion = JSON.parse(execSync("git show HEAD:package.json", { cwd: ROOT, encoding: "utf8" })).version;
  } catch {
    /* HEAD 无 package.json（首提交前）→ 视为版本未变，走跳过 */
  }
  if (headVersion === full) {
    console.error("[version-hook] 完整版相对 HEAD 未变化（" + full + "），拒绝 commit/tag——确需重发先删旧 tag 或先提交功能改动");
    process.exit(1);
  }
  // 5) tag preflight：目标 tag 本地或远程已存在则 fail-before（不 staging、不 commit）
  const tagRef = "refs/tags/v" + full;
  // 5a) 本地 ref 检查（防同仓库重复发版）
  try {
    const existing = execSync("git rev-parse -q --verify " + tagRef, {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (existing) {
      console.error("[version-hook] 本地 tag " + tagRef + " 已存在（" + existing.slice(0, 12) + "），拒绝重复发版——如确需重打先删旧 tag");
      process.exit(1);
    }
  } catch {
    /* 本地 tag 不存在：正常，继续 */
  }
  // 5b) 远程 ref 检查（防克隆未 fetch 远程 tag——本地无但 origin 已有，push 时 tag 冲突会
  //     留下无 tag 的孤儿 bump commit）：无 origin remote 时跳过（纯本地仓库场景），
  //     remote 存在但 ls-remote 失败（网络不可达）→ fail-closed 中止——发版必须能确认远端状态
  let hasOrigin = true;
  try {
    execSync("git remote get-url origin", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    hasOrigin = false;
  }
  if (hasOrigin) {
    try {
      const remoteTags = execSync("git ls-remote --tags origin", {
        cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      if (remoteTags.split(/\r?\n/).some((l) => l.includes(tagRef))) {
        console.error("[version-hook] 远程 origin 已存在 tag " + tagRef + "（本地未 fetch 到）——拒绝重复发版，先 git fetch --tags 核对");
        process.exit(1);
      }
    } catch (e) {
      console.error("[version-hook] 无法查询远程 origin tags（网络不可达？）" + e.message.trim() + "——发版前必须确认远端 tag 状态，中止");
      process.exit(1);
    }
  }
  // 6) add 版本文件全集（package.json + manifest + cordis 包）+ CHANGELOG → commit → tag
  const files = [...versionCommitFiles(), "CHANGELOG.md"];
  run("git add " + files.join(" "), "git add 版本文件 + CHANGELOG");
  run("git commit -m \"chore: bump v" + full + "\"", "git commit");
  run("git tag -a \"v" + full + "\" -m \"v" + full + "\"", "git tag -a v" + full);
  console.log("\n[version-hook] ✅ v" + full + " 提交完成（package.json + manifest.json + cordis 包 + CHANGELOG 同步并提交，tag 已打）。推送（tag 触发 CI 发布，--atomic 保证分支与 tag 同成败）：");
  console.log("  git push --atomic origin master --tags");
}

main();
