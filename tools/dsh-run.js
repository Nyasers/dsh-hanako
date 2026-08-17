// tools/dsh-run.js — dsh_run 工具（单文件自包含，v0.4.0 web host 后端）
// 把任务交给 DeepSeek Harness（dsh）的 web host（--profile web）执行：
// 插件 spawn dsh web（DSH_HOME 指向插件数据目录，账本随插件生命周期），
// 经其 /api 网关提交任务（session.create → events.mux 订阅 → session.prompt），
// 实时事件流驱动卡片 Markdown 输出。web UI 天然可见插件全部任务。
//
// 为什么是单文件：Hana 以带 ?t= 时间戳的 URL 加载 tools/*.js（热更新缓存破坏），
// 但 tools 内部静态 import 的相对模块是无 query 的固定 URL，Node ESM 按 URL 缓存、
// 永不刷新。因此 web host 管理、HTTP RPC 客户端、SSE 事件循环全部内联在本文件
// （Node 24 内置 fetch/AbortController，零第三方依赖）。
// 进程单例挂 globalThis.__dshHanako，供 index.js 卸载清理。
//
// 权限：external_side_effect（调用 dsh 编码 agent 执行任务，消耗 Hana 宿主 provider 额度，Auto 模式送审）。
import { spawn } from "node:child_process";
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
  renameSync,
  appendFileSync,
} from "node:fs";
import { join, dirname, delimiter } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";

const ELECTRON_NODE = process.execPath;
const ELECTRON_NODE_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: 1 };

const __here = dirname(fileURLToPath(import.meta.url));
// v0.6.0: PLUGIN_ROOT 向上查找含 manifest.json 的目录——源码形态（tools/ 下）与
// rspack bundle 形态（dist/tools/ 下）都能正确定位插件根。
let PLUGIN_ROOT = __here;
while (!existsSync(join(PLUGIN_ROOT, "manifest.json"))) {
  const parent = dirname(PLUGIN_ROOT);
  if (parent === PLUGIN_ROOT)
    throw new Error("无法定位插件根：向上未找到 manifest.json");
  PLUGIN_ROOT = parent;
}
const STDERR_CAP = 8192;
const PORT_READY_TIMEOUT_MS = 60000; // web host 端口就绪等待上限
// ---- 统一日志（v0.10.8 定稿：时间戳会话文件，index.js onload 初始化）----
// 当前会话日志 = <dataDir>/logs/<YYYYMMDD-HHmmss-SSS>.log 时间戳会话文件——DSHana 插件
// 全量运行日志（index.js 生命周期 + web host 进程 stdout/stderr + dsh-hana-provider
// 诊断 + dsh-run 工具关键路径）；旧日志由 index.js onload zstd 压缩为 .log.zst 全部保留。
// 本模块只把 stdout/stderr 写入 logPath（单例 g.logPath 优先），并保留兜底初始化
// （index.js 未初始化时自建时间戳会话文件）。
// 行格式 [<HH:mm:ss.SSS>] [<src>] <内容>，src ∈ out/err/provider/hana；写失败静默。
function logTs() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
// 追加一行日志：整体加前缀 + 尾部换行（多行 chunk 不拆行，简单起见同前缀）
function appendLog(logPath, src, chunk) {
  try {
    if (!logPath) return;
    mkdirSync(dirname(logPath), { recursive: true });
    const text = String(chunk ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\n+$/, "");
    appendFileSync(logPath, `[${logTs()}] [${src}] ${text}\n`, "utf8");
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

// ---- manifest configuration 默认值（单一事实源：manifest.json）----
// dev invoke 等场景 ctx.config 可能未注入默认值或带 undefined 键，这里静态读取保证配置可用。
const manifestDefaults = (() => {
  try {
    const m = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, "manifest.json"), "utf8"),
    );
    const props = m?.contributes?.configuration?.properties || {};
    const out = {};
    for (const [k, v] of Object.entries(props))
      if (v && "default" in v) out[k] = v.default;
    return out;
  } catch {
    return {};
  }
})();

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

// nodePath 解析（「配置单一事实源」哲学，补齐直读兜底）：优先直读
// dataDir/config.json 的 global.nodePath（设置界面改动即时生效；Agent 直改文件同样生效），
// 无则回退配置快照/空。未配置时报「node 可执行文件不存在」引导填写。
// function resolveNodePath(cfg) {
//   try {
//     const cf = join(cfg.dataDir, "config.json");
//     if (existsSync(cf)) {
//       const j = JSON.parse(readFileSync(cf, "utf8"));
//       const p = j?.global?.nodePath;
//       if (typeof p === "string" && p.trim()) return p.trim();
//     }
//   } catch { /* 读配置失败忽略 */ }
//   return String(cfg.nodePath || "");
// }

