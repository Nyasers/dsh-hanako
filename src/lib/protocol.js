// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/protocol.js — dsh web /api 网关协议层共用模块（lib 提取）
// 从 tools/dsh-run.js 剥离的协议/纯函数：Unary RPC（ACP 优先，HTTP 兑底）、事件流
// （ctx 直订 + 总线 events 兑底）、文本提取。
//
// 归类说明（feat/acp-channel，2026-09-06）：宿主↔DSH 通讯两条通道——
//   指令 = ACP 进程内直连（Agent Client Protocol：宿主与 DSH 同进程，boot 时挂
//   @deepseek-ai/dsh-acp 插件 + 内存双工 Web Streams，宿主侧 client 单例挂 web.acp；
//   session.create/new/resume 与 prompt 走 ACP——官方 JSON-RPC 面，零端口零 stdio；
//   ctx 不可用/ACP 未挂载时兑底 HTTP RPC）；
//   事件 = cordis ctx.on 直订（DSH Host 事件源头，见 dsh-events.js——ACP 只管指令，
//   事件仍 ctx 直订，与 ACP 插件的 ctx 订阅并存 fan-out）。
// callUnaryBus 为兼容名（调用方 tools/* 不变）。respond（审批应答）走 respondDirect
// （client-response 信封直发 /api/respond，低频面暂留 HTTP）；selectModel/cancel/list
// 同留 HTTP（同 DSH 会话 gateway 层操作与 ACP 兼容）。
//
// 事件流 openMux：进程内 boot 下宿主与 DSH 同 ctx，ctx.on 直订优先（订阅成功即就绪）；
// ctx 不可用（boot 边缘）回退总线 events（WS 总线退役前兑底保留）。
//
// textFromChunk / textFromMessageBlocks 是事件帧文本提取面（assistant/chunk、
// assistant/message 载荷）。消费方：tools/dsh-run.js submitTask + tools/dsh-approve.js
// / dsh-session.js（get 模式）。routes/card.js 另有一份独立 openMux（不 import 本模块）。
import { getSingleton } from "./state.js";
import { subscribeDshCtxEmitEvents } from "./dsh-events.js";

// ---- HTTP RPC 客户端（dsh web /api 网关，fetch 载波）----
// Unary：POST /api/<method>，body = { type:"client-request", rpcId, method, payload }
// 响应 ServerResponse：rpcId 回显 + result.ok/value 或 result.ok=false + error。
function nextRpcId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const HTTP_RPC_TIMEOUT_MS = 60000; // HTTP RPC 默认超时（响应丢失兜底，防挂死）

// RPC fetch 超时：无 caller signal 时用 HTTP_RPC_TIMEOUT_MS；有则 AbortSignal.any 合并
function rpcTimeoutSignal(signal) {
  const t = AbortSignal.timeout(HTTP_RPC_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, t]) : t;
}

