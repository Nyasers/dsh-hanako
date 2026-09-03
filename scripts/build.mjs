// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/build.mjs — dsh-hanako 单 bundle 构建（收敛架构；构建脚本不随源码编译）
// 产物：dist/index.js（单 bundle：生命周期+5 工具+lib+lifecycle+内联前端资源）
//     + dist/routes/index.js 壳（宿主 routes/ 目录扫描，import bundle 导出转发）
//     + dist/manifest.json（宿主 entry 指向 index.js）。插件本体零依赖打包。
// 用法：
//   node scripts/build.mjs                    # 本地已装 @rspack/core 时
//   RSPACK_ENV=<构建环境目录> node scripts/build.mjs   # 独立构建环境
// 注意：@rspack/core 不声明为插件依赖（交付物零依赖），构建工具放独立构建环境或本机。
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import fs from "fs-extra";
import config from "./rspack.config.mjs";
// 构建后整体 terser 压缩（对 rspack 产物 + routes 壳做第二轮压缩）
import { minifyJs } from "./minify-assets.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

// 构建前收集会被 rspack 内联进 bundle 的全部源码 file:// URL（src/ 下全部 .js 模块），
// 构建后产物里出现的这些字面量一律替换回 import.meta.url：rspack 会把 import.meta.url
// 静态化为构建机上的源码绝对路径，分发到对方机器后路径失效。
// 替换后 import.meta.url 指向 bundle 自身（dist/index.js），向上找 manifest.json 的
// 定位逻辑（src/tools/lib/state.js 的 PLUGIN_ROOT）从 bundle 一步即达 dist 根，语义不变。
const staticUrlToMeta = new Map();
(function collectSource(urlRoot) {
  for (const name of fs.readdirSync(urlRoot)) {
    if (
      name === "dist" ||
      name === "node_modules" ||
      name === "releases" ||
      name === "_tmp" ||
      name === ".git" ||
      name === "src-cordis"
    )
      continue;
    const p = join(urlRoot, name);
    if (fs.statSync(p).isDirectory()) collectSource(p);
    else if (p.endsWith(".js")) staticUrlToMeta.set(pathToFileURL(p).href, p);
  }
})(ROOT);

const compiler = rspack(config);

await new Promise((resolvePromise, reject) => {
  compiler.run((err, stats) => {
    compiler.close(() => {});
    if (err) return reject(err);
    if (stats?.hasErrors()) return reject(new Error(stats.toString({ errors: true })));
    console.log(stats?.toString({ colors: true, chunks: false, modules: false, assets: true }));
    resolvePromise();
  });
});

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
walk(join(ROOT, "dist"));

// 2) 写 dist/routes/index.js 壳（宿主扫描 routes/ 目录 → import bundle 具名导出转发）
const p = join(ROOT, "dist", "routes", "index.js");
const shell = 'import { pluginRoutes } from "../index.js";\nexport default pluginRoutes;\n';
fs.outputFileSync(p, shell, "utf8");
console.log("route shell -> routes/index.js");

// 3) 拷贝 manifest.json（dist 根：state.js PLUGIN_ROOT 向上找 manifest.json 即达 dist 根）
fs.copySync(join(ROOT, "manifest.json"), join(ROOT, "dist", "manifest.json"));
console.log("manifest.json -> dist/");

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
await extraTerser(join(ROOT, "dist"));

// 5) 构建 cordis 资产（dist/cordis）：src-cordis = @dsh-hanako/dshana bundle 源码根目录
//    （顶层 package.json + cordis.patch.yml）+ 子插件 plugins/ + 种子模板 seed/。产物：
//      dist/cordis/node_modules/@dsh-hanako/dshana/   ← src-cordis/{package.json, cordis.patch.yml}
//        （bundle 顶层文件入 dshana 子目录：package.json 的 dsh.bundle.patch 声明随包生效）
//      dist/cordis/node_modules/@dsh-hanako/<8 子插件> ← src-cordis/plugins/@dsh-hanako/**
//      dist/cordis/seed/**                            ← src-cordis/seed/**（profile 种子模板，
//        四件套独立文件：package.json/cordis.yml/cordis.patch.yml/pnpm-workspace.yaml；运行时
//        由 profile-seed.js ensureProfileSeeded 读模板落位 $DSH_HOME/profiles/dshana）
//    profile 根四件套不再由构建期内嵌字符串生成——profile 目录改为运行时种子化的用户自有
//    真实目录（落位见 lifecycle.js ensureDshanaProfile → tools/lib/profile-seed.js）。
//    插件 JS 不做 build 这轮 terser（归 pack.mjs 静态压缩步），故不在此遍历的 node_modules
//    跳过名单之外再压缩。
function buildCordis(srcRoot, outRoot) {
  fs.removeSync(outRoot);
  fs.ensureDirSync(outRoot);
  // 1) 子插件（scope 目录整体复制）：plugins/@dsh-hanako → node_modules/@dsh-hanako
  //    （8 包与 bundle 同 scope 物理共存，经单条 scope 目录链接暴露进 profile node_modules）
  const pluginsRoot = join(srcRoot, "plugins");
  if (!fs.pathExistsSync(pluginsRoot)) throw new Error("src-cordis/plugins 缺失");
  for (const scope of fs.readdirSync(pluginsRoot)) {
    const scopeDir = join(pluginsRoot, scope);
    if (!fs.statSync(scopeDir).isDirectory()) continue;
    fs.copySync(scopeDir, join(outRoot, "node_modules", scope));
  }
  // 2) bundle 顶层文件 → node_modules/@dsh-hanako/dshana/
  const bundleDir = join(outRoot, "node_modules", "@dsh-hanako", "dshana");
  for (const f of ["cordis.patch.yml", "package.json"]) {
    const s = join(srcRoot, f);
    if (!fs.pathExistsSync(s)) throw new Error(`cordis bundle 文件缺失：${s}`);
    fs.copySync(s, join(bundleDir, f));
  }
  // 3) 种子模板（profile 四件套独立文件，运行时读模板种子化）→ dist/cordis/seed/
  const seedSrc = join(srcRoot, "seed");
  if (!fs.pathExistsSync(seedSrc)) throw new Error("cordis seed 模板目录缺失：" + seedSrc);
  fs.copySync(seedSrc, join(outRoot, "seed"));
  console.log("cordis assets -> dist/cordis/");
}
buildCordis(join(ROOT, "src-cordis"), join(ROOT, "dist", "cordis"));


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
assertNoStaticFileUrl(join(ROOT, "dist"));

console.log("build done ->", join(ROOT, "dist"));
