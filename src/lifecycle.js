// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// app/lifecycle.js — dsh web host 生命周期（从 tools/dsh-run.js 分离）
// 原 tools/dsh-run.js（2716 行单文件）混杂两件事：a) web host 生命周期管理（启动/自检/更新/
// provider 跟随 watch + DSH 更新请求轮询），b) dsh 任务提交链路（execute/callUnary/events.mux
// 等）。本次把 a) 的全部函数原样搬入本模块，让 dsh-run.js 瘦身为纯任务提交流程模块 +
// 经本模块转发生命周期能力。
//
// 本模块承载（逐字迁移自 dsh-run.js，逻辑零改动）：
//   web host 拉起    ensureWebHost（进程内 boot dsh + 端口就绪等待，幂等）+ startWebHostFromPlugin（挂 g.startWebHost）
//   关闭回收         closeProcess（先清 provider/update watch，再 kill 子进程）
//   连接失败自检     collectWebDiagnostics + buildDepsDiagCheck + buildProcessDiagCheck + pickProcessFix
//   更新 DSH         updateDsh（停 host → 装依赖 → 起 host → 读版本，结果走内存态 g.update）
//   watch           ensureProviderPushWatch（provider 热跟随 watch）
//   provider 路由     detectHostProviderPaths / readJsonFile / mapModel / readHostConfig / buildProviderRoutes
//                    → pushProviderRoutes（总线 emit provider.refresh，替代 HTTP push）
//   config 引导       config.json 初始化/升级已收敛进 src/migrate.js（config-schema 步骤），
//                    本模块经 runMigrations 统一调度（startWebHostFromPlugin 调 config-schema；
//                    junction 收敛同样迁入 migrate.js，ensureWebHost 调 junction-converge）
//   web host 日志     logTs / appendLog / logFileStamp / newWebLogPath（兜底实现）
// 单例挂载（globalThis.__dshHanako，经 getSingleton()）：g.closeProcess / g.collectDiagnostics /
// g.updateDsh / g.startWebHost / g.installDeps / g.verifyDeps / g.checkDshUpdate 均在本模块顶层完成
// （installDeps/verifyDeps/checkDshUpdate 直接引用 lib/install.js & lib/check.js）；g.runMigrations
// 由 src/migrate.js 顶层挂载（本模块 import 时即挂好）。routes/webui.js、index.js、tools/dsh-*.js
// 仍经 globalThis 单例调用，不受影响。
//
// 分发形态与理由：本模块被 index.js（bundle 收敛入口，单 bundle 形态）与 tools/dsh-run.js 静态
// import，随 rspack 单 bundle 内联进 dist/index.js（build.mjs 的 staticUrlToMeta 递归收集 ROOT 下
// 全部 .js 路径做 import.meta.url 替换）。src/migrate.js 同样经本模块静态 import 内联；index.js
// 不静态 import migrate.js（避免 Node ESM 固定 URL 缓存读到旧模块），经 globalThis 单例
// （g.runMigrations）调用——与 g.startWebHost / g.closeProcess 同纪律。本文件自身的 ../tools/lib/*
// 引用随 bundle 内联，无固定 URL 缓存问题。
//
// 语义不变：ensureWebHost 重复调用幂等；web host 进程随插件 onload/卸载生命周期拉起/回收
// （index.js register 回收调用 g.closeProcess）；providerPushCleanup / updateWatchCleanup 清理时机与
// 拆分前一致；updateDsh 流程（停 host→装依赖→起 host→读版本）保持完整；collectWebDiagnostics 输出的
// checks 结构（t1 依赖 / t2 进程）令 routes/webui.js 渲染不变。
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
// dsh profile 名解析（vX：dshana profile 路线，boot --profile 用配置；config.js 内联进 bundle）
import { resolveProfileName } from "./tools/lib/config.js";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  cpSync,
  lstatSync,
  realpathSync,
  symlinkSync,
  rmSync,
  rmdirSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
// 共用模块（lib 内联进 dsh-run bundle，见文件头「分发形态」）：
import {
  getSingleton,
  PLUGIN_ROOT,
  manifestDefaults,
} from "./tools/lib/state.js";
// vX（migrate 体系退役）：不再有版本迁移入口（junction-converge / config-schema 等全丢）
import {
  resolveDshPkgDir,
  installDepsFromPlugin,
  verifyDepsSmoke,
  readDshInstalledVersion,
} from "./tools/lib/install.js";
import { connectBus, closeBus, setBusConfigProvider } from "./lib/bus.js";

