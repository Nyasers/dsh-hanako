// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/pack.mts — dshana 自包含打包（适配单 bundle 收敛架构；构建脚本不随源码编译）
// 交付物 = 代码 bundle（dist/）+ cordis 插件 + ui/ 静态树 + **物化后的生产依赖树**
// （含 win32/darwin/linux × x64/arm64 预编译资产），安装即用、无需 npm install。
// 依赖物化形态对齐样例 hana-dsh：hoisted 布局（顶层真实目录、无软链接——软链进 zip 跨机
// 解压即断）。物化在 _tmp/pkg-root/ 隔离进行，不触碰仓库 node_modules。
// 流程：复制交付清单（prepack 钩子已先行 build）→ 物化生产依赖 → 断言多平台资产 → zip → SHA256。
// 用法：pnpm run pack --target <名字>（prepack 自动前置 build；单独 node scripts/pack.mts 要求 dist/ 已构建）
// 产出：releases/dshana-v<version>[-<target>].zip + .sha256。**zip 根 = 包根**：manifest.json、
//   index.js、node_modules/、ui/ 等全部在 zip 根级，不得套一层目录（宿主安装时在包根读 manifest.json）。
// 两个临时目录的分工（都在 _tmp/ 下，起手清残留、用完即清、收尾由 postpack 钩子清）：
//   · _tmp/pkg-root/<target>：依赖物化**工位**。要跑一次真 install，就得有个像独立项目的目录
//     ——package.json + pnpm-lock.yaml + 为该目标生成的 pnpm-workspace.yaml（supportedArchitectures）
//     三件套放进去跑 pnpm install --prod。隔离在 _tmp 下，仓库自身的 node_modules 与锁文件不被污染。
//   · _tmp/pkg：交付**组装台**。只放要进包的东西（dist/ + 物化依赖树 + cordis + ui + manifest），
//     不带 pnpm 的中间物（lockfile、workspace yaml、.modules.yaml 这些是构建输入，不是交付物）。
//     把「工位」与「组装台」分开，就是不让构建输入混进安装包；组装出包后立即删。
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { ZipArchive } from "archiver";

import fs from "fs-extra";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 版本单一事实源：package.json（唯一来源，不支持命令行传版本——显式传版本容易与
// manifest 不同步（历史教训）；版本同步走 pnpm version 发版流程，scripts/version-hook.mts 收口）
const version = fs.readJsonSync(join(ROOT, "package.json")).version;
if (!version) throw new Error("package.json version 缺失");

// 防回归：版本一致性强制校验（历史曾手改只 bump package.json，manifest.json version 停在
// 旧值，发布包内版本与 tag 不一致）。打包版本必须同时等于 manifest.json 的 version。
const manifestVersion = fs.readJsonSync(join(ROOT, "src", "manifest.json")).version;
if (version !== manifestVersion)
  throw new Error(
    `版本不一致：package.json ${version} ≠ manifest.json ${manifestVersion}（manifest 未同步，跑 node scripts/syncver.mts 同步后再打包）`,
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
  // 注：pnpm-workspace.yaml / pnpm-lock.yaml 不随包——安装侧不执行任何 pnpm install
  // （依赖已物化进包），两份文件在本流程里没有消费方
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
  // 完整性：必需 7 包（roster bundle dshana + 6 子插件）全部存在且
  // package.json 版本一致——缺失/部分产物（含 count=0）一律拒包，防 build 失败后残留部分
  // dist 被误打包。（roster 就是 bundle dshana + 6 子插件：connection 由官方 dsh-web-app
  // bundle 提供，index 处理归官方 frontend-static，设置页由宿主面承担。）
  const required = [
    "dshana",
    "clipboard", "provider", "theme",
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
        `版本不一致：cordis 包 ${join("cordis", name, "package.json")} version ${j.version} ≠ package.json ${version}（跑 node scripts/syncver.mts 同步后再打包）`,
      );
    }
    count += 1;
  }
  console.log(`[pack] cordis 包版本一致（${count} 个 = ${version}）`);
}
assertCordisDistVersions(distDir);

