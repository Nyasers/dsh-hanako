// tools/dsh-cancel.js — dsh 任务取消（止损）工具
// dsh_run 派发任务后只能等完成或超时，本工具提供主动取消：按 opId 调 dsh web host
// POST /api/session.cancel（client-request 信封，rpcId 回显校验）中断运行中的任务会话。
// cancel 后 dsh 会发 turn/end（reason.kind=aborted），事件循环判 outcome.stopReason === "aborted"
// → throw DSH_ABORTED → promise.catch 以 aborted 终态收尾（deferred fail 带「dsh_run 已取消」唤醒 Agent）。
// 工具侧先标记 op.cancelledRequested = true，防 cancel 导致 mux 断流时事件循环把取消误判为完成
// （dsh-run.js consume 末尾的取消兜底）。best-effort 止损：任务刚好自然完成时 cancel 的 accepted
// 无副作用（事件循环已终态，finish 幂等）。

function hostBase() {
  const g = globalThis.__dshHanako;
  const web = g?.web;
  if (!web?.ready || !web.port) throw new Error("dsh web host 未就绪");
  return `http://127.0.0.1:${web.port}`;
}

export const name = "dsh_cancel";

export const description =
  "取消一个已派发的 dsh 任务（主动止损）：dsh_run 提交后返回 opId（卡片/回调里也带），" +
  "本工具按 opId 请求取消仍处于 running 的任务——内部调 dsh web host POST /api/session.cancel " +
  "中断该会话，dsh agent 收到中断后任务以 aborted 终态收尾，宿主 deferred 通道会以" +
  "「dsh_run 已取消」唤醒 Agent。适合误派、卡死或不再需要结果的任务；任务已结束时" +
  "幂等返回提示无需取消。opId 须为本会话近期 dsh_run 提交的任务（op 快照仅内存保留最近 50 条）。";

export const parameters = {
  type: "object",
  properties: {
    opId: {
      type: "string",
      description: "要取消的 dsh 任务的 opId（dsh_run 提交时返回，卡片/回调里带）",
    },
  },
  required: ["opId"],
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "external_api",
    summary: "向 dsh web host 请求取消一个运行中的 dsh 任务会话（session.cancel），中断 dsh agent",
    ruleId: "dsh-hanako-cancel",
  }),
};

async function doExecute(input, ctx) {
  const opId = String(input.opId ?? "").trim();
  if (!opId) throw new Error("opId 必填");

  const g = globalThis.__dshHanako;
  const op = g?.ops?.get(opId);
  if (!op) throw new Error("op 不存在或已过期（只可取消本会话近期提交的 dsh 任务）");

  if (op.status !== "running") {
    // 已结束（含终态收尾中）：无需取消，返回提示不抛错
    return {
      content: [
        { type: "text", text: `任务已结束（status=${op.status}），无需取消` },
      ],
      details: { dsh: { opId, status: op.status } },
    };
  }

  if (!op.sessionId) throw new Error("任务尚未进入会话阶段（sessionId 未知），无法取消");

  const base = hostBase();
  const rpcId = `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const res = await fetch(`${base}/api/session.cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "client-request",
      rpcId,
      method: "session.cancel",
      payload: { sessionId: op.sessionId },
    }),
  });
  if (!res.ok) throw new Error(`/api/session.cancel HTTP ${res.status}`);
  const full = await res.json();
  if (!full || full.rpcId !== rpcId) throw new Error("/api/session.cancel rpcId 不匹配");
  if (!full.result?.ok) {
    const e = full.result?.error || {};
    throw new Error(`取消请求未接受（${e.code || "unknown"} ${e.message || ""}）`);
  }

  // 标记：防 mux 断流时事件循环把取消误判为完成（dsh-run.js consume 末尾取消兜底读取该标记）
  op.cancelledRequested = true;

  const sessionId = String(op.sessionId);
  return {
    content: [
      {
        type: "text",
        text: `已请求取消任务 ${opId}（会话 ${sessionId.slice(0, 12)}…）：dsh agent 会收到中断，任务将尽快以 aborted 终态收尾`,
      },
    ],
    details: {
      dsh: { opId, sessionId, accepted: true, status: "cancelling" },
    },
  };
}

export async function execute(input, ctx) {
  try {
    return await doExecute(input, ctx);
  } catch (e) {
    ctx.log?.error?.("[dsh-hanako] dsh_cancel failed:", e?.stack || e?.message || String(e));
    throw e;
  }
}
