---
name: dsh-cancel
description: "dsh_cancel 工具手册（源码 tools/dsh-cancel.js 核对）。触发场景：取消已派发的 dsh 任务（误派/卡死/不再需要结果止损）、dsh_cancel 怎么用（sessionId 从 dsh_run 回调/卡片 URL 取，必填）、op Map 退役后 g.ops 仅存运行期协调条目（任务 rpcId 键控，取消只认 sessionId）、幂等语义（任务已结束返回无需取消）、取消后任务以 aborted 终态收尾并唤醒 Agent、cancelling 状态、session.cancel 调用细节。需要取消 dsh 任务前先读本技能。"
---

# dsh_cancel 工具手册

取消一个已派发的 dsh 任务（主动止损）。权限 `external_side_effect`（external_api）。实现 `tools/dsh-cancel.js`。

## 参数契约

`required: ["sessionId"]`（op Map 退役后 g.ops 仅存运行期协调条目、任务 rpcId 键控；**取消一律显式传 sessionId**）：

| 参数 | 类型 | 语义 |
|---|---|---|
| `sessionId` | string（必填） | 要取消的 dsh 会话 sessionId（dsh_run 异步回调/卡片 URL 里带）。直接按会话取消，重启后仍有效 |

## 行为（源码核实）

1. **参数校验**：`sessionId` 为空 → 抛 `需要 sessionId（dsh_run 回调/卡片 URL 里带；取消一律显式传 sessionId）`。
2. **定位**：`sessionId` 直接定位会话；g.ops 运行期条目以任务 rpcId 键控，cancel 遍历条目找 `entry.sessionId === sessionId` 的项（条目极少——仅运行中任务，遍历可忽略；极早 cancel 条目未建则为 null，跳过标记）。
3. **请求**：调 web host `POST /api/session.cancel`（client-request 信封，rpcId 回显校验；`full.result.ok` 为假抛取消请求未接受）。
4. **防误判**：先标记 `entry.cancelledRequested = true`（找到该会话的运行期条目时）——cancel 导致 mux 断流时，dsh-run.js 事件循环读取该标记把无终态收尾判为 aborted 而非 end_turn（防误报完成）。
5. **收尾**：dsh agent 收到中断，任务以 aborted 终态收尾，宿主 deferred fail 以「dsh_run 已取消」唤醒 Agent。best-effort：任务刚好自然完成时 cancel 的 accepted 无副作用（cancel 幂等）。

## 返回

`已请求取消任务（会话 <sessionId 前 12 字符>…）：dsh agent 会收到中断，任务将尽快以 aborted 终态收尾`，details `{ dsh: { sessionId, accepted: true, status: "cancelling" } }`。

## 使用场景

- 误派（任务描述写错、cwd 给错）
- 卡死（长时间无进度，先看卡片/Web UI 再决定）
- 不再需要结果（省 token）

## 示例：从哪拿 sessionId

sessionId 来源（**取消一律显式传 sessionId**）：

1. **dsh_run 异步回调**：任务完成/失败时后台消息带 `sessionId`（形如 `session-xxxx`）——直接抄用
2. **运行卡片 URL**：卡片 iframe 地址带 `sessionId=<session-xxxx>&rpcId=<r_xxx>`——从 URL 取
3. **dsh_session**：查会话清单（`dsh_session(action="list")`）按 `sessionId` 定位，再取消
4. 任务 rpcId 不再用于取消定位（g.ops 条目按任务 rpcId 键控，但 cancel 参数只收 sessionId）——**取消一律传 sessionId**

```
dsh_cancel(sessionId="session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
```

## 关联

- 取消后的终态、错误码 DSH_ABORTED、usage 对账见 dsh-run 技能「错误码速查」。
- 取消后查终态看运行卡片（SSE 卡片从 jsonl 恢复，重启后仍可看）；会话清单/摘要（含取消后遗留的会话，仅 agent 自己创建的会话）用 dsh_session action=list（详见 dsh-session 技能）。
