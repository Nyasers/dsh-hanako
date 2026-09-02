// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/install.js — dsh 依赖部署/验证共用模块（lib 提取）
// 从 tools/dsh-run.js 剥离：resolveDshPkgDir / installDepsFromPlugin / verifyDepsSmoke
// + semver 比较辅助（parseSemver / compareSemver）+ 本地版本直读（readDshInstalledVersion）。
// 状态经 lib/state.js 的 getSingleton 访问分组对象 g.deps = { status, result, error,
// time, log }（v0.24 状态收敛：旧平铺 g.depsInstalling/g.depsInstallLog/g.depsSmoke 等
// 全废；status 值域 idle/installing/ok/error，result = 依赖核对缓存复合对象，log =
// 内存尾环字符串，time = 最近一次 npm i 输出时间）。
// 消费方：dsh-run.js（updateDsh 编排）、lib/check.js（checkDshUpdate 读本地版本）
// （checkDshUpdate 依赖 verifyDepsSmoke 缓存 + 本地版本直读）、tools/dsh-install.js
// （经单例 g.installDeps / g.verifyDeps 调用）。
//
// 容错纪律：函数内部失败返回 { ok:false, error } 结构不抛出（调用方按需降级）；
// 日志/写入失败静默（不阻断主流程）。注释风格保持宿主侧（中文/双引号/分号）。

import {
  readFileSync,
  existsSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, dirname, delimiter } from "node:path";
import {
  getSingleton,
  manifestDefaults,
  PLUGIN_ROOT,
  resolveNodeExec,
  resolveNodeExecEnv,
  IS_WIN,
} from "./state.js";
import {
  ensurePnpm,
  runPnpm,
  PNPM_VERSION,
  DSH_PACKAGE,
  buildPnpmInstallArgs,
  isValidPkgSpec,
} from "./pnpm.js";
// T1 错误分类器（spec：dsh-deps-zero-intervention）：install 失败路径对失败信号归类，
// 产出 errorClass + guidance 存 g.deps.errorClass（纯函数，见 errclass.js 模块头）
import {
  classifyInstallError,
  ERROR_CLASS_GUIDANCE,
} from "./errclass.js";

// ---- 依赖安装日志通道（统一）----
// installDepsFromPlugin 内部 emitLog(s, src)：同一份文本同时进
//   ① 内存尾环 g.deps.log（≤DEPS_LOG_CAP=8000，卡片/诊断界面实时读尾部；g.update.log
//      为 getter 投影同源，见 lib/state.js——旧实现 pnpm 流式累积不设上限，长安装内存无界增长）
//   ② 会话日志文件（持久诊断：src=pnpm 记 pnpm i 原始输出、src=hana 记里程碑
//      [依赖安装]…；g.appendLog 行规范化 \r\n/\r → \n 逐行加前缀，见 index.js）。
// 旧「命令完成后一次性 g.appendLog("pnpm", out)」废弃——pnpm 输出逐 chunk 实时写。
const DEPS_LOG_CAP = 8000;

// ---- pnpm 原生文本直通（ndjson reporter 去除 2026-09-03，用户定稿）----
// 展示消费的是文本日志（emitLog：内存尾环 ≤DEPS_LOG_CAP + 会话日志 src=pnpm），
// ndjson 结构化层从未被真正解析利用——原 pnpmNdjsonLineToText / pnpmErrText /
// PNPM_STAGE_DESC / firstStr / firstNum / countKeys 一整套 JSON 事件 → 可读行
// 转换白付复杂度，整体删除。pnpm 侧 buildPnpmInstallArgs 去掉 --reporter=ndjson
// 后输出原生文本：makePipe 只保留行规范化 \r\n/\r → \n、跨 chunk 行重组
// （pending）、逐行 emitLog，原生文本直通（仍逐行 src=pnpm 进日志通道）；各流独立
// capped tail（≤65536）与失败错误提取（pnpmErrorTail，≤300 语义）保留，见下方。

// 失败错误提取：失败时对 stdout/stderr 各自 capped tail 的尾部文本直接截取
// （pnpm 原生文本，无结构化解析层——ndjson 解析链已删除），最终 ≤300 字符
// （旧实现 out.slice(-300) 语义保持）。
function pnpmErrorTail(stdoutTail, stderrTail) {
  const take = (tail) => {
    if (!tail) return "";
    const lines = tail.split("\n").filter((s) => s.length > 0).slice(-10);
    return lines.join("\n");
  };
  // stdout 在前、stderr 在后：join 后 slice(-300) 取末尾窗口，stderr（错误/警告优先级高）
  // 落在截断窗口内不被挤出；stdout 的进度文本在前段作上下文。
  const parts = [take(stdoutTail), take(stderrTail)].filter((s) => s.length > 0);
  return parts.join("\n").slice(-300) || "无输出";
}

