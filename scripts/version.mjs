// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/version.mjs — dsh-hanako 版本 bump 自动化（npm semver 体系）
//
// 使用时机：所有功能改动已提交、工作区干净、确认要发版时。工作区有未提交改动
// 直接拒绝（bump 是发版动作，不允许混入其他改动）——dry-run 只是预览，不要求
// 工作区干净（自测/预览时允许有未提交改动）。
//
// 职责边界：只做版本号的机械同步——package.json（单一事实源）bump → manifest.json
// 同步（防手改漏同步的坑）→ pack 校验（版本一致性强制校验）→ commit + annotated tag。
// push 手动（tag 触发 CI 发布）。
// 说明：pnpm-lock.yaml 不含该包自身 version（lockfileVersion 仅记录依赖解析树与
// importers 的依赖声明，根包版本不落在 lock 里），故 bump 只同步 package.json +
// manifest.json，pnpm-lock.yaml 无需（也无法）同步 version，交由 pnpm install 自动维护。
// 不碰 CHANGELOG：条目描述是发版内容，由发版人在 bump 前写好并提交（本脚本只在
// 版本号层面保证契约一致，CHANGELOG 是否齐全由人负责）。
//
// semver 语义（对齐 npm version）：
//   patch      有 prerelease → 去 prerelease 毕业（1.0.0-alpha.1 → 1.0.0，patch 不递增）；
//              无 → x.y.(z+1)（1.0.0 → 1.0.1）
//   minor      → x.(y+1).0（清 prerelease；1.0.0-alpha.1 → 1.1.0）
//   major      → (x+1).0.0（清 prerelease）
//   prerelease（别名 pre）有 prerelease → 递增末段序号（1.0.0-alpha.1 → 1.0.0-alpha.2，
//              保留原 preid；末段非数字时追加 .0，1.0.0-alpha → 1.0.0-alpha.0）；
//              无 → x.y.(z+1)-0（npm 默认行为）
//   <完整 semver> 显式版本号（含 prerelease / build metadata；build 剥离不保留）
//
// 用法：
//   node scripts/version.mjs patch                 # 1.0.0-alpha.1 -> 1.0.0（毕业）
//   node scripts/version.mjs minor                 # -> 1.1.0
//   node scripts/version.mjs major                 # -> 2.0.0
//   node scripts/version.mjs prerelease            # -> 1.0.0-alpha.2（无 pre 时 x.y.(z+1)-0）
//   node scripts/version.mjs pre                   # 同 prerelease
//   node scripts/version.mjs 1.0.0-beta.0          # 显式版本号（完整 semver）
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
  console.error("用法: node scripts/version.mjs patch|minor|major|prerelease|pre|<semver> [--dry-run]");
  process.exit(1);
}

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const write = (p, data) => {
  fs.writeFileSync(path.join(ROOT, p), JSON.stringify(data, null, 2) + "\n", "utf8");
};

// ---- npm semver 解析/格式化（零依赖；build metadata 解析但剥离不保留）----
// 完整格式：major.minor.patch[-prerelease][+build]；prerelease 标识由
// [0-9A-Za-z-]+ 组成、点分隔；build 同构、点分隔。
const SEMVER_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(v) {
  const s = String(v || "").trim();
  const m = s.match(SEMVER_RE);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : null,
  };
}

function formatSemver(s) {
  return (
    s.major + "." + s.minor + "." + s.patch +
    (s.pre && s.pre.length ? "-" + s.pre.join(".") : "")
  );
}

