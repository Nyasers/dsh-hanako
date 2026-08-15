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
// 权限：external_side_effect（调用 DeepSeek 官方 API，消耗额度，Auto 模式送审）。
import { spawn } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __here = dirname(fileURLToPath(import.meta.url));
// v0.6.0: PLUGIN_ROOT 向上查找含 manifest.json 的目录——源码形态（tools/ 下）与
// rspack bundle 形态（dist/tools/ 下）都能正确定位插件根。
let PLUGIN_ROOT = __here;
while (!existsSync(join(PLUGIN_ROOT, "manifest.json"))) {
  const parent = dirname(PLUGIN_ROOT);
  if (parent === PLUGIN_ROOT) throw new Error("无法定位插件根：向上未找到 manifest.json");
  PLUGIN_ROOT = parent;
}
const STDERR_CAP = 8192;
const DEFAULT_CREDENTIALS = () => join(homedir(), ".dsh", ".credentials.yaml");
const PORT_READY_TIMEOUT_MS = 60000; // web host 端口就绪等待上限

// ---- manifest configuration 默认值（单一事实源：manifest.json）----
// dev invoke 等场景 ctx.config 可能未注入默认值或带 undefined 键，这里静态读取保证配置可用。
const manifestDefaults = (() => {
  try {
    const m = JSON.parse(readFileSync(join(PLUGIN_ROOT, "manifest.json"), "utf8"));
    const props = m?.contributes?.configuration?.properties || {};
    const out = {};
    for (const [k, v] of Object.entries(props)) if (v && "default" in v) out[k] = v.default;
    return out;
  } catch {
    return {};
  }
})();

// ---- 凭据读取（仅 DEEPSEEK_API_KEY，支持裸值/单双引号值，不解析完整 YAML）----
// 优先级：插件 DSH_HOME（账本落插件目录原则）→ ~/.dsh 全局。
function readApiKey(dataDir) {
  const candidates = [
    dataDir && join(dataDir, "dsh-home", ".credentials.yaml"),
    DEFAULT_CREDENTIALS(),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8");
      const m = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m);
      if (!m) continue;
      const v = m[1] ?? m[2] ?? m[3] ?? null;
      if (v) return v;
    } catch { /* 该候选不可读，尝试下一个 */ }
  }
  return null;
}

// 最终 key 解析：宿主注入的 cfg.apiKey 优先；其次直接读宿主写的 config.json
// （global.apiKey）——宿主对工具调用的 ctx.config 是插件加载时的配置快照，
// 之后在设置界面改的 key 不会注入，需直接读文件绕过。
function resolveApiKey(cfg) {
  if (cfg.apiKey) return cfg.apiKey;
  try {
    const cf = join(cfg.dataDir, "config.json");
    if (existsSync(cf)) {
      const j = JSON.parse(readFileSync(cf, "utf8"));
      const k = j?.global?.apiKey;
      if (typeof k === "string" && k) return k;
    }
  } catch { /* 读配置失败忽略 */ }
  return readApiKey(cfg.dataDir);
}

// 模型解析（绕宿主配置快照，同 resolveApiKey）：设置界面改的 model 写入
// dataDir/config.json 的 global.model，工具调用的 ctx.config 是加载时快照不会更新，
// 因此优先直读 config.json；没有（未改过）才回退到快照/默认值。
function resolveModel(cfg) {
  try {
    const cf = join(cfg.dataDir, "config.json");
    if (existsSync(cf)) {
      const j = JSON.parse(readFileSync(cf, "utf8"));
      const m = j?.global?.model;
      if (typeof m === "string" && m.trim()) return m.trim();
    }
  } catch { /* 读配置失败忽略 */ }
  return String(cfg.model || "deepseek-v4-flash");
}

// agent 预设解析（同 resolveModel 的「配置单一事实源」哲学）：优先直读
// dataDir/config.json 的 global.agentPreset（设置界面改动即时生效），无则回退
// 配置快照/默认值 standard。工具调用显式传 agentPreset 时在 submitTask 内优先。
function resolveAgentPreset(cfg) {
  try {
    const cf = join(cfg.dataDir, "config.json");
    if (existsSync(cf)) {
      const j = JSON.parse(readFileSync(cf, "utf8"));
      const p = j?.global?.agentPreset;
      if (typeof p === "string" && p.trim()) return p.trim();
    }
  } catch { /* 读配置失败忽略 */ }
  return String(cfg.agentPreset || "standard");
}

// reasoningEffort 解析（同 resolveAgentPreset 的「配置单一事实源」哲学）：优先直读
// dataDir/config.json 的 global.reasoningEffort（设置界面改动即时生效），无则回退
// 配置快照/工具调用入参。与 agentPreset 不同，缺省不补默认值，保持与现状一致
// （不传时由 web host 默认处理，通常为 high）。
function resolveReasoningEffort(cfg) {
  try {
    const cf = join(cfg.dataDir, "config.json");
    if (existsSync(cf)) {
      const j = JSON.parse(readFileSync(cf, "utf8"));
      const r = j?.global?.reasoningEffort;
      if (typeof r === "string" && r.trim()) return r.trim();
    }
  } catch { /* 读配置失败忽略 */ }
  return cfg.reasoningEffort;
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
  } catch { /* 读配置失败忽略 */ }
  const v = Number(cfg.approvalTimeoutMs);
  if (Number.isFinite(v) && v > 0) return v;
  return 0; // 快照缺失/非数字/0/负数：禁用超时拒绝（0，调用方判断）
}

// nodePath 解析（同 resolveModel 的「配置单一事实源」哲学，补齐直读兜底）：优先直读
// dataDir/config.json 的 global.nodePath（设置界面改动即时生效；Agent 直改文件同样生效），
// 无则回退配置快照/空。未配置时报「node 可执行文件不存在」引导填写。
function resolveNodePath(cfg) {
  try {
    const cf = join(cfg.dataDir, "config.json");
    if (existsSync(cf)) {
      const j = JSON.parse(readFileSync(cf, "utf8"));
      const p = j?.global?.nodePath;
      if (typeof p === "string" && p.trim()) return p.trim();
    }
  } catch { /* 读配置失败忽略 */ }
  return String(cfg.nodePath || "");
}

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
  } catch { /* 读配置失败忽略 */ }
  return String(cfg.defaultCwd || "");
}