// 1.6) App ui/ 静态树断言（cards route 资源面；相对资源契约）：缺失 = 卡片
//   404 + 宿主 manifest 校验失败，fail-closed 拒包。
function assertUiTree(outDir) {
  const uiDir = join(outDir, "ui");
  if (!fs.pathExistsSync(uiDir)) {
    throw new Error("App ui/ 静态树缺失（dist/ui 不存在）：src/ui 未随 build 拷贝——先跑 pnpm run build 再打包");
  }
  for (const rel of ["main.html", "sidebar.html", "app-shell.js"]) {
    if (!fs.pathExistsSync(join(uiDir, rel))) {
      throw new Error("App ui/ 缺 cards route 资源：" + rel + "（src/ui/" + rel + " 缺失或构建未跑）");
    }
  }
  console.log("[pack] ui/ 静态树完整（main/sidebar 壳页 + app-shell.js bundle）");
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
//   用法：node scripts/pack.mts [--target universal|darwin-arm64|darwin-x64|linux-x64|win32-x64|
//   linux-arm64|win32-arm64]；默认 universal（单一目标，不接 `all`）。多目标 = 多次调用
//   （包别名 `pack:<target>`）或 CI 的并发矩阵。
//   别名约定：所有 `pack:<target>` 都必须**委派给 pack**（`pnpm run pack --target=…`），
//   不能直接写 `node scripts/pack.mts --target=…`：pnpm 的 pre/post 钩子是按脚本名精确匹配的，
//   `pack:linux-x64` 只会去找 `prepack:linux-x64` / `postpack:linux-x64`（实测确认），直接调脚本
//   会同时跳过 prepack（build）与 postpack（清临时目录）。
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
  return "# pack.mts 生成（每次打包重建，勿手改）\nnodeLinker: hoisted\n\n" + body;
}

/** 集成覆盖的声明（每个 integration.json 的 package 字段与 overlay 数）。 */
function integrationDecls(integrationsDir) {
  if (!fs.pathExistsSync(integrationsDir)) {
    throw new Error(`集成目录不存在：${integrationsDir}（预期 src-integrations/；拒绍产出未打补丁的包）`);
  }
  const out: any[] = [];
  for (const e of fs.readdirSync(integrationsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(integrationsDir, e.name, "integration.json");
    if (!fs.pathExistsSync(p)) continue;
    const decl = JSON.parse(fs.readFileSync(p, "utf8"));
    out.push({
      name: e.name,
      package: decl.package,
      files: Array.isArray(decl.files) ? decl.files.length : 0,
    });
  }
  if (out.length === 0) {
    throw new Error(`没有有效的集成声明（${integrationsDir}）：拒绍产出未打补丁的包`);
  }
  return out;
}

/**
 * 物化完成后先确认集成目标包齐备，再进组装。物化是外部进程（pnpm），它退出与文件完全落盘
 * 之间有时差；没有这道闸时，残树会一路跑到覆盖阶段才报“物化树里没有 px”，看起来像是集成层的问题。
 * 有界等待（≤30s）只是给那个时差留窗口，等了还是缺就是真的缺，当场失败并点名。
 */
function assertIntegrationTargets(modules, integrationsDir) {
  const targets = integrationDecls(integrationsDir);
  const missingOf = () => targets.filter((t) => !fs.pathExistsSync(join(modules, t.package, "package.json")));
  let missing = missingOf();
  if (missing.length > 0) {
    console.log(`[pack] 等物化落盘（缺 ${missing.length} 个集成目标包，最多等 30s）…`);
    const deadline = Date.now() + 30000;
    while (missing.length > 0 && Date.now() < deadline) {
      sleepSync(1000);
      missing = missingOf();
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `物化树缺少集成目标包（${missing.length}/${targets.length} 个，拒绝打包）：\n  - `
      + missing.map((t) => t.package).join("\n  - "),
    );
  }
  return targets.length;
}

/** 同步睡一会（打包脚本内部的顺序流程，不用事件循环）。 */
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
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
  console.log(`[pack] ${spec.name} 物化完成（平台资产 ${spec.assets.length} 项齐备，集成目标 ${assertIntegrationTargets(modules, join(ROOT, "src-integrations"))} 项）`);
  const pruned = pruneNodeModules(modules, spec);
  if (pruned.files > 0) {
    console.log(
      `[pack] ${spec.name} 源码层精简：删 ${pruned.files} 项（释放未压缩 ${(pruned.bytes / 1e6).toFixed(1)} MB）`,
    );
  }
  return modules;
}

/**
 * 源码层精简：只删两类“没有运行期入口”的东西，其余一律留着。
 *   1. 非本平台的预编译产物（按目标平台筛：带平台名的目录 + prebuilds/bin/third_party 下的平台子目录）；
 *      这是体积的大头，也是唯一需要“选择”的一步。
 *   2. 四类扩展名：`.pdb`（调试符号）、`.map`（源码映射）、`.d.ts/.d.mts/.d.cts`（类型声明）、
 *      `.md/.markdown`（纯文档）——JS 不会 require 它们。
 *
 * 刻意**不**按目录名删东西（`docs`/`tests`/`examples`/`fixtures` 之类）：目录名不等于内容，
 * 包在那种目录里放运行期代码并不稀奇，而按名字猜的代价是装包后起不来。
 *
 * 返回 { files, bytes }；失败一律不阻断打包（删不掉就留着）。
 */