// defaultCwd 解析（同 resolveNodePath 的「配置单一事实源」哲学，补齐直读兜底）：优先直读
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

// ---- 常驻 web host 单例（globalThis 跨模块共享，index.js 卸载清理时读取）----
function getSingleton() {
  if (!globalThis.__dshHanako || typeof globalThis.__dshHanako !== "object") {
    globalThis.__dshHanako = { web: null };
  }
  const g = globalThis.__dshHanako;
  // 旧对象可能缺新字段（热更新后旧 globalThis 对象仍在）：逐字段兜底
  // v0.10.46：g.ops 不再是任务状态注册表（jsonl 唯一事实源），仅存审批/取消运行期协调状态
  if (!g.ops) g.ops = new Map();
  g.closeProcess = closeProcess;
  // v0.8.3: 插件页连接失败自检——经单例挂载诊断收集函数（routes 不静态 import 本模块：
  // Hana 带 ?t= 加载 tools，静态 import 会命中 Node ESM 固定 URL 缓存读到旧模块）
  g.collectDiagnostics = collectWebDiagnostics;
  // v0.8.6: deps 缺失项「安装依赖」按钮的后端部署逻辑（同挂单例纪律）
  g.installDeps = installDepsFromPlugin;
  // v0.8.7: 依赖运行级完整性验证（node cliBin --version 冒烟，结果缓存 g.depsSmoke）
  g.verifyDeps = verifyDepsSmoke;
  // v0.8.10: Node/npm 运行级可用性检测（node --version + npm-cli.js，结果缓存 g.nodeSmoke）
  // g.verifyNode = verifyNodeSmoke;
  // v0.9.1: Node 候选探测（t1 未配置时的环境变量感知候选，纯 fs existsSync）
  // g.detectNodeCandidates = detectNodeCandidates;
  return g;
}

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
// v0.6.0: dsh 依赖位置两形态——① 数据目录 dsh-pkg/（Agent npm ci 部署的轻量分发形态，
// 优先）；② 插件安装目录 node_modules（现役 zip 自带形态，兑底）。DSH_HOME 恒在数据目录。
function resolveDshPkgDir(cfg) {
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

  // const nodePath = resolveNodePath(cfg);
  const pkgDir = cfg.dshPkgDir;
  const cliBin = join(
    pkgDir,
    "node_modules",
    "@deepseek-ai",
    "dsh",
    "lib",
    "bin.js",
  );
  // if (!nodePath || !existsSync(nodePath)) {
  //   throw new Error(`node 可执行文件不存在：${nodePath}，请在插件设置中配置 nodePath`);
  // }
  if (!existsSync(cliBin)) {
    throw new Error(
      `dsh 包未就绪：${cliBin} 不存在。请在插件数据目录 dsh-pkg 执行 npm i -P @deepseek-ai/dsh`,
    );
  }
  const hostProvider = detectHostProviderPaths();

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
  // + 段4 default-model insert（v0.9.5 起恒挂载）。
  // cordis 插件加载：theme/provider/default-model/logger 四段均以包名注册（dsh client 模块发现
  // 按 loader entry 的 name 做 require.resolve('<name>/package.json')，file:// 无法解析），
  // 故启动前须在 $DSH_HOME/profiles/node_modules 统一建 junction（包名 → 插件安装目录
  // dsh-plugin/<pkg>），与 dsh 自维护的 junction farm 同机制（ensureCordisJunctions
  // 每次启动无条件重建）。
  // 启动前渲染模板（占位符→实际路径）到数据目录 dsh-hanako.patch.generated.yml；launcher
  // flag（--profile/--patch）必须位于应用参数（--port）之前。模板缺失/渲染失败时不挂
  // 任何 patch 记 warn（会话全文搜索保持上游默认禁用），不阻断 dsh 启动。
  // v0.9.5 正规化升级：dsh-hana-default-model 先行改包名注册；本版 theme/provider 一并
  // 正规化——dsh client 模块发现按 require.resolve('<name>/package.json') 找 package.json
  // 的 dsh.client 声明，file:// 形式无法解析。包名解析锚点是 $DSH_HOME/profiles（baseUrl
  // 父目录的 node_modules），启动前统一建 junction：$DSH_HOME/profiles/node_modules/
  // <dsh-hana-theme|dsh-hana-provider|dsh-hana-default-model|dsh-hana-logger> → 插件安装目录
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
      "dsh-hana-default-model",
      "dsh-hana-logger",
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
  // 渲染 provider 的 config 依赖解析基座占位符（MODELS_PATH / CATALOG_PATH /
  // DSH_PKG_DIR / LOG_PATH）——theme/provider/default-model 三段均以包名注册，不再有
  // file:// URL 占位符；包名经 ensureCordisJunctions 的 junction 解析。LOG_PATH 为本次
  // 会话日志文件路径，四个内嵌插件（theme/provider/default-model/logger）经统一日志
  // 服务（dsh-hana-logger，inject ['hanaLogger']）写入同一文件（src 前缀不变）。
  const renderPatchTpl = () => {
    const gen = join(cfg.dataDir, "dsh-hanako.patch.generated.yml");
    let content = readFileSync(patchTpl, "utf8")
      .split("{{MODELS_PATH}}")
      .join(hostProvider.modelsPath)
      .split("{{CATALOG_PATH}}")
      .join(hostProvider.catalogPath)
      .split("{{DSH_PKG_DIR}}")
      .join(cfg.dshPkgDir || resolveDshPkgDir(cfg))
      .split("{{LOG_PATH}}")
      .join(logPath);
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

// push dsh web host 刷新（回环调用 127.0.0.1:{port}，5s 超时；成功/失败都 console.log 简记，
// 失败不阻断——web host 未起/端口未就绪时静默忽略，dsh 侧启动时已 refresh 一次）
async function pushProviderRefresh(port) {
  const g = getSingleton();
  const network = g.network;
  const doFetch =
    network && typeof network.fetch === "function"
      ? network.fetch.bind(network)
      : fetch;
  const url = `http://127.0.0.1:${port}/api/hana-provider.refresh`;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    console.log(
      `[dsh-run] provider push ${res.ok ? "成功" : `失败（HTTP ${res.status}）`}：${url}`,
    );
  } catch (e) {
    // web host 未起 / 端口未就绪：静默忽略（dsh 侧启动时已 refresh 一次，功能不受影响）
    console.log(`[dsh-run] provider push 未送达（${e?.message || e}）：${url}`);
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

// ---- 依赖自主部署（v0.8.6: deps 缺失项「安装依赖」按钮的后端逻辑）----
// 参照技能文档 dsh-hanako/SKILL.md 依赖自主部署章节：部署目标恒为数据目录 dsh-pkg
// （升级安装会清插件目录 node_modules，数据目录随插件生命周期保留；不部署到插件根），
// 把插件根的 package.json + package-lock.json 复制进去后用配置的 node 执行 npm ci。
// 关键：npm ci 前把 node 目录加进 PATH——koffi/node-pty 的 install script 经 cmd 起
// 子进程 node，PATH 缺 node 报 'node' is not recognized（技能文档有实测踩坑记录）。
// --omit=dev 剔除 rspack 构建树（peer 自动装默认开启，保留 dsh 树，实测 528 包可运行）。
// registry 默认官方源，失败自动重试 npmmirror。部署是长任务（约 35s）：本函数异步
// 执行不 await（调用方立即返回，页面靠轮询诊断刷新）；状态记单例 g.depsInstalling /
// g.depsInstallError / g.depsInstallAt / g.depsInstallLog（≤800）。
async function installDepsFromPlugin(ctxConfig, ctxDataDir) {
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
  // v0.8.8: log 写入也刷新最近更新时间（前端 installing 态显示「更新于 HH:MM:SS」）
  const log = (s) => {
    g.depsInstallLog = (g.depsInstallLog + String(s)).slice(-800);
    g.depsInstallAt = new Date().toISOString();
  };
  try {
    // 1. 部署目录 = 数据目录 dsh-pkg（mkdir recursive，不存在则建）
    const pkgDir = join(dataDir, "dsh-pkg");
    mkdirSync(pkgDir, { recursive: true });
    // 2. 复制插件根 package.json
    const srcPkg = join(PLUGIN_ROOT, "package.json");
    if (!existsSync(srcPkg))
      throw new Error("插件根缺少 package.json：" + srcPkg);
    copyFileSync(srcPkg, join(pkgDir, "package.json"));
    log("Copied package.json to " + pkgDir);
    // 3. 创建 node 代理，定位 npm-cli.js
    if (IS_WIN) {
      const script = join(pkgDir, "node.cmd");
      const content = `@"${ELECTRON_NODE}" %*\n`;
      writeFileSync(script, content);
    } else {
      const script = join(pkgDir, "node");
      const content = `#!/bin/sh\nexec "${ELECTRON_NODE}" "$@"\n`;
      writeFileSync(script, content, { mode: 0o755 });
    }
    log("Created proxy node at" + pkgDir);
    const npmCli = join(
      PLUGIN_ROOT,
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    if (!existsSync(npmCli)) {
      throw new Error("npm-cli.js 不存在：" + npmCli);
    }
    // 4. npm ci：--omit=dev 剔除构建树；先把 node 目录加进 PATH（install script 子进程需 node）
    const run = async (registryArgs) => {
      // const child = spawn(ELECTRON_NODE, [npmCli, "ci", "--omit=dev", "--no-audit", "--no-fund", "--verbose", ...registryArgs], {
      const child = spawn(
        ELECTRON_NODE,
        [
          npmCli,
          "i",
          "@deepseek-ai/dsh",
          "--omit=dev",
          "--loglevel=http",
          ...registryArgs,
        ],
        {
          cwd: pkgDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...ELECTRON_NODE_ENV,
            PATH: pkgDir + delimiter + (process.env.PATH || ""),
          },
          windowsHide: true,
        },
      );
      let out = ""; // 仅用于错误信息提取（失败时拼进错误文本）
      // v0.8.8: npm ci 输出流式累积到 depsInstallLog（≤800 截断）+ 每次 data 刷新
      // depsInstallAt——前端 3s 轮询 health 会随诊断刷新 installLog 尾部，呈现实时进度
      const cap = (d) => {
        out += String(d);
        g.depsInstallLog += String(d);
        g.depsInstallAt = new Date().toISOString();
      };
      child.stdout.on("data", cap);
      child.stderr.on("data", cap);
      const code = await new Promise((res) => child.once("close", res));
      g.appendLog("npm", out);
      if (code !== 0)
        throw new Error(
          "npm i 失败 @deepseek-ai/dsh（exit " +
            code +
            "）：" +
            (out.slice(-300) || "无输出"),
        );
      return out;
    };
    try {
      await run([]); // 官方源
    } catch (e) {
      log("[官方源失败] " + e.message + "，重试 npmmirror…");
      await run(["--registry=https://registry.npmmirror.com"]);
    }
    // 5. 校验 dsh 包就位（resolveDshPkgDir 优先 dsh-pkg，这里 cliBin 即部署产物）
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
        "npm ci 完成但未找到 dsh 包：" +
          cliBin +
          " 不存在（部署目录 " +
          pkgDir +
          "）",
      );
    }
    g.depsInstallError = null;
    log("[完成] " + cliBin);
    // v0.8.7: 部署成功后强制运行级重验（清旧缓存，await 刷新——安装流程本身就是等待场景）
    g.depsSmoke = null;
    await verifyDepsSmoke(cfg);
    return { ok: true, state: "installed", cliBin };
  } catch (e) {
    g.depsInstallError = String(e?.message || e).slice(0, 1500);
    log("[失败] " + g.depsInstallError);
    return { ok: false, state: "error", error: g.depsInstallError };
  } finally {
    g.depsInstalling = false;
  }
}
// 挂单例（getSingleton() 内也有同款赋值，这里显式建立一次）
getSingleton().installDeps = installDepsFromPlugin;

// ---- 依赖运行级完整性验证（v0.8.7: deps 存在性之外的加载冒烟）----
// dsh 是 cordis 生态，模块图挂大量 peer 依赖（dsh-agent/dsh-llm-deepseek/dsh-tool-* 等）：
// npm ci 中断 / install script 失败未回滚 / --omit=peer 误用都会造成「入口文件在、依赖缺」
// 的假就绪，运行时才抛 ERR_MODULE_NOT_FOUND。文件存在 ≠ 依赖完整。
// 可靠检测 = 运行级验证「node <cliBin> --version」：node 沿 import 图加载整个 cordis 模块树，
// 任何依赖缺失都会抛错且退出码非 0（技能文档「部署后验证 node lib/bin.js --version 应输出
// 0.1.0-rc.6」同款逻辑）。能跑 = 依赖图完整。
// 防并发/防轮询风暴：结果缓存到单例 g.depsSmoke = { ok, version, error, stderr, at, running }；
// running=true 时直接返回当前缓存不重复 spawn（spawn 一次 --version 数百 ms，3s 轮询 ×
// 每次 spawn 不可接受，必须缓存 + running 标志）。v0.8.8 起触发时机：进标签页自动一次 +
// 手动「检测依赖」按钮（经 GET /webui/verify-deps 驱动）/ installDeps 部署成功后强制重验。
async function verifyDepsSmoke(cfg) {
  const g = getSingleton();
  // 防并发：验证进行中直接返回当前缓存（不重复 spawn）
  if (g.depsSmoke?.running) return g.depsSmoke;
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
  // const nodePath = resolveNodePath(diagCfg);
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
    // if (!nodePath || !existsSync(nodePath)) throw new Error("node 可执行文件不存在：" + nodePath);
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
    const version = (stdout.match(/^\s*(\d+\.\d+\.\d+)/) || [])[1] || null;
    if (code === 0 && version) {
      smoke.ok = true;
      smoke.version = version;
      smoke.error = "";
      smoke.stderr = err.slice(-400);
    } else {
      // 真实错误（ERR_MODULE_NOT_FOUND 等）截断 ≤400 存入 error
      smoke.ok = false;
      smoke.error = String(err || out || "退出码 " + code).slice(0, 400);
      smoke.stderr = String(err || out).slice(-400);
    }
  } catch (e) {
    smoke.ok = false;
    smoke.error = String(e?.message || e).slice(0, 400);
  } finally {
    smoke.at = new Date().toISOString();
    smoke.running = false;
  }
  return smoke;
}
// 挂单例（getSingleton() 内也有同款赋值，这里显式建立一次）
getSingleton().verifyDeps = verifyDepsSmoke;