// ---- 常驻 web host 单例（globalThis 跨模块共享，index.js 卸载清理时读取）----
function getSingleton() {
  if (!globalThis.__dshHanako || typeof globalThis.__dshHanako !== "object") {
    globalThis.__dshHanako = { web: null };
  }
  const g = globalThis.__dshHanako;
  // 旧对象可能缺新字段（热更新后旧 globalThis 对象仍在）：逐字段兜底
  if (!g.ops) g.ops = new Map();
  g.closeProcess = closeProcess;
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
  } catch { return false; }
}

async function resolveDeferredWake({ bus, taskId, result }) {
  if (!bus?.request || !taskId) return false;
  try { await bus.request("deferred:resolve", { taskId, result }); return true; } catch { return false; }
}

async function failDeferredWake({ bus, taskId, error }) {
  if (!bus?.request || !taskId) return false;
  try { await bus.request("deferred:fail", { taskId, error }); return true; } catch { return false; }
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
  } catch { /* 通知失败忽略（审批仍可在 web UI 处理）*/ }
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
      value: { sessionId: approval.sessionId, approvalId: approval.approvalId, outcome },
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
    throw new Error(`审批应答未接受（${j.reason || "unknown"}）：可能已超时或被其他方处理`);
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

// ---- 操作注册表（卡片反馈）：opId → 状态快照 ----
// 工具发起时注册 running，结束时更新终态；routes/card.js 从同一个 globalThis
// 单例读取（跨加载实例共享），宿主卡片 iframe 轮询 /ops/status 渲染。
const OP_KEEP = 50; // 内存保留最近 N 条（终态结果文本已进对话 content，卡片只是增强展示）

function nextOpId() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 5);
  return `op_${ts}_${rand}`;
}

function startOperation({ task, cwd, timeoutMs, agentPreset, reasoningEffort, resumeSessionId }) {
  const g = getSingleton();
  const opId = nextOpId();
  g.ops.set(opId, {
    opId,
    task: String(task ?? "").slice(0, 500),
    cwd: String(cwd ?? ""),
    agentPreset: String(agentPreset ?? ""),
    reasoningEffort: String(reasoningEffort ?? ""),
    resumeSessionId: resumeSessionId ?? null,
    timeoutMs: timeoutMs ?? null,
    status: "running",
    startedAt: new Date().toISOString(),
    durationMs: null,
    output: null,
    stopReason: null,
    error: null,
    sessionId: null,
    sessionCwd: null, // v0.7.2: 会话实际 cwd（resume 时与 op.cwd 可能不一致，sessionRecord 链接构造用）
    approvalPending: false,
    pendingApprovals: [],
  });
  if (g.ops.size > OP_KEEP) {
    const first = g.ops.keys().next().value;
    if (first) g.ops.delete(first);
  }
  return opId;
}

function endOperation(opId, patch) {
  const g = getSingleton();
  const op = g.ops.get(opId);
  if (!op) return;
  const started = new Date(op.startedAt).getTime();
  Object.assign(op, patch, { durationMs: Date.now() - started });
  dirtyOps.add(opId); // v0.7.1: JSONL 增量——标记待写行，persistOps 按 dirty 追加
  schedulePersist(); // 终态触发落盘（防抖 300ms，见 persistOps）
}

// ---- op 历史落盘与恢复（v0.7.1）：终态快照增量追加写 dataDir/ops.jsonl，重启后 loadOps 恢复可查 ----
// 落盘是增强，不阻塞主流程：写失败 try/catch 静默；进程退出前不保证 flush
// （终态以卡片/对话内容为准）。防抖 300ms：多次 endOperation 只写最后一次。
// v0.7.1 起 ops.json（整文件 JSON 数组，每次终态全量重写）→ ops.jsonl（JSON Lines）：
// 每行一条 op 快照，终态只 append 一行（O(1)，不再全量序列化历史）；恢复端逐行解析，
// 单行损坏只丢该条（旧格式整体 JSON.parse 失败则全部丢失），同一 op 多行按 opId 去重留最后一行。
let persistTimer = null;
let dirtyOps = new Set(); // 待落盘 opId（endOperation 标记，persistOps 消费后清空；失败不清下次重试）

// ---- dsh 会话落盘路径算法（v0.7.2 起，复刻 @deepseek-ai/dsh-session-persistence-jsonl@0.1.0-rc.6）----
// 用途：serializeOpRow 构造 sessionRecord 链接——指向 dsh 官方会话完整记录
// <dataDir>/dsh-home/sessions/<projectKey(cwd)>/<encodeSegment(sessionId)>/session.jsonl.zstd。
// 依赖被 package-lock.json 锁死 rc.6（漂移风险可控）；dsh 升级可能漂移——ops.jsonl 是增强型
// 账本，链接失效不影响主流程（完整记录仍可经 sessionId 在 dsh Web UI 定位）。
// 算法逐 code unit 复刻自 dsh-session-persistence-jsonl/lib/index.js（encodeSegment 84~96 行，
// projectKey 106~125 行）：
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

// ---- v0.7.3: sessionRecord 链接构造 = 存在性校验 + 扫描兜底 ----
// v0.7.2 盲区：旧行（v0.7.1 时代产生）无 sessionCwd，loadOps 回写迁移时 serializeOpRow 回退
// op.cwd 构造链接；resume 任务的 op.cwd 是用户传入/defaultCwd（如 E:\Hanako\workspace），
// 而会话实际 cwd（dsh 落盘 projectKey 依据）可能是别的目录——回退用错 cwd 指向不存在的文件。
// 本函数先按 <dataDir>/dsh-home/sessions/<projectKey(cwd)>/<encodedId>/ 探测（新任务 sessionCwd
// 恒正确 → 一次 existsSync 直接命中，零额外扫描成本）；未命中再按 encodedId 扫 sessions/*/
// 定位真实路径（会话量小，成本可忽略）；仍找不到返回 null——调用方省略链接（诚实缺失，
// 优于坏链接；完整记录仍可经 sessionId 在 dsh Web UI / sessions 目录定位）。
function resolveSessionRecord(dataDir, cwd, sessionId) {
  const encoded = encodeSegment(sessionId);
  const probeDir = join(dataDir, "dsh-home", "sessions", projectKey(cwd), encoded);
  for (const name of ["session.jsonl.zstd", "session.jsonl"]) {   // 兼容 zstd / compression:none 两种后缀
    const p = join(probeDir, name);
    if (existsSync(p)) return p;
  }
  // projectKey 漂移（旧行 resume 回退 op.cwd 等）：按 encodedId 扫 sessions/*/ 定位真实路径
  const sessionsRoot = join(dataDir, "dsh-home", "sessions");
  try {
    for (const proj of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      for (const name of ["session.jsonl.zstd", "session.jsonl"]) {
        const p = join(sessionsRoot, proj.name, encoded, name);
        if (existsSync(p)) return p;
      }
    }
  } catch { /* 扫描失败：返回 null，调用方省略链接 */ }
  return null;
}

