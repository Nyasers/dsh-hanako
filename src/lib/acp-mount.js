// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// lib/acp-mount.js — ACP（Agent Client Protocol）进程内内部通讯通道挂载
// （feat/acp-channel，2026-09-06 用户裁定方向）
//
// 形态：宿主与 DSH 同进程（进程内 boot），在 DSH cordis ctx 上挂 @deepseek-ai/dsh-acp
// 插件，transport 用内存双工 Web Streams（TransformStream + ndJsonStream）——零端口
// 零 stdio。宿主侧用 @agentclientprotocol/sdk 的 client 连同一双工对，得到 agent 面
// 客户端（session.new/prompt/cancel 等）——指令通道内部化，HTTP /api 只服务 WebUI。
//
// 事件面不经过 ACP：继续 ctx.on 直订（dsh-events.js）——ACP 只管指令。
//
// 依赖定位（安装副本 pnpm 严格布局）：@deepseek-ai/dsh-acp 与 @agentclientprotocol/sdk
// 都不是 @deepseek-ai/dsh 的直接依赖（dsh 依赖 @deepseek-ai/dsh-acp-app，后者依赖
// dsh-acp；SDK 是 dsh-acp 的依赖）——从 dsh-acp-app 的 .pnpm 真实位置 createRequire
// 沿同层 node_modules 解析（不硬编码 hash：枚举 .pnpm/@deepseek-ai+dsh-acp-app@*，
// 取唯一匹配/首个）。
import { readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { getSingleton } from "./state.js";
import { notifyApprovalWake } from "./wake.js";
import { resolveApprovalTimeoutSec } from "./config.js";

// ACP client session/update 通知缓冲上限（CodeRabbit Major #5）：takeUpdate 无候取者时
// updateQueue 的暂存上限——超限丢最旧（进展遥测非关键，防无界累积内存增长）。
const MAX_BUFFERED_UPDATES = 128;

// toolCache 上限（CodeRabbit 第二轮 #1）：toolCallId → { name, args }（审批决策的 tool
// 上下文）——每次 tool_call 通知都存一条序列化 rawInput，web host 长活 + 工具反复调用
// 时可无界累积参数数据。设上限，超限淘汰最旧；close() 时清空（见下方 close）。
const MAX_TOOL_CACHE = 200;

// ACP 运行时依赖定位：@deepseek-ai/dsh-acp（插件本体）与 @agentclientprotocol/sdk
// 随 DSH 依赖树存在（@deepseek-ai/dsh → @deepseek-ai/dsh-acp-app → dsh-acp，SDK 是
// dsh-acp 的依赖）——宿主不新增声明（bootstrap pnpm i -P 只装 cordis/dsh，避免 pnpm
// 全局解析重排）。从 @deepseek-ai/dsh（宿主 dependencies，顶层链接）realpath 到
// .pnpm 真实位置后 createRequire 沿依赖链解析（链接路径解析不到间接依赖）。
// 宿主**不静态 import**（静态 import 在模块加载期解析，依赖未装时崩 → onload 自动装
// 不跑 = 无法闭环）：解析与动态 import 全在 mountAcp 内（惰性，boot 时执行）。
const hostRequire = createRequire(import.meta.url);

/** 读 DSH 默认模型（dsh-home/settings.yaml agent-default-model，与 tools run.js 同源），
 * 供 ACP 插件的 provider/model 配置（ACP 创建的 agent 的 initialSelection）与
 * selectModel 后的 effort 默认保持（readDefaultModel().effort——宿主 set model 会冲掉
 * DSH settings 的 reasoningEffort，需在 set model 后补 set；不支持的模型 set 失败静默
 * 降级）。读失败返回 null（调用方回退 undefined——Schema 必填失败时抛错由调用方降级）。 */
function readDefaultModel(dshHome) {
  try {
    const p = join(dshHome, "settings.yaml");
    // 行级解析（CodeRabbit 第二轮 #7）：原实现三条跨块正则
    // `agent-default-model:[\s\S]*?\n\s+(model|reasoningEffort):` 在 agent-default-model
    // 块内没有对应键时，懒匹配会跨越到下一个顶层 mapping（llm-pi-ai / agent-presets 等）
    // 误取同名字段（settings.yaml 顶层键嵌套子块同名键时）。先截 agent-default-model 块
    //（到下一个顶层键/出块）再在块内提取键——零依赖行级策略，与 lib/config.js 的
    // readDshDefaultModel 同源（settings.yaml 结构简单，不需引 YAML 解析器）。
    const lines = String(readFileSync(p, "utf8")).split(/\r?\n/);
    let inBlock = false;
    const out = {};
    for (const line of lines) {
      if (/^agent-default-model\s*:/.test(line)) {
        inBlock = true;
        continue;
      }
      if (!inBlock) continue;
      // 无缩进行 = 出块（下一个顶层键）；空行/注释行跳过（块内允许，不算出块）
      if (!/^\s/.test(line)) {
        if (line.trim() === "" || /^\s*#/.test(line)) continue;
        break;
      }
      const m = line.match(/^(\s+)([A-Za-z]+)\s*:\s*(.*)$/);
      if (!m) continue; // 块内嵌套（列表项等）跳过，继续找键
      const k = m[2];
      const v = m[3].trim();
      if (v) out[k] = v.replace(/^['"]|['"]$/g, "");
    }
    // 选择行为与旧实现一致：provider+model 必需（缺任一回退 null，调用方走 undefined）；
    // reasoningEffort 可选。值在块内截取，不会跨块误配。
    if (!out.provider || !out.model) return null;
    return {
      provider: String(out.provider).trim(),
      model: String(out.model).trim(),
      reasoningEffort: out.reasoningEffort
        ? String(out.reasoningEffort).trim()
        : undefined,
    };
  } catch {
    return null;
  }
}

/** 挂载 ACP 内部通讯通道。
 * @param ctx DSH cordis ctx（进程内 boot 的 r.ctx）
 * @param opts { pkgDir, dshHome, emitLog }
 * @returns { client, close }——client = ACP agent 面客户端（request/notify）；close =
 *   卸载（ctx.fiber.dispose 由 lifecycle 统一管，本处仅释放 client 连接）。
 * 挂载/握手失败抛错（调用方降级——WebUI 主链不依赖 ACP）。
 */
export async function mountAcp(ctx, { dshHome, emitLog }) {
  const log = (msg) => {
    try { emitLog?.("hana", "[dsh acp] " + msg); } catch { /* noop */ }
  };
  // 共享状态持有（审批应答 + client session/update 通知缓冲共用）：必须在
  // approvalAnswerer 注册/可能被调用**之前**初始化——approvalAnswerer 在审批到达时读
  // toolCache。若其声明在注册之后，ctx.on("approval/request", approvalAnswerer) 同步注册
  // 后本函数还有很多 await（动态 import、ctx.plugin、握手），事件循环可在 toolCache 声明
  //（TDZ）之前 dispatch 审批 → approvalAnswerer 读 toolCache 抛 ReferenceError。
  // 故在此前置声明（CodeRabbit Minor #3）。
  const updateQueue = []; // session/update 通知缓冲（takeUpdate 取号者为空时暂存）
  const updateWaiters = []; // 等待 update 的解析器队列（takeUpdate 无缓冲时等投递）
  const toolCache = new Map(); // toolCallId → { name, args }（审批决策的 tool 上下文）
  // 通道关闭标记（CodeRabbit 第二轮 #3）：close() 先置 closed 再关连接——closed 期间
  // takeUpdate 立即 resolve null（不再新增 waiter，防新取号者挂死在已停用通道）；迟到的
  // session/update 通知直接丢弃（不重入缓冲/toolCache）；close() 幂等（重复调用安全）。
  let closed = false;
  // ---- L4：审批应答（approval/request ctx global waterfall）----
  // DSH agent 越界/敏感工具 → ApprovalService.decide → ctx.waterfall(scopeTarget(agent),
  // 'approval/request', req, ...)——agent-scope 过滤，普通 ctx.on（无 global）因 context
  // filter 收不到（实证：宿主与 dsh-acp 的无 scope ctx.on 均静默；dsh-acp 的
  // request_permission 转发也因此从不触发）。EventOptions.global: true = 无视 context
  // filter 收所有 agent 的 scope 事件。listener 返回 ApprovalOutcome（allowed-once /
  // rejected / cancelled / unavailable）= 认领请求（不调 next）——宿主决策即审批结果，
  // 零端口（不经 ACP request_permission / HTTP respond）。
  // req: { agent, toolName, callId?, reason?, signal? }（ApprovalRequestEvent）。
  async function approvalAnswerer(req, next) {
    const g = getSingleton();
    const sessionId =
      req && req.agent && req.agent.session ? req.agent.session.id : null;
    const callId = (req && req.callId) || null;
    const cached = callId ? toolCache.get(callId) : null;
    const toolName =
      (req && req.toolName) || (cached && cached.name) || "tool";
    const approvalId = String(callId || "req-" + Date.now());
    try {
      g?.appendLog?.(
        "hana",
        `[dsh acp] 审批请求收到（session=${String(sessionId || "?").slice(0, 12)} tool=${toolName} id=${approvalId.slice(0, 24)}）`,
      );
    } catch { /* 日志失败不阻断 */ }
    const op =
      g && typeof g.ops?.get === "function" ? g.ops.get(sessionId) : null;
    if (!op || !Array.isArray(op.activeApprovals)) {
      // 无活动任务/协调条目缺失（任务已终态/未知会话）：认领并默认拒绝（安全）
      try {
        g?.appendLog?.(
          "hana",
          `[dsh acp] 审批无活动任务（op=${op ? "有但无表" : "无"}）——默认拒绝`,
        );
      } catch { /* 日志失败不阻断 */ }
      return "rejected";
    }
    let settle = null;
    const pending = new Promise((resolve) => {
      settle = resolve;
    });
    // ---- 单飞收尾守卫（CodeRabbit Minor #4）----
    // onAbort 与超时（及宿主应答 _respond）是三条独立 settle 路径。原实现无共享 guard：
    // onAbort 标记 cancelled 后，超时回调仍会写 status="answered"/outcome="rejected"/
    // answeredAt（_respond 空操作但状态字段被后到者污染），且 onAbort 不清超时计时器。
    // settled 标志 = 首个 settle 写终态 + resolve 挂起 Promise + 清除超时计时器；后续
    // 路径只 no-op——保留先到者设的状态/时间戳（onAbort 的 cancelled 不会被覆盖）。
    let settled = false;
    let timeoutTimer = null; // 超时拒绝计时器（settle/onAbort 时 clearTimeout，防再触发污染）
    const commitSettle = (statusOutcome, resolvedValue) => {
      if (settled) return;
      settled = true;
      approval.status = "answered";
      approval.outcome = statusOutcome;
      approval.answeredAt = new Date().toISOString();
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      const s = settle;
      settle = null;
      if (s) {
        try {
          s(resolvedValue);
        } catch { /* 已 settle 忽略 */ }
      }
    };
    const approval = {
      approvalId,
      eventId: approvalId,
      sessionId,
      toolName,
      callId,
      reason: (req && req.reason) || null,
      args: cached ? cached.args : null,
      status: "pending",
      requestedAt: new Date().toISOString(),
      _respond: (outcomeStr) => {
        // 宿主应答（dsh_approve / interlude 转发）：rejected → rejected，其余 → allowed-once
        //（与旧 mapping 一致）。经 commitSettle：已 settle（abort/超时先到）则 no-op。
        const mapped =
          outcomeStr === "rejected" ? "rejected" : "allowed-once";
        commitSettle(mapped, mapped);
      },
    };
    op.activeApprovals.push(approval);
    try {
      g?.appendLog?.(
        "hana",
        `[dsh acp] 审批已挂起（id=${approvalId.slice(0, 24)}）——等宿主应答`,
      );
    } catch { /* 日志失败不阻断 */ }
    // 审批请求取消（会话 abort/cancel）→ 返回 cancelled。
    // onAbort 写 cancelled 终态并清超时计时器（commitSettle 内部）：后到的超时/应答
    // 只 no-op，不再覆盖 cancelled 状态与时间戳。
    const signal = req && req.signal;
    const onAbort = () => {
      // 审批请求取消（会话 abort/cancel）→ 返回 cancelled。resolve 值 = 宿主回给
      // ApprovalService 的 ApprovalOutcome：必须完整透传 cancelled——不得沿用旧的
      // allowed-once（否则 abort 被当作一次授权放行，工具可能随后续重试被执行）。
      // outcome→allowed-once/rejected 的收窄映射只发生在宿主决策入口 _respond；
      // 超时自动拒绝路径已直传 rejected（CodeRabbit 第二轮 #2）。
      commitSettle("cancelled", "cancelled");
    };
    if (signal) {
      if (signal.aborted) onAbort(); // signal 已 aborted：立即 settle + 清计时器
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    // 超时自动拒绝（approvalTimeoutSec 秒无人应答；0/不可读 = 禁用）
    try {
      const ats = resolveApprovalTimeoutSec({ dataDir: g?.dataDir });
      if (ats > 0 && !settled) {
        // signal 已同步 aborted（上方 onAbort 已 settle）→ 不再起计时器
        timeoutTimer = setTimeout(() => {
          // 已 settle（onAbort/应答先到）→ no-op（守卫处理）；仍 pending → rejected
          commitSettle("rejected", "rejected");
        }, ats * 1000);
        approval._cancelTimer = () => {
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
        };
      }
    } catch { /* 超时表不可用禁用 */ }
    // 宿主 Agent 审批通知（interlude 插话——bus/sessionPath/rpcId/task 经 op 条目
    // 由 run.js createOpEntry 提交上下文补齐；通知失败不阻断——审批仍可经 dsh_approve）
    try {
      await notifyApprovalWake({
        bus: g && g.bus,
        sessionPath: op.sessionPath,
        rpcId: op.rpcId || "",
        approval,
        task: op.task || "",
      });
    } catch { /* 通知失败不阻断 */ }
    return pending;
  }
  // 注册 global waterfall listener（无视 agent-scope filter——收所有审批）；返回 outcome
  // = 认领（不调 next——审批服务 decide 拿宿主决策）。
  try {
    ctx.on("approval/request", approvalAnswerer, { global: true, prepend: true });
    log("审批应答已挂（approval/request global+prepend listener）");
  } catch (e) {
    log("审批应答挂载失败：" + ((e && e.message) || e));
  }
  // 诊断（审批链路定位）：internal/dispatch 探测——waterfall 分发面实证。events.ts
  // dispatch 时 emit('internal/dispatch', mode, name, args, thisArg)——收 log 确认
  // approval/request 的 waterfall 是否真的 dispatch（policy 短路则完全不进）。
  // 注：已验证完成（12:58 审批全链通）——此探测仅保留供未来链路回归参考。
  try {
    ctx.on("internal/dispatch", (mode, name) => {
      if (name !== "approval/request") return;
      try {
        log("internal/dispatch 探测：approval/request 已分发（mode=" + mode + "）");
      } catch { /* 日志失败不阻断 */ }
    });
  } catch { /* 探测订阅失败忽略 */ }

  // 依赖沿 DSH 树解析（dsh realpath → dsh-acp-app → dsh-acp + SDK——见文件头注释），
  // 与 DSH 运行时同物理包实例（非 bundle 内联）；动态加载不阻塞模块加载（闭环）。
  const dshReal = realpathSync(
    dirname(hostRequire.resolve("@deepseek-ai/dsh/package.json")),
  );
  const dshRequire = createRequire(join(dshReal, "package.json"));
  const acpAppRequire = createRequire(dshRequire.resolve("@deepseek-ai/dsh-acp-app"));
  const acpPath = acpAppRequire.resolve("@deepseek-ai/dsh-acp");
  // SDK 是 dsh-acp 的依赖（不在 dsh-acp-app 层）——从 dsh-acp 解析
  const acpRequire = createRequire(acpPath);
  const acpMod = await import(/* webpackIgnore: true */ pathToFileURL(acpPath).href);
  const sdkMod = await import(/* webpackIgnore: true */ pathToFileURL(
    acpRequire.resolve("@agentclientprotocol/sdk"),
  ).href);
  const acp = acpMod.default ?? acpMod;
  const sdk = sdkMod.default ?? sdkMod;
  const ndJsonStream = sdk.ndJsonStream;
  const createAcpClientApp = sdk.client ?? sdk.ClientApp?.create;
  const methods = sdk.methods;
  if (typeof ndJsonStream !== "function" || typeof createAcpClientApp !== "function") {
    throw new Error("ACP SDK 缺 ndJsonStream/client（版本不兼容）");
  }
  // 模型配置：优先显式 provider/model 缺省读 dsh 默认（ACP agent initialSelection）
  const dm = readDefaultModel(dshHome);
  const acpConfig = {
    provider: dm?.provider,
    model: dm?.model,
  };
  // 默认 effort（settings agent-default-model.reasoningEffort）：宿主 selectModel
  // set model 会冲掉 DSH settings 的 effort（set model 无 effort → resolveCallConfig
  // 落 model 默认）——存宿主单例供 protocol acpSelect 在 set model 后补 set effort
  //（任务显式传优先；不支持的模型 set 失败静默降级——见 acpSelect catch）。
  try {
    const g0 = getSingleton();
    if (g0) g0.acpDefaultEffort = dm?.reasoningEffort || null;
  } catch { /* 单例不可写忽略 */ }
  // 内存双工对（零端口零 stdio）：server 侧写 a2c / 读 c2a；client 侧相反
  const a2c = new TransformStream();
  const c2a = new TransformStream();
  const agentStream = ndJsonStream(a2c.writable, c2a.readable);
  const clientStream = ndJsonStream(c2a.writable, a2c.readable);
  // 挂 ACP 插件（注入面与 web bundle 共享 services：agents/llm/sessionPersistence/sessions）
  await ctx.plugin({
    name: "dshana-acp",
    inject: [...(acp.inject || [])],
    apply: (inner) => acp.apply(inner, { ...acpConfig, stream: agentStream }),
  });
  log("插件已挂载（provider=" + (acpConfig.provider || "?") + " model=" + (acpConfig.model || "?") + "）");
  // 宿主侧 client：注册 session/update 通知缓冲（指令进展事件）与审批反向应答
  //（审批应答 = ctx approval/request global waterfall，见 approvalAnswerer）。
  // update 同时缓存 tool_call 的 title/rawInput（审批决策信息源——request_permission
  // 请求只带 toolCallId，name/args 从 tool_call update 补）。updateQueue/updateWaiters/
  // toolCache 已在上方前置声明（防审批在 TDZ 期读 toolCache，见 CodeRabbit Minor #3）。
  const clientApp = createAcpClientApp({ name: "dsh-hanako-host" })
    .onNotification(methods.client.session.update, ({ params }) => {
      // 通道已关闭（close 后迟到的通知）：直接丢弃，不写 toolCache/updateQueue
      if (closed) return Promise.resolve();
      const update = params && params.update;
      if (update && typeof update === "object" && update.sessionUpdate === "tool_call") {
        if (update.toolCallId) {
          let args = null;
          if (update.rawInput !== undefined) {
            try {
              args =
                typeof update.rawInput === "string"
                  ? update.rawInput
                  : JSON.stringify(update.rawInput);
            } catch {
              args = String(update.rawInput ?? "");
            }
          }
          toolCache.set(update.toolCallId, {
            name: typeof update.title === "string" ? update.title : "tool",
            args,
          });
          // 有界缓存（CodeRabbit 第二轮 #1）：超上限淘汰最旧（Map 插入序最早 = 最旧）
          if (toolCache.size > MAX_TOOL_CACHE) {
            const oldestKey = toolCache.keys().next().value;
            if (oldestKey !== undefined) toolCache.delete(oldestKey);
          }
        }
      }
      if (updateWaiters.length) updateWaiters.shift()(params);
      else {
        // 无候取者时的无界暂存防护（CodeRabbit Major #5）：takeUpdate 长期无人调用时
        // updateQueue 原会无限累积（session/update 每次进展/工具/checkpoint 都触发）。
        // 有限上限 MAX_BUFFERED_UPDATES：超限丢最旧一条（保留近期进展取号方向，也让
        // 队列有界）。updateWaiters.shift() 的即时投递路径不走此缓存、不受限。
        if (updateQueue.length >= MAX_BUFFERED_UPDATES) updateQueue.shift();
        updateQueue.push(params);
      }
      return Promise.resolve();
    });
  const connection = clientApp.connect(clientStream);
  const client = connection.agent;
  // initialize 握手验证（协议面通 = 挂载成功门槛；失败抛错由调用方降级）。
  // 参数需 protocolVersion + clientCapabilities（SDK 方法校验，缺则 Invalid params）
  const init = await client.request(methods.agent.initialize, {
    protocolVersion: sdk.PROTOCOL_VERSION ?? 1,
    clientCapabilities: {},
  });
  log(
    "握手成功（agent=" + ((init && init.agentInfo && init.agentInfo.name) || "?") +
    " v" + ((init && init.agentInfo && init.agentInfo.version) || "?") +
    " proto=" + ((init && init.protocolVersion) || "?") + "）",
  );
  return {
    client,
    sdk,
    methods,
    takeUpdate: () => {
      // 已关闭：立即 resolve null——不新增 waiter（防 close 后新取号者挂死）；遗留
      // waiter 由 close() 唤醒置空（既有 waiter-draining 行为保留）。
      if (closed) return Promise.resolve(null);
      return updateQueue.length
        ? Promise.resolve(updateQueue.shift())
        : new Promise((r) => updateWaiters.push(r));
    },
    close: () => {
      // 幂等：closed 已置位直接返回（重复 close 安全，不再重复关连接/清空/唤醒）。
      // 先置 closed 再关连接：closed 先行使新 takeUpdate / 迟到通知立即短路。
      if (closed) return;
      closed = true;
      try { connection.close?.(); } catch { /* noop */ }
      // 卸载/关闭：废弃累积 update 缓冲与等待者（防 close 后残留无界暂存/挂死 waiter）。
      // close 语义 = 通道停用不再取用——遗留缓冲可被 GC（CodeRabbit Major #5）。
      // toolCache 同步清空（CodeRabbit 第二轮 #1）：审批决策上下文随通道停用失效，
      // 释放序列化 rawInput 引用（不再挂起长活 web host 的审批上下文）。
      toolCache.clear();
      updateQueue.length = 0;
      const ws = updateWaiters.splice(0);
      for (const r of ws) {
        try { r(null); } catch { /* 忽略 */ }
      }
    },
  };
}
