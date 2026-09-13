// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/overlay-typecheck.mts — 覆盖层类型检查（只查我们自己写进上游包里的那些文件）
//
// 为什么需要：我们的构建是**转译**（bundle 不做类型检查），所以覆盖层里的自由变量、
// 拼错的成员这类错能一路过构建、过单测，直到真机才炸——`role is not defined` 就是这么
// 漏出去的（清注释时连带删了一行代码，TS 只转译，构建和测试都没看见）。
//
// 为什么在**暂存树**里查：覆盖层是"盖进别人包里"才成立的（相对 import 指向上游文件），
// 在仓库树上单独查会一片解析失败。integrations.mts 摊好上游源、盖好覆盖之后调本模块，
// 用一份临时 tsconfig 在整个 src/ 上查，**只报我们自己那几个文件的诊断**：上游代码在
// 另一套 tsconfig 下不保证干净，混进来就是噪音；我们自己的文件必须干净。
//
// 严格度：strict 但不要求 implicit-any（本仓的覆盖层多为改写上游 JS 风格代码，先把
// "未定义的名字 / 不存在的成员 / 签名不符"这类真错拦住）。strict 全量迁移另算一刀。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TS_FILE, classifyDiagnostics, formatDiagnostics, parseTsDiagnostics } from "./ts-diagnostics.mts";

const TSC_REL = ["node_modules", "typescript", "bin", "tsc"];

/**
 * 从源码镜像生出「DSH 包名 → 源入口」表：**只补本仓 .pnpm 里没装的那些包**。
 *
 * 为何需要：覆盖层会用到 DSH 自己那批包（且它们 `declare module` 增强 cordis 的 `Context`）。
 * 这些包对本仓构建而言是运行时外部、不一定装，于是不映射就解析不到声明；而**混用**
 * （一部分取本仓已装的 lib/types/*.d.ts、一部分取镜像源）会把插槽契约聚合成两套、
 * 反过来报我们的文件“属性不存在”。所以口径定死：**一律以上游源为准**（我们改的就是那份
 * 源），也即镜像优先，本仓产物只当兵底。
 */
