// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/dsh-run.js — dsh_run 工具（有状态任务提交核心 + 工具契约）
// 把任务交给 DeepSeek Harness（dsh）的 web host（--profile web）执行：
// 经 /api 网关提交任务（session.create → events.mux 订阅 → session.prompt），
// 实时事件流驱动卡片输出。运行期协调键统一为任务 rpcId（session.prompt 提交产生的
// RPC id，与 jsonl user/message 的 data.source.rpcId 同值）——g.ops 条目键 /
// toolCallCache / approvalTimers 全部以任务 rpcId 键控，运行期协调键与数据定位键合一。
// 本文件收敛为「有状态提交核心」——与审批状态机（g.ops / approvalTimers /
// toolCallCache）紧耦合的代码保留在此；纯协议/解析/唤醒已剥离到 lib/*.js，
// web host 生命周期在 app/lifecycle.js。
// 完整模块结构与分发纪律见 DESIGN.md「架构」。
// dataDir 解析：ctx.dataDir（宿主 onload 注入）→ g.dataDir（单例，onload 已正确初始化）
// → PLUGIN_ROOT/data（冷启动兜底）。工具调用 ctx 通常没有 dataDir，回退链经单例兜底；
// 回退值绝不写回单例（防污染 g.dataDir → 卡片 readOp / dsh_ops 定位错目录），
// 详见 doExecute 内注释。
//
// 权限：external_side_effect（调用 dsh 编码 agent 执行任务，消耗 Hana 宿主 provider 额度，Auto 模式送审）。
import { join } from "node:path";
import { getSingleton, PLUGIN_ROOT, manifestDefaults } from "./lib/state.js";
import { resolveDshPkgDir } from "./lib/install.js";
import {
  readDshDefaultModel,
  readDshDefaultPreset,
  resolveReasoningEffort,
  resolveApprovalTimeoutMs,
  resolveDefaultCwd,
} from "./lib/config.js";
import {
  registerDeferredWake,
  resolveDeferredWake,
  failDeferredWake,
  notifyApprovalWake,
} from "./lib/wake.js";
import {
  callUnary,
  openMux,
  textFromChunk,
  textFromMessageBlocks,
  buildSummary,
} from "./lib/protocol.js";
// 生命周期能力（web host 拉起 / config.json 引导）——本模块只做任务提交，这两者对单例/web host
// 的依赖经 app/lifecycle.js 转发（lifecycle.js 顶层 mountLifecycle 已把 closeProcess / collectDiagnostics /
// updateDsh / startWebHost / installDeps / verifyDeps / checkDshUpdate 挂到 globalThis 单例）。
import { ensureWebHost, ensureConfigJson } from "../lifecycle.js";

