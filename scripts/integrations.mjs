// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/integrations.mjs — 集成层的漂移闸（见 src-integrations/README.md 与 specs/current/hana-integrations）
//
// 用法：
//   node scripts/integrations.mjs verify          # 镜像版本一致 + 每个 overlay 记录的上游哈希仍成立
//   node scripts/integrations.mjs stage           # verify 后把 overlay 落进 _tmp/integrations/<短名>/
//   node scripts/integrations.mjs hash <仓库相对路径>   # 打印上游该文件的 sha256（写清单时用）
//   node scripts/integrations.mjs list
//
// 闸的意义：overlay 是「上游某版文件 + 我们的 delta」的整文件拷贝，清单记下当时上游文件的 sha256。
// 构建时用**当前镜像**重算比对；不一致 = 上游动过 → 构建失败并指名要 rebase 的文件。
// 于是"拷贝即冻结"在流程上不可能发生。
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, cpSync, rmSync } from "node:fs";
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
            `请把我们的 delta rebase 到 src-integrations/${name}/files/${rel}，` +
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
  const dir = join(rootDir, "src-integrations");
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

/**
 * 递归收集目录下源码文件里的**非相对导入 specifier**（含 type-only：列出无害）。
 * 用途有二：① 原版产物零 require 时充当 externals；② 收紧产物侧抽取的假阳性。
 * 根因：压缩后工厂参数被改名成单字符（如 e），`e("data-plugin")` 这种同名调用的字符串
 * 字面会被 extractRequires 误认成 require；而真正的外部依赖一定在源码里是 import。
 * @param {string} rootDir 源码根目录
 * @returns {Set<string>} specifier 集合
 */
function sourceSpecifiers(rootDir) {
  const seen = new Set();
  const declRe = /(?:from|import)\s*\(?\s*["']([^"'.][^"']*)["']/g;
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.name)) continue;
      let text;
      try { text = readFileSync(p, "utf8") } catch { continue }
      let m;
      while ((m = declRe.exec(text)) !== null) seen.add(m[1]);
    }
  };
  walk(rootDir);
  return seen;
}

// ---------- 编译进包（摊源 → 覆盖 overlay → 编译 → 装包 + 版本戳） ----------

/**
 * 从 client bundle 里抽出它使用的外部依赖。
 * 两种姿势都要认：
 *   · 未压缩/官方产物：字面 `require("spec")`；
 *   · 我们自己压缩过的产物：banner 里的 factory 参数被改名（`factory:e=>{… e("spec")`）。
 * externals 的可信来源是**原版** bundle；本函数同样用于事后校验我方产物有无“悬空外部引用”。
 * @param {string} bundleText client bundle 文本
 * @returns {string[]} 去重后的 specifier 列表（保序）
 */
export function extractRequires(bundleText) {
  const text = String(bundleText ?? "");
  const out = [];
  const push = (s) => { if (s && !out.includes(s)) out.push(s); };
  const banner = /factory\s*:\s*([A-Za-z_$][\w$]*)\s*=>/.exec(text);
  if (banner) {
    const re = new RegExp(banner[1].replace(/\$/g, "\\$") + "\\(\\s*[\"'`]([^\"'`]+)[\"'`]\\s*\\)", "g");
    for (const m of text.matchAll(re)) push(m[1]);
  }
  const literal = /require\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of text.matchAll(literal)) push(m[1]);
  return out;
}

