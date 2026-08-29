// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// app/lifecycle.js — dsh web host 生命周期（从 tools/dsh-run.js 分离）
// 原 tools/dsh-run.js（2716 行单文件）混杂两件事：a) web host 生命周期管理（启动/自检/更新/
// provider 跟随 watch + DSH 更新请求轮询），b) dsh 任务提交链路（execute/callUnary/events.mux
// 等）。本次把 a) 的全部函数原样搬入本模块，让 dsh-run.js 瘦身为纯任务提交流程模块 +
// 经本模块转发生命周期能力。
//
// 本模块承载（逐字迁移自 dsh-run.js，逻辑零改动；v0.21 起并入统一通道 bridge）：
//   web host 拉起    ensureWebHost（spawn dsh web + 端口就绪等待，幂等；启动前 ensureBridge
//                    起 WS #2 server，端口/token 注入 spawn env）+ startWebHostFromPlugin（挂 g.startWebHost）
//   关闭回收         closeProcess（先清 provider watch / bridge 更新事件订阅 / stopBridge，再 kill 子进程）
//   连接失败自检     collectWebDiagnostics + buildDepsDiagCheck + buildProcessDiagCheck + pickProcessFix
//   更新 DSH         updateDsh（停 host → 装依赖 → 起 host → 读版本，写 update-result.json +
//                    经 bridge 推 update.result 事件帧）
//   bridge 装配       ensureBridge / stopBridge / subscribeBridgeEvents（WS #2 生命周期 +
//                    update.request 事件订阅，替代 update-request.json 文件轮询桥接）
//   watch + 轮询     ensureProviderPushWatch（provider 热跟随 watch）
//   provider 路由     detectHostProviderPaths / readJsonFile / mapModel / readHostConfig / buildProviderRoutes
//                    → pushProviderRefresh（HTTP push 到 dsh web host）
//   config 引导       ensureConfigJson（自动生成 config.json，幂等）
//   web host 日志     logTs / appendLog / logFileStamp / newWebLogPath（兜底实现）
// 单例挂载（globalThis.__dshHanako，经 getSingleton()）：g.closeProcess / g.collectDiagnostics /
// g.updateDsh / g.startWebHost / g.installDeps / g.verifyDeps / g.checkDshUpdate 均在本模块顶层完成
// （installDeps/verifyDeps/checkDshUpdate 直接引用 lib/install.js & lib/check.js）。routes/webui.js、
// index.js、tools/dsh-*.js 仍经 globalThis 单例调用，不受影响。
//
// 分发形态与理由：本模块只被 tools/dsh-run.js（rspack 入口）静态 import，会被 rspack 内联进
// dist/tools/dsh-run.js bundle（build.mjs 的 staticUrlToMeta 已递归收集 ROOT 下全部 .js 路径做
// import.meta.url 替换；工具 ?t= 重载即刷新整包）。index.js / routes/webui.js 不做静态 import（违反
// 缓存纪律，见 tools/dsh-run.js 文件头），仍经单例调用。本文件自身的 ../tools/lib/* 引用随 dsh-run
// bundle 内联，无固定 URL 缓存问题。
//
// 语义不变：ensureWebHost 重复调用幂等；web host 进程随插件 onload/卸载生命周期拉起/回收
// （index.js register 回收调用 g.closeProcess）；providerPushCleanup / updateEventCleanup 清理时机与
// 拆分前一致；updateDsh 流程（停 host→装依赖→起 host→读版本）保持完整；collectWebDiagnostics 输出的
// checks 结构（t1 依赖 / t2 进程）令 routes/webui.js 渲染不变。
import { spawn } from "node:child_process";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
  renameSync,
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
  ELECTRON_NODE,
  ELECTRON_NODE_ENV,
  IS_WIN,
} from "./tools/lib/state.js";
import {
  resolveDshPkgDir,
  installDepsFromPlugin,
  verifyDepsSmoke,
  readDshInstalledVersion,
} from "./tools/lib/install.js";
import { checkDshUpdate } from "./tools/lib/check.js";
// 统一通道（bridge，M1）：WS #2 server + 帧分发 + event 分发（lifecycle 装配）
import {
  ensureBridge,
  stopBridge,
  onBridgeEvent,
  emitBridgeEvent,
} from "./lib/bridge.js";

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
// ---- config.json 自动初始化（全新安装免「先保存一次」引导）----
// config.json 不随包分发（宿主设置界面生成，路径 <插件数据目录>/config.json），
// 全新安装时不存在。插件初始化（onload 拉起 web host / 首次工具调用）时按 manifest
// 默认值自动生成 { schemaVersion: 1, global: { ...manifestDefaults }, agents: {}, sessions: {} }，
// 用户装完即可在设置界面看到默认值，无需先手动保存一次。
// 幂等：文件已存在直接返回，绝不覆盖用户配置/宿主生成内容。失败静默：resolve* 有
// 配置快照兜底，不阻塞主流程（生成的只是初始默认值，被覆盖/缺失都不影响功能）。
export function ensureConfigJson(cfg) {
  try {
    const dataDir =
      cfg.dataDir || getSingleton().dataDir || join(PLUGIN_ROOT, "data");
    const cf = join(dataDir, "config.json");
    if (existsSync(cf)) return; // 已存在（宿主生成/用户修改）：幂等跳过
    mkdirSync(dataDir, { recursive: true });
    const tmp = join(dataDir, ".config.json.tmp");
    // 先写临时文件再 rename 原子落位（中断不留半成品），对齐 scripts/pack.mjs 惯例
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          schemaVersion: 1,
          global: { ...manifestDefaults },
          agents: {},
          sessions: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    renameSync(tmp, cf);
  } catch {
    /* 生成失败静默：resolve* 有配置快照兜底 */
  }
}
// ---- web host 生命周期：spawn dsh web（DSH_HOME 锁进插件数据目录）----
// dsh 依赖位置解析（resolveDshPkgDir）已提取到 lib/install.js——数据目录
// dsh-pkg/ 优先（Agent npm i @deepseek-ai/dsh 部署的轻量分发形态），插件安装目录
// node_modules 兑底（现役 zip 自带形态）。DSH_HOME 恒在数据目录。
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
  if (g.web?.child) {
    // 旧实例启动失败过：清掉重建
    try {
      g.web.child.kill();
    } catch {
      /* 已退出 */
    }
    g.web = null;
  }
  if (!cfg.dshPkgDir) cfg.dshPkgDir = resolveDshPkgDir(cfg);

  const pkgDir = cfg.dshPkgDir;
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
      `DSH 包未就绪：${cliBin} 不存在。请在插件数据目录 dsh-pkg 执行 pnpm add @deepseek-ai/dsh`,
    );
  }

  const dshHome = join(cfg.dataDir, "dsh-home");
  // spawn 的 cwd 必须是已存在目录（无效 cwd 会让 Node 报误导性的 ENOENT）
  mkdirSync(cfg.dataDir, { recursive: true });
  const port = Number(cfg.webPort) || 3080;
  // 当前会话日志 = 时间戳会话文件（index.js onload 已初始化单例 g.logPath）。
  // 单例优先；index.js 未初始化（冷启动边缘）时兜底自建。写进 web/logLastExit/错误消息供诊断。
  const logPath = g.logPath || newWebLogPath(cfg.dataDir);
  // 会话全文搜索 overlay（dsh 默认 openAt: never 禁用搜索，需 --patch 覆盖为 first-search）
  // 主题注入 overlay + 宿主 provider 跟随 overlay——多份 patch 合并为
  // dsh-plugin/dsh-hanako.patch.yml.tpl 单一模板：段1 session-query 静态配置块 + 段2 theme
  // insert + 段3 provider insert（恒渲染：hostProvider 恒开跟随宿主，无关闭选项）
  // + 段4 settings insert（恒挂载；改名 @dsh-hanako/settings 并注入
  // 「检查与更新 DSH」链路 config：dshPkgDir/dataDir——远端版本 HTTP 直查 npm registry，
  // 不再注入 pnpm 入口）。
  // cordis 插件加载：theme/provider/settings/logger 四段均以包名注册（dsh client 模块发现
  // 按 loader entry 的 name 做 require.resolve('<name>/package.json')，file:// 无法解析），
  // 故启动前须在 $DSH_HOME/profiles/node_modules 统一建 junction（包名 → 插件安装目录
  // dsh-plugin/<pkg>），与 dsh 自维护的 junction farm 同机制（ensureCordisJunctions
  // 每次启动无条件重建）。
  // 启动前渲染模板（占位符→实际路径）到数据目录 dsh-hanako.patch.generated.yml；launcher
  // flag（--profile/--patch）必须位于应用参数（--port）之前。模板缺失/渲染失败时不挂
  // 任何 patch 记 warn（会话全文搜索保持上游默认禁用），不阻断 dsh 启动。
  // 正规化升级：@dsh-hanako/settings 前身 dsh-hana-default-model 先行改包名注册；
  // 本版 theme/provider 一并正规化——dsh client 模块发现按
  // require.resolve('<name>/package.json') 找 package.json 的 dsh.client 声明，file://
  // 形式无法解析。包名解析锚点是 $DSH_HOME/profiles（baseUrl 父目录的 node_modules），
  // 启动前统一建 junction：$DSH_HOME/profiles/node_modules/
  // <@dsh-hanako/theme|@dsh-hanako/provider|@dsh-hanako/settings|@dsh-hanako/logger> → 插件安装目录
  // dsh-plugin/<同名包>（与 dsh 自维护的 junction farm 同机制；dsh 的
  // healProfilesModuleFallback 只管理自身依赖闭包，不碰外来 link）。
  // 无条件重建：每次启动删旧建新（不比较 readlink）——junction 状态无条件收敛到当前
  // 代码期望，杜绝一切残留（悬空 junction / 指向旧路径）导致的解析失败；与 patch 每次
  // 渲染覆盖同一哲学。存在性用 lstatSync（不跟随目标）判断——existsSync 沿目标解析，
  // 悬空 junction 会误判不存在，导致 symlinkSync EEXIST。非 junction 同名实体报错
  // 不静默覆盖。
  const ensureCordisJunctions = (dshHome) => {
    // @dsh-hanako scope 收敛（v0.18.1）：五个插件包统一命名空间，junction 名与包名
    // 一致（profiles/node_modules/@dsh-hanako/<pkg> → 插件安装目录
    // dsh-plugin/@dsh-hanako/<pkg>）。顺带清理旧名遗留 junction（dsh-hana-* 前缀，
    // 含 v0.13.0 改名前的 dsh-hana-default-model / dsh-hana-proxy 等历史残留），
    // 无条件收敛到当前命名，杜绝混装。
    const packages = [
      {
        link: "@dsh-hanako/theme",
        target: join(PLUGIN_ROOT, "dsh-plugin", "@dsh-hanako", "theme"),
      },
      {
        link: "@dsh-hanako/provider",
        target: join(PLUGIN_ROOT, "dsh-plugin", "@dsh-hanako", "provider"),
      },
      {
        link: "@dsh-hanako/settings",
        target: join(PLUGIN_ROOT, "dsh-plugin", "@dsh-hanako", "settings"),
      },
      {
        link: "@dsh-hanako/logger",
        target: join(PLUGIN_ROOT, "dsh-plugin", "@dsh-hanako", "logger"),
      },
      {
        link: "@dsh-hanako/clipboard",
        target: join(PLUGIN_ROOT, "dsh-plugin", "@dsh-hanako", "clipboard"),
      },
      {
        link: "@dsh-hanako/bridge",
        target: join(PLUGIN_ROOT, "dsh-plugin", "@dsh-hanako", "bridge"),
      },
    ];
    const nmDir = join(dshHome, "profiles", "node_modules");
    // 清理旧名 junction：profiles/node_modules 下 dsh-hana-*（非 @dsh-hanako scope）
    // 的符号链接一律删（旧插件实例遗留，如 dsh-hana-default-model / dsh-hana-proxy）
    try {
      const legacy = readdirSync(nmDir).filter(
        (n) => n.startsWith("dsh-hana-") && !n.startsWith("@"),
      );
      for (const name of legacy) {
        const p = join(nmDir, name);
        try {
          if (lstatSync(p).isSymbolicLink()) {
            unlinkSync(p);
            console.log(`[dsh-run] 清理旧插件 junction：${name}`);
          }
        } catch {
          /* 非链接或已删：忽略 */
        }
      }
    } catch {
      /* nmDir 不存在/读失败：忽略（下方 mkdir 兜底） */
    }
    for (const pkg of packages) {
      const link = join(nmDir, ...pkg.link.split("/"));
      try {
        let existed = false;
        let isLink = false;
        try {
          isLink = lstatSync(link).isSymbolicLink();
          existed = true;
        } catch {
          /* 不存在（含 lstat 失败） */
        }
        if (existed && !isLink)
          throw new Error(link + " 已存在且不是符号链接请移除后重试");
        if (existed) unlinkSync(link);
        mkdirSync(dirname(link), { recursive: true });
        symlinkSync(pkg.target, link, IS_WIN ? "junction" : null);
      } catch (e) {
        // 符号链接创建失败降级：仅记 warn，不阻断 dsh 启动——对应插件会退化为
        // 不可用（client 模块未发现），后端路由与其余插件不受影响
        console.warn(
          `[dsh-run] ${pkg.link} junction 创建失败（${e?.message || e}），该插件将不可用`,
        );
      }
    }
  };

  const patchFiles = [];
  const patchTpl = join(PLUGIN_ROOT, "dsh-plugin", "dsh-hanako.patch.yml.tpl");
  // 渲染各插件的 config 依赖解析基座占位符——theme/provider/settings/logger/clipboard/
  // bridge 六段均以包名注册，不再有 file:// URL 占位符；包名经 ensureCordisJunctions 的
  // junction 解析。bridge 段无 config（URL/TOKEN 由 spawn env 注入）。
  // B方案：provider 段不再注入 modelsPath/catalogPath（宿主不再经 patch 注入
  // provider 数据，parse 逻辑上移宿主，route 目录改经 HTTP push 下发）——provider config
  // 只剩 dshPkgDir（子进程解析 pi-ai 依赖用）。DSH_PKG_DIR = dsh 包安装目录
  // （provider/settings 段）；LOG_PATH = 本次会话日志文件路径（logger 段，四个内嵌
  // 插件经统一日志服务写入同一文件）；DATA_DIR = settings 段「检查与更新 DSH」链路
  // （更新请求/结果文件写入数据目录）。v0.18.2 起远端版本查询改 HTTP 直查 npm registry
  // （settings 侧与 lib/check.js 同款，pnpm view 语义等价），NPM_CLI_PATH / ELECTRON_NODE
  // 占位符已从模板删除（settings 不再 spawn pnpm，渲染为同步函数，无异步依赖）。
  const renderPatchTpl = () => {
    const gen = join(cfg.dataDir, "dsh-hanako.patch.generated.yml");
    // 远程可信 Host：dshRemoteUrl 配置的 host（cloudflared 转发 3080 的远程域，
    // dsh isTrustedApiRequest 对非 loopback Host 需 trustedHosts 放行）；未配置为空
    //（trustedHosts 空数组，等价默认）。
    let trustedHost = "";
    if (typeof cfg.dshRemoteUrl === "string" && cfg.dshRemoteUrl) {
      try {
        trustedHost = new URL(cfg.dshRemoteUrl).host;
      } catch {
        trustedHost = "";
      }
    }
    const content = readFileSync(patchTpl, "utf8")
      .split("{{DSH_PKG_DIR}}")
      .join(cfg.dshPkgDir || resolveDshPkgDir(cfg))
      .split("{{LOG_PATH}}")
      .join(logPath)
      .split("{{DATA_DIR}}")
      .join(cfg.dataDir)
      .split("{{DSH_TRUSTED_HOST}}")
      .join(trustedHost);
    writeFileSync(gen, content, "utf8");
    return gen;
  };
  if (existsSync(patchTpl)) {
    try {
      patchFiles.push(renderPatchTpl());
    } catch (e) {
      // 渲染失败（读模板/写数据目录异常）：不挂任何 patch 记 warn（dsh 启动不受影响，
      // 会话全文搜索保持上游默认禁用）
      console.warn(
        `[dsh-run] patch 模板渲染失败（${e?.message || e}）：不挂任何 patch（DSH 启动不受影响，会话全文搜索保持上游默认禁用）`,
      );
    }
  } else {
    // 模板缺失：不挂任何 patch 记 warn（dsh 启动不受影响，会话全文搜索保持上游默认禁用）
    console.warn(
      "[dsh-run] dsh-plugin/dsh-hanako.patch.yml.tpl 缺失：不挂任何 patch（DSH 启动不受影响，会话全文搜索保持上游默认禁用）",
    );
  }
  const patchArgs = patchFiles.flatMap((p) => ["--patch", p]);
  // 六段 cordis 插件均以包名注册，spawn 前确保 junction 就绪（幂等）
  ensureCordisJunctions(dshHome);
  // ---- 统一通道（bridge）WS #2：spawn 前启动服务端（幂等），端口/token 注入 spawn env ----
  // dsh 侧 @dsh-hanako/bridge 插件经 DSH_BRIDGE_URL/DSH_BRIDGE_TOKEN 连接并首帧握手。
  // ensureBridge 内部已做幂等（web host 重建时旧实例已由 closeProcess → stopBridge 清掉，
  // 新启动生成新 token）。bridge 启动失败不阻断 dsh 启动（降级：页面/更新链路回退旧路径，
  // 详见 lib/bridge.js 与 routes/bridge.js 注释）。
  let bridgeEnv = {};
  try {
    const br = await ensureBridge();
    bridgeEnv = {
      DSH_BRIDGE_URL: "ws://127.0.0.1:" + br.port,
      DSH_BRIDGE_TOKEN: br.token,
    };
  } catch (e) {
    console.warn(
      `[dsh-run] bridge WS #2 启动失败（${e?.message || e}），本次 web host 无 bridge 通道`,
    );
  }
  // launcher flag（--profile/--patch）必须位于应用参数（--port）之前；且 --patch 是
  // 顶层 dsh 选项，必须位于 --profile 之前（dsh 0.1.x：--profile 之后的参数视为
  // web app 参数，--patch 会被 web app 拒为 unknown option）
  // --expose-internals 是 node 运行时 flag，必须置于 cliBin 之前（node --expose-internals <cliBin> …）。
  // HMR 服务需要 Node 内部 ESM loader：上游 drop 该 flag 后改走原生 addon 兜底
  // （require('node-addon-require-builtin')），但该 addon 在 macOS arm64 上加载失败
  // （node-addon-require-builtin: Unsupported/no-getter (arm64 …)），导致 `dsh web` boot 崩溃。
  // 显式注入 flag 切到 require('internal/modules/esm/loader') 直连路径，绕开崩溃 addon；
  // Windows x64 等其余平台走直连同样成立、行为不变（Hana 内置 node 24.15，v2 loader）。
  const child = spawn(
    ELECTRON_NODE,
    [
      "--expose-internals",
      cliBin,
      ...patchArgs,
      "--profile",
      "web",
      "--port",
      String(port),
      // 不自动打开默认浏览器（dsh web app 默认会 open；插件以 iframe 内嵌，
      // 更新/重启后弹浏览器是噪音，web app 参数须在 launcher flag 之后）
      "--no-open",
    ],
    {
      cwd: cfg.dataDir,
      stdio: ["ignore", "pipe", "pipe"],
      // 恒不注入 API Key 环境变量——凭据由 @dsh-hanako/provider 插件直读
      // 宿主 provider-catalog.json（dsh models 页/任务均走 Hana 宿主 provider）
      env: {
        ...ELECTRON_NODE_ENV,
        DSH_HOME: dshHome,
        DSH_TELEMETRY_DISABLED: "1",
        // bridge WS #2 连接参数（dsh 侧 @dsh-hanako/bridge 插件消费；见上方 ensureBridge）
        ...bridgeEnv,
      },
      windowsHide: true,
    },
  );

  const web = {
    child,
    port,
    dshHome,
    logPath,
    ready: false,
    stderr: "",
    readyPromise: null,
  };
  // stdout/stderr 全量落盘（src=out/err；stderr 另保留内存尾部供诊断界面）。
  // 写入优先用单例 appendLog（index.js 提供，行格式一致 [ts] [src] 内容），
  // 无单例时回退本模块 appendLog（两者写同一 logPath）
  const emitLog = (src, d) => {
    if (typeof g.appendLog === "function") g.appendLog(src, d);
    else appendLog(logPath, src, d);
  };
  child.stdout.on("data", (d) => {
    emitLog("out", d);
  });
  child.stderr.on("data", (d) => {
    emitLog("err", d);
    web.stderr = (web.stderr + String(d)).slice(-STDERR_CAP);
  });
  child.once("exit", (code, signal) => {
    web.ready = false;
    web.stderr += `\n[dsh web 退出 code=${code} signal=${signal}]`;
    emitLog("hana", `dsh web 退出 code=${code} signal=${signal}`);
    // 退出信息记入单例持久字段（随后 g.web 摘除，局部 web.stderr 会丢）——
    // 进程被外部杀掉（kill / Stop-Process）时诊断仍能区分「已退出」而非误报「尚未启动」
    g.webLastExit = {
      code,
      signal,
      at: new Date().toISOString(),
      stderr: web.stderr.slice(-800),
      logPath,
    };
    if (g.web === web) g.web = null;
  });

  // 等端口就绪（stdout 出现 "dsh web: http://" 或端口可连）
  const readyPromise = (async () => {
    const deadline = Date.now() + PORT_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `DSH web 进程提前退出 (code=${child.exitCode})：${web.stderr.slice(-1200) || "无 stderr"}（完整日志：${logPath}）`,
        );
      }
      try {
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
        if (r.ok) {
          web.ready = true;
          // 新进程就绪：清掉上次退出记录（持久字段只反映最近一次退出）
          g.webLastExit = null;
          // B方案下子进程启动时 snapshot 为空，首批 provider 依赖宿主 push。
          // 从这里（唯一新进程就绪点）主动推一次最新 routes——任意 spawn 路径
          // （插件 onload / webui 手动启动 / dsh_run 进程兜底重启 / updateDsh 更新重启）
          // 都保证有初始 push；内部有界重试覆盖子进程插件 apply() 晚于端口就绪的
          // 路由空窗（失败不阻断，下轮配置变化/重启仍会触发）。不 await，页面/任务不阻塞。
          pushProviderRefresh(port);
          return web;
        }
      } catch {
        /* 未就绪，继续等 */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
      `DSH web 启动超时（${Math.round(PORT_READY_TIMEOUT_MS / 1000)}s 内端口 ${port} 未就绪）：${web.stderr.slice(-1200) || "无 stderr"}（完整日志：${logPath}）`,
    );
  })();
  web.readyPromise = readyPromise;
  g.web = web;
  return readyPromise;
}

