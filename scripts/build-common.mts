// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/build-common.mts — 构建共享工具（根级通用：src 半与 src-cordis 半构建复用）
// 布局原则：跨域共享构件放根 scripts/，领域专用随各自源码（src/ 与 src-cordis/）。
// 提供：collectSource（收集会被 rspack 内联的源码 file:// URL）、walk 工厂（静态化
// import.meta.url 回写）、extraTerser（rspack 产物二次压缩）、assertNoStaticFileUrl
// （产物不得残留构建机路径字面量）。
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { minifyJs, minifyHtml } from "./minify-assets.mts";

// 收集目录下全部 .js 的 file:// URL（rspack 会把 import.meta.url 静态化为构建机源码
// 绝对路径；构建后产物出现这些字面量一律替换回 import.meta.url——分发路径失效根因）。
// 产物侧（rewriter/terser/assert）同时覆盖 .js 与 .mjs：受管 runtime 入口 dist/runtime/
// dsh-host.mjs 也是 rspack ESM 产物，同样存在 import.meta.url 静态化问题（step 2）。
export function collectSource(urlRoot) {
  const map = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      // 收会被打包的源码：.js 与 .ts/.tsx（改造中的两态共存）。构建描述与脚本是 .mjs，
      // 不进 bundle、也不参与 URL 回写与静态 URL 断言，故不收。
      else if (/\.(js|ts|tsx)$/.test(p)) map.set(pathToFileURL(p).href, p);
    }
  };
  walk(urlRoot);
  return map;
}

// 静态化路径字面量 → import.meta.url 的 walk 工厂（产物里 "file://..." 引号两种形态都换）
export function makeUrlRewriter(staticUrlToMeta) {
  return function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".js") || p.endsWith(".mjs")) {
        let code = readFileSync(p, "utf8");
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
        if (changed) writeFileSync(p, code, "utf8");
      }
    }
  };
}

// 产物二次 terser：rspack（swc）已压一轮，这里压字符串资产（HTML/CSS/JS 内联）；须在
// URL 回写（makeUrlRewriter）之后——先压会改写引号导致回写锚点失配。跳过
// node_modules（npm 自带产物）与 dsh-plugin（归 pack 静态压缩步）。
export async function extraMinify(root) {
  const files: string[] = [];
  const collect = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name === "node_modules" || name === "dsh-plugin") continue;
      if (statSync(p).isDirectory()) collect(p);
      else if (/\.(js|mjs|html)$/.test(name)) files.push(p);
    }
  };
  collect(root);
  console.log("[build] extra minify (" + files.length + " files)...");
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    const before = Buffer.byteLength(code, "utf8");
    let out;
    try {
      // .html 是静态壳页（React 不参与，它们是原样拷进 dist 的）：只去注释与收空白。
      out = file.endsWith(".html") ? await minifyHtml(code) : await minifyJs(code);
    } catch (err) {
      throw new Error("extra minify 失败（" + file + "）：" + err.message);
    }
    writeFileSync(file, out, "utf8");
    const after = Buffer.byteLength(out, "utf8");
    console.log("[build]   " + file.slice(root.length + 1) + ": " + before + " -> " + after + " bytes (" +
      ((1 - after / before) * 100).toFixed(1) + "% 缩减)");
  }
}

// 产物强制校验：不得残留带引号的 file:// 字面量（构建机路径泄漏即失败，CI 兜底）
export function assertNoStaticFileUrl(root) {
  const offenders: string[] = [];
  const scan = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) scan(p);
      else if (p.endsWith(".js") || p.endsWith(".mjs")) {
        const code = readFileSync(p, "utf8");
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
