// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/integrations.mjs — 集成层的漂移闸（见 integrations/README.md 与 specs/current/hana-integrations）
//
// 用法：
//   node scripts/integrations.mjs verify          # 镜像版本一致 + 每个 overlay 记录的上游哈希仍成立
//   node scripts/integrations.mjs stage           # verify 后把 overlay 落进 _tmp/integrations/<短名>/
//   node scripts/integrations.mjs hash <仓库相对路径>   # 打印上游该文件的 sha256（写清单时用）
//   node scripts/integrations.mjs list
//
// 闸的意义：overlay 是「上游某版文件 + 我们的 delta」的整文件拷贝，清单记下当时上游文件的 sha256。
// 构建时用**当前镜像**重算比对；不一致 = 上游动过 → 构建失败并指名要 rebase 的文件。
// 于是"拷贝即冻结"在流程上不可能发生（这正是 0.1.2 冻结导致真机黑屏的根因）。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..");
const MIRROR = join(REPO_ROOT, "vendor", "deepseek-harness");

// ---------- 纯函数（导出供单测） ----------

/** DSH 版本 → 上游 git tag（release 线形如 dsh-v0.1.5-rc.2）。 */
export function tagForVersion(version) {
  return "dsh-v" + String(version ?? "").trim();
}

/** sha256（hex 小写）。 */
export function sha256(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8");
  return createHash("sha256").update(b).digest("hex");
}

/** 从 package.json 取 pin 的 DSH 版本。 */
export function dshVersionOf(pkgJson) {
  const v = pkgJson && pkgJson.dependencies && pkgJson.dependencies["@deepseek-ai/dsh"];
  return typeof v === "string" && v ? v : null;
}

/**
 * 校验一组集成清单（纯函数：上游文件由 readUpstream 提供，便于单测）。
 * 任一处不成立就抛错，错误信息给出「该 rebase 哪个文件、哈希改成什么」。
 * @param {Array<{dir?:string,package?:string,upstreamDir?:string,files?:Array<{path:string,upstreamSha256:string}>}>} integrations
 * @param {(repoRelPath:string)=>Buffer|null} readUpstream 读上游文件（仓库相对路径 → 内容；不存在返回 null）
 * @returns {{packages:number, files:number, empty:string[]}}
 */
export function verifyIntegrations(integrations, readUpstream) {
  const problems = [];
  const empty = [];
  let files = 0;
  for (const it of Array.isArray(integrations) ? integrations : []) {
    const name = it && (it.dir || it.package) ? String(it.dir || it.package) : "(未命名)";
    const pkg = String((it && it.package) || "");
    if (!pkg) problems.push(`integration ${name}: 缺少 package`);
    const upstreamDir = String((it && it.upstreamDir) || "");
    if (!upstreamDir) problems.push(`integration ${name}: 缺少 upstreamDir`);
    const list = Array.isArray(it && it.files) ? it.files : [];
    if (list.length === 0) empty.push(name);
    for (const f of list) {
      const rel = f && typeof f.path === "string" ? f.path : "";
      if (!rel) {
        problems.push(`integration ${name}: files[] 项缺少 path`);
        continue;
      }
      const recorded = String((f && f.upstreamSha256) || "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(recorded)) {
        problems.push(`integration ${name}: ${rel} 未记录合法的 upstreamSha256（64 位 hex）`);
        continue;
      }
      const upstreamRel = upstreamDir + "/" + rel;
      let content;
      try {
        content = readUpstream(upstreamRel);
      } catch (e) {
        problems.push(`integration ${name}: 读上游 ${upstreamRel} 失败：${(e && e.message) || e}`);
        continue;
      }
      if (content === null || content === undefined) {
        problems.push(
          `integration ${name}: 上游不存在 ${upstreamRel}（路径被移动/删除？请核对 upstreamDir 与 files[].path）`,
        );
        continue;
      }
      const actual = sha256(content);
      if (actual !== recorded) {
        problems.push(
          `integration ${name}: overlay ${rel} 已过期 —— 上游 ${upstreamRel} 变了` +
            `（记录 ${recorded.slice(0, 12)}…，实得 ${actual.slice(0, 12)}…）。` +
            `请把我们的 delta rebase 到 integrations/${name}/files/${rel}，` +
            `并把 upstreamSha256 更新为 ${actual}`,
        );
        continue;
      }
      files++;
    }
  }
  if (problems.length) {
    const err = new Error("集成层漂移校验未通过：\n" + problems.map((p) => "  - " + p).join("\n"));
    err.problems = problems;
    throw err;
  }
  return { packages: (integrations || []).length, files, empty };
}