// ---- Node/npm 运行级可用性检测（v0.8.10: t1 配置存在性之外的可用性冒烟）----
// 路径存在 ≠ 能跑（与 t2 依赖验证同理）：node.exe 可能是损坏/不匹配的二进制，node
// 同目录可能不带 npm 分发（installDepsFromPlugin 的 npm ci 依赖 npm-cli.js）。检测 =
// spawn「node --version」确认可执行 + 检查 node 同目录 node_modules/npm/bin/npm-cli.js。
// 同 verifyDepsSmoke 纪律：结果缓存 g.nodeSmoke = { ok, version, error, at, running }，
// running 防并发；不随轮询触发——由页面「进标签页自动一次 / 手动「检测 Node」按钮」
// 经 GET /webui/verify-node 驱动。
// async function verifyNodeSmoke(cfg) {
//   const g = getSingleton();
//   // 防并发：验证进行中直接返回当前缓存（不重复 spawn）
//   if (g.nodeSmoke?.running) return g.nodeSmoke;
//   const dataDir = cfg.dataDir || g.dataDir || (g.web?.dshHome ? dirname(g.web.dshHome) : "");
//   const diagCfg = { ...cfg, dataDir };
//   // const nodePath = resolveNodePath(diagCfg);
//   const smoke = { ok: false, version: null, error: "", at: "", running: true };
//   g.nodeSmoke = smoke;
//   try {
//     // if (!nodePath || !existsSync(nodePath)) {
//     //   throw new Error("node 可执行文件不存在：" + nodePath + "，请在插件设置中配置 nodePath");
//     // }
//     // const nodeDir = dirname(nodePath);
//     // // npm 可用性：node 同目录 node_modules/npm/bin/npm-cli.js（installDepsFromPlugin 同款定位）
//     // const npmCli = join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
//     // spawn node --version，10s 超时兜底（child.kill）；capture stdout+stderr
//     const child = spawn(ELECTRON_NODE, ["--version"], {
//       cwd: nodeDir,
//       stdio: ["ignore", "pipe", "pipe"],
//       env: ELECTRON_NODE_ENV,
//       windowsHide: true,
//     });
//     let out = "";
//     let err = "";
//     child.stdout.on("data", (d) => { out = (out + String(d)).slice(-800); });
//     child.stderr.on("data", (d) => { err = (err + String(d)).slice(-800); });
//     const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 10000);
//     const code = await new Promise((res) => child.once("close", res));
//     clearTimeout(timer);
//     const stdout = out.trim();
//     const version = (stdout.match(/^\s*v?(\d+\.\d+\.\d+)/) || [])[1] || null;
//     if (code !== 0 || !version) {
//       throw new Error(String(err || out || "退出码 " + code).slice(0, 400) || "node --version 无有效输出");
//     }
//     // if (!existsSync(npmCli)) {
//     //   throw new Error("node 目录未带 npm 分发（npm-cli.js 不存在：" + npmCli + "）——安装依赖与启动 web host 需要 npm，请更换完整 node 安装（官方安装包或 fnm 等）");
//     // }
//     smoke.ok = true;
//     smoke.version = version;
//     smoke.error = "";
//   } catch (e) {
//     smoke.ok = false;
//     smoke.error = String(e?.message || e).slice(0, 400);
//   } finally {
//     smoke.at = new Date().toISOString();
//     smoke.running = false;
//   }
//   return smoke;
// }
// 挂单例（getSingleton() 内也有同款赋值，这里显式建立一次）
// getSingleton().verifyNode = verifyNodeSmoke;