function serializeOpRow(op, dataDir) {
  // v0.7.2: 终态行不再落盘完整 output——完整输出在内存 op 快照（卡片懒加载）与
  // dsh 会话完整记录（sessionRecord 链接指向 dsh-home/sessions/.../session.jsonl.zstd）里，
  // ops.jsonl 只留账本元数据 + 链接（单一事实源）。映射只发生在持久化时，不污染内存 Map
  // （内存快照仍保留完整 output 供卡片懒加载）。summary/usage/task/status/stopReason/error 照旧保留。
  const row = { ...op };
  delete row.output;
  if (dataDir && row.sessionId) {
    try {
      // v0.7.3: 经 resolveSessionRecord 构造——存在性校验 + 扫描兜底：
      // sessionCwd 优先（resume 时 op.cwd 可能与会话实际 cwd 不一致，不能用来构造链接）；
      // 缺失（恢复的旧行）回退 op.cwd（旧行 resume 的 op.cwd 可能不是会话实际 cwd，探测
      // 未命中时按 encodedId 扫描 sessions/*/ 定位真实路径）；找不到真实文件：省略链接
      // （诚实缺失，优于坏链接，同时清除历史坏链接）——不构造链接不阻塞主流程。
      const rec = resolveSessionRecord(dataDir, row.sessionCwd || row.cwd, row.sessionId);
      if (rec) row.sessionRecord = rec;
      else delete row.sessionRecord;
    } catch { delete row.sessionRecord; /* 路径算法异常（cwd 为空等）：省略链接——完整记录仍可经 sessionId 在 dsh Web UI 定位 */ }
  }
  return row;
}

function persistOps() {
  const g = getSingleton();
  if (!g.dataDir || dirtyOps.size === 0) return; // 单例未记数据目录或无待写：直接返回不抛
  try {
    mkdirSync(g.dataDir, { recursive: true });
    const file = join(g.dataDir, "ops.jsonl");
    for (const opId of dirtyOps) {
      const op = g.ops.get(opId);
      if (!op) continue; // 已被 OP_KEEP 裁掉：不补写（其历史行下次 load 去重裁剪）
      appendFileSync(file, JSON.stringify(serializeOpRow(op, g.dataDir)) + "\n", "utf8");
    }
    dirtyOps.clear();
  } catch { /* 落盘失败静默：历史落盘是增强，不阻塞主流程；dirty 未清，下次终态重试（重复行 load 去重兜底） */ }
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistOps, 300);
}

function loadOps() {
  const g = getSingleton();
  if (g._opsLoaded) return; // 幂等：startWebHostFromPlugin / doExecute 双调用点只恢复一次
  g._opsLoaded = true;
  if (!g.dataDir) return;
  const jsonlPath = join(g.dataDir, "ops.jsonl");
  const legacyPath = join(g.dataDir, "ops.json");
  const rows = [];
  if (existsSync(jsonlPath)) {
    // v0.7.1: JSONL 逐行解析——单行损坏跳过只丢该条；同一 op 多行（中间态 sessionId 行 + 终态行）
    // 按 opId 去重留最后一行（Map.set 覆盖保持首次插入位置，顺序仍按文件行序）。
    let text = "";
    try { text = readFileSync(jsonlPath, "utf8"); } catch { /* 读失败：按空启动 */ }
    const lastIdx = new Map(); // opId -> rows 中的下标
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row = null;
      try { row = JSON.parse(line); } catch { continue; } // 单行损坏：跳过该条，不影响其余
      if (!row || typeof row !== "object" || !row.opId) continue;
      const idx = lastIdx.get(row.opId);
      if (idx !== undefined) rows[idx] = row; // 后行覆盖前行
      else { lastIdx.set(row.opId, rows.length); rows.push(row); }
    }
  } else if (existsSync(legacyPath)) {
    // v0.7.1: 旧版 ops.json（JSON 数组）一次性迁移——读旧文件写 jsonl 后删除旧文件；
    // 迁移失败（旧文件损坏）静默忽略，按空 Map 启动。
    try {
      const legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
      if (Array.isArray(legacy)) {
        rows.push(...legacy.filter((r) => r && typeof r === "object" && r.opId));
        mkdirSync(g.dataDir, { recursive: true });
        writeFileSync(jsonlPath, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
        rmSync(legacyPath, { force: true });
      }
    } catch { /* 旧文件不存在/损坏：忽略，空 Map 启动 */ }
    if (rows.length === 0) return;
  } else {
    return; // 无任何历史文件：空 Map 启动
  }
  const interruptedAt = new Date().toISOString();
  for (const row of rows) {
    // 非终态 op（重启前仍 running，未及结束）标为 interrupted（重启即中断，符合事实）；终态原样恢复
    g.ops.set(row.opId, row.status === "running" ? { ...row, status: "interrupted", interruptedAt } : row);
  }
  // 恢复后同样遵守 OP_KEEP：超出删最老（Map 按插入序，最老在前）
  while (g.ops.size > OP_KEEP) {
    const first = g.ops.keys().next().value;
    if (!first) break;
    g.ops.delete(first);
  }
  // v0.7.1: 恢复态（interrupted 标记 + 去重 + 裁剪后）回写 jsonl，文件与内存对齐——
  // 压缩历史行、持久化 interrupted 标记（重启不再重复标记新时间戳）、防文件无界增长。
  try {
    const rowsNow = [...g.ops.values()].map((op) => JSON.stringify(serializeOpRow(op, g.dataDir)));
    writeFileSync(jsonlPath, rowsNow.join("\n") + (rowsNow.length ? "\n" : ""), "utf8");
  } catch { /* 回写失败静默：下次 load 再对齐 */ }
}