// dsh 依赖位置（vY T7d）：唯一形态 = 插件安装目录 node_modules（pnpm install --prod 按
// 插件根 package.json 声明部署，dsh 作为插件依赖树的一部分）。dsh-pkg 独立安装区已退役
// （版本单一事实源 = 插件根声明本身，无部署副本/无独立升级通道）。DSH_HOME 恒在数据目录。
export function resolveDshPkgDir() {
  return PLUGIN_ROOT;
}

// ---- T7a：运行时依赖声明读取（单一事实源 = 插件根 package.json 的 dependencies）----
// 声明版本固定随插件发版：@deepseek-ai/dsh（dsh 运行时本体）+ @deepseek-ai/cordis
// （cordis 运行时，dsh 插件树的宿主容器）。读取失败/未声明 → null（调用方回退旧基线）。
function readDeclaredDeps() {
  try {
    const pkg = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8"),
    );
    const deps = (pkg && pkg.dependencies) || {};
    const out = {};
    if (typeof deps["@deepseek-ai/dsh"] === "string")
      out["@deepseek-ai/dsh"] = deps["@deepseek-ai/dsh"];
    if (typeof deps["@deepseek-ai/cordis"] === "string")
      out["@deepseek-ai/cordis"] = deps["@deepseek-ai/cordis"];
    return out;
  } catch {
    return {};
  }
}

// 声明版本号（严格 semver 或合法 dist-tag 校验通过才返回；未声明/非法 → null）
function readDeclaredDshVersion() {
  const v = readDeclaredDeps()["@deepseek-ai/dsh"];
  return v && isValidPkgSpec(v) ? v : null;
}

// ---- 零依赖 semver 比较（major.minor.patch 三段数字逐个比；预发布按 SemVer §11.4 比较）----
// pre 字段：null 表示正式版（无预发布后缀）；数组表示 prerelease 标识符列表
// （如 "1.0.0-alpha.1" → ["alpha","1"]、"0.1.0-rc.6" → ["rc","6"]；"1.0.0" → null）。
// compareSemver 三段相同时：无 pre 的正式版 > 任一预发布；同为预发布逐标识符按
// SemVer §11.4 比较——数字标识符数值比较、非数字标识符 ASCII 字典序、数字 < 非数字；
// 前段全等时长数组 > 短数组（alpha < alpha.1）。保持「正式版 > 任一预发布」「本地 <
// 基线 → updateAvailable」语义不变，只修正 pre 之间的相对序（旧实现把非 rc 预发布
// 简化为 { kind:"pre", num:0 }，alpha.1 与 beta.1 被判相等、rc 与 beta 无法正确比较）。
export function parseSemver(v) {
  const s = String(v || "").trim();
  const m = s.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  );
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : null,
  };
}

// prerelease 标识符比较（SemVer §11.4）：数字标识符按数值比；非数字按 ASCII 字典序；
// 数字 < 非数字。
function comparePreIdentifiers(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) {
    const na = Number(a);
    const nb = Number(b);
    return na === nb ? 0 : na < nb ? -1 : 1;
  }
  if (an) return -1; // 数字 < 非数字
  if (bn) return 1; // 非数字 > 数字
  return a < b ? -1 : a > b ? 1 : 0; // 非数字 ASCII 字典序
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  // 三段相同 → 按 SemVer §11.4 比较 prerelease
  if (!pa.pre && !pb.pre) return 0; // 都无预发布后缀 → 相等
  if (!pa.pre) return 1; // a 正式版 > b 预发布
  if (!pb.pre) return -1; // a 预发布 < b 正式版
  const len = Math.min(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const c = comparePreIdentifiers(pa.pre[i], pb.pre[i]);
    if (c !== 0) return c;
  }
  // 前段全等：长数组 > 短数组（alpha < alpha.1）
  if (pa.pre.length !== pb.pre.length)
    return pa.pre.length < pb.pre.length ? -1 : 1;
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
// 把声明 package.json + 插件根的 pnpm-workspace.yaml（allowBuilds 白名单）写入 pkgDir，
// 并创建指向宿主 electron node 的代理脚本，然后经 lib/pnpm.js 的 buildPnpmInstallArgs 执行
// pnpm install --prod（按声明 package.json 的 dependencies 拉取，原生文本输出逐行
// 直通日志通道，见文件头「依赖安装日志通道」）。不再走 pnpm add @spec 动态安装（T7a
// 起版本由插件根 package.json
// 的 dependencies 声明，单一事实源，固定版本随插件发版）。
// 关键：PATH 首部指向 pkgDir——代理脚本（node.cmd/node）将子进程 node 请求转发到宿主 electron node，
// koffi/node-pty 的 install script 经 cmd 起子进程 node 时就能找到宿主 electron node。
// 不复制插件根 package.json：其 devDependencies 是 rspack 构建树，复制进来需 --omit=dev 剔除，
// 而 pnpm 11 的 install 命令不支持 --omit CLI 旗标（报 Unknown option: 'omit'）；
// 声明 package.json 只含运行时 dependencies（@deepseek-ai/dsh + @deepseek-ai/cordis），
// pnpm install 天然只装运行时树。
// registry 默认官方源，失败自动重试 npmmirror。部署是长任务：本函数异步
// 执行不 await（调用方立即返回，页面靠轮询诊断刷新）；状态记单例分组 g.deps =
// { status, result, error, time, log }（v0.24 状态收敛：status 入口置 installing、
// 成功置 ok、catch 置 error——终态保留，下次入口才回到 installing；log 内存尾环
// ≤DEPS_LOG_CAP，pnpm 输出与里程碑同通道 emitLog 实时写，见文件头「依赖安装日志通道」）。
// spec 参数（T7a 起，opts.spec）：工具层显式传 version/tag 时覆盖声明版本安装（逃生门）；
// 缺省默认走插件根 package.json 的 dependencies 声明版本（@deepseek-ai/dsh 固定版本随插件发版，
// 单一事实源），不再回退配置基线 resolveDshTag（保留仅作旧版兼容兜底）。
// 解耦（D6）：工具包/生命周期自身不 import pnpm 或 cordis 运行时——pnpm 经运行时引导
// （ensurePnpm 下载单文件）；诊断经 spawn subprocess + HTTP 直查，不加载 cordis。
// 通知宿主侧 deps 状态翻转（routes/webui.js 挂的 g.notifyDepsChanged → 壳页一次性
// 刷新诊断，事件驱动替代面板周期 tick）。通知失败不阻断部署/验证主流程。
function notifyDepsChanged() {
  const g = getSingleton();
  if (g && typeof g.notifyDepsChanged === "function") {
    try {
      g.notifyDepsChanged();
    } catch {
      /* 通知失败不阻断 */
    }
  }
}

