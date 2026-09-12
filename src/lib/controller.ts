// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/controller.ts — DSH 控制面客户端（App 侧；对齐官方样例 hana-dsh 的 controller.invoke）
//
// 落点：App 工具（dshana_session）**不直接访问 DSH HTTP**，而是经宿主 `ctx.runtime.fetch(runtimeId,
// "/_control")` 打到 runtime 内中继的控制面（src/runtime/bridge.ts 的 /_control，controlKey 鉴权），
// 由 runtime 进程带 DSH cookie 转发到 DSH /api。好处：
//   · App 侧不需要 network 授权到 DSH/中继（宿主代发受管服务请求）；
//   · DSH 凭据只存在于 runtime 进程内；
//   · 单一入口，便于收据/超时/取消统一治理。
//
// 信封契约复用 lib/rpc-envelope.js（client-request + server-response），与 runtime 侧转发一致。
import { bridgeAccess } from "./managed-runtime.ts";
import { buildClientRequest, parseServerResponse } from "./rpc-envelope.ts";

/** 低层控制面调用：invoke("rpc", { body }) → runtime 转发 → DSH 的 server-response 原文。 */
export async function invokeControl(ctx, action, args, opts = {}) {
  const access = bridgeAccess();
  if (!access || !access.runtimeId) throw new Error("受管 runtime 未就绪：无可用控制面（先 ensureManagedRuntime）");
  if (!ctx || !ctx.runtime || typeof ctx.runtime.fetch !== "function") {
    throw new Error("宿主不支持 ctx.runtime.fetch（受管服务请求）——需要 Hana 0.944+");
  }
  const res = await ctx.runtime.fetch(access.runtimeId, "/_control", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hana-dsh-control": access.controlKey },
    body: JSON.stringify({ action, args }),
    timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 30000,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((body && (body.error || body.message)) || ("控制面 HTTP " + res.status));
  }
  if (!body || typeof body !== "object") throw new Error("控制面返回非对象（宿主契约异常）");
  return body;
}

/**
 * 一元 RPC（经控制面）：{ method, payload, rpcId? } → DSH 的 result（parseServerResponse 解包）。
 * 与 lib/dsh-rpc.js 的 rpcCallWithFetch 同信封，但载体改为控制面。
 */
export async function rpcViaControl(ctx, { method, payload, rpcId, timeoutMs } = {}) {
  const { body } = buildClientRequest({ method, payload, rpcId });
  const full = await invokeControl(ctx, "rpc", { body }, { timeoutMs });
  return parseServerResponse(full, body.rpcId);
}