// ---- web host 生命周期：spawn dsh web（DSH_HOME 锁进插件数据目录）----
// v0.6.0: dsh 依赖位置两形态——① 数据目录 dsh-pkg/（Agent npm ci 部署的轻量分发形态，
// 优先）；② 插件安装目录 node_modules（现役 zip 自带形态，兑底）。DSH_HOME 恒在数据目录。
function resolveDshPkgDir(cfg) {
  if (cfg?.dataDir) {
    const candidate = join(cfg.dataDir, "dsh-pkg");
    if (existsSync(join(candidate, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"))) {
      return candidate;
    }
  }
  return PLUGIN_ROOT;
}

async function ensureWebHost(cfg) {
  const g = getSingleton();
  if (g.web?.ready) return g.web;
  if (g.web?.readyPromise) {
    try { return await g.web.readyPromise; } catch { /* 启动失败：清掉允许重试 */ g.web = null; }
  }
  if (g.web?.child) {
    // 旧实例启动失败过：清掉重建
    try { g.web.child.kill(); } catch { /* 已退出 */ }
    g.web = null;
  }
  if (!cfg.dshPkgDir) cfg.dshPkgDir = resolveDshPkgDir(cfg);

  const nodePath = resolveNodePath(cfg);
  const pkgDir = cfg.dshPkgDir;
  const cliBin = join(pkgDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (!nodePath || !existsSync(nodePath)) {
    throw new Error(`node 可执行文件不存在：${nodePath}，请在插件设置中配置 nodePath`);
  }
  if (!existsSync(cliBin)) {
    throw new Error(`dsh 包未就绪：${cliBin} 不存在。轻量分发形态请在插件数据目录 dsh-pkg 执行 npm ci（部署目录需含 package.json + package-lock.json，详见技能 dsh-hanako/SKILL.md 依赖自主部署章节）；现役 zip 形态请确认插件目录（${pkgDir}）node_modules 解压完整`);
  }
  const apiKey = resolveApiKey(cfg);
  if (!apiKey) {
    throw new Error("找不到 DEEPSEEK_API_KEY：请在插件设置中配置 apiKey（配置后需重启 Hana 生效），或把 key 写入插件数据目录 dsh-home/.credentials.yaml（也可用 ~/.dsh/.credentials.yaml）");
  }

  const dshHome = join(cfg.dataDir, "dsh-home");
  // spawn 的 cwd 必须是已存在目录（无效 cwd 会让 Node 报误导性的 ENOENT）
  mkdirSync(cfg.dataDir, { recursive: true });
  const port = Number(cfg.webPort) || 3080;
  // v0.5.11: 会话全文搜索 overlay（dsh 默认 openAt: never 禁用搜索，需 --patch 覆盖为 first-search）
  // v0.8.1: 主题注入 overlay——cordis 插件从安装目录 assets/dsh-cordis 加载（file:// URL），
  // patch 含机器绝对路径，启动前渲染模板（占位符→实际路径）到数据目录；
  // launcher flag（--profile/--patch）必须位于应用参数（--port）之前；patch 文件缺失时优雅降级不阻断启动
  const patchFiles = [];
  const sessionQueryPatch = join(PLUGIN_ROOT, "config", "session-query.patch.yml");
  if (existsSync(sessionQueryPatch)) patchFiles.push(sessionQueryPatch);
  const themePatchTpl = join(PLUGIN_ROOT, "config", "hana-theme.patch.yml.tpl");
  if (existsSync(themePatchTpl)) {
    const themePluginFile =
      "file:///" + encodeURI(join(PLUGIN_ROOT, "assets", "dsh-cordis", "dsh-hana-theme", "index.js").replace(/\\/g, "/"));
    const gen = join(cfg.dataDir, "hana-theme.patch.generated.yml");
    writeFileSync(gen, readFileSync(themePatchTpl, "utf8").split("{{THEME_PLUGIN_FILE}}").join(themePluginFile), "utf8");
    patchFiles.push(gen);
  }
  const patchArgs = patchFiles.flatMap((p) => ["--patch", p]);
  const child = spawn(nodePath, [cliBin, "--profile", "web", ...patchArgs, "--port", String(port)], {
    cwd: cfg.dataDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: "1", DEEPSEEK_API_KEY: apiKey },
    windowsHide: true,
  });

  const web = { child, port, dshHome, ready: false, stderr: "", readyPromise: null };
  child.stderr.on("data", (d) => {
    web.stderr = (web.stderr + String(d)).slice(-STDERR_CAP);
  });
  child.once("exit", (code, signal) => {
    web.ready = false;
    if (g.web === web) g.web = null;
    web.stderr += `\n[dsh web 退出 code=${code} signal=${signal}]`;
  });

  // 等端口就绪（stdout 出现 "dsh web: http://" 或端口可连）
  const readyPromise = (async () => {
    const deadline = Date.now() + PORT_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`dsh web 进程提前退出 (code=${child.exitCode})：${web.stderr.slice(-1200) || "无 stderr"}`);
      }
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/host.describe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "client-request", rpcId: "probe", method: "host.describe", payload: {} }),
          signal: AbortSignal.timeout(2000),
        });
        if (r.ok) { web.ready = true; return web; }
      } catch { /* 未就绪，继续等 */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`dsh web 启动超时（${Math.round(PORT_READY_TIMEOUT_MS / 1000)}s 内端口 ${port} 未就绪）：${web.stderr.slice(-1200) || "无 stderr"}`);
  })();
  web.readyPromise = readyPromise;
  g.web = web;
  return readyPromise;
}

// 单例挂载：index.js 不 import 本文件（避免模块缓存），onload 时通过单例拉起 web host。
// 构建 cfg（manifest 默认 + 用户配置 + dataDir/dshPkgDir fallback）后调 ensureWebHost。
// 失败不抛出（onload 不能被 dsh 启动失败阻塞），由工具调用时的 ensureWebHost 重试。
getSingleton().startWebHost = async function startWebHostFromPlugin(ctxConfig, ctxDataDir) {
  const cfg = { ...manifestDefaults };
  for (const [k, v] of Object.entries(ctxConfig || {})) {
    if (v !== undefined && v !== null && v !== "") cfg[k] = v;
  }
  cfg.dataDir = ctxDataDir || join(PLUGIN_ROOT, "data");
  // v0.5.7: 单例记数据目录（落盘/恢复共用）+ 恢复 op 历史（ops.json 落盘，重启可查）
  getSingleton().dataDir = cfg.dataDir;
  loadOps();
  if (!cfg.dshPkgDir) cfg.dshPkgDir = resolveDshPkgDir(cfg);
  cfg.apiKey = cfg.apiKey || "";
  try {
    await ensureWebHost(cfg);
    return true;
  } catch (e) {
    // 记录失败原因供诊断（onload 侧只能看到布尔）；后续工具调用重试
    const g = getSingleton();
    g.webLastError = String(e?.message || e).slice(0, 1500);
    if (g.web?.stderr) g.webLastError += `\n[dsh web stderr] ${g.web.stderr.slice(-800)}`;
    g.webLastErrorAt = new Date().toISOString();
    return false;
  }
};