const STDERR_CAP = 8192;
const PORT_READY_TIMEOUT_MS = 60000; // web host 端口就绪等待上限
// ---- 统一日志（时间戳会话文件，index.js onload 初始化）----
// 当前会话日志 = <dataDir>/logs/<YYYYMMDD-HHmmss-SSS>.log 时间戳会话文件——DSHana 插件
// 全量运行日志（index.js 生命周期 + web host 进程 stdout/stderr + @dsh-hanako/provider
// 诊断 + dsh-run 工具关键路径）；旧日志由 index.js onload zstd 压缩为 .log.zst 全部保留。
// 本模块只把 stdout/stderr 写入 logPath（单例 g.logPath 优先），并保留兜底初始化
// （index.js 未初始化时自建时间戳会话文件）。
// 行格式 [<HH:mm:ss.SSS>] [<src>] <内容>，src ∈ out/err/provider/hana/npm；写失败静默。
function logTs() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
// 追加日志（行规范化，与 index.js appendLogLine 同规范——这里是兜底实现，index.js
// 未初始化时用）：\r\n / 裸 \r 统一折行，逐行加 [ts] [src] 前缀、空行丢弃；chunk 内
// 所有行共用同一时间戳（单次 append）。跨 chunk 的半行按 chunk 边界拆行（诊断可接受）。
function appendLog(logPath, src, chunk) {
  try {
    if (!logPath) return;
    mkdirSync(dirname(logPath), { recursive: true });
    const lines = String(chunk ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    if (!lines.length) return;
    const ts = logTs();
    appendFileSync(
      logPath,
      lines.map((l) => `[${ts}] [${src}] ${l}`).join("\n") + "\n",
      "utf8",
    );
  } catch {
    /* 日志失败不阻断 */
  }
}
function logFileStamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  const p3 = (n) => String(n).padStart(3, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p3(d.getMilliseconds())}`;
}
// 兜底初始化：index.js onload 未初始化（冷启动边缘）时建时间戳会话文件（与 index.js
// 同命名约定，后续 onload 会把它当作旧日志 zstd 压缩）；不归档不压缩——属于 index.js
// 插件会话边界逻辑，避免重复
function newWebLogPath(dataDir) {
  const logsDir = join(dataDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const stamp = logFileStamp(new Date());
  let target = join(logsDir, stamp + ".log");
  let i = 1;
  while (existsSync(target)) {
    i += 1;
    target = join(logsDir, stamp + "-" + i + ".log");
  }
  try {
    writeFileSync(target, "", "utf8");
  } catch {
    /* 建文件失败不阻断 */
  }
  return target;
}
// 宿主 provider 路径探测：不再暴露 hostProvider 配置项，直接探测宿主数据目录。
// 候选 ① process.env.HANA_HOME 宿主进程注入（最权威：宿主进程恒注入，dev 源码/安装形态均成立）；
// ② 插件安装形态 <宿主数据目录>/plugins/<pluginId> 上溯两级（仅安装形态成立）；
// ③ 标准 home <用户主目录>/.hanako。按存在性逐项验证命中；全部未命中取候选 ②
// 构造（@dsh-hanako/provider 读不到会 warn 停用，不影响主流程）。
function detectHostProviderPaths() {
  const fromPlugin = dirname(dirname(PLUGIN_ROOT));
  const candidates = [
    process.env.HANA_HOME,
    fromPlugin,
    join(homedir(), ".hanako"),
  ].filter(Boolean);
  let modelsPath = null;
  let catalogPath = null;
  for (const dir of candidates) {
    if (!modelsPath && existsSync(join(dir, "models.json")))
      modelsPath = join(dir, "models.json");
    if (!catalogPath && existsSync(join(dir, "provider-catalog.json")))
      catalogPath = join(dir, "provider-catalog.json");
    if (modelsPath && catalogPath) break;
  }
  return {
    modelsPath: modelsPath || join(fromPlugin, "models.json"),
    catalogPath: catalogPath || join(fromPlugin, "provider-catalog.json"),
  };
}
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 32768;
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const THINKING_FORMATS = [
  "openai",
  "openrouter",
  "deepseek",
  "together",
  "zai",
  "qwen",
  "chat-template",
  "qwen-chat-template",
  "string-thinking",
  "ant-ling",
];
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// ---- 宿主 provider 直读（只读两文件，不写不改；从子进程整体迁移，逐字复制不改逻辑）----
function readJsonFile(path) {
  if (!existsSync(path)) return { value: null, error: `文件不存在：${path}` };
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")), error: null };
  } catch (e) {
    return { value: null, error: `JSON 解析失败：${e?.message || e}` };
  }
}

// compat 映射（定稿表）：Hana 模型条目 → pi-ai Model 字段
function mapModel(raw, api) {
  const m = raw && typeof raw === "object" ? raw : {};
  const compat = m.compat && typeof m.compat === "object" ? m.compat : {};
  const out = {
    id: String(m.id || ""),
    name: String(m.name || m.id || ""),
    input: Array.isArray(m.input)
      ? m.input.filter((x) => x === "text" || x === "image")
      : ["text"],
    contextWindow:
      Number.isInteger(m.contextWindow) && m.contextWindow > 0
        ? m.contextWindow
        : DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      Number.isInteger(m.maxTokens) && m.maxTokens > 0
        ? m.maxTokens
        : DEFAULT_MAX_TOKENS,
    reasoning: m.reasoning === true,
  };
  // defaultThinkingLevel → pi-ai thinking 级别（直通，非法值丢弃保解析不炸）
  if (
    typeof m.defaultThinkingLevel === "string" &&
    THINKING_LEVELS.includes(m.defaultThinkingLevel)
  ) {
    // 宿主词汇归一：宿主侧把 xhigh 归一目为 max 档（host eT），dsh 侧同样归一
    out.defaultThinkingLevel =
      m.defaultThinkingLevel === "xhigh" ? "max" : m.defaultThinkingLevel;
  }
  // 思考强度列表口径对齐宿主 h$()（Hana host bundle 的 VH/h$/bI）：
  //   宿主列表 = 显式 thinkingLevels || mj([off,medium,high])，xhigh:true → 追加 max；
  //   宿主词汇无 minimal（minimal/low 不进入列表，host Hme 集只认 off/low/medium/high/
  //   xhigh/max）。用 pi-ai 的 thinkingLevelMap 复刻：minimal/low → null（列表裁剪，
  //   见 pi-ai getSupportedThinkingLevels 的 mapped===null 排除），xhigh:true → max
  //   映射（xhigh 在宿主侧即为 max 档）。efforts 列表随 getSupportedThinkingLevels
  //   自动对齐：off/medium/high（无 xhigh）或 off/medium/high/max（xhigh）；请求层
  //   reasoning_effort 同样经 thinkingLevelMap 直通（max → "max"）。
  if (m.reasoning === true) {
    const tlm = { minimal: null, low: null };
    if (m.xhigh === true) tlm.max = "max";
    out.thinkingLevelMap = tlm;
  }
  // compat 映射仅对 openai-completions 协议生效（pi-ai 其余协议无这些开关）
  if (api === "openai-completions") {
    const c = {};
    if (
      typeof compat.thinkingFormat === "string" &&
      THINKING_FORMATS.includes(compat.thinkingFormat)
    ) {
      c.thinkingFormat = compat.thinkingFormat;
    }
    if (m.xhigh === true) c.supportsReasoningEffort = true;
    // supportsDeveloperRole 必须直通（勿丢）：pi-ai openai-completions 在
    // model.reasoning && compat.supportsDeveloperRole 时把 system 提示发成
    // developer role，未传时回退检测值（标准模型默认 true）——sensenova 等
    // 厂商 API 只认 system，Hana 配置里的 supportsDeveloperRole:false 就是要
    // 压住它；丢了会 400（实测 "developer is not one of [...]"）
    if (typeof compat.supportsDeveloperRole === "boolean") {
      c.supportsDeveloperRole = compat.supportsDeveloperRole;
    }
    if (Object.keys(c).length > 0) out.compat = c;
  }
  // 丢弃：reasoningProfile / reasoningReplay /
  // hanaVideoInput / hanaAudioInput（不进入 pi-ai Model）
  return out;
}

// 读两文件 → route 目录（纯数据，不依赖 pi-ai）
function readHostConfig(modelsPath, catalogPath) {
  const result = { routes: [], skipped: [], errors: [] };
  const modelsFile = readJsonFile(modelsPath);
  if (modelsFile.error) {
    result.errors.push(`models.json：${modelsFile.error}`);
    return result;
  }
  const catalogFile = readJsonFile(catalogPath);
  if (catalogFile.error) {
    result.errors.push(`provider-catalog.json：${catalogFile.error}`);
    return result;
  }
  const providers = modelsFile.value && modelsFile.value.providers;
  const creds = (catalogFile.value && catalogFile.value.providers) || {};
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    result.errors.push("models.json 缺少 providers 对象");
    return result;
  }
  for (const [id, p] of Object.entries(providers)) {
    if (!p || typeof p !== "object") {
      result.skipped.push({ id, reason: "条目非对象" });
      continue;
    }
    // 凭据规则：models.json 的 apiKey 是引用，实际 api_key 从 catalog 对应条目直读；
    // catalog 缺失的 provider 跳过并记日志（openai-codex / xai-oauth 即此情形）
    const cred = creds[id];
    const apiKey =
      cred && typeof cred.api_key === "string" ? cred.api_key.trim() : "";
    if (!apiKey) {
      result.skipped.push({
        id,
        reason: "provider-catalog.json 无凭据（api_key）",
      });
      continue;
    }
    const baseURL = String(p.baseUrl || (cred && cred.base_url) || "").trim();
    if (!baseURL) {
      result.skipped.push({ id, reason: "baseURL 为空" });
      continue;
    }
    const api =
      String(p.api || (cred && cred.api) || "").trim() || "openai-completions";
    if (
      ![
        "openai-completions",
        "openai-responses",
        "anthropic-messages",
      ].includes(api)
    ) {
      result.skipped.push({
        id,
        reason: `协议 ${api} 不支持（本插件仅 openai-completions/openai-responses/anthropic-messages）`,
      });
      continue;
    }
    const models = (Array.isArray(p.models) ? p.models : [])
      .map((m) => mapModel(m, api))
      .filter((m) => m.id);
    if (models.length === 0) {
      result.skipped.push({ id, reason: "models 列表为空" });
      continue;
    }
    result.routes.push({
      id,
      displayName: id,
      baseURL,
      api,
      apiKey,
      // 补全 pi-ai Model 必需字段（协议/归属/端点/成本），与 dsh-llm-pi-ai 的
      // resolveRouteModels 同一姿势
      models: models.map((m) => ({
        ...m,
        api,
        provider: id,
        baseUrl: baseURL,
        cost: NO_COST,
      })),
    });
  }
  return result;
}

// ---- 宿主侧 provider 路由组装（B方案：解析逻辑上移宿主侧）----
// 背景：子进程不再读宿主两文件/不做组装，这些函数上移宿主侧；子进程只接受组装好的
// route 目录。THINKING_LEVELS/THINKING_FORMATS/NO_COST 随映射函数一并上移。组装链路：
// detectHostProviderPaths → readJsonFile → mapModel → readHostConfig → buildProviderRoutes
// 缓存最新目录（读取失败保留旧 routes）。组装结果经 HTTP push（body 带 routes）传子进程。
// 注：mapModel 用到的 DEFAULT_CONTEXT_WINDOW/DEFAULT_MAX_TOKENS 常量随迁移上移。
function buildProviderRoutes() {
  const g = getSingleton();
  const host = detectHostProviderPaths();
  const result = readHostConfig(host.modelsPath, host.catalogPath);
  if (result.routes.length === 0 && result.errors.length > 0) {
    const prev = Array.isArray(g.latestProviderRoutes)
      ? g.latestProviderRoutes
      : [];
    if (prev.length > 0) {
      console.warn(
        "[dsh-run] 读取宿主 provider 配置失败，保留上次 routes：" +
          result.errors.join("；"),
      );
      return { routes: prev, skipped: result.skipped, errors: result.errors };
    }
    console.warn(
      "[dsh-run] 读取宿主 provider 配置失败（无上次缓存）：" +
        result.errors.join("；"),
    );
    return result;
  }
  g.latestProviderRoutes = result.routes;
  return result;
}
// ---- dshana profile 挂载：目录链接 → PLUGIN_ROOT/cordis（替代拷贝落位）----
// vX（dshana profile 路线）：子插件与服务层全部收敛进 dshana profile，进程内 boot 只带
// --profile（默认 dshana）。dsh 的 loadProfile 要求 $DSH_HOME/profiles/<name> 存在且含
// package.json（dsh.profile.bundles），空目录会直接抛「profile does not exist」。
// 挂载方式：$DSH_HOME/profiles/dshana 建目录链接指向插件目录 cordis/（打包产物 =
// PLUGIN_ROOT/cordis，见 build.mjs buildCordis）——单一事实源（插件更新即 profile
// 更新，零拷贝零漂移），dsh 的 loadProfile 对目录链接透明（node fs 直读）。
// 平台：Windows 用 directory junction（免管理员权限），非 Windows 用目录 symlink
// （type=dir，无需特权）；两者 lstat isSymbolicLink / realpath 语义一致，幂等检查通用。
// 幂等：目标是链接且指向源目录时不动；非链接 / 指向过期则重建（删实体目录或旧链接，
// 重新建链接）。源缺失记 warn 不阻断——若 profile 缺失 dsh 侧会再报，最终由诊断引导修复。
// 注：链接指向插件安装目录（宿主升级插件会整体替换该目录），重建时机 = 每次
// web host boot 前（ensureDshanaProfile），插件升级后首次拉起自动重建链接。
const PROFILE_NAME = "dshana";
export function ensureDshanaProfile(cfg) {
  const g = getSingleton();
  // 仅 dshana profile 路线需要挂载：配置改回官方 profile（如 web）时不挂载，
  // 走官方 bundle（dsh 自动 initProfile）；dshana 才需要插件自带的 profile 材料。
  if (resolveProfileName(cfg) !== PROFILE_NAME) return;
  const dshHome = join(cfg.dataDir, "dsh-home");
  const srcRoot = join(PLUGIN_ROOT, "cordis");
  const destRoot = join(dshHome, "profiles", PROFILE_NAME);
  if (!existsSync(join(srcRoot, "package.json"))) {
    g.appendLog?.(
      "hana",
      `[cordis] profile 源缺失：${srcRoot}（插件未打包 cordis/ 或安装不完整）`,
    );
    return;
  }
  // 已是正确链接：跳过（零拷贝，无内容比对）
  try {
    const stat = lstatSync(destRoot);
    if (stat.isSymbolicLink()) {
      const resolved = realpathSync(destRoot);
      if (resolved === realpathSync(srcRoot)) return;
    }
  } catch {
    /* 不存在或无法 stat：重建 */
  }
  // 非链接 / 指向过期：先删旧目标（实体目录或旧链接），再建链接
  try {
    if (existsSync(destRoot)) {
      const stat = lstatSync(destRoot);
      if (stat.isSymbolicLink()) {
        // 旧链接（指向过期源）：rmdir 删链接本身，不递归（防误删链接目标）
        rmdirSync(destRoot);
      } else {
        // 旧实体目录（历史拷贝落位残留）：整体删除后重建链接
        rmSync(destRoot, { recursive: true, force: true });
      }
    }
  } catch (e) {
    g.appendLog?.(
      "hana",
      `[cordis] 旧 profile 清理失败：${(e && e.message) || e}（跳过重建）`,
    );
    return;
  }
  try {
    mkdirSync(dirname(destRoot), { recursive: true });
    // 平台差异：Windows 用 directory junction（免管理员权限创建目录链接）；
    // 非 Windows（Linux/macOS）用目录符号链接（symlink type=dir，无需特权）。
    // 两者对 node fs 透明（lstat isSymbolicLink / realpath 均成立），幂等检查通用。
    if (process.platform === "win32") {
      symlinkSync(srcRoot, destRoot, "junction");
    } else {
      symlinkSync(srcRoot, destRoot, "dir");
    }
    g.appendLog?.(
      "hana",
      `[cordis] dshana profile 链接（${process.platform === "win32" ? "junction" : "symlink"}）-> ${srcRoot}`,
    );
  } catch (e) {
    // 链接建立失败（跨盘/权限等）：回退拷贝落位（旧行为，保证 profile 可用）
    g.appendLog?.(
      "hana",
      `[cordis] profile 链接失败（${(e && e.message) || e}），回退拷贝落位`,
    );
    try {
      cpSync(srcRoot, destRoot, { recursive: true, force: true });
      g.appendLog?.("hana", `[cordis] dshana profile 落位（拷贝回退）-> ${destRoot}`);
    } catch (e2) {
      g.appendLog?.(
        "hana",
        `[cordis] profile 落位失败：${(e2 && e2.message) || e2}`,
      );
    }
  }
}

// ---- web host 生命周期：进程内 boot dsh（T7b 方案 A；spawn 形态已整体退役）----
// dsh 依赖位置解析（resolveDshPkgDir）已提取到 lib/install.js——数据目录
// dsh-pkg/ 优先（Agent npm i @deepseek-ai/dsh 部署的轻量分发形态），插件安装目录
// node_modules 兑底（现役 zip 自带形态）。DSH_HOME 恒在数据目录。
// 唯一形态 = 宿主进程内 runProfile() boot dshana（webserver 保留在进程内 bind 端口）。
// 诊断/安装面仍保留 spawn（verifyDepsSmoke 冒烟 + pnpm install 子进程——D6 解耦：
// 诊断与工具包不 import cordis/pnpm，见 lib/install.js / lib/pnpm.js）。

// ---- T7b 进程内 boot：dsh 模块动态定位（解耦 D6）----
// dsh 包不在插件 node_modules（数据目录 dsh-pkg），且 profile-boot-*.js 是带构建
// hash 的产物名（bin.js 按 hash 动态 import）——不能硬编码文件名，枚举 lib 目录试出
// 导出 runProfile 的候选（probe-inproc 验证过的定位方式）。
// app-boot 经 createRequire 从 dsh 包视角解析：pnpm 严格结构下 @deepseek-ai/dsh-app-boot
// 是 dsh 的间接依赖，不在顶层 node_modules——createRequire 沿 dsh 包的 .pnpm 依赖链
// 解析，比枚举 .pnpm 目录稳（不依赖 pnpm 内部布局）。
// 返回 { profileBoot, bootEntry, appBoot, appBootEntry }：profileBoot 提供 runProfile，
// appBoot 提供 loadLayeredEnv。
// 加载方式 = CJS require（Node ≥22.12 支持 require(esm)：dsh 入口为 ESM 但静态图同步
// 可加载、无顶层 await，实测 runProfile/loadLayeredEnv 可直接访问）。选 require 而非
// import 的原因：CJS require 的模块缓存 key = realpath（含 .pnpm 哈希目录），dsh 升级
// 哈希变 → 旧 key 自动失效、下次 require 即加载新版——天然穿透宿主进程内缓存，无需
// 指纹/清理手段；而 ESM 动态 import 的缓存 key = 提供的 URL（symlink 顶层路径跨版本
// 稳定，曾致升级后热重载命中旧 dsh 模块，boot 读已删除的旧 .pnpm 路径报 ENOENT）。
// require 对运行时绝对路径无 rspack 静态分析问题（import(expr) 需 webpackIgnore 规避，
// require 调用原样保留）。
function loadInprocDsh(pkgDir) {
  const dshPkgLink = join(pkgDir, "node_modules", "@deepseek-ai", "dsh");
  if (!existsSync(join(dshPkgLink, "package.json"))) {
    throw new Error(
      `DSH 包未就绪：${dshPkgLink} 不存在。请在 DSHana 标签页执行「安装依赖」（pnpm install 按声明拉取到 dsh-pkg），或手动在插件数据目录 dsh-pkg 执行 pnpm install`,
    );
  }
  // createRequire 基准 = dsh 包（symlink 路径，沿插件根 node_modules 链解析 app-boot；
  // 加载候选为绝对路径时基准不影响）。libDir 用 symlink 路径可读，cache key 恒 realpath。
  const dshReq = createRequire(join(dshPkgLink, "package.json"));
  const libDir = join(dshPkgLink, "lib");
  // ① profile-boot：枚举 lib 下 profile-boot-*.js，逐个 require 试 runProfile
  let profileBoot = null;
  let bootEntry = null;
  let tried = 0;
  try {
    for (const f of readdirSync(libDir)) {
      if (!f.startsWith("profile-boot-") || !f.endsWith(".js")) continue;
      const abs = join(libDir, f);
      tried += 1;
      try {
        const m = dshReq(abs);
        if (m && typeof m.runProfile === "function") {
          profileBoot = m;
          bootEntry = abs;
          break;
        }
      } catch {
        /* 单个候选加载失败：继续试下一个（dsh 版本演进产物名变化） */
      }
    }
  } catch (e) {
    throw new Error(
      `无法枚举 dsh profile-boot 模块（${libDir}）：${e?.message || e}`,
    );
  }
  if (!profileBoot) {
    throw new Error(
      `dsh 包无可用 profile-boot 模块（lib 下已检查 ${tried} 个 profile-boot-*.js）`,
    );
  }
  // ② app-boot 定位（双保险）：
  //    a) createRequire 从 dsh 包（symlink）视角解析（标准 pnpm 布局：沿插件根
  //       node_modules 链，CodeRabbit 核过——realpath 基准从 .pnpm 深处向上可能找不到，
  //       symlink 基准必然命中）；
  //    b) 失败回退 .pnpm 虚拟存储枚举（手工/自定义链接树布局兑底）。
  //    resolve/枚举结果直接 require：cache key 为 realpath（.pnpm 哈希目录），随 dsh
  //    版本自动失效，无需显式 realpath 指纹。
  let appBootEntry = null;
  try {
    appBootEntry = dshReq.resolve("@deepseek-ai/dsh-app-boot");
  } catch {
    // 回退 .pnpm 枚举
    appBootEntry = null;
  }
  if (appBootEntry === null) {
    const pnpmDir = join(pkgDir, "node_modules", ".pnpm");
    let found = null;
    try {
      for (const d of readdirSync(pnpmDir)) {
        if (!d.startsWith("@deepseek-ai+dsh-app-boot@")) continue;
        const candidate = join(
          pnpmDir,
          d,
          "node_modules",
          "@deepseek-ai",
          "dsh-app-boot",
          "lib",
          "index.js",
        );
        if (existsSync(candidate)) {
          found = candidate;
          break;
        }
      }
    } catch {
      /* 枚举失败（.pnpm 不存在等）：保持 null */
    }
    appBootEntry = found;
  }
  if (appBootEntry === null) {
    throw new Error(
      `无法解析 @deepseek-ai/dsh-app-boot（dsh 依赖缺失？createRequire 与 .pnpm 枚举均未命中）`,
    );
  }
  const appBoot = dshReq(appBootEntry);
  if (typeof appBoot.loadLayeredEnv !== "function") {
    throw new Error(
      `@deepseek-ai/dsh-app-boot 缺 loadLayeredEnv 导出（${appBootEntry}）`,
    );
  }
  return { profileBoot, bootEntry, appBoot, appBootEntry };
}

// ---- T7b 进程内 boot：进程级 env 管理 ----
// 进程内形态 dsh 与宿主同进程：boot 前把 DSH_HOME / DSHANA_BUS_SECRET 写入
// process.env（dsh 侧 loadProfile / resolveDshHome / bridge 凭据读同一 env，
// 与 spawn 注入子进程 env 语义等价），dispose 后恢复原值（不留污染）。
let inprocEnv = null; // { DSH_HOME?, DSHANA_BUS_SECRET? } 原值快照（undefined = 未设置）
function setInprocEnv(dshHome, busSecret) {
  inprocEnv = {
    DSH_HOME: process.env.DSH_HOME,
    DSHANA_BUS_SECRET: process.env.DSHANA_BUS_SECRET,
  };
  process.env.DSH_HOME = dshHome;
  process.env.DSHANA_BUS_SECRET = busSecret;
}
function restoreInprocEnv() {
  if (!inprocEnv) return;
  const prev = inprocEnv;
  inprocEnv = null;
  for (const k of ["DSH_HOME", "DSHANA_BUS_SECRET"]) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
}

// ---- 总线免鉴权握手探测（vX：适配 dsh 0.1.2+ token 鉴权）----
// dsh 0.1.2-alpha.2 起对 HTTP API（/api/host.describe 等）加 token 鉴权，无 token
// 请求返回 401/403；但 /api/dshana.bus 总线 hello 仍免鉴权（本机信任通道，patch
// bridge 注册）——HTTP 探测收到 401/403 时用 WS 握手（hello → hello-ok）判定就绪。
// 临时连接用完即关；注意 bridge 凭据方法（launchToken/authCookie）要求 hello 帧携带
// spawn 注入的共享秘密（DSHANA_BUS_SECRET）且 bridge 保持单连接语义——probe 的
// hello 必须带同样的 secret，否则会挤掉常驻 connectBus 连接并关闭凭据 gate
// （credAuthed=false，凭据 RPC 拒绝直到 bus.js 重连）。
// 失败 resolve(false)（不抛），由调用方按容错纪律继续等待/超时。
function probeBusReady(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let sock;
    let done = false;
    let timer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        sock?.close();
      } catch {
        /* 已关闭 */
      }
      resolve(ok);
    };
    try {
      sock = new WebSocket("ws://127.0.0.1:" + port + "/api/dshana.bus");
    } catch {
      finish(false);
      return;
    }
    timer = setTimeout(() => finish(false), timeoutMs);
    sock.addEventListener("open", () => {
      try {
        const g = getSingleton();
        const secret = g?.busSecret || "";
        sock.send(
          JSON.stringify({ channel: "hello", payload: secret ? { secret } : {} }),
        );
      } catch {
        /* send 失败由 close/error 兜底 */
      }
    });
    sock.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const f = JSON.parse(ev.data);
        if (f && f.channel === "hello-ok") finish(true);
      } catch {
        /* 非 JSON 帧忽略 */
      }
    });
    sock.addEventListener("close", () => finish(false));
    sock.addEventListener("error", () => finish(false));
  });
}

// ---- CJS 模块缓存清理（防御兜底：require 解析残留穿透）----
// loadInprocDsh 改 require 加载后，dsh 树主穿透靠 require 的 realpath cache key（升级哈希
// 变 → 旧 key 自动失效）。此处清理为防御兜底：覆盖 dsh 树内其他 CJS 依赖（symlink 路径
// 解析 / 宿主 preserve-symlinks 边缘 / 历史残留），定向删除 Module._pathCache 与
// require.cache 中含插件根 node_modules / dsh-home 的条目，require 链下次解析重新走磁盘、
// 命中当前 .pnpm 哈希目录（实测曾致：升级热重载后 require.resolve 命中旧 .pnpm 路径，
// readFileSync ENOENT）。全清 _pathCache 亦可（纯解析结果缓存，无模块实例，重建零风险）；
// 此处定向删含插件路径的条目，克制不扰宿主其他模块缓存。清理失败不阻断（残留仅致下次
// 升级热重载跑旧解析路径，重启兑底）。
function clearDshRequireCaches(pkgDir, dataDir) {
  try {
    const mod = createRequire(import.meta.url)("module");
    const hits = [String(pkgDir || ""), join(String(dataDir || ""), "dsh-home")]
      .filter(Boolean)
      .map((p) => p.toLowerCase());
    if (hits.length === 0) return;
    // Module._pathCache：key = 内部解析缓存键，value = 解析出的绝对路径；
    // 命中插件根 / dsh-home 的条目删除（key 与 value 都查，覆盖两种形态）
    const pc = mod._pathCache;
    if (pc && typeof pc === "object") {
      for (const key of Object.keys(pc)) {
        const probe = String(key) + "\n" + String(pc[key] || "");
        if (hits.some((p) => probe.toLowerCase().includes(p))) delete pc[key];
      }
    }
    // require.cache（Module._cache）：删除插件根与 dsh-home 下已加载的 CJS 模块
    // （模块实例随引用释放；dsh 旧 ctx 已 dispose，此处清除后下次 require 全新加载）
    const cache = mod._cache;
    if (cache && typeof cache === "object") {
      for (const key of Object.keys(cache)) {
        if (hits.some((p) => key.toLowerCase().includes(p))) delete cache[key];
      }
    }
  } catch {
    /* 缓存清理失败不阻断 boot */
  }
}

export async function ensureWebHost(cfg) {
  const g = getSingleton();
  if (g.web?.ready) return g.web;
  if (g.web?.readyPromise) {
    try {
      return await g.web.readyPromise;
    } catch {
      /* 启动失败：清掉允许重试 */ g.web = null;
    }
  }
  if (g.web?.ctx) {
    // 旧实例启动失败过：清掉重建（进程内形态 dispose）
    try {
      await g.web.ctx?.fiber?.dispose();
    } catch {
      /* 已退出 */
    }
    g.web = null;
  }
  if (!cfg.dshPkgDir) cfg.dshPkgDir = resolveDshPkgDir(cfg);

  // CJS require 缓存定向清理（dsh 升级免重启第二层）：见 clearDshRequireCaches 定义注释。
  // 放 dshPkgDir 解析后、boot 前——每次拉起都清，首次空转无害；boot 失败重试同样幂等。
  clearDshRequireCaches(cfg.dshPkgDir, cfg.dataDir);

  const pkgDir = cfg.dshPkgDir;
  const dshHome = join(cfg.dataDir, "dsh-home");
  // 总线共享秘密（bridge 凭据保护）：每次 web host 拉起随机生成——进程内形态 boot 前
  // 写 process.env.DSHANA_BUS_SECRET（同进程共享，bridge 读）；重启即换新 secret。
  g.busSecret = randomUUID();
  mkdirSync(cfg.dataDir, { recursive: true });
  const port = Number(cfg.webPort) || 3080;
  // 当前会话日志 = 时间戳会话文件（index.js onload 已初始化单例 g.logPath）。
  // 单例优先；index.js 未初始化（冷启动边缘）时兜底自建。写进 web/logLastExit/错误消息供诊断。
  const logPath = g.logPath || newWebLogPath(cfg.dataDir);
  // 启动前确保 dshana profile 已落位（dist/cordis → $DSH_HOME/profiles/dshana），
  // 否则 dsh loadProfile 会抛「profile does not exist」。
  ensureDshanaProfile(cfg);
  return bootInproc(cfg, { pkgDir, dshHome, port, logPath });
}
// ---- T7b：进程内 boot dsh（动态 import + runProfile，webserver 保留在进程内 bind）----
async function bootInproc(cfg, { pkgDir, dshHome, port, logPath }) {
  const g = getSingleton();
  const emitLog = (src, d) => {
    if (typeof g.appendLog === "function") g.appendLog(src, d);
    else appendLog(logPath, src, d);
  };
  const web = {
    processMode: "inproc",
    port,
    dshHome,
    logPath,
    ready: false,
    stderr: "",
    readyPromise: null,
    // T7b 进程内形态字段：ctx/shutdown（runProfile 返回）、disposed（回收标记）、bootError
    ctx: null,
    shutdown: null,
    disposed: false,
    bootError: null,
  };
  // 进程内形态：dsh 与宿主同进程——boot 前把 DSH_HOME / DSHANA_BUS_SECRET 写入
  // process.env（dsh 侧 loadProfile / resolveDshHome / bridge 凭据读同一 env，
  // 与 spawn 注入子进程 env 语义等价），dispose 后恢复（见 closeProcess / restoreInprocEnv）。
  setInprocEnv(dshHome, g.busSecret);
  const readyPromise = (async () => {
    try {
      const { profileBoot, bootEntry, appBoot, appBootEntry } = await loadInprocDsh(pkgDir);
      emitLog("hana", `[dsh web] 进程内 boot dsh（profile-boot=${bootEntry}，app-boot=${appBootEntry}）`);
      const environment = appBoot.loadLayeredEnv("dsh");
      const profile = resolveProfileName(cfg);
      emitLog("hana", `[dsh web] runProfile({ profile: "${profile}", port: ${port} }) ...`);
      const r = await profileBoot.runProfile({
        environment,
        profile,
        patchFiles: [],
        args: ["--port", String(port), "--no-open"],
      });
      web.ctx = r.ctx;
      web.shutdown = r.shutdown;
      emitLog("hana", `[dsh web] 进程内 boot 完成（ctx=${!!r.ctx} shutdown=${typeof r?.shutdown}，webserver ${port} 存活）`);
      // 就绪探测必须与 boot 同 try：就绪失败（超时/握手失败）时 web.ctx 仍持有
      // 进程内 cordis 树 + 占用端口——不回收则 g.web 被 ensureWebHost 清掉后引用
      // 丢失，重试必 EADDRINUSE 直到重启 Hana（CodeRabbit Major：spawn 路径可杀子进程
      // 自愈，进程内路径必须显式 dispose）。
      return await waitWebReady(web, port, emitLog, cfg);
    } catch (e) {
      web.bootError = e;
      web.stderr = String(e?.stack || e?.message || e).slice(0, STDERR_CAP);
      emitLog("err", `[dsh web] 进程内 boot 失败：${web.stderr}`);
      // 回收：就绪失败或 boot 失败都要 dispose 进程内 cordis 树（释放 HTTP server /
      // 端口），并恢复改写过的进程级 env（DSH_HOME / DSHANA_BUS_SECRET）——否则
      // g.web 摘除后 ctx 引用丢失，端口永久占用。
      try {
        await web.ctx?.fiber?.dispose();
      } catch (e2) {
        try {
          g.appendLog?.("hana", "[dsh web] 进程内 boot 失败回收 dispose 异常：" + (e2?.message || e2));
        } catch {
          /* 日志失败不阻断 */
        }
      }
      web.ctx = null;
      web.disposed = true;
      restoreInprocEnv();
      throw e;
    }
  })();
  web.readyPromise = readyPromise;
  g.web = web;
  return readyPromise;
}

// 等端口就绪（HTTP /api/host.describe 直连 + WS 总线握手，任一通过即 markReady）。
// 进程内形态：快速失败检查读 web.bootError（bootInproc 记录）。就绪后 markReady 返回 web 对象。
async function waitWebReady(web, port, emitLog, cfg) {
  const g = getSingleton();
  const deadline = Date.now() + PORT_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // 进程内 boot 失败：立即抛出（bootError 由 bootInproc 记录）
    if (web.bootError) {
      throw new Error(
        `DSH 进程内 boot 失败：${web.bootError.message || web.bootError}（完整日志：${web.logPath}）`,
      );
    }
    try {
      // web host 就绪探测保留 HTTP 直连（/api/host.describe，一次性启动握手）：发生在
      // connectBus 之前——总线还没连上，总线化是鸡生蛋；Unary RPC 指令面已收敛进总线
      // （callUnaryBus），此处只做端口就绪探测，不进总线。
      const r = await fetch(`http://127.0.0.1:${port}/api/host.describe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId: "probe",
          method: "host.describe",
          payload: {},
        }),
        signal: AbortSignal.timeout(2000),
      });
      // 就绪标记（HTTP 直连或总线握手任一通过即调用）：connectBus / config 下发 /
      // provider push 收敛在同一就绪点（connectBus 幂等 + 内部退避重连，失败不阻断）。
      const markReady = () => {
        web.ready = true;
        // 新进程就绪：清掉上次退出记录（持久字段只反映最近一次退出）
        g.webLastExit = null;
        // dshana.bus 消息总线：同一就绪点连接（bridge 段随 patch 挂载，子插件注册了
        // /api/dshana.bus upgrade 路由）。connectBus 幂等 + 内部退避重连（连接失败不阻断
        // dsh 启动——更新请求信道降级：settings 报「消息总线未连接」，check-version 走 dsh 侧
        // 直查不受影响）。不 await，页面/任务不阻塞。
        try {
          connectBus({ webPort: port });
          // bus.ready 补推接线（幂等，只挂一次）：总线连接成功后如有待补推 routes
          // 立即补推（connectBus 是异步建连，pushProviderRoutes 在握手前调用必然
          // 未送达记 pending——补推监听必须与 connectBus 同一就绪点挂上，否则工具
          // 路径（ensureWebHost）不经过 startWebHostFromPlugin 时待补推永不到达）。
          wireProviderPushOnBusReady();
          // config 下发 provider（替代 patch config 注入）：hello-ok 后自动发 config 帧
          // （dshPkgDir/dataDir），settings/provider 子插件经 dshanaBus.getConfig() 取路径。
          // 每次握手重发，覆盖 web host 重启后新 bridge 实例。
          setBusConfigProvider(() => ({
            dshPkgDir: cfg.dshPkgDir || resolveDshPkgDir(cfg),
            dataDir: cfg.dataDir,
          }));
        } catch (e) {
          g.appendLog?.("hana", "[dshana.bus] 连接失败：" + (e?.message || e));
        }
        // provider 路由推送走总线（替代 /api/hana-provider.refresh HTTP push，任务 G）：
        // 唯一新进程就绪点主动推一次最新 routes（任意 spawn 路径都保证有初始 push）；
        // bus 未连接（hello-ok 未到）时记待补推，bus.ready 后自动补推——覆盖连接窗口期。
        pushProviderRoutes();
        return web;
      };
      if (r.ok) return markReady();
      // 端口已有响应（401/403/404/500 等）= web 进程已活：0.1.2+ HTTP API 加
      // token 鉴权（无 cookie 401）且端点路径有变（host.describe 404），无 token
      // 探测无法再靠 HTTP 判定就绪；总线 hello 免鉴权（本机信任通道），握手判定。
      if (await probeBusReady(port)) {
        return markReady();
      }
    } catch {
      /* 未就绪，继续等 */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `DSH web 启动超时（${Math.round(PORT_READY_TIMEOUT_MS / 1000)}s 内端口 ${port} 未就绪）：${web.stderr.slice(-1200) || "无 stderr"}（完整日志：${web.logPath}）`,
  );
}


