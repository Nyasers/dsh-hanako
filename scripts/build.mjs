// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/build.mjs — dsh-hanako 构建（两源两产物，可分段执行）
// 产物：
//   src 半（build:src）：dist/index.js（插件本体单 bundle：生命周期+工具+lib+前端资源）
//     + dist/routes/index.js 壳 + dist/manifest.json
//   src-cordis 半（build:cordis）：dist/cordis/**（@dsh-hanako/* cordis 子插件包：
//     service 半 rspack + client 半 tsdown，见 src-cordis/build preset）
// 用法：
//   node scripts/build.mjs                # 全量（src + cordis）
//   node scripts/build.mjs --src          # 只 src 半（主 bundle）
//   node scripts/build.mjs --cordis       # 只 src-cordis 半（cordis 子插件，高频迭代快）
//   RSPACK_ENV=<构建环境目录> node scripts/build.mjs   # 独立构建环境
// 注意：@rspack/core 不声明为插件依赖（交付物零依赖），构建工具放独立构建环境或本机。
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import fs from "fs-extra";
import config from "./rspack.config.mjs";
// cordis 子插件构建：共享 preset 层在 src-cordis/build（配置随源码走，学官方 dsh）
import { serviceBundle } from "../src-cordis/build/service-config.mjs";
import { buildClientBundle } from "../src-cordis/build/client-config.mjs";
// 构建后整体 terser 压缩（对 rspack 产物 + routes 壳做第二轮压缩）
import { minifyJs } from "./minify-assets.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODE = process.argv.includes("--cordis")
  ? "cordis"
  : process.argv.includes("--src")
    ? "src"
    : "all";

// rspack 解析：RSPACK_ENV 指向构建环境（推荐），否则本地 node_modules
// rspack 2.x 为 ESM-only，动态 import（解析 exports/main 到实际入口文件）。
function resolveRspackEntry(coreDir) {
  const pkg = JSON.parse(fs.readFileSync(join(coreDir, "package.json"), "utf8"));
  const dot = pkg.exports?.["."];
  let entry = null;
  if (typeof dot === "string") entry = dot;
  else if (dot && typeof dot === "object") entry = dot.default ?? dot.import ?? dot.require;
  if (!entry) entry = pkg.main ?? "dist/index.js";
  return join(coreDir, entry);
}
let rspackPkg;
const envDir = process.env.RSPACK_ENV;
if (envDir) {
  rspackPkg = await import(
    pathToFileURL(
      resolveRspackEntry(join(envDir, "node_modules", "@rspack", "core")),
    ).href,
  );
} else {
  rspackPkg = await import("@rspack/core");
}
const rspack = rspackPkg.rspack ?? rspackPkg.default?.rspack;

// 构建前收集会被 rspack 内联进 bundle 的全部源码 file:// URL（src/ + src-cordis/ 下全部
// .js 模块），构建后产物里出现的这些字面量一律替换回 import.meta.url：rspack 会把
// import.meta.url 静态化为构建机上的源码绝对路径，分发到对方机器后路径失效。
// 替换后 import.meta.url 指向 bundle 自身（dist/index.js 或 dist/cordis/<pkg>/index.js），
// 向上找 manifest.json 的定位逻辑从 bundle 一步即达产物根，语义不变。
const staticUrlToMeta = new Map();
(function collectSource(urlRoot) {
  for (const name of fs.readdirSync(urlRoot)) {
    if (
      name === "dist" ||
      name === "node_modules" ||
      name === "releases" ||
      name === "_tmp" ||
      name === ".git"
    )
      continue;
    const p = join(urlRoot, name);
    if (fs.statSync(p).isDirectory()) collectSource(p);
    else if (p.endsWith(".js")) staticUrlToMeta.set(pathToFileURL(p).href, p);
  }
})(ROOT);

// ---- 构建后处理 ----
// 1) 静态化路径字面量 → import.meta.url（运行时语义；压缩产物里是 "file:///..." 或 'file:///...'）
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js")) {
      let code = fs.readFileSync(p, "utf8");
      let changed = false;
      for (const [url, entryName] of staticUrlToMeta) {
        for (const quoted of [`"${url}"`, `'${url}'`]) {
          if (code.includes(quoted)) {
            code = code.split(quoted).join("import.meta.url");
            changed = true;
            console.log("patched import.meta.url -> " + entryName);
          }
        }
      }
      if (changed) fs.writeFileSync(p, code, "utf8");
    }
  }
}

