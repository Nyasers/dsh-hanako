---
name: dsh-approve
description: "dsh_approve 工具手册（源码 tools/dsh-approve.js 核对）。触发场景：dsh 任务挂起审批怎么应答、收到 dsh-approval 通知怎么处理（payload 结构：sessionId/approvalId/toolName/callId/reason/args 命令路径原文）、allowed-once 与 rejected 怎么选、决策看 args 不听 reason、审批已应答/已超时/不在待办列表的报错语义、Web UI 人工处理兜底。需要应答 dsh 审批前先读本技能。注意：当前宿主审批适配未接入，本工具为预留接口。"
---

# dsh_approve 工具手册

应答 dsh 任务挂起的权限审批（approval/requested）。权限 `external_side_effect`（external_api）。实现 `tools/dsh-approve.js`。

> **现状（vX）**：宿主侧审批应答适配**未接入**——dsh_run 事件循环收到 waterfall 帧仅记日志，`g.ops[sessionId].activeApprovals` 不会被填充，deferred 审批通知（notifyApprovalWake）无触发点。**当前审批只能在 DSH Web UI（webPort，默认 3080）人工处理**（允许/拒绝）；执行超时在审批挂起期间继续计时。本工具与下述链路为**预留接口**（应答信封/错误语义已实现并保真），随宿主审批适配接入后生效。

## 参数契约

`required: ["sessionId", "approvalId"]`：

| 参数 | 类型 | 语义 |
|---|---|---|
| `sessionId` | string | 审批所属 dsh 会话的 sessionId（审批通知里带；全链路唯一定位键，dsh_run 提交返回/卡片 URL 同键） |
| `approvalId` | string | 审批 id（同一任务可能挂起多个审批，逐个应答） |
| `outcome` | enum: allowed-once/rejected | 默认 `allowed-once`（安全默认：放行单次，仅本次操作）/ `rejected` 拒绝该请求 |

## 审批全链路（预留设计：触发 → 应答 → 收尾）

> 以下为审批适配接入后的目标链路；当前运行时未接入（见顶部现状）。

1. **触发**：dsh agent 请求越界权限（approval/policy=ask）→ 任务挂起，插件把审批上下文存进运行期协调条目 `g.ops[sessionId].activeApprovals`（审批对象含 respond 路由所需 `respondRpcId`——审批帧信封自己的 RPC id，区别于任务 rpcId），暂停任务执行超时计时（目标行为）。
2. **通知**：经宿主 deferred 通道投递（taskId = `` `${rpcId}::approval::${approvalId}` ``，rpcId 为任务级 rpcId；独立于任务完成通道），payload：
   ```text
   { kind: "dsh-approval", rpcId, sessionId, approvalId, toolName, callId,
     reason,       // model 自述（不可尽信）
     args,         // 工具/调用参数原文（命令/路径）——决策依据
     taskPreview } // 任务文本前 120 字符
   ```
   args 来源：事件循环按 callId 从 toolCallCache 反查（tool/call 与 code-dispatch 子调用 subCallId 形如 `root:code:N` 均缓存；miss 时剥 `:code:N` 后缀回退 run_code 根调用兜底）。
3. **决策**：**看 args（具体执行了什么），不听 reason（model 自述）**。合理 → `allowed-once`；危险 → `rejected`。
4. **应答**：`dsh_approve(sessionId, approvalId, outcome)`，经总线 RPC（`callUnaryBus`，rpc.request/rpc.result 通道）发 `method="respond"`——bridge 在 dsh 进程内自环调 `POST /api/respond`（client-response 信封，用审批对象的 `respondRpcId` 路由 pending 表），回投 `{ accepted }` 校验 `j.accepted` 语义不变；总线未连接时降级 HTTP 直连。
5. **超时**：`approvalTimeoutSec`（默认 30s；0 = 禁用）内无人应答自动 rejected（`auto: "expired"`）——目标行为（当前未接入）。应答方失联检测：正常应答几秒内完成。
6. **恢复**：approval/resolved（allowed-once/rejected/cancelled 一律视为已解决）→ 清该审批超时计时器，无 pending 项时恢复任务执行计时（目标行为；当前执行超时连续计时）。
7. **兜底**：也可在 dsh Web UI 人工处理；通知失败不影响任务。

## 应答校验与错误语义

- 任务条目不存在/已过期（g.ops 条目仅活到任务终态，终态即删除）：`任务不存在或已过期（sessionId: xxx）：只可应答本会话近期提交的 dsh 任务审批`
- approval 不在待办列表：`审批 xxx 不在任务 yyy 的待办列表（可能已被应答/超时）。已知: …`（列出已知项及状态）
- 已应答：`审批 xxx 已应答（allowed-once/rejected），勿重复应答`
- 应答未接受（`!j.accepted`）：`审批应答未接受（reason）：可能已超时或被其他方处理，任务侧会自行感知`

## 返回

成功：`已放行/已拒绝审批 <approvalId> [toolName]（理由）`，details `{ dsh: { sessionId, approvalId, toolName, outcome, accepted: true } }`。

## 关联

- 通知来自 dsh_run 任务的事件循环（approval/requested 帧）——**当前未接入**（事件循环收到 waterfall 帧仅记日志，见 dsh-run 技能「审批」段）；任务本身用 dsh_run 提交。
- 审批超时配置 approvalTimeoutSec（单位：秒）的解析与 config.json 单一事实源规则见 dsh-run 技能「配置单一事实源」。