// ---- 宿主侧 provider 跟随 push 链路（fs.watch → ctx.resources.watch + 总线 push）----
// 语义：@dsh-hanako/provider 插件不再自建 fs.watch（Windows rename 原子替换等平台坑一并消除）——
// 宿主侧经 ctx.resources.watch 感知 models.json / provider-catalog.json 变化（bus 派发
// resource.changed，resourceKey 格式 local_fs:<path>），防抖 300ms（与旧实现同 DEBOUNCE
// 语义）后经 dshana.bus 消息总线 emit("provider.refresh", { routes }) 推送最新 route 目录
// （v0.22.1+ 替代 POST /api/hana-provider.refresh HTTP push——HTTP push 链路已退役，
// 总线为进程间唯一通道），dsh 侧插件收到事件重读配置 refresh()（handle.replace 原子更新）。
// watch 建立失败降级不阻断（dsh 侧启动时仍会 refresh 一次，功能不受影响）。
// 幂等：startWebHost 重复调用 / web host 重建时先清理旧 watch 再建；cleanup 挂单例
// g.providerPushCleanup，closeProcess 回收 web host 时调用（退订 bus + 关 watchers）。
const PROVIDER_SYNC_DEBOUNCE_MS = 300;
// provider 路由推送（总线版）：组装最新 route 目录（buildProviderRoutes）→
// g.dshanaBus.emit("provider.refresh", { routes })。bus 未连接（hello-ok 未到）时记待补推
// 标志，bus.ready（本机事件）后自动补推最新 routes——覆盖「web host 就绪点早于 bus 握手」
// 的连接窗口期；子进程侧 @dsh-hanako/provider 监听 provider.refresh 事件执行 refresh()。
// 幂等：任意时刻调用都基于最新组装结果（读取失败保留旧 routes，见 buildProviderRoutes）；
// 失败不阻断（下轮配置变化/重启仍会触发）。
let providerPushPending = false; // bus 未连接期间待补推标志（模块级单例）
function pushProviderRoutes() {
  const g = getSingleton();
  const bus = g.dshanaBus;
  if (!bus || typeof bus.emit !== "function") {
    providerPushPending = true;
    return;
  }
  let host;
  try {
    host = buildProviderRoutes();
  } catch (e) {
    // routes 组装异常（防御性）：本轮 push 放弃，下轮配置变化/重启再试
    try {
      g.appendLog?.("hana", "[dsh-run] provider routes 组装失败，本轮 push 放弃：" + (e?.message || e));
    } catch {
      /* 日志失败不阻断 */
    }
    return;
  }
  const delivered = bus.emit("provider.refresh", { routes: host.routes });
  if (delivered) {
    providerPushPending = false;
    try {
      g.appendLog?.("hana", "[dsh-run] provider 路由已经总线推送（" + host.routes.length + " 条 routes）");
    } catch {
      /* 日志失败不阻断 */
    }
    console.log("[dsh-run] provider 路由已经总线推送（" + host.routes.length + " 条 routes）");
  } else {
    // 未送达（bus 未连接/未握手）：记待补推，bus.ready 后自动补推
    providerPushPending = true;
    try {
      g.appendLog?.("hana", "[dsh-run] provider 路由总线推送未送达（bus 未连接），标记待补推");
    } catch {
      /* 日志失败不阻断 */
    }
  }
}
// bus.ready 补推接线（幂等，只挂一次）：总线连接成功后如有待补推 routes 立即补推。
// 另订阅 dsh 侧 provider 插件的 provider.refresh.request 就绪握手（CodeRabbit 时序意见）：
// 子插件订阅建立后显式请求重放最新 routes——覆盖「宿主首批 push 早于子插件订阅建立」
// 的窗口（loadDeps/effect 未完成时首批 provider.refresh 事件丢失，provider 卡
// empty-snapshot）。收到请求即重推（pushProviderRoutes 内部未送达记 pending，
// bus.ready 后自动补推，无需在此重复判 pending）。
let providerPushWired = false;
function wireProviderPushOnBusReady() {
  if (providerPushWired) return;
  providerPushWired = true;
  const g = getSingleton();
  if (g.dshanaBus && typeof g.dshanaBus.on === "function") {
    g.dshanaBus.on("provider.refresh.request", () => {
      pushProviderRoutes();
    });
    g.dshanaBus.on("bus.ready", () => {
      if (providerPushPending) {
        providerPushPending = false;
        pushProviderRoutes();
      }
    });
  }
}
function ensureProviderPushWatch(cfg) {
  const g = getSingleton();
  // 幂等：先清理旧 watch + 退订（startWebHost 重复调用 / web host 重建时）
  if (typeof g.providerPushCleanup === "function") {
    try {
      g.providerPushCleanup();
    } catch {
      /* 清理失败不阻断 */
    }
    g.providerPushCleanup = null;
  }
  const resources = g.resources;
  const bus = g.dshanaBus;
  // resources/bus 缺失（旧宿主无此服务 / onload 未注入）：降级不阻断
  if (!resources || typeof resources.watch !== "function") {
    console.warn(
      "[dsh-run] 宿主 resources 不可用，provider 热跟随 watch 未建立（DSH 侧启动时仍会 refresh 一次）",
    );
    return;
  }
  if (!bus || typeof bus.subscribe !== "function") {
    console.warn(
      "[dsh-run] 宿主 bus 不可用，provider 热跟随订阅未建立（DSH 侧启动时仍会 refresh 一次）",
    );
    return;
  }
  const hostProvider = detectHostProviderPaths();
  const paths = [hostProvider.modelsPath, hostProvider.catalogPath].filter(
    Boolean,
  );
  const handles = [];
  const resourceKeys = new Set();
  let timer = null;
  const triggerPush = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      pushProviderRoutes();
    }, PROVIDER_SYNC_DEBOUNCE_MS);
  };
  for (const path of paths) {
    try {
      const handle = resources.watch(
        { kind: "local-file", path },
        { purpose: "@dsh-hanako/provider-sync" },
      );
      handles.push(handle);
      // watch 返回 { subscriptionId, resourceKeys, unsubscribe, close }：resourceKeys 即
      // 事件过滤键（格式 local_fs:<path>）；无 resourceKeys 时按约定格式兜底
      if (
        Array.isArray(handle?.resourceKeys) &&
        handle.resourceKeys.length > 0
      ) {
        for (const key of handle.resourceKeys) resourceKeys.add(key);
      } else {
        resourceKeys.add(`local_fs:${path}`);
      }
    } catch (e) {
      // watch 建立失败：降级不阻断（dsh 侧启动时仍会 refresh 一次）
      console.warn(
        `[dsh-run] provider 热跟随 watch 建立失败 ${path}（${e?.message || e}），该文件变化将不触发 push`,
      );
    }
  }
  if (handles.length === 0) {
    console.warn(
      "[dsh-run] provider 热跟随 watch 全部建立失败（DSH 侧启动时仍会 refresh 一次）",
    );
    return;
  }
  // bus.subscribe 返回 unsubscribe 函数（SDK 类型 () => void）；防御性兼容 { unsubscribe } 形状
  const unsub = bus.subscribe((event) => {
    if (!event || typeof event !== "object") return;
    if (event.type !== "resource.changed") return;
    const key = event.resourceKey;
    if (typeof key === "string" && resourceKeys.has(key)) {
      console.log(`[dsh-run] 宿主配置变化（${key}），防抖后总线推送 DSH 刷新`);
      triggerPush();
    }
  });
  g.providerPushCleanup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    for (const handle of handles) {
      try {
        handle?.unsubscribe?.();
      } catch {
        /* 已关闭 */
      }
    }
    handles.length = 0;
    resourceKeys.clear();
    if (typeof unsub === "function") {
      try {
        unsub();
      } catch {
        /* 退订失败忽略 */
      }
    } else if (unsub && typeof unsub.unsubscribe === "function") {
      try {
        unsub.unsubscribe();
      } catch {
        /* 退订失败忽略 */
      }
    }
    g.providerPushCleanup = null;
  };
  console.log(
    `[dsh-run] provider 热跟随 watch 已建立（${paths.length} 文件），宿主配置变化将总线推送 DSH 刷新`,
  );
}
// ---- DSH 检查能力（checkDshUpdate / npmViewDistTags / semver 比较 / 本地版本
// 直读已提取到 lib/check.js + lib/install.js，经 getSingleton 挂 g.checkDshUpdate 供
// Agent 工具 dsh_install / DSHana 标签页 webui 路由两面共用，单一事实源；
// 设置页「DSH 版本」卡片 v0.18.1 起由 dsh 侧 @dsh-hanako/settings 直查远端，不经此通道）----
function emitBus(channel, payload) {
  try {
    const g = getSingleton();
    if (g.dshanaBus && typeof g.dshanaBus.emit === "function") g.dshanaBus.emit(channel, payload);
  } catch {
    /* 总线 emit 失败不阻断 */
  }
}

