---
name: dsh-approve
description: "dsh_approve 工具手册（源码 tools/dsh-approve.js 核对）。触发场景：DSH 任务挂起审批怎么应答、收到 dsh-approval 通知怎么处理（payload 结构：sessionId/approvalId/toolName/callId/reason/args 命令路径原文）、allowed-once 与 rejected 怎么选、决策看 args 不听 reason、审批已应答/已超时/不在待办列表的报错语义、Web UI 人工处理兜底。需要应答 DSH 审批前先读本技能。注意：宿主审批适配已接入，应答经总线 respond 回投 /api/$events/result。"
---

# dsh_approve 工具手册

应答 DSH 任务挂起的权限审批（approval/requested）。权限 `external_side_effect`（external_api）。实现 `tools/dsh-approve.js`。

> **现状**：宿主审批应答适配已接入——dsh_run 事件循环处理 approval/request 瀑布帧：填充 `g.ops[sessionId].activeApprovals`、审批挂起暂停执行超时（应答/超时拒绝后恢复）、经宿主 deferred（interlude 型）通道投递 dsh-approval 通知（**实测 interlude 同样在 Agent 结束回合时才落地，不能在回合进行中插入时间线**——Agent 须先结束当前回合才能收到审批通知）；Agent 收到通知后调本工具应答，应答经总线 respond 自环 `/api/$events/result` 放行/拒绝。审批挂起期间执行超时暂停计时（审批等待是外部决策，不计入任务超时）。DSH Web UI（webPort，默认 3080）人工处理仍可用作兜底。

## 参数契约

`required: ["sessionId", "approvalId"]`：

| 参数 | 类型 | 语义 |
|---|---|---|
| `sessionId` | string | 审批所属 DSH 会话的 sessionId（审批通知里带；全链路唯一定位键，dsh_run 提交返回/卡片 URL 同键） |
| `approvalId` | string | 审批 id（同一任务可能挂起多个审批，逐个应答） |
| `outcome` | enum: allowed-once/rejected | 默认 `allowed-once`（安全默认：放行单次，仅本次操作）/ `rejected` 拒绝该请求 |

## 审批全链路（触发 → 应答 → 收尾）

> 以下为已接入链路（2026-09 实测闭环）：

1. **触发**：DSH agent 请求越界权限（approval/policy=ask）→ 任务挂起，插件把审批上下文存进运行期协调条目 `g.ops[sessionId].activeApprovals`（审批对象含应答路由所需 `eventId`——审批瀑布帧自己的 eventId，区别于任务 rpcId；应答时回投给 `$events/result`），暂停任务执行超时计时（目标行为）。
2. **通知**：经宿主 deferred 通道投递（taskId = `` `${rpcId}::approval::${approvalId}` ``，rpcId 为任务级 rpcId；独立于任务完成通道；interlude 型投递，实测在 Agent 结束回合时才落地），payload：
   ```text
   { kind: "dsh-approval", rpcId, sessionId, approvalId, toolName, callId,
     reason,       // model 自述（不可尽信）
     args,         // 工具/调用参数原文（命令/路径）——决策依据
     taskPreview } // 任务文本前 120 字符
   ```
   args 来源：事件循环按 callId 从 toolCallCache 反查（tool/call 与 code-dispatch 子调用 subCallId 形如 `root:code:N` 均缓存；miss 时剥 `:code:N` 后缀回退 run_code 根调用兜底）。
3. **决策**：**看 args（具体执行了什么），不听 reason（model 自述）**。合理 → `allowed-once`；危险 → `rejected`。
4. **应答**：`dsh_approve(sessionId, approvalId, outcome)`，经总线 RPC（`callUnaryBus`，rpc.request/rpc.result 通道）发 `method="respond"`——bus 翻译器在 DSH 进程内自环调 `POST /api/$events/result`（RemoteEventResult：clientId 由总线事件流 ready 帧持有、eventId = 审批帧 eventId、outcome 为 `{ kind: 'result', value }`），回投 ServerResponse 的 `result.ok` 判定 accepted；总线未连接时降级 HTTP 直连。
5. **超时**：`approvalTimeoutSec`（config.json `global.approvalTimeoutSec` 优先，缺省回落配置快照，再缺省 0 = 禁用；单位：秒）内无人应答自动 rejected（`auto: "expired"`）。
6. **恢复**：应答成功/超时拒绝后调用审批对象 `_resume` 恢复任务执行计时（审批等待不计入执行超时）；无 pending 审批时任务继续跑至终态。
7. **兜底**：也可在 DSH Web UI 人工处理；通知失败不影响任务。

## 应答校验与错误语义

- 任务条目不存在/已过期（g.ops 条目仅活到任务终态，终态即删除）：`任务不存在或已过期（sessionId: xxx）：只可应答本会话近期提交的 DSH 任务审批`
- approval 不在待办列表：`审批 xxx 不在任务 yyy 的待办列表（可能已被应答/超时）。已知: …`（列出已知项及状态）
- 已应答：`审批 xxx 已应答（allowed-once/rejected），勿重复应答`
- 应答未接受（`!j.accepted`）：`审批应答未接受（reason）：可能已超时或被其他方处理，任务侧会自行感知`

## 返回

成功：`已放行/已拒绝审批 <approvalId> [toolName]（理由）`，details `{ DSH: { sessionId, approvalId, toolName, outcome, accepted: true } }`。

## 关联

- 通知来自 dsh_run 任务的事件循环（approval/requested 帧，宿主事件循环经总线 events 频道订阅 bridge 转发的瀑布帧）；任务本身用 dsh_run 提交。
- 已知边界：瀑布帧广播不区分会话——同一审批帧会被所有活跃任务的事件循环收到（宿主侧按 sessionId 归属的过滤尚未实现）。
- 审批超时配置 approvalTimeoutSec（单位：秒）的解析与 config.json 单一事实源规则见 dsh-run 技能「配置单一事实源」。