function pruneNodeModules(modules, spec) {
  const plat = new Set();
  for (const os of spec.os) for (const cpu of spec.cpu) plat.add(`${os}-${cpu}`);
  const normalizePlat = (name) => name.replace(/^win10-/, "win32-");
  const out = { files: 0, bytes: 0 };
  const PRUNABLE_FILE = /(\.pdb|\.map|\.d\.ts|\.d\.mts|\.d\.cts|\.md|\.markdown)$/i;
  const PLATFORM_DIR = /^(win32|win10|darwin|linux)-[a-z0-9]+$/i;
  const PRECOMPILED_DIR = /^(prebuilds|bin|third_party)$/;

  const listDir = (dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  };

  const dropTree = (p) => {
    const size = dirSize(p);
    try {
      fs.removeSync(p);
      out.files += 1;
      out.bytes += size;
    } catch {
      /* 删不掉就留着 */
    }
  };

  const walk = (dir) => {
    for (const e of listDir(dir)) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (PLATFORM_DIR.test(e.name) && !plat.has(normalizePlat(e.name))) {
          dropTree(p);
          continue;
        }
        if (PRECOMPILED_DIR.test(e.name)) {
          for (const sub of listDir(p)) {
            if (sub.isDirectory() && PLATFORM_DIR.test(sub.name) && !plat.has(normalizePlat(sub.name))) {
              dropTree(join(p, sub.name));
            }
          }
          walk(p);
          continue;
        }
        walk(p);
        continue;
      }
      if (!PRUNABLE_FILE.test(e.name)) continue;
      try {
        const st = fs.statSync(p);
        fs.removeSync(p);
        out.files += 1;
        out.bytes += st.size;
      } catch {
        /* 删不掉就留着 */
      }
    }
  };
  walk(modules);
  return out;
}

/** 目录内所有文件的字节合计（用于统计被删目录的体量）。 */
function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else {
      try {
        total += fs.statSync(p).size;
      } catch {
        /* 忽略 */
      }
    }
  }
  return total;
}

