// scripts/pack.mjs — dsh-hanako v0.6.0 轻量化打包
// 交付物 = 代码 bundle（dist/）+ 配置 + 技能 + 卡片资源 + lockfile，零依赖（Agent npm ci 装）。
// 流程：build（rspack）→ 复制交付清单 → zip → SHA256。
// 用法：node scripts/pack.mjs [version]   （如 node scripts/pack.mjs 0.6.0；缺省用 package.json 的 version）
// 产出：releases/dsh-hanako-v<version>.zip + .sha256（发布产物）；铺平目录 _tmp/pkg/（zip 中间原料，可清空）
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ZipArchive } from "archiver";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 版本单一事实源：命令行参数优先（npm run pack -- <version>），缺省读 package.json version
const version = process.argv[2] || JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
if (!version) throw new Error("用法：node scripts/pack.mjs [version]（缺省取 package.json 的 version）");

// 1. 构建 bundle
console.log("[pack] build...");
execFileSync(process.execPath, [join(ROOT, "scripts", "build.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, RSPACK_ENV: process.env.RSPACK_ENV || "" },
});

// 2. 静态项复制进 dist —— dist 即完整交付目录（bundle + manifest + skills + 资源），
//    包根结构 = 标准插件形态（根 index.js + tools/，无 dist 这层目录）
const staticItems = [
  "manifest.json",
  "package.json",
  "package-lock.json",
  "skills",
  "app",
  "routes",
  "assets",
  "README.md",
];
const distDir = join(ROOT, "dist");
for (const item of staticItems) {
  const src = join(ROOT, item);
  if (!existsSync(src)) throw new Error(`静态项不存在：${item}`);
  cpSync(src, join(distDir, item), { recursive: true });
}

// 2.5 静态资产压缩（terser JS 纯语法级 + clean-css CSS 压缩，覆盖写回 dist 副本）
//     JS 不走 rspack 管线（会被模块系统转换+依赖内联破坏加载语义）：cordis 插件
//     （assets/dsh-cordis/*/index.js）被 dsh 运行时 import() 加载、client.js 被浏览器
//     ModuleLoader 按 window.__ModuleLoader__.load 注册、app/card.js 在 iframe 内执行；
//     CSS（app/card.css）同样只做语法级压缩。两者均为构建期工具，解析与 build.mjs 的
//     resolveRspackEntry 同模式：优先 RSPACK_ENV 构建环境 node_modules，否则本地
//     node_modules（CI npm ci --omit=peer 装 dev 树，terser/clean-css 必装）。
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

// 收集待压缩的静态资产：assets/（递归）、routes/（顶层）、app/（顶层），按扩展名过滤
function collectStaticFiles(dir, recursive = true, ext = ".js") {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (recursive) files.push(...collectStaticFiles(p, true, ext));
    } else if (name.endsWith(ext)) {
      files.push(p);
    }
  }
  return files;
}

// module 启发式（JS 专用）：内容含顶层 import/export 语句 → module: true（ESM），
// 否则浏览器脚本（先粗略去掉注释，避免注释里 "import/export" 字样误判；简单判断即可）
function isEsm(code) {
  const noComments = code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  return /\b(?:import|export)\s/.test(noComments);
}

