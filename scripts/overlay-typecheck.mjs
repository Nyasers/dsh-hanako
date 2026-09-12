// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/overlay-typecheck.mjs — 覆盖层类型检查（只查我们自己写进上游包里的那些文件）
//
// 为什么需要：我们的构建是**转译**（bundle 不做类型检查），所以覆盖层里的自由变量、
// 拼错的成员这类错能一路过构建、过单测，直到真机才炸——`role is not defined` 就是这么
// 漏出去的（清注释时连带删了一行代码，TS 只转译，构建和测试都没看见）。
//
// 为什么在**暂存树**里查：覆盖层是"盖进别人包里"才成立的（相对 import 指向上游文件），
// 在仓库树上单独查会一片解析失败。integrations.mjs 摊好上游源、盖好覆盖之后调本模块，
// 用一份临时 tsconfig 在整个 src/ 上查，**只报我们自己那几个文件的诊断**：上游代码在
// 另一套 tsconfig 下不保证干净，混进来就是噪音；我们自己的文件必须干净。
//
// 严格度：strict 但不要求 implicit-any（本仓的覆盖层多为改写上游 JS 风格代码，先把
// "未定义的名字 / 不存在的成员 / 签名不符"这类真错拦住）。strict 全量迁移另算一刀。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TSC_REL = ["node_modules", "typescript", "bin", "tsc"];
const TS_FILE = /\.(ts|tsx|mts|cts)$/i;

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
        let name = "";
        try {
          name = String(JSON.parse(readFileSync(pj, "utf8")).name || "");
        } catch {
          continue;
        }
        if (!name) continue;
        const installed = join(hiddenDir, name);
        const fallback = existsSync(installed) ? [installed] : [];
        const entry = join(dir, "src", "index.ts");
        if (existsSync(entry)) out[name] = [entry, ...fallback];
        const clientEntry = join(dir, "src", "client", "index.ts");
        if (existsSync(clientEntry)) out[`${name}/client`] = [clientEntry, ...fallback];
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
 * 失败清单：只有这些码才算“我们自己的文件自相矛盾”，判失败。
 *
 * 为何用白名单而不是黑名单：跨包契约（插槽 props、JSX 属性类型）依赖类型来源，而本仓里
 * “已装的 lib/types”与“镜像源”对同一个版本号也不完全对齐（如 usePanelInfo / root 插槽
 * 各在一侧有），这类差异会把我们的文件误伤。它们不是咬过我们的那一类：我们真错过的是
 * “未定义的名字”（清注释连带删了一行代码），那类典型码如下——都是不依赖外部类型就能判定的。
 * 其余码（TS2339/TS2344/TS2322…）照常计数打进日志，将来全量 TS 化后再纳入失败。
 */
const FAIL_CODES = new Set([
  "TS2304", // Cannot find name —— 自由变量（role 那次就是它）
  "TS2552", // Cannot find name（带拼写建议）
  "TS2305", // Module has no exported member —— 导入写错名
  "TS2551", // Property does not exist（带拼写建议）
  "TS2554", // Expected N arguments, but got M
  "TS1005", // ';' expected 之类的语法错
  "TS1109", // Expression expected
  "TS1128", // Declaration or statement expected
  "TS1160", // Unterminated template literal
]);

/**
 * 把 tsc 输出分成四份（纯函数）：
 *   · `mine`     = 落在我们覆盖层文件上、且属于 FAIL_CODES 的诊断 → 判失败；
 *   · `other`    = 我们文件上的其它诊断（类型契约/环境）→ 只计数，但码与条数进日志；
 *   · `upstream` = 其它源码文件上的诊断（暂存树的上游源、镜像里被解析到的包源）→ 只计数；
 *   · `config`   = 不是源码文件的诊断（tsconfig 出错、选项被移除）→ 判失败：检查器没真跑。
 * tsc 打印的是相对 cwd（= 暂存树根）的路径。
 */
export function parseOverlayDiagnostics(stdout, ours) {
  const wanted = new Set((Array.isArray(ours) ? ours : []).map((p) => String(p).replace(/\\/g, "/")));
  const mine = [];
  const other = [];
  const upstream = [];
  const config = [];
  for (const raw of String(stdout || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.*?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/);
    if (!m) continue;
    const rel = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
    const entry = {
      file: rel,
      line: Number(m[2]),
      col: Number(m[3]),
      severity: m[4],
      code: m[5],
      message: m[6],
    };
    if (wanted.has(rel)) {
      (FAIL_CODES.has(entry.code) ? mine : other).push(entry);
    } else if (TS_FILE.test(rel)) {
      upstream.push(entry);
    } else {
      config.push(entry);
    }
  }
  return { mine, other, upstream, config };
}

/**
 * 跑一次覆盖层类型检查。有我们的诊断就抛（fail-closed：宁可不产出补丁包，也不出一个
 * 自己都讲不通的覆盖层）。返回 { checked, upstream } 供日志用。
 */
export function typecheckOverlay({ short, stage, files, repoRoot, mirrorDir, log = () => {} }) {
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
        + config.map((d) => `  - ${d.file}:${d.line}:${d.col} ${d.code} ${d.message}`).join("\n"),
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
        + mine.map((d) => `  - ${d.file}:${d.line}:${d.col} ${d.code} ${d.message}`).join("\n")
        + "\n（这些文件是我们写进上游包里的；构建只转译不检查，所以在这一步拦。）",
    );
  }
  log(`[integrations] ${short}: 覆盖层类型检查通过（${ours.length} 个文件）`);
  return { checked: ours.length, upstream: upstream.length, other: other.length };
}