// ---------- 磁盘 / 镜像 ----------

/** 读 integrations 下各短名目录的 integration.json，附带 dir 与 root。 */
export function loadIntegrations(rootDir = REPO_ROOT) {
  const dir = join(rootDir, "integrations");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const manifest = join(dir, ent.name, "integration.json");
    if (!existsSync(manifest)) continue;
    const it = JSON.parse(readFileSync(manifest, "utf8"));
    out.push({ ...it, dir: ent.name, root: join(dir, ent.name) });
  }
  return out;
}

/** 镜像是否含该 tag（返回 commit 或 null）。 */
export function mirrorHasTag(tag, mirrorDir = MIRROR) {
  const r = spawnSync("git", ["-C", mirrorDir, "rev-parse", "--verify", "--quiet", tag + "^{commit}"], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  return String(r.stdout || "").trim() || null;
}

/** 从镜像的某个 tag 读文件（仓库相对路径 → Buffer；不存在返回 null）。 */
export function readUpstreamFromMirror(repoRelPath, tag, mirrorDir = MIRROR) {
  const r = spawnSync("git", ["-C", mirrorDir, "show", `${tag}:${repoRelPath}`], {
    maxBuffer: 128 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  return r.stdout;
}

/** 把 overlay 落进 _tmp/integrations/<短名>/（供后续编译步骤消费）。 */
export function stageIntegrations(integrations, rootDir = REPO_ROOT) {
  const staged = [];
  for (const it of integrations) {
    for (const f of Array.isArray(it.files) ? it.files : []) {
      const src = join(it.root, "files", f.path);
      if (!existsSync(src)) throw new Error(`integration ${it.dir}: overlay 文件缺失 ${src}`);
      const dst = join(rootDir, "_tmp", "integrations", it.dir, f.path);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst);
      staged.push(join("_tmp", "integrations", it.dir, f.path));
    }
  }
  return staged;
}

// ---------- CLI ----------

function main() {
  const cmd = process.argv[2] || "verify";
  const pkgJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const version = dshVersionOf(pkgJson);
  if (!version) {
    console.error("[integrations] package.json 未声明 dependencies['@deepseek-ai/dsh']");
    process.exit(1);
  }
  const tag = tagForVersion(version);

  if (cmd === "hash") {
    const rel = process.argv[3];
    if (!rel) {
      console.error("[integrations] 用法：node scripts/integrations.mjs hash <仓库相对路径>");
      process.exit(1);
    }
    const buf = readUpstreamFromMirror(rel, tag);
    if (buf === null) {
      console.error(`[integrations] 镜像 ${tag} 下不存在：${rel}`);
      process.exit(1);
    }
    console.log(sha256(buf));
    return;
  }

  const integrations = loadIntegrations();
  if (cmd === "list") {
    for (const it of integrations) {
      console.log(`${it.dir}  → ${it.package}  overlay=${(it.files || []).length}  hana=${it.hana}`);
    }
    return;
  }

  // verify / stage 都要先过闸
  const commit = mirrorHasTag(tag);
  if (!commit) {
    console.error(
      `[integrations] 源码镜像不一致：vendor/deepseek-harness 里没有 tag ${tag}。\n` +
        `  pin 的 DSH 版本是 ${version}；请先把镜像跟到该版本：\n` +
        `  git -C vendor/deepseek-harness fetch --no-tags origin tag ${tag}`,
    );
    process.exit(1);
  }
  console.log(`[integrations] 镜像 ${tag} = ${commit.slice(0, 9)}（pin ${version}）`);

  let result;
  try {
    result = verifyIntegrations(integrations, (rel) => readUpstreamFromMirror(rel, tag));
  } catch (e) {
    console.error("[integrations] " + ((e && e.message) || e));
    process.exit(1);
  }
  console.log(`[integrations] 漂移闸通过：${result.packages} 个集成、${result.files} 个 overlay 文件`);
  if (result.empty.length) {
    console.log(`[integrations] 注意：以下集成尚无 overlay（批次未落地）：${result.empty.join(", ")}`);
  }

  if (cmd === "stage") {
    const staged = stageIntegrations(integrations);
    console.log(`[integrations] 已落盘 ${staged.length} 个文件到 _tmp/integrations/`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