// ---- Node 候选探测（v0.9.1: t1 未配置时的环境变量感知候选）----
// 纯 fs 探测（existsSync），同步、无子进程无网络，可放进诊断轮询。探测链按「通用性」排序，
// **PATH 最通用**（任何 node 管理器/官方安装都会把 node 目录或 shim 放进 PATH：nvm-windows
// 的 symlink、fnm 的 shim、scoop 的 shim 都能被 PATH 找到；existsSync 过滤后，「采用」时
// verifyNodeSmoke 会真实 spawn --version 校验，shim 也能转发到真实 node，校验兜底成立）；
// ProgramFiles 官方安装次之（官方安装包默认路径，跨工具通用）；工具特定变量层仅作补充
// （**不假设用户使用特定版本管理器**，只认环境变量信号——环境变量没有的不探测默认安装路径，
// 保持轻量不猜、不过度设计）。工具层内按常见程度排列：nvm-windows → fnm → volta。
// 不做 spawn 校验（版本/可用性推迟到「采用」动作时 await verifyNodeSmoke 校验），
// 避免诊断轮询时批量 spawn 子进程。返回 [{ path, source }]，全空返回 []。
// function detectNodeCandidates(cfg) {
//   const out = [];
//   const push = (p, source) => {
//     if (!p) return;
//     p = String(p);
//     if (!existsSync(p)) return;
//     if (out.some((c) => c.path === p)) return; // 去重（工具特定变量常已含于 PATH，先到先得）
//     out.push({ path: p, source });
//   };
//   // 1. PATH 解析（最通用：任何 node 管理器/官方安装都会把 node 目录或 shim 放进 PATH）
//   const seen = new Set();
//   for (const dir of String(process.env.PATH || "").split(delimiter)) {
//     if (!dir || seen.has(dir)) continue;
//     seen.add(dir);
//     push(join(dir, "node.exe"), "PATH");
//   }
//   // 2. ProgramFiles 官方安装（官方安装包默认路径，npm 随官方安装包分发，跨工具通用）
//   push(join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"), "Program Files");
//   // 3. 工具特定补充层（v0.9.2：nvm-windows → fnm → volta，只认环境变量信号）
//   // 3a. nvm-windows：NVM_HOME（安装目录内 node.exe）+ NVM_SYMLINK（当前版本 symlink）
//   const nvmHome = process.env.NVM_HOME || "";
//   if (nvmHome) push(join(nvmHome, "node.exe"), "nvm-windows");
//   const nvmSym = process.env.NVM_SYMLINK || "";
//   if (nvmSym) push(join(nvmSym, "node.exe"), "nvm-windows");
//   // 3b. fnm：FNM_MULTISHELL_PATH（当前激活版本 shim 目录）。
//   //     FNM_DIR 下的多版本目录遍历（node-versions/<v>/installation/node.exe 取最新）刻意不实现——
//   //     按「轻量、不猜」原则：多版本遍历需读目录，且 PATH 通常已含 fnm shim（3a 前 PATH 层已覆盖）。
//   const fnmShell = process.env.FNM_MULTISHELL_PATH || "";
//   if (fnmShell) push(join(fnmShell, "node.exe"), "fnm 当前版本");
//   // 3c. volta：VOLTA_HOME/bin/node.exe
//   const voltaHome = process.env.VOLTA_HOME || "";
//   if (voltaHome) push(join(voltaHome, "bin", "node.exe"), "volta");
//   // 未实现（注释说明，非 Windows/小众）：nvm-sh 的 NVM_DIR 是 Unix 路径（Windows 场景忽略）；
//   // asdf 等小众管理器无稳定 Windows 环境变量约定，暂不探测。
//   return out;
// }
// 挂单例（getSingleton() 内也有同款赋值，这里显式建立一次）
// getSingleton().detectNodeCandidates = detectNodeCandidates;