// 目标选择：`--target <名字>` / `--target=<名字>`（必须显式给，无默认）。
// 用 node:util 的 parseArgs 结构化解析（strict + 禁位置参数）：未知选项、缺值、多余位置参数
// 由它直接报错，不再手写字符串扫描——上一版手扫以 startsWith("--target") 判「认识的参数」，
// 把 `--targets=x` 漏成了合法值，静默回落跑了一整次通用包。
// 未指定 / 不支持的目标 / 解析失败三种情况一律 failUsage：打印支持目标列表并退出码 2。
// 多目标由 CI 并行矩阵各自跑一次，或本地逐个跑 `pnpm run pack:<target>`；不支持 `all`。
function supportedTargetNames() {
  return ["universal", ...HOST_TARGETS.map((t) => t.name), ...EXTRA_TARGETS.map((t) => t.name)];
}
function failUsage(detail) {
  console.error(`[pack] ${detail}`);
  console.error("[pack] 支持的目标：");
  for (const n of supportedTargetNames()) {
    const s = targetSpec(n);
    console.error(`  ${n.padEnd(14)} os=[${s.os.join(",")}] cpu=[${s.cpu.join(",")}]${s.libc ? " libc=[" + s.libc.join(",") + "]" : ""}`);
  }
  console.error("[pack] 用法：node scripts/pack.mts --target <名字>（或 pnpm run pack --target=<名字>）");
  process.exit(2);
}
const spec = (() => {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: { target: { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
  } catch (e) {
    failUsage(`参数解析失败：${(e && e.message) || e}`);
  }
  const raw = parsed.values.target;
  if (raw === undefined) failUsage("未指定 --target");
  const name = String(raw).trim();
  const found = targetSpec(name);
  if (!found) failUsage(`未知打包目标：${name}`);
  return found;
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
  const files: string[] = [];
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

// 3+4) 组装 → zip → SHA256（单目标；发布产物归档 releases/）
//    archiver 纯 Node 跨平台 zip（对齐 hana-remote-dev）：不用 tar -a -cf——
//    GNU tar（Linux）不认 .zip 后缀会静默产出 tar 伪 zip
const relDir = join(ROOT, "releases");
fs.ensureDirSync(relDir);
// 临时目录纪律（曾因多目标连跑堆积 2.2 GB 把宿主压崩）：
//   · 起手清残留（上次运行/中途崩溃留下的）；
//   · 用完即清（暂存树 + 铺平目录）；
//   · 收尾全清由 package.json 的 postpack 钩子承担（scripts/clean-tmp.mts），CI 里也可单独调。
// 中间原料与暂存树都可再生，真正的产物只有 releases/ 下的 zip + sha256。
/**
 * 集成层覆盖：把 src-integrations 编译出的补丁包盖回物化树（单副本；机制见 src-integrations/README.md）。
 * fail-closed：声明了 overlay 却没产物 = 构建没跑全——宁可不打包，也不出「没打补丁」的包。
 * 版本戳（<上游>+dshana-<干净版本>）由 integrations.mts build 写在补丁包的 package.json 里，此处只原样覆盖。
 * @param {string} nodeModulesDir 组装台里的 node_modules（交付树，已是 no-link 铺平形态）
 */
function applyIntegrations(nodeModulesDir) {
  const integrationsDir = join(ROOT, "src-integrations");
  // fail-closed：目录缺失会让整包官方包回退成上游原版（role 对、主题对，但 ui-layout /
  // ui-sidebar / ui-settings-general 的补丁全丢），而打包照旧成功。任何“声明的补丁没盖上”
  // 都必须让打包失败。
  if (!fs.pathExistsSync(integrationsDir)) {
    throw new Error(`集成目录不存在：${integrationsDir}（预期 src-integrations/；拒绝产出未打补丁的包）`);
  }
  const builtRoot = join(ROOT, "_tmp", "integrations-built");
  const pending: any[] = [];
  let applied = 0;
  for (const ent of fs.readdirSync(integrationsDir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const manifestPath = join(integrationsDir, ent.name, "integration.json");
    if (!fs.pathExistsSync(manifestPath)) continue;
    const decl = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const files = Array.isArray(decl.files) ? decl.files : [];
    if (files.length === 0) continue; // 尚无 overlay：不算缺口
    const builtDir = join(builtRoot, ent.name);
    if (!fs.pathExistsSync(builtDir)) {
      pending.push(ent.name);
      continue;
    }
    const target = join(nodeModulesDir, decl.package);
    if (!fs.pathExistsSync(target)) throw new Error(`集成 ${ent.name}：物化树里没有 ${decl.package}`);
    fs.copySync(builtDir, target, { overwrite: true });
    const stamped = JSON.parse(fs.readFileSync(join(target, "package.json"), "utf8")).version;
    applied += 1;
    console.log(`[pack] 集成覆盖：${decl.package}@${stamped}（${ent.name}，${files.length} 个 overlay）`);
  }
  if (pending.length) {
    throw new Error(`集成产物缺失（${pending.join(", ")}）：先跑 pnpm run build（含 integrations build）再打包`);
  }
  // 声明了补丁却一个也没盖上 = 目录/清单出了问题；宁可不出包。
  if (applied === 0) {
    throw new Error(`没有应用任何集成补丁（${integrationsDir} 下无有效 integration.json）：拒绝产出未打补丁的包`);
  }
}

const pkgRoot = join(ROOT, "_tmp", "pkg");
for (const stale of [pkgRoot, stagingRoot]) fs.removeSync(stale);
{
  const modules = materializeProdDeps(spec);
  // 命名：通用包无后缀（既有 CI/脚本按 dshana-v<ver>.zip 取件），平台包带目标后缀
  const base = spec.name === "universal" ? `dshana-v${version}` : `dshana-v${version}-${spec.name}`;
  const pkgDir = join(pkgRoot, base); // 组装暂存目录（内容原样进 zip 根，此目录名不出现在包里）
  fs.removeSync(pkgDir);
  fs.copySync(distDir, pkgDir);
  fs.copySync(modules, join(pkgDir, "node_modules"));
  applyIntegrations(join(pkgDir, "node_modules"));
  // 暂存树用完即删
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
  // 第二参数必须为 false：把 pkgDir 的**内容**放在 zip 根。
  // 曾写成 archive.directory(pkgDir, base)，于是整包被套进一层 `<base>/`，宿主安装时在包根读
  // manifest.json 读不到（manifest.json 落在 `<base>/manifest.json`），报 INVALID_MANIFEST 拒绝安装：
  //   宿主校验器 `validate-app.mjs --archive <zip>` 会明确判 "ENOENT ... '<app>\\manifest.json'"。
  // 参照物：装得上的样例包 zip 根级就是 manifest.json / node_modules / ui / dist。
  archive.directory(pkgDir, false);
  await archive.finalize();
  await done;
  fs.moveSync(tmpZip, zipPath, { overwrite: true });
  const buf = fs.readFileSync(zipPath);
  const sha = createHash("sha256").update(buf).digest("hex").toUpperCase();
  console.log(`[pack] ${zipPath}`);
  console.log(`[pack] zip ${(buf.length / 1048576).toFixed(1)} MB · SHA256 ${sha}`);
  fs.writeFileSync(`${zipPath}.sha256`, sha, "utf8");
  // 铺平目录已入包，即用即清
  fs.removeSync(pkgDir);
}
// 收尾全清 → postpack 钩子（scripts/clean-tmp.mts）