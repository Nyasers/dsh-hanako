// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/pack.mjs — dsh-hanako 轻量化打包（适配单 bundle 收敛架构；构建脚本不随源码编译）
// 交付物 = 代码 bundle（dist/）+ 配置 + 技能 + cordis 插件 + lockfile，零依赖（Agent pnpm i 装，
// pnpm 运行时引导：tools/lib/pnpm.js ensurePnpm 下载单文件 pnpm.mjs 到数据目录 pnpm-dist/，
// 供 tools/lib/install.js 部署 @deepseek-ai/dsh）。
// 流程：build（rspack 单 bundle）→ 复制交付清单 → zip → SHA256。
// 用法：node scripts/pack.mjs [version]（缺省用 package.json 的 version）
// 产出：releases/dsh-hanako-v<version>.zip + .sha256；铺平目录 _tmp/pkg/（zip 中间原料，可清空）
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ZipArchive } from "archiver";

import fs from "fs-extra";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 版本单一事实源：package.json（唯一来源，不支持命令行传版本——显式传版本容易与
// manifest 不同步（历史教训）；版本同步用 scripts/version.mjs 自动化）
const version = fs.readJsonSync(join(ROOT, "package.json")).version;
if (!version) throw new Error("package.json version 缺失");

// 防回归：版本一致性强制校验（历史曾手改只 bump package.json，manifest.json version 停在
// 旧值，发布包内版本与 tag 不一致）。打包版本必须同时等于 manifest.json 的 version。
const manifestVersion = fs.readJsonSync(join(ROOT, "manifest.json")).version;
if (version !== manifestVersion)
  throw new Error(
    `版本不一致：package.json ${version} ≠ manifest.json ${manifestVersion}（manifest 未同步，跑 scripts/version.mjs 或手动同步后再打包）`,
  );

// 1. 构建 bundle
console.log("[pack] build...");
execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, RSPACK_ENV: process.env.RSPACK_ENV || "" },
});

// 2. 静态项复制进 dist —— dist 即完整交付目录（bundle + manifest + skills + cordis 插件），
//    包根结构 = 标准插件形态（根 index.js + routes/ 壳，无 dist 这层目录）。
//    app/（card.js/css 已 asset/source 内联进 bundle）与 routes/（壳由 build 生成）不再复制。
const staticItems = [
  "NOTICE",
  "package.json",
  "manifest.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "skills",
];
const distDir = join(ROOT, "dist");
for (const item of staticItems) {
  const src = join(ROOT, item);
  if (!fs.pathExistsSync(src)) throw new Error(`静态项不存在：${item}`);
  // dereference: true —— 历史为内置 pnpm 的符号链接复制（node_modules/pnpm →
  // .pnpm/pnpm@…/node_modules/pnpm，zip 内置 pnpm）；现版本起 pnpm 改运行时引导
  // （tools/lib/pnpm.js ensurePnpm 下载单文件到数据目录 pnpm-dist/），不再打包
  // node_modules/pnpm——其余静态项（NOTICE/package.json/manifest/pnpm-workspace/
  // pnpm-lock/skills）均为真实实体，dereference 恒为 no-op，保留无害。
  fs.copySync(src, join(distDir, item), {
    dereference: true,
    filter: (srcPath) => {
      if (srcPath.includes("node_modules/.bin")) return false;
      if (/__tests__|\.test\.|\.spec\./.test(srcPath)) return false;
      return true;
    },
  });
}

// 2.5 静态资产压缩（terser JS 纯语法级 + clean-css CSS 压缩，覆盖写回 dist 副本）
//     cordis 插件（dist/cordis/node_modules/@dsh-hanako/*/index.js，由 build 从
//     src-cordis 组装）被 dsh 运行时 import() 加载、client.js 被浏览器
//     ModuleLoader 按 window.__ModuleLoader__.load 注册；均只做语法级压缩。
function resolveTool(pkgName) {
  const envDir = process.env.RSPACK_ENV;
  if (envDir) {
    const envRequire = createRequire(join(envDir, "node_modules", "noop.js"));
    try {
      return envRequire(pkgName);
    } catch {
      console.log(`[pack] RSPACK_ENV 下未找到 ${pkgName}，回退本地 node_modules`);
    }
  }
  return require(pkgName);
}

function collectStaticFiles(dir, recursive = true, ext = ".js") {
  const files = [];
  if (!fs.pathExistsSync(dir)) return files;
  for (const name of fs.readdirSync(dir)) {
    const p = join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (recursive) files.push(...collectStaticFiles(p, true, ext));
    } else if (name.endsWith(ext)) {
      files.push(p);
    }
  }
  return files;
}

// module 启发式（JS 专用）：顶层 import/export 语句 → module: true（ESM）
function isEsm(code) {
  const noComments = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  return /\b(?:import|export)\s/.test(noComments);
}

{
  // --- JS 压缩（terser 纯语法级）---
  const terser = resolveTool("terser");
  const minify = terser.minify ?? terser.default?.minify;
  if (typeof minify !== "function") throw new Error("terser 加载失败：未找到 minify");
  const staticJs = [...collectStaticFiles(join(distDir, "cordis"))];
  console.log(`[pack] minify static js (${staticJs.length} files)...`);
  for (const file of staticJs) {
    const code = fs.readFileSync(file, "utf8");
    const before = Buffer.byteLength(code, "utf8");
    let result;
    try {
      result = await minify(code, {
        compress: true,
        mangle: true,
        module: isEsm(code),
        format: { comments: false },
      });
    } catch (err) { throw new Error(`terser 压缩失败（${file}）：${err.message}`); }
    if (!result?.code) throw new Error(`terser 压缩失败（${file}）：无输出`);
    fs.writeFileSync(file, result.code, "utf8");
    console.log(`[pack]   ${file}: ${before} -> ${Buffer.byteLength(result.code, "utf8")} bytes`);
  }
}

// 3. dist → 铺平目录（zip 中间原料，放 _tmp 可随时清空）
const pkgDir = join(ROOT, "_tmp", "pkg", `dsh-hanako-v${version}`);
fs.removeSync(pkgDir);
fs.copySync(distDir, pkgDir);

// 4. zip + SHA256（发布产物归档 releases/，与项目群惯例一致）
//    archiver 纯 Node 跨平台 zip（对齐 hana-remote-dev）：不用 tar -a -cf——
//    GNU tar（Linux）不认 .zip 后缀会静默产出 tar 伪 zip（CI ubuntu 踩坑 2026-08-14）
const relDir = join(ROOT, "releases");
fs.ensureDirSync(relDir);
const zipPath = join(relDir, `dsh-hanako-v${version}.zip`);
fs.removeSync(zipPath);
const tmpZip = join(relDir, `.dsh-hanako-v${version}.zip.tmp`); // 先写临时文件，rename 原子落位
const output = fs.createWriteStream(tmpZip);
const archive = new ZipArchive({ zlib: { level: 9 } });
const done = new Promise((resolve, reject) => {
  output.on("close", resolve);
  output.on("error", reject);
  archive.on("error", reject);
});
archive.pipe(output);
archive.directory(pkgDir, `dsh-hanako-v${version}`);
await archive.finalize();
await done;
fs.moveSync(tmpZip, zipPath, { overwrite: true });
const buf = fs.readFileSync(zipPath);
const sha = createHash("sha256").update(buf).digest("hex").toUpperCase();
const sizeMB = (buf.length / 1048576).toFixed(1);
console.log(`\n[pack] ${zipPath}`);
console.log(`[pack] zip ${sizeMB} MB · SHA256 ${sha}`);
fs.writeFileSync(`${zipPath}.sha256`, sha, "utf8");