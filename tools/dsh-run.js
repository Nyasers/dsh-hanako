// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/dsh-run.js — dsh_run 工具 + web host 生命周期（v0.13.0 lib 提取后瘦身）
// 把任务交给 DeepSeek Harness（dsh）的 web host（--profile web）执行：
// 插件 spawn dsh web（DSH_HOME 指向插件数据目录，账本随插件生命周期），
// 经其 /api 网关提交任务（session.create → events.mux 订阅 → session.prompt），
// 实时事件流驱动卡片 Markdown 输出。web UI 天然可见插件全部任务。
//
// 模块结构（v0.13.0）：安装/检查/更新能力层与共用状态提取到 tools/lib/——
//   lib/state.js    getSingleton（globalThis 单例）+ 环境常量（IS_WIN / ELECTRON_NODE /
//                   ELECTRON_NODE_ENV / PLUGIN_ROOT / manifestDefaults）+ g.depTasks 默认
//   lib/install.js  resolveDshPkgDir / installDepsFromPlugin / verifyDepsSmoke /
//                   semver 比较（parseSemver / compareSemver）/ readDshInstalledVersion
//   lib/check.js    checkDshUpdate（npmViewLatest + 本地版本直读 + semver 比较）
// 本文件保留：web host 生命周期（closeProcess / ensureWebHost / ensureProviderPushWatch /
// ensureUpdateWatch / startWebHostFromPlugin / collectWebDiagnostics）+ 任务提交链路 +
// updateDsh（组合 lib 的 installDepsFromPlugin / verifyDepsSmoke / readDshInstalledVersion）。
// 单例挂载在本文件（getSingleton() 内逐字段赋值保留：g.closeProcess / g.collectDiagnostics /
// g.installDeps / g.verifyDeps / g.checkDshUpdate / g.updateDsh / g.startWebHost），
// routes/webui.js 与 index.js 经单例调用不受影响。
//
// 为什么是单文件（历史约束）：Hana 以带 ?t= 时间戳的 URL 加载 tools/*.js（热更新缓存破坏），
// 但 tools 内部静态 import 的相对模块是无 query 的固定 URL，Node ESM 按 URL 缓存、永不刷新。
// 分发形态宿主加载的是 dist/tools/*.js（rspack bundle，build.mjs 入口内联 import），
// ?t= 重载即刷新 lib，无缓存问题；因此 rspack 入口（dsh-run/dsh-update/dsh-install）可以
// 静态 import lib。非 bundle 侧（routes/webui.js、index.js）保持经 globalThis 单例调用。
// 进程单例挂 globalThis.__dshHanako，供 index.js 卸载清理。
//
// 权限：external_side_effect（调用 dsh 编码 agent 执行任务，消耗 Hana 宿主 provider 额度，Auto 模式送审）。
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
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
// v0.13.0: 共用模块（lib 内联进 bundle，见文件头「模块结构」）
import {
  getSingleton,
  PLUGIN_ROOT,
  manifestDefaults,
  ELECTRON_NODE,
  ELECTRON_NODE_ENV,
  IS_WIN,
} from "./lib/state.js";
import {
  resolveDshPkgDir,
  installDepsFromPlugin,
  verifyDepsSmoke,
  readDshInstalledVersion,
} from "./lib/install.js";
import { checkDshUpdate } from "./lib/check.js";

const STDERR_CAP = 8192;
const PORT_READY_TIMEOUT_MS = 60000; // web host 端口就绪等待上限
// ---- 统一日志（v0.10.8 定稿：时间戳会话文件，index.js onload 初始化）----
// 当前会话日志 = <dataDir>/logs/<YYYYMMDD-HHmmss-SSS>.log 时间戳会话文件——DSHana 插件
// 全量运行日志（index.js 生命周期 + web host 进程 stdout/stderr + dsh-hana-provider
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
// 构造（dsh-hana-provider 读不到会 warn 停用，不影响主流程）。
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
    out.defaultThinkingLevel = m.defaultThinkingLevel;
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