// ---- 连接失败自检（v0.8.3: 插件页 web host 未就绪时的诊断数据源）----
// 供 routes/webui.js 使用（经单例 globalThis.__dshHanako.collectDiagnostics 挂载，
// 不静态 import 本模块——Hana 带 ?t= 加载 tools，静态 import 会命中 Node ESM 固定
// URL 缓存读到旧模块，见文件头注释；与 index.js 经单例取 closeProcess 同一套纪律）。
// web host 未就绪时逐项检查：① nodejs 配置（resolveNodePath + existsSync）
// ② dsh 依赖（resolveDshPkgDir + cliBin 存在性）③ DSH 进程状态（单例 web /
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
    // out.checks.push(buildNodeDiagCheck(g, diagCfg));
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

/** ① Node.js 配置：nodePath 配置 + 路径存在 + 运行级可用性（node --version + npm-cli.js）
 * v0.8.10: 叠加 nodeSmoke（verifyNodeSmoke 缓存 { ok, version, error, at, running }）。
 * ok：configured && exists 且（未验证/验证中暂通过；验证过必须通过）——路径存在 ≠ 能跑。 */
// function buildNodeDiagCheck(g, cfg) {
//   const nodePath = resolveNodePath(cfg);
//   const configured = Boolean(nodePath);
//   const exists = configured && existsSync(nodePath);
//   // 运行级可用性状态（verifyNodeSmoke 缓存；非敏感：布尔/版本号/截断错误文本）
//   const smoke = g.nodeSmoke || null;
//   const verifyRunning = Boolean(smoke?.running);
//   const verified = configured && exists && smoke ? Boolean(smoke.ok) : null; // null = 未配置/未验证（暂通过）
//   const verifyError = smoke && !smoke.ok && !smoke.running ? String(smoke.error || "").slice(0, 400) : null;
//   const verifyVersion = smoke?.version ?? null;
//   const verifyAt = smoke?.at ?? null;
//   const ok = configured && exists && (!smoke || smoke.ok || smoke.running);
//   const check = {
//     key: "node",
//     name: "Node.js 配置",
//     ok,
//     configured,
//     exists: configured ? exists : null,
//     path: nodePath,
//     verified,
//     verifyRunning,
//     verifyError,
//     verifyVersion,
//     verifyAt,
//     candidates: null, // v0.9.1: 未配置时的环境变量感知候选 [{ path, source }]（空则不渲染）
//     detail: "",
//     fix: "",
//   };
//   if (!configured) {
//     check.detail = "nodePath 未配置（插件设置「Node.js 可执行文件路径」为空）";
//     check.fix = "双路径修复：在插件设置中配置 Node.js 可执行文件路径（node.exe 绝对路径）；或让 Agent 协助（探测本机 node → 引导确认 → 写 config.json 的 global.nodePath → 立即生效，无需重启）；或点下方候选列表「采用」";
//     // v0.9.1: 环境变量感知候选探测（纯 fs existsSync 同步；探测失败/全空则保持纯提示）
//     try {
//       const cands = detectNodeCandidates(cfg);
//       if (cands.length) check.candidates = cands;
//     } catch { /* 探测失败静默 */ }
//   } else if (!exists) {
//     check.detail = "配置的路径不存在：" + nodePath;
//     check.fix = "双路径修复：在插件设置中修正 Node.js 可执行文件路径（当前路径无效）；或让 Agent 协助（探测本机 node → 引导确认 → 写 config.json → 立即生效，无需重启）";
//   } else if (!smoke) {
//     // 未验证过（进标签页自动检测一次 / 手动「检测 Node」；ok 暂 true）
//     check.detail = "已配置且路径存在，点击「检测 Node」验证可用性";
//   } else if (verifyRunning) {
//     // 检测进行中：ok 暂 true，结果由检测接口返回后刷新
//     check.detail = "已配置，正在检测 Node/npm 可用性…";
//   } else if (!smoke.ok) {
//     // 配置存在但不可用：node 跑不起来或未带 npm
//     check.detail = "nodePath 配置存在但不可用：" + (verifyError ? "\n" + verifyError : "运行级检测失败");
//     check.fix = "修正 Node.js 可执行文件路径（配置的 node 无法运行或未带 npm），修正后立即生效无需重启；或让 Agent 协助（探测本机 node → 引导确认 → 写 config.json → 立即生效）";
//   } else {
//     check.detail = "已配置且可用（node v" + smoke.version + "，npm 可用）：" + nodePath;
//   }
//   return check;
// }