// 4) dist 整体额外 terser 压缩：rspack（swc）已压过一轮，这里再走 terser 做第二轮
// （bundle 字符串资产 - 内联 HTML/CSS/JS 一并在内；引号统一/去多余空格/再 mangle）。
// 顺序说明：必须在本步之前完成 import.meta.url 替换（walk）——若先 terser 再替换，
// terser 会把引号统一/字面量改写导致替换锚点（"file://..." / 'file://...'）失配。
// 遍历 dist 全部 .js；跳过 node_modules（npm 自带产物不归我们压）与 dsh-plugin
// （cordis 插件由 pack.mjs 的静态压缩步处理，避免重复压缩）。
function extraTerser(root) {
  const files = [];
  const collect = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = join(dir, name);
      if (name === "node_modules" || name === "dsh-plugin") continue;
      if (fs.statSync(p).isDirectory()) collect(p);
      else if (p.endsWith(".js")) files.push(p);
    }
  };
  collect(root);
  console.log("[build] extra terser (" + files.length + " files)...");
  return (async () => {
    for (const file of files) {
      const code = fs.readFileSync(file, "utf8");
      const before = Buffer.byteLength(code, "utf8");
      let out;
      try {
        out = await minifyJs(code); // module: true —— ESM bundle 与 routes 壳均适用
      } catch (err) {
        throw new Error("extra terser 失败（" + file + "）：" + err.message);
      }
      fs.writeFileSync(file, out, "utf8");
      const after = Buffer.byteLength(out, "utf8");
      const rel = file.startsWith(join(ROOT, "dist")) ? file.slice(join(ROOT, "dist").length + 1) : file;
      console.log(
        "[build]   " + rel + ": " + before + " -> " + after + " bytes (" +
        ((1 - after / before) * 100).toFixed(1) + "% 缩减)",
      );
    }
  })();
}

// ==================== src 半（插件本体 bundle） ====================
async function buildSrcPhase() {
  const compiler = rspack(config);
  await new Promise((resolvePromise, reject) => {
    compiler.run((err, stats) => {
      compiler.close(() => { });
      if (err) return reject(err);
      if (stats?.hasErrors()) return reject(new Error(stats.toString({ errors: true })));
      console.log(stats?.toString({ colors: true, chunks: false, modules: false, assets: true }));
      resolvePromise();
    });
  });

  // 构建后处理：静态化路径回写（主 bundle 区）
  walk(join(ROOT, "dist"));

  // 2) 写 dist/routes/index.js 壳（宿主扫描 routes/ 目录 → import bundle 具名导出转发）
  const p = join(ROOT, "dist", "routes", "index.js");
  const shell = 'import { pluginRoutes } from "../index.js";\nexport default pluginRoutes;\n';
  fs.outputFileSync(p, shell, "utf8");
  console.log("route shell -> routes/index.js");

  // 3) 拷贝 manifest.json（dist 根：state.js PLUGIN_ROOT 向上找 manifest.json 即达 dist 根）
  fs.copySync(join(ROOT, "src", "manifest.json"), join(ROOT, "dist", "manifest.json")); // src 域构件（manifest 随 src 半产出）
  console.log("manifest.json -> dist/");

  // 4) 主 bundle 区额外 terser（rspack 已压一轮，二次压缩字符串资产）
  await extraTerser(join(ROOT, "dist"));
  console.log("build:src -> dist/");
}

