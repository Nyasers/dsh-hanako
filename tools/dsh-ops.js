// tools/dsh-ops.js — dsh 任务历史查询（只读）工具
// 直接读本插件内存中的 op 快照（globalThis.__dshHanako.ops，v0.5.7 起含落盘恢复内容）：
// 终态 op 快照落盘 <dataDir>/ops.jsonl（v0.7.1 起 JSONL 增量追加，旧 ops.json 首次启动自动迁移），
// 插件启动时 loadOps 恢复，因此重启后仍可查历史任务与结论。
// 不调 dsh web host /api，纯本地内存读，sessionPermission 描述为只读（无副作用）。

export const name = "dsh_ops";

export const description =
  "查询 dsh 任务历史（op 快照）：可选 status 过滤（running/ok/error/interrupted/cancelling），不传返回全部（最多 50 条）；" +
  "重启后仍可查（历史已落盘恢复）。返回 opId/任务/状态/耗时/usage 摘要，供对账与回溯";

export const parameters = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["running", "ok", "error", "interrupted"],
      description: "按状态过滤：running=运行中（含已请求取消未收尾的 cancelling 任务）/ ok=成功 / error=失败（含超时 timeout、取消 aborted）/ interrupted=上次运行中断（重启恢复时标记）。不传返回全部（最多 50 条）。",
    },
  },
  required: [],
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "local_read",
    summary: "读取本插件内存中的 dsh 任务历史快照（ops Map，含落盘恢复内容）",
    ruleId: "dsh-hanako-ops",
  }),
};

async function doExecute(input, ctx) {
  const g = globalThis.__dshHanako;
  const all = g?.ops ? [...g.ops.values()] : [];
  all.reverse(); // Map 按插入序（最老在前）：倒序 = 最新在前
  const statusFilter = String(input.status ?? "").trim();
  const rows = statusFilter ? all.filter((op) => op.status === statusFilter) : all;

  // 每条映射为摘要对象：字段存在才带（undefined 省略）
  const items = rows.map((op) => {
    const item = {
      opId: op.opId,
      status: op.status,
      task: String(op.task ?? "").slice(0, 80),
    };
    if (op.stopReason != null) item.stopReason = op.stopReason;
    if (op.durationMs != null) item.durationMs = op.durationMs;
    if (op.startedAt != null) item.startedAt = op.startedAt;
    if (op.endedAt != null) item.endedAt = op.endedAt;
    if (op.usage != null) item.usage = op.usage;
    if (op.resumeSessionId != null) item.resumeSessionId = op.resumeSessionId;
    if (op.sessionId != null) item.sessionId = op.sessionId;
    return item;
  });

  if (items.length === 0) {
    return {
      content: [{ type: "text", text: "暂无 dsh 任务记录" }],
      details: { dsh: { count: 0, status: statusFilter || null } },
    };
  }

  const lines = items.map((op) => {
    const dur = op.durationMs != null ? `${(op.durationMs / 1000).toFixed(1)}s` : "-";
    return `${op.opId} · ${op.status} · ${dur} · ${String(op.task ?? "").slice(0, 40)}`;
  });
  const filterNote = statusFilter ? `（status=${statusFilter}）` : "";
  return {
    content: [
      { type: "text", text: `dsh 任务历史${filterNote}：共 ${items.length} 条\n${lines.join("\n")}` },
    ],
    details: { dsh: { count: items.length, status: statusFilter || null, ops: items } },
  };
}

export async function execute(input, ctx) {
  try {
    return await doExecute(input, ctx);
  } catch (e) {
    ctx.log?.error?.("[dsh-hanako] dsh_ops failed:", e?.stack || e?.message || String(e));
    throw e;
  }
}
