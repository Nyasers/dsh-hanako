// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/dsh-run.js — dsh_run 工具（有状态任务提交核心 + 工具契约）
// 把任务交给 DeepSeek Harness（dsh）的 web host（--profile web）执行：
// 经 /api 网关提交任务（session.create → events.mux 订阅 → session.prompt），
// 实时事件流驱动卡片输出。运行期协调态收敛：g.ops 条目键 = sessionId（全链路唯一定位键，
// dsh_run 提交返回 / 卡片 URL / dsh_cancel / dsh_session 同键）；toolCallCache /
// approvalTimers 仍以任务 rpcId 键控（session.prompt 提交产生的 RPC id，与 jsonl
// user/message 的 data.source.rpcId 同值，不在本次收敛范围）。
// 本文件收敛为「有状态提交核心」——与审批状态机（g.ops / approvalTimers /
// toolCallCache）紧耦合的代码保留在此；纯协议/解析/唤醒已剥离到 lib/*.js，
// web host 生命周期在 app/lifecycle.js。
// 完整模块结构与分发纪律见 DESIGN.md「架构」。
// dataDir 解析：ctx.dataDir（宿主 onload 注入）→ g.dataDir（单例，onload 已正确初始化）
// → PLUGIN_ROOT/data（冷启动兜底）。工具调用 ctx 通常没有 dataDir，回退链经单例兜底；
// 回退值绝不写回单例（防污染 g.dataDir → 卡片 readOp / dsh_session 定位错目录），
// 详见 doExecute 内注释。
//
// 权限：external_side_effect（调用 dsh 编码 agent 执行任务，消耗 Hana 宿主 provider 额度，Auto 模式送审）。
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { getSingleton, PLUGIN_ROOT, manifestDefaults } from "../../lib/state.js";
import { resolveDshPkgDir } from "../../lib/bootstrap.js";
// T7：taskId ↔ DSH session/rpc 映射（ctx.storage.agent 主存 / dataDir/state.json 兜底）
import { bindTask, resolveTaskStore } from "../../lib/task-map.js";
// 受管 runtime 内存态（runtimeId 等；映射条目记录定位键用）
import { readDshRuntimeState } from "../../lib/runtime-host.js";
import {
  readDshDefaultModel,
  readDshDefaultPreset,
  resolveReasoningEffort,
  resolveApprovalTimeoutSec,
  resolveDefaultTimeoutSec,
} from "../../lib/config.js";
import {
  registerDeferredWake,
  resolveDeferredWake,
  abnormalWakeResult,
  notifyApprovalWake,
} from "../../lib/wake.js";
import {
  callUnaryBus,
  openMux,
  textFromChunk,
  textFromMessageBlocks,
} from "../../lib/protocol.js";
// 生命周期能力（web host 拉起）——本模块只做任务提交，对单例/web host 的依赖经
// app/lifecycle.js 转发（lifecycle.js 顶层 mountLifecycle 已把 closeProcess / updateDsh /
// startWebHost / installDeps / verifyDeps / checkDshUpdate 挂到 globalThis 单例）。
// config.json 引导已退役（vX，migrate 体系删除）：配置读取侧 resolve* 缺省回退兜底。
// 与 lifecycle.js 同属 index.js 单 bundle 收敛入口的静态 import 链。
import { ensureWebHost } from "../../lib/lifecycle.js";

// 0.1.2 终态结果：读会话投影缓存（projcache json——明文）。
// 0.1.2 无 session/get 命令、$events 无内容事件（api-session/* 只有
// added/removed/status/error/activity）——投影是任务结果的快速通道
// （title/tokenUsage/sessionStats）；完整 assistant 消息可经 dsh_session get 深读。
/**
 * T7：Hana task 终态回投（ctx.tasks.complete/fail）+ 映射状态同步。
 * 第 3 步 task-bridge 完整接线前，这里只做「尽力而为」的终态记录（失败不阻断任务链，
 * 任务真实结果仍在 DSH 会话 jsonl / 卡片里）。
 */
async function settleHanaTask(ctx, taskId, { ok, result, error }) {
  if (!taskId || !ctx) return;
  const tasks = ctx.tasks;
  try {
    if (ok) {
      await tasks?.complete?.(taskId, result);
    } else {
      await tasks?.fail?.(taskId, { message: String(error?.message || error || "DSH 任务失败").slice(0, 500) });
    }
  } catch {
    /* 终态回投失败不阻断（任务结果另有 jsonl 事实源） */
  }
  try {
    const store = resolveTaskStore(ctx, { dataDir: ctx.dataDir });
    const prev = store.read().byTask?.[taskId];
    if (prev) {
      bindTask(store, {
        ...prev,
        status: ok ? "completed" : "failed",
        ...(ok && result?.sessionId ? { dshSessionId: result.sessionId } : {}),
        ...(ok && result?.rpcId ? { rpcId: result.rpcId } : {}),
      });
    }
  } catch {
    /* 映射更新失败不阻断 */
  }
}

