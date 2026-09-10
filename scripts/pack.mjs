// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/pack.mjs — dsh-hanako 自包含打包（适配单 bundle 收敛架构；构建脚本不随源码编译）
// 交付物 = 代码 bundle（dist/）+ cordis 插件 + ui/ 静态树 + **物化后的生产依赖树**
// （含 win32/darwin/linux × x64/arm64 预编译资产），安装即用、无需 npm install。
// 依赖物化形态对齐样例 hana-dsh：hoisted 布局（顶层真实目录、无软链接——软链进 zip 跨机
// 解压即断）。物化在 _tmp/pkg-root/ 隔离进行，不触碰仓库 node_modules。
// 流程：复制交付清单（prepack 钩子已先行 build）→ 物化生产依赖 → 断言多平台资产 → zip → SHA256。
// 用法：pnpm run pack（prepack 自动前置 build；单独 node scripts/pack.mjs 要求 dist/ 已构建）
// 产出：releases/dsh-hanako-v<version>[-<target>].zip + .sha256（多目标见 --targets）；
//   临时目录 _tmp/pkg、_tmp/pkg-root 起手清残留、逐目标用完即清、收尾无論成败都清。
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { ZipArchive } from "archiver";

import fs from "fs-extra";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 版本单一事实源：package.json（唯一来源，不支持命令行传版本——显式传版本容易与
// manifest 不同步（历史教训）；版本同步走 pnpm version 发版流程，scripts/version-hook.mjs 收口）
const version = fs.readJsonSync(join(ROOT, "package.json")).version;
if (!version) throw new Error("package.json version 缺失");

// 防回归：版本一致性强制校验（历史曾手改只 bump package.json，manifest.json version 停在
// 旧值，发布包内版本与 tag 不一致）。打包版本必须同时等于 manifest.json 的 version。
const manifestVersion = fs.readJsonSync(join(ROOT, "src", "manifest.json")).version;
if (version !== manifestVersion)
  throw new Error(
    `版本不一致：package.json ${version} ≠ manifest.json ${manifestVersion}（manifest 未同步，跑 node scripts/syncver.mjs 同步后再打包）`,
  );

