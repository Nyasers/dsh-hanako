// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/sync-vendor-layout.mjs — @dsh-hanako/view 的官方 ui-layout client 源码 vendor 同步
// 源：git submodule vendor/deepseek-harness（仓库内相对路径，可移植——clone 后
// `git submodule update --init` 即得；不 env、不硬编码本机路径）。
// 钉版 = submodule 当前 HEAD（唯一事实源，主仓库 gitlink 记录其 commit）：
//   换依赖版本（dsh 锁版升级）= submodule 内 `git fetch && git checkout <新 tag>`
//   → 主仓库 `git add vendor/deepseek-harness` → 重跑本脚本 → 审 vendor diff → 提交。
// 用途：升 dsh 版本/核对 vendor 与上游一致时运行；复制覆盖 src-cordis/plugins/view/vendor/ 整目录。
// 校验：copy 后逐文件字节比对（源 == 目标），失败 exit 1；submodule 未 init / HEAD 缺文件
// 即报错退出（fail-closed——vendor 必须能溯源到钉版 commit）。
// 用法：node scripts/sync-vendor-layout.mjs
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import fs from "fs-extra";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// deepseek-harness 以 submodule 钉在 vendor/（remote = 官方 upstream，gitlink 记录钉版 commit）
const CHECKOUT = join(ROOT, "vendor", "deepseek-harness");
const REL_FILES = [
  "packages/client/ui-layout/src/client/AppFrame.tsx",
  "packages/client/ui-layout/src/client/AppFrame.module.css",
  "packages/client/ui-layout/src/client/columns.ts",
  "packages/client/ui-layout/src/client/DocumentTitle.tsx",
  "packages/client/ui-layout/src/client/service.ts",
  "packages/client/ui-layout/src/client/stores.ts",
  "packages/client/ui-layout/src/client/theme-presenter.ts",
];
const DST_DIR = join(ROOT, "src-cordis", "plugins", "view", "vendor");

function git(args) {
  return execFileSync("git", ["-C", CHECKOUT, ...args], { encoding: "utf8" }).trim();
}
function main() {
  if (!fs.pathExistsSync(join(CHECKOUT, ".git"))) {
    throw new Error(
      "submodule 未初始化：" + CHECKOUT + " 缺失。先跑 `git submodule update --init`（或 clone 时加 --recursive）",
    );
  }
  // submodule HEAD 必须等于主仓库即将记录的 gitlink——防本地漂移（submodule 被 checkout
  // 到别的版本时若静默复制，vendor 会以错钉版记录）。读 **index**（`:path`）而非 HEAD：升版
  // 流程是 submodule checkout 新 tag → `git add vendor/deepseek-harness` → 跑本脚本，
  // 此时新 gitlink 在 index 尚未 commit；未 stage 时 index == HEAD，两场景都覆盖。
  const expectedSha = execFileSync(
    "git",
    ["-C", ROOT, "rev-parse", ":vendor/deepseek-harness"],
    { encoding: "utf8" },
  ).trim();
  const actualSha = git(["rev-parse", "HEAD"]);
  if (actualSha !== expectedSha) {
    throw new Error(`submodule HEAD 不匹配主仓库 gitlink：期望 ${expectedSha}，实际 ${actualSha}（先 git submodule update 对齐）`);
  }
  // 钉版可读名（日志用）：detached at tag → tag 名；否则 describe 形态。内容源一律 HEAD
  //（HEAD = 主仓库 gitlink 记录的钉版 commit，与 tag 名解耦——tag 可被上游移动，commit 不可变）。
  let pinned;
  try {
    pinned = git(["describe", "--tags", "--exact-match", "HEAD"]);
  } catch {
    try {
      pinned = git(["describe", "--tags", "HEAD"]);
    } catch {
      pinned = git(["rev-parse", "--short", "HEAD"]);
    }
  }
  // 原子写：先全部从钉版 commit 读入并暂存（git show HEAD:path，与 submodule 工作树状态
  // 解耦）——任一文件读取失败即中止，**不触碰 DST_DIR**（避免半更新 vendor 树）；全部读
  // 成功后才进入写阶段，逐文件写 + 字节校验。
  const staged = new Map();
  for (const rel of REL_FILES) {
    let content;
    try {
      content = execFileSync("git", ["-C", CHECKOUT, "show", `HEAD:${rel}`], { encoding: "utf8" });
    } catch {
      throw new Error(`submodule HEAD（${pinned}）缺少 ${rel}：钉版不含该文件，确认钉版/路径正确`);
    }
    staged.set(rel, content);
  }
  fs.ensureDirSync(DST_DIR);
  for (const [rel, content] of staged) {
    const target = join(DST_DIR, rel.split("/").pop());
    fs.writeFileSync(target, content);
    const back = fs.readFileSync(target, "utf8");
    if (back !== content) {
      throw new Error(`复制校验失败：${target}`);
    }
    console.log("[sync-vendor]  ", rel, "->", target);
  }
  console.log(`[sync-vendor] 完成（${REL_FILES.length} 文件，钉版 ${pinned} @ ${actualSha.slice(0, 12)}）`);
}
main();
