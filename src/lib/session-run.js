// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/session-run.js — dsh_session create/send 提交链（App v2 步骤 3）
//
// 职责：execute（工具执行，App 主进程）内完成：
//   ① ctx.tasks.create({ callToken, label, metadata }) —— callToken 只在这里消费，
//      绝不落盘/落日志（迁移指南 §5 硬约束）；
//   ② ensureManagedRuntime（未起则启动到 ready；单例，一个 runtime 服务多会话）；
//   ③ 经 loopback HTTP Unary RPC（决策 A：复用 v1 信封协议，见 lib/rpc-envelope.js）
//      把 session.create/list/selectModel/prompt 提交给受管 runtime 内的 DSH web 服务；
//   ④ 写 <dataDir>/dshana/taskmaps/<sessionId>.json 映射（决策 C，见 lib/task-map.js）
//      ——受管 runtime 的 task-bridge（src/runtime/task-bridge.js）凭它把 DSH 事件回投
//      ctx.tasks.update/complete/fail；
//   ⑤ 同 DSH session 串行化（决策 D，lib/session-serialize.js）：**锁持有到任务终态**
//      （v1 同款：队列槽位在 create/send 提交到 DSH turn 结束期间占用），不同 session
//      互不干扰——否则同一 session 的两个任务会互相消费对方的终态事件。
//
// 提交是 fire-and-forget（v1 语义）：本模块 submitDshTask 返回 { promise, ready }——
// ready 在 prompt 被 DSH 接受（{ accepted:true }）后 resolve 定位键，execute 随即返回；
// promise 在后台继续等到 Hana task 终态（child task-bridge complete/fail 后，宿主投递
// 到来源会话，指南 §5）并释放串行化锁。本模块不把 DSH turn 的最终文本带回 execute——
// 内容读取统一走 dsh_session action=get（v1 minimal 回调语义）。
//
// 与 v1 tools/subtool/run.js 的对应：v1 task:register/deferred 唤醒协议退役，v2 等价物
// = Hana ctx.tasks + 宿主自动投递；v1 g.ops/审批/取消/超时执行是步骤 4 内容（本步不设
// DSH 执行超时/取消——需要 session.cancel 链，见 DESIGN「遗留」；模型侧超时由宿主
// models.stream 5 分钟/请求兜底）。
import { join } from "node:path";
import { appCtx, appDataDir } from "./app-runtime.js";
import { ensureManagedRuntime } from "./managed-runtime.js";
import { nextRpcId } from "./rpc-envelope.js";
import { writeTaskMap, removeTaskMap, isValidSessionId, pruneTaskMaps } from "./task-map.js";
import { withSessionTurn, enterSessionTurn } from "./session-serialize.js";
import { readDshDefaultModel } from "./config.js";
import { serviceBase, serviceFetch } from "./service-base.js";
import { rpcCallWithFetch } from "./dsh-rpc.js";
import { resolveTaskTimeoutSec, resolveApprovalTimeoutMs, cancelSessionWork } from "./cancel-chain.js";

// ---- 归一/校验（纯函数面，便于单测）----
export function normalizeCreateSend({ action, input } = {}) {
  const act = action === "send" ? "send" : action === "create" ? "create" : "";
  if (!act) throw new Error("session-run: action 必须是 create / send");
  const taskText = String((input && input.task) || "").trim();
  if (!taskText) {
    throw new Error((act === "create" ? "create" : "send") + " 必须传 task（任务描述/消息文本）");
  }
  const cwd = String((input && input.cwd) || "").trim();
  const sessionId = String((input && input.sessionId) || "").trim();
  if (act === "create") {
    if (sessionId) throw new Error("create 不允许传 sessionId（新建会话；续会话用 send）");
    if (!cwd) throw new Error("create 必须传 cwd（沙箱工作目录，defaultCwd 配置已删除无回退）");
  } else {
    if (!sessionId) throw new Error("send 必须传 sessionId（续已有会话；形如 session-<uuid>）");
    if (!isValidSessionId(sessionId)) throw new Error("sessionId 格式非法（应为 session-<UUID>）：" + sessionId);
  }
  // agent 预设：code 已退役 → ptc（与 v1 语义一致）；空值不传（DSH 默认）
  let preset = String((input && input.agentPreset) || "").trim() || null;
  if (preset === "code") preset = "ptc";
  // 推理强度/模型：只取工具显式值（off/high/max 词汇不变）；空值不传（DSH 默认处理）
  const effort = String((input && input.reasoningEffort) || "").trim() || null;
  const provider = String((input && input.provider) || "").trim() || null;
  const model = String((input && input.model) || "").trim() || null;
  return {
    action: act,
    taskText,
    cwd,
    sessionId,
    agentPreset: preset,
    reasoningEffort: effort,
    provider,
    model,
    timeoutSec: Number(input && input.timeout) > 0 ? Number(input.timeout) : null,
  };
}