{
  // --- JS 压缩（terser 纯语法级：保留模块格式/import 语句，只做语法压缩/去注释/改名）---
  const terser = resolveTool("terser");
  const minify = terser.minify ?? terser.default?.minify;
  if (typeof minify !== "function") throw new Error("terser 加载失败：未找到 minify（构建环境必装 terser）");
  const staticJs = [
    ...collectStaticFiles(join(distDir, "assets")),
    ...collectStaticFiles(join(distDir, "routes"), false),
    ...collectStaticFiles(join(distDir, "app"), false),
  ];
  console.log(`[pack] minify static js (${staticJs.length} files)...`);
  for (const file of staticJs) {
    const code = readFileSync(file, "utf8");
    const before = Buffer.byteLength(code, "utf8");
    let result;
    try {
      result = await minify(code, {
        compress: true,
        mangle: true,
        module: isEsm(code),
        format: { comments: false },
      });
    } catch (err) {
      throw new Error(`terser 压缩失败（${file}）：${err.message}`);
    }
    if (!result?.code) throw new Error(`terser 压缩失败（${file}）：无输出`);
    const out = result.code;
    writeFileSync(file, out, "utf8");
    const after = Buffer.byteLength(out, "utf8");
    const rel = file.startsWith(distDir + "\\") ? file.slice(distDir.length + 1) : file;
    console.log(`[pack]   ${rel}: ${before} -> ${after} bytes (${((1 - after / before) * 100).toFixed(1)}% 缩减)`);
  }

  // --- CSS 压缩（clean-css level 2：合并/去空白/优化颜色，普通样式安全）---
  const cleanCssMod = resolveTool("clean-css");
  const CleanCSS = cleanCssMod.default ?? cleanCssMod; // CJS 包：interop 后取构造函数
  if (typeof CleanCSS !== "function") throw new Error("clean-css 加载失败：未找到构造函数（构建环境必装 clean-css）");
  const staticCss = [
    ...collectStaticFiles(join(distDir, "assets"), true, ".css"),
    ...collectStaticFiles(join(distDir, "routes"), false, ".css"),
    ...collectStaticFiles(join(distDir, "app"), false, ".css"),
  ];
  if (staticCss.length) {
    console.log(`[pack] minify static css (${staticCss.length} files)...`);
    for (const file of staticCss) {
      const css = readFileSync(file, "utf8");
      const before = Buffer.byteLength(css, "utf8");
      let result;
      try {
        result = new CleanCSS({ level: 2 }).minify(css);
      } catch (err) {
        throw new Error(`clean-css 压缩失败（${file}）：${err.message}`);
      }
      if (result.errors?.length) throw new Error(`clean-css 压缩失败（${file}）：${result.errors.join("; ")}`);
      if (typeof result.styles !== "string") throw new Error(`clean-css 压缩失败（${file}）：无输出`);
      const out = result.styles;
      writeFileSync(file, out, "utf8");
      const after = Buffer.byteLength(out, "utf8");
      const rel = file.startsWith(distDir + "\\") ? file.slice(distDir.length + 1) : file;
      console.log(`[pack]   ${rel}: ${before} -> ${after} bytes (${((1 - after / before) * 100).toFixed(1)}% 缩减)`);
    }
  }
}

// 3. dist → 铺平目录（zip 中间原料，放 _tmp 可随时清空）
const pkgDir = join(ROOT, "_tmp", "pkg", `dsh-hanako-v${version}`);
rmSync(pkgDir, { recursive: true, force: true });
cpSync(distDir, pkgDir, { recursive: true });

// 4. zip + SHA256（发布产物归档 releases/，与项目群惯例一致）
//    archiver 纯 Node 跨平台 zip（对齐 hana-remote-dev）：不用 tar -a -cf——
//    GNU tar（Linux）不认 .zip 后缀会静默产出 tar 伪 zip（CI ubuntu 踩坑 2026-08-14，
//    安装端报 end of central directory record signature not found）
const relDir = join(ROOT, "releases");
mkdirSync(relDir, { recursive: true });
const zipPath = join(relDir, `dsh-hanako-v${version}.zip`);
rmSync(zipPath, { force: true });
const tmpZip = join(relDir, `.dsh-hanako-v${version}.zip.tmp`); // 先写临时文件，rename 原子落位（中断不留半成品）
const output = createWriteStream(tmpZip);
const archive = new ZipArchive({ zlib: { level: 9 } });
const done = new Promise((resolve, reject) => {
  output.on("close", resolve);
  output.on("error", reject);
  archive.on("error", reject);
});
archive.pipe(output);
// zip 根 = dsh-hanako-v<version>/（保持既有形态：顶层目录带版本号）
archive.directory(pkgDir, `dsh-hanako-v${version}`);
await archive.finalize();
await done;
renameSync(tmpZip, zipPath);
const buf = readFileSync(zipPath);
const sha = createHash("sha256").update(buf).digest("hex").toUpperCase();
const sizeMB = (buf.length / 1048576).toFixed(1);
console.log(`\n[pack] ${zipPath}`);
console.log(`[pack] zip ${sizeMB} MB · SHA256 ${sha}`);
writeFileSync(`${zipPath}.sha256`, sha, "utf8");
