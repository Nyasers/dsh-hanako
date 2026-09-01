// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/install.js — dsh 依赖部署/验证共用模块（lib 提取）
// 从 tools/dsh-run.js 剥离：resolveDshPkgDir / installDepsFromPlugin / verifyDepsSmoke
// + semver 比较辅助（parseSemver / compareSemver）+ 本地版本直读（readDshInstalledVersion）。
// 状态经 lib/state.js 的 getSingleton 访问分组对象 g.deps = { status, result, error,
// time, log }（v0.24 状态收敛：旧平铺 g.depsInstalling/g.depsInstallLog/g.depsSmoke 等
// 全废；status 值域 idle/installing/ok/error，result = 运行级验证缓存复合对象，log =
// 内存尾环字符串，time = 最近一次 npm i 输出时间）。
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
import { resolveDshTag } from "./config.js";

// ---- 依赖安装日志通道（统一）----
// installDepsFromPlugin 内部 emitLog(s, src)：同一份文本同时进
//   ① 内存尾环 g.deps.log（≤DEPS_LOG_CAP=8000，卡片/诊断界面实时读尾部；g.update.log
//      为 getter 投影同源，见 lib/state.js——旧实现 pnpm 流式累积不设上限，长安装内存无界增长）
//   ② 会话日志文件（持久诊断：src=pnpm 记 pnpm i 原始输出、src=hana 记里程碑
//      [依赖安装]…；g.appendLog 行规范化 \r\n/\r → \n 逐行加前缀，见 index.js）。
// 旧「命令完成后一次性 g.appendLog("pnpm", out)」废弃——pnpm 输出逐 chunk 实时写。
const DEPS_LOG_CAP = 8000;

// ---- pnpm ndjson 进度/错误解析（--reporter=ndjson 结构化事件流 → 可读文本）----
// pnpm 11.24.0 的 ndjson reporter（bole 序列化到 stdout）：每行一个 JSON 对象，
// level 为字符串（debug/info/warn/error），name 标识事件类型：
//   pnpm:fetching-progress  { packageId, downloaded, size, status }   包下载进度
//   pnpm:progress           { packageId, status: resolved/fetched/found_in_store }  解析/取包状态
//   pnpm:stage              { stage: resolution_started/done | importing_started/done | (exec) }  安装阶段
//   pnpm:root               { added/removed: { name, version } }     逐包链接（添加/移除）
//   pnpm:stats              { added, removed }                       汇总计数
//   pnpm:lifecycle          { stage(脚本名), depPath, wd, line?, exitCode? }  build script 进度
//   pnpm / pnpm:global      { message, err? }                        info/warn/error（含致命错误）
// 解析策略：JSON 行按事件类型转可读进度行（下载进度、阶段中文描述、错误提取 message/err，
// 不把原始 JSON 整行灌进展示日志）；非 JSON 行原样透传（pnpm 也可能输出裸文本，不丢信息）；
// 未识别且无 message 的事件行跳过（完整原始流保留在 out，供失败时错误提取）。
const PNPM_STAGE_DESC = {
  resolution_started: "依赖解析开始",
  resolution_done: "依赖解析完成",
  importing_started: "依赖导入开始",
  importing_done: "依赖导入完成",
  "(exec)": "执行脚本",
};