function readSessionProjection(dataDir, sessionId) {
  try {
    const p = join(
      dataDir,
      "dsh-home",
      "storages",
      "session_projcache",
      "sessions",
      `${sessionId}.json`,
    );
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// ---- 本地审批应答（自动放行/超时拒绝共用；信封构造同 tools/dsh-approve.js，不 import 避免模块耦合）----
// dsh 0.1.2 瀑布帧应答：$events/result 通道（clientId 由总线补齐，宿主无 launchToken 源）——
// 应答 = RemoteEventResult { clientId, eventId, outcome }，outcome = { kind: 'result', value }。
// callUnaryBus("respond") 经总线 rpc.request 投递 → bus 翻译器自环调 /api/$events/result，
// 回投 { accepted }（ConnectionRpcResult.ok 转译）；成功返回 true，失败抛错由调用方决定。
async function respondApprovalLocal(approval, outcome) {
  const j = await callUnaryBus("respond", {
    eventId: approval.eventId,
    outcome: { kind: "result", value: outcome },
  });
  if (!j || !j.accepted) {
    throw new Error(
      `审批应答未接受（${(j && j.reason) || "unknown"}）：可能已超时或被其他方处理`,
    );
  }
  return true;
}

// 审批超时拒绝计时器表：key = `${taskRpcId}::${approvalId}`（timer 是运行时对象，
// 不挂 g.ops 条目上；终态清理见 submitTask 的 finally）。所有审批都会挂表（0=禁用除外）。
const approvalTimers = new Map();

// tool/call 参数缓存（审批决策信息源）：
// key = `${taskRpcId}::${callId}`，value = { name, args }（args 为命令原文/目标路径的 JSON
// 字符串或对象，通知时转字符串）。运行期缓存不落盘（审批都是运行期的，落盘无意义）；终态清理
// 同 approvalTimers（见 submitTask 的 finally）。审批到达时按 approval.callId 反查，把「具体
// 执行了什么」（命令/路径原文）附在审批通知里给 Agent——Agent 看命令原文决策，而不是只看
// 工具名或 model 自述（bash/pwsh 都能执行任意命令，工具名说明不了安全）。
const toolCallCache = new Map();

// 同会话提交队列：resume/send 可复用同一 DSH 会话，DSH 的 queue 模式会接受并发提交并把
// 后到的 prompt 排到当前 turn 之后；但 submitTask 的 mux 事件流与 g.ops 条目都以 sessionId
// 定位，两个同时运行的 submitTask 会互相消费对方的 turn/end、互相覆盖/清理 ops。因此对同一
// DSH 会话的 submitTask 做进程内串行化，后到任务等前一个任务终态（finally 清理完成）后再
// 执行，保留「同一会话顺序续跑」的既有语义。resume 在进入 runTask 前以 resumeSessionId 排队；
// create 在提交 prompt 前按新 sessionId 登记本队列，避免 create 返回后立即 send 重叠。
const sessionTurnQueues = new Map();

async function withSessionTurn(sessionKey, run) {
  const previous = sessionTurnQueues.get(sessionKey) || Promise.resolve();
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => gate);
  sessionTurnQueues.set(sessionKey, next);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (sessionTurnQueues.get(sessionKey) === next) {
      sessionTurnQueues.delete(sessionKey);
    }
  }
}

// create 路径拿到的 sessionId 在提交完成前对调用方不可知，不会已有并发排队；这里同步占住
// session 队列槽位（与 withSessionTurn 同尾链格式），到任务 finally 清理后释放。
function enterSessionTurn(sessionKey) {
  if (sessionTurnQueues.has(sessionKey)) {
    throw new Error(`dsh_run 内部错误：新会话 ${sessionKey} 已有排队提交`);
  }
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const next = Promise.resolve().then(() => gate);
  sessionTurnQueues.set(sessionKey, next);
  return () => {
    release();
    if (sessionTurnQueues.get(sessionKey) === next) {
      sessionTurnQueues.delete(sessionKey);
    }
  };
}

// ---- 运行期协调状态（任务状态零存储，g.ops 仅存审批/取消协调字段）----
// 任务状态（status/output/summary/usage/耗时）不再保存在插件内存：jsonl（dsh 会话日志）是
// 唯一事实源，卡片经 /ops/stream 从 jsonl 重建基线 + 转发 DSH 实时事件，插件零任务状态。
// g.ops 仅保留「审批/取消」运行期协调状态，键 = sessionId（全链路唯一定位键：dsh_run
// 提交返回 / 卡片 URL / dsh_cancel / dsh_session 同键）：sessionId → { cancelledRequested,
// activeApprovals }。approvalPending 派生态删除（有 pending 项即挂起，activeApprovals 数组
// 判断即可）。任务终态时在 submitTask 的 finally 删除条目。用途：① approval/requested
// 存审批上下文（respondRpcId 路由 respond），dsh_approve 工具应答；② dsh_cancel 凭
// sessionId 直接 ops.get 取条目并标记 cancelledRequested（防 mux 断流时事件循环把取消
// 误判为完成）。前提：同一 sessionId 的 submitTask 由 withSessionTurn 串行，
// 上一轮终态 finally 已删条目后下一轮才建条目，当轮条目语义正确。

function createOpEntry(sessionId, meta) {
  const g = getSingleton();
  // 协调态最小化：task/sessionId/approvalPending 均不再存（task 原文在 jsonl user/message，
  // sessionId 即键，approvalPending 由 activeApprovals 是否有 pending 项推出）。
  // ACP 审批协调补充（L4）：sessionPath/task/rpcId 供 acp-mount 的 request_permission
  // handler 投递 interlude 审批通知（notifyApprovalWake 需要宿主会话关联）。
  g.ops.set(sessionId, {
    activeApprovals: [],
    cancelledRequested: false,
    sessionPath: meta?.sessionPath ?? null,
    task: meta?.task ?? null,
    rpcId: meta?.rpcId ?? null,
  });
  return sessionId;
}

