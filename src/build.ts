// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/build.ts — 主 bundle（src 域）构建入口（App 交付形态）
// 布局：领域专用脚本随各自源码——rspack.config.mts（本目录，配置源）与本入口放 src/，
// 共享工具（collect/walk/terser/assert + minify/template loader）在 scripts/（根级）。
// 产物（dist/ = App 安装目录形态；宿主读 dist 根 manifest.json + entry）：
//   manifest.json       App v2 manifest（entry "index.js" / icon "assets/icon.png"）
//   index.js            rspack 单 bundle（入口具名导出 apply + default.apply）
//   assets/icon.png     App 身份图标（manifest.icon 指向的包内真实图片）
//   skills/             App skills（dshana / dsh-session，SKILL.md 随包分发）
//   runtime/dsh-host.mjs  受管 Node runtime 入口（见 src/runtime/；
//                         cordis/ 产物由 build:cordis 另产出 dist/cordis，随包分发）
//   ui/                   App ui/ 静态树（migration step 4b/5；cards route 指向壳页，
//                         见 src/ui/——相对资源路径，宿主以 /api/apps/<id>/ui<route> 服务）
// v1 遗留变化：不再生成 dist/routes/index.js 壳（v1 宿主按 routes/ 目录扫描具名导出
// pluginRoutes；v2 路由走 ctx.routes.register 单 route app，宿主不扫 dist 目录）。
// 用法：node src/build.ts [RSPACK_ENV=<构建环境目录>]
// 注意：本文件是构建入口，不在 bundle 里（主入口由 rspack.config.mts 指定为 src/index.ts）；
// 但 collectSource 会把 src/ 下的 .js/.ts 一并收作 URL 回写与静态 URL 断言的扫描面。
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename, dirname, join } from "node:path";

import fs from "fs-extra";
import config from "#/rspack.config.mts"; // 同目录（src 域配置随源码）
import runtimeConfig from "#/runtime/rspack.config.mts"; // runtime/ 域（受管 runtime 入口）
import uiConfig from "#/ui/rspack.config.mts"; // ui/ 域（壳页脚本 bundle；浏览器 SDK 构建期内联）
import {
  collectSource,
  makeUrlRewriter,
  extraMinify,
  assertNoStaticFileUrl,
} from "../scripts/build-common.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // src/ → 仓库根
const DIST_DIR = join(ROOT, "dist");

// rspack 解析：RSPACK_ENV 指向构建环境（推荐），否则本地 node_modules
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

// src 域源码收集（供 URL 回写）
const rewriter = makeUrlRewriter(collectSource(join(ROOT, "src")));

// 单 compiler 编译封装（rspack 一次 run/close；stats 报错即 reject）
async function compile(cfg, label) {
  const compiler = rspack(cfg);
  await new Promise((resolvePromise, reject) => {
    compiler.run((err, stats) => {
      compiler.close(() => { });
      if (err) return reject(err);
      if (stats?.hasErrors()) return reject(new Error(label + "：" + stats.toString({ errors: true })));
      console.log(stats?.toString({ colors: true, chunks: false, modules: false, assets: true }));
      resolvePromise();
    });
  });
}

// 主 bundle 编译（rspack output.clean 清空 dist 后写入 dist/index.js）
await compile(config, "build:src 主 bundle");

// 受管 runtime 入口编译（dist/runtime/dsh-host.mjs；clean:false 只追加，见 config 头注释）
await compile(runtimeConfig, "build:src runtime bundle");
console.log("runtime bundle -> dist/runtime/dsh-host.mjs（受管 runtime 入口，migration step 2）");

// 1) 静态化路径字面量回写（dist 主区）
rewriter(DIST_DIR);

// 2) App 交付目录组装（dist 根 = App 安装目录；manifest/skills/icon 与入口 index.js 同层）
fs.copySync(join(ROOT, "src", "manifest.json"), join(DIST_DIR, "manifest.json"));
fs.copySync(join(ROOT, "src", "skills"), join(DIST_DIR, "skills"));
// App 图标：src/assets/icon.png 为唯一规范源（manifest.icon "assets/icon.png"）；
// 依赖部署（自包含打包）：DSH 依赖由 pack.mts 物化进安装目录 node_modules，
// dist = App 安装目录形态（含 cordis 产物）；运行时不再安装，dist 保持轻量壳。
const iconSrc = join(ROOT, "src", "assets", "icon.png");
if (!fs.pathExistsSync(iconSrc))
  throw new Error("App 图标缺失（src/assets/icon.png）：manifest.icon 指向 assets/icon.png，需真实可解码图片");
fs.copySync(iconSrc, join(DIST_DIR, "assets", "icon.png"));
console.log("manifest.json + skills/ + assets/icon.png -> dist/（App v2 安装目录形态）");

// App ui/ 静态树（cards contributes 的 route 指向 ui 内相对文件；缺失 = 卡片 404 + manifest
// 校验失败——fail-fast）。相对资源纪律：壳页内资源一律相对路径，无根绝对 URL。
const uiSrc = join(ROOT, "src", "ui");
if (!fs.pathExistsSync(uiSrc)) {
  throw new Error("App ui/ 静态树缺失（src/ui）：contributes.cards 的 route 指向 ui 内页面（见 manifest.json）");
}
// 静态面（*.html 等非脚本资源）直接拷贝；页面脚本是构建源，由 ui bundle 收进
// dist/ui/app-shell.js 与 dist/ui/settings.js（浏览器 SDK 一并内联），不另放源码副本。
// 静态面拷贝用白名单：只放行已知的静态类型，其余一律不拷。
// 为何不用黑名单逐个数脚本扩展名：改名那天 .mts 就是没被列上的那个，于是 rspack.config.mts
// 直接漏进了产物（dist/ui/）。白名单没有这种缺口，以后多出什么类型都不会漏出源码。
const STATIC_EXT = [".html", ".css", ".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".json", ".map"];
fs.copySync(uiSrc, join(DIST_DIR, "ui"), {
  // 目录要放行（filter 对目录也会问一次，只看扩展名会把跟目录本身拒掉，整棵拷贝就成了空操作）
  filter: (src) => fs.statSync(src).isDirectory() || STATIC_EXT.some((ext) => basename(src).endsWith(ext)),
});
console.log("ui/ 静态面 -> dist/ui（白名单 " + STATIC_EXT.join(" ") + "；脚本由 ui bundle 产出）");

// ui bundle 编译（dist/ui/app-shell.js；clean:false 只写该文件，静态页已被 copy）
await compile(uiConfig, "build:src ui bundle");
console.log("ui bundle -> dist/ui/app-shell.js（浏览器 SDK 构建期内联）");

// 3) 二次压缩（主区：JS + 静态壳页 HTML）+ 静态 URL 断言
await extraMinify(DIST_DIR);
assertNoStaticFileUrl(DIST_DIR);
console.log("build:src done ->", DIST_DIR);
