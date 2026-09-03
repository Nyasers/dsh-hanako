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
//   更新 DSH         updateDsh（停 host → 装依赖 → 起 host → 读版本，结果走内存态 g.update）
//   watch           ensureProviderPushWatch（provider 热跟随 watch）
//   provider 路由     detectHostProviderPaths / readJsonFile / mapModel / readHostConfig / buildProviderRoutes
//                    → pushProviderRoutes（总线 emit provider.refresh，替代 HTTP push）
//   config 引导       config.json 初始化/升级已收敛进 src/migrate.js（config-schema 步骤），
//                    本模块经 runMigrations 统一调度（startWebHostFromPlugin 调 config-schema；
//                    junction 收敛同样迁入 migrate.js，ensureWebHost 调 junction-converge）
//   web host 日志     logTs / appendLog / logFileStamp / newWebLogPath（兜底实现）
// 单例挂载（globalThis.__dshHanako，经 getSingleton()）：g.closeProcess /
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
// 拆分前一致；updateDsh 流程（停 host→装依赖→起 host→读版本）保持完整。（T5：旧诊断壳
// checks 结构已随 collectWebDiagnostics 家族退役，自举状态出口 = GET /webui/boot-state）
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
// dsh profile 名解析（vX：dshana profile 路线，boot --profile 用配置；config.js 内联进 bundle）
import { resolveProfileName } from "./tools/lib/config.js";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
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
} from "./tools/lib/install.js";
// dshana profile 运行时种子化/迁移/scope 链接（lib 提取，ensureDshanaProfile 调用；
// 种子模板为独立文件 src-cordis/seed（构建期复制 dist/cordis/seed）；设计
// specs/current/dshana-profile-bundle/spec.md）：
import { ensureProfileSeeded } from "./lib/profile-seed.js";
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
// ---- dshana profile 运行时初始化（真实目录 + scope 链接，替代整树 junction）----
// vX（dshana-profile-bundle 重构，spec：specs/current/dshana-profile-bundle/spec.md
// D1/D2/D4/D5）：profile 目录改为运行时初始化的用户自有真实目录（用户可自装插件），
// 不再整树 junction 挂插件产物。产物 = scope 树（dist/cordis/**，
// 含 bundle @dsh-hanako/dshana 与 8 子插件，见 build.mjs buildCordis）：
//   profileDir = $DSH_HOME/profiles/dshana：官方 initProfile 生成（manifest
//   dsh.profile.bundles=[@deepseek-ai/dsh-base, @dsh-hanako/dshana]、用户层
//   cordis.patch.yml 模板、pnpm-workspace.yaml；cordis.yml 空根由 dsh boot 自维护）+
//   node_modules/@dsh-hanako 单条 scope 目录链接 → PLUGIN_ROOT/cordis。
// 初始化/迁移/链接幂等逻辑收敛在 lib/profile-seed.js（ensureProfileSeeded，纯路径
// 逻辑便于测试）；本函数只做 profile 名门控 + 路径定位 + 官方 initProfile 注入
// （loadInprocDsh 拿 appBoot，dsh 依赖缺失时跳过由诊断引导）+ g.appendLog 日志。语义：
//   老整树 junction → 删链接后官方初始化；老拷贝实体目录（name=dsh-profile-dshana 且
//   dependencies 空 = 纯内置物）→ 清内置残留后官方补齐；含用户依赖/未知内容 → 拒绝迁移
//   （warn + 诊断引导，绝不整树删除）。initProfile 幂等只补缺失不覆盖用户改动；scope
//   链接缺失/漂移重建、失败回退整体拷贝。源缺失记 warn 不阻断——若 profile 缺失 dsh 侧
//   会再报，最终由诊断引导修复。
const PROFILE_NAME = "dshana";
export async function ensureDshanaProfile(cfg) {
  // 仅 dshana profile 路线需要种子化：配置改回官方 profile（如 web）时不执行，
  // 走官方 bundle（dsh 自动 initProfile）。
  if (resolveProfileName(cfg) !== PROFILE_NAME) return;
  const g = getSingleton();
  const append = (msg) => g.appendLog?.("hana", msg);
  const srcRoot = join(PLUGIN_ROOT, "cordis"); // 打包产物 cordis/（scope 树形态：@dsh-hanako 平铺目录，无 node_modules 层）
  const scopeSrc = srcRoot; // 产物 scope 根 = cordis 资产根（9 包平铺 dist/cordis/*，链接名 @dsh-hanako 供 cordis 解析）
  const dshHome = join(cfg.dataDir, "dsh-home");
  // 官方生成工具 initProfile（@deepseek-ai/dsh-app-boot 导出，与 loadLayeredEnv 同模块）：
  // 复用 loadInprocDsh 拿 appBoot（dsh 依赖缺失/版本无 initProfile 时无法官方生成 →
  // warn 跳过，由诊断链引导——profile 无 manifest 时 dsh loadProfile 会再报）。
  let appBoot = null;
  try {
    appBoot = (await loadInprocDsh(cfg.dshPkgDir || resolveDshPkgDir(cfg)))?.appBoot ?? null;
  } catch (e) {
    append(`[cordis] dsh app-boot 解析失败，profile 种子化跳过（${(e && e.message) || e}，由诊断引导）`);
    return;
  }
  if (typeof appBoot?.initProfile !== "function") {
    append("[cordis] dsh app-boot 无 initProfile（版本过旧？），profile 种子化跳过（由诊断引导）");
    return;
  }
  ensureProfileSeeded({
    profileDir: join(dshHome, "profiles", PROFILE_NAME),
    scopeSrc,
    initProfile: appBoot.initProfile, // 官方 initProfile(dir, bundles, patchReload)：生成 manifest/用户层模板/pnpm-workspace（幂等）
    log: append,
  });
}