export async function installDepsFromPlugin(ctxConfig, ctxDataDir, opts = {}) {
  const g = getSingleton();
  // 部署中并发调用直接返回（路由侧也会先查 g.deps.status，这里是直调兜底）。
  // 注意同时判 "running"：install 内部的强制重验会把 status 短暂置 running（见下方
  // verifyDepsSmoke 调用），期间并发 install 也必须拦下——原始语义 g.depsInstalling
  // 全程为 true，分组模型下 installing+running 都是「依赖操作进行中」。
  if (
    g.deps.status === "installing" ||
    g.deps.status === "running"
  )
    return { ok: false, state: "installing" };
  const cfg = { ...manifestDefaults };
  for (const [k, v] of Object.entries(ctxConfig || {})) {
    if (v !== undefined && v !== null && v !== "") cfg[k] = v;
  }
  const dataDir = ctxDataDir || g.dataDir || join(PLUGIN_ROOT, "data");
  cfg.dataDir = dataDir;
  // 安装目标（T7a 起）：版本单一事实源 = 插件根 package.json 的 dependencies 声明
  // （@deepseek-ai/dsh 固定版本随插件发版）。vY（T7d）：dsh-pkg 退役——pnpm install
  // 直接装进插件根 node_modules（--prod 只装运行时 dependencies），无部署声明副本；
  // version/tag 逃生门移除（更新 dsh = 更新插件发版）。
  const declaredDeps = readDeclaredDeps();
  const declaredVersion = readDeclaredDshVersion();
  // 声明注入面校验（保留）：声明来自插件根 package.json（单一事实源），仅允许严格
  // SemVer 或合法 dist-tag——"npm:evil@1.0.0" / "github:user/repo" 等非法声明直接拒绝。
  // 终态发布：声明非法视为部署失败，置 error 并通知（壳页事件驱动刷新诊断，UI 不
  // 卡在 installing 禁用态）。
  if (declaredVersion === null) {
    g.deps.error =
      "插件声明缺少合法 @deepseek-ai/dsh 版本（dependencies 未声明或非法）";
    g.deps.status = "error";
    g.deps.time = new Date().toISOString();
    // T1：声明非法属 declaration（不可恢复 → 停 + 上报），与 catch 失败路径同一产出
    // 形态（{ errorClass, guidance } 对象，见 errclass.js 模块头）——status=error 时
    // errorClass 不落空，诊断展示/调度器可依赖。
    g.deps.errorClass = {
      errorClass: "declaration",
      guidance: ERROR_CLASS_GUIDANCE.declaration,
    };
    notifyDepsChanged();
    return {
      ok: false,
      state: "error",
      error: g.deps.error,
    };
  }
  // 子进程 node 解析（每次部署解析一次；wrapper 与 pnpm add 用同一解析结果——自定义
  // nodejsPath 时 wrapper 也指向系统 node，macOS 签名校验问题一并解决）。同时传
  // dataDir（直读 config.json 的 global.nodejsPath，单一事实源）与 cfg.nodejsPath
  // （配置快照兑底：global.nodejsPath 缺失/dev invoke 场景时仍能解析到自定义 node）
  const nodeExec = resolveNodeExec({ dataDir, nodejsPath: cfg.nodejsPath });
  const nodeEnv = resolveNodeExecEnv({ dataDir, nodejsPath: cfg.nodejsPath });
  g.deps.status = "installing";
  g.deps.error = null;
  // T1：新一次安装尝试清空上次失败的分类（errorClass 只反映最近一次 install 失败，
  // 与 error 同生命周期；成功路径/新入口不残留旧分类误导诊断展示）
  g.deps.errorClass = null;
  g.deps.time = new Date().toISOString();
  g.deps.log = "";
  notifyDepsChanged();
  // 统一日志通道（见文件头）：同一份文本进内存尾环（≤DEPS_LOG_CAP，实时）+ 会话日志
  // 文件（src=pnpm 原始输出 / src=hana 里程碑）。每次写入刷新 g.deps.time（前端
  // installing 态显示「更新于 HH:MM:SS」、3s 轮询 health 随诊断刷新 log 尾部）。
  const emitLog = (s, src) => {
    const text = String(s);
    g.deps.log = (g.deps.log + text).slice(-DEPS_LOG_CAP);
    g.deps.time = new Date().toISOString();
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
    // 1. 部署目标 = 插件根（vY T7d：dsh-pkg 退役——依赖作为插件 node_modules 的一部分，
    //    直接 pnpm install --prod 按插件根 package.json 声明拉取；无部署声明副本）。
    const pkgDir = PLUGIN_ROOT;
    milestone("部署目标：插件根 " + pkgDir);
    // 1.5 幂等检查：cliBin 存在且已装版本 === 声明版本（精确匹配固定版本）→ 跳过安装
    //    放在停 host 之前，避免版本一致时白停一次 web host。
    const cliBin = join(
      pkgDir,
      "node_modules",
      "@deepseek-ai",
      "dsh",
      "lib",
      "bin.js",
    );
    const installedVersion = readDshInstalledVersion({ dataDir });
    if (
      existsSync(cliBin) &&
      declaredVersion &&
      installedVersion === declaredVersion
    ) {
      // 幂等跳过前经 verifyDepsSmoke 确认（去 spawn 2026-09-02 后为静态核对：cliBin +
      // 磁盘版本与声明一致——与上方幂等条件同源，实为 result/pnpm 状态刷新 + pnpm 引导
      // 自愈检查；核对不过 fall through 走重装流程）。
      const smoke = await verifyDepsSmoke(cfg, { force: true });
      if (smoke && smoke.ok) {
        milestone("已安装 dsh@" + installedVersion + "（与声明一致），跳过安装");
        g.deps.error = null;
        g.deps.result = smoke;
        g.deps.status = "ok";
        notifyDepsChanged();
        return { ok: true, state: "installed", cliBin, skipped: true };
      }
      milestone(
        "已安装 dsh@" +
          installedVersion +
          "（与声明一致）但依赖不完整（" +
          ((smoke && (smoke.error || smoke.stderr)) || "verify 失败") +
          "），走重装流程",
      );
      // verifyDepsSmoke 的终态（error）是独立入口语义；此处嵌套于 install 流程——
      // 重装仍进行中，恢复 installing 外层锁，守卫保持拦截并发 install（否则 verify
      // 失败后到安装完成的窗口内第二次 install 请求可进入，两个 pnpm install 同时
      // 删/建 node_modules）。恢复后补一次通知：verify 失败已推 error（壳页可能显示
      // 错误与重装按钮），需告知状态已回到 installing，避免壳页停留错误展示诱导重复操作。
      g.deps.status = "installing";
      notifyDepsChanged();
    }
    // 1.6 部署前停 web host：后续要删旧 node_modules，Windows 上被运行中进程加载的原生
    //    模块（koffi/node-pty 的 .node）会锁文件，rmSync 直接失败（EBUSY/EPERM）。
    //    经单例调用 closeProcess（lifecycle.js 挂载，幂等；dsh-install 工具 update
    //    action 同款「停 host → 装依赖 → 起 host」编排），异常不阻断部署（撞锁时会以
    //    error 返回，信息留在日志）；
    //    部署完成后由调用方 autoStart 重新拉起。
    try {
      if (typeof g.closeProcess === "function") await g.closeProcess();
    } catch {
      /* 停 host 失败不阻断（后续清理若撞锁会以 error 返回） */
    }
    milestone("[兼容] web host 已停止（部署前）");
    // 2. 部署清单 = 插件根 package.json（dependencies 单一事实源）+ pnpm-workspace.yaml
    //    （allowBuilds 白名单放行 build scripts）——不再写部署副本（T7d：dsh-pkg 退役）。
    const srcWs = join(PLUGIN_ROOT, "pnpm-workspace.yaml");
    if (!existsSync(srcWs))
      throw new Error("插件根缺少 pnpm-workspace.yaml：" + srcWs);
    milestone("部署清单：插件根 package.json（声明）+" + srcWs);
    // 3. 创建 node 代理（插件根，与部署物同目录）；pnpm 入口 = 运行时引导
    //    （lib/pnpm.js ensurePnpm 下载单文件 pnpm.mjs 到数据目录 pnpm-dist/）。
    //    代理与 pnpm run 的 PATH 前缀同源绑定 pkgDir（见下）——install script
    //    （koffi/node-pty 等 build）经 cmd 起子进程 node 时命中代理 → 转发到解析后的
    //    node 执行体（nodejsPath 或宿主 electron node）。历史教训（T7d 过渡期）：代理
    //    写数据目录 pnpm-proxy 而 PATH 仍指插件根，cmd 找不到 node，install script 全挂
    //    （ELIFECYCLE 'node' is not recognized，全新安装必现）；代理随部署走、与 PATH
    //    同目录即无漂移可能。清理段只删 node_modules/lock，pnpm 不碰 node_modules 外
    //    文件，代理每次安装幂等重建、不受影响。
    const legacyProxy = join(dataDir, "pnpm-proxy");
    if (existsSync(legacyProxy)) {
      try {
        rmSync(legacyProxy, { recursive: true, force: true });
        milestone("[兼容] 旧数据目录 pnpm-proxy 已删除（代理改随插件根部署）");
      } catch (e) {
        milestone("[兼容] 旧 pnpm-proxy 删除失败（可手动清理）：" + (e?.message || e));
      }
    }
    if (IS_WIN) {
      const script = join(pkgDir, "node.cmd");
      const content = `@"${nodeExec}" %*\n`;
      writeFileSync(script, content);
    } else {
      const script = join(pkgDir, "node");
      const content = `#!/bin/sh\nexec "${nodeExec}" "$@"\n`;
      writeFileSync(script, content, { mode: 0o755 });
    }
    milestone("node 代理就绪：" + pkgDir);
    // pnpm 不再内置（zip 摘除 node_modules/pnpm）：运行时下载 pnpm-{version} 单文件
    // pnpm.mjs 到数据目录 pnpm-dist/（缓存独立于 dsh-pkg）。引导失败（网络/校验）与
    // 旧「pnpm.cjs 不存在」语义区分：抛可读错误（含两个 CDN 提示），由外层 catch 记入
    // g.deps.error——不再有「pnpm 缺失」分支（pnpm 已无内置形态）。
    let pnpmCli;
    try {
      pnpmCli = await ensurePnpm({ dataDir });
    } catch (e) {
      throw new Error("pnpm 引导失败：" + (e?.message || e));
    }
    milestone("pnpm 引导就绪：" + pnpmCli);
    // ---- npm → pnpm 升级兼容清理 + dsh-pkg 退役 ----------------
    // 旧版本 npm i 部署 dsh-pkg 会留下 package-lock.json 和扁平 node_modules；新版本
    // pnpm install --prod 部署到插件根——先清旧残留再装，避免与 pnpm 的 .pnpm 结构混装。
    // 清理范围：插件根 node_modules/lock（安装目标自身）；旧数据目录 dsh-pkg 整体退役
    // （T7d：独立安装区移除，依赖收进插件 node_modules）。
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
    // dsh-pkg 退役（T7d）：旧独立安装区整体删除（依赖已收进插件 node_modules；
    // 残留的 dsh-pkg 是历史部署副本，不再使用）。
    const legacyPkg = join(dataDir, "dsh-pkg");
    if (existsSync(legacyPkg)) {
      try {
        rmSync(legacyPkg, { recursive: true, force: true });
        milestone("[退役] 旧 dsh-pkg 已删除（依赖收进插件 node_modules）");
      } catch (e) {
        milestone("[退役] dsh-pkg 删除失败（可手动清理）：" + (e?.message || e));
      }
    }
    // 5. pnpm install 安装目标（参数构造收敛 lib/pnpm.js buildPnpmInstallArgs：按
    //    插件根 package.json 声明拉取 --prod（只装运行时 dependencies，不装 devDeps
    //    构建树），registry 兜底由调用方只传 URL 意图；allowBuilds 放行 build scripts；
    //    PATH 首部指向代理目录（node.cmd/node 让 install script 找到宿主 electron node）
    milestone("安装目标：pnpm install --prod（按插件根声明 " + declaredVersion + "）");
    const run = async (registry) => {
      // stdout/stderr 各持独立跨 chunk 行缓冲（pending 行重组 + tail 错误提取）：两条
      // 管道的 chunk 边界互不相关，各流独立重组，避免把不同流的片段拼成一行；错误
      // 提取也按流独立解析（pnpmErrorTail(stdoutTail, stderrTail)，stdout 在前）。
      // makePipe 工厂按流各自创建回调。
      const buffers = {
        out: { pending: "", tail: "" },
        err: { pending: "", tail: "" },
      };
      // pnpm 原生文本输出逐 chunk 实时进统一日志通道（emitLog：内存尾环 ≤DEPS_LOG_CAP
      // + 会话日志 src=pnpm 实时写，行规范化 \r\n/\r → \n）——ndjson 解析层已去除，
      // 原生文本直接逐行透传。每次 data 刷新 depsInstallAt——前端 3s 轮询 health 随
      // 诊断刷新 installLog 尾部，呈现实时进度
      const makePipe = (buf) => (d) => {
        const text = String(d).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        buf.tail = (buf.tail + text).slice(-65536); // 各流独立 capped tail（错误提取用）
        const lines = (buf.pending + text).split("\n");
        buf.pending = lines.pop() ?? ""; // 末段可能是不完整行，留到下个 chunk
        for (const line of lines) {
          if (line === "") continue;
          emitLog(line + "\n", "pnpm"); // 原生文本直通（行规范化已在上面做）
        }
      };
      // 参数构造收敛 lib/pnpm.js buildPnpmInstallArgs（无 --reporter=ndjson，pnpm
      // 原生文本输出；按声明安装，registry 兜底意图由调用方只传 URL）
      const r = await runPnpm(buildPnpmInstallArgs({ registry }), {
        pnpmCli,
        cwd: pkgDir,
        env: {
          ...nodeEnv,
          // PATH 首部 = pkgDir（插件根）：node 代理（node.cmd/node）与部署物同目录、
          // 同源绑定（见上方「创建 node 代理」）——install script（koffi/node-pty 等
          // build）经 cmd 起子进程 node 时命中代理，转发到解析后的 node 执行体
          // （nodejsPath 或宿主 electron node）。代理目录与 PATH 前缀为同一常量，
          // 不存在漂移可能（T7d 过渡期代理在数据目录而 PATH 指插件根，曾致全挂）。
          PATH: pkgDir + delimiter + (process.env.PATH || ""),
        },
        onStdout: makePipe(buffers.out),
        onStderr: makePipe(buffers.err),
      });
      // 收尾 flush：两条管道各自的残留半行分别处理（互不拼接，见 buffers 注释）
      for (const buf of [buffers.out, buffers.err]) {
        if (buf.pending) emitLog(buf.pending + "\n", "pnpm");
      }
      if (r.code !== 0) {
        // T1：失败信号结构化——message 保持原可读文本形态（日志/诊断兼容），原始
        // stdout/stderr 尾 + 退出码附在 Error 上随 throw 上行，外层 catch 组分类信号
        // （classifyInstallError）时能拿到完整特征（pnpm 原始输出中的错误码/错误文本，
        // 不止 pnpmErrorTail 裁过的 ≤300 字摘要）。
        const installErr = new Error(
          "pnpm install 失败 " +
            DSH_PACKAGE +
            "（exit " +
            r.code +
            "）：" +
            pnpmErrorTail(buffers.out.tail, buffers.err.tail),
        );
        installErr.exitCode = r.code;
        installErr.stdoutTail = buffers.out.tail;
        installErr.stderrTail = buffers.err.tail;
        throw installErr;
      }
      return buffers.out.tail; // 无消费者（run 返回值未使用）；保持 string 返回语义
    };
    try {
      await run(null); // 官方源（buildPnpmInstallArgs 不加 registry 参数）
    } catch (e) {
      milestone("[官方源失败] " + e.message + "，重试 npmmirror…");
      await run("https://registry.npmmirror.com");
    }
    // 6. 校验 dsh 包就位（resolveDshPkgDir 优先 dsh-pkg，这里 cliBin 即部署产物）
    if (!existsSync(cliBin)) {
      throw new Error(
        "pnpm install 完成但未找到 DSH 包：" +
          cliBin +
          " 不存在（部署目录 " +
          pkgDir +
          "）",
      );
    }
    g.deps.error = null;
    milestone("[完成] " + cliBin);
    // 部署成功后强制静态核对（刷新 result/pnpm 状态——安装流程本身就是等待场景）；
    // verifyDepsSmoke 会把 g.deps.result 刷新为最新核对结果（含 status → ok/error）
    g.deps.result = null;
    await verifyDepsSmoke(cfg, { force: true });
    // 安装链路终态 ok（终态保留；verify 若失败其详情在 g.deps.result，不影响安装结论）——
    // 成功终态清 error：verifyDepsSmoke 失败路径可能已写入 g.deps.error，不带矛盾状态
    // （status ok + error 非空）进事件驱动诊断。
    g.deps.status = "ok";
    g.deps.error = null;
    notifyDepsChanged();
    return { ok: true, state: "installed", cliBin };
  } catch (e) {
    // T1 错误分类接入：失败路径对失败信号归类，产出 errorClass + guidance 存
    // g.deps.errorClass（{ errorClass, guidance } 对象，见 errclass.js 模块头；g.deps.error
    // 原样保留 = 可读错误文本，分类是它之上的结构化附加）。信号来源：
    //   ① 本函数内部 throw 已附原始 stdout/stderr 尾 + 退出码（见上方 run() 结构化
    //      throw）——决定性信号 = 最后一次 registry 尝试（官方源 → npmmirror）的输出，
    //      分类器按「分层判定」先只看 tail（见 errclass.js 模块头）；
    //   ② 其它 throw 点（pnpm 引导失败等）只有 message——message 即含错误特征文本
    //      （如 ENOTFOUND/ETIMEDOUT），经 milestoneLog 喂分类器（tail 为空时的兜底层）。
    // 注意：milestoneLog 只传本次失败的 e.message，不拼接 g.deps.log 全文——g.deps.log
    // 是两次 registry 尝试的累积输出（官方源失败的 ENOTFOUND 等仍留在日志里），拼入会
    // 让分类器误判成前次尝试的类（CodeRabbit PR #50：决定性 declaration 被残留 network
    // 特征抢判）；message 与 tail 同属最后一次失败，特征一致无冲突。
    // 分类器纯函数永不抛，这里直接调用不需再包 try（分类失败不可能，最坏 unknown）。
    const errObj = e instanceof Error ? e : null;
    const classified = classifyInstallError({
      exitCode:
        errObj && typeof errObj.exitCode === "number" ? errObj.exitCode : null,
      stdoutTail:
        errObj && typeof errObj.stdoutTail === "string" ? errObj.stdoutTail : "",
      stderrTail:
        errObj && typeof errObj.stderrTail === "string" ? errObj.stderrTail : "",
      // e 非 Error（或 message 形态）时文本特征主要落在 message：经 milestoneLog 喂
      // 分类器（message 携带的错误码/错误文本与同次 tail 特征一致，不冲突）
      milestoneLog: String(e?.message || e),
    });
    g.deps.errorClass = classified;
    g.deps.error = String(e?.message || e).slice(0, 1500);
    g.deps.status = "error";
    notifyDepsChanged();
    milestone("[失败] " + g.deps.error);
    return { ok: false, state: "error", error: g.deps.error };
  }
}

