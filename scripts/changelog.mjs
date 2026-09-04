// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/changelog.mjs — CHANGELOG 生成（conventional-changelog v8 + conventionalcommits preset）
// 职责：version 钩子阶段生成 upcoming release 段并合并进 CHANGELOG.md；也支持全量重生成。
//
// 用法：
//   node scripts/changelog.mjs            # 增量：生成当前未发版段（最近 tag → HEAD），
//                                         #   插入 CHANGELOG.md 头部（幂等：已存在同版本段则替换）
//   node scripts/changelog.mjs --full     # 全量：releaseCount 0 从最早 tag 起重生成，覆盖文件
//                                         #   （首迁 / 事故重建用；--full 顶部可能出现空壳段，
//                                         #    生成逻辑自动丢弃无内容的版本段）
//
// 版本号来源：package.json version（完整版，含 +dsh-<依赖> build 段）。显式 context.version
// 注入——v8 若从 readPackage 自动取 version 会经 normalize 剥掉 build 段，标题/compare 链接
// 只剩裸号，与 tag（完整版）不一致。
import { ConventionalChangelog } from "conventional-changelog";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const fullMode = args.includes("--full");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const version = pkg.version;

async function generate(releaseCount) {
  const gen = new ConventionalChangelog()
    .readPackage()
    .readRepository()
    .loadPreset("conventionalcommits")
    .context({ version }) // 完整版（含 build 段），防 normalize 剥离
    .options({ releaseCount });
  let out = "";
  for await (const chunk of gen.write()) out += chunk;
  return out;
}

const HEADER = "# Changelog";

// 丢弃空版本段（有标题无条目）：按 "\n## " 切段，段内除标题外无实质内容即丢。
// 仅全量模式使用（见 main）：无 conventional commit 的历史版本段（含 releaseCount 0 时
// 当前 version 已被 tag 而生成的顶部空壳段）统一丢弃；增量模式不调用。
function dropEmptySections(text) {
  const sections = text.split(/(?=^## )/m);
  const kept = sections.filter((sec) => {
    const body = sec.replace(/^## .*\n?/, "").trim();
    return body.length > 0;
  });
  return kept.join("");
}

// 幂等合并：文件顶部已存在同版本段 → 整段替换（重跑同版本增量不重复插入）；否则头部插入。
function mergeIntoFile(file, newSection) {
  const titleRe = new RegExp("^## \\[" + escapeRegExp(version) + "\\]");
  let oldBody = "";
  if (fs.existsSync(file)) {
    oldBody = fs.readFileSync(file, "utf8").replace(new RegExp("^" + escapeRegExp(HEADER) + "\\s*\\n?"), "");
  }
  // 头部（首段）同版本 → 替换整段（到下一个 ^## 前）
  if (titleRe.test(oldBody)) {
    const idx = oldBody.indexOf("\n## ", oldBody.indexOf("## "));
    const rest = idx === -1 ? "" : oldBody.slice(idx + 1);
    return HEADER + "\n\n" + newSection.trimEnd() + "\n\n" + rest.trimStart();
  }
  return HEADER + "\n\n" + newSection.trimEnd() + (oldBody.trim() ? "\n\n" + oldBody.trimStart() : "") + "\n";
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main() {
  const generated = fullMode ? await generate(0) : await generate(1);
  // 全量：drop 空段（legacy 0.x / alpha.1 / 纯 dsh 刷新等无 conventional commit 的历史版本 + 顶部"当前
  // 版本伪段"）——CHANGELOG 只留有内容段，完整 tag 序列由 git 承载。
  // 增量：不 drop——upcoming 段即使无条目（refactor/docs 类发版经 preset 过滤）也保留标题段记录发版，
  // 不中断 version 钩子。
  const text = fullMode ? dropEmptySections(generated) : generated;
  if (!text.trim()) {
    console.error("[changelog] 生成内容为空（" + (fullMode ? "全量" : "增量") + "），未写文件");
    process.exit(1);
  }
  const file = path.join(ROOT, "CHANGELOG.md");
  if (fullMode) {
    fs.writeFileSync(file, HEADER + "\n\n" + text.trimEnd() + "\n", "utf8");
    console.log("[changelog] 全量重生成完成（releaseCount 0）→ CHANGELOG.md");
  } else {
    const merged = mergeIntoFile(file, text);
    fs.writeFileSync(file, merged, "utf8");
    console.log("[changelog] 增量生成完成 v" + version + " → CHANGELOG.md");
  }
}

main().catch((e) => {
  console.error("[changelog] 失败: " + e.message);
  process.exit(1);
});