// ---- web host 生命周期：进程内 boot dsh（T7b 方案 A；spawn 形态已整体退役）----
// dsh 依赖位置解析（resolveDshPkgDir）已提取到 lib/install.js——数据目录
// dsh-pkg/ 优先（Agent npm i @deepseek-ai/dsh 部署的轻量分发形态），插件安装目录
// node_modules 兑底（现役 zip 自带形态）。DSH_HOME 恒在数据目录。
// 唯一形态 = 宿主进程内 runProfile() boot dshana（webserver 保留在进程内 bind 端口）。
// 子进程面收敛（2026-09-02 去 spawn）：仅 pnpm install 保留子进程（D6 解耦——安装需
// 独立进程跑 pnpm；依赖完整性验证已静态化（见 lib/install.js verifyDepsSmoke），运行
// 级裁决由进程内 boot 承担）。

// ---- T7b 进程内 boot：dsh 模块动态定位（解耦 D6）----
// dsh 包位置 = 插件 node_modules（vY T7d：dsh-pkg 独立安装区已退役，依赖收进插件
// node_modules，resolveDshPkgDir 唯一形态）；profile-boot-*.js 是带构建 hash 的
// 产物名（bin.js 按 hash 动态 import）——不能硬编码文件名，枚举 lib 目录试出
// 导出 runProfile 的候选（probe-inproc 验证过的定位方式）。
// app-boot 经 createRequire 从 dsh 包视角解析：pnpm 严格结构下 @deepseek-ai/dsh-app-boot
// 是 dsh 的间接依赖，不在顶层 node_modules——createRequire 沿 dsh 包的 .pnpm 依赖链
// 解析，比枚举 .pnpm 目录稳（不依赖 pnpm 内部布局）。
// 返回 { profileBoot, bootEntry, appBoot, appBootEntry }：profileBoot 提供 runProfile，
// appBoot 提供 loadLayeredEnv。
// 注意：动态 import 必须带 webpackIgnore 注释（rspack 兼容 webpack 语义）——源码里的
// import(expr) 会被 rspack 编译成自身 chunk runtime（s(<id>)(url)），对运行时绝对路径
// file:// URL 不适用（实机验证：dsh 包无可用 profile-boot 模块）；webpackIgnore 告诉
// bundler 完全不要处理该 import，保留原生 import() 调用，且不丢静态语义。
async function loadInprocDsh(pkgDir) {
  const dshPkg = join(pkgDir, "node_modules", "@deepseek-ai", "dsh");
  const libDir = join(dshPkg, "lib");
  if (!existsSync(join(dshPkg, "package.json"))) {
    throw new Error(
      `DSH 包未就绪：${dshPkg} 不存在。依赖自动安装链会按插件声明补齐并自动重试，无需手动操作；若持续未就绪请查看上方依赖诊断（自动安装失败原因与重试状态）`,
    );
  }
  // ① profile-boot：枚举 lib 下 profile-boot-*.js，逐个 import 试 runProfile
  let profileBoot = null;
  let bootEntry = null;
  let tried = 0;
  try {
    for (const f of readdirSync(libDir)) {
      if (!f.startsWith("profile-boot-") || !f.endsWith(".js")) continue;
      const abs = join(libDir, f);
      tried += 1;
      try {
        const m = await import(/* webpackIgnore: true */ pathToFileURL(abs).href);
        if (typeof m.runProfile === "function") {
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
  //    a) createRequire 从 dsh 包视角解析（标准 pnpm 布局：dsh 的依赖在 .pnpm 节点同级
  //       node_modules，Node 沿父目录链能找到）；
  //    b) 失败回退 .pnpm 虚拟存储枚举（手工/自定义链接树布局下 createRequire 的 realpath
  //       解析不可靠——实测 symlink 路径向上只到顶层 node_modules，找不到间接依赖；
  //       probe-inproc 验证过的定位方式）。
  let appBootEntry = null;
  try {
    const dshRequire = createRequire(join(dshPkg, "package.json"));
    appBootEntry = dshRequire.resolve("@deepseek-ai/dsh-app-boot");
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
  const appBoot = await import(/* webpackIgnore: true */ pathToFileURL(appBootEntry).href);
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
  // 新启动尝试开始：作废旧退出记录（webLastExit 只反映「最近一次进程退出」；本次尝试
  // 失败会更新 webLastError，boot-state 应反映启动失败而非旧退出——否则 lastExit 遮蔽
  // 当前失败，自举页误示进程退出。CodeRabbit PR #53）
  g.webLastExit = null;
  if (!cfg.dshPkgDir) cfg.dshPkgDir = resolveDshPkgDir(cfg);

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
  // 启动前确保 dshana profile 已种子化并挂 scope 链接（$DSH_HOME/profiles/dshana 真实
  // 目录 → dist/cordis），否则 dsh loadProfile 会抛「profile
  // does not exist」。
  await ensureDshanaProfile(cfg);
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
    // web host 启动失败：通知壳页事件流刷新自举状态（routes/webui.js 注册回调，推
    // diag-changed 信号 → 壳页刷新 /webui/boot-state 呈现 waiting；无订阅者 no-op）
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
// 与 lib 侧挂载保持同款幂等语义）。tools/dsh-install.js（Agent）与 index.js 自动链经
// g.installDeps / g.verifyDeps 调用（/webui 手动路由已随 T5 退役）。
getSingleton().installDeps = installDepsFromPlugin;
getSingleton().verifyDeps = verifyDepsSmoke;
// ---- 连接失败自检展示层退役（T5 spec：dsh-deps-zero-intervention）----
// 旧「诊断壳 checks 结构」（collectWebDiagnostics / buildDepsDiagCheck /
// buildProcessDiagCheck / pickProcessFix / readLogTail，t1 依赖 + t2 进程卡片）已随
// Bootstrap 自举壳页（T4）退役：浏览器壳页只消费 /webui/boot-state（T3 单一状态出口，
// routes/webui.js readBootState——g.boot 状态机 + g.deps errorClass/guidance + g.web 就绪）。
// 日志诊断保留 = 会话日志文件（g.logPath，含 install/boot 全程里程碑），不再生成 UI checks。

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
// startWebHostFromPlugin 处单独赋值，这里只挂其余生命周期能力——closeProcess /
// updateDsh / installDeps / verifyDeps / checkDshUpdate）。routes/webui.js、index.js、tools/dsh-*.js 均经
// globalThis 单例调用，不静态 import 本模块（见文件头「分发形态」）。
const mountLifecycle = () => {
  const g = getSingleton();
  g.closeProcess = closeProcess;
  g.installDeps = installDepsFromPlugin;
  g.verifyDeps = verifyDepsSmoke;
  return g;
};
mountLifecycle();