// 取对象首个存在的字符串字段值（防御不同 pnpm 版本字段差异）
function firstStr(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

// 取对象首个存在的数字字段值（同 firstStr，数字形态）
function firstNum(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

// 对象键计数（peer-dependency-issues 汇总用）
function countKeys(v) {
  return v && typeof v === "object" ? Object.keys(v).length : 0;
}

// 从单个 ndjson 日志对象提取可读错误文本（err.message 优先、回退 message、err.code）
function pnpmErrText(obj) {
  const err = obj && typeof obj.err === "object" && obj.err ? obj.err : null;
  const code = err && typeof err.code === "string" && err.code ? err.code : "";
  let msg = err && typeof err.message === "string" && err.message ? err.message : "";
  if (!msg && typeof obj.message === "string") msg = obj.message;
  if (!msg) return code || null;
  // err.message 通常不含 code 前缀（PnpmError.message 只有详情）；已含则不重复拼
  return code && msg.indexOf(code) !== 0 ? code + " " + msg : msg;
}

// 逐行转换：JSON 事件行 → 可读进度行；非 JSON 行原样透传（不丢信息）
// sizes：fetching-progress 的包大小记录表（started 事件记 size，in_progress 事件用）
function pnpmNdjsonLineToText(line, sizes) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return line; // 非 JSON 行原样透传
  }
  if (!obj || typeof obj !== "object") return line;
  const name = typeof obj.name === "string" ? obj.name : "";
  const level = typeof obj.level === "string" ? obj.level : "";
  // 错误/警告：提取可读文本（message/err），不要把原始 JSON 整行抛给用户
  if (level === "error" || name === "pnpm:error") {
    const m = pnpmErrText(obj);
    return m ? "[pnpm] 错误：" + m : line;
  }
  if (level === "warn") {
    const m = typeof obj.message === "string" && obj.message ? obj.message : pnpmErrText(obj);
    return m ? "[pnpm] 警告：" + m : line;
  }
  switch (name) {
    case "pnpm:fetching-progress": {
      // 字段双兼容：11.24.0 用 packageId/downloaded/size；其它版本可能用 package/fetched/total
      const pkg = firstStr(obj, ["packageId", "package"]);
      if (pkg == null) return line;
      const sizeNow = firstNum(obj, ["size", "total"]);
      if (sizeNow != null && sizes) sizes.set(pkg, sizeNow); // started 事件带包总字节
      const fetched = firstNum(obj, ["downloaded", "fetched"]);
      const total = fetched != null && sizeNow == null ? (sizes ? sizes.get(pkg) : null) : sizeNow;
      if (fetched == null || total == null || total <= 0) {
        return "[pnpm] 下载 " + pkg + " …";
      }
      const pct = Math.min(100, Math.round((fetched / total) * 100));
      return "[pnpm] 下载 " + pkg + " " + fetched + "/" + total + " (" + pct + "%)";
    }
    case "pnpm:progress": {
      const pkg = firstStr(obj, ["packageId"]);
      if (pkg == null) return line;
      const st = typeof obj.status === "string" ? obj.status : "";
      const desc =
        st === "resolved"
          ? "已解析"
          : st === "fetched"
            ? "已下载"
            : st === "found_in_store"
              ? "命中缓存"
              : st || "处理";
      return "[pnpm] " + desc + " " + pkg;
    }
    case "pnpm:stage": {
      const st = typeof obj.stage === "string" ? obj.stage : "";
      if (!st) return line;
      return "[pnpm] " + (PNPM_STAGE_DESC[st] || st);
    }
    case "pnpm:root": {
      const added = obj.added;
      const removed = obj.removed;
      if (added && typeof added.name === "string") {
        return "[pnpm] 添加 " + added.name + (added.version != null ? "@" + added.version : "");
      }
      if (removed && typeof removed.name === "string") {
        return "[pnpm] 移除 " + removed.name + (removed.version != null ? "@" + removed.version : "");
      }
      return line;
    }
    case "pnpm:stats": {
      const parts = [];
      if (typeof obj.added === "number") parts.push("新增 " + obj.added + " 个包");
      if (typeof obj.removed === "number") parts.push("移除 " + obj.removed + " 个包");
      return parts.length ? "[pnpm] " + parts.join("，") : line;
    }
    case "pnpm:lifecycle": {
      const stage = typeof obj.stage === "string" ? obj.stage : "";
      const depPath = typeof obj.depPath === "string" ? obj.depPath : "";
      const scriptLine = typeof obj.line === "string" ? obj.line : "";
      const exitCode = typeof obj.exitCode === "number" ? obj.exitCode : null;
      const where = depPath ? "（" + depPath + "）" : "";
      if (scriptLine) return "[pnpm] " + (depPath ? depPath + " " : "") + scriptLine;
      if (exitCode != null) return "[pnpm] 脚本结束 " + (stage || "?") + where + " exit=" + exitCode;
      return "[pnpm] 执行脚本 " + (stage || "?") + where;
    }
    case "pnpm:summary":
      return "[pnpm] 包链接完成，开始执行构建脚本…";
    case "pnpm:deprecation": {
      const pkgName = firstStr(obj, ["pkgName"]);
      const ver = typeof obj.pkgVersion === "string" ? obj.pkgVersion : "";
      const depMsg = typeof obj.deprecated === "string" ? obj.deprecated : "";
      const what = pkgName ? pkgName + (ver ? "@" + ver : "") : "某包";
      return "[pnpm] 弃用告警：" + what + (depMsg ? "：" + depMsg : "");
    }
    case "pnpm:peer-dependency-issues": {
      const byProject = obj.issuesByProjects;
      if (!byProject || typeof byProject !== "object") return line;
      let missing = 0;
      let bad = 0;
      let conflicts = 0;
      for (const issues of Object.values(byProject)) {
        if (!issues || typeof issues !== "object") continue;
        missing += countKeys(issues.missing);
        bad += countKeys(issues.bad);
        if (Array.isArray(issues.conflicts)) conflicts += issues.conflicts.length;
      }
      const parts = [];
      if (missing) parts.push("缺少 " + missing + " 个 peer 依赖");
      if (bad) parts.push(bad + " 个版本不符");
      if (conflicts) parts.push(conflicts + " 处冲突");
      return parts.length ? "[pnpm] peer 依赖告警：" + parts.join("，") : "[pnpm] peer 依赖告警";
    }
    case "pnpm:link": {
      // 文件链接事件（pnpm 11.24.0：linkLogger.debug({ target, link })，字段
      // target=store 实际位置、link=落位路径）：两字段齐备才格式化输出链接日志；
      // 任一缺失视为不完整事件，原行透传保留原始信息供诊断。
      const link = typeof obj.link === "string" && obj.link ? obj.link : "";
      const target = typeof obj.target === "string" && obj.target ? obj.target : "";
      if (!link || !target) return line;
      return "[pnpm] 链接 " + link + " ← " + target;
    }
    default: {
      // 其它事件（scope/summary/context 等）：有 message 透传 message，否则跳过
      const m = typeof obj.message === "string" && obj.message ? obj.message : "";
      return m ? "[pnpm] " + m : "";
    }
  }
}

