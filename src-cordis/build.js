// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src-cordis/build.js — src-cordis 域构建入口（cordis 子插件包）
// 布局：领域专用随源码——cordis 域脚本/配置全在 src-cordis/（build/ preset + 每包
// cordis.config.mjs 描述），共享工具（rspack 本体解析/URL 回写/terser/assert + 共享
// minify-loader）在 scripts/ 根级。产物 dist/cordis/**：
//   9 子插件：service 半 rspack（index.js bundle）+ client 半 tsdown（settings/view 等，closure-factory）
//   + dshana roster bundle（package.json + cordis.patch.yml）+ 静态 package.json/client.js
// 用法：node src-cordis/build.js [RSPACK_ENV=<构建环境目录>]
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import fs from "fs-extra";
import { serviceBundle } from "./build/service-config.mjs"; // preset 层（src-cordis/build/）
import { buildClientBundle } from "./build/client-config.mjs";
import { collectSource, makeUrlRewriter, assertNoStaticFileUrl } from "../scripts/build-common.mjs"; // 根级共享

const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // src-cordis/ → 仓库根
const SRC_ROOT = join(ROOT, "src-cordis");

// rspack 解析（同 build-src：RSPACK_ENV 或本地 node_modules）
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
    pathToFileURL(resolveRspackEntry(join(envDir, "node_modules", "@rspack", "core"))).href,
  );
} else {
  rspackPkg = await import("@rspack/core");
}
const rspack = rspackPkg.rspack ?? rspackPkg.default?.rspack;

// cordis 域源码收集（plugins/**/*.js；cordis.config/build 为 .mjs 不收集）
const rewriter = makeUrlRewriter(collectSource(join(SRC_ROOT, "plugins")));

// 静态组装：子插件 package.json/client.js + dshana roster bundle
function buildCordisStatic(outRoot) {
  fs.removeSync(outRoot);
  fs.ensureDirSync(outRoot);
  const pluginsRoot = join(SRC_ROOT, "plugins");
  if (!fs.pathExistsSync(pluginsRoot)) throw new Error("src-cordis/plugins 缺失");
  const pkgNames = [];
  for (const name of fs.readdirSync(pluginsRoot)) {
    if (name.startsWith(".")) continue;
    const pkgSrc = join(pluginsRoot, name);
    if (!fs.statSync(pkgSrc).isDirectory()) continue;
    const pkgOut = join(outRoot, name);
    fs.ensureDirSync(pkgOut);
    pkgNames.push(name);
    for (const f of ["package.json"]) {
      const s = join(pkgSrc, f);
      if (!fs.pathExistsSync(s)) throw new Error(`cordis 插件文件缺失：${s}`);
      fs.copySync(s, join(pkgOut, f));
    }
    const clientSrc = join(pkgSrc, "client.js");
    if (fs.pathExistsSync(clientSrc)) fs.copySync(clientSrc, join(pkgOut, "client.js"));
  }
  const bundleOut = join(outRoot, "dshana");
  for (const f of ["cordis.patch.yml", "package.json"]) {
    const s = join(SRC_ROOT, f);
    if (!fs.pathExistsSync(s)) throw new Error(`cordis bundle 文件缺失：${s}`);
    fs.copySync(s, join(bundleOut, f));
  }
  console.log("cordis 静态组装 -> dist/cordis/（子插件 " + pkgNames.length + " 包 + dshana bundle）");
}

// 每包构建描述加载
async function loadCordisPackageConfigs() {
  const pluginsRoot = join(SRC_ROOT, "plugins");
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

// service 半（rspack 逐包）
async function buildServiceHalves(packages, outRoot) {
  let count = 0;
  for (const { name, pkgDir } of packages) {
    const cfg = serviceBundle({ name, pkgDir, outDir: join(outRoot, name) });
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
  console.log(`cordis service 半（rspack）-> ${outRoot}（${count} 个 ESM bundle）`);
}

// client 半（tsdown，有 client 描述字段的包）
async function buildClientHalves(packages, outRoot) {
  let count = 0;
  for (const { name, pkgDir, cfg } of packages) {
    if (!cfg.client) continue;
    await buildClientBundle({
      id: `@dsh-hanako/${name}`,
      pkgDir,
      outDir: join(outRoot, name),
      externals: cfg.client.externals,
      defines: cfg.client.defines,
    });
    count += 1;
  }
  console.log(`cordis client 半（tsdown）-> ${outRoot}（${count} 个 closure-factory bundle）`);
}

// 主流程
const outRoot = join(ROOT, "dist", "cordis");
const cordisPackages = await loadCordisPackageConfigs();
buildCordisStatic(outRoot);
await buildServiceHalves(cordisPackages, outRoot);
await buildClientHalves(cordisPackages, outRoot);
// cordis bundle URL 回写（dist/cordis 区）
rewriter(outRoot);
assertNoStaticFileUrl(join(ROOT, "dist"));
console.log("build:cordis done ->", outRoot);