// 单例挂载：index.js 不 import 本文件（避免模块缓存），onload 时通过单例拉起 web host。
// 构建 cfg（manifest 默认 + 用户配置 + dataDir/dshPkgDir fallback）后调 ensureWebHost。
// 失败不抛出（onload 不能被 dsh 启动失败阻塞），由工具调用时的 ensureWebHost 重试。
getSingleton().startWebHost = async function startWebHostFromPlugin(
  ctxConfig,
  ctxDataDir,
) {
  const cfg = { ...manifestDefaults };
  for (const [k, v] of Object.entries(ctxConfig || {})) {
    if (v !== undefined && v !== null && v !== "") cfg[k] = v;
  }
  cfg.dataDir = ctxDataDir || join(PLUGIN_ROOT, "data");
  // vX（migrate 体系退役）：不再自动生成 config.json / 清理 update-result / 超时键迁移——
  // 配置读取侧（resolve*）缺省回退兜底，旧配置照常读取；新装无 config.json 时用默认值。
  // 单例记数据目录（dsh_session 经 g.dataDir 定位 dsh 会话缓存等数据文件）
  getSingleton().dataDir = cfg.dataDir;
  if (!cfg.dshPkgDir) cfg.dshPkgDir = resolveDshPkgDir(cfg);
  try {
    await ensureWebHost(cfg);
    // web host 就绪后建立宿主侧 provider 跟随 push watch（幂等：先清理旧 watch 再建）
    ensureProviderPushWatch(cfg);
    // bus.ready 补推接线（幂等）：总线连接成功后如有待补推 routes 立即补推
    wireProviderPushOnBusReady();
    // 首批 provider 的初始 push 已收敛进 ensureWebHost（唯一就绪点，bus 就绪后自动
    // 送达或待补推），此处不再重复推；后续每次 resource.changed 经防抖 watch 增量 push。
    // DSH 更新请求 v0.22.1 起由子插件经 dshana.bus 消息总线直投（connectBus 已
    // 在同一就绪点建立连接），/child/post 反向信道已退役，无宿主侧轮询/文件。
    return true;
  } catch (e) {
    // 记录失败原因供诊断（onload 侧只能看到布尔）；后续工具调用重试
    const g = getSingleton();
    g.webLastError = String(e?.message || e).slice(0, 1500);
    if (g.web?.stderr)
      g.webLastError += `\n[dsh web stderr] ${g.web.stderr.slice(-800)}`;
    // 失败也记日志路径（诊断界面可跳完整日志；g.web 在启动失败后可能已摘除，
    // 从 webLastExit 取兜底）
    const logPath = g.web?.logPath || g.webLastExit?.logPath || null;
    if (logPath) g.webLastLogPath = logPath;
    g.webLastErrorAt = new Date().toISOString();
    // web host 启动失败：通知壳页就绪事件流推诊断（routes/webui.js 注册回调，
    // 诊断对象由 readDiagnostics 收集；无订阅者 no-op）
    if (typeof g.notifyWebStartFailed === "function") {
      try {
        g.notifyWebStartFailed();
      } catch {
        /* 通知失败不阻断 */
      }
    }
    return false;
  }
};