// 失败错误提取：stdout/stderr 各自的 capped tail 独立逐行转可读文本（JSON 错误行提取
// message/err，不把原始 JSON 整行抛给用户；两流独立解析，避免跨流拼接部分 NDJSON
// 记录），最终 ≤300 字符（旧实现 out.slice(-300) 语义保持）。
function pnpmErrorTail(stdoutTail, stderrTail) {
  const parse = (tail) => {
    if (!tail) return "";
    const lines = tail.split("\n").filter((s) => s.length > 0).slice(-10);
    return lines.map((ln) => pnpmNdjsonLineToText(ln)).filter((s) => s.length > 0).join("\n");
  };
  // stdout 在前、stderr 在后：join 后 slice(-300) 取末尾窗口，stderr（错误/警告优先级高）
  // 落在截断窗口内不被挤出；stdout 的 ndjson 进度/结构化错误在前段作上下文。
  const parts = [parse(stdoutTail), parse(stderrTail)].filter((s) => s.length > 0);
  return parts.join("\n").slice(-300) || "无输出";
}

// dsh 依赖位置两形态——① 数据目录 dsh-pkg/（Agent pnpm install 按声明部署的轻量分发形态，
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
// pnpm install --reporter=ndjson（按声明 package.json 的 dependencies 拉取，结构化安装进度
// 事件流 → 可读进度行，见下）。不再走 pnpm add @spec 动态安装（T7a 起版本由插件根 package.json
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
  // 安装目标解析（T7a 起）：版本单一事实源 = 插件根 package.json 的 dependencies 声明
  // （@deepseek-ai/dsh 固定版本随插件发版；opts.spec 显式覆盖——工具层 version/tag
  // 参数仍是逃生门；声明缺失时回退配置基线 resolveDshTag 兼容旧版）。
  // 声明版本在读下方部署 package.json 时同步写入（pnpm install 按声明拉取），
  // 不再走 pnpm add @spec 动态安装。
  const declaredDeps = readDeclaredDeps();
  const declaredVersion = readDeclaredDshVersion();
  const effectiveSpec =
    (typeof opts?.spec === "string" && opts.spec.trim() ? opts.spec.trim() : null) ||
    declaredVersion ||
    resolveDshTag(cfg);
  // 注入面校验（vX）：effectiveSpec 会拼成 DSH_PACKAGE + "@" + spec（旧 pnpm add
  // 路径；T7a 后主路径为 pnpm install 按声明拉取，仅 opts.spec 覆盖时才拼 add spec）
  // spec 可能来自工具参数（version/tag）、声明或配置基线 dshTag；未校验时
  // "npm:evil@1.0.0"（npm alias）、“github:user/repo”、“file:../x”、“/abs/path” 等会
  // 让 pnpm add 安装非预期包。校验失败按容错纪律提前返回（不 throw）。
  if (!isValidPkgSpec(effectiveSpec)) {
    return {
      ok: false,
      state: "error",
      error: "非法安装目标: " + effectiveSpec + "（仅允许 SemVer 版本号或 dist-tag）",
    };
  }
  const pkgTarget = DSH_PACKAGE + "@" + effectiveSpec;
  // 子进程 node 解析（每次部署解析一次；wrapper 与 pnpm add 用同一解析结果——自定义
  // nodejsPath 时 wrapper 也指向系统 node，macOS 签名校验问题一并解决）。同时传
  // dataDir（直读 config.json 的 global.nodejsPath，单一事实源）与 cfg.nodejsPath
  // （配置快照兑底：global.nodejsPath 缺失/dev invoke 场景时仍能解析到自定义 node）
  const nodeExec = resolveNodeExec({ dataDir, nodejsPath: cfg.nodejsPath });
  const nodeEnv = resolveNodeExecEnv({ dataDir, nodejsPath: cfg.nodejsPath });
  g.deps.status = "installing";
  g.deps.error = null;
  g.deps.time = new Date().toISOString();
  g.deps.log = "";
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
    // 1. 部署目录 = 数据目录 dsh-pkg（mkdir recursive，不存在则建）
    const pkgDir = join(dataDir, "dsh-pkg");
    mkdirSync(pkgDir, { recursive: true });
    milestone("部署目录就绪：" + pkgDir);
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
      // 幂等跳过前必须运行级重验（CodeRabbit：cliBin 存在 ≠ 依赖图完整——声明版本一致
      // 但运行时包缺失时不能报「已安装成功」；smoke 失败 fall through 走重装流程）。
      const smoke = await verifyDepsSmoke(cfg, { force: true });
      if (smoke && smoke.ok) {
        milestone("已安装 dsh@" + installedVersion + "（与声明一致），跳过安装");
        g.deps.error = null;
        g.deps.result = smoke;
        g.deps.status = "ok";
        return { ok: true, state: "installed", cliBin, skipped: true };
      }
      milestone(
        "已安装 dsh@" +
          installedVersion +
          "（与声明一致）但依赖不完整（" +
          ((smoke && (smoke.error || smoke.stderr)) || "verify 失败") +
          "），走重装流程",
      );
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
    // 2. 部署清单：package.json（dependencies 来自插件根声明，T7a 固定版本随插件
    //    发版，单一事实源）+ 插件根 pnpm-workspace.yaml（allowBuilds 白名单放行
    //    build scripts）。不再写最小空 package.json 以 pnpm add 动态加版本。
    const srcWs = join(PLUGIN_ROOT, "pnpm-workspace.yaml");
    if (!existsSync(srcWs))
      throw new Error("插件根缺少 pnpm-workspace.yaml：" + srcWs);
    // 写 package.json（dependencies 来自声明；opts.spec 覆盖时以 spec 改写 dsh 版本）
    const depPkg = {
      name: "dsh-pkg",
      private: true,
      dependencies: { ...declaredDeps },
    };
    if (effectiveSpec && effectiveSpec !== declaredVersion) {
      depPkg.dependencies["@deepseek-ai/dsh"] = effectiveSpec;
    }
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify(depPkg, null, 2) + "\n");
    copyFileSync(srcWs, join(pkgDir, "pnpm-workspace.yaml"));
    milestone("写 package.json（dependencies 声明）+ pnpm-workspace.yaml 到 " + pkgDir);
    // 3. 创建 node 代理；pnpm 入口 = 运行时引导（lib/pnpm.js ensurePnpm）
    if (IS_WIN) {
      const script = join(pkgDir, "node.cmd");
      const content = `@"${nodeExec}" %*\n`;
      writeFileSync(script, content);
    } else {
      const script = join(pkgDir, "node");
      const content = `#!/bin/sh\nexec "${nodeExec}" "$@"\n`;
      writeFileSync(script, content, { mode: 0o755 });
    }
    milestone("Created proxy node at " + pkgDir);
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
    // ---- npm → pnpm 升级兼容清理 ----
    // 旧版本 dsh-install 用 npm i 部署 dsh-pkg，会留下 package-lock.json 和扁平的
    // node_modules；新版本改用 pnpm install 部署（按声明），若不先清掉旧 npm 结构，会与 pnpm 自己的
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
    // 5. pnpm install 安装目标（参数构造收敛 lib/pnpm.js buildPnpmInstallArgs：按
    //    声明 package.json 的 dependencies 拉取，registry 兜底由调用方只传 URL 意图）；
    //    dependencies 无 devDeps 无需 omit；allowBuilds 放行 build scripts；PATH 首部
    //    指向 pkgDir（代理脚本 node.cmd/node 让 install script 找到宿主 electron node）
    milestone("安装目标：pnpm install（按声明 " + pkgTarget + "）");
    const run = async (registry) => {
      // stdout/stderr 各持独立跨 chunk 行缓冲（pending 行重组 + tail 错误提取）：两条
      // 管道的 chunk 边界互不相关，共用一个缓冲会把不同流的片段拼成一行，破坏 ndjson
      // 行重组（JSON.parse 失败 → 降级为脏文本透传）；错误提取也按流独立解析
      // （pnpmErrorTail(stdoutTail, stderrTail)），避免跨流拼接部分 NDJSON 记录。
      // makePipe 工厂按流各自创建回调。
      const buffers = {
        out: { pending: "", tail: "" },
        err: { pending: "", tail: "" },
      };
      const pkgSizes = new Map(); // fetching-progress 包大小记录（started 事件记 size）
      // pnpm ndjson 输出逐 chunk 实时进统一日志通道（emitLog：内存尾环 ≤DEPS_LOG_CAP
      // + 会话日志 src=pnpm 实时写，行规范化 \r\n/\r → \n）；每行先做 ndjson 解析转
      // 可读进度行（JSON 事件 → "[pnpm] …"，非 JSON 行原样透传，见上方解析区）——取代
      // 旧 --loglevel=http 非结构化输出直写。每次 data 刷新 depsInstallAt——前端 3s 轮询
      // health 随诊断刷新 installLog 尾部，呈现实时进度
      const makePipe = (buf) => (d) => {
        const text = String(d).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        buf.tail = (buf.tail + text).slice(-65536); // 各流独立 capped tail（错误提取用）
        const lines = (buf.pending + text).split("\n");
        buf.pending = lines.pop() ?? ""; // 末段可能是不完整行，留到下个 chunk
        for (const line of lines) {
          if (line === "") continue;
          const readable = pnpmNdjsonLineToText(line, pkgSizes);
          if (readable !== "") emitLog(readable + "\n", "pnpm");
        }
      };
      // 参数构造收敛 lib/pnpm.js buildPnpmInstallArgs（含 --reporter=ndjson；按声明
      // 安装，registry 兜底意图由调用方只传 URL）
      const r = await runPnpm(buildPnpmInstallArgs({ registry }), {
        pnpmCli,
        cwd: pkgDir,
        env: {
          ...nodeEnv,
          PATH: pkgDir + delimiter + (process.env.PATH || ""),
        },
        onStdout: makePipe(buffers.out),
        onStderr: makePipe(buffers.err),
      });
      // 收尾 flush：两条管道各自的残留半行分别处理（互不拼接，见 buffers 注释）
      for (const buf of [buffers.out, buffers.err]) {
        if (buf.pending) {
          const readable = pnpmNdjsonLineToText(buf.pending, pkgSizes);
          if (readable !== "") emitLog(readable + "\n", "pnpm");
        }
      }
      if (r.code !== 0)
        throw new Error(
          "pnpm install 失败 " + DSH_PACKAGE + "（exit " + r.code + "）：" + pnpmErrorTail(buffers.out.tail, buffers.err.tail),
        );
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
    // 部署成功后强制运行级重验（清旧缓存，await 刷新——安装流程本身就是等待场景）；
    // verifyDepsSmoke 会把 g.deps.result 刷新为最新 smoke（含 status running→ok/error）
    g.deps.result = null;
    await verifyDepsSmoke(cfg, { force: true });
    // 安装链路终态 ok（终态保留；verify 若失败其详情在 g.deps.result，不影响安装结论）
    g.deps.status = "ok";
    return { ok: true, state: "installed", cliBin };
  } catch (e) {
    g.deps.error = String(e?.message || e).slice(0, 1500);
    g.deps.status = "error";
    milestone("[失败] " + g.deps.error);
    return { ok: false, state: "error", error: g.deps.error };
  }
}