async function callUnary(base, method, payload, signal, meta) {
  const rpcId =
    (meta && typeof meta === "object" && meta.rpcId) || nextRpcId();
  // meta.rpcId 回传：rpcId 由宿主生成（client-request 信封），dsh 侧以此写 jsonl
  // user/message 的 data.source.rpcId——生成即有效，提前设置使失败/拒绝路径也能拿到
  //（成功路径同值），供调用方在提交失败时保留 rpcId 关联（sessionId+rpcId 定位轮次）。
  if (meta && typeof meta === "object") meta.rpcId = rpcId;
  const res = await fetch(`${base}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
    signal: rpcTimeoutSignal(signal),
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
  return full.result.value;
}

// 指令 base 来源：web host 单例（调用方通常已 ensureWebHost / hostBase 校验就绪）
function rpcBusBase(g) {
  const web = g?.web;
  if (web?.ready && web.port) return "http://127.0.0.1:" + web.port;
  throw new Error("DSH web host 未就绪（callUnaryBus 降级路径）");
}

// Unary RPC 指令面统一入口（feat/acp-channel：ACP 优先，HTTP 信封兑底）——
// session.create（新建/resume）与 prompt 走 ACP 内部通道（web.acp.client）；其余方法
// 走 HTTP /api（信封翻译：点号 → 斜杠 endpoint + session/* 的 args 信封
// request/_request 包装 + requestId 注入——直连缺这层会 404 与 gateway 校验失败）。
async function callUnaryBus(method, payload, signal, meta) {
  const base = rpcBusBase(getSingleton());
  if (method === "respond") {
    return respondDirect(base, payload, signal);
  }
  const reqId = nextRpcId();
  if (meta && typeof meta === "object") meta.rpcId = reqId;
  const endpoint = method.includes(".") ? method.replace(/\./g, "/") : method;
  const isSession =
    method.startsWith("session.") || method.startsWith("session/");
  const isSessionList =
    method === "session.list" || method === "session/list";
  // gateway 信封（HTTP 兑底路径）：payload 必须恰含一个 plain-object args 字段
  //（{ args: <Remote payload> }）——session/* 的 Remote payload 按 descriptor 参数名
  // 包 request/_request（session.list 用 _request）并注入 requestId（jsonl 定位键）；
  // 非 session 方法裸 payload 透传（respond 已走 respondDirect 分支）。
  const inner = isSession
    ? {
        [isSessionList ? "_request" : "request"]: {
          ...(payload || {}),
          requestId: reqId,
        },
      }
    : payload;
  const payload2 = { args: inner };
  // ACP 内部通道优先（feat/acp-channel，端口只剩 UI 消费）：web.acp.client 就绪时
  // session 指令面全部走 ACP（进程内 JSON-RPC，零端口）：create（new/resume）/
  // prompt（fire）/ list（run.js resume 查 cwd）/ selectModel（set_config_option）/ cancel
  //（notification）。HTTP /api 仅剩 respond（审批应答——L4 反向 request 未接前）兑底
  // 与 WebUI 数据面消费。
  const acp = acpClient();
  if (acp) {
    if (method === "session.create" || method === "session/create") {
      return await acpCreate(acp, method, payload, signal);
    }
    if (method === "session.prompt" || method === "session/prompt") {
      return await acpPrompt(acp, method, payload, signal);
    }
    if (method === "session.list" || method === "session/list") {
      return await acpList(acp, method, payload, signal);
    }
    if (method === "session.selectModel" || method === "session/selectModel") {
      return await acpSelect(acp, method, payload, signal);
    }
    if (method === "session.cancel" || method === "session/cancel") {
      return await acpCancel(acp, method, payload, signal);
    }
  }
  return callUnary(base, endpoint, payload2, signal, meta);
}

// 取 ACP client 单例（boot 挂载成功才有；挂载失败/未 boot 返回 null → HTTP 兑底）
function acpClient() {
  try {
    const acp = getSingleton()?.web?.acp;
    return acp && acp.client && typeof acp.client.request === "function" ? acp : null;
  } catch {
    return null;
  }
}

// ACP session.create（新建/续会话）：newSession/resumeSession。ACP 返回
// { sessionId, configOptions }——映射回原接口的 { sessionId }（调用方再取字段）。
// agentPreset 无 ACP 对应字段（忽略——用 DSH 全局默认 preset）。
async function acpCreate(acp, method, payload, signal) {
  const client = acp.client;
  const methods = acp.methods;
  const sid = payload && payload.sessionId;
  const params = {
    ...(payload && payload.cwd ? { cwd: String(payload.cwd) } : {}),
    mcpServers: [],
  };
  const res = sid
    ? await client.request(methods.agent.session.resume, { sessionId: sid, ...params }, { signal })
    : await client.request(methods.agent.session.new, params, { signal });
  try {
    getSingleton()?.appendLog?.("hana", `[dsh-rpc] ACP ${sid ? "resume" : "new"} 会话 ${res.sessionId}`);
  } catch { /* 日志失败不阻断 */ }
  // effort 默认保持：session 建立后补 set reasoning_effort（ACP 会话 initial selection
  // 只带 provider/model——settings 的 reasoningEffort 不经 ACP 插件 config 传递，落
  // model 默认 = Default）。effort = 工具显式传（payload.reasoningEffort）?? boot 读
  // settings 的默认（g.acpDefaultEffort——acp-mount readDefaultModel）。模型不支持
  //（effort 枚举不在 efforts 列表）set 抛 AcpModelConfigError——catch 静默降级
  //（effort 落该模型默认——「有的模型不支持该参数」的兜底）。
  try {
    const g0 = getSingleton();
    const effort =
      (payload && payload.reasoningEffort) ||
      (g0 && g0.acpDefaultEffort) ||
      null;
    if (effort) {
      try {
        await client.request(
          methods.agent.session.setConfigOption,
          {
            sessionId: res.sessionId,
            configId: "reasoning_effort",
            value: String(effort),
          },
          { signal },
        );
        try {
          getSingleton()?.appendLog?.(
            "hana",
            "[dsh-rpc] ACP effort 已设：" + String(effort) +
              "（session=" + String(res.sessionId).slice(0, 12) + "）",
          );
        } catch { /* 日志失败不阻断 */ }
      } catch (e) {
        try {
          getSingleton()?.appendLog?.(
            "hana",
            "[dsh-rpc] ACP reasoning_effort 降级（模型默认）：" +
              ((e && e.message) || e),
          );
        } catch { /* 日志失败不阻断 */ }
      }
    }
  } catch { /* effort 读取/设置失败不阻断会话创建 */ }
  return { sessionId: res.sessionId };
}

// ACP session.prompt：ACP 协议是请求-响应（服务端 drain 到 turn 完才回）——宿主提交
// 语义 = fire-and-forget：发出请求立即返回 { accepted: true }（结果由事件流 openMux
// 终态判定，run.js 原逻辑复用）；挂起的 request 在 turn 完 resolve，错误吞（事件流
// 已判终态/超时兜底——admission 失败无事件流时靠 run.js 超时暴露，错误记诊断日志）。
async function acpPrompt(acp, method, payload, signal) {
  const client = acp.client;
  const methods = acp.methods;
  const content = Array.isArray(payload && payload.content) ? payload.content : [];
  const params = { sessionId: payload.sessionId, prompt: content };
  try {
    getSingleton()?.appendLog?.("hana", `[dsh-rpc] ACP prompt（fire，session=${payload.sessionId}）`);
  } catch { /* 日志失败不阻断 */ }
  const pending = client.request(methods.agent.session.prompt, params);
  pending.then(
    () => {},
    (err) => {
      // 终态错误：正常 turn 完成路径事件流已判终——此处仅诊断；admission 失败
      //（sessionId 无效/参数错——快 reject）也会落这里，任务由 run.js 超时暴露。
      try {
        getSingleton()?.appendLog?.(
          "hana",
          "[dsh-rpc] ACP prompt 终态失败：" + ((err && err.message) || err),
        );
      } catch { /* 日志失败不阻断 */ }
    },
  );
  return { accepted: true };
}

// ACP session.list：ACP list 无 projections——返回全量轻量会话
//（sessions: [{ sessionId, cwd }]）。映射宿主 items 结构（run.js resume 分支消费
// item.sessionId/cwd——同字段直通）。
async function acpList(acp, method, payload, signal) {
  const client = acp.client;
  const methods = acp.methods;
  const res = await client.request(methods.agent.session.list, {}, { signal });
  const sessions =
    res && Array.isArray(res.sessions) ? res.sessions : [];
  return { items: sessions };
}

// ACP session.selectModel：set_config_option({ configId: "model", value })——ACP 的
// model option value = JSON.stringify([provider, model])（model-control.ts 的
// modelValue 编码，无需预枚举）。reasoningEffort 附加 set reasoning_effort（effort id
// 字符串；模型不支持时失败静默——对齐原 HTTP 的 model-unavailable 降级重试语义，
// ACP 层内直接降级）。model 真失败（provider/model 不在目录）抛错。
async function acpSelect(acp, method, payload, signal) {
  const client = acp.client;
  const methods = acp.methods;
  const sid = payload && payload.sessionId;
  if (!sid) throw new Error("dsh session.selectModel 缺 sessionId");
  const provider = payload && payload.provider;
  const model = payload && payload.model;
  if (!provider || !model)
    throw new Error("dsh session.selectModel 缺 provider/model");
  await client.request(
    methods.agent.session.setConfigOption,
    { sessionId: sid, configId: "model", value: JSON.stringify([provider, model]) },
    { signal },
  );
  // 默认 effort 保持（宿主 set model 会冲掉 DSH settings 的 reasoningEffort——
  // readDefaultModel 读到存 g.acpDefaultEffort；任务显式传的优先）。模型不支持的
  // effort（枚举不在 efforts 列表）set 抛 AcpModelConfigError——catch 静默降级
  //（effort 落该模型默认）——「有的模型不支持该参数」的兜底。
  const g0 = getSingleton();
  const effort =
    (payload && payload.reasoningEffort) ||
    (g0 && g0.acpDefaultEffort) ||
    null;
  if (effort) {
    try {
      await client.request(
        methods.agent.session.setConfigOption,
        { sessionId: sid, configId: "reasoning_effort", value: String(effort) },
        { signal },
      );
      try {
        getSingleton()?.appendLog?.(
          "hana",
          "[dsh-rpc] ACP effort 已设：" + String(effort) +
            "（session=" + String(sid).slice(0, 12) + "）",
        );
      } catch { /* 日志失败不阻断 */ }
    } catch (e) {
      // effort 不被该模型接受：已选模型生效，effort 用模型默认（对齐 HTTP 降级）
      try {
        getSingleton()?.appendLog?.(
          "hana",
          "[dsh-rpc] ACP reasoning_effort 降级（模型默认）：" +
            ((e && e.message) || e),
        );
      } catch { /* 日志失败不阻断 */ }
    }
  }
  return { ok: true };
}

// ACP session.cancel：notification（无响应）——发送到传输后即返回（取消请求已送达 DSH）。
// CodeRabbit #7 judgement：ACP notify 虽是 fire-and-forget（服务端不回 ack），但 SDK 的
// notify 返回 promise，其 settle = JSON-RPC notify 帧**写入传输完成**（内存双工 stream 写
// 失败立即 reject；不依赖服务端响应 → 不会挂起）。因此值得 await：写入/序列化失败时错误
// 沿 callUnaryBus 的既有错误路径抛出（调用方多为 best-effort 已 catch 忽略——index.js/
// run.js 兜底捕获——不再静默吞掉「取消未送达」帧错误）。Service sendNotification 语义确认
//（dist/acp.js AcpContext.notify→sendNotification）。
async function acpCancel(acp, method, payload, signal) {
  const client = acp.client;
  const methods = acp.methods;
  const sid = payload && payload.sessionId;
  if (!sid) throw new Error("dsh session.cancel 缺 sessionId");
  // await notify：写传输失败（连接断/stream 已 error）→ 此处 reject → callUnaryBus 抛错，
  // 取消未达不再被误报为 accepted。
  await client.notify(methods.agent.session.cancel, { sessionId: sid });
  return { accepted: true };
}

// respond 审批应答直发（client-response 信封原样 POST /api/respond）。响应 rpcReceipt
// { accepted, reason? }，调用方校验 j.accepted 语义不变。
async function respondDirect(base, payload, signal) {
  const res = await fetch(`${base}/api/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: rpcTimeoutSignal(signal),
  });
  if (!res.ok) throw new Error(`/api/respond HTTP ${res.status}`);
  return await res.json();
}