// ==================== src-cordis 半（cordis 子插件包） ====================
// 产物：
//   dist/cordis/<8 包>/index.js
//     ← 各包 service 半：源码入口经 rspack 打成 ESM bundle（preset 见
//     src-cordis/build/service-config.mjs，配置随包走——各包自持构建描述
//     cordis.config.mjs；内部模块合并、assets/ 独立资源 minify + asset/source
//     内联、node 内建外部 import、具名导出保留）
//   dist/cordis/<8 包>/{package.json, client.js?}
//     ← 源包静态文件（package.json 恒复制；client.js 仅 bridge 保留散装复制——
//     vendor 手写 __ModuleLoader__ bundle 无内容字符串不进打包链；settings 的
//     client.js 为 ESM 源，由 client 半 preset 产物覆盖，不复制）
//   dist/cordis/<pkg>/client.js（settings）
//     ← client 半：tsdown closure-factory 自注册 bundle（preset 见
//     src-cordis/build/client-config.mjs，学官方 clientBundle 预设）
//   dist/cordis/dshana/{package.json, cordis.patch.yml}
//     ← src-cordis 顶层（roster bundle 包：dsh.bundle.patch 声明，无 JS 入口不打包）
// profile 文件（manifest/用户层/pnpm-workspace/cordis.yml）不随产物分发——profile
// 目录由运行时官方 initProfile 生成 + dsh boot prepareProfile 自维护
// （落位见 lifecycle.js ensureDshanaProfile → tools/lib/profile-seed.js）。
function buildCordisStatic(srcRoot, outRoot) {
  fs.removeSync(outRoot);
  fs.ensureDirSync(outRoot);
  // 1) 子插件静态文件（package.json + 存在时的 client.js）：plugins/<pkg> 单层平铺
  //    （@dsh-hanako scope 是包名/解析语义（对应插件 Hana id），源码与产物目录不套 scope 层）
  const pluginsRoot = join(srcRoot, "plugins");
  if (!fs.pathExistsSync(pluginsRoot)) throw new Error("src-cordis/plugins 缺失");
  const pkgNames = [];
  for (const name of fs.readdirSync(pluginsRoot)) {
    if (name.startsWith(".")) continue;
    const pkgSrc = join(pluginsRoot, name);
    if (!fs.statSync(pkgSrc).isDirectory()) continue;
    const pkgOut = join(outRoot, name); // 产物 9 包平铺于 cordis 资产根
    fs.ensureDirSync(pkgOut);
    pkgNames.push(name);
    // 静态 allowlist：package.json 恒复制；client.js 仅存在时复制（bridge/settings
    // 浏览器端 __ModuleLoader__ bundle）。index.js 由 rspack 输出覆盖；assets/ 与
    // ws-lib.js 等内部模块已内联/合并进 bundle，不复制。
    for (const f of ["package.json"]) {
      const s = join(pkgSrc, f);
      if (!fs.pathExistsSync(s)) throw new Error(`cordis 插件文件缺失：${s}`);
      fs.copySync(s, join(pkgOut, f));
    }
    const clientSrc = join(pkgSrc, "client.js");
    if (fs.pathExistsSync(clientSrc)) fs.copySync(clientSrc, join(pkgOut, "client.js"));
  }
  // 2) dshana roster bundle 包（src-cordis 顶层两文件，无 JS 入口不打包）
  const bundleOut = join(outRoot, "dshana");
  for (const f of ["cordis.patch.yml", "package.json"]) {
    const s = join(srcRoot, f);
    if (!fs.pathExistsSync(s)) throw new Error(`cordis bundle 文件缺失：${s}`);
    fs.copySync(s, join(bundleOut, f));
  }
  console.log("cordis 静态组装 -> dist/cordis/（子插件 " + pkgNames.length + " 包 + dshana bundle）");
}

// 打包 cordis 子插件（两链编排）：扫描各包自持构建描述（cordis.config.mjs）→
// src-cordis/build/* preset 生成配置并执行。service 半默认开（有 index.js 即打
// rspack ESM bundle）；client 半按描述 client 字段声明（settings）经 tsdown 打
// closure-factory。描述约定见各包 cordis.config.mjs 头注释。
async function loadCordisPackageConfigs() {
  const pluginsRoot = join(ROOT, "src-cordis", "plugins");
  const list = [];
  for (const name of fs.readdirSync(pluginsRoot)) {
    const pkgDir = join(pluginsRoot, name);
    if (!fs.statSync(pkgDir).isDirectory()) continue;
    const cfgPath = join(pkgDir, "cordis.config.mjs");
    if (!fs.pathExistsSync(cfgPath)) throw new Error(`cordis 包缺构建描述：${cfgPath}`);
    const mod = await import(pathToFileURL(cfgPath).href);
    list.push({ name, pkgDir, cfg: mod.default ?? {} });
  }
  return list;
}