// ---- 宿主侧 provider 跟随 push 链路（fs.watch → ctx.resources.watch + HTTP push）----
// 语义：@dsh-hanako/provider 插件不再自建 fs.watch（Windows rename 原子替换等平台坑一并消除）——
// 宿主侧经 ctx.resources.watch 感知 models.json / provider-catalog.json 变化（bus 派发
// resource.changed，resourceKey 格式 local_fs:<path>），防抖 300ms（与旧实现同 DEBOUNCE
// 语义）后 POST dsh web host /api/hana-provider.refresh，dsh 侧插件收到通知重读配置
// refresh()（handle.replace 原子更新）。watch 建立失败降级不阻断（dsh 侧启动时仍会
// refresh 一次，功能不受影响）。
// 幂等：startWebHost 重复调用 / web host 重建时先清理旧 watch 再建；cleanup 挂单例
// g.providerPushCleanup，closeProcess 回收 web host 时调用（退订 bus + 关 watchers）。
const PROVIDER_SYNC_DEBOUNCE_MS = 300;
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
  const bus = g.bus;
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
  const port = Number(cfg.webPort) || 3080;
  const handles = [];
  const resourceKeys = new Set();
  let timer = null;
  const triggerPush = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      pushProviderRefresh(port);
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
      console.log(`[dsh-run] 宿主配置变化（${key}），防抖后 push DSH 刷新`);
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
    `[dsh-run] provider 热跟随 watch 已建立（${paths.length} 文件），宿主配置变化将 push DSH 刷新`,
  );
}
// ---- DSH 检查能力（checkDshUpdate / npmViewLatest / semver 比较 / 本地版本
// 直读已提取到 lib/check.js + lib/install.js，经 getSingleton 挂 g.checkDshUpdate 供
// Agent 工具 dsh_update / DSHana 标签页 webui 路由两面共用，单一事实源；
// 设置页「DSH 版本」卡片 v0.18.1 起由 dsh 侧 @dsh-hanako/settings 直查远端，不经此通道）----