// installDepsFromPlugin / verifyDepsSmoke 已提取到 lib/install.js（本文件顶部
// import），这里显式挂单例（getSingleton 本体在 lib/state.js 不再逐函数赋值；mountSingleton
// 与 lib 侧挂载保持同款幂等语义）。routes/webui.js 经 g.installDeps / g.verifyDeps 调用。
getSingleton().installDeps = installDepsFromPlugin;
getSingleton().verifyDeps = verifyDepsSmoke;
// ---- 连接失败自检（插件页 web host 未就绪时的诊断数据源）----
// 供 routes/webui.js 使用（经单例 globalThis.__dshHanako.collectDiagnostics 挂载，
// 不静态 import 本模块——Hana 带 ?t= 加载 tools，静态 import 会命中 Node ESM 固定
// URL 缓存读到旧模块，见文件头注释；与 index.js 经单例取 closeProcess 同一套纪律）。
// web host 未就绪时逐项检查：① dsh 依赖（resolveDshPkgDir + cliBin 存在性）② DSH 进程状态（单例 web /
// webLastError / stderr 尾部）。只回布尔与截断文本；单例/字段缺失（冷启动、
// web 从未拉起）全部容错，本函数永不抛异常。
export function collectWebDiagnostics(cfg = {}) {
  const out = {
    port: Number(cfg.webPort) || 3080,
    checks: [],
  };
  try {
    // 数据目录解析链：显式传入 → 单例记录（onload/工具已写入）→ 从 web.dshHome 反推
    const g = getSingleton();
    const dataDir =
      cfg.dataDir ||
      g.dataDir ||
      (g.web?.dshHome ? dirname(g.web.dshHome) : "");
    const diagCfg = { ...cfg, dataDir };
    // 不再自动触发运行级检测（去掉 maybeTriggerDepsSmoke）——检测改为「进标签页
    // 自动一次 + 手动「检测依赖」按钮」，经 GET /webui/verify-deps 路由驱动；g.deps.result
    // 只存最近一次检测结果供诊断展示（不随 3s 轮询重复 spawn）。
    out.checks.push(buildDepsDiagCheck(g, diagCfg));
    out.checks.push(buildProcessDiagCheck(g, out));
  } catch (e) {
    // 顶层兜底：诊断读取本身异常时回退成「未知」项，接口不抛
    out.checks.push({
      key: "unknown",
      name: "自检异常",
      ok: false,
      detail: String(e?.message || e).slice(0, 400),
      fix: "请查看 Hana 日志或重启 Hana 后重试",
    });
  }
  return out;
}