// 缓存 tool/call 帧的参数原文（审批决策信息源）。
// payload 兼容两种帧形：session/event 包裹的 tool/call 事件（ev.data={name,arguments,callId}）
// 或直发帧（frame.data={name,arguments,callId}，宿主 backscanArgs 同款字段结构）。
// arguments 是 JSON 字符串时原样存（子串匹配足够），对象则序列化；无 callId 的帧不缓存。
function cacheToolCall(taskRpcId, payload) {
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
  toolCallCache.set(`${taskRpcId}::${callId}`, {
    name: typeof payload.name === "string" ? payload.name : "",
    args,
  });
}
// ---- 任务提交：注册运行期协调状态 + 后台执行（不 await）----
// 返回 { promise, ready }：任务 rpcId 由 prompt 提交产生（submitTask 作用域提升变量，事件循环
// 与终态回调共用；toolCallCache / approvalTimers 以任务 rpcId 键控，g.ops 以 sessionId 键控）；
// 卡片 route 由 ready 的 sessionId+rpcId 定位；
// promise 在后台跑：session.create → events.mux 订阅 → session.prompt → 事件循环 → 终态。
// 任务状态零存储——collected/blocksSeq/usageTotal 仅用于回调返回，
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
  // vX（dsh 0.1.2）：preset 词表 = standard/ptc/cordis/minimal（code 已退役——旧版
  // "code"（工具呈现批量调用）即现 ptc（PTC 模式 SDK 呈现工具，见 dsh-agent-presets
  // presets/ptc））。旧配置/settings.yaml 遗留 code 时映射到 ptc，避免 agent-preset/not-found。
  if (preset === "code") preset = "ptc";
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
  // ready：session.create + prompt 提交完成时 resolve { sessionId, rpcId }（卡片 URL 推迟到此后生成，
  // 重启后按 sessionId+rpcId 从会话 jsonl 精确恢复 op，零映射文件）；失败 resolve null（loc 为 null 时
  // route 不带任何定位参数——该路径任务提交必失败，deferred fail 会报错，卡片只做失败展示）
  let resolveReady = null;
  const ready = new Promise((r) => {
    resolveReady = r;
  });
  // usageTotal 提升到 submitTask 作用域：事件循环累计（assistant/message 的 d.usage 是每轮 LLM 调用用量，
  // 覆盖式只保留最后一轮、多轮任务严重偏小；按 disjoint 口径累计 = 未缓存输入/输出/缓存读取/推理之和，
  // 与 dsh 会话投影 tokenUsage.totals 对齐）。ok 终态与 promise.catch 的错误终态都能读到。
  let usageTotal = null;
  // taskRpcId 同样提升到 submitTask 作用域：prompt 提交成功后才产生（callUnaryBus 的 rpcId，
  // 总线路径下 bridge 回投 result 承载、HTTP 降级路径同 callUnary——client-request 信封 rpcId，
  // 与 jsonl user/message 的 data.source.rpcId 同值）；事件循环（审批/取消/缓存键）与
  // 终态回调都读它。注意不要用 frame.rpcId（server-request 信封自己的 RPC id，仅 /api/respond 的
  // client-response 路由用，见 approval.respondRpcId）。
  let taskRpcId = null;

  const runTask = async () => {
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
    // 生效 cwd（宿主 task 注册元数据用）：create = 用户显式传的 cwd；resume = 会话已有
    // cwd（send 不传 cwd 时由 session.list 查回）。resume 分支赋值。
    let effectiveCwd = String(cwd ?? "").trim();
    // 活跃会话直续：list 只列「持久但非活跃（可 resume 恢复）」的会话（dsh-acp 的
    // listSessions 排除 sessions Map/activating/ctx.sessions 注册）——list 不含 ≠ 不存在：
    // 会话在 Map（活跃可插话 / 空闲可续）时续 = 直接 session.prompt（ACP prompt 到已
    // 存在会话 = 加 turn/插话——steer 语义），不需要 create/resume（活跃会话 resume 会被
    // dsh-acp 拒 "session already active"）。list 有（进程重启后持久非活跃）才走
    // session.resume 恢复。真不存在的 id（list 无且不在 Map）→ prompt admission 失败
    //（fire 后无事件流——run.js 超时暴露——错误提示见超时）。
    let activeResumeId = null;
    if (resumeSessionId) {
      const list = await callUnaryBus("session.list", {
        projections: ["id", "cwd"],
      });
      const items = list.items || [];
      const existing = items.find((it) => it.sessionId === resumeSessionId);
      if (existing) {
        // 非活跃持久会话（进程重启/长期挂起）——session.resume 从持久恢复
        // 异常会话（cwd 为空/缺失）回退用户显式传的 cwd，再不行才报错
        const resumeCwd = String(existing.cwd ?? "").trim() || cwd;
        if (!resumeCwd)
          throw new Error(
            `目标会话 ${resumeSessionId} 无 cwd 且无可用回退 cwd，无法 resume`,
          );
        effectiveCwd = resumeCwd;
        createPayload = {
          sessionId: resumeSessionId,
          cwd: resumeCwd,
          ...(preset && { agentPreset: preset }),
        };
      } else {
        // list 不含：会话在 Map（活跃/空闲）——直接 prompt 续（插话/加 turn）——
        // cwd 查不回（list 只列非活跃），effectiveCwd 用调用方传的（task 元数据用，
        // 非关键——jsonl 目录由 DSH 按会话持久）
        activeResumeId = resumeSessionId;
        try {
          getSingleton()?.appendLog?.(
            "hana",
            `[dsh-rpc] send 直续活跃会话 ${String(resumeSessionId).slice(0, 16)}（list 无——Map 直 prompt）`,
          );
        } catch { /* 日志失败不阻断 */ }
      }
    } else {
      createPayload = { cwd, ...(preset && { agentPreset: preset }) };
    }
    let sessionId;
    if (activeResumeId) {
      // 活跃会话：不调 session.create（会话已在 Map）——直接用它，后续 prompt fire
      sessionId = activeResumeId;
    } else {
      const session = await callUnaryBus("session.create", createPayload);
      sessionId = session.sessionId;
    }

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
          "dsh_run 需要 provider/model：请显式传 provider/model，或先在 DSH models 页设置默认模型（settings.yaml agent-default-model）",
        );
      }
      const selectModelPayload = {
        sessionId,
        provider: sp,
        model: sm,
        ...(effort ? { reasoningEffort: effort } : {}),
      };
      try {
        await callUnaryBus("session.selectModel", selectModelPayload);
      } catch (err) {
        // 显式 effort 被拒（如 reasoning:false 模型不接受 effort）：降级不带 effort 重试
        if (
          effort &&
          String(err?.message || "").includes("model-unavailable")
        ) {
          await callUnaryBus("session.selectModel", {
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
    let blocksSeq = []; // assistant/message 的 blocks（终态回调输出结构化，reasoning 可折叠）
    // 最新一条 assistant/message 的纯文本（CodeRabbit #11）：从事件 data.message.content 经
    // textFromMessageBlocks 提取真助手文本（非会话 title 元数据）。turn/end 时以它为最终
    // assistant output——覆盖式保留 turn 内最后一条真正的助手答复。
    let lastAssistantText = "";
    const seenMsgIds = new Set(); // assistant/message 去重（防事件边界重放）
    let sawChunk = false;
    const seen = new Set();
    let outcome = null; // { stopReason, failure? }
    // pendingFailure：finish error 帧（LLM 请求失败，如 429 限流）的 failure 兜底记录。
    // finish error 不是终态信号（DSH 侧可能退避重试继续跑），仅当流异常关闭且无 turn/end
    // 终态帧时用它把任务判为失败，避免 finish error 后 DSH 断流/崩溃被误判为成功。
    let pendingFailure = null;

    const consume = (async () => {
      // finishFromProjection：终态统一收尾（HTTP 会话经 api-session/status running=false，
      // ACP 会话不经 session-controller——经 session/event 的 turn/end 帧）。tokenUsage 汇总
      // 自会话投影（projcache）。assistant output 用事件循环累计的真助手文本（CodeRabbit
      // #11）——不再拿 projcache 的 title 元数据冒充助手输出（title 是会话标题，不是回答）。
      const finishFromProjection = () => {
        // 终端前把事件循环累计的最后一条真正的助手答复定为 collected（有正文才覆盖）。
        if (lastAssistantText) collected = lastAssistantText;
        const proj = readSessionProjection(cfg.dataDir, sessionId);
        if (proj) {
          const pv = proj.record?.rows;
          const tu = pv?.tokenUsage?.val;
          if (tu) {
            usageTotal = usageTotal || {};
            const totals = tu.totals || {};
            if (totals.uncachedInputTokens != null)
              usageTotal.inputTokens = totals.uncachedInputTokens;
            if (totals.outputTokens != null)
              usageTotal.outputTokens = totals.outputTokens;
            if (totals.cacheReadTokens != null)
              usageTotal.cacheReadTokens = totals.cacheReadTokens;
          }
        }
        outcome = pendingFailure
          ? { stopReason: "error", failure: pendingFailure }
          : { stopReason: "end_turn" };
      };
      try {
        for await (const frame of openMux(base, ac.signal)) {
          // ---- dsh 0.1.2 事件帧适配（openMux 产出 emit/waterfall）----
          // 0.1.2 的 $events 只广播 api-session/*（added/removed/status/error/activity），
          // 无 assistant/chunk/turn 内容事件——内容经会话投影（projcache）读取。
          // ACP 会话的事件走 session/event 通用广播（不经 session-controller）——
          // turn/end 即终态（与 api-session/status false 同义，双通道互不冲突先到先收）。
          if (frame.type === "emit") {
            const ev = frame.event;
            const args = Array.isArray(frame.args) ? frame.args : [];
            if (ev === "session/event") {
              const [session, evObj] = args;
              const sid = session && (session.id ?? null);
              if (sid !== sessionId) continue;
              if (!evObj || typeof evObj.type !== "string") continue;
              if (evObj.type === "turn/end") {
                // 终态前先判 reason.kind（CodeRabbit #12）：reason.kind==="error" 的失败回合
                //（LLM 输出校验失败/内部错误）不得被 finishFromProjection 当正常成功上报。
                const r = (evObj && evObj.data && evObj.data.reason) || null;
                const kind = r && r.kind;
                if (kind === "error") {
                  // 失败回合：从 reason.error/failure（或 pendingFailure 兜底）取错误消息作
                  // error outcome。normal 完成/aborted 走既有路径：aborted 由 abortPromise/
                  // 上层 DSH_ABORTED 判终，这里不把失败回合当成功 end_turn。
                  const f =
                    (r && (r.failure || r.error)) ||
                    pendingFailure ||
                    { message: "DSH turn 失败（reason.kind=error 无错误详情）" };
                  outcome = {
                    stopReason: "error",
                    failure: {
                      message: String(
                        (f && (f.message || "")) ||
                          (r && r.message) ||
                          "DSH turn 失败",
                      ),
                    },
                  };
                  return; // 终态：失败回合（outcome 已判 error）
                }
                finishFromProjection();
                return; // 终态：turn 回合结束（正常/end_turn）
              }
              if (evObj.type === "assistant/message") {
                // 从事件 data.message.content 提取真正的助手文本（CodeRabbit #11）：不走
                // title 元数据冒充输出。text block 拼接为 lastAssistantText（turn 内最后一条
                // 助手答复即最终 output）；去重防边界重放。blocks 镜像卡片口径累积到 blocksSeq
                //（text/reasoning/tool-call），供终态结构化重建/下游取用。
                const msg =
                  (evObj && evObj.data && evObj.data.message) || null;
                const id = (msg && typeof msg.id === "string" && msg.id) || "";
                if (id) {
                  if (seenMsgIds.has(id)) continue;
                  seenMsgIds.add(id);
                }
                const blocks = Array.isArray(msg && msg.content)
                  ? msg.content
                  : [];
                const msgText = textFromMessageBlocks(blocks);
                for (const b of blocks) {
                  if (!b) continue;
                  if (b.type === "text" && typeof b.text === "string" && b.text) {
                    blocksSeq.push({ type: "text", text: b.text });
                  } else if (
                    b.type === "reasoning" &&
                    typeof b.text === "string" &&
                    b.text
                  ) {
                    blocksSeq.push({ type: "reasoning", text: b.text });
                  } else if (b.type === "tool-call" && b.name) {
                    blocksSeq.push({ type: "tool-call", name: b.name });
                  }
                }
                if (msgText) lastAssistantText = msgText;
                continue;
              }
              continue;
            }
            if (ev === "api-session/status") {
              const [sid, running] = args;
              if (sid !== sessionId) continue;
              if (running !== false) continue; // 运行中：等待终态
              // 终态：agent 回合结束（status false）。结果从会话投影读取。
              finishFromProjection();
              return; // 0.1.2：status false 即终态
            } else if (ev === "api-session/error") {
              const [sid, message] = args;
              if (sid === sessionId && typeof message === "string") {
                pendingFailure = { message };
                getSingleton().appendLog?.(
                  "hana",
                  `[dsh] 任务失败：${message}`,
                );
              }
            } else if (ev === "api-session/activity") {
              // 活动心跳：任务仍在执行（进度信号），忽略
            }
            // api-session/added / removed：会话清单事件，忽略
          } else if (frame.type === "waterfall") {
            // 0.1.2 瀑布帧：approval/request（越界权限请求，agent 挂起等决策）。
            // 宿主审批适配：解析审批对象（approvalId = 瀑布帧 eventId，应答凭据）→
            // 填充 activeApprovals（dsh_approve 工具应答路由）→ 暂停执行超时（审批等待
            // 是外部决策，不计入任务超时）→ notifyApprovalWake（interlude 插话投递宿主，
            // Agent 收到后调 dsh_approve）→ 起审批超时拒绝表（approvalTimeoutSec 无人
            // 应答自动 rejected）。
            if (frame.event === "approval/request") {
              const req =
                frame.request && typeof frame.request === "object"
                  ? frame.request
                  : {};
              const approvalId =
                typeof frame.eventId === "string" && frame.eventId
                  ? frame.eventId
                  : null;
              if (!approvalId) continue;
              const cached =
                typeof req.callId === "string" && req.callId
                  ? toolCallCache.get(`${taskRpcId || "?"}::${req.callId}`)
                  : null;
              const approval = {
                approvalId,
                eventId: approvalId,
                sessionId,
                toolName:
                  typeof req.toolName === "string" ? req.toolName : "tool",
                callId: typeof req.callId === "string" ? req.callId : null,
                reason: typeof req.reason === "string" ? req.reason : null,
                args: cached ? cached.args : null,
                status: "pending",
                requestedAt: new Date().toISOString(),
                _resume: resumeTimeout,
              };
              const op = getSingleton().ops.get(sessionId);
              if (op && Array.isArray(op.activeApprovals)) {
                op.activeApprovals.push(approval);
              }
              // 审批挂起：暂停任务执行超时（应答/超时拒绝后 resumeTimeout 恢复）
              pauseTimeout();
              // 宿主 task 体系：审批任务注册（type: 'dsh-approval'，面板可见；应答/
              // 超时拒绝后 complete）
              try {
                await bus.request("task:register", {
                  taskId: `${sessionId}::approval::${approvalId}`,
                  type: "dsh-approval",
                  parentSessionPath: sessionPath || null,
                  sessionId,
                  meta: {
                    rpcId: taskRpcId || "",
                    toolName: approval.toolName,
                    kind: "dsh-approval",
                  },
                  persist: true,
                });
              } catch {
                /* 注册失败不阻断（审批照常，Web UI 可处理） */
              }
              // 通知 Agent（interlude 插话投递；通知失败不影响任务——审批仍可在
              // DSH Web UI（3080）人工处理）
              await notifyApprovalWake({
                bus,
                sessionPath,
                rpcId: taskRpcId || "",
                approval,
                task: taskText,
              });
              // 审批超时拒绝（approvalTimeoutSec 秒无人应答自动 rejected；0=禁用）
              const ats = resolveApprovalTimeoutSec(cfg);
              if (ats > 0) {
                const tKey = `${taskRpcId || "?"}::${approvalId}`;
                const timer = setTimeout(async () => {
                  try {
                    await respondApprovalLocal(approval, "rejected");
                    approval.status = "answered";
                    approval.outcome = "rejected";
                    approval.answeredAt = new Date().toISOString();
                    // 宿主 task 终态同步（自动超时拒绝）
                    try {
                      await getSingleton().bus?.request?.("task:complete", {
                        taskId: `${sessionId}::approval::${approvalId}`,
                        result: { outcome: "rejected", auto: "expired" },
                      });
                    } catch {
                      /* 忽略 */
                    }
                  } catch {
                    /* 超时拒绝失败静默（任务侧自行感知/终局） */
                  } finally {
                    // 无论应答成功与否都恢复执行超时：应答失败也恢复计时，
                    // 让正常超时路径兑底取消（否则审批等待的暂停永不恢复，
                    // 事件流可无限等待）
                    if (typeof approval._resume === "function") {
                      try {
                        approval._resume();
                      } catch {
                        /* 恢复失败不影响 */
                      }
                    }
                  }
                }, ats * 1000);
                timer.unref?.();
                approvalTimers.set(tKey, timer);
              }
            } else {
              getSingleton().appendLog?.(
                "hana",
                `[dsh] 收到瀑布事件 ${frame.event}`,
              );
            }
          }
        }
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

    // promptMeta 声明提升到 try 外：提交失败时 catch 从 promptMeta.rpcId 兜底
    // taskRpcId（callUnaryBus/HTTP 兜底在 reject 路径也回传 meta.rpcId）
    const promptMeta = {};
    // 新会话在 ready 之前不会暴露给其他 submitTask；进入 try 后、resolveReady 前登记
    // session 队列槽位，使 create 未完成时到达的 send 等待，同时避免注册前抛错泄漏锁。
    let releaseNewSessionTurn = null;
    try {
      releaseNewSessionTurn = resumeSessionId
        ? null
        : enterSessionTurn(sessionId);
      // 3. 提交 prompt（queue 模式：立即 accepted，agent 异步执行）
      // promptMeta.rpcId = 会话 jsonl 的 user/message 事件 data.source.rpcId（同一 RPC id），
      // 经 ready 返回给卡片 URL：插件重启后按 sessionId+rpcId 从 jsonl 精确恢复（运行期
      // 协调键 = sessionId，数据定位键 = sessionId+rpcId）。
      await callUnaryBus(
        "session.prompt",
        {
          sessionId,
          mode: "queue",
          content: [{ type: "text", text: taskText }],
        },
        ac.signal,
        promptMeta,
      );
      // 任务 rpcId 此刻产生（prompt 提交成功）：赋值提升变量 + 建运行期协调条目。
      // 顺序最稳：赋值 taskRpcId → createOpEntry → resolveReady——resolveReady 后事件循环
      // 才开始流转，审批帧到达时条目必已存在（g.ops.get(sessionId) 必命中）。
      // 同一 sessionId 的 submitTask 由 withSessionTurn 串行：
      // 上一轮终态 finally 已删条目后下一轮才建条目，当轮条目语义正确。
      taskRpcId = promptMeta.rpcId || "";
      createOpEntry(sessionId, {
        sessionPath,
        task: taskText,
        rpcId: taskRpcId,
      });
      // 宿主 task 体系接入：任务注册（type: 'dsh'，taskId = sessionId——取消链路经宿主
      // task:abort → handler.abort → session.cancel，Agent 取消统一走宿主 task 能力，
      // dsh_cancel 不再直连）。注册失败不阻断任务（宿主面板不可见，任务照跑；终态同步
      // 同样跳过）。
      try {
        await bus.request("task:register", {
          taskId: sessionId,
          type: "dsh",
          parentSessionPath: sessionPath || null,
          sessionId,
          meta: {
            rpcId: taskRpcId,
            cwd: effectiveCwd,
            task: taskText.slice(0, 200),
            kind: "dsh-session",
          },
          persist: true,
        });
      } catch {
        /* 注册失败不阻断任务 */
      }
      resolveReady({ sessionId, rpcId: taskRpcId });

      // 4. 竞速：事件循环终态 / 超时 / 取消
      // 初始启动：无审批时与旧行为完全一致（一次 setTimeout(timeoutMs)）
      resumeTimeout();
      await Promise.race([consume, timeoutPromise, abortPromise]);
      clearTimeout(timer);
      if (signal && rejectAbort) signal.removeEventListener("abort", onAbort);

      if (!outcome || outcome.stopReason === "error") {
        const failure = outcome?.failure;
        const msg = failure?.message || "DSH 任务执行失败";
        throw Object.assign(new Error(msg), { code: "DSH_ERROR" });
      }
      if (outcome.stopReason === "aborted") {
        throw Object.assign(new Error("dsh_run 已取消"), {
          code: "DSH_ABORTED",
        });
      }
      // 宿主 task 终态同步（register 失败时 complete 也失败，静默跳过）
      try {
        await bus.request("task:complete", {
          taskId: sessionId,
          result: {
            status: "ok",
            rpcId: taskRpcId,
            stopReason: outcome.stopReason,
          },
        });
      } catch {
        /* 终态同步失败不阻断 */
      }

      const fullOutput = collected;
      // 回调/返回值保持 chunk 流文本；结构化 blocks（reasoning 可折叠）由卡片端从 jsonl/实时事件重建
      // 回调固定 minimal：summary 恒为 null（不生成摘要），取内容走 dsh_session get
      return {
        rpcId: taskRpcId,
        sessionId,
        output: fullOutput,
        summary: null,
        stopReason: outcome.stopReason,
        usage: usageTotal ?? null,
        stderr: web.stderr ? web.stderr.slice(-2000) : null,
      };
    } catch (err) {
      // 提交失败也保留 rpcId 关联：promptMeta.rpcId 由 callUnaryBus/HTTP 兜底在 reject 路径
      // 提前回传（reqId 生成即写 meta）——session.prompt 已发出但响应失败/超时/中止时
      // rpcId 仍已知（dsh 侧已以此写 jsonl data.source.rpcId），失败终态可凭 sessionId+rpcId
      // 在 jsonl 定位该轮次；完全未发出（emit 失败且降级也失败）时 rpcId 为空，用
      // 「submission-failed」占位（展示层，deferredTaskId 仍用独立 fallback 保持唯一）。
      if (!taskRpcId && promptMeta?.rpcId) taskRpcId = promptMeta.rpcId;
      // 超时/取消：通知 web host 取消该会话的任务（best effort，agent 在 web 里仍可见）
      if (err?.code === "DSH_TIMEOUT" || err?.code === "DSH_ABORTED") {
        try {
          await callUnaryBus("session.cancel", { sessionId });
        } catch {
          /* 忽略 */
        }
      }
      // 宿主 task 终态同步：取消走 task:cancel（宿主 aborted/canceled 状态保留），
      // 超时/错误走 task:fail；正常终态已在上方 task:complete。
      try {
        if (err?.code === "DSH_ABORTED") {
          await bus.request("task:cancel", {
            taskId: sessionId,
            reason: "aborted",
          });
        } else {
          await bus.request("task:fail", {
            taskId: sessionId,
            reason:
              String((err && err.message) || err || "dsh task failed").slice(0, 300),
          });
        }
      } catch {
        /* 终态同步失败不阻断 */
      }
      // 附加已创建的 sessionId（session.create 成功后 prompt/执行失败时）：回调层
      // abnormalWakeResult 优先用 err.sessionId——session.prompt 失败时 ready 的 loc 为 null
      // （resolveReady 未调），不附加则已创建的会话 ID 丢失，错误只剩空 rpcId 无法对账。
      if (err && typeof err === "object" && !err.sessionId && sessionId) {
        err.sessionId = sessionId;
      }
      throw err;
    } finally {
      ac.abort();
      if (timer) clearTimeout(timer);
      if (signal && rejectAbort) signal.removeEventListener("abort", onAbort);
      // 任务终态清理本 op 的审批超时拒绝计时器（防泄漏）。任务已结束（正常
      // 终态/取消/超时），挂起的审批由 web host 侧会话收尾自然失效，无需再自动拒绝。
      for (const [key, t] of approvalTimers) {
        if (key.startsWith(`${taskRpcId}::`)) {
          clearTimeout(t);
          approvalTimers.delete(key);
        }
      }
      // 同样清理本 op 的 tool/call 参数缓存（运行期缓存只活到任务终态，防泄漏）
      for (const key of toolCallCache.keys()) {
        if (key.startsWith(`${taskRpcId}::`)) toolCallCache.delete(key);
      }
      // 删除运行期协调状态条目（任务状态零存储，条目仅活到终态）
      try {
        getSingleton().ops.delete(sessionId);
      } catch {
        /* 忽略 */
      }
    }
    if (releaseNewSessionTurn) {
      releaseNewSessionTurn();
    }
  };

  const promise = resumeSessionId
    ? withSessionTurn(resumeSessionId, runTask)
    : runTask();

  promise.catch((err) => {
    // 提交失败也保留 rpcId 关联：taskRpcId 已在 catch 里从 promptMeta.rpcId 兜底（若有）——
    // loc 带 { sessionId, rpcId } 时 doExecute 的 text / deferred 回调 / 卡片 route 都保留
    // 关联；完全无 rpcId（提交未发出）时 loc 为 null（route 不带定位参数，错误态由
    // deferred 呈现）。
    resolveReady?.(taskRpcId ? { sessionId, rpcId: taskRpcId } : null);
  });

  return { promise, ready };
}
// ---- 工具契约 ----
export const name = "dsh_run";

export const description =
  "把任务交给 DeepSeek Harness（DSH）的常驻 web host 执行（完整编码 agent：沙箱 shell 与文件系统、上下文压缩、subagent 级联）。" +
  "适合需要独立 agent 上下文深度执行的代码任务（实现/重构/调试/测试）或与当前对话隔离的长任务。" +
  "固定异步：提交即渲染实时卡片、完成后宿主唤醒结果后台送达（任务会话在 DSH Web UI（webPort，默认 3080）可见可继续）。" +
  "完整调用手册（agentPreset/reasoningEffort/provider/model/sessionId resume/审批/固定 minimal 回调）见 SKILL: skills/dsh-run/SKILL.md";

export const parameters = {
  type: "object",
  properties: {
    task: {
      type: "string",
      description:
        "要 DSH 执行的任务描述（会作为用户消息发给编码 agent，应包含完整上下文与明确交付物）",
    },
    cwd: {
      type: "string",
      description:
        "DSH agent 的沙箱工作目录（bash 与文件系统工具的活动范围，绝对路径）。create（新建会话）必传，无配置回退。resume（传 sessionId）时以会话已有 cwd 为准，该值被忽略。",
    },
    timeout: {
      type: "number",
      description:
        "超时秒数，缺省用插件配置 defaultTimeoutSec（单位：秒）。长任务建议显式调大。",
    },
    agentPreset: {
      type: "string",
      enum: ["standard", "ptc", "cordis", "minimal"],
      description:
        "agent 预设模式：standard=完整编码 agent（默认）/ ptc=PTC 模式（以 TypeScript 程序组合多步操作的工具呈现）/ cordis=可读写运行时的 agent / minimal=固定提示词精简 agent。缺省不传，用 DSH 默认（DSH Web UI 可调）。",
    },
    reasoningEffort: {
      type: "string",
      enum: ["off", "high", "max"],
      description:
        "推理强度（DeepSeek adapter）：off=关闭思考 / high=高 / max=最高。工具显式传时才指定（v0.9.5 起无全局配置）；不传时由 DSH 默认处理（通常 high）。",
    },
    provider: {
      type: "string",
      description:
        "显式指定任务 provider（如 deepseek/sensenova/agnes）。与 model 一起传时 selectModel 覆盖 DSH 默认模型；只传一个时另一侧从 settings.yaml 默认模型补齐。都不传时不 selectModel，任务用 DSH 默认。",
    },
    model: {
      type: "string",
      description:
        "显式指定任务模型 id（如 deepseek-v4-flash）。与 provider 一起传时 selectModel 覆盖 DSH 默认模型；都不传时不 selectModel，任务用 DSH 默认。",
    },
    sessionId: {
      type: "string",
      description:
        "复用已有 DSH 会话（resume）：传上次任务的 sessionId（dsh_run 回调/卡片里带，或 DSH web UI 会话列表）则在该会话上继续，agent 保留上文（省上下文重建）。resume 时以会话已有 cwd 为准（自动查询沿用，无需传 cwd）；目标会话应已空闲（上次任务已结束）。",
    },
  },
  required: ["task"],
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "external_llm_api",
    summary:
      "把任务交给 DeepSeek Harness（DSH web host）执行：经 Hana 宿主 provider（sensenova/agnes/deepseek）消耗模型额度，DSH agent 可能在指定 cwd 内读写文件、运行沙箱命令",
    ruleId: "dsh-hanako-external-llm",
  }),
};
async function doExecute(input, ctx) {
  // 只合并非空配置值：dev/未设置时 ctx.config 可能带 undefined 键，spread 会覆盖 manifest 默认值
  const cfg = { ...manifestDefaults };
  for (const [k, v] of Object.entries(ctx.config || {})) {
    if (v !== undefined && v !== null && v !== "") cfg[k] = v;
  }
  // 插件数据目录（宿主注入）：DSH_HOME 数据根落在这里（账本随插件生命周期）。
  // 回退链对齐 dsh-install 的 ctx.dataDir || g.dataDir：宿主只对 onload
  // 生命周期 ctx 注入 dataDir，工具调用 ctx 通常没有（缺 g.dataDir 兜底会回退到
  // PLUGIN_ROOT/data 并把错误值写进单例，污染 g.dataDir → 卡片 readOp / dsh_session
  // 全落到不存在的 dsh-home → 404「任务记录不存在」）。
  const g = getSingleton();
  const dataDir = ctx.dataDir || g.dataDir || join(PLUGIN_ROOT, "data");
  cfg.dataDir = dataDir;
  // vX（migrate 体系退役）：不再自动生成 config.json / 超时键迁移——配置读取侧兜底。
  // 单例记数据目录（dsh_session 经 g.dataDir 定位 dsh 会话缓存等数据文件）——
  // 只在显式注入（ctx.dataDir 非空）或单例为空（冷启动兜底）时写入；ctx.dataDir
  // 为空且单例已有值时保留单例原值，绝不把 PLUGIN_ROOT/data 回退值覆盖进去。
  if (ctx.dataDir && ctx.dataDir !== g.dataDir) g.dataDir = ctx.dataDir;
  else if (!g.dataDir) g.dataDir = dataDir;
  // dsh 依赖位置——数据目录 dsh-pkg/（Agent npm i @deepseek-ai/dsh 部署）优先，插件根兑底
  if (!cfg.dshPkgDir) cfg.dshPkgDir = resolveDshPkgDir(cfg);

  // resume 时 cwd 可空：会话的 cwd 已在创建时定死，复用会话沿用其已有 cwd（提交层 resume 自动查询会话已有 cwd 并显式传入）
  // create 必传 cwd（defaultCwd 配置已删除，无回退）：沙箱工作目录每次调用显式指定
  const cwd = String(input.cwd ?? "").trim();
  if (!cwd && !input.sessionId)
    throw new Error("create 必须传 cwd（沙箱工作目录，defaultCwd 配置已删除无回退；send 沿用会话已有 cwd）");
  // 超时单位统一为秒（v0.25）：工具 timeout 参数与配置 defaultTimeoutSec 均为秒，
  // 边界换算——内部计时保留毫秒（setTimeout 需要毫秒），换算只在工具参数入口/配置读取处。
  // 显式 timeout > 0 采用（秒→毫秒）；否则用配置默认（resolveDefaultTimeoutSec 秒，
  // 含旧键 defaultTimeoutMs 迁移兜底；0/缺失回落 600s 硬编码兜底，与旧 ||600000 语义一致）。
  const timeoutSec = resolveDefaultTimeoutSec(cfg);
  const timeoutMs =
    Number(input.timeout) > 0 ? Number(input.timeout) * 1000 : timeoutSec * 1000;

  // callbackMode 收口固定 minimal（v0.21.3 后续演进）：所有回调只带定位键
  // { status, rpcId, sessionId }（sessionId 唯一定位键，不再冗余 id 字段），
  // 不生成摘要、不占上下文；取会话内容统一走 dsh_session action=get（凭 sessionId 直取 summary）。
  const taskCfg = {
    dshPkgDir: cfg.dshPkgDir,
    dataDir: cfg.dataDir,
    reasoningEffort: cfg.reasoningEffort,
    webPort: cfg.webPort,
    // 任务超时（内部毫秒；卡片 URL 携带供恢复态「时间」行展示超时预算 + 本地倒计时）
    timeoutMs,
    // 审批配置唯一键 approvalTimeoutSec（单位：秒；超时兜底，0=禁用；manifest 默认 30）
    approvalTimeoutSec: cfg.approvalTimeoutSec,
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

  const { promise, ready } = submitTask(taskCfg, taskParams);
  // 卡片 URL 推迟到 session.create + prompt 提交后生成：携带 sessionId+rpcId，
  // 插件重启后旧卡片按这两个键从会话 jsonl 精确恢复（运行期协调键 = sessionId，不丢数据）
  const loc = await ready;
  // 任务 rpcId：ready 的 loc.rpcId（prompt 提交产生的 RPC id，与 jsonl data.source.rpcId 同值）；
  // loc 为 null（提交失败）时为空串。deferred taskId 与工具契约字段都用它。
  const taskRpcId = (loc && loc.rpcId) || "";
  // ---- T7：taskId ↔ DSH session/rpc 映射（ctx.storage.agent 主存；第 3 步完整接线前先建）----
  // hanaTaskId 由 index.js 的 execute 外层在本次工具调用期间经 ctx.tasks.create 取得
  // （callToken 只在 create 时有效，此后只用稳定 taskId）；缺失则跳过（映射降级，任务照跑）。
  const hanaTaskId = typeof ctx?.hanaTaskId === "string" ? ctx.hanaTaskId : "";
  if (hanaTaskId) {
    try {
      const store = resolveTaskStore(ctx, { dataDir });
      bindTask(store, {
        taskId: hanaTaskId,
        kind: input.sessionId ? "send" : "create",
        status: "running",
        dshSessionId: (loc && loc.sessionId) || "",
        rpcId: taskRpcId,
        runtimeId: readDshRuntimeState().runtimeId || null,
        cwd,
        ...(input.provider ? { provider: String(input.provider) } : {}),
        ...(input.model ? { model: String(input.model) } : {}),
      });
    } catch (e) {
      getSingleton()?.appendLog?.(
        "hana",
        "[dsh-hanako] taskId 映射写入失败（降级）：" + (e?.message || e),
      );
    }
  }
  // deferred taskId = 任务 rpcId（toolCallCache / approvalTimers / deferred 同键，与 g.ops
  // 的 sessionId 键并存）；taskRpcId 为空时兜底唯一键
  // （该路径提交必失败，deferred fail 报错即可）
  const deferredTaskId = taskRpcId || ("dsh-run::" + Date.now().toString(36));
  // 卡片 route 定位参数只带 locQuery（sessionId+rpcId+timeoutMs）；loc 为 null（提交失败）时
  // route 不带任何定位参数——降级路径已随 op Map 退役移除（/ops/stream 需 sessionId+rpcId 才能恢复）
  const locQuery =
    (loc && loc.sessionId
      ? `?sessionId=${encodeURIComponent(loc.sessionId)}`
      : "") +
    (loc && loc.rpcId ? `&rpcId=${encodeURIComponent(loc.rpcId)}` : "") +
    (loc && taskCfg.timeoutMs != null
      ? `&timeoutMs=${encodeURIComponent(taskCfg.timeoutMs)}`
      : "");
  const cardBase = {
    route: `/card/op${locQuery}`,
    title: "DSH 运行中",
    description: String(input.task ?? "").slice(0, 80),
    aspectRatio: "16:1",
  };

  // 固定异步：注册 deferred（完成后宿主唤醒，结果后台送达）——wait 参数已退役，
  // 同步等待不再提供（长任务阻塞当前回合无收益，取内容走 dsh_session get）
  {
    const bus = ctx.bus ?? getSingleton().bus;
    const sessionPath = ctx.sessionPath;
    await registerDeferredWake({
      bus,
      sessionPath,
      taskId: deferredTaskId,
      label: String(input.task ?? "").slice(0, 120),
    });

    promise.then(
      (res) => {
        // 回调固定 minimal：只带定位键 { status, rpcId, sessionId }（sessionId 唯一定位键，
        // 与 dsh_session / dsh_run resume 同键；不再冗余 id 字段——id 与 sessionId 同值重复），
        // 不含 output/outputMeta/summary/usage/stderr 等大字段、不生成摘要、不占 Agent 上下文；
        // 取会话内容统一走 dsh_session action=get（凭 sessionId 直取 summary），完整输出在
        // 卡片与 dsh Web UI 可查。
        resolveDeferredWake({
          bus,
          taskId: deferredTaskId,
          result: {
            status: "ok",
            rpcId: taskRpcId,
            sessionId: res.sessionId,
          },
        });
        // T7：Hana task 终态回投 + 映射状态同步（失败不阻断）
        settleHanaTask(ctx, hanaTaskId, {
          ok: true,
          result: { sessionId: res.sessionId, rpcId: taskRpcId },
        });
      },
      (err) => {
        // 非正常终态（取消/超时/错误）也走 resolve 形态：宿主对 deferred:fail 只呈现
        // error.message 纯文本（实测丢定位键），resolve 的 result JSON 完整回传——与正常
        // 结束同构的 minimal 定位键 { status, rpcId, sessionId } + 简短 message
        // （status：cancelled / timeout / failed）。定位键优先级见 abnormalWakeResult。
        resolveDeferredWake({
          bus,
          taskId: deferredTaskId,
          result: abnormalWakeResult({
            err,
            loc,
            taskRpcId: taskRpcId || "submission-failed",
          }),
        });
        // T7：非正常终态（取消/超时/失败）同样回投 Hana task（fail 语义）+ 映射状态
        settleHanaTask(ctx, hanaTaskId, { ok: false, error: err });
      },
    );

    return {
      content: [
        {
          type: "text",
          // 提交返回即带 sessionId（持久定位键，jsonl 文件级，不依赖 g.ops 内存态）：
          // loc.sessionId 在 await ready 后已可用（session.create + prompt 提交成功），
          // 与卡片 URL locQuery 同源。放 content text 而非仅 details——details 不进入
          // Agent 上下文（实机：wait 返回只有 text），Agent 凭 text 里的 sessionId 立即
          // dsh_cancel / dsh_session get，无需反查 list 或等终态回调。提交失败（loc
          // null）时 sessionId 占位「（提交失败）」，rpcId 仍可定位（deferred 回调兜底）。
          text: `任务已提交给 DSH（rpcId: ${taskRpcId || "submission-failed"}，sessionId: ${(loc && loc.sessionId) || "（提交失败）"}），在后台执行中。进度与输出见上方卡片；完成后后台消息仅带回任务状态与定位键（rpcId/sessionId），取内容用 dsh_session get。`,
        },
      ],
      details: {
        dsh: {
          sessionId: (loc && loc.sessionId) || "",
          rpcId: taskRpcId,
          status: "running",
          cwd,
        },
        card: cardBase,
      },
    };
  }
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