// service 半：逐包 rspack 编译（preset serviceBundle），输出各包 index.js。
// 顺序依赖 buildCordisStatic 先建目录（rspack clean:false，只写 index.js 不删静态文件）。
async function buildServiceHalves(packages, outRoot) {
  const pkgOutRoot = outRoot; // scope 根 = cordis 资产根（9 包平铺）
  let count = 0;
  for (const { name, pkgDir } of packages) {
    const cfg = serviceBundle({ name, pkgDir, outDir: join(pkgOutRoot, name) });
    await new Promise((resolvePromise, reject) => {
      const compiler = rspack(cfg);
      compiler.run((err, stats) => {
        compiler.close(() => { });
        if (err) return reject(err);
        if (stats?.hasErrors()) return reject(new Error(stats.toString({ errors: true })));
        resolvePromise();
      });
    });
    count += 1;
  }
  console.log(`cordis service 半（rspack）-> ${pkgOutRoot}（${count} 个 ESM bundle）`);
}

// client 半：有 client 描述字段的包经 tsdown preset 打 closure-factory 自注册 bundle。
// 产物与 rspack service 半同目录共存（只写 client.js）。
async function buildClientHalves(packages, outRoot) {
  const pkgOutRoot = outRoot; // scope 根 = cordis 资产根（9 包平铺）
  let count = 0;
  for (const { name, pkgDir, cfg } of packages) {
    if (!cfg.client) continue;
    await buildClientBundle({
      id: `@dsh-hanako/${name}`,
      pkgDir,
      outDir: join(pkgOutRoot, name),
      externals: cfg.client.externals,
    });
    count += 1;
  }
  console.log(`cordis client 半（tsdown）-> ${pkgOutRoot}（${count} 个 closure-factory bundle）`);
}

async function buildCordisPhase() {
  const cordisPackages = await loadCordisPackageConfigs();
  await buildCordisStatic(join(ROOT, "src-cordis"), join(ROOT, "dist", "cordis"));
  await buildServiceHalves(cordisPackages, join(ROOT, "dist", "cordis"));
  await buildClientHalves(cordisPackages, join(ROOT, "dist", "cordis"));

  // cordis 子插件 bundle 同款回写：rspack 会把各包源码模块的 import.meta.url 静态化为
  // 构建机上的源码绝对路径（src-cordis/plugins/...），分发后路径失效——collectSource 现已
  // 涵盖 src-cordis（见上），这里对 dist/cordis 再跑一次 walk 回写 import.meta.url（产物
  // bundle 落位 dist/cordis/<pkg>/index.js，createRequire(import.meta.url) 语义不变）
  walk(join(ROOT, "dist", "cordis"));
  console.log("build:cordis -> dist/cordis/");
}

// ==================== 主控 ====================
// 6) 构建后强制校验：产物不得残留带引号的 file:// 字面量（构建机路径泄漏即失败）。
// 回归防护：收集范围再全也有漏网可能，这里兜底——CI 出包残留即构建失败。
function assertNoStaticFileUrl(root) {
  const offenders = [];
  const scan = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = join(dir, name);
      if (fs.statSync(p).isDirectory()) scan(p);
      else if (p.endsWith(".js")) {
        const code = fs.readFileSync(p, "utf8");
        for (const m of code.matchAll(/["']file:\/\/[^"']+["']/g)) {
          offenders.push(p + ": " + m[0].slice(0, 120));
        }
      }
    }
  };
  scan(root);
  if (offenders.length) {
    throw new Error(
      "构建产物残留静态 file:// 字面量（构建机路径泄漏）：\\n" +
      offenders.slice(0, 10).join("\\n"),
    );
  }
  console.log("assert no static file:// literal -> ok");
}

if (MODE !== "cordis") await buildSrcPhase();
if (MODE !== "src") await buildCordisPhase();
assertNoStaticFileUrl(join(ROOT, "dist"));
console.log("build done（" + MODE + "）->", join(ROOT, "dist"));