// ---- 更新 DSH（能力层）：停 web host（closeProcess——回收子进程 + 停 bridge，Windows
// 文件锁前提：npm i 要替换被 web host 占用的 dsh 包文件）→ installDepsFromPlugin（npm i
// @deepseek-ai/dsh = 装 latest，成功即新版本）→ 起 web host（ensureWebHost 重建 bridge，
// 新端口/token，失败不阻断结果上报，记 error 字段）→ 读新版本。全程写
// <dataDir>/update-result.json { state: done|error, version?, error?, at }（dsh 设置页
// update-status 路由读），完成/失败同时经 bridge 推 update.result 事件帧（前端可选收推送）。
// 并发防护：g.updating 进行中重复调用返回 { ok:false, state:"updating" } 不重复执行；
// 与 installDepsFromPlugin 内部 g.depsInstalling 独立（本标志管整条更新流程）。----
export async function updateDsh(cfg) {
  const g = getSingleton();
  if (g.updating) return { ok: false, state: "updating" };
  g.updating = true;
  g.updateError = null;
  const dataDir = cfg.dataDir || g.dataDir;
  const resultFile = join(dataDir, "update-result.json");
  const stamp = () => new Date().toISOString();
  const log = (s) => {
    try {
      g.appendLog?.("hana", `[DSH 更新] ${s}`);
    } catch {
      /* 日志失败不阻断 */
    }
    console.log(`[dsh-run] DSH 更新：${s}`);
  };
  const writeResult = (obj) => {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(resultFile, JSON.stringify(obj), "utf8");
    } catch (e) {
      log(`update-result.json 写入失败：${e?.message || e}`);
    }
  };
  try {
    // ① 进度态（前端轮询 update-status 可见）
    writeResult({ state: "updating", at: stamp() });
    // ② 停 web host（Windows 文件锁前提）
    log("停止 web host…");
    await closeProcess();
    // ③ 装 latest（installDepsFromPlugin 内部有 g.depsInstalling 防并发；成功后
    // 会自动运行级重验刷新 g.depsSmoke）
    log("执行 pnpm add @deepseek-ai/dsh（latest）…");
    const install = await installDepsFromPlugin(cfg, dataDir);
    if (!install || !install.ok)
      throw new Error(install?.error || "依赖安装失败");
    // ④ 起新进程（失败不阻断结果上报，记 error 字段）
    let restartError = null;
    try {
      await ensureWebHost(cfg);
    } catch (e) {
      restartError = String(e?.message || e).slice(0, 1500);
      log(`web host 重启失败：${restartError}`);
    }
    // ④b 重启后重建宿主侧 watch/事件订阅——closeProcess 已清理（provider 热跟随 +
    // bridge 更新事件订阅），ensureWebHost 本身不建（只有 startWebHostFromPlugin 建），
    // 不重建则更新后设置页更新请求不再触发宿主处理。bridge 本身已由 ensureWebHost
    // 重建（新端口/token），此处重建事件订阅。
    ensureProviderPushWatch(cfg);
    // 重启用进程后首批 provider 的初始 push 已由 ensureWebHost（唯一就绪点）
    // 发出；此处只重建跟随 watch，不再重复 push。
    subscribeBridgeEvents(cfg);
    // ⑤ 读新版本 → done（installDepsFromPlugin 已刷新 g.depsSmoke，优先用；无则直读 package.json）
    const version =
      (g.depsSmoke && !g.depsSmoke.running && g.depsSmoke.ok
        ? g.depsSmoke.version
        : null) ||
      readDshInstalledVersion({ ...cfg, dataDir }) ||
      null;
    writeResult({
      state: "done",
      version,
      ...(restartError ? { error: restartError } : {}),
      at: stamp(),
    });
    // 更新结果同时经 bridge 推送给 dsh 侧（update.result 事件帧；设置页 update-status
    // 仍读文件轮询——改动最小，推送供前端可选收实时通知）
    emitBridgeEvent("update.result", {
      state: "done",
      version,
      ...(restartError ? { error: restartError } : {}),
      at: stamp(),
    });
    log(
      `更新完成（version=${version || "未知"}${restartError ? "，web host 重启失败：" + restartError : ""}）`,
    );
    return {
      ok: true,
      state: "done",
      version,
      ...(restartError ? { error: restartError } : {}),
    };
  } catch (e) {
    const err = String(e?.message || e).slice(0, 1500);
    g.updateError = err;
    writeResult({ state: "error", error: err, at: stamp() });
    emitBridgeEvent("update.result", { state: "error", error: err, at: stamp() });
    log(`更新失败：${err}`);
    return { ok: false, state: "error", error: err };
  } finally {
    // ⑥ 解锁（update-request.json 文件桥接已退役：不再写/清该文件）
    g.updating = false;
  }
}
// ---- 宿主侧 DSH 更新请求桥接（v0.21 起：update-request.json 文件轮询退役，改 bridge 事件流）----
// 语义：dsh 设置页「更新到最新」经 @dsh-hanako/settings 的 bridge.emit("update.request",
// { fromVersion }) → WS #2 event 帧 → 宿主 bridge 事件分发（lib/bridge.js events
// EventEmitter）→ 本订阅触发 updateDsh（能力层单一事实源，写 update-result.json 供
// 设置页 update-status 轮询 + 经 bridge 推 update.result 供前端可选收推送）。
// 相比旧 ensureUpdateWatch 5s 轮询 update-request.json：事件驱动即时、无轮询空窗、
// 无文件占位/读写。update-request.json 退役（不再写/读）。
// 幂等：startWebHost 重复调用 / web host 重建时先退订再订；cleanup 挂单例
// g.updateEventCleanup，closeProcess 回收 web host 时调用。
function subscribeBridgeEvents(cfg) {
  const g = getSingleton();
  // 幂等：先退订旧订阅（startWebHost 重复调用 / web host 重建时）
  if (typeof g.updateEventCleanup === "function") {
    try {
      g.updateEventCleanup();
    } catch {
      /* 清理失败不阻断 */
    }
    g.updateEventCleanup = null;
  }
  // 更新请求（dsh 设置页 → 宿主）：触发 updateDsh（能力层；g.updating 防并发）
  const onUpdateRequest = (payload) => {
    if (g.updating) return; // 更新中：跳过（重复触发防护）
    console.log("[dsh-run] 收到 DSH 更新请求（bridge update.request），执行 updateDsh");
    updateDsh(cfg).catch((e) => {
      console.warn(`[dsh-run] DSH 更新异常：${e?.message || e}`);
    });
  };
  // 更新结果推送（宿主 → dsh）：updateDsh 完成时经 bridge emit("update.result")
  // 推送（设置页 update-status 仍读文件轮询——改动最小；推送供前端可选消费）
  const unsubRequest = onBridgeEvent("update.request", onUpdateRequest);
  g.updateEventCleanup = () => {
    try {
      unsubRequest();
    } catch {
      /* 退订失败忽略 */
    }
    g.updateEventCleanup = null;
  };
  console.log("[dsh-run] bridge 更新事件订阅已建立（update.request → updateDsh）");
}
// push dsh web host 刷新（回环调用 127.0.0.1:{port}；结果写入统一会话日志 + console 简记，
// 失败不阻断。B方案：body 携带组装好的 route 目录（buildProviderRoutes() 的
// 最新 routes），子进程 applySnapshot 直接消费，不再自读宿主文件（buildProviderRoutes
// 内部已处理「读取失败保留旧 routes」回退）。
//
// 有界重试 + 回环 fetch 直连：B方案下子进程启动时 snapshot 为空、首批 provider
// 全依赖这次 push。但 dsh web host 的 /api/host.describe 就绪（宿主判定 ready）早于
// 子进程内插件的 apply() 完成——@dsh-hanako/provider 的 apply 要先 await 动态导入
// pi-ai/dsh-llm/dsh-timeout，之后才经 ctx.inject(['webServer']).effect 注册
// /api/hana-provider.refresh 路由。启动 push 若只发一次，会打在路由注册前的空窗上
// （404/连接拒绝），provider 快照将一直为空直到宿主配置变化触发下一轮 push——即
// 「@dsh-hanako/provider 失效」。因此 push 改为对非 2xx（尤其 404）与网络错误按退避表
// 重试，直到路由就绪送达。
// 另：发送不经过 ctx.network.fetch——回环控制调用走全局 fetch（与 ensureWebHost
// 就绪探测 / routes/webui.js probeHost 同一通道，实测可用）；宿主的 network 服务是
// 出站/计费代理，代理策略可能拦截明文回环 POST，曾导致 push 静默永不送达。结果与
// 异常统一写会话日志（g.appendLog hana 前缀，与插件诊断同一文件），不再只 console。
const PROVIDER_PUSH_RETRY_DELAYS_MS = [300, 500, 800, 1200, 1800, 2500, 3000];
async function pushProviderRefresh(port) {
  const g = getSingleton();
  const url = `http://127.0.0.1:${port}/api/hana-provider.refresh`;
  const pushLog = (msg) => {
    try {
      // 统一会话日志（[ts] [hana] 行）：push 结果对用户可见（插件日志文件）
      appendLog(g.logPath || g.web?.logPath, "hana", msg);
    } catch {
      /* 日志失败不阻断 */
    }
    console.log(msg);
  };
  let host;
  try {
    host = buildProviderRoutes();
  } catch (e) {
    // routes 组装异常（防御性）：本轮 push 放弃，下轮变化/重启再试
    pushLog(
      `[dsh-run] provider routes 组装失败，本轮 push 放弃：${e?.message || e}`,
    );
    return;
  }
  let lastNote = "未知错误";
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ routes: host.routes }),
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        pushLog(
          `[dsh-run] provider push 成功（${host.routes.length} 条 routes，第 ${attempt + 1} 次尝试）：${url}`,
        );
        return;
      }
      lastNote = `HTTP ${res.status}`;
      if (attempt === PROVIDER_PUSH_RETRY_DELAYS_MS.length) {
        pushLog(`[dsh-run] provider push 失败（${lastNote}）：${url}`);
        return;
      }
    } catch (e) {
      // 网络错误（连接拒绝/超时等）：同样进退避重试；全失败静默忽略不阻断
      lastNote = e?.message || String(e);
      if (attempt === PROVIDER_PUSH_RETRY_DELAYS_MS.length) {
        pushLog(`[dsh-run] provider push 未送达（${lastNote}）：${url}`);
        return;
      }
    }
    await new Promise((r) =>
      setTimeout(r, PROVIDER_PUSH_RETRY_DELAYS_MS[attempt]),
    );
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
  // 插件初始化（拉起 web host）即自动生成 config.json（不存在时按 manifest 默认值）
  ensureConfigJson(cfg);
  // 单例记数据目录（dsh_ops 经 g.dataDir 定位 dsh 会话缓存等数据文件）
  getSingleton().dataDir = cfg.dataDir;
  if (!cfg.dshPkgDir) cfg.dshPkgDir = resolveDshPkgDir(cfg);
  try {
    await ensureWebHost(cfg);
    // web host 就绪后建立宿主侧 provider 跟随 push watch（幂等：先清理旧 watch 再建）
    ensureProviderPushWatch(cfg);
    // 首批 provider 的初始 push 已收敛进 ensureWebHost（唯一就绪点，含重试），
    // 此处不再重复推；后续每次 resource.changed 经防抖 watch 增量 push。
    // bridge 更新事件订阅（幂等）：dsh 设置页「更新到最新」经 bridge.emit("update.request")
    // → WS #2 event 帧 → 宿主 updateDsh（单一事实源，update-request.json 文件桥接退役）；
    // 版本检查 v0.18.1 起由 dsh 侧设置页直查，不经桥接
    subscribeBridgeEvents(cfg);
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
    // 自动一次 + 手动「检测依赖」按钮」，经 GET /webui/verify-deps 路由驱动；g.depsSmoke
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
 * v0.8.6: 叠加部署状态——g.depsInstalling（npm i 进行中）/ g.depsInstallError（上次失败）/ g.depsInstallLog
 * v0.8.7: 叠加运行级完整性验证——g.depsSmoke（verifyDepsSmoke 缓存 { ok, version, error, stderr, at, running }）。
 * v0.13.0: 叠加版本/检查/更新状态——version（当前版本）、check（最近一次 checkDshUpdate
 * 缓存：latest/updateAvailable/at/error）、checking/updating（进行中）、updateResult
 * （update-result.json 文件内容：state/version/error/at）——deps 卡片版本行 + 「检查更新」
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
  // 部署状态（installDeps 写入单例；只回非敏感布尔与截断文本）
  const installing = Boolean(g.depsInstalling);
  const installError = String(g.depsInstallError || "").slice(0, 300);
  const installLog = String(g.depsInstallLog || "").slice(-800);
  const installAt = g.depsInstallAt || null; // 最近一次 npm i 输出时间（实时进度）
  // 运行级验证状态（verifyDepsSmoke 缓存；非敏感：布尔/版本号/截断错误文本）
  const smoke = g.depsSmoke || null;
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
  // 状态（g.checkResult 缓存：最近一次 checkDshUpdate 结果）+ 更新状态（g.updating /
  // g.updateError + update-result.json 文件内容）。只回非敏感布尔/版本号/截断文本。
  const currentVersion =
    (smoke && !smoke.running && smoke.ok ? smoke.version : null) ||
    readDshInstalledVersion(cfg) ||
    null;
  const checkResult = g.checkResult || null;
  const checking = Boolean(g.checking);
  const updating = Boolean(g.updating);
  const updateError = String(g.updateError || "").slice(0, 300);
  let updateResult = null;
  try {
    const uf = join(cfg.dataDir, "update-result.json");
    if (existsSync(uf)) updateResult = JSON.parse(readFileSync(uf, "utf8"));
  } catch {
    /* 解析失败忽略 */
  }
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
      "依赖缺失：点击本卡片「安装依赖」按钮自动在插件数据目录 dsh-pkg 执行 pnpm add @deepseek-ai/dsh（完成后自动验证）；或确认插件目录 node_modules 解压完整";
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
      "点击本卡片「重新安装依赖」按钮重新执行 pnpm add @deepseek-ai/dsh（自动部署到 dsh-pkg，完成后自动验证）";
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
  const lastExit = g.webLastExit || null; // 持久退出记录：{ code, signal, at, stderr, logPath } | null
  const started = Boolean(web || g.webLastError || lastExit);
  const alive = Boolean(child && child.exitCode === null);
  const ready = Boolean(web?.ready);
  const exitCode = child?.exitCode ?? lastExit?.code ?? null;
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
    // 进程侧已就绪但探测未命中（端口短暂不可达等）：仍提示重试
    check.detail =
      "进程运行中且已就绪，但端口 " + port + " 探测未命中（可能短暂不可达）";
    check.fix = "稍候自动重试；若持续未就绪，检查端口是否被其他程序占用";
  } else if (alive) {
    check.detail =
      "进程运行中，端口 " +
      port +
      " 尚未就绪" +
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
    return "按上方「DSH 依赖安装」项修复（数据目录 dsh-pkg 执行 pnpm add @deepseek-ai/dsh，完成后自动验证）";
  }
  if (/EADDRINUSE|address already in use|占用|bind/i.test(text)) {
    return "检查端口 " + port + " 是否被占用（释放后重启 Hana）";
  }
  return "检查上方依赖项；仍失败请重启 Hana 后重试";
}

export async function closeProcess() {
  const g = getSingleton();
  // 先清理 watch/轮询（provider 热跟随 + DSH 更新请求轮询），再回收 web host 进程
  if (typeof g.providerPushCleanup === "function") {
    try {
      g.providerPushCleanup();
    } catch {
      /* 清理失败不阻断 */
    }
  }
  if (typeof g.updateEventCleanup === "function") {
    try {
      g.updateEventCleanup();
    } catch {
      /* 清理失败不阻断 */
    }
  }
  // 关闭 bridge（WS #2 server + 全部连接；web host 重启时下次 ensureWebHost 重建，
  // 生成新端口/token）
  try {
    await stopBridge();
  } catch (e) {
    console.warn(`[dsh-run] bridge 停止异常：${e?.message || e}`);
  }
  const web = g.web;
  g.web = null;
  if (web?.child) {
    try {
      web.child.kill();
    } catch {
      /* 已退出 */
    }
    await new Promise((r) => setTimeout(r, 200));
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
  g.updateDsh = updateDsh;
  g.installDeps = installDepsFromPlugin;
  g.verifyDeps = verifyDepsSmoke;
  g.checkDshUpdate = checkDshUpdate;
  return g;
};
mountLifecycle();
