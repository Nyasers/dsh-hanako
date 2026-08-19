// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/build.mjs — dsh-hanako rspack 构建（v0.6.0 轻量化分化）
// 产物：dist/index.js + dist/tools/*.js（ESM bundle，压缩），插件本体零依赖打包。
// 用法：
//   node scripts/build.mjs                       # 本地已装 @rspack/core 时
//   RSPACK_ENV=<构建环境目录> node scripts/build.mjs   # 用独立构建环境（推荐）
// 注意：@rspack/core 不声明为插件依赖（交付物零依赖，Agent npm ci 只装运行时 dsh），
// 构建工具放在独立构建环境或本机。
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import fs from "fs-extra";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// rspack 解析：RSPACK_ENV 指向构建环境（推荐），否则本地 node_modules
// v0.7.1: rspack 2.x 为 ESM-only（type:module，exports 无 require 入口），require() 加载报
// MODULE_NOT_FOUND；改动态 import，且目录 URL 不被 ESM 支持（ERR_UNSUPPORTED_DIR_IMPORT），
// 需按包 exports/main 解析到实际入口文件——CJS 旧版与 ESM 新版均兼容。
function resolveRspackEntry(coreDir) {
  const pkg = JSON.parse(
    fs.readFileSync(join(coreDir, "package.json"), "utf8"),
  );
  const dot = pkg.exports?.["."];
  let entry = null;
  if (typeof dot === "string") entry = dot;
  else if (dot && typeof dot === "object")
    entry = dot.default ?? dot.import ?? dot.require;
  if (!entry) entry = pkg.main ?? "dist/index.js";
  return join(coreDir, entry);
}
let rspackPkg;
const envDir = process.env.RSPACK_ENV;
if (envDir) {
  rspackPkg = await import(
    pathToFileURL(
      resolveRspackEntry(join(envDir, "node_modules", "@rspack", "core")),
    ).href
  );
} else {
  rspackPkg = await import("@rspack/core");
}
// 具名导出兜底：ESM 包直接取 rspack；CJS 包经 import() interop 后 default 内取
const rspack = rspackPkg.rspack ?? rspackPkg.default?.rspack;

// 入口：生命周期 index.js + 7 个工具文件（宿主按 manifest 路径加载，保持子目录结构；
// v0.13.0 lib 提取：tools/lib/*.js 经相对 import 被 rspack 内联进各入口 bundle）
const entryNames = [
  "index",
  "tools/dsh-run",
  "tools/dsh-update",
  "tools/dsh-install",
  "tools/dsh-approve",
  "tools/dsh-cancel",
  "tools/dsh-ops",
  "tools/dsh-search",
];
const entries = Object.fromEntries(
  entryNames.map((n) => [n, join(ROOT, `${n}.js`)]),
);

// 构建前收集各入口源码的 file:// URL —— 构建后产物里出现的这些字面量要替换回
// import.meta.url（rspack 会把 import.meta.url 静态化为源码绝对路径，分发到对方机器
// 后路径失效；替换后 bundle 保留运行时语义）。
const staticUrlToMeta = new Map(
  entryNames.map((n) => [pathToFileURL(join(ROOT, `${n}.js`)).href, n]),
);

const compiler = rspack({
  name: "dsh-hanako",
  mode: "production",
  target: "node",
  entry: entries,
  output: {
    path: join(ROOT, "dist"),
    filename: "[name].js",
    module: true,
    clean: true,
    // library type module：把入口具名导出真正 emit 为 ESM export（宿主动态 import 拿
    // name/description/parameters/execute 等；无 library 时 entry 导出不会出现在文件顶层）
    library: { type: "module" },
  },
  experiments: { outputModule: true },
  externalsPresets: { node: true },
  // usedExports: false + sideEffects: false —— 关闭导出级 tree-shaking：
  // 普通 ESM entry 的导出没有外部消费者，默认会被整体摇成空壳（工具文件顶层是
  // 纯声明+函数，无副作用）；插件本体全部保留（体积可忽略）。
  optimization: { minimize: true, usedExports: false, sideEffects: false },
  devtool: false,
  node: false,
});

await new Promise((resolvePromise, reject) => {
  compiler.run((err, stats) => {
    compiler.close(() => {});
    if (err) return reject(err);
    if (stats?.hasErrors())
      return reject(new Error(stats.toString({ errors: true })));
    console.log(
      stats?.toString({
        colors: true,
        chunks: false,
        modules: false,
        assets: true,
      }),
    );
    resolvePromise();
  });
});

// 构建后处理：静态化路径字面量 → import.meta.url（运行时语义）
function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js")) {
      let code = fs.readFileSync(p, "utf8");
      let changed = false;
      for (const [url, entryName] of staticUrlToMeta) {
        // 替换带引号的完整字面量（压缩产物里是 "file:///..." 或 'file:///...'）→ 无引号表达式
        for (const quoted of [`"${url}"`, `'${url}'`]) {
          if (code.includes(quoted)) {
            code = code.split(quoted).join("import.meta.url");
            changed = true;
            console.log(`patched import.meta.url -> ${entryName}`);
          }
        }
      }
      if (changed) fs.writeFileSync(p, code, "utf8");
    }
  }
}
walk(join(ROOT, "dist"));

console.log("build done ->", join(ROOT, "dist"));
