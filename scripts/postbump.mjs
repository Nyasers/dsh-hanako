// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/postbump.mjs — 发版收尾：派生版本同步 + git commit/tag（仓库 bump 编排的收尾阶段）
// 由 pnpm run bump 钩子链的 postbump 触发（package.json scripts.postbump），在 bump 阶段
// 在 version 阶段（scripts/bump.mjs 已 bump 主 package.json）之后执行：
//   1) manifest.json version 同步 = 主 package.json（脚本保证同步，防手改漏同步）
//   2) cordis 包 version 同步（src-cordis 顶层 roster bundle + plugins/* 9 个：随插件
//      整体发版不独立发布，历史独立号废弃，version 仅元数据一致性）
//   3) git add（package.json + manifest.json + cordis 包）→ commit "chore: bump v…" →
//      annotated tag v…
// CHANGELOG 由发版人自行维护（bump 前写好并提交）；打包验证已由 prebump 钩子先行
// （pnpm run pack）完成——本脚本只做版本号文件的机械同步与提交收尾。
// 注意：本流程是仓库自定义 bump 编排（prebump/bump/postbump），与 npm/pnpm 的 version\n// 生命周期完全无关——不要用 pnpm version / npm version 触发。
// 手动补跑：node scripts/postbump.mjs（读主 package.json version 对齐派生 + 提交）。
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const write = (p, data) => {
  fs.writeFileSync(path.join(ROOT, p), JSON.stringify(data, null, 2) + "\n", "utf8");
};
const run = (cmd, desc) => {
  console.log("[postbump] " + desc + "...");
  try {
    execSync(cmd, { stdio: "inherit", cwd: ROOT, shell: true });
  } catch (e) {
    console.error("[postbump] " + desc + " 失败: " + e.message);
    process.exit(1);
  }
};

// cordis 包清单（与 bump.mjs 同构；同步对象 = src-cordis 顶层 + plugins/*）
function cordisPkgPaths() {
  const out = ["src-cordis/package.json"];
  const plugins = path.join(ROOT, "src-cordis", "plugins");
  for (const name of fs.readdirSync(plugins)) {
    const p = path.join(plugins, name);
    if (!fs.statSync(p).isDirectory()) continue;
    const pj = path.join(p, "package.json");
    if (fs.existsSync(pj)) out.push(path.relative(ROOT, pj));
  }
  return out.sort();
}

function main() {
  // 主版本为唯一事实源（version 阶段已 bump）
  const pkg = read("package.json");
  const version = pkg.version;
  if (typeof version !== "string" || !version) {
    console.error("[postbump] package.json version 缺失");
    process.exit(1);
  }

  // 1) manifest.json 同步
  const manifest = read("manifest.json");
  let manifestChanged = false;
  if (manifest.version !== version) {
    manifest.version = version;
    write("manifest.json", manifest);
    manifestChanged = true;
    console.log("[postbump] manifest.json -> " + version);
  } else {
    console.log("[postbump] manifest.json 已一致（" + version + "）");
  }

  // 2) cordis 包同步
  const cordisFiles = cordisPkgPaths();
  let cordisChanged = 0;
  for (const rel of cordisFiles) {
    const c = read(rel);
    if (c.version !== version) {
      c.version = version;
      write(rel, c);
      cordisChanged += 1;
    }
  }
  console.log(
    "[postbump] cordis 包同步：" + cordisFiles.length + " 个（" + cordisChanged + " 个已写）-> " + version,
  );

  // 3) 真实同步门禁：仅当 version 阶段确实 bump 过（manifest/cordis 相对新主版本有实际
  //    写入）才提交。手动误跑/未 bump（版本未变）时派生全等 → 直接跳过 git（无论工作区
  //    是否有其它未提交改动——bump 的干净检查在 bump 阶段，postbump 不替它越权提交杂项）
  if (!manifestChanged && cordisChanged === 0) {
    console.log("[postbump] 无派生版本同步（版本未变化或已一致），跳过 git commit/tag");
    return;
  }
  const syncFiles = ["package.json", "manifest.json", ...cordisFiles];
  run("git add " + syncFiles.join(" "), "git add");
  run("git commit -m \"chore: bump v" + version + "\"", "git commit");
  run("git tag -a v" + version + " -m \"v" + version + "\"", "git tag -a v" + version);
  console.log("\n[postbump] ✅ v" + version + " 提交完成（package.json + manifest.json + " + cordisFiles.length + " 个 cordis 包对齐）。推送（tag 触发 CI 发布）：");
  console.log("  git push origin master --tags");
}

main();