/** ① dsh 依赖：cliBin 存在性（resolveDshPkgDir 同款：数据目录 dsh-pkg 优先，插件根兑底）
 * v0.8.6: 叠加部署状态——g.deps.status（installing 进行中）/ g.deps.error（上次失败）/ g.deps.log
 * v0.8.7: 叠加运行级完整性验证——g.deps.result（verifyDepsSmoke 缓存 { ok, version, error, stderr, at, running }）。
 * v0.24: 单例分组结构化——g.deps = { status, result, error, time, log }、g.update =
 * { status, result, error, time, log }、g.check = { status, result, error, time, log }
 * （旧平铺字段全废；update-result.json 退役，updateResult 改内存态组合）。
 * v0.13.0: 叠加版本/检查/更新状态——version（当前版本）、check（最近一次 checkDshUpdate
 * 缓存：latest/updateAvailable/at/error）、checking/updating（进行中）、updateResult
 * （内存态：g.update.status + g.update.result.version）——deps 卡片版本行 + 「检查更新」
 * 「更新 DSH」按钮数据源。
 * ok 判定升级：存在 且（未验证/验证中视为暂通过，验证过必须通过）——文件存在 ≠ 依赖完整。 */
function buildDepsDiagCheck(g, cfg) {
  const pkgDir = resolveDshPkgDir(cfg);
  const cliBin = join(
    pkgDir,
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "lib",
    "bin.js",
  );
  // 候选位置全列出，未命中时讲清「查了哪些位置」（resolveDshPkgDir 只回命中/兑底那一个）
  const candidates = [];
  if (cfg.dataDir) candidates.push(join(cfg.dataDir, "dsh-pkg"));
  candidates.push(PLUGIN_ROOT);
  const checked = [
    ...new Set(
      candidates.map((p) =>
        join(p, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      ),
    ),
  ];
  const installed = existsSync(cliBin);
  // 部署状态（installDeps 写入单例分组 g.deps；只回非敏感布尔与截断文本）
  const installing = g.deps.status === "installing";
  const installError = String(g.deps.error || "").slice(0, 300);
  const installLog = String(g.deps.log || "").slice(-800);
  const installAt = g.deps.time || null; // 最近一次 npm i 输出时间（实时进度）
  // 运行级验证状态（verifyDepsSmoke 缓存于 g.deps.result；非敏感：布尔/版本号/截断错误文本）
  const smoke = g.deps.result || null;
  const verifyRunning = Boolean(smoke?.running);
  const verified = installed && smoke ? Boolean(smoke.ok) : null; // null = 未安装/未验证过（暂通过）
  const verifyError =
    smoke && !smoke.ok && !smoke.running
      ? String(smoke.error || smoke.stderr || "").slice(0, 400)
      : null;
  const verifyVersion = smoke?.version ?? null;
  const verifyAt = smoke?.at ?? null;
  // pnpm 引导状态（独立子项，不进 ok 判定）：透出 verifyDepsSmoke 的 pnpm 检查结果
  // （pnpmReady/pnpmVersion/pnpmError；smoke 未生成过 → checked=false，前端不渲染该行）。
  // 仅 DSHana 标签页 deps 卡片展示（settings「检查与更新 DSH」卡片不展示 pnpm 状态——
  // 用户决策：远端版本查询已改 HTTP 直查，settings 侧不关心 pnpm 引导）。
  const pnpmChecked = Boolean(smoke);
  const pnpmReady = Boolean(smoke?.pnpmReady);
  const pnpmVersion = smoke?.pnpmVersion || null;
  const pnpmError = smoke?.pnpmError
    ? String(smoke.pnpmError).slice(0, 300)
    : null;
  // 当前版本（运行级验证缓存优先，无则直读 dsh-pkg package.json）+ 版本检查
  // 状态（g.check.result 缓存：最近一次 checkDshUpdate 结果）+ 更新状态（g.update.status /
  // g.update.error + 内存态 updateResult，v0.24 起不再读 update-result.json）。
  // 只回非敏感布尔/版本号/截断文本。
  const currentVersion =
    (smoke && !smoke.running && smoke.ok ? smoke.version : null) ||
    readDshInstalledVersion(cfg) ||
    null;
  const checkResult = g.check.result || null;
  const checking = g.check.status === "running";
  const updating = g.update.status === "running";
  const updateError = String(g.update.error || "").slice(0, 300);
  // 更新结果内存态组合（v0.24：update-result.json 退役，不再读文件；状态 + 终态版本 +
  // 错误 + 时间，version 更新终态优先、依赖验证缓存兜底）
  // 状态值域映射：g.update.status（idle/running/ok/error）→ 诊断对外契约值
  // （done/updating/error；webui-shell.jinja2 按 state === "done" 渲染完成文案）
  const updateState =
    { ok: "done", running: "updating" }[g.update.status] || g.update.status;
  const updateResult = {
    state: updateState,
    version: g.update.result?.version || g.deps.result?.version || null,
    error: g.update.error || null,
    at: g.update.time || null,
  };
  // ok：存在 且（未验证/验证中暂通过；验证过必须通过）——验证失败 → ok=false
  const ok = installed && (!smoke || smoke.ok || smoke.running);
  const check = {
    key: "deps",
    name: "DSH 依赖安装",
    ok,
    installed,
    installing,
    verified,
    verifyRunning,
    verifyError,
    verifyVersion,
    verifyAt,
    installError: installError || null,
    installLog: installLog || null,
    installAt,
    pkgDir,
    cliBin,
    // 版本/检查/更新状态（deps 卡片版本行 + 检查更新/更新 DSH 按钮）
    version: currentVersion,
    check: {
      latest: checkResult?.latestVersion ?? null,
      updateAvailable: Boolean(checkResult?.updateAvailable),
      at: checkResult?.at || null,
      error: String(checkResult?.error || "").slice(0, 300) || null,
    },
    checking,
    updating,
    updateError: updateError || null,
    updateResult,
    // pnpm 引导状态（独立子项，不进 ok 判定；见上方 pnpmChecked 注释）
    pnpmChecked,
    pnpmReady,
    pnpmVersion,
    pnpmError,
    detail: "",
    fix: "",
  };
  if (installing) {
    // 安装中（含重装场景 installed 仍可能为 true）优先——实时进度
    // installLog 尾部由前端 .diag-progress 展示（随轮询刷新）
    check.detail = "正在安装依赖…（npm i，进度见下方）";
    check.fix = "";
  } else if (!installed) {
    // 未安装：保持现有文案
    check.detail =
      "未找到 DSH 包：" +
      cliBin +
      " 不存在" +
      (checked.length > 1 ? "（已检查 " + checked.join("、") + "）" : "");
    if (installError) check.detail += "\n[上次安装失败] " + installError;
    check.fix =
      "依赖缺失：点击本卡片「安装依赖」按钮自动在插件数据目录 dsh-pkg 执行 pnpm install（按声明拉取，完成后自动验证）；或确认插件目录 node_modules 解压完整";
  } else if (!smoke) {
    // 未检测过（进标签页自动检测一次 / 手动「检测依赖」；ok 暂算 installed）
    check.detail = "DSH 包已就绪，点击「检测依赖」验证依赖完整性";
  } else if (verifyRunning) {
    // 检测进行中：ok 暂 true，结果由检测接口返回后刷新
    check.detail = "正在检测依赖完整性…";
  } else if (!smoke.ok) {
    // 存在但验证失败：依赖图不完整（ERR_MODULE_NOT_FOUND 等真实错误）
    check.detail =
      "DSH 包存在但依赖不完整：" +
      (verifyError ? "\n" + verifyError : "运行级验证失败");
    check.fix =
      "点击本卡片「重新安装依赖」按钮重新执行 pnpm install（按声明拉取，自动部署到 dsh-pkg，完成后自动验证）";
  } else {
    // 存在 + 验证通过：能跑 = 依赖图完整
    check.detail =
      "DSH 包已就绪（运行级验证通过，版本 v" +
      (currentVersion || smoke?.version || "?") +
      "）：" +
      cliBin;
  }
  return check;
}

/** ② DSH 进程：单例 web 状态（child/exitCode/ready/stderr 尾部）+ webLastError/webLastErrorAt + webLastExit
 * v0.8.5: webLastExit 为单例持久退出记录（进程被外部杀掉时 g.web 已摘除，凭它区分
 * 「已退出」而非误报「尚未启动」）；只在 ensureWebHost 成功拉起新进程（ready）时清掉。 */
function buildProcessDiagCheck(g, out) {
  const web = g.web || null;
  const child = web?.child || null;
  // T7b 进程内形态：无子进程——「存活」= boot 完成且未 shutdown（disposed 标记）
  const inproc = web?.processMode === "inproc";
  const lastExit = g.webLastExit || null; // 持久退出记录：{ code, signal, at, stderr, logPath } | null
  const started = Boolean(web || g.webLastError || lastExit);
  const alive = inproc
    ? Boolean(web && !web.disposed)
    : Boolean(child && child.exitCode === null);
  const ready = Boolean(web?.ready);
  const exitCode = inproc ? null : child?.exitCode ?? lastExit?.code ?? null;
  const stderr = String(web?.stderr || lastExit?.stderr || "").slice(-800); // stderr 尾部截断 ≤800
  const lastError = String(g.webLastError || "").slice(-800);
  const lastErrorAt = g.webLastErrorAt || "";
  // 本次会话日志路径（当前 web / 退出记录 / 失败记录，三级兜底）
  const logPath = web?.logPath || lastExit?.logPath || g.webLastLogPath || null;
  const check = {
    key: "process",
    name: "DSH 进程状态",
    ok: started && ready && alive,
    started,
    alive,
    ready,
    exitCode,
    stderr,
    lastError,
    lastErrorAt,
    logPath, // 完整日志路径（界面展示「本次会话日志」）
    lastExit, // 结构化退出记录（非敏感），供前端/调试
    detail: "",
    fix: "",
  };
  const port = out.port;
  if (!started) {
    // 从未启动：无 web / webLastError / webLastExit（冷启动或从未拉起过）
    check.detail =
      "web host 尚未启动（插件加载即拉起，可能仍在初始化，或从未成功启动过）";
    check.fix =
      "稍候自动重试；若持续未就绪，可点击本卡片「手动启动 web host」按钮重新拉起，或检查上方依赖项";
  } else if (ready && alive) {
    // 已就绪但探测未命中（端口短暂不可达等）：仍提示重试
    check.detail =
      (inproc ? "进程内 boot 已就绪，但端口 " : "进程运行中且已就绪，但端口 ") +
      port +
      " 探测未命中（可能短暂不可达）";
    check.fix = "稍候自动重试；若持续未就绪，检查端口是否被其他程序占用";
  } else if (alive) {
    check.detail =
      (inproc
        ? "进程内 boot 完成，端口 " + port + " 尚未就绪"
        : "进程运行中，端口 " + port + " 尚未就绪") +
      (stderr ? "\n[stderr 尾部] " + stderr : "");
    check.fix =
      "正在启动，请稍候自动重试；若长时间未就绪，检查端口是否被占用，或重启 Hana";
  } else if (lastExit) {
    // 进程曾运行后退出/被外部杀掉：展示持久退出记录（g.web 已摘除，stderr 从 lastExit 取）。
    // code/signal 可能为 null（Windows 杀进程无 signal、信号杀进程无 code）：只列非空项
    const codeTxt =
      lastExit.code !== null && lastExit.code !== undefined
        ? "code=" + lastExit.code
        : null;
    const sigTxt =
      lastExit.signal !== null && lastExit.signal !== undefined
        ? "signal=" + lastExit.signal
        : null;
    const exitTxt =
      codeTxt || sigTxt
        ? [codeTxt, sigTxt].filter(Boolean).join(" ")
        : "code=? signal=?";
    check.detail =
      "进程已退出（" +
      exitTxt +
      "，时间 " +
      lastExit.at +
      "）" +
      (lastExit.stderr ? "\n[stderr 尾部] " + lastExit.stderr : "");
    check.fix = "点击本卡片「手动启动 web host」按钮重新拉起，或重启 Hana";
  } else {
    // 启动失败（webLastError）：展示失败原因（其已含 stderr 尾部）+ 修复指引
    check.detail = lastError
      ? "启动失败：" + lastError
      : "进程已退出（code=" +
        (exitCode ?? "?") +
        "）" +
        (stderr ? "\n[stderr 尾部] " + stderr : "");
    check.fix = pickProcessFix(lastError, stderr, port);
  }
  return check;
}

/** 进程失败修复指引：按失败原因内容匹配（依赖 / 端口占用），兜底通用建议。
 * 同时匹配 webLastError 与 stderr 尾部——端口占用等错误常只出现在 stderr（进程退出时
 * webLastError 可能未携带 stderr 尾部，见「进程已退出」分支）。 */
function pickProcessFix(lastError, stderr, port) {
  const text = (lastError || "") + "\n" + (stderr || "");
  if (/dsh 包未就绪|DSH 包未就绪|cliBin|npm i/i.test(text)) {
    return "按上方「DSH 依赖安装」项修复（数据目录 dsh-pkg 执行 pnpm install，按声明拉取，完成后自动验证）";
  }
  if (/EADDRINUSE|address already in use|占用|bind/i.test(text)) {
    return "检查端口 " + port + " 是否被占用（释放后重启 Hana）";
  }
  return "检查上方依赖项；仍失败请重启 Hana 后重试";
}

export async function closeProcess() {
  const g = getSingleton();
  // 先清理 watch/轮询 + 消息总线（provider 热跟随 + dshana.bus 客户端），再回收 web host 进程
  if (typeof g.providerPushCleanup === "function") {
    try {
      g.providerPushCleanup();
    } catch {
      /* 清理失败不阻断 */
    }
  }
  // dshana.bus 主动关闭（插件卸载 / updateDsh 停 host 时）：置 stopFlag 不再重连，
  // 下次 connectBus（web host 就绪点）复位重连。关闭失败不阻断回收。
  try {
    closeBus();
  } catch {
    /* 总线关闭失败不阻断 */
  }
  const web = g.web;
  g.web = null;
  if (web?.ctx) {
    // T7b 进程内形态：await ctx.fiber.dispose() 释放 dsh cordis 树（HTTP server +
    // loader + 全部插件）。不用 runProfile 返回的 shutdown 控制器：其 shutdown() 会写
    // process.exitCode、interrupt() 会 process.exit 直接杀宿主进程（createProcessShutdown
    // 为独立 CLI 设计）；ctx.fiber.dispose() 与控制器内部 dispose 同源，进程内无副作用。
    // 必须 await：进程内不能像 kill 一样 fire-and-forget，否则端口未释放、重载 EADDRINUSE。
    web.disposed = true;
    try {
      await web.ctx?.fiber?.dispose();
    } catch (e) {
      try {
        g.appendLog?.("hana", "[dsh web] 进程内 shutdown dispose 失败：" + (e?.message || e));
      } catch {
        /* 日志失败不阻断 */
      }
    }
    // 恢复 boot 时改写过的进程级 env（DSH_HOME / DSHANA_BUS_SECRET）
    restoreInprocEnv();
  }
}
// ---- 单例挂载（原 tools/dsh-run.js 的 mountSingleton 迁入本模块；g.startWebHost 已在上方
// startWebHostFromPlugin 处单独赋值，这里只挂其余生命周期能力——closeProcess / collectDiagnostics /
// updateDsh / installDeps / verifyDeps / checkDshUpdate）。routes/webui.js、index.js、tools/dsh-*.js 均经
// globalThis 单例调用，不静态 import 本模块（见文件头「分发形态」）。
const mountLifecycle = () => {
  const g = getSingleton();
  g.closeProcess = closeProcess;
  g.collectDiagnostics = collectWebDiagnostics;
  g.installDeps = installDepsFromPlugin;
  g.verifyDeps = verifyDepsSmoke;
  return g;
};
mountLifecycle();