// ---- 事件流（refactor/bus-inproc：ctx.on 直订优先，总线 events 兜底）----
// DSH Host 事件源头 = cordis ctx（官方 dsh-api-remotes remoteEventSource 即 ctx.on 直订），
// remote.mux WS / dshana.bus 只是载波。进程内 boot 下宿主 ctx.on 直订同一事件源，
// 零 WS/总线绕圈；ctx 不可用（boot 边缘）回退总线 events（总线退役前兜底保留）。

async function* openMux(base, signal) {
  const g = getSingleton();
  const queue = [];
  const waiters = [];
  let off = null;
  let ready = false;
  let aborted = false; // abort 已触发标志：唤醒 waiters 后供循环检查（防 abort 后新建 waiter 挂死）
  const onFrame = (payload) => {
    if (!payload || typeof payload.type !== "string") return;
    if (payload.type === "ready") {
      ready = true; // 事件流就绪信号（总线模式 bridge 就绪帧），不投上层
      return;
    }
    if (waiters.length) waiters.shift()(payload);
    else queue.push(payload);
  };
  off = subscribeDshCtxEmitEvents(onFrame);
  if (off) {
    ready = true; // ctx 直订：订阅成功即就绪（无 bridge ready 帧等待）
  } else {
    // ctx 不可用（boot 未完成边缘/异常形态）：回退总线 events（bridge 转发）
    const bus = g?.dshanaBus;
    if (!bus || typeof bus.on !== "function") {
      throw new Error("dshana.bus 不可用，无法订阅 DSH 事件流");
    }
    off = bus.on("events", onFrame);
  }
  if (signal?.aborted) {
    aborted = true;
    off();
    throw Object.assign(new Error("dsh_run 已取消"), { code: "DSH_ABORTED" });
  }
  const onAbort = () => {
    aborted = true; // 记录中止：消费者处理帧期间 abort 时，循环下一次迭代检查后退出
    while (waiters.length) waiters.shift()(null); // 唤醒当前 waiters 使其退出
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    // 就绪等待（总线模式等 bridge 就绪帧；ctx 直订 ready 恒 true 直接跳过）
    const readyDeadline = Date.now() + 5000;
    while (!ready) {
      if (queue.length) break;
      if (Date.now() > readyDeadline) break;
      if (aborted) return; // abort 后不再等待就绪，走 finally 清理
      await new Promise((r) => setTimeout(r, 50));
    }
    while (true) {
      if (aborted) return; // abort 已触发：退出（finally 统一清理监听/队列）
      if (queue.length) {
        yield queue.shift();
        continue;
      }
      // 创建新 waiter 前再查一次 aborted：abort 可能发生在上一帧 yield 给消费者
      // 处理期间（此时 waiters 为空，onAbort 只置标志），不检查则新建 waiter 永不被唤醒
      if (aborted) return;
      const frame = await new Promise((resolve) => waiters.push(resolve));
      if (frame === null) return;
      yield frame;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (typeof off === "function") off();
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

export {
  nextRpcId,
  callUnary,
  callUnaryBus,
  openMux,
  textFromChunk,
  textFromMessageBlocks,
};