export async function closeProcess() {
  const g = getSingleton();
  const web = g.web;
  g.web = null;
  if (web?.child) {
    try { web.child.kill(); } catch { /* 已退出 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ---- HTTP RPC 客户端（dsh web /api 网关，fetch 载波）----
// Unary：POST /api/<method>，body = { type:"client-request", rpcId, method, payload }
// 响应 ServerResponse：rpcId 回显 + result.ok/value 或 result.ok=false + error。
function nextRpcId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function callUnary(base, method, payload, signal) {
  const rpcId = nextRpcId();
  const res = await fetch(`${base}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
    signal,
  });
  if (!res.ok) throw new Error(`dsh /api/${method} HTTP ${res.status}`);
  const full = await res.json();
  if (!full || full.rpcId !== rpcId) throw new Error(`dsh /api/${method} rpcId 不匹配`);
  if (!full.result || !full.result.ok) {
    const e = full.result?.error || {};
    throw new Error(`dsh ${method} 失败：${e.code || "unknown"} ${e.message || ""}`);
  }
  return full.result.value;
}

// ---- 事件流（/api/events.mux，WebSocket 通道）----
// dsh 的事件流要求 WebSocket 升级（GET 返回 426 Upgrade Required，浏览器 UI 即走 WS）。
// Node 24 内置全局 WebSocket；帧为 JSON，payload 即 MuxFrame。
async function* openMux(base, signal) {
  if (typeof WebSocket !== "function") {
    throw new Error("宿主环境无全局 WebSocket，无法订阅 dsh 事件流（需要 Node 22+）");
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
    try { envelope = JSON.parse(ev.data); frame = envelope?.payload || envelope || {}; } catch { return; }
    // server-request 信封（approval/requested 等应答类帧）：外层 rpcId 补进 frame——
    // dsh web host 的 /api/respond 靠 client-response 信封的 rpcId 路由 pending 表，
    // 审批帧的 rpcId 只在外层，只取 payload 会丢（审批应答就断链）。
    if (envelope && typeof envelope === "object" && typeof envelope.rpcId === "string" && typeof frame.rpcId !== "string") {
      frame.rpcId = envelope.rpcId;
    }
    if (!frame || typeof frame.type !== "string") return;
    if (waiters.length) waiters.shift()(frame);
    else queue.push(frame);
  };
  ws.onerror = () => { wsError = new Error("dsh events.mux WebSocket 错误"); };
  ws.onclose = () => { wsClosed = true; while (waiters.length) waiters.shift()(null); };
  if (signal?.aborted) { try { ws.close(); } catch {} throw Object.assign(new Error("dsh_run 已取消"), { code: "DSH_ABORTED" }); }
  const onAbort = () => { try { ws.close(); } catch {} };
  signal?.addEventListener("abort", onAbort, { once: true });
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(wsError || new Error("dsh events.mux 连接失败"));
  });
  try {
    while (true) {
      if (queue.length) { yield queue.shift(); continue; }
      if (wsError) throw wsError;
      if (wsClosed) return;
      const frame = await new Promise((resolve) => waiters.push(resolve));
      if (frame === null) return;
      yield frame;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { ws.close(); } catch { /* 已关闭 */ }
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
    return { text: candidate, summaryOf: "final-message", fullLength: full.length };
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
    try { args = args === undefined || args === null ? "" : JSON.stringify(args); } catch { args = String(args ?? ""); }
  }
  toolCallCache.set(`${opId}::${callId}`, {
    name: typeof payload.name === "string" ? payload.name : "",
    args,
  });
}

