// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/install.js — dsh 依赖部署/验证共用模块（lib 提取）
// 从 tools/dsh-run.js 剥离：resolveDshPkgDir / installDepsFromPlugin / verifyDepsSmoke
// + semver 比较辅助（parseSemver / compareSemver）+ 本地版本直读（readDshInstalledVersion）。
// 状态经 lib/state.js 的 getSingleton 访问（g.depsInstalling / g.depsInstallLog /
// g.depsSmoke 等，字段语义与旧 dsh-run.js 完全一致，别丢）。
// 消费方：dsh-run.js（updateDsh / buildDepsDiagCheck 等组合）、lib/check.js
// （checkDshUpdate 依赖 verifyDepsSmoke 缓存 + 本地版本直读）、tools/dsh-install.js
// （经单例 g.installDeps / g.verifyDeps 调用）。
//
// 容错纪律：函数内部失败返回 { ok:false, error } 结构不抛出（调用方按需降级）；
// 日志/写入失败静默（不阻断主流程）。注释风格保持宿主侧（中文/双引号/分号）。

import { spawn } from "node:child_process";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { join, dirname, delimiter } from "node:path";
import {
  getSingleton,
  manifestDefaults,
  PLUGIN_ROOT,
  ELECTRON_NODE,
  ELECTRON_NODE_ENV,
  IS_WIN,
} from "./state.js";
import { ensurePnpm, runPnpm } from "./pnpm.js";

// ---- 依赖安装日志通道（统一）----
// installDepsFromPlugin 内部 emitLog(s, src)：同一份文本同时进
//   ① 内存尾环 g.depsInstallLog（≤DEPS_LOG_CAP=8000，卡片/诊断界面实时读尾部；
//      旧实现 pnpm 流式累积不设上限，长安装内存无界增长）
//   ② 会话日志文件（持久诊断：src=pnpm 记 pnpm i 原始输出、src=hana 记里程碑
//      [依赖安装]…；g.appendLog 行规范化 \r\n/\r → \n 逐行加前缀，见 index.js）。
// 旧「命令完成后一次性 g.appendLog("pnpm", out)」废弃——pnpm 输出逐 chunk 实时写。
const DEPS_LOG_CAP = 8000;

// dsh 依赖位置两形态——① 数据目录 dsh-pkg/（Agent pnpm i @deepseek-ai/dsh 部署的轻量分发形态，
// 优先）；② 插件安装目录 node_modules（现役 zip 自带形态，兑底）。DSH_HOME 恒在数据目录。
export function resolveDshPkgDir(cfg) {
  if (cfg?.dataDir) {
    const candidate = join(cfg.dataDir, "dsh-pkg");
    if (
      existsSync(
        join(candidate, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      )
    ) {
      return candidate;
    }
  }
  return PLUGIN_ROOT;
}

// ---- 零依赖 semver 比较（major.minor.patch 三段数字逐个比；预发布 -rc.x 视为低于同版本正式版）----
// pre 字段：null 表示正式版（无预发布后缀）；对象 { kind, num } 表示预发布。
//   kind="rc" 且 num 为 rc 序号（如 "0.1.0-rc.6" → { kind:"rc", num:6 }）；
//   其余非数字预发布后缀（如 "-beta"、"-alpha"）kind="pre"、num=0（视为更旧），
//   避免误分析成 rc 或崩溃。compareSemver 三段相同时：正式版 > 任一预发布；
//   同为预发布则先比 rc 序号，能区分 0.1.0-rc.6 < 0.1.0-rc.7。
export function parseSemver(v) {
  const s = String(v || "").trim();
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)([\s\S]*)$/);
  if (!m) return null;
  const tail = m[4];
  let pre = null;
  if (tail) {
    const rc = tail.match(/^-rc\.(\d+)/i);
    pre = rc ? { kind: "rc", num: Number(rc[1]) } : { kind: "pre", num: 0 };
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre,
  };
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  // 三段相同
  if (!pa.pre && !pb.pre) return 0; // 都无预发布后缀 → 相等
  if (!pa.pre) return 1; // a 正式版 > b 预发布
  if (!pb.pre) return -1; // a 预发布 < b 正式版
  // 都是预发布：先比序号（含 rc 序号；非 rc 按 num=0 更旧）
  if (pa.pre.num !== pb.pre.num) return pa.pre.num < pb.pre.num ? -1 : 1;
  return 0;
}