// ---- 依赖运行级完整性验证（deps 存在性之外的加载冒烟）----
// dsh 是 cordis 生态，模块图挂大量 peer 依赖（dsh-agent/dsh-llm-deepseek/dsh-tool-* 等）：
// pnpm add 中断 / install script 失败未回滚 / --omit=peer 误用都会造成「入口文件在、依赖缺」
// 的假就绪，运行时才抛 ERR_MODULE_NOT_FOUND。文件存在 ≠ 依赖完整。
// 可靠检测 = 运行级验证「node <cliBin> --version」：node 沿 import 图加载整个 cordis 模块树，
// 任何依赖缺失都会抛错且退出码非 0（技能文档「部署后验证 node lib/bin.js --version 应输出
// 0.1.0-rc.6」同款逻辑）。能跑 = 依赖图完整。
// 防并发/防轮询风暴：结果缓存到单例分组 g.deps.result = { ok, version, error, stderr, at,
// running, pnpm* }（v0.24 状态收敛：旧 g.depsSmoke 平铺字段并入 g.deps.result 复合对象）；
// running 标志映射进 g.deps.status === "running"，进行中直接返回当前缓存不重复 spawn
// （spawn 一次 --version 数百 ms，3s 轮询 × 每次 spawn 不可接受，必须缓存 + running 标志）。
// 触发时机：进标签页自动一次 +
// 手动「检测依赖」按钮（经 GET /webui/verify-deps 驱动）/ installDeps 部署成功后强制重验。
// v0.18.2: 叠加 pnpm 引导检查（独立子项）——与 dsh 冒烟并行调 ensurePnpm（幂等：缓存
// 完整直接返回，缺失/损坏自动重新下载自愈），结果记 pnpmReady / pnpmVersion / pnpmError。
// 不进 smoke.ok 的 dsh 依赖就绪判定（web host 启动不依赖 pnpm，patch 已降级）；仅作
// deps 卡片「pnpm 引导：就绪/未就绪」独立展示行。
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
  // pnpm 引导检查（与 dsh 运行级验证并行，互不拖累）：verifyDepsSmoke 虽是运行级
  // 只读检测，但 pnpm 检查允许自愈——ensurePnpm 幂等：缓存完整（sha256 一致）直接
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
    if (!existsSync(cliBin)) throw new Error("cliBin 不存在：" + cliBin);
    slog("开始（cliBin=" + cliBin + "）");
    // spawn node cliBin --version，10s 超时兜底（child.kill）；capture stdout+stderr
    // node 执行体每次 spawn 前解析（自定义 nodejsPath 或默认 Electron node）
    const child = spawn(resolveNodeExec(diagCfg), [cliBin, "--version"], {
      cwd: dirname(cliBin),
      stdio: ["ignore", "pipe", "pipe"],
      env: resolveNodeExecEnv(diagCfg),
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
    // 等 pnpm 检查收尾（自愈下载可能比 dsh 冒烟慢；pnpmTask 内部已 catch，不抛）。
    // 若只 await dsh 冒烟，冷启动首次 verify 会带着 pnpmReady=false 返回，前端展示
    // 「未就绪」误导——自愈路径（删缓存后 verify）须等下载完成再定格结果。
    await pnpmTask;
    smoke.at = new Date().toISOString();
    smoke.running = false;
    // 验证链路终态（ok/error 保留；下次 verify 入口才回到 running）——注意 install 内部
    // 调用本函数后还会把 g.deps.status 置 ok（安装结论优先，verify 详情在 g.deps.result）
    g.deps.status = smoke.ok ? "ok" : "error";
    // error 字段与验证结果同步（ok → 清空；失败 → smoke.error，供诊断展示）
    g.deps.error = smoke.ok ? "" : smoke.error;
  }
  return smoke;
}