/**
 * selectModel 载荷组装（纯函数）：显式传了 provider/model/effort 任一时需要；
 * 只传其一/只传 effort 时另一侧从 DSH 默认模型（settings.yaml agent-default-model）补齐；
 * 补不出且确需选择时报错（沿用 v1 文案语义）。全不传返回 null（不 selectModel）。
 */
export function resolveModelSelection(parsed, dshHome) {
  const { provider: p, model: m, reasoningEffort: e } = parsed || {};
  if (!p && !m && !e) return null;
  let provider = p;
  let model = m;
  if (!provider || !model) {
    const dm = readDshDefaultModel(dshHome);
    provider = provider || (dm && dm.provider) || "";
    model = model || (dm && dm.model) || "";
  }
  if (!provider || !model) {
    throw new Error(
      "需要 provider/model：请显式传 provider/model，或先在 DSH models 页设置默认模型（settings.yaml agent-default-model）",
    );
  }
  return { provider, model, ...(e ? { reasoningEffort: e } : {}) };
}

// ---- loopback HTTP RPC（ctx.network.fetch 门；manifest network 声明放行 127.0.0.1）----
// 实现收敛到 lib/dsh-rpc.js rpcCallWithFetch（cancel-chain 等步骤 4a 模块共用同一封装）。
async function rpcCall(ctx, base, opts) {
  if (!ctx || !ctx.network || typeof ctx.network.fetch !== "function") {
    throw new Error("session-run: 宿主 ctx.network.fetch 不可用（缺 network 授权）");
  }
  return rpcCallWithFetch(serviceFetch((url, init) => ctx.network.fetch(url, init)), base, opts);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function failTask(ctx, taskId, message) {
  try {
    if (ctx && ctx.tasks && typeof ctx.tasks.fail === "function") {
      await ctx.tasks.fail(taskId, String(message || "dsh 任务失败").slice(0, 3000));
    }
  } catch {
    /* fail 失败不阻断（终态尽力而为） */
  }
}

/** 后台等到 Hana task 终态（complete/failed/canceled/aborted；轮询 get，无 SSE 复杂度）。 */
async function waitTaskTerminal(ctx, taskId, log, pollMs = 1200) {
  for (;;) {
    let rec = null;
    try {
      rec = await ctx.tasks.get(taskId);
    } catch (e) {
      log?.warn?.("[dsh-session] tasks.get 查询失败：" + ((e && e.message) || e));
    }
    const st = rec && rec.status;
    if (st && ["completed", "failed", "canceled", "aborted"].includes(String(st))) {
      return rec;
    }
    await sleep(pollMs);
  }
}

/**
 * 带执行超时的终态等待（步骤 4a）：timeoutSec（秒）内未终态 → 走 cancel 链（指南 §9：
 * 执行超时 = 取消，不是只标失败）；超时后仍继续等到任务终态（cancel 已确认/升级后宿主
 * 终态到达）。timeoutSec <= 0 时等价 waitTaskTerminal（无限等）。超时计时 unref（不阻断
 * App 进程退出）。
 */
async function waitTaskTerminalWithTimeout(ctx, taskId, sessionId, timeoutSec, log, pollMs = 1200) {
  const ms = Number(timeoutSec) > 0 ? Math.round(Number(timeoutSec)) * 1000 : 0;
  let fired = false;
  let timer = null;
  const fire = async () => {
    if (fired) return;
    fired = true;
    logLine(log, "[dsh-session] 任务执行超时（" + Math.round(ms / 1000) + "s）——走 cancel 链（session=" + sessionId + "）");
    try {
      await cancelSessionWork({ sessionId, reason: "timeout", log });
    } catch (e) {
      log?.warn?.("[dsh-session] 超时 cancel 链失败：" + ((e && e.message) || e));
    }
  };
  if (ms > 0) {
    timer = setTimeout(() => { void fire(); }, ms);
    if (typeof timer.unref === "function") timer.unref();
  }
  try {
    return await waitTaskTerminal(ctx, taskId, log, pollMs);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- 会话建立/续用 ----
// create：session.create { cwd, agentPreset? } → { sessionId }
// send：目标会话可能 (a) 持久非活跃（runtime 重启后）→ session.list 有它（带 cwd），走
// session.create resume（{ sessionId, cwd }）；(b) 活跃/空闲在 DSH agent Map（list 不含）
// → 直接 prompt（无 session.create）；list 也不含 = 会话不存在（prompt admission 会以
// session/not-found 报错）。
async function establishSession(ctx, base, parsed, log) {
  if (parsed.action === "create") {
    const createPayload = {
      cwd: parsed.cwd,
      ...(parsed.agentPreset ? { agentPreset: parsed.agentPreset } : {}),
    };
    const value = await rpcCall(ctx, base, { method: "session/create", payload: createPayload });
    const sessionId = value && value.sessionId;
    if (!sessionId) throw new Error("session.create 未返回 sessionId：" + JSON.stringify(value || null));
    return { sessionId, resumed: false, effectiveCwd: parsed.cwd };
  }
  let listed = null;
  try {
    const listValue = await rpcCall(ctx, base, { method: "session/list", payload: {} });
    const items = (listValue && Array.isArray(listValue.items) && listValue.items) || [];
    listed = items.find((it) => it && it.sessionId === parsed.sessionId) || null;
  } catch (e) {
    // list 失败不阻断（活跃 Map 会话路径照常）；回落直接 prompt
    log?.warn?.("[dsh-session] session.list 查询失败，回落直接 prompt：" + ((e && e.message) || e));
  }
  if (listed && typeof listed.cwd === "string" && listed.cwd) {
    await rpcCall(ctx, base, {
      method: "session/create",
      payload: {
        sessionId: parsed.sessionId,
        cwd: listed.cwd,
        ...(parsed.agentPreset ? { agentPreset: parsed.agentPreset } : {}),
      },
    });
    return { sessionId: parsed.sessionId, resumed: true, effectiveCwd: listed.cwd };
  }
  return { sessionId: parsed.sessionId, resumed: false, effectiveCwd: parsed.cwd || null };
}

function logLine(log, msg) {
  try {
    if (log && typeof log.info === "function") log.info(msg);
  } catch {
    /* 日志失败不阻断 */
  }
}

/**
 * create/send 提交入口（tools/session.js 调用）。返回 { promise, ready }：
 *   ready  —— prompt 被 DSH 接受后 resolve loc { action, sessionId, rpcId, taskId, cwd }；
 *             提交阶段失败（runtime 起不来/会话建立失败/selectModel 失败/prompt 拒绝）
 *             时 reject（任务已 fail 标记，错误直接抛给 execute）。
 *   promise —— 后台继续等到 Hana task 终态并释放同会话串行化锁（fire-and-forget；
 *             终态结果由宿主投递到来源会话）。调用方 catch 记录即可，不 await。
 */
export function submitDshTask({ action, input, callToken, log }) {
  const parsed = normalizeCreateSend({ action, input });
  const ctx = appCtx();
  const dataDir = appDataDir();
  if (!ctx || !dataDir) {
    throw new Error("App 运行包未初始化（apply 未注入宿主 ctx/dataDir）");
  }
  if (!ctx.tasks || typeof ctx.tasks.create !== "function") {
    throw new Error("宿主 ctx.tasks 不可用（缺 app/tasks.manage 能力授予）");
  }
  const token = String(callToken || "").trim();
  if (!token) {
    throw new Error(
      "create/send 需要宿主工具调用 callToken（任务绑定来源会话）；请在模型工具调用路径下执行本工具（context.callToken 缺失）",
    );
  }

  let resolveReady = null;
  let rejectReady = null;
  const ready = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let releaseNewSessionTurn = null; // create：会话槽位（占用到终态）
  const taskLabel = (parsed.action === "send" ? "DSH 续会话" : "DSH 新任务") + "：" + parsed.taskText.slice(0, 30);

  const runTask = async () => {
    let taskId = null;
    let sessionId = null;
    try {
      // ① Hana task 创建（callToken 专用一次；taskId 是稳定句柄）
      let task;
      try {
        task = await ctx.tasks.create({
          callToken: token,
          label: taskLabel,
          metadata: {
            dsh: {
              action: parsed.action,
              cwd: parsed.cwd || undefined,
              sessionId: parsed.sessionId || undefined,
              task: parsed.taskText.slice(0, 200),
              timeoutSec: parsed.timeoutSec || undefined,
            },
          },
        });
      } catch (e) {
        throw new Error("Hana task 创建失败：" + ((e && e.message) || e));
      }
      taskId = task && task.taskId;
      if (!taskId) throw new Error("ctx.tasks.create 未返回 taskId（宿主契约异常）");
      try { pruneTaskMaps(dataDir); } catch { /* 忽略 */ }

      // ② 受管 runtime 就绪（单例；首启含依赖 ensure）
      try {
        const rt = await ensureManagedRuntime({ taskId });
        logLine(log, "[dsh-session] runtime 就绪 runtimeId=" + (rt && rt.runtimeId) + "（task=" + taskId + "）");
      } catch (e) {
        await failTask(ctx, taskId, "DSH 受管运行时启动失败：" + ((e && e.message) || e));
        throw e;
      }
      const base = serviceBase();

      // ③ 会话建立（create 新建 / send 沿用）
      let established;
      try {
        established = await establishSession(ctx, base, parsed, log);
      } catch (e) {
        await failTask(ctx, taskId, "DSH 会话建立失败：" + ((e && e.message) || e));
        throw e;
      }
      sessionId = established.sessionId;
      // create：会话已知后立即占住队列槽位（到任务终态释放；防 create 后立即 send 重叠）
      if (parsed.action === "create") releaseNewSessionTurn = enterSessionTurn(sessionId);

      // ④ 显式 provider/model/effort → selectModel（model-unavailable 降级不带 effort 重试）
      const selection = resolveModelSelection(parsed, join(dataDir, "dsh-home"));
      if (selection) {
        try {
          await rpcCall(ctx, base, { method: "session/selectModel", payload: { sessionId, ...selection } });
        } catch (e) {
          if (
            parsed.reasoningEffort &&
            String((e && e.message) || "").includes("model-unavailable")
          ) {
            await rpcCall(ctx, base, {
              method: "session/selectModel",
              payload: { sessionId, provider: selection.provider, model: selection.model },
            });
          } else {
            throw e;
          }
        }
      }
      // ⑤ 写映射（先于 prompt；rpcId = prompt requestId = jsonl data.source.rpcId 关联键）
      //    步骤 4a：映射快照下传执行超时与审批超时（受管 runtime approval-bridge 读不到
      //    App settings，经映射文件取 approvalTimeoutMs；0 = 宿主不自动拒绝）
      const rpcId = nextRpcId();
      const timeoutSec = resolveTaskTimeoutSec(parsed.timeoutSec);
      const approvalTimeoutMs = resolveApprovalTimeoutMs();
      writeTaskMap(dataDir, {
        taskId,
        dshSessionId: sessionId,
        action: parsed.action,
        rpcId,
        ...(parsed.action === "create" || parsed.action === "send" ? { task: parsed.taskText.slice(0, 500) } : {}),
        timeoutSec,
        approvalTimeoutMs,
      });
      // ⑥ prompt（fire：{ accepted:true } 立即返回）
      await rpcCall(ctx, base, {
        method: "session/prompt",
        rpcId,
        payload: { sessionId, mode: "queue", content: [{ type: "text", text: parsed.taskText }] },
      });
      logLine(log, "[dsh-session] prompt 已提交（" + parsed.action + "）session=" + sessionId + " rpcId=" + rpcId);
      // ready 后 execute 可返回；本后台继续等 task 终态（释放串行化锁）
      const loc = {
        action: parsed.action,
        sessionId,
        rpcId,
        taskId,
        cwd: established.effectiveCwd || parsed.cwd || null,
      };
      resolveReady(loc);
      // 后台等到终态（child task-bridge complete/fail/canceled → 宿主投递来源会话）。
      // 步骤 4a 执行超时：超时走 cancel 链（不是只 fail task——指南 §9：超时/撤销不默认
      // 批准、不给假成功）；超时确认也复用取消确认窗口（DSH 未确认时升级宿主 cancel）。
      const rec = await waitTaskTerminalWithTimeout(ctx, taskId, sessionId, timeoutSec, log);
      logLine(log, "[dsh-session] task 终态 " + ((rec && rec.status) || "?") + "（session=" + sessionId + "）");
      return loc;
    } catch (e) {
      // 提交阶段失败：删映射（若有 sessionId）+ 任务 fail（已建时）+ ready reject
      if (sessionId) {
        try { removeTaskMap(dataDir, sessionId); } catch { /* 忽略 */ }
      }
      if (taskId) {
        const msg = "DSH 任务提交失败（" + parsed.action + "）：" + ((e && e.message) || e);
        await failTask(ctx, taskId, msg);
        const err = new Error(msg);
        if (sessionId) err.sessionId = sessionId;
        rejectReady(err);
      } else {
        rejectReady(e);
      }
      throw e;
    } finally {
      if (releaseNewSessionTurn) {
        try { releaseNewSessionTurn(); } catch { /* 忽略 */ }
        releaseNewSessionTurn = null;
      }
    }
  };

  const promise =
    parsed.action === "send"
      ? withSessionTurn(parsed.sessionId, runTask) // 同会话 send 串行（决策 D）
      : runTask();
  // 后台 promise 兜底：ready reject 已同步抛给调用方；promise 自身拒绝只记日志
  promise.catch((e) => {
    try {
      logLine(log, "[dsh-session] 后台任务异常：" + ((e && e.message) || e));
    } catch { /* 忽略 */ }
  });
  return { promise, ready };
}
