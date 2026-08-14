// scripts/pack.mjs — dsh-hanako v0.6.0 轻量化打包
// 交付物 = 代码 bundle（dist/）+ 配置 + 技能 + 卡片资源 + lockfile，零依赖（Agent npm ci 装）。
// 流程：build（rspack）→ 复制交付清单 → zip → SHA256。
// 用法：node scripts/pack.mjs [version]   （如 node scripts/pack.mjs 0.6.0；缺省用 package.json 的 version）
// 产出：releases/dsh-hanako-v<version>.zip + .sha256（发布产物）；铺平目录 _tmp/pkg/（zip 中间原料，可清空）
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

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
  "config",
  "README.md",
];
const distDir = join(ROOT, "dist");
for (const item of staticItems) {
  const src = join(ROOT, item);
  if (!existsSync(src)) throw new Error(`静态项不存在：${item}`);
  cpSync(src, join(distDir, item), { recursive: true });
}

// 3. dist → 铺平目录（zip 中间原料，放 _tmp 可随时清空）
const pkgDir = join(ROOT, "_tmp", "pkg", `dsh-hanako-v${version}`);
rmSync(pkgDir, { recursive: true, force: true });
cpSync(distDir, pkgDir, { recursive: true });

// 4. zip + SHA256（发布产物归档 releases/，与项目群惯例一致）
const relDir = join(ROOT, "releases");
mkdirSync(relDir, { recursive: true });
const zipPath = join(relDir, `dsh-hanako-v${version}.zip`);
rmSync(zipPath, { force: true });
execFileSync("tar", ["-a", "-cf", zipPath, `dsh-hanako-v${version}`], {
  cwd: join(ROOT, "_tmp", "pkg"),
  stdio: "inherit",
});
const buf = readFileSync(zipPath);
const sha = createHash("sha256").update(buf).digest("hex").toUpperCase();
const sizeMB = (buf.length / 1048576).toFixed(1);
console.log(`\n[pack] ${zipPath}`);
console.log(`[pack] zip ${sizeMB} MB · SHA256 ${sha}`);
writeFileSync(`${zipPath}.sha256`, sha, "utf8");
