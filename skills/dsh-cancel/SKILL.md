---
name: dsh-cancel
description: "dsh_cancel 工具手册（源码 tools/dsh-cancel.js 核对）。触发场景：取消已派发的 dsh 任务（误派/卡死/不再需要结果止损）、dsh_cancel 怎么用（opId 从 dsh_run 返回/卡片/回调取）、幂等语义（任务已结束返回无需取消）、取消后任务以 aborted 终态收尾并唤醒 Agent、cancelling 状态、session.cancel 调用细节。需要取消 dsh 任务前先读本技能。"
---

# dsh_cancel 工具手册

取消一个已派发的 dsh 任务（主动止损）。权限 `external_side_effect`（external_api）。实现 `tools/dsh-cancel.js`。

## 参数契约

`required: ["opId"]`：

| 参数 | 类型 | 语义 |
|---|---|---|
| `opId` | string | 要取消的任务 opId（dsh_run 提交时返回，卡片/回调里带） |

## 行为（源码核实）

1. **op 校验**：`g.ops.get(opId)` 不存在/过期（超 50 条被裁）→ 抛 `op 不存在或已过期（只可取消本会话近期提交的 dsh 任务）`。
2. **幂等**：`op.status !== "running"`（已结束/终态收尾中）→ 返回 `任务已结束（status=…），无需取消`，**不抛错**。
3. **阶段校验**：`op.sessionId` 为空 → 抛 `任务尚未进入会话阶段（sessionId 未知），无法取消`。
4. **请求**：调 web host `POST /api/session.cancel`（client-request 信封，rpcId 回显校验；`full.result.ok` 为假抛取消请求未接受）。
5. **防误判**：先标记 `op.cancelledRequested = true`——cancel 导致 mux 断流时，dsh-run.js 事件循环读取该标记把无终态收尾判为 aborted 而非 end_turn（防误报完成）。
6. **收尾**：dsh agent 收到中断，任务以 aborted 终态收尾，宿主 deferred fail 以「dsh_run 已取消」唤醒 Agent。best-effort：任务刚好自然完成时 cancel 的 accepted 无副作用（事件循环已终态，finish 幂等）。

## 返回

`已请求取消任务 <opId>（会话 <sessionId 前 12 字符>…）：dsh agent 会收到中断，任务将尽快以 aborted 终态收尾`，details `{ dsh: { opId, sessionId, accepted: true, status: "cancelling" } }`。

## 使用场景

- 误派（任务描述写错、cwd 给错）
- 卡死（长时间无进度，先看卡片/Web UI 再决定）
- 不再需要结果（省 token）

## 关联

- 取消后的终态、错误码 DSH_ABORTED、usage 对账见 dsh-run 技能「错误码速查」。
- 取消后查终态用 dsh_ops（status=running 过滤含 cancelling；aborted 归入 error 过滤的说明见 dsh-ops 技能）。