// 直读 dsh 包 version（resolveDshPkgDir 同款路径：数据目录 dsh-pkg 优先，插件根兑底；
// package.json 不存在/解析失败 → null）
export function readDshInstalledVersion(cfg) {
  try {
    const pkgDir = resolveDshPkgDir(cfg);
    const pkgFile = join(
      pkgDir,
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "package.json",
    );
    if (!existsSync(pkgFile)) return null;
    const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
    return pkg && typeof pkg.version === "string" && pkg.version
      ? pkg.version
      : null;
  } catch {
    return null;
  }
}

// ---- 依赖自主部署（deps 缺失项「安装依赖」按钮的后端逻辑）----
// 参照技能文档 dsh-hanako/SKILL.md 依赖自主部署章节：部署目标恒为数据目录 dsh-pkg
// （升级安装会清插件目录 node_modules，数据目录随插件生命周期保留；不部署到插件根），
// 把最小 package.json + 插件根的 pnpm-workspace.yaml（allowBuilds 白名单）写入 pkgDir，
// 并创建指向宿主 electron node 的代理脚本，然后执行 pnpm add @deepseek-ai/dsh --loglevel=http。
// 关键：PATH 首部指向 pkgDir——代理脚本（node.cmd/node）将子进程 node 请求转发到宿主 electron node，
// koffi/node-pty 的 install script 经 cmd 起子进程 node 时就能找到宿主 electron node。
// 不复制插件根 package.json：其 devDependencies 是 rspack 构建树，复制进来需 --omit=dev 剔除，
// 而 pnpm 11 的 add 命令不支持 --omit CLI 旗标（报 Unknown option: 'omit'）；
// 最小 package.json 无 devDeps，pnpm add 天然只装 @deepseek-ai/dsh 运行时树（peer 自动装默认开启）。
// registry 默认官方源，失败自动重试 npmmirror。部署是长任务：本函数异步
// 执行不 await（调用方立即返回，页面靠轮询诊断刷新）；状态记单例 g.depsInstalling /
// g.depsInstallError / g.depsInstallAt / g.depsInstallLog（内存尾环 ≤DEPS_LOG_CAP，
// pnpm 输出与里程碑同通道 emitLog 实时写，见文件头「依赖安装日志通道」）。
export async function installDepsFromPlugin(ctxConfig, ctxDataDir) {
  const g = getSingleton();
  // 部署中并发调用直接返回（路由侧也会先查 g.depsInstalling，这里是直调兜底）
  if (g.depsInstalling) return { ok: false, state: "installing" };
  const cfg = { ...manifestDefaults };
  for (const [k, v] of Object.entries(ctxConfig || {})) {
    if (v !== undefined && v !== null && v !== "") cfg[k] = v;
  }
  const dataDir = ctxDataDir || g.dataDir || join(PLUGIN_ROOT, "data");
  cfg.dataDir = dataDir;
  g.depsInstalling = true;
  g.depsInstallError = null;
  g.depsInstallAt = new Date().toISOString();
  g.depsInstallLog = "";
  // 统一日志通道（见文件头）：同一份文本进内存尾环（≤DEPS_LOG_CAP，实时）+ 会话日志
  // 文件（src=pnpm 原始输出 / src=hana 里程碑）。每次写入刷新 depsInstallAt（前端
  // installing 态显示「更新于 HH:MM:SS」、3s 轮询 health 随诊断刷新 installLog 尾部）。
  const emitLog = (s, src) => {
    const text = String(s);
    g.depsInstallLog = (g.depsInstallLog + text).slice(-DEPS_LOG_CAP);
    g.depsInstallAt = new Date().toISOString();
    if (typeof g.appendLog === "function") {
      try {
        g.appendLog(src, text);
      } catch {
        /* 日志失败不阻断 */
      }
    }
  };
  const milestone = (s) => emitLog("[依赖安装] " + s, "hana");
  try {
    // 1. 部署目录 = 数据目录 dsh-pkg（mkdir recursive，不存在则建）
    const pkgDir = join(dataDir, "dsh-pkg");
    mkdirSync(pkgDir, { recursive: true });
    milestone("部署目录就绪：" + pkgDir);
    // 1.5 部署前停 web host：后续要删旧 node_modules，Windows 上被运行中进程加载的原生
    //    模块（koffi/node-pty 的 .node）会锁文件，rmSync 直接失败（EBUSY/EPERM）。
    //    经单例调用 closeProcess（lifecycle.js 挂载，幂等；dsh-update 同款「停 host → 装
    //    依赖 → 起 host」编排），异常不阻断部署（撞锁时会以 error 返回，信息留在日志）；
    //    部署完成后由调用方 autoStart 重新拉起。
    try {
      if (typeof g.closeProcess === "function") await g.closeProcess();
    } catch {
      /* 停 host 失败不阻断（后续清理若撞锁会以 error 返回） */
    }
    milestone("[兼容] web host 已停止（部署前）");
    // 2. 部署清单：最小 package.json（无 devDeps，避免 pnpm 11 add 缺 --omit 旗标时误装构建树）
    //    + 插件根 pnpm-workspace.yaml（allowBuilds 白名单放行 dsh 树 build scripts；pnpm 11
    //    配置已迁至 pnpm-workspace.yaml，package.json 的 allowScripts / onlyBuiltDependencies 不再读取）
    const srcWs = join(PLUGIN_ROOT, "pnpm-workspace.yaml");
    if (!existsSync(srcWs))
      throw new Error("插件根缺少 pnpm-workspace.yaml：" + srcWs);
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "dsh-pkg", private: true }, null, 2) + "\n",
    );
    copyFileSync(srcWs, join(pkgDir, "pnpm-workspace.yaml"));
    milestone("写最小 package.json + pnpm-workspace.yaml 到 " + pkgDir);
    // 3. 创建 node 代理；pnpm 入口 = 运行时引导（lib/pnpm.js ensurePnpm）
    if (IS_WIN) {
      const script = join(pkgDir, "node.cmd");
      const content = `@"${ELECTRON_NODE}" %*\n`;
      writeFileSync(script, content);
    } else {
      const script = join(pkgDir, "node");
      const content = `#!/bin/sh\nexec "${ELECTRON_NODE}" "$@"\n`;
      writeFileSync(script, content, { mode: 0o755 });
    }
    milestone("Created proxy node at " + pkgDir);
    // pnpm 不再内置（zip 摘除 node_modules/pnpm）：运行时下载 pnpm-{version} 单文件
    // pnpm.mjs 到数据目录 pnpm-dist/（缓存独立于 dsh-pkg）。引导失败（网络/校验）与
    // 旧「pnpm.cjs 不存在」语义区分：抛可读错误（含两个 CDN 提示），由外层 catch 记入
    // g.depsInstallError——不再有「pnpm 缺失」分支（pnpm 已无内置形态）。
    let pnpmCli;
    try {
      pnpmCli = await ensurePnpm({ dataDir });
    } catch (e) {
      throw new Error("pnpm 引导失败：" + (e?.message || e));
    }
    // ---- npm → pnpm 升级兼容清理 ----
    // 旧版本 dsh-install 用 npm i 部署 dsh-pkg，会留下 package-lock.json 和扁平的
    // node_modules；新版本改用 pnpm add 部署，若不先清掉旧 npm 结构，会与 pnpm 自己的
    // .pnpm 目录和符号链接混装，轻则冗余、重则影响 dsh 的 cordis 依赖解析。
    // 只清理数据目录 dsh-pkg（pkgDir）内的残留；插件根 PLUGIN_ROOT 下的 node_modules
    // 或其它目录不受影响。package.json / pnpm-workspace.yaml 由步骤 2 覆盖写，无需删。
    // pnpm-lock.yaml 一并清（中途手动跑过 pnpm 的残留，避免旧 lockfile 与新 package.json 错配）。
    const npmLock = join(pkgDir, "package-lock.json");
    const pnpmLock = join(pkgDir, "pnpm-lock.yaml");
    const flatNodeModules = join(pkgDir, "node_modules");
    if (
      existsSync(npmLock) ||
      existsSync(pnpmLock) ||
      existsSync(flatNodeModules)
    ) {
      if (existsSync(npmLock)) rmSync(npmLock, { force: true });
      if (existsSync(pnpmLock)) rmSync(pnpmLock, { force: true });
      if (existsSync(flatNodeModules))
        rmSync(flatNodeModules, { recursive: true, force: true });
      milestone("[兼容] 清理旧依赖残留（package-lock.json / pnpm-lock.yaml / node_modules）");
    } else {
      milestone("[兼容] 无旧依赖残留，跳过清理");
    }
    // 5. pnpm add @deepseek-ai/dsh：最小 package.json 无 devDeps 无需 omit；allowBuilds 放行
    //    build scripts；PATH 首部指向 pkgDir（代理脚本 node.cmd/node 让 install script 找到宿主 electron node）
    const run = async (registryArgs) => {
      let out = ""; // 仅用于错误信息提取（失败时拼进错误文本）；cap 尾环 ≤64KB
      // pnpm 输出逐 chunk 实时进统一日志通道（emitLog：内存尾环 ≤DEPS_LOG_CAP
      // + 会话日志 src=pnpm 实时写，行规范化 \r\n/\r → \n——取代旧「命令完成后一次性
      // g.appendLog("pnpm", out)」）；每次 data 刷新 depsInstallAt——前端 3s 轮询 health
      // 随诊断刷新 installLog 尾部，呈现实时进度
      const cap = (d) => {
        const text = String(d).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        out = (out + text).slice(-65536);
        emitLog(text, "pnpm");
      };
      const r = await runPnpm(
        ["add", "@deepseek-ai/dsh", "--loglevel=http", ...registryArgs],
        {
          pnpmCli,
          cwd: pkgDir,
          env: {
            ...ELECTRON_NODE_ENV,
            PATH: pkgDir + delimiter + (process.env.PATH || ""),
          },
          onStdout: cap,
          onStderr: cap,
        },
      );
      if (r.code !== 0)
        throw new Error(
          "pnpm add 失败 @deepseek-ai/dsh（exit " +
            r.code +
            "）：" +
            (out.slice(-300) || "无输出"),
        );
      return out;
    };
    try {
      await run([]); // 官方源
    } catch (e) {
      milestone("[官方源失败] " + e.message + "，重试 npmmirror…");
      await run(["--registry=https://registry.npmmirror.com"]);
    }
    // 6. 校验 dsh 包就位（resolveDshPkgDir 优先 dsh-pkg，这里 cliBin 即部署产物）
    const cliBin = join(
      pkgDir,
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "lib",
      "bin.js",
    );
    if (!existsSync(cliBin)) {
      throw new Error(
        "pnpm add 完成但未找到 dsh 包：" +
          cliBin +
          " 不存在（部署目录 " +
          pkgDir +
          "）",
      );
    }
    g.depsInstallError = null;
    milestone("[完成] " + cliBin);
    // 部署成功后强制运行级重验（清旧缓存，await 刷新——安装流程本身就是等待场景）
    g.depsSmoke = null;
    await verifyDepsSmoke(cfg);
    return { ok: true, state: "installed", cliBin };
  } catch (e) {
    g.depsInstallError = String(e?.message || e).slice(0, 1500);
    milestone("[失败] " + g.depsInstallError);
    return { ok: false, state: "error", error: g.depsInstallError };
  } finally {
    g.depsInstalling = false;
  }
}