/** ② dsh 依赖：cliBin 存在性（resolveDshPkgDir 同款：数据目录 dsh-pkg 优先，插件根兑底）
 * v0.8.6: 叠加部署状态——g.depsInstalling（npm ci 进行中）/ g.depsInstallError（上次失败）/ g.depsInstallLog
 * v0.8.7: 叠加运行级完整性验证——g.depsSmoke（verifyDepsSmoke 缓存 { ok, version, error, stderr, at, running }）。
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
  const installAt = g.depsInstallAt || null; // v0.8.8: 最近一次 npm ci 输出时间（实时进度）
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
    detail: "",
    fix: "",
  };
  if (installing) {
    // v0.8.8: 安装中（含重装场景 installed 仍可能为 true）优先——实时进度
    // installLog 尾部由前端 .diag-progress 展示（随轮询刷新）
    check.detail = "正在安装依赖…（npm ci，约 30-40s，进度见下方）";
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
      "依赖缺失：点击本卡片「安装依赖」按钮自动在插件数据目录 dsh-pkg 执行 npm ci（约 30-40s，完成后自动验证）；或确认插件目录 node_modules 解压完整";
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
      "点击本卡片「重新安装依赖」按钮重新执行 npm ci（自动部署到 dsh-pkg，完成后自动验证）";
  } else {
    // 存在 + 验证通过：能跑 = 依赖图完整
    check.detail =
      "dsh 包已就绪（运行级验证通过，版本 v" + smoke.version + "）：" + cliBin;
  }
  return check;
}

/** ③ DSH 进程：单例 web 状态（child/exitCode/ready/stderr 尾部）+ webLastError/webLastErrorAt + webLastExit
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
      "稍候自动重试；若持续未就绪，可点击本卡片「手动启动 web host」按钮重新拉起，或检查上方 Node.js 配置与依赖项";
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

/** 进程失败修复指引：按失败原因内容匹配（node / 依赖 / 端口占用），兜底通用建议。
 * 同时匹配 webLastError 与 stderr 尾部——端口占用等错误常只出现在 stderr（进程退出时
 * webLastError 可能未携带 stderr 尾部，见「进程已退出」分支）。 */