// ---- 任务提交：同步注册 op + 后台执行（不 await）----
// 返回 { opId, promise }：opId 立即可用（构造卡片 route / deferred taskId），
// promise 在后台跑：session.create → events.mux 订阅 → session.prompt → 事件循环 → 终态。
function submitTask(cfg, { task, cwd, timeoutMs = 600000, signal, bus, sessionPath, agentPreset, reasoningEffort, sessionId }) {
  const taskText = String(task ?? "").trim();
  if (!taskText) throw new Error("task 不能为空");

  // agent 预设解析须在 startOperation 之前完成：op 快照要带 agentPreset（卡片对账可见）
  const preset = agentPreset ?? resolveAgentPreset(cfg);
  // reasoningEffort 同样在 startOperation 之前解析：op 快照要带该字段（卡片对账可见）
  const effort = reasoningEffort ?? resolveReasoningEffort(cfg);
  // resume 会话解析同样在 startOperation 之前完成：op 快照要带 resumeSessionId（卡片对账可见，值为 null 或 sessionId）
  const resumeSessionId = String(sessionId ?? "").trim() || null;

  const opId = startOperation({ task: taskText, cwd, timeoutMs, agentPreset: preset, reasoningEffort: effort, resumeSessionId });
  let settled = false;
  // lastUsage 提升到 submitTask 作用域：事件循环收集（assistant/message 的 d.usage），
  // ok 终态 finish 与 promise.catch 的错误终态 finish 都能读到（错误路径也要带 usage，取消/超时前已产生的消耗可对账）
  let lastUsage = null;
  const finish = (patch) => { if (!settled) { settled = true; endOperation(opId, patch); } };

  const promise = (async () => {
    const web = await ensureWebHost(cfg);
    const base = `http://127.0.0.1:${web.port}`;

    // 1. 建会话：无 sessionId = 新建（干净起点，完成后留在 web 历史中可继续）；
    // 有 sessionId = resume 该会话（context 继承，agent 记得上个任务的内容，省上下文重建）。
    // resume 必须显式传会话已有 cwd：web host 的 session.create 服务端 cwd 回退是
    // request.payload.cwd ?? defaults.cwd（defaults.cwd = web host 进程 cwd = 插件数据目录），
    // 不传会与目标会话既有 cwd 不符触发 session-conflict，create 不会自动采用会话已有 cwd。
    // 故 resume 分支先 session.list 查目标会话已有 cwd（忽略用户传入的 cwd——resume 语义即沿用会话）。
    // agentPreset 无值不传（保持兼容：缺省走 web host 默认 standard）
    let createPayload;
    if (resumeSessionId) {
      const list = await callUnary(base, "session.list", { projections: ["id", "cwd"] });
      const items = list.items || [];
      const existing = items.find((it) => it.sessionId === resumeSessionId);
      if (!existing) throw new Error(`目标会话不存在或已归档，无法 resume：${resumeSessionId}`);
      // 异常会话（cwd 为空/缺失）回退用户传的 cwd 或 defaultCwd，再不行才报错
      const resumeCwd = String(existing.cwd ?? "").trim() || cwd;
      if (!resumeCwd) throw new Error(`目标会话 ${resumeSessionId} 无 cwd 且无可用回退 cwd，无法 resume`);
      createPayload = { sessionId: resumeSessionId, cwd: resumeCwd, ...(preset && { agentPreset: preset }) };
    } else {
      createPayload = { cwd, ...(preset && { agentPreset: preset }) };
    }
    const session = await callUnary(base, "session.create", createPayload);
    const sessionId = session.sessionId;
    // v0.7.2: 记会话实际 cwd（createPayload.cwd = resume 时查到的会话已有 cwd / 新建时用户传入 cwd，
    // 即 dsh 会话落盘 projectKey 所用的 cwd；op.cwd 在 resume 时可能不一致，不能拿来构造 sessionRecord 链接）
    endOperation(opId, { sessionId, sessionCwd: createPayload.cwd });

    // 1.5 模型选择（dsh 会话级 call config：provider/model 经 session.selectModel 切换）
    // provider 固定 deepseek-official（dsh-llm-deepseek 注册路由），模型名 pass-through 直传；
    // 显式设置保证「配置的模型就是实际运行的模型」（单一事实源，不受 web host 默认值漂移影响）。
    // resume 场景同样执行：会话级 call config 重设无冲突，配置的模型仍是实际运行的模型（单一事实源哲学）。
    const model = resolveModel(cfg);
    await callUnary(base, "session.selectModel", {
      sessionId,
      provider: "deepseek-official",
      model,
        ...(effort && { reasoningEffort: effort }),
    });

    // 2. 开 mux 事件流 + prompt 竞速
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    let collected = "";
    let finalMessageText = ""; // 最后一条 assistant/message 的文本（回调摘要锚点）
    let sawChunk = false;
    const seen = new Set();
    let outcome = null; // { stopReason, failure? }
    const updateOpOutput = (text) => {
      const op = getSingleton().ops.get(opId);
      if (op && op.status === "running") op.output = text;
    };

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
              const t = textFromChunk(d);
              if (t) { collected += t; updateOpOutput(collected); }
            } else if (ev.type === "assistant/message") {
              const msg = d.message;
              if (msg?.id && typeof msg.id === "string" && !seen.has(msg.id)) {
                seen.add(msg.id);
                const t = textFromMessageBlocks(msg.content);
                if (!sawChunk && t) { // chunk 流已提供文本时跳过拼接，避免重复
                  collected += t; updateOpOutput(collected);
                }
                if (t) finalMessageText = t; // 每条覆盖，结束时即最终汇报（摘要锚点）
              }
              if (d.usage) lastUsage = d.usage;
            } else if (ev.type === "tool/call") {
              // v0.5.9: 缓存工具调用参数原文（session/event 包裹的 tool/call 事件，
              // d = { name, arguments, callId }），审批到达时按 callId 反查做内容级匹配。
              cacheToolCall(opId, d);
            } else if (ev.type === "tool/code-dispatch-start") {
              // v0.5.13: code preset 子调用分发事件（d = { rootCallId, parentCallId,
              // subCallId, name, arguments }）：run_code 内联的工具调用（如 write）以子调用
              // 形式派发，参数不产生独立 tool/call 帧；按 subCallId 缓存（形如 `root:code:N`），
              // 审批帧 callId 即该 subCallId，可精确反查到命令/路径原文。
              cacheToolCall(opId, { callId: d.subCallId, name: d.name, arguments: d.arguments });
            } else if (ev.type === "turn/end") {
              const reason = d.reason;
              const kind = reason?.kind;
              if (kind === "completed") outcome = { stopReason: "end_turn" };
              else if (kind === "max-tokens") outcome = { stopReason: "max_tokens" };
              else if (kind === "aborted") outcome = { stopReason: "aborted" };
              else if (reason?.failure) outcome = { stopReason: "error", failure: reason.failure };
              else outcome = { stopReason: kind || "end_turn" };
              return; // 一次 prompt = 一个 turn，turn/end 即终态
            }
          } else if (frame.type === "approval/requested") {
            // 审批挂起（approval/policy=ask）：任务会等待应答。除卡片标记外，
            // 把审批上下文（含 respond 路由所需的 rpcId）存进 op 快照，并触发
            // 宿主 deferred 通知（独立 taskId，不占用任务完成通道），Agent 收到后
            // 调用 dsh_approve 工具应答；无人应答仍可在 dsh Web UI 人工处理。
            // v0.5.12：审批固定形态——挂起 → deferred 通知 Agent（附 tool/call 参数原文，
            // 见 notifyApprovalWake）→ Agent 用 dsh_approve 应答；无人应答超时自动拒绝
            // （approvalTimeoutMs，默认 30s 应答方失联检测，0=禁用）。不再有白名单自动放行
            // 或 manual/auto 模式切换：全部审批都交 Agent 处理。
            const g = getSingleton();
            const op = g.ops.get(opId);
            if (op && op.status === "running") {
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
                    cachedCall = { name: "run_code(code-dispatch)", args: root.args };
                  }
                }
              }
              approval.args = cachedCall?.args ?? null;
              if (!Array.isArray(op.pendingApprovals)) op.pendingApprovals = [];
              if (!op.pendingApprovals.some((a) => a.approvalId === approval.approvalId)) {
                op.pendingApprovals.push(approval);
                // v0.5.12 统一流程：所有审批都通知 Agent 应答（不区分 manual/auto，无白名单）。
                // 通知附带命令/路径原文（approval.args）；挂起后暂停执行超时计时（外部决策等待
                // 不计入执行时间），并挂审批超时拒绝计时器（approvalTimeoutMs，0=禁用）。
                notifyApprovalWake({ bus: bus ?? getSingleton().bus, sessionPath, opId, approval, task: op.task });
                pauseTimeout(); // 审批挂起：暂停执行超时计时（外部决策等待不计入执行时间）
                const timeoutMs = resolveApprovalTimeoutMs(cfg);
                if (timeoutMs > 0) {
                  const timerKey = `${opId}::${approval.approvalId}`;
                  const t = setTimeout(() => {
                    approvalTimers.delete(timerKey); // 计时器已触发：从表移除
                    const ap2 = op.pendingApprovals?.find((a) => a.approvalId === approval.approvalId);
                    if (ap2 && ap2.status === "pending") {
                      respondApprovalLocal(base, ap2, "rejected").then(() => {
                        if (ap2.status === "pending") {
                          ap2.status = "answered";
                          ap2.outcome = "rejected";
                          ap2.answeredAt = new Date().toISOString();
                          ap2.auto = "expired";
                          if (!op.pendingApprovals.some((a) => a.status === "pending")) {
                            op.approvalPending = false;
                            resumeTimeout(); // 无挂起审批：恢复计时（同 approval/resolved 语义）
                          }
                        }
                      }).catch(() => { /* 拒绝失败忽略：审批保持 pending，等人工或 web UI */ });
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
              const item = op.pendingApprovals.find((a) => a.approvalId === frame.approvalId);
              if (item && item.status === "pending") {
                item.status = "resolved";
                item.outcome = frame.outcome ?? "resolved";
                item.resolvedAt = new Date().toISOString();
              }
              const timerKey = `${opId}::${frame.approvalId}`;
              const t = approvalTimers.get(timerKey);
              if (t) { clearTimeout(t); approvalTimers.delete(timerKey); }
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
            outcome = { stopReason: "error", failure: { message: frame.error?.message || "事件流错误" } };
            return;
          }
        }
        // 取消兜底：dsh_cancel 已标记 cancelledRequested 时，若 cancel 导致 mux 断流且
        // 未收到 turn/end，把无终态收尾判为 aborted 而非 end_turn（防误报完成）
        const opNow = getSingleton().ops.get(opId);
        if (opNow?.cancelledRequested && !outcome) outcome = { stopReason: "aborted" };
        // 流正常结束但无终态：视为完成（end_turn 可能已发但流先关）
        if (!outcome) outcome = { stopReason: "end_turn" };
      } catch (err) {
        if (err?.name === "AbortError") throw Object.assign(new Error("dsh_run 已取消"), { code: "DSH_ABORTED" });
        throw err;
      }
    })();

    // 超时计时：支持审批挂起时暂停/恢复。审批等待是外部决策，不计入执行超时——
    // 挂起时扣减已流逝时间并清 timer，全部解决后按 remaining 重新 setTimeout，剩余窗口续算。
    let timer = null; // 当前计时器句柄（暂停态为 null）
    let remaining = timeoutMs; // 剩余超时毫秒（初始 = 完整超时窗口）
    let startedAt = null; // 当前计时段起点（Date.now()）
    let rejectTimeout = null;
    const timeoutPromise = new Promise((_, reject) => { rejectTimeout = reject; });
    const pauseTimeout = () => {
      if (!timer) return; // 未启动或已暂停：幂等
      remaining -= Date.now() - startedAt;
      clearTimeout(timer);
      timer = null;
    };
    const resumeTimeout = () => {
      if (timer) return; // 运行中：幂等
      if (remaining <= 0) { // 剩余已耗尽（暂停前已贴近超时）：立即判超时
        rejectTimeout(Object.assign(new Error(`dsh_run 超时（${Math.round(timeoutMs / 1000)}s）`), { code: "DSH_TIMEOUT" }));
        return;
      }
      startedAt = Date.now();
      timer = setTimeout(() => {
        rejectTimeout(Object.assign(new Error(`dsh_run 超时（${Math.round(timeoutMs / 1000)}s）`), { code: "DSH_TIMEOUT" }));
      }, remaining);
    };
    let rejectAbort = null;
    const abortPromise = new Promise((_, reject) => {
      if (signal?.aborted) {
        reject(Object.assign(new Error("dsh_run 已取消"), { code: "DSH_ABORTED" }));
        return;
      }
      if (signal) rejectAbort = () => reject(Object.assign(new Error("dsh_run 已取消"), { code: "DSH_ABORTED" }));
    });

    try {
      // 3. 提交 prompt（queue 模式：立即 accepted，agent 异步执行）
      await callUnary(base, "session.prompt", {
        sessionId,
        mode: "queue",
        content: [{ type: "text", text: taskText }],
      }, ac.signal);

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
        throw Object.assign(new Error("dsh_run 已取消"), { code: "DSH_ABORTED" });
      }

      const fullOutput = collected;
      const summary = buildSummary(fullOutput, finalMessageText);
      finish({ status: "ok", output: fullOutput, summary, stopReason: outcome.stopReason, usage: lastUsage ?? null });
      return {
        opId,
        sessionId,
        output: fullOutput,
        summary,
        stopReason: outcome.stopReason,
        usage: lastUsage ?? null,
        stderr: web.stderr ? web.stderr.slice(-2000) : null,
      };
    } catch (err) {
      // 超时/取消：通知 web host 取消该会话的任务（best effort，agent 在 web 里仍可见）
      if (err?.code === "DSH_TIMEOUT" || err?.code === "DSH_ABORTED") {
        try { await callUnary(base, "session.cancel", { sessionId }); } catch { /* 忽略 */ }
      }
      throw err;
    } finally {
      ac.abort();
      if (timer) clearTimeout(timer);
      if (signal && rejectAbort) signal.removeEventListener("abort", onAbort);
      // v0.5.8: 任务终态清理本 op 的审批超时拒绝计时器（防泄漏）。任务已结束（正常
      // 终态/取消/超时），挂起的审批由 web host 侧会话收尾自然失效，无需再自动拒绝。
      for (const [key, t] of approvalTimers) {
        if (key.startsWith(`${opId}::`)) { clearTimeout(t); approvalTimers.delete(key); }
      }
      // v0.5.9: 同样清理本 op 的 tool/call 参数缓存（运行期缓存只活到任务终态，防泄漏）
      for (const key of toolCallCache.keys()) {
        if (key.startsWith(`${opId}::`)) toolCallCache.delete(key);
      }
    }
  })();

  promise.catch((err) => {
    finish({
      status: "error",
      error: (err?.message || String(err)).slice(0, 2000),
      output: null,
      stopReason: err?.code === "DSH_TIMEOUT" ? "timeout" : err?.code === "DSH_ABORTED" ? "aborted" : "error",
      usage: lastUsage ?? null, // 错误终态也带 usage（若已收集到）：取消/超时前的消耗也可对账
    });
  });

  return { opId, promise };
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
  "回调压缩（PTC 式）：异步完成回调默认只带最终结论摘要（callbackMode=summary，省上下文），完整输出在卡片 op 快照与 dsh web UI 可查；设 callbackMode=full 可回传全量。" +
  "审批：dsh agent 请求越界权限时任务挂起，插件经 deferred 通道发来 dsh-approval 通知（带 opId/approvalId/理由/命令参数原文），用 dsh_approve 工具应答（allowed-once/rejected）；无人应答超时自动拒绝（approvalTimeoutMs，0=禁用）；也可在 dsh Web UI 人工处理。" +
  "agentPreset：任务可指定 agent 预设模式（standard/code/cordis/minimal），缺省用插件配置。" +
    "reasoningEffort：任务可指定推理强度（off/high/max），缺省用插件配置。" +
    "resume：传 sessionId 复用已有会话继续任务（agent 保留上文），省上下文重建。resume 时以会话已有 cwd 为准（自动查询沿用，无需传 cwd）。";

