// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/derive.mts — 派生同步统一入口（apply / --check）
//
// 口径：**派生同步** = 从某个源推导、写回目标文件。凡"能推导 + 被抄了多份 + 抄漏会坏"
// 的事实都走这里；只有人能定的东西（设计取舍、文案措辞、许可范围）不进本表。
//
// 两态：默认写回；`--check` 只校验、漂了就 exit 1（CI 门禁）。每个任务只声明"怎么从源
// 算出期望内容"，比较 / 写回 / 报告由框架统一做——不再各自发明 CLI 和 check。
//
// 一个任务 = 一类读者（再细就成"一个文件一个任务"，derive: 后面排长队反而难用）：
//   manifest     主 package.json#version         → src/manifest.json（宿主读的 App 契约）
//   cordis       主 package.json#version         → src-cordis/**/package.json（profile loader 读的 bundle 层）
//   thirdparty   vendor/hana-app-sdk 的 manifest → THIRD_PARTY_NOTICES.md（分发合规）
//   paths        镜像包清单                       → src-integrations/tsconfig.paths.json（编辑器）
//   vendor       主 package.json 的 dsh 依赖       → vendor/deepseek-harness 的 checkout（状态型）
//
// 不进本表：NOTICE（主体是我们自己的许可声明，只有仓库 URL 会漂，而那事几年一遇，手改即可）；
// changelog（源是 git log，只有发版时有意义，不是"随时可校验"那类）。
//
// 用法：
//   node scripts/derive.mts                # 全部写回
//   node scripts/derive.mts --check        # 全部校验（CI 门禁）
//   node scripts/derive.mts <task> [...]   # 指定任务
//
// 派生目标一律"整份期望内容"比较：框架拿任务算出的内容与磁盘逐字比对，不一致才写。
// 好处是 diff 稳定（任务里不做局部替换，就没有顺序抖动的余地）。
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { cordisPkgPaths, readPkg } from "./version-common.mts";
import { mirrorPathEntries } from "./overlay-typecheck.mts";
import { thirdpartyTask } from "./derive-thirdparty.mts";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 一个派生文件的期望产物（rel 相对仓库根）。 */
export interface DerivedFile {
  rel: string;
  /** 期望的完整文件内容（整份比较，不做局部替换）。 */
  content: string;
}

/** 文件型任务：算出期望内容，由框架比较 / 写回。 */
export interface FileTask {
  kind: "file";
  name: string;
  /** 一句话：源 → 目标（日志与 --check 报告用）。 */
  about: string;
  plan(): DerivedFile[];
}

/**
 * 状态型任务：产出不是文件内容，而是某个外部状态（如 submodule 的 checkout）。
 * inspect 只读、报差异；repair 才动（仅 apply 且有差异时跑）。分开是为了让 --check
 * 绝不产生副作用。
 */
export interface StateTask {
  kind: "state";
  name: string;
  about: string;
  /** 只读检查：返回差异描述（空数组 = 一致）。 */
  inspect(): string[];
  /** 修复动作（仅 apply 且确有差异时执行）。 */
  repair?(): void;
}

export type DeriveTask = FileTask | StateTask;

const join = (...p: string[]) => path.join(ROOT, ...p);
const jsonText = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
const readText = (rel: string) => fs.readFileSync(join(rel), "utf8");
const exists = (rel: string) => fs.existsSync(join(rel));

/** 按主 package.json 的版本重写一批 JSON 的 version 字段（manifest / cordis 共用）。 */
function versionFiles(rels: string[]): DerivedFile[] {
  const version = readPkg("package.json").version;
  if (typeof version !== "string" || !version) throw new Error("package.json version 缺失");
  return rels.map((rel) => {
    const j = readPkg(rel);
    j.version = version;
    return { rel, content: jsonText(j) };
  });
}

/** 任务：manifest —— 主版本 → src/manifest.json（宿主读的 App 契约）。 */
const manifestTask: FileTask = {
  kind: "file",
  name: "manifest",
  about: "package.json#version → src/manifest.json",
  plan: () => versionFiles(["src/manifest.json"]),
};

/** 任务：cordis —— 主版本 → cordis 包（roster bundle + plugins/*，无独立版本线）。 */
const cordisTask: FileTask = {
  kind: "file",
  name: "cordis",
  about: "package.json#version → src-cordis/**/package.json",
  plan: () => versionFiles(cordisPkgPaths()),
};

/** 任务：paths —— 镜像包清单 → 编辑器用的 tsconfig.paths.json。 */
const pathsTask: FileTask = {
  kind: "file",
  name: "paths",
  about: "镜像包清单 → src-integrations/tsconfig.paths.json",
  plan: () => {
    const MIRROR = join("vendor", "deepseek-harness");
    const HIDDEN = join("node_modules", ".pnpm", "node_modules");
    const OUT_DIR = join("src-integrations");
    const toOut = (abs: string) => path.relative(OUT_DIR, abs).replace(/\\/g, "/");
    const paths: Record<string, string[]> = {
      // 本仓装了的包照旧走 pnpm 隐藏目录（与根 tsconfig 同口径）。
      "*": [toOut(path.join(HIDDEN, "*"))],
    };
    for (const [name, targets] of Object.entries(mirrorPathEntries(MIRROR, HIDDEN))) {
      paths[name] = targets.map(toOut);
    }
    return [
      {
        rel: "src-integrations/tsconfig.paths.json",
        content: jsonText({
          "//": "由 node scripts/derive.mts paths 生成，勿手改。供 src-integrations/<集成>/tsconfig.json 继承。",
          compilerOptions: { paths },
        }),
      },
    ];
  },
};