// ---- 本地审批应答（自动放行/超时拒绝共用；信封构造同 tools/dsh-approve.js，不 import 避免模块耦合）----
// POST {base}/api/respond，client-response 信封（rpcId 路由 web host pending 表），校验 j.accepted。
// 成功返回 true，失败抛错由调用方决定：自动放行失败回退人工通知，超时拒绝失败静默忽略。
async function respondApprovalLocal(base, approval, outcome) {
  const body = {
    type: "client-response",
    rpcId: approval.respondRpcId,
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

// ---- 运行期协调状态（任务状态零存储，g.ops 仅存审批/取消协调字段）----
// 任务状态（status/output/summary/usage/耗时）不再保存在插件内存：jsonl（dsh 会话日志）是
// 唯一事实源，卡片经 /ops/stream 从 jsonl 重建基线 + 转发 DSH 实时事件，插件零任务状态。
// g.ops 仅保留「审批/取消」运行期协调状态：任务 rpcId → { rpcId, task, sessionId,
// approvalPending, pendingApprovals, cancelledRequested }。任务终态时在 submitTask 的 finally
// 删除条目。用途：① approval/requested 存审批上下文（respondRpcId 路由 respond），
// dsh_approve 工具应答；② dsh_cancel 按 sessionId 遍历 g.ops 找条目并标记 cancelledRequested
//   （防 mux 断流时事件循环把取消误判为完成）。

function createOpEntry(taskRpcId, { task, sessionId }) {
  const g = getSingleton();
  g.ops.set(taskRpcId, {
    rpcId: taskRpcId,
    task: String(task ?? "").slice(0, 500),
    sessionId: sessionId ?? null, // prompt 提交成功后建条目时已建会话，直接回填（dsh_cancel 按 sessionId 遍历反查）
    approvalPending: false,
    pendingApprovals: [],
    cancelledRequested: false,
  });
  return taskRpcId;
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
// 与终态回调共用；运行期协调键与数据定位键合一）；卡片 route 由 ready 的 sessionId+rpcId 定位；
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
  // taskRpcId 同样提升到 submitTask 作用域：prompt 提交成功后才产生（callUnary 的 client-request
  // 信封 rpcId，与 jsonl user/message 的 data.source.rpcId 同值）；事件循环（审批/取消/缓存键）与
  // 终态回调都读它。注意不要用 frame.rpcId（server-request 信封自己的 RPC id，仅 /api/respond 的
  // client-response 路由用，见 approval.respondRpcId）。
  let taskRpcId = null;

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
    // pendingFailure：finish error 帧（LLM 请求失败，如 429 限流）的 failure 兜底记录。
    // finish error 不是终态信号（DSH 侧可能退避重试继续跑），仅当流异常关闭且无 turn/end
    // 终态帧时用它把任务判为失败，避免 finish error 后 DSH 断流/崩溃被误判为成功。
    let pendingFailure = null;

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
              // finish error 帧不是失败信号：DSH 侧 LLM 请求失败（如 429 限流）会进入
              // agent/request-error waterfall → dsh-llm-retry recover（指数退避 + jitter，
              // append llm/retry 后 cancellableDelay 等待），返回 {kind:"retry"} 时 step()
              // continue 重试、不抛错——任务实际还在跑。只把 failure 记进 pendingFailure
              // （流异常关闭无 turn/end 时兜底判失败），继续消费后续帧；终态判定以 turn/end
              // 为准（官方 UI 客户端同语义：event.type !== "turn/end" || reason.kind !== "error"）。
              const c = d?.chunk;
              if (c?.type === "finish" && c.reason?.kind === "error") {
                const f = c.reason.failure || c.reason.error || {};
                pendingFailure = {
                  message:
                    f.message || c.reason.message || "模型调用失败（无详情）",
                  ...(f.code ? { code: f.code } : {}),
                };
              } else {
                const t = textFromChunk(d);
                if (t) collected += t; // 仅本地收集（回调输出用）；不再写 op Map
              }
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
              // 缓存工具调用参数原文（session/event 包裹的 tool/call 事件，
              // d = { name, arguments, callId }），审批到达时按 callId 反查做内容级匹配。
              cacheToolCall(taskRpcId, d);
            } else if (ev.type === "tool/code-dispatch-start") {
              // code preset 子调用分发事件（d = { rootCallId, parentCallId,
              // subCallId, name, arguments }）：run_code 内联的工具调用（如 write）以子调用
              // 形式派发，参数不产生独立 tool/call 帧；按 subCallId 缓存（形如 `root:code:N`），
              // 审批帧 callId 即该 subCallId，可精确反查到命令/路径原文。
              cacheToolCall(taskRpcId, {
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
                  failure: { message: "DSH 任务失败（无错误详情）" },
                };
              else outcome = { stopReason: kind || "end_turn" };
              return; // 一次 prompt = 一个 turn，turn/end 即终态
            } else if (ev.type === "llm/retry") {
              // LLM 请求失败退避重试事件（dsh-llm-retry 的 recover 挂 agent/request-error
              // waterfall，session.append 后 cancellableDelay 等待再返回 {kind:"retry"}）。
              // 只经会话日志通道记一条（不阻断事件循环、不改卡片渲染），终态仍以 turn/end 为准。
              // data 含 retryId/turn/step/provider/mode/policyKey/retry（第 N 次）/delayMs/failure。
              const rd = d || {};
              const retryN = Number(rd.retry) || 1;
              const extra = [];
              if (rd.provider) extra.push(`provider=${rd.provider}`);
              if (rd.failure?.code) extra.push(`code=${rd.failure.code}`);
              const extraTxt = extra.length ? `，${extra.join("，")}` : "";
              getSingleton().appendLog?.(
                "hana",
                `[LLM 重试] LLM 请求失败，退避重试中（第 ${retryN} 次，延迟 ${rd.delayMs}ms${extraTxt}）`,
              );
            }
          } else if (frame.type === "approval/requested") {
            // 审批挂起（approval/policy=ask）：任务会等待应答。把审批上下文（含 respond
            // 路由所需的 respondRpcId）存进运行期协调状态（g.ops 条目，键 = 任务 rpcId），并触发
            // 宿主 deferred 通知（独立 taskId，不占用任务完成通道），Agent 收到后
            // 调用 dsh_approve 工具应答；无人应答仍可在 dsh Web UI 人工处理。
            // 审批固定形态——挂起 → deferred 通知 Agent（附 tool/call 参数原文，
            // 见 notifyApprovalWake）→ Agent 用 dsh_approve 应答；无人应答超时自动拒绝
            // （approvalTimeoutMs，默认 30s 应答方失联检测，0=禁用）。不再有白名单自动放行
            // 或 manual/auto 模式切换：全部审批都交 Agent 处理。
            const g = getSingleton();
            const op = g.ops.get(taskRpcId);
            if (op) {
              op.approvalPending = true;
              const approval = {
                approvalId: frame.approvalId,
                respondRpcId: frame.rpcId,
                sessionId,
                toolName: frame.toolName,
                callId: frame.callId,
                reason: frame.reason,
                at: new Date().toISOString(),
                status: "pending",
              };
              // 审批通知附带 tool/call 参数原文（命令/路径，按 callId 从
              // toolCallCache 反查）——Agent 决策看「具体执行了什么」，而不是只听 model 自述
              // reason。code preset 下子调用（subCallId 形如 `root:code:N`）的参数在
              // tool/code-dispatch-start 事件里，已按 subCallId 精确缓存；若仍 miss（子调用
              // 事件未到/直发帧形态），剥 `:code:N` 后缀回退到 run_code 根调用（args 为整段
              // 代码原文，兜底呈现）。
              let cachedCall = toolCallCache.get(`${taskRpcId}::${frame.callId}`);
              if (!cachedCall && typeof frame.callId === "string") {
                const stripped = frame.callId.replace(/:\w+:\d+$/, "");
                if (stripped !== frame.callId) {
                  const root = toolCallCache.get(`${taskRpcId}::${stripped}`);
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
                // 统一流程：所有审批都通知 Agent 应答（不区分 manual/auto，无白名单）。
                // 通知附带命令/路径原文（approval.args）；挂起后暂停执行超时计时（外部决策等待
                // 不计入执行时间），并挂审批超时拒绝计时器（approvalTimeoutMs，0=禁用）。
                notifyApprovalWake({
                  bus: bus ?? getSingleton().bus,
                  sessionPath,
                  rpcId: taskRpcId,
                  approval,
                  task: op.task,
                });
                pauseTimeout(); // 审批挂起：暂停执行超时计时（外部决策等待不计入执行时间）
                const timeoutMs = resolveApprovalTimeoutMs(cfg);
                if (timeoutMs > 0) {
                  const timerKey = `${taskRpcId}::${approval.approvalId}`;
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
            // "answered" 时不再覆写，但同样不参与 pending 计数。item 变为非
            // pending（resolved/answered）即清掉该审批的超时拒绝计时器（防触发重复应答）。
            const g = getSingleton();
            const op = g.ops.get(taskRpcId);
            if (op?.pendingApprovals) {
              const item = op.pendingApprovals.find(
                (a) => a.approvalId === frame.approvalId,
              );
              if (item && item.status === "pending") {
                item.status = "resolved";
                item.outcome = frame.outcome ?? "resolved";
                item.resolvedAt = new Date().toISOString();
              }
              const timerKey = `${taskRpcId}::${frame.approvalId}`;
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
            // 直发 tool/call 帧（frame.data = { name, arguments, callId }，
            // 宿主 backscanArgs 同款字段结构）：同样缓存参数原文（frame.data 缺失时回退帧字段）。
            cacheToolCall(taskRpcId, frame.data ?? frame);
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
        const opNow = getSingleton().ops.get(taskRpcId);
        if (opNow?.cancelledRequested && !outcome)
          outcome = { stopReason: "aborted" };
        // 兜底增强：流正常关闭但无 turn/end 时，若期间见过 finish error（LLM 请求失败帧，
        // DSH 退避重试中/断流/崩溃），按失败收尾——避免 finish error 后 DSH 断流被误判为成功。
        // 取消优先（上面已判 aborted），这里只处理非取消的异常收尾；pendingFailure 为空时
        // 保持原「视为完成」语义（end_turn 可能已发但流先关）。
        if (!outcome && pendingFailure)
          outcome = { stopReason: "error", failure: pendingFailure };
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
      // 经 ready 返回给卡片 URL：插件重启后按 sessionId+rpcId 从 jsonl 精确恢复（运行期协调键
      // 即任务 rpcId，数据定位键合一）
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
      // 任务 rpcId 此刻产生（prompt 提交成功）：赋值提升变量 + 建运行期协调条目。
      // 顺序最稳：赋值 taskRpcId → createOpEntry → resolveReady——resolveReady 后事件循环
      // 才开始流转，审批帧到达时条目必已存在（g.ops.get(taskRpcId) 必命中）。
      taskRpcId = promptMeta.rpcId || "";
      createOpEntry(taskRpcId, { task: taskText, sessionId });
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

      const fullOutput = collected;
      // 回调/返回值保持 chunk 流文本；结构化 blocks（reasoning 可折叠）由卡片端从 jsonl/实时事件重建
      // minimal 模式不生成摘要（buildSummary 是宿主侧协议层函数，minimal 回调不带 output/摘要）
      const summary =
        cfg.callbackMode === "minimal"
          ? null
          : buildSummary(fullOutput, finalMessageText);
      return {
        rpcId: taskRpcId,
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
      // 附加已创建的 sessionId（session.create 成功后 prompt/执行失败时）：execute 层
      // failDeferredWake 优先用 err.sessionId——session.prompt 失败时 ready 的 loc 为 null
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
        getSingleton().ops.delete(taskRpcId);
      } catch {
        /* 忽略 */
      }
    }
  })();

  promise.catch((err) => {
    resolveReady?.(null); // 提交失败：loc 为 null，卡片 route 不带定位参数（错误态由 deferred fail 呈现）
  });

  return { promise, ready };
}
// ---- 工具契约 ----
export const name = "dsh_run";

export const description =
  "把任务交给 DeepSeek Harness（DSH）的常驻 web host 执行（完整编码 agent：沙箱 shell 与文件系统、上下文压缩、subagent 级联）。" +
  "适合需要独立 agent 上下文深度执行的代码任务（实现/重构/调试/测试）或与当前对话隔离的长任务。" +
  "默认异步：提交即渲染实时卡片、完成后宿主唤醒结果后台送达；wait=true 同步直接返回。任务会话在 DSH Web UI（webPort，默认 3080）可见可继续。" +
  "完整调用手册（agentPreset/reasoningEffort/provider/model/sessionId resume/审批/回调模式）见 SKILL: skills/dsh-run/SKILL.md";

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
        "DSH agent 的沙箱工作目录（bash 与文件系统工具的活动范围，绝对路径）。缺省用插件配置 defaultCwd。resume（传 sessionId）时以会话已有 cwd 为准，该值被忽略。",
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
        "agent 预设模式：standard=完整编码 agent（默认）/ code=工具呈现批量调用（适合大型编码任务）/ cordis=可读写运行时的 agent / minimal=固定提示词精简 agent。缺省不传，用 DSH 默认（DSH Web UI 可调）。",
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
  // 回退链对齐 dsh-update/dsh-install 的 ctx.dataDir || g.dataDir：宿主只对 onload
  // 生命周期 ctx 注入 dataDir，工具调用 ctx 通常没有（缺 g.dataDir 兜底会回退到
  // PLUGIN_ROOT/data 并把错误值写进单例，污染 g.dataDir → 卡片 readOp / dsh_ops
  // 全落到不存在的 dsh-home → 404「任务记录不存在」）。
  const g = getSingleton();
  const dataDir = ctx.dataDir || g.dataDir || join(PLUGIN_ROOT, "data");
  cfg.dataDir = dataDir;
  // 首次工具调用即自动生成 config.json（不存在时按 manifest 默认值；幂等，失败静默）
  ensureConfigJson(cfg);
  // 单例记数据目录（dsh_ops 经 g.dataDir 定位 dsh 会话缓存等数据文件）——
  // 只在显式注入（ctx.dataDir 非空）或单例为空（冷启动兜底）时写入；ctx.dataDir
  // 为空且单例已有值时保留单例原值，绝不把 PLUGIN_ROOT/data 回退值覆盖进去。
  if (ctx.dataDir && ctx.dataDir !== g.dataDir) g.dataDir = ctx.dataDir;
  else if (!g.dataDir) g.dataDir = dataDir;
  // dsh 依赖位置——数据目录 dsh-pkg/（Agent npm i @deepseek-ai/dsh 部署）优先，插件根兑底
  if (!cfg.dshPkgDir) cfg.dshPkgDir = resolveDshPkgDir(cfg);

  // resume 时 cwd 可空：会话的 cwd 已在创建时定死，复用会话沿用其已有 cwd（提交层 resume 自动查询会话已有 cwd 并显式传入）
  const cwd = String(input.cwd || resolveDefaultCwd(cfg) || "").trim();
  if (!cwd && !input.sessionId)
    throw new Error("cwd 不能为空（工具参数或插件配置 defaultCwd 至少给一个）");
  const timeoutMs =
    Number(input.timeout) > 0
      ? Number(input.timeout) * 1000
      : Number(cfg.defaultTimeoutMs || 600000);

  // callbackMode 三档：full=回传全量输出 / summary=只带最终结论摘要（默认）/
  // minimal=回调只带 { id, status, rpcId, sessionId } 定位键（不生成摘要、不占上下文）
  const callbackMode =
    cfg.callbackMode === "full" || cfg.callbackMode === "minimal"
      ? cfg.callbackMode
      : "summary";
  // 异步提交回执按 callbackMode 展示三档语义
  const modePhrase =
    callbackMode === "full"
      ? "带回完整输出"
      : callbackMode === "minimal"
        ? "仅带回任务状态与定位键（id/rpcId/sessionId）"
        : "带回结果摘要";

  const taskCfg = {
    dshPkgDir: cfg.dshPkgDir,
    dataDir: cfg.dataDir,
    reasoningEffort: cfg.reasoningEffort,
    webPort: cfg.webPort,
    // 审批配置唯一键 approvalTimeoutMs（超时兜底，0=禁用；manifest 默认 30000）
    approvalTimeoutMs: cfg.approvalTimeoutMs,
    // 回调输出模式（minimal 时 submitTask 跳过 buildSummary）
    callbackMode,
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
  const { promise, ready } = submitTask(taskCfg, taskParams);
  // 卡片 URL 推迟到 session.create + prompt 提交后生成：携带 sessionId+rpcId，
  // 插件重启后旧卡片按这两个键从会话 jsonl 精确恢复（运行期协调键 = 任务 rpcId，不丢数据）
  const loc = await ready;
  // 任务 rpcId：ready 的 loc.rpcId（prompt 提交产生的 RPC id，与 jsonl data.source.rpcId 同值）；
  // loc 为 null（提交失败）时为空串。deferred taskId 与工具契约字段都用它。
  const taskRpcId = (loc && loc.rpcId) || "";
  // deferred taskId = 任务 rpcId（运行期协调键与数据定位键合一）；taskRpcId 为空时兜底唯一键
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
    title: `DSH ${wait ? "任务" : "运行中"}`,
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
      taskId: deferredTaskId,
      label: String(input.task ?? "").slice(0, 120),
    });

    promise.then(
      (res) => {
        // 回调 result 统一带定位键 id（= sessionId，与 dsh_ops / dsh_search / dsh_run
        // resume 同键）：主上下文收到回调后凭 id 直接取会话内容或续接，无需 dsh_search 查找。
        if (callbackMode === "minimal") {
          // minimal：回调只带定位键（不含 output/outputMeta/summary/usage/stderr 等大字段，
          // 不生成摘要、不占 Agent 上下文）；主上下文自行审查或凭 id 取具体会话内容。
          resolveDeferredWake({
            bus,
            taskId: deferredTaskId,
            result: {
              id: res.sessionId,
              status: "ok",
              rpcId: taskRpcId,
              sessionId: res.sessionId,
            },
          });
          return;
        }
        // PTC 式回调压缩：默认只带最终结论摘要（callbackMode=summary），
        // 完整输出在卡片（jsonl 恢复）与 dsh web UI（sessionId）可查，不进 Agent 上下文。
        const outputMode = callbackMode === "full" ? "full" : "summary";
        const payloadOutput =
          outputMode === "full"
            ? res.output
            : (res.summary?.text ?? res.output);
        resolveDeferredWake({
          bus,
          taskId: deferredTaskId,
          result: {
            id: res.sessionId,
            rpcId: taskRpcId,
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
        // 尽力带定位键：有 sessionId（提交成功后的执行失败）时 error 带 sessionId；
        // 提交失败无 sessionId 的场景带 rpcId（可为空串）。主上下文凭定位键直接取会话
        // 内容/对账，无需额外 dsh_search 查找。
        const error = { message: String(err?.message || err).slice(0, 300) };
        // 定位键优先级：rejected error 自带的 sessionId（submitTask 内已附加，session.prompt
        // 失败时 loc 为 null 也保留已创建的会话）→ loc.sessionId → taskRpcId（可为空串）。
        // 避免 session.prompt 失败（loc null）时只剩空 rpcId、已创建会话无法对账。
        const errSessionId =
          err && typeof err === "object" ? err.sessionId : undefined;
        if (errSessionId) error.sessionId = errSessionId;
        else if (loc?.sessionId) error.sessionId = loc.sessionId;
        else error.rpcId = taskRpcId;
        failDeferredWake({
          bus,
          taskId: deferredTaskId,
          error,
        });
      },
    );

    return {
      content: [
        {
          type: "text",
          text: `任务已提交给 DSH（rpcId: ${taskRpcId}），在后台执行中。进度与输出见上方卡片；完成后后台消息${modePhrase}（callbackMode=${callbackMode}，完整输出在卡片与 DSH web UI 可查）。`,
        },
      ],
      details: {
        dsh: { rpcId: taskRpcId, status: "running", cwd, wait: false },
        card: cardBase,
      },
    };
  }

  // 同步模式：等结果直接返回
  const res = await promise;
  const note =
    res.stopReason === "end_turn" ? "" : `\n\n[stopReason: ${res.stopReason}]`;
  const text = `${res.output || "（DSH 未返回文本）"}${note}`;
  return {
    content: [{ type: "text", text }],
    details: {
      dsh: {
        id: res.sessionId, // 定位键 = sessionId（与异步回调 result.id 同键，凭 id 直接取会话内容/续接）
        stopReason: res.stopReason,
        usage: res.usage,
        cwd,
        rpcId: res.rpcId,
        sessionId: res.sessionId,
        wait: true,
      },
      card: {
        ...cardBase,
        title: `DSH ${res.stopReason === "end_turn" ? "完成" : "结束"}`,
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