// 读 dsh-home/settings.yaml 的 agent-default-model（行级解析，零依赖）——
// dsh 默认模型：dsh models 页设置后写回 settings.yaml（selectModel 同源）。
// 返回 { provider, model } 或 null。
function readDshDefaultModel(dshHome) {
  try {
    const f = join(dshHome, "settings.yaml");
    if (!existsSync(f)) return null;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    let inBlock = false;
    const out = {};
    for (const line of lines) {
      if (/^agent-default-model\s*:/.test(line)) {
        inBlock = true;
        continue;
      }
      if (!inBlock) continue;
      const m = line.match(/^(\s+)([A-Za-z]+)\s*:\s*(.*)$/);
      if (!m) break; // 无缩进或非键行 = 出块（子项缩进 ≥1 空格均视为块内，2 空格标准缩进正常解析）
      const k = m[2];
      const v = m[3].trim();
      if (v) out[k] = v.replace(/^['"]|['"]$/g, "");
    }
    return out.provider ? out : null;
  } catch {
    return null;
  }
}

// 读 dsh-home/settings.yaml 的 agent-presets.default（行级解析，零依赖）——
// dsh 默认 agent 预设：Web UI 设置后写回 settings.yaml。返回预设字符串或 null。
function readDshDefaultPreset(dshHome) {
  try {
    const f = join(dshHome, "settings.yaml");
    if (!existsSync(f)) return null;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    let inBlock = false;
    for (const line of lines) {
      if (/^agent-presets\s*:/.test(line)) {
        inBlock = true;
        continue;
      }
      if (!inBlock) continue;
      const m = line.match(/^(\s+)default\s*:\s*(.*)$/);
      if (!m) {
        if (!/^\s/.test(line)) break; // 无缩进 = 出块（顶层键）
        continue; // 块内其他键，继续找 default
      }
      const v = m[2].trim().replace(/^['"]|['"]$/g, "");
      if (v) return v;
    }
    return null;
  } catch {
    return null;
  }
}

// ---- config.json 自动初始化（全新安装免「先保存一次」引导）----
// config.json 不随包分发（宿主设置界面生成，路径 <插件数据目录>/config.json），
// 全新安装时不存在。插件初始化（onload 拉起 web host / 首次工具调用）时按 manifest
// 默认值自动生成 { schemaVersion: 1, global: { ...manifestDefaults }, agents: {}, sessions: {} }，
// 用户装完即可在设置界面看到默认值，无需先手动保存一次。
// 幂等：文件已存在直接返回，绝不覆盖用户配置/宿主生成内容。失败静默：resolve* 有
// 配置快照兜底，不阻塞主流程（生成的只是初始默认值，被覆盖/缺失都不影响功能）。
function ensureConfigJson(cfg) {
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

// reasoningEffort 解析（v0.9.5：全局配置已移除，只接受工具显式参数，无配置回退；
// 不传时由 dsh 默认处理）。返回显式值或 null。
function resolveReasoningEffort(explicit) {
  const v = String(explicit ?? "").trim();
  return v || null;
}

// approvalTimeoutMs 解析（v0.5.12 起为唯一审批配置）：优先直读 dataDir/config.json 的
// global.approvalTimeoutMs（设置界面改动即时生效）：数字 > 0 采用；0 或负数 = 用户显式禁用
// 超时拒绝（返回 0，调用方判断不挂计时器）；非数字/缺失回退配置快照 cfg.approvalTimeoutMs
// （manifest 默认 30000），同样 0/负数 = 禁用。
function resolveApprovalTimeoutMs(cfg) {
  try {
    const cf = join(cfg.dataDir, "config.json");
    if (existsSync(cf)) {
      const j = JSON.parse(readFileSync(cf, "utf8"));
      const v = j?.global?.approvalTimeoutMs;
      if (typeof v === "number" && Number.isFinite(v)) {
        return v > 0 ? v : 0; // 数字合法即采用（0/负数=禁用，不回退快照复活超时）
      }
    }
  } catch {
    /* 读配置失败忽略 */
  }
  const v = Number(cfg.approvalTimeoutMs);
  if (Number.isFinite(v) && v > 0) return v;
  return 0; // 快照缺失/非数字/0/负数：禁用超时拒绝（0，调用方判断）
}

// defaultCwd 解析（「配置单一事实源」哲学，补齐直读兜底）：优先直读
// dataDir/config.json 的 global.defaultCwd（设置界面改动即时生效；Agent 直改文件同样生效），
// 无则回退配置快照/空。工具显式传 cwd 时在 doExecute 内优先，不受影响。
function resolveDefaultCwd(cfg) {
  try {
    const cf = join(cfg.dataDir, "config.json");
    if (existsSync(cf)) {
      const j = JSON.parse(readFileSync(cf, "utf8"));
      const d = j?.global?.defaultCwd;
      if (typeof d === "string" && d.trim()) return d.trim();
    }
  } catch {
    /* 读配置失败忽略 */
  }
  return String(cfg.defaultCwd || "");
}

// ---- 常驻 web host 单例挂载（v0.13.0：getSingleton 本体在 lib/state.js，这里只挂本文件
// 定义/组合的函数；routes/webui.js、index.js、tools/dsh-*.js 经 globalThis 单例调用）----
// 说明：lib/state.js 的 getSingleton 只做初始化 + 字段兜底（ops/depTasks Map），函数挂载
// 由各定义模块负责——本文件挂 closeProcess / collectDiagnostics / updateDsh /
// startWebHost；lib/install.js 挂 installDeps / verifyDeps；lib/check.js 挂 checkDshUpdate
// （见各文件尾部/挂载段）。模块加载顺序：dsh-run.js import lib → lib 顶层挂载先执行 →
// 本文件挂载随后执行，单例字段齐全。
const mountSingleton = () => {
  const g = getSingleton();
  g.closeProcess = closeProcess;
  // v0.8.3: 插件页连接失败自检——经单例挂载诊断收集函数（routes 不静态 import 本模块）
  g.collectDiagnostics = collectWebDiagnostics;
  // v0.13.0: DSH 更新能力层（Agent 工具 dsh_update / 设置页桥接共用；组合 lib 能力）
  g.updateDsh = updateDsh;
  // v0.13.0: lib 能力挂载（getSingleton 本体在 lib/state.js 不再逐函数赋值，这里统一挂；
  // installDeps/verifyDeps 在文件尾部原挂载点另有一次显式赋值，幂等）
  g.installDeps = installDepsFromPlugin;
  g.verifyDeps = verifyDepsSmoke;
  g.checkDshUpdate = checkDshUpdate;
  return g;
};
mountSingleton();

// ---- deferred 唤醒（宿主原生后台任务通道，HRD wake.js 同协议）----
// 工具发起时 deferred:register（登记 + 投递策略）→ 终态 resolve/fail → 宿主投递
// <hana-background-result> 给 Agent 会话（默认唤醒回合，结果结构化直达）。
// 容错纪律：唤醒是终态的旁路通知，任何失败都不抛回调用方（终局落盘不受影响）。
async function registerDeferredWake({ bus, sessionPath, taskId, label }) {
  if (!bus?.request || !sessionPath || !taskId) return false;
  try {
    await bus.request("deferred:register", {
      taskId,
      sessionPath,
      meta: {
        type: "dsh-run",
        label: String(label || ""),
        deliveryIntent: "trigger_parent_turn",
        notifyAgentOnFailure: true,
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveDeferredWake({ bus, taskId, result }) {
  if (!bus?.request || !taskId) return false;
  try {
    await bus.request("deferred:resolve", { taskId, result });
    return true;
  } catch {
    return false;
  }
}

async function failDeferredWake({ bus, taskId, error }) {
  if (!bus?.request || !taskId) return false;
  try {
    await bus.request("deferred:fail", { taskId, error });
    return true;
  } catch {
    return false;
  }
}

// ---- 审批挂起通知（宿主 deferred 通道，独立 taskId 不占用任务完成通道）----
// dsh 会话触发 approval/requested 时任务挂起等应答；插件把审批上下文投递给宿主，
// Agent 收到后调用 dsh_approve 工具应答（allowed-once / rejected）。
// 容错纪律同任务回调：通知失败不影响任务，审批仍可在 dsh Web UI 人工处理。
async function notifyApprovalWake({ bus, sessionPath, opId, approval, task }) {
  if (!bus?.request || !sessionPath) return;
  const taskId = `${opId}::approval::${approval.approvalId}`;
  try {
    await bus.request("deferred:register", {
      taskId,
      sessionPath,
      meta: {
        type: "dsh-approval",
        label: `dsh 审批: ${approval.toolName || "tool"}`,
      },
    });
    await bus.request("deferred:resolve", {
      taskId,
      result: {
        kind: "dsh-approval",
        opId,
        sessionId: approval.sessionId,
        approvalId: approval.approvalId,
        toolName: approval.toolName,
        callId: approval.callId,
        reason: approval.reason ?? null,
        args: approval.args ?? null, // v0.5.12: tool/call 参数原文（命令/路径），Agent 审批决策依据
        taskPreview: String(task ?? "").slice(0, 120),
      },
    });
  } catch {
    /* 通知失败忽略（审批仍可在 web UI 处理）*/
  }
}

// ---- 本地审批应答（自动放行/超时拒绝共用；信封构造同 tools/dsh-approve.js，不 import 避免模块耦合）----
// POST {base}/api/respond，client-response 信封（rpcId 路由 web host pending 表），校验 j.accepted。
// 成功返回 true，失败抛错由调用方决定：自动放行失败回退人工通知，超时拒绝失败静默忽略。
async function respondApprovalLocal(base, approval, outcome) {
  const body = {
    type: "client-response",
    rpcId: approval.rpcId,
    result: {
      ok: true,
      value: {
        sessionId: approval.sessionId,
        approvalId: approval.approvalId,
        outcome,
      },
    },
  };
  const res = await fetch(`${base}/api/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`/api/respond HTTP ${res.status}`);
  const j = await res.json();
  if (!j.accepted) {
    throw new Error(
      `审批应答未接受（${j.reason || "unknown"}）：可能已超时或被其他方处理`,
    );
  }
  return true;
}

// 审批超时拒绝计时器表：key = `${opId}::${approvalId}`（不挂 op 快照上——ap 会落盘序列化，
// timer 是运行时对象；终态清理见 submitTask 的 finally）。所有审批都会挂表（0=禁用除外）。
const approvalTimers = new Map();

// v0.5.9→v0.5.12: tool/call 参数缓存（审批决策信息源，由内容级白名单匹配数据源转型）：
// key = `${opId}::${callId}`，value = { name, args }（args 为命令原文/目标路径的 JSON 字符串
// 或对象，通知时转字符串）。运行期缓存不落盘（审批都是运行期的，落盘无意义）；终态清理同
// approvalTimers（见 submitTask 的 finally）。审批到达时按 approval.callId 反查，把「具体
// 执行了什么」（命令/路径原文）附在审批通知里给 Agent——Agent 看命令原文决策，而不是只看
// 工具名或 model 自述（bash/pwsh 都能执行任意命令，工具名说明不了安全）。
const toolCallCache = new Map();

// ---- 运行期协调状态（v0.10.46：op Map 退役，不再存任务快照）----
// 任务状态（status/output/summary/usage/耗时）不再保存在插件内存：jsonl（dsh 会话日志）是
// 唯一事实源，卡片经 /ops/stream 从 jsonl 重建基线 + 转发 DSH 实时事件，插件零任务状态。
// g.ops 仅保留「审批/取消」运行期协调状态：opId → { task, sessionId, approvalPending,
// pendingApprovals, cancelledRequested }。任务终态时在 submitTask 的 finally 删除条目。
// 用途：① approval/requested 存审批上下文（rpcId 路由 respond），dsh_approve 工具应答；
// ② dsh_cancel 未传 sessionId 时按 opId 反查 sessionId / 标记 cancelledRequested
//   （防 mux 断流时事件循环把取消误判为完成）。

function nextOpId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 5);
  return `op_${ts}_${rand}`;
}

function createOpEntry(opId, { task }) {
  const g = getSingleton();
  g.ops.set(opId, {
    opId,
    task: String(task ?? "").slice(0, 500),
    sessionId: null, // session.create 后回填（dsh_cancel 按 opId 反查取消目标）
    approvalPending: false,
    pendingApprovals: [],
    cancelledRequested: false,
  });
  return opId;
}

// ---- web host 生命周期：spawn dsh web（DSH_HOME 锁进插件数据目录）----
// v0.13.0: dsh 依赖位置解析（resolveDshPkgDir）已提取到 lib/install.js——数据目录
// dsh-pkg/ 优先（Agent npm i @deepseek-ai/dsh 部署的轻量分发形态），插件安装目录
// node_modules 兑底（现役 zip 自带形态）。DSH_HOME 恒在数据目录。
async function ensureWebHost(cfg) {
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
      `dsh 包未就绪：${cliBin} 不存在。请在插件数据目录 dsh-pkg 执行 npm i -P @deepseek-ai/dsh`,
    );
  }

  const dshHome = join(cfg.dataDir, "dsh-home");
  // spawn 的 cwd 必须是已存在目录（无效 cwd 会让 Node 报误导性的 ENOENT）
  mkdirSync(cfg.dataDir, { recursive: true });
  const port = Number(cfg.webPort) || 3080;
  // 当前会话日志 = 时间戳会话文件（index.js onload 已初始化单例 g.logPath）。
  // 单例优先；index.js 未初始化（冷启动边缘）时兜底自建。写进 web/logLastExit/错误消息供诊断。
  const logPath = g.logPath || newWebLogPath(cfg.dataDir);
  // v0.5.11: 会话全文搜索 overlay（dsh 默认 openAt: never 禁用搜索，需 --patch 覆盖为 first-search）
  // v0.8.1: 主题注入 overlay；v0.9.3: 宿主 provider 跟随 overlay——多份 patch 合并为
  // dsh-plugin/dsh-hanako.patch.yml.tpl 单一模板：段1 session-query 静态配置块 + 段2 theme
  // insert + 段3 provider insert（v0.9.5 起恒渲染：hostProvider 恒开跟随宿主，无关闭选项）
  // + 段4 settings insert（v0.9.5 起恒挂载；v0.13.0 改名 dsh-hana-settings 并注入
  // 「检查与更新 DSH」链路 config：dshPkgDir/npmCliPath/electronNode/dataDir）。
  // cordis 插件加载：theme/provider/settings/logger 四段均以包名注册（dsh client 模块发现
  // 按 loader entry 的 name 做 require.resolve('<name>/package.json')，file:// 无法解析），
  // 故启动前须在 $DSH_HOME/profiles/node_modules 统一建 junction（包名 → 插件安装目录
  // dsh-plugin/<pkg>），与 dsh 自维护的 junction farm 同机制（ensureCordisJunctions
  // 每次启动无条件重建）。
  // 启动前渲染模板（占位符→实际路径）到数据目录 dsh-hanako.patch.generated.yml；launcher
  // flag（--profile/--patch）必须位于应用参数（--port）之前。模板缺失/渲染失败时不挂
  // 任何 patch 记 warn（会话全文搜索保持上游默认禁用），不阻断 dsh 启动。
  // v0.9.5 正规化升级：dsh-hana-settings 前身 dsh-hana-default-model 先行改包名注册；
  // 本版 theme/provider 一并正规化——dsh client 模块发现按
  // require.resolve('<name>/package.json') 找 package.json 的 dsh.client 声明，file://
  // 形式无法解析。包名解析锚点是 $DSH_HOME/profiles（baseUrl 父目录的 node_modules），
  // 启动前统一建 junction：$DSH_HOME/profiles/node_modules/
  // <dsh-hana-theme|dsh-hana-provider|dsh-hana-settings|dsh-hana-logger> → 插件安装目录
  // dsh-plugin/<同名包>（与 dsh 自维护的 junction farm 同机制；dsh 的
  // healProfilesModuleFallback 只管理自身依赖闭包，不碰外来 link）。
  // 无条件重建：每次启动删旧建新（不比较 readlink）——junction 状态无条件收敛到当前
  // 代码期望，杜绝一切残留（悬空 junction / 指向旧路径）导致的解析失败；与 patch 每次
  // 渲染覆盖同一哲学。存在性用 lstatSync（不跟随目标）判断——existsSync 沿目标解析，
  // 悬空 junction 会误判不存在，导致 symlinkSync EEXIST。非 junction 同名实体报错
  // 不静默覆盖。
  const ensureCordisJunctions = (dshHome) => {
    const packages = [
      "dsh-hana-theme",
      "dsh-hana-provider",
      "dsh-hana-settings",
      "dsh-hana-logger",
      "dsh-hana-clipboard",
    ];
    for (const pkg of packages) {
      const link = join(dshHome, "profiles", "node_modules", pkg);
      const target = join(PLUGIN_ROOT, "dsh-plugin", pkg);
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
        symlinkSync(target, link, IS_WIN ? "junction" : null);
      } catch (e) {
        // 符号链接创建失败降级：仅记 warn，不阻断 dsh 启动——对应插件会退化为
        // 不可用（client 模块未发现），后端路由与其余插件不受影响
        console.warn(
          `[dsh-run] ${pkg} junction 创建失败（${e?.message || e}），该插件将不可用`,
        );
      }
    }
  };

  const patchFiles = [];
  const patchTpl = join(PLUGIN_ROOT, "dsh-plugin", "dsh-hanako.patch.yml.tpl");
  // 渲染各插件的 config 依赖解析基座占位符——theme/provider/settings/logger 四段均以
  // 包名注册，不再有 file:// URL 占位符；包名经 ensureCordisJunctions 的 junction 解析。
  // v0.13.x B方案：provider 段不再注入 modelsPath/catalogPath（宿主不再经 patch 注入
  // provider 数据，parse 逻辑上移宿主，route 目录改经 HTTP push 下发）——provider config
  // 只剩 dshPkgDir（子进程解析 pi-ai 依赖用）。DSH_PKG_DIR = dsh 包安装目录
  // （provider/settings 段）；LOG_PATH = 本次会话日志文件路径（logger 段，四个内嵌
  // 插件经统一日志服务写入同一文件）；NPM_CLI_PATH / ELECTRON_NODE / DATA_DIR =
  // settings 段「检查与更新 DSH」链路（npm view 查远端版本 + 更新请求/结果文件写入数据目录）。
  const renderPatchTpl = () => {
    const gen = join(cfg.dataDir, "dsh-hanako.patch.generated.yml");
    let content = readFileSync(patchTpl, "utf8")
      .split("{{DSH_PKG_DIR}}")
      .join(cfg.dshPkgDir || resolveDshPkgDir(cfg))
      .split("{{LOG_PATH}}")
      .join(logPath)
      // v0.13.0: dsh-hana-settings「检查与更新 DSH」链路占位符（npm-cli.js 路径 /
      // 宿主 electron node / 插件数据目录）
      .split("{{NPM_CLI_PATH}}")
      .join(join(PLUGIN_ROOT, "node_modules", "npm", "bin", "npm-cli.js"))
      .split("{{ELECTRON_NODE}}")
      .join(ELECTRON_NODE)
      .split("{{DATA_DIR}}")
      .join(cfg.dataDir);
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
        `[dsh-run] patch 模板渲染失败（${e?.message || e}）：不挂任何 patch（dsh 启动不受影响，会话全文搜索保持上游默认禁用）`,
      );
    }
  } else {
    // 模板缺失：不挂任何 patch 记 warn（dsh 启动不受影响，会话全文搜索保持上游默认禁用）
    console.warn(
      "[dsh-run] dsh-plugin/dsh-hanako.patch.yml.tpl 缺失：不挂任何 patch（dsh 启动不受影响，会话全文搜索保持上游默认禁用）",
    );
  }
  const patchArgs = patchFiles.flatMap((p) => ["--patch", p]);
  // 四段 cordis 插件均以包名注册，spawn 前确保 junction 就绪（幂等）
  ensureCordisJunctions(dshHome);
  const child = spawn(
    ELECTRON_NODE,
    [cliBin, "--profile", "web", ...patchArgs, "--port", String(port)],
    {
      cwd: cfg.dataDir,
      stdio: ["ignore", "pipe", "pipe"],
      // v0.9.5: 恒不注入 API Key 环境变量——凭据由 dsh-hana-provider 插件直读
      // 宿主 provider-catalog.json（dsh models 页/任务均走 Hana 宿主 provider）
      env: {
        ...ELECTRON_NODE_ENV,
        DSH_HOME: dshHome,
        DSH_TELEMETRY_DISABLED: "1",
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
  // v0.10.7: stdout/stderr 全量落盘（src=out/err；stderr 另保留内存尾部供诊断界面）。
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
    // v0.8.5: 退出信息记入单例持久字段（随后 g.web 摘除，局部 web.stderr 会丢）——
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
          `dsh web 进程提前退出 (code=${child.exitCode})：${web.stderr.slice(-1200) || "无 stderr"}（完整日志：${logPath}）`,
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
          // v0.8.5: 新进程就绪：清掉上次退出记录（持久字段只反映最近一次退出）
          g.webLastExit = null;
          // v0.13.1：B方案下子进程启动时 snapshot 为空，首批 provider 依赖宿主 push。
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
      `dsh web 启动超时（${Math.round(PORT_READY_TIMEOUT_MS / 1000)}s 内端口 ${port} 未就绪）：${web.stderr.slice(-1200) || "无 stderr"}（完整日志：${logPath}）`,
    );
  })();
  web.readyPromise = readyPromise;
  g.web = web;
  return readyPromise;
}

// ---- 宿主侧 provider 跟随 push 链路（v0.10.7：fs.watch → ctx.resources.watch + HTTP push）----
// 语义：dsh-hana-provider 插件不再自建 fs.watch（Windows rename 原子替换等平台坑一并消除）——
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
      "[dsh-run] 宿主 resources 不可用，provider 热跟随 watch 未建立（dsh 侧启动时仍会 refresh 一次）",
    );
    return;
  }
  if (!bus || typeof bus.subscribe !== "function") {
    console.warn(
      "[dsh-run] 宿主 bus 不可用，provider 热跟随订阅未建立（dsh 侧启动时仍会 refresh 一次）",
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
        { purpose: "dsh-hana-provider-sync" },
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
      "[dsh-run] provider 热跟随 watch 全部建立失败（dsh 侧启动时仍会 refresh 一次）",
    );
    return;
  }
  // bus.subscribe 返回 unsubscribe 函数（SDK 类型 () => void）；防御性兼容 { unsubscribe } 形状
  const unsub = bus.subscribe((event) => {
    if (!event || typeof event !== "object") return;
    if (event.type !== "resource.changed") return;
    const key = event.resourceKey;
    if (typeof key === "string" && resourceKeys.has(key)) {
      console.log(`[dsh-run] 宿主配置变化（${key}），防抖后 push dsh 刷新`);
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
    `[dsh-run] provider 热跟随 watch 已建立（${paths.length} 文件），宿主配置变化将 push dsh 刷新`,
  );
}

// ---- DSH 检查能力（v0.13.0：checkDshUpdate / npmViewLatest / semver 比较 / 本地版本
// 直读已提取到 lib/check.js + lib/install.js，经 getSingleton 挂 g.checkDshUpdate 供
// Agent 工具 dsh_update / DSHana 标签页 webui 路由 / 设置页桥接三面共用，单一事实源）----

// ---- 更新 DSH（能力层）：停 web host（closeProcess——回收子进程，Windows 文件锁前提：
// npm i 要替换被 web host 占用的 dsh 包文件）→ installDepsFromPlugin（npm i
// @deepseek-ai/dsh = 装 latest，成功即新版本）→ 起 web host（ensureWebHost，失败不阻断
// 结果上报，记 error 字段）→ 读新版本。全程写 <dataDir>/update-result.json
// { state: done|error, version?, error?, at }（dsh 设置页 update-status 路由读）。
// 并发防护：g.updating 进行中重复调用返回 { ok:false, state:"updating" } 不重复执行；
// 与 installDepsFromPlugin 内部 g.depsInstalling 独立（本标志管整条更新流程）。----
async function updateDsh(cfg) {
  const g = getSingleton();
  if (g.updating) return { ok: false, state: "updating" };
  g.updating = true;
  g.updateError = null;
  const dataDir = cfg.dataDir || g.dataDir;
  const resultFile = join(dataDir, "update-result.json");
  const requestFile = join(dataDir, "update-request.json");
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
    log("执行 npm i @deepseek-ai/dsh（latest）…");
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
    // ④b 重启后重建宿主侧 watch——closeProcess 已清理旧 watch（provider 热跟随 + DSH
    // 检查/更新桥接），ensureWebHost 本身不建 watch（只有 startWebHostFromPlugin 建），
    // 不重建则更新后设置页检查/更新请求不再触发宿主处理
    ensureProviderPushWatch(cfg);
    // v0.13.1: 重启用进程后首批 provider 的初始 push 已由 ensureWebHost（唯一就绪点）
    // 发出；此处只重建跟随 watch，不再重复 push。
    ensureUpdateWatch(cfg);
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
    log(`更新失败：${err}`);
    return { ok: false, state: "error", error: err };
  } finally {
    // ⑥ 清 update-request.json（写回 idle，防重复触发）
    try {
      writeFileSync(requestFile, JSON.stringify({ state: "idle" }), "utf8");
    } catch {
      /* 清理失败不阻断 */
    }
    // ⑦ 解锁
    g.updating = false;
  }
}

// ---- 宿主侧 DSH 检查/更新桥接 watch（v0.13.0：dsh 设置页「DSH 版本」块 → 宿主能力层）----
// 语义：dsh-hana-settings 插件写 <dataDir>/update-request.json（state: 'check-requested'
// 请求版本检查 / 'requested' 请求更新），宿主侧经 ctx.resources.watch 感知变化（bus 派发
// resource.changed，resourceKey 格式 local_fs:<path>）→ 读文件按 state 分发：
//   check-requested → checkDshUpdate（结果写 check-result.json，dsh 侧路由读回）
//   requested → updateDsh（写 update-result.json，npm i latest + 重启 web host）
// 防抖去重：用能力层自身运行期标志——检查 g.checking / 更新 g.updating 进行中重复请求
// 直接跳过（在飞操作的结果会写对应结果文件）；检查另加 5s 时间窗（刚检查过不重复跑
// npm view，结果已在 check-result.json）。watch 建立失败降级不阻断（设置页版本块仍可
// 显示本地版本，检查/更新按钮请求写入后无人消费——降级可接受）。
// 幂等：startWebHost 重复调用 / web host 重建时先清理旧 watch 再建；cleanup 挂单例
// g.updateWatchCleanup，closeProcess 回收 web host 时调用（退订 bus + 关 watchers）。
function ensureUpdateWatch(cfg) {
  const g = getSingleton();
  // 幂等：先清理旧 watch + 退订（startWebHost 重复调用 / web host 重建时）
  if (typeof g.updateWatchCleanup === "function") {
    try {
      g.updateWatchCleanup();
    } catch {
      /* 清理失败不阻断 */
    }
    g.updateWatchCleanup = null;
  }
  const resources = g.resources;
  const bus = g.bus;
  // resources/bus 缺失（旧宿主无此服务 / onload 未注入）：降级不阻断
  if (!resources || typeof resources.watch !== "function") {
    console.warn(
      "[dsh-run] 宿主 resources 不可用，DSH 检查/更新桥接 watch 未建立（设置页检查/更新请求将不触发宿主处理）",
    );
    return;
  }
  if (!bus || typeof bus.subscribe !== "function") {
    console.warn(
      "[dsh-run] 宿主 bus 不可用，DSH 检查/更新桥接 watch 未建立（设置页检查/更新请求将不触发宿主处理）",
    );
    return;
  }
  const dataDir = cfg.dataDir || g.dataDir;
  if (!dataDir) {
    console.warn("[dsh-run] 缺少 dataDir，DSH 检查/更新桥接 watch 未建立");
    return;
  }
  const path = join(dataDir, "update-request.json");
  // watch 前确保文件存在（不存在则写 { state: 'idle' } 占位——resources.watch 对不存在的
  // 文件可能不派发事件，占位保证文件系统就位后变化可感知）
  try {
    if (!existsSync(path)) {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(path, JSON.stringify({ state: "idle" }), "utf8");
    }
  } catch (e) {
    console.warn(
      `[dsh-run] update-request.json 占位写入失败（${e?.message || e}），检查/更新桥接 watch 未建立`,
    );
    return;
  }
  const handles = [];
  const resourceKeys = new Set();
  try {
    const handle = resources.watch(
      { kind: "local-file", path },
      { purpose: "dsh-hana-update" },
    );
    handles.push(handle);
    // watch 返回 { subscriptionId, resourceKeys, unsubscribe, close }：resourceKeys 即
    // 事件过滤键（格式 local_fs:<path>）；无 resourceKeys 时按约定格式兜底
    if (Array.isArray(handle?.resourceKeys) && handle.resourceKeys.length > 0) {
      for (const key of handle.resourceKeys) resourceKeys.add(key);
    } else {
      resourceKeys.add(`local_fs:${path}`);
    }
  } catch (e) {
    console.warn(
      `[dsh-run] DSH 检查/更新桥接 watch 建立失败 ${path}（${e?.message || e}），设置页检查/更新请求将不触发宿主处理`,
    );
    return;
  }
  // bus.subscribe 返回 unsubscribe 函数（SDK 类型 () => void）；防御性兼容 { unsubscribe } 形状
  const unsub = bus.subscribe((event) => {
    if (!event || typeof event !== "object") return;
    if (event.type !== "resource.changed") return;
    const key = event.resourceKey;
    if (typeof key === "string" && resourceKeys.has(key)) {
      onBridgeRequestChanged(dataDir, path, cfg);
    }
  });
  g.updateWatchCleanup = () => {
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
    g.updateWatchCleanup = null;
  };
  console.log(
    `[dsh-run] DSH 检查/更新桥接 watch 已建立（${path}），设置页检查/更新请求将触发宿主处理`,
  );
}

// update-request.json 变化分发（check-requested → 版本检查；requested → 更新）。
// 防抖去重：检查/更新进行中（g.checking / g.updating）直接跳过——在飞操作的结果会写
// 对应结果文件；检查另加 5s 时间窗（刚检查过不重复跑 npm view）。失败只记日志不抛出。
function onBridgeRequestChanged(dataDir, path, cfg) {
  const g = getSingleton();
  let req = null;
  try {
    req = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return; // 解析失败/不存在：忽略
  }
  if (!req || typeof req !== "object") return;
  if (req.state === "check-requested") {
    if (g.checking || g.updating) return; // 进行中：跳过（在飞操作的结果会写 check-result.json）
    if (g.checkAt && Date.now() - g.checkAt < 5000) return; // 5s 内刚检查过：结果已在 check-result.json
    console.log(
      "[dsh-run] 收到 DSH 版本检查请求（设置页），执行 checkDshUpdate",
    );
    checkDshUpdate(cfg).catch((e) => {
      console.warn(`[dsh-run] 版本检查异常：${e?.message || e}`);
    });
  } else if (req.state === "requested") {
    if (g.updating) return; // 更新中：跳过（重复触发防护）
    console.log("[dsh-run] 收到 DSH 更新请求（设置页），执行 updateDsh");
    updateDsh(cfg).catch((e) => {
      console.warn(`[dsh-run] DSH 更新异常：${e?.message || e}`);
    });
  }
}

// push dsh web host 刷新（回环调用 127.0.0.1:{port}；结果写入统一会话日志 + console 简记，
// 失败不阻断。v0.13.x B方案：body 携带组装好的 route 目录（buildProviderRoutes() 的
// 最新 routes），子进程 applySnapshot 直接消费，不再自读宿主文件（buildProviderRoutes
// 内部已处理「读取失败保留旧 routes」回退）。
//
// v0.13.1 有界重试 + 回环 fetch 直连：B方案下子进程启动时 snapshot 为空、首批 provider
// 全依赖这次 push。但 dsh web host 的 /api/host.describe 就绪（宿主判定 ready）早于
// 子进程内插件的 apply() 完成——dsh-hana-provider 的 apply 要先 await 动态导入
// pi-ai/dsh-llm/dsh-timeout，之后才经 ctx.inject(['webServer']).effect 注册
// /api/hana-provider.refresh 路由。启动 push 若只发一次，会打在路由注册前的空窗上
// （404/连接拒绝），provider 快照将一直为空直到宿主配置变化触发下一轮 push——即
// 「dsh-hana-provider 失效」。因此 push 改为对非 2xx（尤其 404）与网络错误按退避表
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
  // v0.10.2: 插件初始化（拉起 web host）即自动生成 config.json（不存在时按 manifest 默认值）
  ensureConfigJson(cfg);
  // 单例记数据目录（dsh_ops 经 g.dataDir 定位 dsh 会话缓存等数据文件）
  getSingleton().dataDir = cfg.dataDir;
  if (!cfg.dshPkgDir) cfg.dshPkgDir = resolveDshPkgDir(cfg);
  try {
    await ensureWebHost(cfg);
    // v0.10.7: web host 就绪后建立宿主侧 provider 跟随 push watch（幂等：先清理旧 watch 再建）
    ensureProviderPushWatch(cfg);
    // v0.13.1：首批 provider 的初始 push 已收敛进 ensureWebHost（唯一就绪点，含重试），
    // 此处不再重复推；后续每次 resource.changed 经防抖 watch 增量 push。
    // v0.13.0: DSH 检查/更新桥接 watch（幂等）：dsh 设置页「DSH 版本」块写
    // update-request.json → 宿主 checkDshUpdate / updateDsh（单一事实源）
    ensureUpdateWatch(cfg);
    return true;
  } catch (e) {
    // 记录失败原因供诊断（onload 侧只能看到布尔）；后续工具调用重试
    const g = getSingleton();
    g.webLastError = String(e?.message || e).slice(0, 1500);
    if (g.web?.stderr)
      g.webLastError += `\n[dsh web stderr] ${g.web.stderr.slice(-800)}`;
    // v0.10.7: 失败也记日志路径（诊断界面可跳完整日志；g.web 在启动失败后可能已摘除，
    // 从 webLastExit 取兜底）
    const logPath = g.web?.logPath || g.webLastExit?.logPath || null;
    if (logPath) g.webLastLogPath = logPath;
    g.webLastErrorAt = new Date().toISOString();
    return false;
  }
};

// v0.13.0: installDepsFromPlugin / verifyDepsSmoke 已提取到 lib/install.js（本文件顶部
// import），这里显式挂单例（getSingleton 本体在 lib/state.js 不再逐函数赋值；mountSingleton
// 与 lib 侧挂载保持同款幂等语义）。routes/webui.js 经 g.installDeps / g.verifyDeps 调用。
getSingleton().installDeps = installDepsFromPlugin;
getSingleton().verifyDeps = verifyDepsSmoke;

// ---- 连接失败自检（v0.8.3: 插件页 web host 未就绪时的诊断数据源）----
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
    // v0.8.8: 不再自动触发运行级检测（去掉 maybeTriggerDepsSmoke）——检测改为「进标签页
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
  const installAt = g.depsInstallAt || null; // v0.8.8: 最近一次 npm i 输出时间（实时进度）
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
  // v0.13.0: 当前版本（运行级验证缓存优先，无则直读 dsh-pkg package.json）+ 版本检查
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
    name: "dsh 依赖安装",
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
    // v0.13.0: 版本/检查/更新状态（deps 卡片版本行 + 检查更新/更新 DSH 按钮）
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
    detail: "",
    fix: "",
  };
  if (installing) {
    // v0.8.8: 安装中（含重装场景 installed 仍可能为 true）优先——实时进度
    // installLog 尾部由前端 .diag-progress 展示（随轮询刷新）
    check.detail = "正在安装依赖…（npm i，进度见下方）";
    check.fix = "";
  } else if (!installed) {
    // 未安装：保持现有文案
    check.detail =
      "未找到 dsh 包：" +
      cliBin +
      " 不存在" +
      (checked.length > 1 ? "（已检查 " + checked.join("、") + "）" : "");
    if (installError) check.detail += "\n[上次安装失败] " + installError;
    check.fix =
      "依赖缺失：点击本卡片「安装依赖」按钮自动在插件数据目录 dsh-pkg 执行 npm i @deepseek-ai/dsh（完成后自动验证）；或确认插件目录 node_modules 解压完整";
  } else if (!smoke) {
    // v0.8.8: 未检测过（进标签页自动检测一次 / 手动「检测依赖」；ok 暂算 installed）
    check.detail = "dsh 包已就绪，点击「检测依赖」验证依赖完整性";
  } else if (verifyRunning) {
    // 检测进行中：ok 暂 true，结果由检测接口返回后刷新
    check.detail = "正在检测依赖完整性…";
  } else if (!smoke.ok) {
    // 存在但验证失败：依赖图不完整（ERR_MODULE_NOT_FOUND 等真实错误）
    check.detail =
      "dsh 包存在但依赖不完整：" +
      (verifyError ? "\n" + verifyError : "运行级验证失败");
    check.fix =
      "点击本卡片「重新安装依赖」按钮重新执行 npm i @deepseek-ai/dsh（自动部署到 dsh-pkg，完成后自动验证）";
  } else {
    // 存在 + 验证通过：能跑 = 依赖图完整
    check.detail =
      "dsh 包已就绪（运行级验证通过，版本 v" +
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
  // v0.10.7: 本次会话日志路径（当前 web / 退出记录 / 失败记录，三级兜底）
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
  if (/dsh 包未就绪|cliBin|npm i/i.test(text)) {
    return "按上方「dsh 依赖安装」项修复（数据目录 dsh-pkg 执行 npm i @deepseek-ai/dsh，完成后自动验证）";
  }
  if (/EADDRINUSE|address already in use|占用|bind/i.test(text)) {
    return "检查端口 " + port + " 是否被占用（释放后重启 Hana）";
  }
  return "检查上方依赖项；仍失败请重启 Hana 后重试";
}

export async function closeProcess() {
  const g = getSingleton();
  // 先清理 watch（provider 热跟随 + DSH 检查/更新桥接），再回收 web host 进程
  if (typeof g.providerPushCleanup === "function") {
    try {
      g.providerPushCleanup();
    } catch {
      /* 清理失败不阻断 */
    }
  }
  if (typeof g.updateWatchCleanup === "function") {
    try {
      g.updateWatchCleanup();
    } catch {
      /* 清理失败不阻断 */
    }
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

// ---- HTTP RPC 客户端（dsh web /api 网关，fetch 载波）----
// Unary：POST /api/<method>，body = { type:"client-request", rpcId, method, payload }
// 响应 ServerResponse：rpcId 回显 + result.ok/value 或 result.ok=false + error。
function nextRpcId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function callUnary(base, method, payload, signal, meta) {
  const rpcId = nextRpcId();
  const res = await fetch(`${base}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
    signal,
  });
  if (!res.ok) throw new Error(`dsh /api/${method} HTTP ${res.status}`);
  const full = await res.json();
  if (!full || full.rpcId !== rpcId)
    throw new Error(`dsh /api/${method} rpcId 不匹配`);
  if (!full.result || !full.result.ok) {
    const e = full.result?.error || {};
    throw new Error(
      `dsh ${method} 失败：${e.code || "unknown"} ${e.message || ""}`,
    );
  }
  // meta.rpcId 回传：会话 jsonl 的 user/message 事件 data.source.rpcId 与此相同，
  // 供 op 快照记录后用 sessionId+rpcId 从 jsonl 精确恢复（重启不丢、零映射文件）
  if (meta && typeof meta === "object") meta.rpcId = rpcId;
  return full.result.value;
}

// ---- 事件流（/api/events.mux，WebSocket 通道）----
// dsh 的事件流要求 WebSocket 升级（GET 返回 426 Upgrade Required，浏览器 UI 即走 WS）。
// Node 24 内置全局 WebSocket；帧为 JSON，payload 即 MuxFrame。
async function* openMux(base, signal) {
  if (typeof WebSocket !== "function") {
    throw new Error("宿主环境无全局 WebSocket，无法订阅 dsh 事件流");
  }
  const url = base.replace(/^http/, "ws") + "/api/events.mux";
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  let wsError = null;
  let wsClosed = false;
  ws.onmessage = (ev) => {
    let frame = {};
    let envelope = null;
    try {
      envelope = JSON.parse(ev.data);
      frame = envelope?.payload || envelope || {};
    } catch {
      return;
    }
    // server-request 信封（approval/requested 等应答类帧）：外层 rpcId 补进 frame——
    // dsh web host 的 /api/respond 靠 client-response 信封的 rpcId 路由 pending 表，
    // 审批帧的 rpcId 只在外层，只取 payload 会丢（审批应答就断链）。
    if (
      envelope &&
      typeof envelope === "object" &&
      typeof envelope.rpcId === "string" &&
      typeof frame.rpcId !== "string"
    ) {
      frame.rpcId = envelope.rpcId;
    }
    if (!frame || typeof frame.type !== "string") return;
    if (waiters.length) waiters.shift()(frame);
    else queue.push(frame);
  };
  ws.onerror = () => {
    wsError = new Error("dsh events.mux WebSocket 错误");
  };
  ws.onclose = () => {
    wsClosed = true;
    while (waiters.length) waiters.shift()(null);
  };
  if (signal?.aborted) {
    try {
      ws.close();
    } catch {}
    throw Object.assign(new Error("dsh_run 已取消"), { code: "DSH_ABORTED" });
  }
  const onAbort = () => {
    try {
      ws.close();
    } catch {}
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(wsError || new Error("dsh events.mux 连接失败"));
  });
  try {
    while (true) {
      if (queue.length) {
        yield queue.shift();
        continue;
      }
      if (wsError) throw wsError;
      if (wsClosed) return;
      const frame = await new Promise((resolve) => waiters.push(resolve));
      if (frame === null) return;
      yield frame;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

// 从 assistant/chunk 提取文本增量（宽松：delta/block 里任何 {type:"text",text} 都收）
function textFromChunk(chunk) {
  if (!chunk || typeof chunk !== "object") return "";
  const c = chunk.chunk || chunk;
  const t = c?.delta?.text ?? c?.block?.text ?? c?.text;
  return typeof t === "string" ? t : "";
}

// 从 assistant/message 提取文本（content block 数组里 type==="text" 的 text 拼接）
function textFromMessageBlocks(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

// ---- 回调摘要构建（PTC 式压缩：中间步骤不进 Agent 上下文）----
// 参考 dsh PTC 模式（Code Mode SDK：一次程序执行替代多次工具往返）的思路：
// 中间过程是噪音，最终结论才是信号。完整输出保留在 op 快照（卡片可查）
// 与 dsh web UI（sessionId 定位），回调只带最终结论摘要。
// 摘要锚点：最后一条 assistant/message 的文本，即 dsh 对任务的最终汇报。
const SUMMARY_HEAD = 1500;
const SUMMARY_TAIL = 600;

function buildSummary(output, finalText) {
  const full = String(output ?? "");
  const candidate = String(finalText ?? "").trim();
  if (candidate) {
    return {
      text: candidate,
      summaryOf: "final-message",
      fullLength: full.length,
    };
  }
  if (full.length > SUMMARY_HEAD + SUMMARY_TAIL) {
    const hidden = full.length - SUMMARY_HEAD - SUMMARY_TAIL;
    return {
      text: `${full.slice(0, SUMMARY_HEAD)}\n\n…[中间过程 ${hidden} 字符已折叠，完整输出见 op 快照 / dsh web UI]…\n\n${full.slice(-SUMMARY_TAIL)}`,
      summaryOf: "head-tail",
      fullLength: full.length,
    };
  }
  return { text: full, summaryOf: "full", fullLength: full.length };
}

// v0.5.9: 缓存 tool/call 帧的参数原文（内容级白名单匹配的数据源）。
// payload 兼容两种帧形：session/event 包裹的 tool/call 事件（ev.data={name,arguments,callId}）
// 或直发帧（frame.data={name,arguments,callId}，宿主 backscanArgs 同款字段结构）。
// arguments 是 JSON 字符串时原样存（子串匹配足够），对象则序列化；无 callId 的帧不缓存。
function cacheToolCall(opId, payload) {
  if (!payload || typeof payload !== "object") return;
  const callId = payload.callId;
  if (typeof callId !== "string" || !callId) return;
  let args = payload.arguments;
  if (typeof args !== "string") {
    try {
      args = args === undefined || args === null ? "" : JSON.stringify(args);
    } catch {
      args = String(args ?? "");
    }
  }
  toolCallCache.set(`${opId}::${callId}`, {
    name: typeof payload.name === "string" ? payload.name : "",
    args,
  });
}

// ---- 任务提交：注册运行期协调状态 + 后台执行（不 await）----
// 返回 { opId, promise, ready }：opId 立即可用（构造卡片 route / deferred taskId），
// promise 在后台跑：session.create → events.mux 订阅 → session.prompt → 事件循环 → 终态。
// v0.10.46：任务状态零存储（op Map 退役）——collected/blocksSeq/usageTotal 仅用于回调返回，
// 卡片状态由 /ops/stream 从 jsonl 重建 + 实时事件转发呈现。
function submitTask(
  cfg,
  {
    task,
    cwd,
    timeoutMs = 600000,
    signal,
    bus,
    sessionPath,
    agentPreset,
    reasoningEffort,
    sessionId,
    provider,
    model,
  },
) {
  const taskText = String(task ?? "").trim();
  if (!taskText) throw new Error("task 不能为空");

  // agent 预设解析（卡片详情区展示 agentPreset，需在提交前解析补齐）。
  // 显式参数优先，缺省从 settings.yaml 的 agent-presets.default 补齐（与 dsh 默认预设一致）。
  let preset = String(agentPreset ?? "").trim() || null;
  if (!preset) {
    const dp = readDshDefaultPreset(join(cfg.dataDir, "dsh-home"));
    preset = dp || null;
  }
  // reasoningEffort 解析：只取工具显式参数（全局配置已移除），不传为 null（由 dsh 默认处理）。
  const effort = resolveReasoningEffort(reasoningEffort);
  // resume 会话解析：值为 null 或 sessionId
  const resumeSessionId = String(sessionId ?? "").trim() || null;

  // provider/model 解析补齐：显式参数优先；只传其一/都不传时从 dsh 默认模型（settings.yaml）补齐。
  const explicitProvider = String(provider ?? "").trim();
  const explicitModel = String(model ?? "").trim();
  let opProvider = explicitProvider;
  let opModel = explicitModel;
  if (!opProvider || !opModel) {
    const dm = readDshDefaultModel(join(cfg.dataDir, "dsh-home"));
    opProvider = opProvider || (dm && dm.provider) || "";
    opModel = opModel || (dm && dm.model) || "";
  }
  const opId = createOpEntry(nextOpId(), { task: taskText });
  // ready：session.create + prompt 提交完成时 resolve { sessionId, rpcId }（卡片 URL 推迟到此后生成，
  // 重启后按 sessionId+rpcId 从会话 jsonl 精确恢复 op，零映射文件）；失败 resolve null（降级 opId-only URL）
  let resolveReady = null;
  const ready = new Promise((r) => {
    resolveReady = r;
  });
  // usageTotal 提升到 submitTask 作用域：事件循环累计（assistant/message 的 d.usage 是每轮 LLM 调用用量，
  // 覆盖式只保留最后一轮、多轮任务严重偏小；按 disjoint 口径累计 = 未缓存输入/输出/缓存读取/推理之和，
  // 与 dsh 会话投影 tokenUsage.totals 对齐）。ok 终态与 promise.catch 的错误终态都能读到。
  let usageTotal = null;

  const promise = (async () => {
    const web = await ensureWebHost(cfg);
    const base = `http://127.0.0.1:${web.port}`;

    // 1. 建会话：无 sessionId = 新建（干净起点，完成后留在 web 历史中可继续）；
    // 有 sessionId = resume 该会话（context 继承，agent 记得上个任务的内容，省上下文重建）。
    // resume 必须显式传会话已有 cwd：web host 的 session.create 服务端 cwd 回退是
    // request.payload.cwd ?? defaults.cwd（defaults.cwd = web host 进程 cwd = 插件数据目录），
    // 不传会与目标会话既有 cwd 不符触发 session-conflict，create 不会自动采用会话已有 cwd。
    // 故 resume 分支先 session.list 查目标会话已有 cwd（忽略用户传入的 cwd——resume 语义即沿用会话）。
    // agentPreset 无值不传（缺省走 web host 默认，Web UI 可调）
    let createPayload;
    if (resumeSessionId) {
      const list = await callUnary(base, "session.list", {
        projections: ["id", "cwd"],
      });
      const items = list.items || [];
      const existing = items.find((it) => it.sessionId === resumeSessionId);
      if (!existing)
        throw new Error(
          `目标会话不存在或已归档，无法 resume：${resumeSessionId}`,
        );
      // 异常会话（cwd 为空/缺失）回退用户传的 cwd 或 defaultCwd，再不行才报错
      const resumeCwd = String(existing.cwd ?? "").trim() || cwd;
      if (!resumeCwd)
        throw new Error(
          `目标会话 ${resumeSessionId} 无 cwd 且无可用回退 cwd，无法 resume`,
        );
      createPayload = {
        sessionId: resumeSessionId,
        cwd: resumeCwd,
        ...(preset && { agentPreset: preset }),
      };
    } else {
      createPayload = { cwd, ...(preset && { agentPreset: preset }) };
    }
    const session = await callUnary(base, "session.create", createPayload);
    const sessionId = session.sessionId;
    // 运行期协调状态回填 sessionId（dsh_cancel 未传 sessionId 时按 opId 反查取消目标）
    const entryNow = getSingleton().ops.get(opId);
    if (entryNow) entryNow.sessionId = sessionId;

    // 1.5 模型选择：仅当工具显式传 provider/model/effort 时才 selectModel（显式覆盖
    // dsh 默认模型）；都不传时不 selectModel，任务直接用 dsh 默认模型
    // （settings.yaml agent-default-model）。dsh 的 selectModel 会把所选模型写回全局
    // 默认 settings.yaml——显式指定即成为新默认（注意：任何 selectModel(sensenova)
    // 都会把默认覆盖回 sensenova，要长期固定 deepseek 需在 dsh models 页设置默认）。
    const explicitProvider = String(provider ?? "").trim();
    const explicitModel = String(model ?? "").trim();
    if (explicitProvider || explicitModel || effort) {
      // 只传其一/只传 effort 时，另一侧从 dsh 默认模型（settings.yaml）补齐
      let sp = explicitProvider;
      let sm = explicitModel;
      if (!sp || !sm) {
        const dm = readDshDefaultModel(join(cfg.dataDir, "dsh-home"));
        sp = sp || (dm && dm.provider) || "";
        sm = sm || (dm && dm.model) || "";
      }
      if (!sp || !sm) {
        throw new Error(
          "dsh_run 需要 provider/model：请显式传 provider/model，或先在 dsh models 页设置默认模型（settings.yaml agent-default-model）",
        );
      }
      const selectModelPayload = {
        sessionId,
        provider: sp,
        model: sm,
        ...(effort ? { reasoningEffort: effort } : {}),
      };
      try {
        await callUnary(base, "session.selectModel", selectModelPayload);
      } catch (err) {
        // 显式 effort 被拒（如 reasoning:false 模型不接受 effort）：降级不带 effort 重试
        if (
          effort &&
          String(err?.message || "").includes("model-unavailable")
        ) {
          await callUnary(base, "session.selectModel", {
            sessionId,
            provider: sp,
            model: sm,
          });
        } else {
          throw err;
        }
      }
    }

    // 2. 开 mux 事件流 + prompt 竞速
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    let collected = "";
    let finalMessageText = ""; // 最后一条 assistant/message 的文本（回调摘要锚点）
    let blocksSeq = []; // assistant/message 的 blocks（终态回调输出结构化，reasoning 可折叠）
    let sawChunk = false;
    const seen = new Set();
    let outcome = null; // { stopReason, failure? }

    const consume = (async () => {
      try {
        for await (const frame of openMux(base, ac.signal)) {
          if (frame.sessionId && frame.sessionId !== sessionId) continue;
          if (frame.type === "session/event") {
            const ev = frame.event;
            const d = ev?.data;
            if (!d) continue;
            if (ev.type === "assistant/chunk") {
              sawChunk = true;
              // v0.9.4.1: 错误透传——finish 帧 reason=error（如 429/400）直接带真实信息
              const c = d?.chunk;
              if (c?.type === "finish" && c.reason?.kind === "error") {
                const f = c.reason.failure || c.reason.error || {};
                outcome = {
                  stopReason: "error",
                  failure: {
                    message:
                      f.message || c.reason.message || "模型调用失败（无详情）",
                  },
                };
                return;
              }
              const t = textFromChunk(d);
              if (t) collected += t; // 仅本地收集（回调输出用）；不再写 op Map
            } else if (ev.type === "assistant/message") {
              const msg = d.message;
              if (msg?.id && typeof msg.id === "string" && !seen.has(msg.id)) {
                seen.add(msg.id);
                const t = textFromMessageBlocks(msg.content);
                if (!sawChunk && t) {
                  // chunk 流已提供文本时跳过拼接，避免重复
                  collected += t;
                }
                if (t) finalMessageText = t; // 每条覆盖，结束时即最终汇报（摘要锚点）
                // 收集结构化 blocks（text/reasoning/tool-call）：终态 op.output 供卡片完整输出折叠渲染
                const blocks = Array.isArray(msg.content) ? msg.content : [];
                for (const b of blocks) {
                  if (
                    b?.type === "text" &&
                    typeof b.text === "string" &&
                    b.text
                  )
                    blocksSeq.push({ type: "text", text: b.text });
                  else if (
                    b?.type === "reasoning" &&
                    typeof b.text === "string" &&
                    b.text
                  )
                    blocksSeq.push({ type: "reasoning", text: b.text });
                  else if (b?.type === "tool-call" && b.name)
                    blocksSeq.push({ type: "tool-call", name: b.name });
                }
              }
              if (d.usage) {
                // 累计：inputTokens 已是 disjoint（不含 cacheRead），各字段求和即任务维度总量；
                // 缺失字段不初始化（API 未返回时卡片不显示，避免 0 误报）
                const u = d.usage;
                usageTotal = usageTotal || {};
                usageTotal.inputTokens =
                  (usageTotal.inputTokens || 0) + (u.inputTokens ?? 0);
                usageTotal.outputTokens =
                  (usageTotal.outputTokens || 0) + (u.outputTokens ?? 0);
                if (u.cacheReadTokens != null)
                  usageTotal.cacheReadTokens =
                    (usageTotal.cacheReadTokens || 0) + u.cacheReadTokens;
                if (u.reasoningTokens != null)
                  usageTotal.reasoningTokens =
                    (usageTotal.reasoningTokens || 0) + u.reasoningTokens;
              }
            } else if (ev.type === "tool/call") {
              // v0.5.9: 缓存工具调用参数原文（session/event 包裹的 tool/call 事件，
              // d = { name, arguments, callId }），审批到达时按 callId 反查做内容级匹配。
              cacheToolCall(opId, d);
            } else if (ev.type === "tool/code-dispatch-start") {
              // v0.5.13: code preset 子调用分发事件（d = { rootCallId, parentCallId,
              // subCallId, name, arguments }）：run_code 内联的工具调用（如 write）以子调用
              // 形式派发，参数不产生独立 tool/call 帧；按 subCallId 缓存（形如 `root:code:N`），
              // 审批帧 callId 即该 subCallId，可精确反查到命令/路径原文。
              cacheToolCall(opId, {
                callId: d.subCallId,
                name: d.name,
                arguments: d.arguments,
              });
            } else if (ev.type === "turn/end") {
              const reason = d.reason;
              const kind = reason?.kind;
              if (kind === "completed") outcome = { stopReason: "end_turn" };
              else if (kind === "max-tokens")
                outcome = { stopReason: "max_tokens" };
              else if (kind === "aborted") outcome = { stopReason: "aborted" };
              else if (reason?.failure)
                outcome = { stopReason: "error", failure: reason.failure };
              else if (reason?.error)
                outcome = {
                  stopReason: "error",
                  failure: {
                    message: reason.error.message || "模型调用失败（无详情）",
                  },
                };
              else if (kind === "error")
                outcome = {
                  stopReason: "error",
                  failure: { message: "dsh 任务失败（无错误详情）" },
                };
              else outcome = { stopReason: kind || "end_turn" };
              return; // 一次 prompt = 一个 turn，turn/end 即终态
            }
          } else if (frame.type === "approval/requested") {
            // 审批挂起（approval/policy=ask）：任务会等待应答。把审批上下文（含 respond
            // 路由所需的 rpcId）存进运行期协调状态（g.ops 条目，非任务快照），并触发
            // 宿主 deferred 通知（独立 taskId，不占用任务完成通道），Agent 收到后
            // 调用 dsh_approve 工具应答；无人应答仍可在 dsh Web UI 人工处理。
            // v0.5.12：审批固定形态——挂起 → deferred 通知 Agent（附 tool/call 参数原文，
            // 见 notifyApprovalWake）→ Agent 用 dsh_approve 应答；无人应答超时自动拒绝
            // （approvalTimeoutMs，默认 30s 应答方失联检测，0=禁用）。不再有白名单自动放行
            // 或 manual/auto 模式切换：全部审批都交 Agent 处理。
            const g = getSingleton();
            const op = g.ops.get(opId);
            if (op) {
              op.approvalPending = true;
              const approval = {
                approvalId: frame.approvalId,
                rpcId: frame.rpcId,
                sessionId,
                toolName: frame.toolName,
                callId: frame.callId,
                reason: frame.reason,
                at: new Date().toISOString(),
                status: "pending",
              };
              // v0.5.12→v0.5.13: 审批通知附带 tool/call 参数原文（命令/路径，按 callId 从
              // toolCallCache 反查）——Agent 决策看「具体执行了什么」，而不是只听 model 自述
              // reason。v0.5.13: code preset 下子调用（subCallId 形如 `root:code:N`）的参数在
              // tool/code-dispatch-start 事件里，已按 subCallId 精确缓存；若仍 miss（子调用
              // 事件未到/直发帧形态），剥 `:code:N` 后缀回退到 run_code 根调用（args 为整段
              // 代码原文，兜底呈现）。
              let cachedCall = toolCallCache.get(`${opId}::${frame.callId}`);
              if (!cachedCall && typeof frame.callId === "string") {
                const stripped = frame.callId.replace(/:\w+:\d+$/, "");
                if (stripped !== frame.callId) {
                  const root = toolCallCache.get(`${opId}::${stripped}`);
                  if (root && root.name === "run_code") {
                    cachedCall = {
                      name: "run_code(code-dispatch)",
                      args: root.args,
                    };
                  }
                }
              }
              approval.args = cachedCall?.args ?? null;
              if (!Array.isArray(op.pendingApprovals)) op.pendingApprovals = [];
              if (
                !op.pendingApprovals.some(
                  (a) => a.approvalId === approval.approvalId,
                )
              ) {
                op.pendingApprovals.push(approval);
                // v0.5.12 统一流程：所有审批都通知 Agent 应答（不区分 manual/auto，无白名单）。
                // 通知附带命令/路径原文（approval.args）；挂起后暂停执行超时计时（外部决策等待
                // 不计入执行时间），并挂审批超时拒绝计时器（approvalTimeoutMs，0=禁用）。
                notifyApprovalWake({
                  bus: bus ?? getSingleton().bus,
                  sessionPath,
                  opId,
                  approval,
                  task: op.task,
                });
                pauseTimeout(); // 审批挂起：暂停执行超时计时（外部决策等待不计入执行时间）
                const timeoutMs = resolveApprovalTimeoutMs(cfg);
                if (timeoutMs > 0) {
                  const timerKey = `${opId}::${approval.approvalId}`;
                  const t = setTimeout(() => {
                    approvalTimers.delete(timerKey); // 计时器已触发：从表移除
                    const ap2 = op.pendingApprovals?.find(
                      (a) => a.approvalId === approval.approvalId,
                    );
                    if (ap2 && ap2.status === "pending") {
                      respondApprovalLocal(base, ap2, "rejected")
                        .then(() => {
                          if (ap2.status === "pending") {
                            ap2.status = "answered";
                            ap2.outcome = "rejected";
                            ap2.answeredAt = new Date().toISOString();
                            ap2.auto = "expired";
                            if (
                              !op.pendingApprovals.some(
                                (a) => a.status === "pending",
                              )
                            ) {
                              op.approvalPending = false;
                              resumeTimeout(); // 无挂起审批：恢复计时（同 approval/resolved 语义）
                            }
                          }
                        })
                        .catch(() => {
                          /* 拒绝失败忽略：审批保持 pending，等人工或 web UI */
                        });
                    }
                  }, timeoutMs);
                  approvalTimers.set(timerKey, t);
                }
              }
            }
          } else if (frame.type === "approval/resolved") {
            // 审批解决（allowed-once / rejected / cancelled 一律视为已解决）：仅当
            // 无任何 status==="pending" 的审批时才恢复计时（pending 计数语义——多审批
            // 交错时 A 解决但 B 仍挂起则不恢复）。dsh_approve 工具应答已把项标为
            // "answered" 时不再覆写，但同样不参与 pending 计数。v0.5.8：item 变为非
            // pending（resolved/answered）即清掉该审批的超时拒绝计时器（防触发重复应答）。
            const g = getSingleton();
            const op = g.ops.get(opId);
            if (op?.pendingApprovals) {
              const item = op.pendingApprovals.find(
                (a) => a.approvalId === frame.approvalId,
              );
              if (item && item.status === "pending") {
                item.status = "resolved";
                item.outcome = frame.outcome ?? "resolved";
                item.resolvedAt = new Date().toISOString();
              }
              const timerKey = `${opId}::${frame.approvalId}`;
              const t = approvalTimers.get(timerKey);
              if (t) {
                clearTimeout(t);
                approvalTimers.delete(timerKey);
              }
              if (!op.pendingApprovals.some((a) => a.status === "pending")) {
                op.approvalPending = false;
                resumeTimeout(); // 无挂起审批：恢复计时，剩余时间续算
              }
            }
          } else if (frame.type === "tool/call") {
            // v0.5.9: 直发 tool/call 帧（frame.data = { name, arguments, callId }，
            // 宿主 backscanArgs 同款字段结构）：同样缓存参数原文（frame.data 缺失时回退帧字段）。
            cacheToolCall(opId, frame.data ?? frame);
          } else if (frame.type === "stream/error") {
            outcome = {
              stopReason: "error",
              failure: { message: frame.error?.message || "事件流错误" },
            };
            return;
          }
        }
        // 取消兜底：dsh_cancel 已标记 cancelledRequested 时，若 cancel 导致 mux 断流且
        // 未收到 turn/end，把无终态收尾判为 aborted 而非 end_turn（防误报完成）
        const opNow = getSingleton().ops.get(opId);
        if (opNow?.cancelledRequested && !outcome)
          outcome = { stopReason: "aborted" };
        // 流正常结束但无终态：视为完成（end_turn 可能已发但流先关）
        if (!outcome) outcome = { stopReason: "end_turn" };
      } catch (err) {
        if (err?.name === "AbortError")
          throw Object.assign(new Error("dsh_run 已取消"), {
            code: "DSH_ABORTED",
          });
        throw err;
      }
    })();

    // 超时计时：支持审批挂起时暂停/恢复。审批等待是外部决策，不计入执行超时——
    // 挂起时扣减已流逝时间并清 timer，全部解决后按 remaining 重新 setTimeout，剩余窗口续算。
    let timer = null; // 当前计时器句柄（暂停态为 null）
    let remaining = timeoutMs; // 剩余超时毫秒（初始 = 完整超时窗口）
    let startedAt = null; // 当前计时段起点（Date.now()）
    let rejectTimeout = null;
    const timeoutPromise = new Promise((_, reject) => {
      rejectTimeout = reject;
    });
    const pauseTimeout = () => {
      if (!timer) return; // 未启动或已暂停：幂等
      remaining -= Date.now() - startedAt;
      clearTimeout(timer);
      timer = null;
    };
    const resumeTimeout = () => {
      if (timer) return; // 运行中：幂等
      if (remaining <= 0) {
        // 剩余已耗尽（暂停前已贴近超时）：立即判超时
        rejectTimeout(
          Object.assign(
            new Error(`dsh_run 超时（${Math.round(timeoutMs / 1000)}s）`),
            { code: "DSH_TIMEOUT" },
          ),
        );
        return;
      }
      startedAt = Date.now();
      timer = setTimeout(() => {
        rejectTimeout(
          Object.assign(
            new Error(`dsh_run 超时（${Math.round(timeoutMs / 1000)}s）`),
            { code: "DSH_TIMEOUT" },
          ),
        );
      }, remaining);
    };
    let rejectAbort = null;
    const abortPromise = new Promise((_, reject) => {
      if (signal?.aborted) {
        reject(
          Object.assign(new Error("dsh_run 已取消"), { code: "DSH_ABORTED" }),
        );
        return;
      }
      if (signal)
        rejectAbort = () =>
          reject(
            Object.assign(new Error("dsh_run 已取消"), { code: "DSH_ABORTED" }),
          );
    });

    try {
      // 3. 提交 prompt（queue 模式：立即 accepted，agent 异步执行）
      // promptMeta.rpcId = 会话 jsonl 的 user/message 事件 data.source.rpcId（同一 RPC id），
      // 经 ready 返回给卡片 URL：插件重启后按 sessionId+rpcId 从 jsonl 精确恢复（无需 opId 映射）
      const promptMeta = {};
      await callUnary(
        base,
        "session.prompt",
        {
          sessionId,
          mode: "queue",
          content: [{ type: "text", text: taskText }],
        },
        ac.signal,
        promptMeta,
      );
      resolveReady({ sessionId, rpcId: promptMeta.rpcId || "" });

      // 4. 竞速：事件循环终态 / 超时 / 取消
      // 初始启动：无审批时与旧行为完全一致（一次 setTimeout(timeoutMs)）
      resumeTimeout();
      await Promise.race([consume, timeoutPromise, abortPromise]);
      clearTimeout(timer);
      if (signal && rejectAbort) signal.removeEventListener("abort", onAbort);

      if (!outcome || outcome.stopReason === "error") {
        const failure = outcome?.failure;
        const msg = failure?.message || "dsh 任务执行失败";
        throw Object.assign(new Error(msg), { code: "DSH_ERROR" });
      }
      if (outcome.stopReason === "aborted") {
        throw Object.assign(new Error("dsh_run 已取消"), {
          code: "DSH_ABORTED",
        });
      }

      const fullOutput = collected;
      // 回调/返回值保持 chunk 流文本；结构化 blocks（reasoning 可折叠）由卡片端从 jsonl/实时事件重建
      const summary = buildSummary(fullOutput, finalMessageText);
      return {
        opId,
        sessionId,
        output: fullOutput,
        summary,
        stopReason: outcome.stopReason,
        usage: usageTotal ?? null,
        stderr: web.stderr ? web.stderr.slice(-2000) : null,
      };
    } catch (err) {
      // 超时/取消：通知 web host 取消该会话的任务（best effort，agent 在 web 里仍可见）
      if (err?.code === "DSH_TIMEOUT" || err?.code === "DSH_ABORTED") {
        try {
          await callUnary(base, "session.cancel", { sessionId });
        } catch {
          /* 忽略 */
        }
      }
      throw err;
    } finally {
      ac.abort();
      if (timer) clearTimeout(timer);
      if (signal && rejectAbort) signal.removeEventListener("abort", onAbort);
      // v0.5.8: 任务终态清理本 op 的审批超时拒绝计时器（防泄漏）。任务已结束（正常
      // 终态/取消/超时），挂起的审批由 web host 侧会话收尾自然失效，无需再自动拒绝。
      for (const [key, t] of approvalTimers) {
        if (key.startsWith(`${opId}::`)) {
          clearTimeout(t);
          approvalTimers.delete(key);
        }
      }
      // v0.5.9: 同样清理本 op 的 tool/call 参数缓存（运行期缓存只活到任务终态，防泄漏）
      for (const key of toolCallCache.keys()) {
        if (key.startsWith(`${opId}::`)) toolCallCache.delete(key);
      }
      // v0.10.46: 删除运行期协调状态条目（op Map 退役：任务状态零存储，条目仅活到终态）
      try {
        getSingleton().ops.delete(opId);
      } catch {
        /* 忽略 */
      }
    }
  })();

  promise.catch((err) => {
    resolveReady?.(null); // 提交失败：卡片降级 opId-only（错误态由 deferred fail 呈现）
  });

  return { opId, promise, ready };
}

// ---- 工具契约 ----
export const name = "dsh_run";

export const description =
  "把任务交给 DeepSeek Harness（dsh）的常驻 web host 执行（完整编码 agent：沙箱 shell 与文件系统、上下文压缩、subagent 级联）。" +
  "适合需要独立 agent 上下文深度执行的代码任务（实现/重构/调试/测试）或与当前对话隔离的长任务。" +
  "默认异步：提交即渲染实时卡片、完成后宿主唤醒结果后台送达；wait=true 同步直接返回。任务会话在 dsh Web UI（webPort，默认 3080）可见可继续。" +
  "完整调用手册（agentPreset/reasoningEffort/provider/model/sessionId resume/审批/回调模式）见 SKILL: skills/dsh-run/SKILL.md";

export const parameters = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description:
        "要 dsh 执行的任务描述（会作为用户消息发给编码 agent，应包含完整上下文与明确交付物）",
    },
    cwd: {
      type: "string",
      description:
        "dsh agent 的沙箱工作目录（bash 与文件系统工具的活动范围，绝对路径）。缺省用插件配置 defaultCwd。resume（传 sessionId）时以会话已有 cwd 为准，该值被忽略。",
    },
    timeout: {
      type: "number",
      description:
        "超时秒数，缺省用插件配置 defaultTimeoutMs。长任务建议显式调大。",
    },
    wait: {
      type: "boolean",
      description:
        "false（默认）= 异步：立即返回，进度见卡片，完成后宿主唤醒、结果后台送达；true = 同步：等任务跑完直接返回最终结果（注意：长任务会阻塞当前回合）",
    },
    agentPreset: {
      type: "string",
      enum: ["standard", "code", "cordis", "minimal"],
      description:
        "agent 预设模式：standard=完整编码 agent（默认）/ code=工具呈现批量调用（适合大型编码任务）/ cordis=可读写运行时的 agent / minimal=固定提示词精简 agent。缺省不传，用 dsh 默认（dsh Web UI 可调）。",
    },
    reasoningEffort: {
      type: "string",
      enum: ["off", "high", "max"],
      description:
        "推理强度（DeepSeek adapter）：off=关闭思考 / high=高 / max=最高。工具显式传时才指定（v0.9.5 起无全局配置）；不传时由 dsh 默认处理（通常 high）。",
    },
    provider: {
      type: "string",
      description:
        "显式指定任务 provider（如 deepseek/sensenova/agnes）。与 model 一起传时 selectModel 覆盖 dsh 默认模型；只传一个时另一侧从 settings.yaml 默认模型补齐。都不传时不 selectModel，任务用 dsh 默认。",
    },
    model: {
      type: "string",
      description:
        "显式指定任务模型 id（如 deepseek-v4-flash）。与 provider 一起传时 selectModel 覆盖 dsh 默认模型；都不传时不 selectModel，任务用 dsh 默认。",
    },
    sessionId: {
      type: "string",
      description:
        "复用已有 dsh 会话（resume）：传上次任务的 sessionId（dsh_run 回调/卡片里带，或 dsh web UI 会话列表）则在该会话上继续，agent 保留上文（省上下文重建）。resume 时以会话已有 cwd 为准（自动查询沿用，无需传 cwd）；目标会话应已空闲（上次任务已结束）。",
    },
  },
  required: ["task"],
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "external_llm_api",
    summary:
      "把任务交给 DeepSeek Harness（dsh web host）执行：经 Hana 宿主 provider（sensenova/agnes/deepseek）消耗模型额度，dsh agent 可能在指定 cwd 内读写文件、运行沙箱命令",
    ruleId: "dsh-hanako-external-llm",
  }),
};

async function doExecute(input, ctx) {
  // 只合并非空配置值：dev/未设置时 ctx.config 可能带 undefined 键，spread 会覆盖 manifest 默认值
  const cfg = { ...manifestDefaults };
  for (const [k, v] of Object.entries(ctx.config || {})) {
    if (v !== undefined && v !== null && v !== "") cfg[k] = v;
  }
  // 插件数据目录（宿主注入）：DSH_HOME 数据根落在这里（账本随插件生命周期）
  const dataDir = ctx.dataDir || join(PLUGIN_ROOT, "data");
  cfg.dataDir = dataDir;
  // v0.10.2: 首次工具调用即自动生成 config.json（不存在时按 manifest 默认值；幂等，失败静默）
  ensureConfigJson(cfg);
  // 单例记数据目录（dsh_ops 经 g.dataDir 定位 dsh 会话缓存等数据文件）
  getSingleton().dataDir = dataDir;
  // v0.6.0: dsh 依赖位置——数据目录 dsh-pkg/（Agent npm i @deepseek-ai/dsh 部署）优先，插件根兑底
  if (!cfg.dshPkgDir) cfg.dshPkgDir = resolveDshPkgDir(cfg);

  // resume 时 cwd 可空：会话的 cwd 已在创建时定死，复用会话沿用其已有 cwd（提交层 resume 自动查询会话已有 cwd 并显式传入）
  const cwd = String(input.cwd || resolveDefaultCwd(cfg) || "").trim();
  if (!cwd && !input.sessionId)
    throw new Error("cwd 不能为空（工具参数或插件配置 defaultCwd 至少给一个）");
  const timeoutMs =
    Number(input.timeout) > 0
      ? Number(input.timeout) * 1000
      : Number(cfg.defaultTimeoutMs || 600000);

  const taskCfg = {
    dshPkgDir: cfg.dshPkgDir,
    dataDir: cfg.dataDir,
    reasoningEffort: cfg.reasoningEffort,
    webPort: cfg.webPort,
    // v0.5.12: 审批配置收敛为唯一键 approvalTimeoutMs（超时兜底，0=禁用；manifest 默认 30000）
    approvalTimeoutMs: cfg.approvalTimeoutMs,
  };
  const taskParams = {
    task: input.task,
    cwd,
    timeoutMs,
    signal: ctx.signal,
    bus: ctx.bus ?? getSingleton().bus,
    sessionPath: ctx.sessionPath,
    agentPreset: input.agentPreset,
    reasoningEffort: input.reasoningEffort,
    sessionId: input.sessionId,
    provider: input.provider,
    model: input.model,
  };

  const wait = input.wait === true;
  const { opId, promise, ready } = submitTask(taskCfg, taskParams);
  // 卡片 URL 推迟到 session.create + prompt 提交后生成：携带 sessionId+rpcId，
  // 插件重启后旧卡片按这两个键从会话 jsonl 精确恢复（op Map 清空不丢数据）
  const loc = await ready;
  const locQuery =
    (loc && loc.sessionId
      ? `&sessionId=${encodeURIComponent(loc.sessionId)}`
      : "") +
    (loc && loc.rpcId ? `&rpcId=${encodeURIComponent(loc.rpcId)}` : "") +
    (taskCfg.timeoutMs != null
      ? `&timeoutMs=${encodeURIComponent(taskCfg.timeoutMs)}`
      : "");
  const cardBase = {
    route: `/card/op?opId=${encodeURIComponent(opId)}${locQuery}`,
    title: `dsh ${wait ? "任务" : "运行中"}`,
    description: String(input.task ?? "").slice(0, 80),
    aspectRatio: "16:1",
  };

  // 异步模式：注册 deferred（完成后宿主唤醒，结果后台送达）
  if (!wait) {
    const bus = ctx.bus ?? getSingleton().bus;
    const sessionPath = ctx.sessionPath;
    await registerDeferredWake({
      bus,
      sessionPath,
      taskId: opId,
      label: String(input.task ?? "").slice(0, 120),
    });

    promise.then(
      (res) => {
        // PTC 式回调压缩：默认只带最终结论摘要（callbackMode=summary），
        // 完整输出在 op 快照（卡片）与 dsh web UI（sessionId）可查，不进 Agent 上下文。
        const outputMode = cfg.callbackMode === "full" ? "full" : "summary";
        const payloadOutput =
          outputMode === "full"
            ? res.output
            : (res.summary?.text ?? res.output);
        resolveDeferredWake({
          bus,
          taskId: opId,
          result: {
            opId,
            tool: "dsh_run",
            status: "ok",
            cwd,
            sessionId: res.sessionId,
            output: payloadOutput,
            outputMeta: {
              mode: outputMode,
              fullLength: (res.output || "").length,
              summaryLength: (res.summary?.text || payloadOutput).length,
              summaryOf: res.summary?.summaryOf ?? null,
            },
            stopReason: res.stopReason,
            usage: res.usage,
            stderr: res.stderr,
          },
        });
      },
      (err) => {
        failDeferredWake({
          bus,
          taskId: opId,
          error: { message: String(err?.message || err).slice(0, 300) },
        });
      },
    );

    return {
      content: [
        {
          type: "text",
          text: `任务已提交给 dsh（opId: ${opId}），在后台执行中。进度与输出见上方卡片；完成后后台消息带回结果摘要（callbackMode=${cfg.callbackMode === "full" ? "full" : "summary"}，完整输出在卡片与 dsh web UI 可查）。`,
        },
      ],
      details: {
        dsh: { opId, status: "running", cwd, wait: false },
        card: cardBase,
      },
    };
  }

  // 同步模式：等结果直接返回
  const res = await promise;
  const note =
    res.stopReason === "end_turn" ? "" : `\n\n[stopReason: ${res.stopReason}]`;
  const text = `${res.output || "（dsh 未返回文本）"}${note}`;
  return {
    content: [{ type: "text", text }],
    details: {
      dsh: {
        stopReason: res.stopReason,
        usage: res.usage,
        cwd,
        opId: res.opId,
        sessionId: res.sessionId,
        wait: true,
      },
      card: {
        ...cardBase,
        title: `dsh ${res.stopReason === "end_turn" ? "完成" : "结束"}`,
      },
      ...(res.stderr ? { dshStderr: res.stderr.slice(-2000) } : {}),
    },
  };
}

export async function execute(input, ctx) {
  try {
    return await doExecute(input, ctx);
  } catch (e) {
    ctx.log?.error?.(
      "[dsh-hanako] execute failed:",
      e?.stack || e?.message || String(e),
    );
    throw e;
  }
}