/** 镜像里列出某 tag 下某目录的文件（仓库相对路径）。 */
export function listMirrorFiles(tag, dir, mirrorDir = MIRROR) {
  const r = spawnSync("git", ["-C", mirrorDir, "ls-tree", "-r", "--name-only", tag, "--", dir], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`ls-tree 失败：${tag}:${dir}`);
  return String(r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
}

/** 包名 → 本机依赖树里的原版包目录（模板与 externals 来源）。 */
export function templatePackageDir(pkgName, repoRoot = REPO_ROOT) {
  return join(repoRoot, "node_modules", ".pnpm", "node_modules", pkgName);
}

/**
 * 把「待内联的非相对 specifier」解析成绝对文件的 alias 表。
 *
 * 为何需要（本质是幽灵依赖）：集成的 stage 树（_tmp/integrations-src/<短名>）只有 src/ 与 lib/，
 * 既没有自己的 package.json 也没有 node_modules——它里面每一条非相对导入都只能向上走到**本仓**
 * 的依赖树去解，也就是在靠 hoisting 碰运气。上游没有这个问题：它的这些包是 monorepo 的
 * workspace 兄弟，打包器直接从工作区解。
 * 所以这里不做“碰巧能解到”，只做“显式声明 + 显式解析”：库由配套的 devDependencies 声明
 * （devDep 会被内联，不进运行时），路径用本脚本已有的同一条约定 .pnpm/node_modules/<name>
 * （templatePackageDir 取原版包走的就是它）。
 * 另一层现实：pnpm 在 Windows 长路径下会把实体放进带哈希的 .pnpm 目录，而根级链接指向一个
 * 不存在的名字（dangling）——本地 <repo>/node_modules/<pkg> 解不开，CI（Linux）上反而正常。
 * 赌链接形态就是赌构建机，故不赌。
 * 只处理 externals 之外的 specifier：React 这类必须保持外部，内联成副本反而错。
 * @param {Iterable<string>} specifiers 待内联的 specifier
 * @param {string} repoRoot 仓库根
 * @returns {Record<string,string>} specifier → 绝对路径
 */
export function resolveInlineAliases(specifiers, repoRoot = REPO_ROOT) {
  const req = createRequire(import.meta.url);
  const alias = {};
  for (const spec of specifiers) {
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    const hoisted = templatePackageDir(pkg, repoRoot);
    if (!existsSync(hoisted)) continue;
    try {
      alias[spec] = req.resolve(spec, { paths: [hoisted] });
    } catch {
      // 解析不到就交给打包器自己试（纯类型导入本就无需解析）
    }
  }
  return alias;
}

/**
 * 编译一个集成：把上游 src 摊到 _tmp/integrations-src/<短名>/，覆盖 overlay，
 * 用我们的 client preset 编译出 lib/client.js，再以原版包为模板组装成
 * _tmp/integrations-built/<短名>/（版本戳 +hana.N）。
 */
export async function buildIntegrations(integrations, { tag, mirrorDir = MIRROR, repoRoot = REPO_ROOT, log = () => {} } = {}) {
  const { buildClientBundle } = await import("../src-cordis/build/client-config.mjs");
  const built = [];
  for (const it of integrations) {
    const short = it.dir;
    const pkg = String(it.package || "");
    const upstreamDir = String(it.upstreamDir || "");
    const template = templatePackageDir(pkg, repoRoot);
    if (!existsSync(template)) throw new Error(`integration ${short}: 本机依赖树找不到原版包 ${template}`);

    // 1) 摊源（上游 src 全量，保留相对路径——entry 就是上游的 src/client/index.ts）
    const stage = join(repoRoot, "_tmp", "integrations-src", short);
    rmSync(stage, { recursive: true, force: true });
    const files = listMirrorFiles(tag, `${upstreamDir}/src`, mirrorDir);
    if (files.length === 0) throw new Error(`integration ${short}: 镜像 ${tag} 下没有 ${upstreamDir}/src`);
    for (const rel of files) {
      const buf = readUpstreamFromMirror(rel, tag, mirrorDir);
      if (buf === null) throw new Error(`integration ${short}: 读不到 ${rel}`);
      const dst = join(stage, rel.slice(upstreamDir.length + 1));
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, buf);
    }

    // 2) 覆盖我们的 overlay（新文件同样落盘）
    for (const f of Array.isArray(it.files) ? it.files : []) {
      const src = join(it.root, "files", f.path);
      if (!existsSync(src)) throw new Error(`integration ${short}: overlay 文件缺失 ${src}`);
      const dst = join(stage, f.path);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst);
    }

    // 3) externals = 原版 bundle 自己的 require 集合。
    //    例外：client 半只有类型导入的包（如 dsh-client-hmr）——原版产物里**零 require**。
    //    这不能当「抽取失败」（fail-closed 会误杀整个集成）：改为从缓存的源码取非相对
    //    specifier 作 externals——真正的外部依赖仍保持外部化（不被内联成重复副本），
    //    类型导入列出来无害（会被构建抹掉）。
    const pristineClient = join(template, "lib", "client.js");
    if (!existsSync(pristineClient)) throw new Error(`integration ${short}: 原版缺 lib/client.js（${pristineClient}）`);
    let externals = extractRequires(readFileSync(pristineClient, "utf8"));
    if (externals.length === 0) {
      externals = [...sourceSpecifiers(join(stage, "src"))];
      console.log(`[integrations] ${short}: 原版 bundle 零 require（client 半仅类型导入），externals 取自有源码（${externals.join(", ") || "空"}）`);
    }
    // 源码里的非相对导入（后面判悬空与算别名都用它，只算一次）
    const imported = sourceSpecifiers(join(stage, "src"));

    // 4) 编译 client 半
    const outDir = join(stage, "lib");
    const entryRel = files.includes(`${upstreamDir}/src/client/index.ts`) ? "src/client/index.ts" : "src/client/index.tsx";
    // 待内联的库得先能解到（见 resolveInlineAliases 注释：pnpm 长路径下根级链接是悬空的）。
    const alias = resolveInlineAliases([...imported].filter((s) => !externals.includes(s)), repoRoot);
    if (Object.keys(alias).length) {
      console.log(`[integrations] ${short}: 内联别名 ${Object.keys(alias).join(", ")}`);
    }
    await buildClientBundle({ id: pkg, pkgDir: stage, outDir, externals, entry: entryRel, alias });

    // 4b) 悬空外部引用闸：产物里出现 externals 之外的引用 = loader 模块表答不上 → 运行时必炸。
    // 典型成因：上游 bundle 内联的第三方库（如 clsx）在本仓库 node_modules 里缺失，
    // 解析不到就被当成 external。处理：把该库加进 devDependencies（devDep 会被内联，不进运行时）。
    const produced = extractRequires(readFileSync(join(outDir, "client.js"), "utf8"));
    // 产物侧抽取在**压缩后**会出假阳性（minifier 把工厂参数改成单字符，`e("data-plugin")`
    // 这类同名调用的字符串字面会被误认成 require）。判据收紧为「确实是源码里的非相对导入」：
    // 只有这类 specifier 悬空才是真问题（clsx 就属于此类：源码 import 了它、产物 require 了它、
    // 而 externals 里没有它）。
    const dangling = produced.filter((s) => !externals.includes(s) && imported.has(s));
    const noise = produced.filter((s) => !externals.includes(s) && !imported.has(s));
    if (noise.length) console.log(`[integrations] ${short}: 产物抽取忽略 ${noise.length} 个非导入字面（假阳性）：${noise.join(", ")}`);
    if (dangling.length) {
      throw new Error(
        `integration ${short}: 产物含悬空外部引用 ${dangling.join(", ")} —— ` +
          `loader 模块表答不上这些 specifier（上游 bundle 里它们是内联的）。` +
          `请把对应库装进 devDependencies（devDep 会被内联）后重跑，或确认它确实应是外部。`,
      );
    }

    // 5) 以原版包为模板组装（lib/index.js、lib/types、package.json 等原样；client.js 换我们的）
    const out = join(repoRoot, "_tmp", "integrations-built", short);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(join(template, "lib"), join(out, "lib"), { recursive: true });
    cpSync(join(stage, "lib", "client.js"), join(out, "lib", "client.js"));
    const manifest = JSON.parse(readFileSync(join(template, "package.json"), "utf8"));
    const hana = Number.isFinite(it.hana) ? it.hana : 1;
    manifest.version = `${String(manifest.version).split("+")[0]}+hana.${hana}`;
    writeFileSync(join(out, "package.json"), JSON.stringify(manifest, null, 2));

    const size = readFileSync(join(out, "lib", "client.js")).length;
    log(`[integrations] ${short}: ${pkg}@${manifest.version} 编译完成（client.js ${size}B，externals ${externals.length} 个）`);
    built.push({ short, pkg, version: manifest.version, out, externals, bytes: size });
  }
  return built;
}

// ---------- CLI ----------

async function main() {
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
    return;
  }

  if (cmd === "build") {
    try {
      const built = await buildIntegrations(integrations, { tag });
      for (const b of built) console.log(`[integrations] 产物：${b.out}`);
    } catch (e) {
      console.error("[integrations] 编译失败：" + ((e && e.message) || e));
      process.exit(1);
    }
    return;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    console.error("[integrations] " + ((e && e.message) || e));
    process.exit(1);
  });
}