const mirrorCache = new Map();
export function mirrorPathEntries(mirrorDir, hiddenDir) {
  const key = `${mirrorDir}|${hiddenDir}`;
  const hit = mirrorCache.get(key);
  if (hit) return hit;
  const out = {};
  const groupsDir = join(mirrorDir, "packages");
  if (existsSync(groupsDir)) {
    for (const group of readdirSync(groupsDir, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      const gDir = join(groupsDir, group.name);
      for (const pkg of readdirSync(gDir, { withFileTypes: true })) {
        if (!pkg.isDirectory()) continue;
        const dir = join(gDir, pkg.name);
        const pj = join(dir, "package.json");
        if (!existsSync(pj)) continue;
        let meta: Record<string, any> | null = null;
        try {
          meta = JSON.parse(readFileSync(pj, "utf8"));
        } catch {
          continue;
        }
        const name = String((meta && meta.name) || "");
        if (!name) continue;
        const installed = join(hiddenDir, name);
        const fallback = existsSync(installed) ? [installed] : [];
        const entry = join(dir, "src", "index.ts");
        if (existsSync(entry)) out[name] = [entry, ...fallback];
        const clientEntry = join(dir, "src", "client", "index.ts");
        if (existsSync(clientEntry)) out[`${name}/client`] = [clientEntry, ...fallback];
        // 子路径导出（pkg/types、pkg/remote、pkg/surface…）：按 package.json exports 的
        // types 字段反推源文件（lib/types/<x>.d.ts → src/<x>.ts）。缺这条时这类 import
        // 在暂存树里解析不到（TS2307），覆盖层文件与上游 contract 会连片报红。
        const exportsMap = meta && meta.exports && typeof meta.exports === "object" ? meta.exports : {};
        for (const [subKey, val] of Object.entries(exportsMap)) {
          if (subKey === "." || subKey === "./package.json" || subKey.startsWith("./src/")) continue;
          const sub = subKey.replace(/^\.\//, "");
          if (!sub || sub.includes("*")) continue;
          const v: any = val;
          const spec = typeof v === "string" ? v : String((v && (v.types || v.default)) || "");
          const m = spec.match(/lib\/types\/(.+)\.d\.ts$/) || spec.match(/lib\/(.+)\.js$/);
          if (!m) continue;
          const srcFile = join(dir, "src", m[1] + ".ts");
          if (existsSync(srcFile) && out[`${name}/${sub}`] === undefined) {
            out[`${name}/${sub}`] = [srcFile, ...fallback];
          }
        }
      }
    }
  }
  mirrorCache.set(key, out);
  return out;
}

/** 覆盖层里需要类型检查的文件（暂存树相对路径）。 */
export function overlayTsFiles(files) {
  return (Array.isArray(files) ? files : [])
    .map((f) => String((f && f.path !== undefined ? f.path : f) ?? ""))
    .filter((p) => p && TS_FILE.test(p));
}

/** 临时 tsconfig（写进暂存树；noEmit + bundler 解析 + react-jsx）。 */
export function overlayTsconfig(repoRoot, mirrorDir) {
  return {
    compilerOptions: {
      noEmit: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      // 与域 tsconfig 同口径：上游 / 覆盖层代码普遍用 node 全局（process、node:*、
      // NodeJS 命名空间），不显式带上就一片 TS2591（假阳性）。typeRoots 指向本仓
      // .pnpm 的 @types（node 就在那里），不写 types 时 TS 不再自动全量加载。
      types: ["node"],
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
      // 上游代码本就用 './x.ts' 结尾的 import（DSH 自己的 tsconfig 开着这个）；
      // 不开的话会把这种写法误报成我们的错。noEmit 下合法。
      allowImportingTsExtensions: true,
      strict: true,
      noImplicitAny: false,
      noUnusedLocals: false,
      noUnusedParameters: false,
      // 暂存树在 _tmp/ 下，解析会一路走到仓库根 node_modules；pnpm 只在那里放了直接
      // 依赖的软链，react / @types/node / DSH 自己那批包都住在 .pnpm/node_modules。
      // 用 paths 通配兜住它们，避免把“本仓没装这个包”误报成我们的文件出错。
      // （不用 baseUrl：TS 7 已移除该选项，会直接报 TS5102。）
      ...(repoRoot
        ? {
            paths: {
              // 本仓装的包（含 react / @types/node）都在 pnpm 的隐藏目录里。
              "*": [join(repoRoot, "node_modules", ".pnpm", "node_modules", "*")],
              // 再把镜像里那些“本仓没装”的 DSH 包补上（已装的不接管）。
              ...(mirrorDir
                ? mirrorPathEntries(mirrorDir, join(repoRoot, "node_modules", ".pnpm", "node_modules"))
                : {}),
            },
            typeRoots: [join(repoRoot, "node_modules", ".pnpm", "node_modules", "@types")],
          }
        : {}),
    },
    include: ["src/**/*.ts", "src/**/*.tsx"],
  };
}

/**
 * 把 tsc 输出按文件归成四份（纯函数；分类口径在 scripts/ts-diagnostics.mts，与逐域检查共用）：
 * mine=我们的文件+失败码 / other=我们的文件+其它码 / upstream=其它源码 / config=非源码（检查器没跑）。
 */
export function parseOverlayDiagnostics(stdout, ours) {
  const wanted = new Set((Array.isArray(ours) ? ours : []).map((p) => String(p).replace(/\\/g, "/")));
  return classifyDiagnostics(parseTsDiagnostics(stdout), (file) => wanted.has(file));
}

/**
 * 跑一次覆盖层类型检查。有我们的诊断就抛（fail-closed：宁可不产出补丁包，也不出一个
 * 自己都讲不通的覆盖层）。返回 { checked, upstream } 供日志用。
 */
export function typecheckOverlay({ short, stage, files, repoRoot, mirrorDir, log = (_msg) => {} }) {
  const ours = overlayTsFiles(files);
  if (ours.length === 0) return { checked: 0, upstream: 0 };
  const cfgPath = join(stage, "tsconfig.overlay.json");
  writeFileSync(cfgPath, JSON.stringify(overlayTsconfig(repoRoot, mirrorDir), null, 2) + "\n", "utf8");
  const tscPath = join(repoRoot, ...TSC_REL);
  if (!existsSync(tscPath)) {
    throw new Error(`覆盖层类型检查无法运行：找不到 TypeScript（devDependency）${tscPath}`);
  }
  const r = spawnSync(process.execPath, [tscPath, "-p", cfgPath, "--pretty", "false"], {
    cwd: stage,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) throw new Error(`覆盖层类型检查无法运行（${short}）：${r.error.message}`);
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const { mine, other, upstream, config } = parseOverlayDiagnostics(out, ours);
  // 配置级错误 = 检查器没真跑（选项被移除、tsconfig 写错…）：绝不当通过。
  if (config.length) {
    throw new Error(
      `覆盖层类型检查未能运行（${short}）：tsconfig/编译器报错 ${config.length} 条\n`
        + formatDiagnostics(config),
    );
  }
  // 非零退出但一条诊断都没解析出来：同样说明检查没真跑（输出格式变了之类），不静默通过。
  if (r.status !== 0 && mine.length === 0 && other.length === 0 && upstream.length === 0) {
    throw new Error(`覆盖层类型检查未能运行（${short}）：tsc 退出 ${r.status} 但无诊断可解析\n${out.slice(0, 800)}`);
  }
  if (upstream.length) {
    log(`[integrations] ${short}: 类型检查忽略上游 ${upstream.length} 条诊断（不属覆盖层）`);
  }
  if (other.length) {
    log(`[integrations] ${short}: 覆盖层另有 ${other.length} 条非失败诊断（计入不拦：${[...new Set(other.map((d) => d.code))].sort().join(", ")}）`);
  }
  if (mine.length) {
    throw new Error(
      `覆盖层类型检查未通过（${short}，${mine.length} 条）：\n`
        + formatDiagnostics(mine)
        + "\n（这些文件是我们写进上游包里的；构建只转译不检查，所以在这一步拦。）",
    );
  }
  log(`[integrations] ${short}: 覆盖层类型检查通过（${ours.length} 个文件）`);
  return { checked: ours.length, upstream: upstream.length, other: other.length };
}