// 1. 静态项复制进 dist —— dist 即完整交付目录（bundle + manifest + skills + cordis 插件），
//    包根结构 = 标准插件形态（根 index.js + routes/ 壳，无 dist 这层目录）。
//    app/（card.js/css 已 asset/source 内联进 bundle）与 routes/（壳由 build 生成）不再复制。
const staticItems = [
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  // manifest.json 与 skills 已随 src 域（src/manifest.json、src/skills/，build:src 产出
  // dist 副本），不再经根级静态复制
  // 注（自包含打包后）：pnpm-workspace.yaml / pnpm-lock.yaml 不再随包——安装侧不再执行任何
  // pnpm install（依赖已物化进包），两份文件的唯一消费方（旧 ensure 链）已退役
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

// 1.5) cordis 包 version 一致性校验（防回归，与 manifest 校验对称）：cordis 包（roster
//   bundle dshana + 10 子插件）version 与主 package.json 同批由 syncver/version-hook（pnpm
//   version 发版流程）同步（单一事实源 = 主 package.json，cordis 包跟随等值，无独立版本线；
//   build metadata +dsh-<dsh 依赖> 由 version-hook 在发版时统一拼回），
//   pack 时读 dist 产物校验一致——手改/漏同步即出包版本漂移。
function assertCordisDistVersions(outDir) {
  const cordisRoot = join(outDir, "cordis");
  // cordis 未组装 = 构建未跑/被清：fail-closed（校验放行空产物会让缺 bundle 的包过包）
  if (!fs.pathExistsSync(cordisRoot)) {
    throw new Error("cordis 产物缺失（dist/cordis 不存在）：先跑 pnpm run build 再打包");
  }
  // 完整性：必需 10 包（roster bundle dshana + 9 子插件）全部存在且
  // package.json 版本一致——缺失/部分产物（含 count=0）一律拒包，防 build 失败后残留部分
  // dist 被误打包
  const required = [
    "dshana",
    "app", "bridge", "bus", "clipboard", "logger", "provider", "settings", "theme", "view",
  ];
  let count = 0;
  for (const name of required) {
    const pj = join(cordisRoot, name, "package.json");
    if (!fs.pathExistsSync(pj)) {
      throw new Error(
        `cordis 产物不完整：缺少 ${name}/package.json（dist/cordis 下）——先跑 pnpm run build 再打包`,
      );
    }
    const j = fs.readJsonSync(pj);
    if (j.version !== version) {
      throw new Error(
        `版本不一致：cordis 包 ${join("cordis", name, "package.json")} version ${j.version} ≠ package.json ${version}（跑 node scripts/syncver.mjs 同步后再打包）`,
      );
    }
    count += 1;
  }
  console.log(`[pack] cordis 包版本一致（${count} 个 = ${version}）`);
}
assertCordisDistVersions(distDir);

// 1.6) App ui/ 静态树断言（v2 cards route 资源面；迁移指南 §10 相对资源契约）：缺失 = 卡片
//   404 + 宿主 manifest 校验失败，fail-closed 拒包。
function assertUiTree(outDir) {
  const uiDir = join(outDir, "ui");
  if (!fs.pathExistsSync(uiDir)) {
    throw new Error("App ui/ 静态树缺失（dist/ui 不存在）：src/ui 未随 build 拷贝——先跑 pnpm run build 再打包");
  }
  for (const rel of ["dshana/main.html", "dshana/sidebar.html", "dshana/app-shell.js"]) {
    if (!fs.pathExistsSync(join(uiDir, rel))) {
      throw new Error("App ui/ 缺 cards route 资源：" + rel + "（src/ui/" + rel + " 缺失或构建未跑）");
    }
  }
  console.log("[pack] ui/ 静态树完整（main/sidebar 壳页 + app-shell.js）");
}
assertUiTree(distDir);

// 1.7) 生产依赖物化（自包含打包）：逐目标在各自的隔离暂存目录里做**干净安装**，得到只含该
//   平台资产的 node_modules（hoisted 布局：顶层真实目录、无软链接——软链进 zip 跨机解压即断）。
//   实测（Windows + 热缓存）：单目标安装 8.4s / 210 MB，且不含其他平台的边角；而「通用树裁剪
//   派生」会留残留且更大（见 specs §11）。
//   目标集对着**宿主支持矩阵**写，不对着「我们顺带能装出来的东西」写：macOS arm64 / macOS x64 /
//   Windows x64 / Linux x86_64（glibc），外加通用兜底包。
//   · 为什么隔离目录：不触碰仓库 node_modules（dev+prod 混合树，且动它会触发 pnpm 重建——
//     Windows 上曾遇清理被拒导致树损坏）。
//   用法：node scripts/pack.mjs [--targets universal|all|<逗号分隔目标名>]；默认 universal
//   （保持既有 CI 行为）；CI 改造后传 all，出 4 个平台包 + 通用兜底。
//   别名约定：`pack:<target>` 与 `pack:all` 都必须**委派给 pack**（`pnpm run pack --targets=…`），
//   不能直接写 `node scripts/pack.mjs --targets=…`：pnpm 的 pre/post 钩子是按脚本名精确匹配的，
//   `pack:linux-x64` 只会去找 `prepack:linux-x64` / `postpack:linux-x64`（实测确认），直接调脚本
//   会同时跳过 prepack（build）与 postpack（清临时目录）。`pack:all` = 依次调各 `pack:<target>`。
const stagingRoot = join(ROOT, "_tmp", "pkg-root");

const HOST_TARGETS = [
  // 注：darwin / linux 的 libvips 单独分包（@img/sharp-libvips-*），Windows 则内联在
  // @img/sharp-win32-x64 里、无独立 libvips 包——断言清单按平台实际形态写（实测得出）。
  { name: "darwin-arm64", os: ["darwin"], cpu: ["arm64"], assets: ["@koromix/koffi-darwin-arm64", "node-addon-require-builtin-darwin-arm64", "@img/sharp-darwin-arm64", "@img/sharp-libvips-darwin-arm64"] },
  { name: "darwin-x64", os: ["darwin"], cpu: ["x64"], assets: ["@koromix/koffi-darwin-x64", "node-addon-require-builtin-darwin-x64", "@img/sharp-darwin-x64", "@img/sharp-libvips-darwin-x64"] },
  { name: "linux-x64", os: ["linux"], cpu: ["x64"], libc: ["glibc"], assets: ["@koromix/koffi-linux-x64", "node-addon-require-builtin-linux-x64-gnu", "@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64"] },
  { name: "win32-x64", os: ["win32"], cpu: ["x64"], assets: ["@koromix/koffi-win32-x64", "node-addon-require-builtin-win32-x64-msvc", "@img/sharp-win32-x64"] },
];
// 通用兜底包：os × cpu 全叉乘（比宿主矩阵多出 win32-arm64 / linux-arm64 等）；体量更大，
// 用于兜底（用户在宿主矩阵外也能跑，代价是下载大）。
const UNIVERSAL_TARGET = {
  name: "universal",
  os: ["win32", "darwin", "linux"],
  cpu: ["x64", "arm64"],
  assets: HOST_TARGETS.flatMap((t) => t.assets),
};

// 非宿主矩阵、**仅手动编译**的目标（不进 CI 主线）：宿主未承诺这些平台，但预编译资产实测存在，
// 需要时点名出包（`pack:<target>` 别名已备）。资产清单同样按实测形态写。
// 注：这些目标不进 `--targets=all`，只能点名；否则 CI 会产出宿主不支持的包。
const EXTRA_TARGETS = [
  { name: "linux-arm64", os: ["linux"], cpu: ["arm64"], libc: ["glibc"], assets: ["@koromix/koffi-linux-arm64", "node-addon-require-builtin-linux-arm64-gnu", "@img/sharp-linux-arm64", "@img/sharp-libvips-linux-arm64"] },
  { name: "win32-arm64", os: ["win32"], cpu: ["arm64"], assets: ["@koromix/koffi-win32-arm64", "node-addon-require-builtin-win32-arm64-msvc", "@img/sharp-win32-arm64"] },
];

function targetSpec(name) {
  if (name === "universal") return UNIVERSAL_TARGET;
  return HOST_TARGETS.find((t) => t.name === name) || EXTRA_TARGETS.find((t) => t.name === name) || null;
}

// 仓库 pnpm-workspace.yaml 中的 supportedArchitectures 由本脚本按目标替换（标记块内）
const PT_START = "# >>> pack-targets";
const PT_END = "# <<< pack-targets";
function stagingWorkspaceYaml(spec) {
  const repoWs = fs.readFileSync(join(ROOT, "pnpm-workspace.yaml"), "utf8");
  const block = [
    "supportedArchitectures:",
    "  os:",
    ...spec.os.map((v) => `    - ${v}`),
    "  cpu:",
    ...spec.cpu.map((v) => `    - ${v}`),
    ...(spec.libc ? ["  libc:", ...spec.libc.map((v) => `    - ${v}`)] : []),
    "",
  ].join("\n");
  const i = repoWs.indexOf(PT_START);
  const j = repoWs.indexOf(PT_END);
  const body = i >= 0 && j > i
    ? repoWs.slice(0, i + PT_START.length) + "\n" + block + repoWs.slice(j)
    : repoWs + "\n" + block;
  // nodeLinker 必须在工作区文件里（CLI 传参形式实测不生效）
  return "# pack.mjs 生成（每次打包重建，勿手改）\nnodeLinker: hoisted\n\n" + body;
}

/** 逐目标干净安装（各自暂存目录 + 各自 supportedArchitectures）；返回该目标的 node_modules 路径。 */
function materializeProdDeps(spec) {
  const { spawnSync } = require("node:child_process");
  const dir = join(stagingRoot, spec.name);
  const modules = join(dir, "node_modules");
  fs.removeSync(dir);
  fs.ensureDirSync(dir);
  fs.copySync(join(ROOT, "package.json"), join(dir, "package.json"));
  fs.copySync(join(ROOT, "pnpm-lock.yaml"), join(dir, "pnpm-lock.yaml"));
  fs.writeFileSync(join(dir, "pnpm-workspace.yaml"), stagingWorkspaceYaml(spec), "utf8");
  console.log(`[pack] 物化 ${spec.name}（干净安装，隔离目录 _tmp/pkg-root/${spec.name}）...`);
  const res = spawnSync("pnpm", ["install", "--prod", "--frozen-lockfile"], {
    cwd: dir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) throw new Error(`生产依赖物化失败（${spec.name}，pnpm install --prod 退出码 ${res.status}）`);
  if (!fs.pathExistsSync(modules)) throw new Error(`生产依赖物化失败（${spec.name}）：node_modules 未生成`);
  const missing = spec.assets.filter((a) => !fs.pathExistsSync(join(modules, a, "package.json")));
  if (missing.length) {
    throw new Error(`${spec.name} 缺少平台资产（该平台的包会跑不起来）：\n  - ${missing.join("\n  - ")}`);
  }
  console.log(`[pack] ${spec.name} 物化完成（平台资产 ${spec.assets.length} 项齐备）`);
  return modules;
}

// 目标选择（默认 universal：保持既有 CI 行为）
const selectedSpecs = (() => {
  const eqArg = process.argv.find((a) => a.startsWith("--targets="));
  const idx = process.argv.indexOf("--targets");
  const raw = eqArg ? eqArg.slice("--targets=".length) : idx >= 0 ? process.argv[idx + 1] : "universal";
  const names = !raw || raw === "universal"
    ? ["universal"]
    : raw === "all"
      ? ["universal", ...HOST_TARGETS.map((t) => t.name)]
      : raw.split(",").map((s) => s.trim()).filter(Boolean);
  return names.map((n) => {
    const spec = targetSpec(n);
    if (!spec) throw new Error(`未知打包目标：${n}（可选：universal / all / ${[...HOST_TARGETS, ...EXTRA_TARGETS].map((t) => t.name).join(" / ")}）`);
    return spec;
  });
})();

// 2. 静态资产压缩（terser JS 纯语法级 + clean-css CSS 压缩，覆盖写回 dist 副本）
//     cordis 插件（dist/cordis/*/index.js，由 build 从
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

// 3+4) 逐目标组装 → zip → SHA256（发布产物归档 releases/）
//    archiver 纯 Node 跨平台 zip（对齐 hana-remote-dev）：不用 tar -a -cf——
//    GNU tar（Linux）不认 .zip 后缀会静默产出 tar 伪 zip（CI ubuntu 踩坑 2026-08-14）
const relDir = join(ROOT, "releases");
fs.ensureDirSync(relDir);
// 临时目录纪律（曾因多目标连跑堆积 2.2 GB 把宿主压崩）：
//   · 起手清残留（上次运行/中途崩溃留下的）；
//   · 逐目标用完即清（暂存树 + 铺平目录），峰值 → 单目标；
//   · 收尾全清由 package.json 的 postpack 钩子承担（scripts/clean-tmp.mjs），CI 里也可单独调。
// 中间原料与暂存树都可再生，真正的产物只有 releases/ 下的 zip + sha256。
const pkgRoot = join(ROOT, "_tmp", "pkg");
for (const stale of [pkgRoot, stagingRoot]) fs.removeSync(stale);
for (const spec of selectedSpecs) {
  const modules = materializeProdDeps(spec);
  // 命名：通用包无后缀（既有 CI/脚本按 dsh-hanako-v<ver>.zip 取件），平台包带目标后缀
  const base = spec.name === "universal" ? `dsh-hanako-v${version}` : `dsh-hanako-v${version}-${spec.name}`;
  const pkgDir = join(pkgRoot, base); // 铺平目录（zip 中间原料）
  fs.removeSync(pkgDir);
  fs.copySync(distDir, pkgDir);
  fs.copySync(modules, join(pkgDir, "node_modules"));
  // 暂存树用完即删：逐目标峰值磁盘从「所有目标叠加」降到「单目标」
  fs.removeSync(join(stagingRoot, spec.name));
  console.log(`[pack] ${spec.name}：代码 + 依赖树已就位（${base}），暂存树已清理`);
  const zipPath = join(relDir, `${base}.zip`);
  fs.removeSync(zipPath);
  const tmpZip = join(relDir, `.${base}.zip.tmp`); // 先写临时文件，rename 原子落位
  const output = fs.createWriteStream(tmpZip);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  const done = new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(output);
  archive.directory(pkgDir, base);
  await archive.finalize();
  await done;
  fs.moveSync(tmpZip, zipPath, { overwrite: true });
  const buf = fs.readFileSync(zipPath);
  const sha = createHash("sha256").update(buf).digest("hex").toUpperCase();
  console.log(`[pack] ${zipPath}`);
  console.log(`[pack] zip ${(buf.length / 1048576).toFixed(1)} MB · SHA256 ${sha}`);
  fs.writeFileSync(`${zipPath}.sha256`, sha, "utf8");
  // 该目标的铺平目录已入包，即用即清（峰值 → 单目标）
  fs.removeSync(pkgDir);
}
// 收尾全清 → postpack 钩子（scripts/clean-tmp.mjs）