// 计算新版本：current 必须是合法 semver；arg 为子命令或显式版本号。
// 显式版本号非法/子命令解析失败返回 null（调用方报错退出）。
function calcNewVersion(current, arg) {
  const v = parseSemver(current);
  if (!v) return null;
  if (arg === "patch" || arg === "minor" || arg === "major" || arg === "prerelease" || arg === "pre") {
    if (arg === "patch") {
      if (v.pre && v.pre.length) v.pre = null; // 有 prerelease → 毕业（patch 不递增）
      else v.patch += 1;
      return formatSemver(v);
    }
    if (arg === "minor") {
      v.minor += 1;
      v.patch = 0;
      v.pre = null;
      return formatSemver(v);
    }
    if (arg === "major") {
      v.major += 1;
      v.minor = 0;
      v.patch = 0;
      v.pre = null;
      return formatSemver(v);
    }
    // prerelease / pre
    if (v.pre && v.pre.length) {
      const last = v.pre[v.pre.length - 1];
      if (/^\d+$/.test(last)) {
        v.pre[v.pre.length - 1] = String(Number(last) + 1); // 递增末段序号，保留 preid
      } else {
        v.pre.push("0"); // 末段非数字 → 追加 .0（npm semver.inc 行为）
      }
    } else {
      v.patch += 1; // 无 prerelease → x.y.(z+1)-0（npm 默认行为）
      v.pre = ["0"];
    }
    return formatSemver(v);
  }
  // 显式版本号：接受完整 semver（含 prerelease / build metadata）；剥离 build 保留
  const ev = parseSemver(arg);
  return ev ? formatSemver(ev) : null;
}

function run(cmd, desc) {
  console.log("[version] " + desc + "...");
  if (dryRun) {
    console.log("  [dry-run] " + cmd);
    return;
  }
  try {
    execSync(cmd, { stdio: "inherit", cwd: ROOT, shell: true });
  } catch (e) {
    console.error("[version] " + desc + " 失败: " + e.message);
    process.exit(1);
  }
}

function main() {
  const pkg = read("package.json");
  const current = pkg.version;
  if (!parseSemver(current)) {
    console.error("[version] 当前版本不是合法 semver: " + current);
    process.exit(1);
  }
  const next = calcNewVersion(current, versionArg);

  console.log("[version] 当前 " + current + " -> 新版本 " + next + (dryRun ? "（dry-run，不落盘）" : ""));
  if (next === null) {
    console.error("[version] 无效版本参数: " + versionArg + "（支持 patch|minor|major|prerelease|pre 或完整 semver，如 1.0.0-beta.0）");
    process.exit(1);
  }
  if (next === current) {
    console.error("[version] 版本号未变化");
    process.exit(1);
  }
  if (!SEMVER_RE.test(next)) {
    console.error("[version] 无效版本号: " + next + "（须为合法 semver，如 1.0.0 / 1.0.0-alpha.1）");
    process.exit(1);
  }

  // 工作区必须干净（bump 是发版动作，不允许混入其他改动——先提交功能改动再发版）。
  // dry-run 只是预览（自测/看将要发生的改动），不要求工作区干净。
  if (!dryRun) {
    const dirty = execSync("git status --porcelain", { cwd: ROOT }).toString().trim();
    if (dirty) {
      console.error("[version] 工作区有未提交改动，先提交（或还原）再发版：\n" + dirty);
      process.exit(1);
    }
  }

  // 1) package.json bump（单一事实源）
  if (!dryRun) {
    pkg.version = next;
    write("package.json", pkg);
  }
  console.log("[version] 1/4 package.json -> " + next);

  // 2) manifest.json 同步（脚本保证同步，防漏）
  if (!dryRun) {
    const manifest = read("manifest.json");
    manifest.version = next;
    write("manifest.json", manifest);
  }
  console.log("[version] 2/4 manifest.json -> " + next);

  // 2.5) pnpm-lock.yaml 不同步版本（见文件头：pnpm-lock 不含根包 version，bump 只同步
  //    package.json + manifest.json；lock 由 pnpm install 自动维护，不做机械对齐）

  // 3) pack 验证（内含版本一致性强制校验：package.json == manifest.json == 打包版本，
  //    不一致直接 fail；打包版本只读 package.json，不传参）
  run("node scripts/pack.mjs", "3/4 打包验证");

  // 4) git commit + annotated tag（CHANGELOG 由发版人自行维护，bump 前写好并提交；
  //    本脚本只提交版本号两个文件）
  run("git add package.json manifest.json", "git add");
  run("git commit -m \"chore: bump v" + next + "\"", "git commit");
  run("git tag -a v" + next + " -m \"v" + next + "\"", "git tag -a v" + next);

  console.log("\n[version] ✅ v" + next + " bump 完成（package.json + manifest.json 对齐）。推送（tag 触发 CI 发布）：");
  console.log("  git push origin master --tags");
}

main();