// ---- 依赖运行级完整性验证（deps 存在性之外的加载冒烟）----
// dsh 是 cordis 生态，模块图挂大量 peer 依赖（dsh-agent/dsh-llm-deepseek/dsh-tool-* 等）：
// pnpm add 中断 / install script 失败未回滚 / --omit=peer 误用都会造成「入口文件在、依赖缺」
// 的假就绪，运行时才抛 ERR_MODULE_NOT_FOUND。文件存在 ≠ 依赖完整。
// 可靠检测 = 运行级验证「node <cliBin> --version」：node 沿 import 图加载整个 cordis 模块树，
// 任何依赖缺失都会抛错且退出码非 0（技能文档「部署后验证 node lib/bin.js --version 应输出
// 0.1.0-rc.6」同款逻辑）。能跑 = 依赖图完整。
// 防并发/防轮询风暴：结果缓存到单例 g.depsSmoke = { ok, version, error, stderr, at, running }；
// running=true 时直接返回当前缓存不重复 spawn（spawn 一次 --version 数百 ms，3s 轮询 ×
// 每次 spawn 不可接受，必须缓存 + running 标志）。触发时机：进标签页自动一次 +
// 手动「检测依赖」按钮（经 GET /webui/verify-deps 驱动）/ installDeps 部署成功后强制重验。
export async function verifyDepsSmoke(cfg) {
  const g = getSingleton();
  // 防并发：验证进行中直接返回当前缓存（不重复 spawn）
  if (g.depsSmoke?.running) return g.depsSmoke;
  // 会话日志（src=hana）：开始/通过/失败 里程碑——故障诊断（依赖缺失、安装后重验
  // 失败）在会话日志里有完整上下文（触发时机 + cliBin + 退出码/错误尾）
  const slog = (s) => {
    if (typeof g.appendLog === "function") {
      try {
        g.appendLog("hana", "[依赖验证] " + s);
      } catch {
        /* 日志失败不阻断 */
      }
    }
  };
  const dataDir =
    cfg.dataDir || g.dataDir || (g.web?.dshHome ? dirname(g.web.dshHome) : "");
  const diagCfg = { ...cfg, dataDir };
  const pkgDir = resolveDshPkgDir(diagCfg);
  const cliBin = join(
    pkgDir,
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "lib",
    "bin.js",
  );
  const smoke = {
    ok: false,
    version: null,
    error: "",
    stderr: "",
    at: "",
    running: true,
  };
  g.depsSmoke = smoke;
  try {
    if (!existsSync(cliBin)) throw new Error("cliBin 不存在：" + cliBin);
    slog("开始（cliBin=" + cliBin + "）");
    // spawn node cliBin --version，10s 超时兜底（child.kill）；capture stdout+stderr
    const child = spawn(ELECTRON_NODE, [cliBin, "--version"], {
      cwd: dirname(cliBin),
      stdio: ["ignore", "pipe", "pipe"],
      env: ELECTRON_NODE_ENV,
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out = (out + String(d)).slice(-800);
    });
    child.stderr.on("data", (d) => {
      err = (err + String(d)).slice(-800);
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已退出 */
      }
    }, 10000);
    const code = await new Promise((res) => child.once("close", res));
    clearTimeout(timer);
    const stdout = out.trim();
    // 提取完整版本（含 -rc.x 预发布后缀）：旧正则只抓 major.minor.patch，
    // 把 0.1.1-rc.1 截断成 0.1.1，与最新版 0.1.1-rc.2 比较时被当作「正式版已最新」，
    // 导致 rc 版永远判不到可更新（回归过两次，勿再截断）
    const version =
      (stdout.match(/^\s*(\d+\.\d+\.\d+(?:-[\w.]+)?)/) || [])[1] || null;
    if (code === 0 && version) {
      smoke.ok = true;
      smoke.version = version;
      smoke.error = "";
      smoke.stderr = err.slice(-400);
      slog("通过（version=" + version + "）");
    } else {
      // 真实错误（ERR_MODULE_NOT_FOUND 等）截断 ≤400 存入 error
      smoke.ok = false;
      smoke.error = String(err || out || "退出码 " + code).slice(0, 400);
      smoke.stderr = String(err || out).slice(-400);
      slog("失败（exit=" + code + "）：" + String(smoke.error).slice(0, 200));
    }
  } catch (e) {
    smoke.ok = false;
    smoke.error = String(e?.message || e).slice(0, 400);
    slog("异常：" + String(smoke.error).slice(0, 200));
  } finally {
    smoke.at = new Date().toISOString();
    smoke.running = false;
  }
  return smoke;
}