/** 读一条 git 输出（trim；失败返回 null）。 */
function gitOut(cmd: string): string | null {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * 任务：vendor —— 让 vendor/deepseek-harness 站在 `dependencies["@deepseek-ai/dsh"]`
 * 对应的 tag 上。
 *
 * 为何是两条：build 的上游源用 `git show <tag>`（走 tag），而类型解析（mirrorPathEntries）
 * 走**工作树**。只对一条，就会重现「同一份上游被读成两个版本」那类假阳性（曾报出
 * usePanelInfo / MainPanelId 一族）。所以 gitlink 与工作树 HEAD 都要在 tag 上。
 *
 * repair 会 `checkout` 并 `git add`（后者把 gitlink 更新进 index）——它改的是仓库状态，
 * 所以只在 apply 且确有差异时跑，--check 绝不碰。
 */
const vendorTask: StateTask = {
  kind: "state",
  name: "vendor",
  about: "package.json#dependencies[@deepseek-ai/dsh] → vendor/deepseek-harness 的 checkout",
  inspect() {
    const dep = readPkg("package.json")?.dependencies?.["@deepseek-ai/dsh"];
    if (typeof dep !== "string" || !dep) return ["package.json 未声明 dependencies['@deepseek-ai/dsh']"];
    const tag = "dsh-v" + dep;
    // 用 refs/tags/ 全名：避免与同名分支歧义，也绕开 `^` 在 cmd 下是转义符的坑。
    const tagSha = gitOut(`git -C vendor/deepseek-harness rev-parse --verify --quiet refs/tags/${tag}`);
    if (!tagSha) return [`vendor/deepseek-harness 无 ${tag}（镜像未 fetch 到该 tag？）`];
    const out: string[] = [];
    // gitlink：父仓库 tree 记录的 submodule commit（.gitmodules 是配置，这个是"版本"）
    const linkLine = gitOut("git ls-tree HEAD -- vendor/deepseek-harness");
    const linkSha = linkLine ? linkLine.split(/\s+/)[2] : null;
    if (linkSha !== tagSha) out.push(`gitlink ${short(linkSha)} ≠ ${tag}（${short(tagSha)}）`);
    const headSha = gitOut("git -C vendor/deepseek-harness rev-parse HEAD");
    if (headSha !== tagSha) out.push(`工作树 HEAD ${short(headSha)} ≠ ${tag}（${short(tagSha)}）`);
    return out;
  },
  repair() {
    const dep = readPkg("package.json")?.dependencies?.["@deepseek-ai/dsh"];
    const tag = "dsh-v" + dep;
    console.log(`[derive] vendor: git -C vendor/deepseek-harness checkout ${tag}`);
    execSync(`git -C vendor/deepseek-harness checkout ${tag}`, { cwd: ROOT, stdio: "inherit" });
    execSync("git add vendor/deepseek-harness", { cwd: ROOT, stdio: "inherit" });
    console.log("[derive] vendor: gitlink 已暂存——随下次 commit 带上（别让它悬着）");
  },
};

const short = (sha: string | null) => (sha ? sha.slice(0, 12) : "（无）");

/** 全部任务（main 按名筛选用）。 */
export const TASKS: DeriveTask[] = [manifestTask, cordisTask, pathsTask, vendorTask, thirdpartyTask];

/** 跑一个任务：比较期望内容与磁盘，写回或报漂。返回漂移文件数。 */
export function runTask(task: DeriveTask, { checkOnly, log = console.log } = { checkOnly: false, log: console.log as (m: string) => void }): number {
  if (task.kind === "state") {
    const diff = task.inspect();
    if (!diff.length) {
      log(`[derive] ${task.name}: 一致（${task.about}）`);
      return 0;
    }
    for (const d of diff) log(`[derive] ${task.name}: ${d}`);
    if (checkOnly || !task.repair) return diff.length;
    task.repair();
    log(`[derive] ${task.name}: 已修复`);
    return diff.length;
  }
  const files = task.plan();
  const stale = files.filter((f) => !exists(f.rel) || readText(f.rel) !== f.content);
  if (!stale.length) {
    log(`[derive] ${task.name}: 一致（${files.length} 个文件）`);
    return 0;
  }
  if (checkOnly) {
    log(`[derive] ${task.name}: 漂移 ${stale.length} 个文件（${task.about}）`);
    for (const f of stale) log(`  - ${f.rel}`);
    return stale.length;
  }
  for (const f of stale) {
    const to = join(f.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, f.content, "utf8");
    log(`[derive] ${task.name}: 写回 ${f.rel}`);
  }
  return stale.length;
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const wanted = args.filter((a) => !a.startsWith("-"));
  const tasks = wanted.length ? TASKS.filter((t) => wanted.includes(t.name)) : TASKS;
  if (wanted.length && tasks.length !== wanted.length) {
    const known = TASKS.map((t) => t.name).join(", ");
    console.error(`[derive] 未知任务：${wanted.filter((w) => !TASKS.some((t) => t.name === w)).join(", ")}（已知：${known}）`);
    process.exit(2);
  }
  let drift = 0;
  for (const task of tasks) drift += runTask(task, { checkOnly });
  if (checkOnly && drift) {
    console.error(`[derive] 派生文件漂移 ${drift} 处——跑 node scripts/derive.mts 写回后提交`);
    process.exit(1);
  }
  console.log(`[derive] ${checkOnly ? "校验" : "派生"}完成：${tasks.length} 个任务，${drift} 个文件${checkOnly ? "漂移" : "写回"}`);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("derive.mts");
if (invokedDirectly) main();
