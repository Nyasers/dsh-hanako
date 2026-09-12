// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/rpc-envelope.js — DSH /api 网关 Unary RPC 信封构造/解析（纯函数，App v2 步骤 3）
//
// v2 指令通道（迁移指南 §13 步骤 3 + 决策 A，见 DESIGN「步骤 3 架构决策」）：
// App 主进程 → 受管 runtime 内 DSH web 服务的指令 = loopback HTTP Unary RPC，
// **信封/翻译器协议复用 v1 已验证格式**（v1 lib/protocol.js callUnary/callUnaryBus 的
// HTTP 兑底路径 + 总线翻译器自环同款，见 src-cordis/plugins/bus/index.js）：
//   POST http://127.0.0.1:<中继端口>/api/<method 点号→斜杠> ，
//   body = { type:"client-request", rpcId, method, payload:{ args: <inner> } }
//   · session.* 方法 payload 须包成 gateway 信封（request/_request + 注入 requestId，
//     jsonl data.source.rpcId 定位键）；session.list 用 _request，其余 session 用 request；
//   · 非 session 方法裸 payload 透传（respond 审批应答单独走 client-response 信封）。
// 响应 ServerResponse JSON：rpcId 回显 + result.ok/value 或 result.ok=false + error。
// 本模块零宿主状态（不 import 单例/运行包），调用方自备 base URL 与 fetch。
//
// 复用纪律：v1 callUnaryBus 曾以 ACP 优先、HTTP 兑底；v2 没有 ACP（DSH 在受管子进程），
// HTTP 信封即唯一指令面——只保留 v1 HTTP 兑底形态的协议常数与包装逻辑，去掉 ACP 分支。

const RPC_TIMEOUT_MS = 60000;

/** rpcId 生成（与 v1 nextRpcId 同形：时间基 + 随机尾巴，跨调用唯一）。 */
export function nextRpcId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 方法名 → /api 端点路径（点号 → 斜杠；session.create → session/create）。 */
export function endpointOf(method) {
  const m = String(method ?? "");
  if (!m) throw new Error("rpc-envelope: method 不能为空");
  return m.includes(".") ? m.replace(/\./g, "/") : m;
}

/** session.* 方法判定（gateway 信封包装适用）。 */
export function isSessionMethod(method) {
  const m = String(method ?? "");
  return m.startsWith("session.") || m.startsWith("session/");
}

/**
 * 构造 client-request 信封（v1 形态；结果可直接 JSON 序列化 POST）。
 * @returns {{ body: object, rpcId: string }} body = 待 POST 的 JSON 体。
 */
/**
 * 构造 client-request 信封（v1 形态；结果可直接 JSON 序列化 POST）。
 * DSH web /api 网关校验 body.method === 端点路径段（斜杠形态，official rpc-host 与
 * @dshana/bridge 同款，见迁移后核对记录）——method 传 'session.create' 或
 * 'session/create' 均可，信封内统一写斜杠形态。
 * @returns {{ body: object, rpcId: string }} body = 待 POST 的 JSON 体。
 */
export function buildClientRequest({ method, payload, rpcId } = {}) {
  const m = String(method ?? "");
  if (!m) throw new Error("rpc-envelope: method 不能为空");
  const id = String(rpcId || "") || nextRpcId();
  const endpoint = endpointOf(m);
  const isList = endpoint === "session/list";
  const inner = isSessionMethod(m)
    ? {
        [isList ? "_request" : "request"]: {
          ...(payload && typeof payload === "object" ? payload : {}),
          requestId: id,
        },
      }
    : payload ?? {};
  return {
    body: { type: "client-request", rpcId: id, method: endpoint, payload: { args: inner } },
    rpcId: id,
  };
}

/**
 * 解析 server response（响应体 JSON）：校验 rpcId 回显与 result.ok；
 * 成功返回 result.value，失败抛 Error（含 dsh 侧 code/message）。
 */
export function parseServerResponse(full, rpcId) {
  if (!full || typeof full !== "object") {
    throw new Error("rpc-envelope: DSH 响应非对象");
  }
  if (rpcId && full.rpcId !== rpcId) {
    throw new Error(`rpc-envelope: DSH 响应 rpcId 不匹配（期望 ${rpcId}，收到 ${String(full.rpcId)}）`);
  }
  const res = full.result;
  if (!res || res.ok !== true) {
    const e = (res && res.error) || {};
    const err = new Error(`DSH ${full.method || "rpc"} 失败：${e.code || "unknown"} ${e.message || ""}`);
    err.code = e.code || "DSH_RPC_ERROR";
    throw err;
  }
  return res.value;
}

/** 默认 RPC 超时（毫秒；调用方可按任务类型覆盖）。 */
export function defaultRpcTimeoutMs() {
  return RPC_TIMEOUT_MS;
}
