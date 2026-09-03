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
// 同步（防手改漏同步的坑）→ commit + annotated tag。
// 打包验证（源码能 build + 链路通 + 版本一致）由 preversion 钩子前置：
// pnpm run version → preversion(pnpm run pack → prepack(build) → pack) → version。
// push 手动（tag 触发 CI 发布）。
// 说明：pnpm-lock.yaml 不含该包自身 version（lockfileVersion 仅记录依赖解析树与
// importers 的依赖声明，根包版本不落在 lock 里），故 bump 只同步 package.json +
// manifest.json，pnpm-lock.yaml 无需（也无法）同步 version，交由 pnpm install 自动维护。
// 不碰 CHANGELOG：条目描述是发版内容，由发版人在 bump 前写好并提交（本脚本只在
// 版本号层面保证契约一致，CHANGELOG 是否齐全由人负责）。
//
// semver 语义（对齐 npm version / node-semver inc）：
//   patch      有 prerelease → 去 prerelease 毕业（1.0.0-alpha.1 → 1.0.0，patch 不递增）；
//              无 → x.y.(z+1)（1.0.0 → 1.0.1）
//   minor      node-semver inc：patch !== 0 或无 prerelease 时 minor+1，否则 minor
//              不递增（毕业）；随后 patch=0、清 prerelease——1.0.0-alpha.1 → 1.0.0、
//              1.0.1-alpha.1 → 1.1.0、1.0.0 → 1.1.0
//   major      node-semver inc：minor !== 0 或 patch !== 0 或无 prerelease 时 major+1，
//              否则 major 不递增（毕业）；随后 minor=0、patch=0、清 prerelease——
//              1.0.0-alpha.1 → 1.0.0、1.1.0-alpha.1 → 2.0.0、1.0.0 → 1.0.0（无变化报错）
//   prerelease（别名 pre）有 prerelease → 递增末段序号（1.0.0-alpha.1 → 1.0.0-alpha.2，
//              保留原 preid；末段非数字时追加 .0，1.0.0-alpha → 1.0.0-alpha.0）；
//              无 → x.y.(z+1)-0（npm 默认行为）
//   <完整 semver> 显式版本号（含 prerelease；build 由本脚本自动附 dsh-<依赖> 段）
// 严格 SemVer（node-semver 校验同款）：核心组件与数字 prerelease 标识符必须
// 0|[1-9]\d*（无前导零——01.0.0 / 1.0.0-alpha.01 非法）；非数字标识符须含至少一个
// 字母或连字符（alpha/beta/rc 等）；build metadata 标识符不受前导零限制（SemVer §10）。
//
// 用法：
//   node scripts/version.mjs patch                 # 1.0.0-alpha.1 -> 1.0.0（毕业）
//   node scripts/version.mjs minor                 # 1.0.0-alpha.1 -> 1.0.0（毕业，minor 不递增）；
//                                                 # 1.0.1-alpha.1 -> 1.1.0
//   node scripts/version.mjs major                 # 1.0.0-alpha.1 -> 1.0.0（毕业，major 不递增）；
//                                                 # 1.1.0-alpha.1 -> 2.0.0
//   node scripts/version.mjs prerelease            # 1.0.0-alpha.1 -> 1.0.0-alpha.2（无 pre 时 x.y.(z+1)-0）
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

// ---- npm semver 解析/格式化（零依赖；build metadata 保留，恒承载 dsh 依赖段）----
// 完整格式：major.minor.patch[-prerelease][+build]；prerelease 标识由
// [0-9A-Za-z-]+ 组成、点分隔；build 同构、点分隔。严格化（node-semver 校验同款）：
// 核心组件 0|[1-9]\d*（无前导零）；数字 prerelease 标识符同样禁止前导零（parseSemver
// 内校验）；非数字标识符须含字母或连字符；build 标识符不受前导零限制（SemVer §10）。
// 版本规则（预览期 2026-09-03 定稿）：build metadata 保留且恒为 dsh 依赖段
// `dsh-<dependencies.@deepseek-ai/dsh>`（由本脚本从 package.json 自动计算，不接受自定义
// build——版本号一眼可见跑在哪个 dsh 上，防手误漂移）；bump 子命令：功能改动 bump beta
// 号、bug 修复 pre 递增（-hotfix.N）、`dsh` 子命令只刷新 build 段（主体不变）。
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function parseSemver(v) {
  const s = String(v || "").trim();
  const m = s.match(SEMVER_RE);
  if (!m) return null;
  const pre = m[4] ? m[4].split(".") : null;
  // 数字 prerelease 标识符禁止前导零（1.0.0-alpha.01 非法）；非数字标识符须含字母或连字符
  if (pre) {
    for (const id of pre) {
      if (/^\d+$/.test(id)) {
        if (id.length > 1 && id[0] === "0") return null;
      } else if (!/[A-Za-z-]/.test(id)) {
        return null;
      }
    }
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre,
    build: m[5] ? m[5].split(".") : null, // build 保留（恒为 dsh 段，见上方版本规则）
  };
}

function formatSemver(s) {
  return (
    s.major + "." + s.minor + "." + s.patch +
    (s.pre && s.pre.length ? "-" + s.pre.join(".") : "") +
    (s.build && s.build.length ? "+" + s.build.join(".") : "")
  );
}