export const parameters = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description: "要 dsh 执行的任务描述（会作为用户消息发给编码 agent，应包含完整上下文与明确交付物）",
    },
    cwd: {
      type: "string",
      description: "dsh agent 的沙箱工作目录（bash 与文件系统工具的活动范围，绝对路径）。缺省用插件配置 defaultCwd。resume（传 sessionId）时以会话已有 cwd 为准，该值被忽略。",
    },
    timeout: {
      type: "number",
      description: "超时秒数，缺省用插件配置 defaultTimeoutMs。长任务建议显式调大。",
    },
    wait: {
      type: "boolean",
      description: "false（默认）= 异步：立即返回，进度见卡片，完成后宿主唤醒、结果后台送达；true = 同步：等任务跑完直接返回最终结果（注意：长任务会阻塞当前回合）",
    },
    agentPreset: {
      type: "string",
      enum: ["standard", "code", "cordis", "minimal"],
      description: "agent 预设模式：standard=完整编码 agent（默认）/ code=工具呈现批量调用（适合大型编码任务）/ cordis=可读写运行时的 agent / minimal=固定提示词精简 agent。缺省用插件配置 agentPreset。",
    },
      reasoningEffort: {
        type: "string",
        enum: ["off", "high", "max"],
        description: "推理强度（DeepSeek adapter）：off=关闭思考 / high=高（默认）/ max=最高。缺省用插件配置 reasoningEffort。",
      },
      sessionId: {
        type: "string",
        description: "复用已有 dsh 会话（resume）：传上次任务的 sessionId（dsh_run 回调/卡片里带，或 dsh web UI 会话列表）则在该会话上继续，agent 保留上文（省上下文重建）。resume 时以会话已有 cwd 为准（自动查询沿用，无需传 cwd）；目标会话应已空闲（上次任务已结束）。",
      },
  },
  required: ["task"],
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "external_llm_api",
    summary: "把任务交给 DeepSeek Harness（dsh web host）执行：调用 DeepSeek 官方 API（消耗 API 额度），dsh agent 可能在指定 cwd 内读写文件、运行沙箱命令",
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
  // v0.5.7: 单例记数据目录（落盘/恢复共用）+ 幂等恢复 op 历史（防 startWebHostFromPlugin 未触发场景；loadOps 内部 _opsLoaded 防重复）
  getSingleton().dataDir = dataDir;
  loadOps();
  // v0.6.0: dsh 依赖位置——数据目录 dsh-pkg/（Agent npm ci 部署）优先，插件根兑底
  if (!cfg.dshPkgDir) cfg.dshPkgDir = resolveDshPkgDir(cfg);

  // resume 时 cwd 可空：会话的 cwd 已在创建时定死，复用会话沿用其已有 cwd（提交层 resume 自动查询会话已有 cwd 并显式传入）
  const cwd = String(input.cwd || resolveDefaultCwd(cfg) || "").trim();
  if (!cwd && !input.sessionId) throw new Error("cwd 不能为空（工具参数或插件配置 defaultCwd 至少给一个）");
  const timeoutMs = Number(input.timeout) > 0 ? Number(input.timeout) * 1000 : Number(cfg.defaultTimeoutMs || 600000);

  const taskCfg = {
    nodePath: resolveNodePath(cfg),
    dshPkgDir: cfg.dshPkgDir,
    dataDir: cfg.dataDir,
    apiKey: cfg.apiKey,
    model: cfg.model,
    agentPreset: cfg.agentPreset,
    reasoningEffort: cfg.reasoningEffort,
    webPort: cfg.webPort,
    // v0.5.12: 审批配置收敛为唯一键 approvalTimeoutMs（超时兜底，0=禁用；manifest 默认 30000）
    approvalTimeoutMs: cfg.approvalTimeoutMs,
  };
  const taskParams = { task: input.task, cwd, timeoutMs, signal: ctx.signal, bus: ctx.bus ?? getSingleton().bus, sessionPath: ctx.sessionPath, agentPreset: input.agentPreset, reasoningEffort: input.reasoningEffort, sessionId: input.sessionId };

  const wait = input.wait === true;
  const { opId, promise } = submitTask(taskCfg, taskParams);
  const cardBase = {
    route: `/card/op?opId=${encodeURIComponent(opId)}`,
    title: `dsh ${wait ? "任务" : "运行中"}`,
    description: String(input.task ?? "").slice(0, 80),
    aspectRatio: "16:1",
  };

  // 异步模式：注册 deferred（完成后宿主唤醒，结果后台送达）
  if (!wait) {
    const bus = ctx.bus ?? getSingleton().bus;
    const sessionPath = ctx.sessionPath;
    await registerDeferredWake({ bus, sessionPath, taskId: opId, label: String(input.task ?? "").slice(0, 120) });

    promise.then(
      (res) => {
        // PTC 式回调压缩：默认只带最终结论摘要（callbackMode=summary），
        // 完整输出在 op 快照（卡片）与 dsh web UI（sessionId）可查，不进 Agent 上下文。
        const outputMode = cfg.callbackMode === "full" ? "full" : "summary";
        const payloadOutput = outputMode === "full" ? res.output : (res.summary?.text ?? res.output);
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
        failDeferredWake({ bus, taskId: opId, error: { message: String(err?.message || err).slice(0, 300) } });
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
  const note = res.stopReason === "end_turn" ? "" : `\n\n[stopReason: ${res.stopReason}]`;
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
    ctx.log?.error?.("[dsh-hanako] execute failed:", e?.stack || e?.message || String(e));
    throw e;
  }
}