function pickProcessFix(lastError, stderr, port) {
  const text = (lastError || "") + "\n" + (stderr || "");
  // if (/node 可执行文件不存在|nodePath/i.test(text)) {
  //   return "按上方「Node.js 配置」项修复（在插件设置中配置 node.exe 路径），改后重启 Hana";
  // }
  if (/dsh 包未就绪|cliBin|npm ci/i.test(text)) {
    return "按上方「dsh 依赖安装」项修复（数据目录 dsh-pkg 执行 npm ci，完成后自动验证）";
  }
  if (/EADDRINUSE|address already in use|占用|bind/i.test(text)) {
    return "检查端口 " + port + " 是否被占用（释放后重启 Hana）";
  }
  return "检查上方 Node.js 配置与依赖项；仍失败请重启 Hana 后重试";
}

export async function closeProcess() {
  const g = getSingleton();
  // 先清理 provider 热跟随 watch（退订 bus + 关 watchers），再回收 web host 进程
  if (typeof g.providerPushCleanup === "function") {
    try {
      g.providerPushCleanup();
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
  "把任务交给 DeepSeek Harness（dsh，DeepSeek 官方开源 agent harness）的常驻 web host 执行。" +
  "dsh 是一个完整编码 agent：DeepSeek 官方 API、沙箱 bash 与文件系统工具、上下文压缩、subagent 级联。" +
  "适合：需要独立 agent 上下文深度执行的代码任务（实现/重构/调试/测试）、需要沙箱 shell 的实验、" +
  "或需要与当前对话隔离的长任务。任务文本会作为用户消息发给 dsh 编码 agent；cwd 是其沙箱工作目录。" +
  "默认异步：立即返回任务已提交（对话中渲染运行卡片，实时显示进度与输出），任务完成后宿主自动唤醒、" +
  "结果随后台消息送达。传 wait=true 可同步等待最终结果直接返回。失败时抛出错误说明原因。" +
  "任务会话在 dsh Web UI（webPort 端口，默认 3080）中可见且持久化，可随时浏览器查看/继续。" +
  "回调压缩（PTC 式）：异步完成回调默认只带最终结论摘要（callbackMode=summary，省上下文），完整输出在卡片与 dsh web UI 可查；设 callbackMode=full 可回传全量。" +
  "审批：dsh agent 请求越界权限时任务挂起，插件经 deferred 通道发来 dsh-approval 通知（带 opId/approvalId/理由/命令参数原文），用 dsh_approve 工具应答（allowed-once/rejected）；无人应答超时自动拒绝（approvalTimeoutMs，0=禁用）；也可在 dsh Web UI 人工处理。" +
  "agentPreset：任务可指定 agent 预设模式（standard/code/cordis/minimal），缺省不指定，用 dsh 默认（dsh Web UI 可调）。" +
  "reasoningEffort：任务可显式指定推理强度（off/high/max）；不传时不指定，由 dsh 默认处理（通常 high）。" +
  "provider/model：任务可显式指定模型（如 provider=deepseek model=deepseek-v4-flash），" +
  "传了则 selectModel 覆盖 dsh 默认（dsh 会把所选模型写回全局默认 settings.yaml，显式指定即成为新默认）；" +
  "都不传则任务直接用 dsh 默认模型（settings.yaml agent-default-model），不 selectModel。" +
  "resume：传 sessionId 复用已有会话继续任务（agent 保留上文），省上下文重建。resume 时以会话已有 cwd 为准（自动查询沿用，无需传 cwd）。";

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
  // v0.6.0: dsh 依赖位置——数据目录 dsh-pkg/（Agent npm ci 部署）优先，插件根兑底
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
    // nodePath: resolveNodePath(cfg),
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