// 读当前 dsh 依赖声明（package.json dependencies.@deepseek-ai/dsh；版本规则 build 段来源）
function readDshDep() {
  const pkg = read("package.json");
  const v = pkg?.dependencies?.["@deepseek-ai/dsh"];
  return typeof v === "string" && v ? v : null;
}

// dsh build 段："dsh-" + 依赖版本（依赖版本含 . → build 多标识符，合法）
function dshBuild() {
  const dep = readDshDep();
  if (!dep) {
    console.error("[version] package.json 缺少 @deepseek-ai/dsh 依赖声明，无法计算 build 段");
    process.exit(1);
  }
  return "dsh-" + dep;
}

// 计算新版本主体：current 必须是合法 semver；arg 为子命令或显式版本号。
// build 段不在此层计算（由 main 统一刷新为 dsh 段，见 dshBuild）——本层清输入 build、
// 只算 major/minor/patch/prerelease 主体；显式版本号/子命令解析失败返回 null。
function calcNewVersion(current, arg) {
  const v = parseSemver(current);
  if (!v) return null;
  v.build = null; // build 由 main 统一按依赖计算，不信任输入（防手误漂移）
  // dsh：只刷新 build 段（主体不变）——依赖升级（如 dsh 0.1.2-alpha.5 → .6）时用，
  // 不 bump hotfix/pre（版本规则 2026-09-03：主体不动只更新 dsh 版本）
  if (arg === "dsh") return formatSemver(v);
  if (arg === "patch" || arg === "minor" || arg === "major" || arg === "prerelease" || arg === "pre") {
    if (arg === "patch") {
      if (v.pre && v.pre.length) v.pre = null; // 有 prerelease → 毕业（patch 不递增）
      else v.patch += 1;
      return formatSemver(v);
    }
    if (arg === "minor") {
      // node-semver inc minor：patch !== 0 或无 prerelease 时 minor+1，否则 minor 不
      // 递增（毕业——1.0.0-alpha.1 → 1.0.0；1.0.1-alpha.1 → 1.1.0）；随后 patch=0、
      // 清 prerelease
      if (v.patch !== 0 || !(v.pre && v.pre.length)) v.minor += 1;
      v.patch = 0;
      v.pre = null;
      return formatSemver(v);
    }
    if (arg === "major") {
      // node-semver inc major：minor !== 0 或 patch !== 0 或无 prerelease 时 major+1，
      // 否则 major 不递增（毕业——1.0.0-alpha.1 → 1.0.0；1.1.0-alpha.1 → 2.0.0）；
      // 随后 minor=0、patch=0、清 prerelease
      if (v.minor !== 0 || v.patch !== 0 || !(v.pre && v.pre.length)) v.major += 1;
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
  // 显式版本号：接受完整 semver 主体（含 prerelease；build 由 main 重算为 dsh 段）
  const ev = parseSemver(arg);
  if (!ev) return null;
  ev.build = null;
  return formatSemver(ev);
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
  const nextBase = calcNewVersion(current, versionArg);

  if (nextBase === null) {
    console.error("[version] 无效版本参数: " + versionArg + "（支持 patch|minor|major|prerelease|pre|dsh 或完整 semver，如 1.0.0-beta.0）");
    process.exit(1);
  }
  // build 段统一刷新为 dsh 依赖段（版本规则 2026-09-03：build 恒 = dsh-<dependencies>）
  const next = nextBase + "+" + dshBuild();

  console.log("[version] 当前 " + current + " -> 新版本 " + next + (dryRun ? "（dry-run，不落盘）" : ""));
  if (next === current) {
    console.error("[version] 版本号未变化");
    process.exit(1);
  }
  if (!SEMVER_RE.test(next)) {
    console.error("[version] 无效版本号: " + next + "（须为合法 semver，如 1.0.0 / 1.0.0-beta.2-hotfix.1+dsh-0.1.2-alpha.5）");
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
  console.log("[version] 1/3 package.json -> " + next);

  // 2) manifest.json 同步（脚本保证同步，防漏）
  if (!dryRun) {
    const manifest = read("manifest.json");
    manifest.version = next;
    write("manifest.json", manifest);
  }
  console.log("[version] 2/3 manifest.json -> " + next);

  // 2.5) pnpm-lock.yaml 不同步版本（见文件头：pnpm-lock 不含根包 version，bump 只同步
  //    package.json + manifest.json；lock 由 pnpm install 自动维护，不做机械对齐）

  // 3) git commit + annotated tag（CHANGELOG 由发版人自行维护，bump 前写好并提交；
  //    本脚本只提交版本号两个文件；打包验证已由 preversion 钩子先行完成）
  run("git add package.json manifest.json", "git add");
  run("git commit -m \"chore: bump v" + next + "\"", "git commit");
  run("git tag -a v" + next + " -m \"v" + next + "\"", "git tag -a v" + next);

  console.log("\n[version] ✅ v" + next + " bump 完成（package.json + manifest.json 对齐）。推送（tag 触发 CI 发布）：");
  console.log("  git push origin master --tags");
}

main();