// ---- 依赖完整性核对（静态：存在性 + 版本与声明一致；去 spawn 2026-09-02）----
// 历史：v0.8.7 起为运行级冒烟（spawn node cliBin --version 验依赖图可加载）。退役理由：
// ① 冒烟 spawn 独立进程、绕开宿主 ESM 缓存，验的是「干净进程可加载」——与真实故障
//    （进程内缓存命中旧版、boot 读已删 .pnpm 路径）不同路：验过 ≠ 能跑，实装验证多次
//    出现「验证通过（依赖绿）+ boot 失败 ENOENT（升级残留）」的两张皮；
// ② 磁盘完整性由 pnpm install 退出 0 保证（事务性；历史假就绪均来自 pnpm 异常中断，
//    现已被 install 失败路径 + errorClass 分类捕获）；可运行性由 boot（进程内同路，
//    命中缓存与否如实反映）裁决——运行级验证夹在中间无独立价值，spawn 面收敛只留
//    pnpm install（D6：诊断/工具不 import cordis/pnpm）。
// 现职责：静态核对 cliBin 存在 + 磁盘版本 === 插件声明（秒回，无子进程、无 running
// 窗口）。pnpm 引导检查保留（ensurePnpm 幂等自愈，文件下载/校验不 spawn）。
// 结果缓存到单例分组 g.deps.result = { ok, version, error, at, running, pnpm* }（
// v0.24 状态收敛：旧 g.depsSmoke 平铺字段并入）；防并发守卫保留（兼容 running/installing
// 语义，静态后 running 窗口消失）。
// 触发时机：dsh_install 工具 action=verify（Agent 只读排查，标签页手动按钮已随诊断壳退役）/ installDeps
// 部署成功后强制重验（opts.force）。
// pnpm 引导状态（pnpmReady/pnpmVersion/pnpmError）为独立子项，不进 ok 判定（web host
// 启动不依赖 pnpm）；仅作 deps 卡片「pnpm 引导：就绪/未就绪」独立展示行。
export async function verifyDepsSmoke(cfg, opts = {}) {
  const g = getSingleton();
  // 防并发：验证进行中直接返回当前缓存（不重复 spawn）——running 标志映射进 g.deps.status
  if (!opts.force && g.deps.status === "running") return g.deps.result;
  // 依赖安装进行中（installDepsFromPlugin 部署未完成）：不启动新验证、不覆盖
  // g.deps.result——返回进行中响应（安装完成后的强制重验经 opts.force 绕过本守卫，
  // 见 install.js 调用点；否则 installing 期间外部 verify 会并发 spawn 并污染结果）
  if (!opts.force && g.deps.status === "installing")
    return (
      g.deps.result ?? {
        ok: false,
        running: true,
        error: "依赖安装进行中，验证稍后自动执行",
      }
    );
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
    // pnpm 引导状态（独立子项，不进 smoke.ok 判定）：pnpmReady=false 时 pnpmError 为原因
    pnpmReady: false,
    pnpmVersion: null,
    pnpmError: "",
  };
  // 结果缓存（g.deps.result 复合对象整体引用）+ 验证进行中状态
  g.deps.result = smoke;
  g.deps.status = "running";
  notifyDepsChanged();
  // pnpm 引导检查（与静态核对并行，互不拖累）：pnpm 检查允许自愈——ensurePnpm 幂等：缓存完整（sha256 一致）直接
  // 返回（快速路径），缺失/损坏自动重新下载（网络操作无副作用）。dataDir 显式传入
  // （与 installDepsFromPlugin 同约定，见 pnpm.js resolveDataDir；patch 渲染已不再
  // 依赖 pnpm——v0.18.2 起版本检查改 HTTP 直查 npm registry）。
  // 结果独立展示，不进 dsh 依赖就绪的布尔判定。任务内已 catch 全部错误，永不 reject。
  const pnpmTask = (async () => {
    slog("pnpm 引导检查…");
    try {
      await ensurePnpm({ dataDir });
      smoke.pnpmReady = true;
      smoke.pnpmVersion = PNPM_VERSION;
      smoke.pnpmError = "";
      slog("pnpm 引导就绪（pnpm-dist/pnpm-" + PNPM_VERSION + "）");
    } catch (e) {
      smoke.pnpmReady = false;
      smoke.pnpmVersion = null;
      smoke.pnpmError = String(e?.message || e).slice(0, 400);
      slog("pnpm 引导失败：" + String(smoke.pnpmError).slice(0, 200));
    }
  })();
  try {
    // 静态核对（去 spawn）：cliBin 存在且为常规文件 + 磁盘版本 === 插件声明。磁盘完整
    // 性由 pnpm install 保证、可运行性由 boot 裁决（见函数头注释），这里只核对「装没装
    // 对」。cliBin 必须是常规文件（existsSync 对目录也返回 true——目录损坏时核对不能过，
    // 否则幂等跳过不修复、boot 加载路径失败。CodeRabbit PR #54）
    let cliStat = null;
    try {
      cliStat = statSync(cliBin);
    } catch {
      /* 不存在/不可读 */
    }
    if (!cliStat || !cliStat.isFile())
      throw new Error("cliBin 不存在或非文件：" + cliBin);
    slog("静态核对（cliBin=" + cliBin + "）");
    const declared = readDeclaredDshVersion();
    const installed = readDshInstalledVersion(diagCfg);
    if (!declared)
      throw new Error(
        "插件声明缺少合法 dsh 版本（dependencies 未声明或非法）",
      );
    if (!installed) throw new Error("dsh 包版本读取失败：" + cliBin);
    // 声明若是合法 dist-tag（非 semver 形态）则无法版本对账——存在即视为一致（安装按
    // 声明拉取由 install 保证）；固定版本声明（现役形态）做严格比对
    const declaredIsSemver = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(declared);
    if (declaredIsSemver && installed !== declared) {
      smoke.error =
        "磁盘 dsh@" +
        installed +
        " ≠ 插件声明 " +
        declared +
        "（需重新安装依赖）";
      slog("不一致（磁盘 " + installed + " ≠ 声明 " + declared + "）");
    } else {
      smoke.ok = true;
      smoke.version = installed;
      slog("通过（version=" + installed + ", 与声明一致）");
    }
  } catch (e) {
    smoke.ok = false;
    smoke.error = String(e?.message || e).slice(0, 400);
    slog("异常：" + String(smoke.error).slice(0, 200));
  } finally {
    // 等 pnpm 检查收尾（自愈下载可能比静态核对慢；pnpmTask 内部已 catch，不抛）。
    // 若不等它，首次 verify 会带着 pnpmReady=false 返回，前端展示「未就绪」误导——
    // 自愈路径（删缓存后 verify）须等下载完成再定格结果。
    await pnpmTask;
    smoke.at = new Date().toISOString();
    smoke.running = false;
    // 验证链路终态（ok/error 保留；下次 verify 入口才回到 running）——注意 install 内部
    // 调用本函数后还会把 g.deps.status 置 ok（安装结论优先，verify 详情在 g.deps.result）
    g.deps.status = smoke.ok ? "ok" : "error";
    // error 字段与验证结果同步（ok → 清空；失败 → smoke.error，供诊断展示）——
    // 先写 error 再通知：notifyDepsChanged 同步调订阅者，若在其前发出则订阅者读到
    // 的终态缺 error（状态与错误不一致的诊断帧）。
    g.deps.error = smoke.ok ? "" : smoke.error;
    notifyDepsChanged();
  }
  return smoke;
}
