---
name: dsh-approve
description: "dsh_approve 工具手册（源码 tools/dsh-approve.js 核对）。触发场景：dsh 任务挂起审批怎么应答、收到 dsh-approval 通知怎么处理（payload 结构：rpcId/approvalId/toolName/callId/reason/args 命令路径原文）、allowed-once 与 rejected 怎么选、决策看 args 不听 reason、无人应答超时自动拒绝（approvalTimeoutMs）、审批已应答/已超时/不在待办列表的报错语义、Web UI 人工处理兜底。需要应答 dsh 审批前先读本技能。"
---

# dsh_approve 工具手册

应答 dsh 任务挂起的权限审批（approval/requested）。权限 `external_side_effect`（external_api）。实现 `tools/dsh-approve.js`。

## 参数契约

`required: ["rpcId", "approvalId"]`：

| 参数 | 类型 | 语义 |
|---|---|---|
| `rpcId` | string | 审批所属 dsh 任务的 rpcId（审批通知里带；任务级 rpcId，每次任务调用唯一） |
| `approvalId` | string | 审批 id（同一任务可能挂起多个审批，逐个应答） |
| `outcome` | enum: allowed-once/rejected | 默认 `allowed-once`（安全默认：放行单次，仅本次操作）/ `rejected` 拒绝该请求 |

## 审批全链路（触发 → 应答 → 收尾）

1. **触发**：dsh agent 请求越界权限（approval/policy=ask）→ 任务挂起，插件把审批上下文存进运行期协调条目 `g.ops[任务 rpcId].pendingApprovals`（审批对象含 respond 路由所需 `respondRpcId`——审批帧信封自己的 RPC id，区别于任务 rpcId），暂停任务执行超时计时。
2. **通知**：经宿主 deferred 通道投递（taskId = `` `${rpcId}::approval::${approvalId}` ``，rpcId 为任务级 rpcId；独立于任务完成通道），payload：
   ```
   { kind: "dsh-approval", rpcId, sessionId, approvalId, toolName, callId,
     reason,       // model 自述（不可尽信）
     args,         // 工具/调用参数原文（命令/路径）——决策依据
     taskPreview } // 任务文本前 120 字符
   ```
   args 来源：事件循环按 callId 从 toolCallCache 反查（tool/call 与 code-dispatch 子调用 subCallId 形如 `root:code:N` 均缓存；miss 时剥 `:code:N` 后缀回退 run_code 根调用兜底）。
3. **决策**：**看 args（具体执行了什么），不听 reason（model 自述）**。合理 → `allowed-once`；危险 → `rejected`。
4. **应答**：`dsh_approve(rpcId, approvalId, outcome)`，内部调 web host `POST /api/respond`（client-response 信封，用审批对象的 `respondRpcId` 路由 pending 表）。
5. **超时**：`approvalTimeoutMs`（默认 30000；0 = 禁用）内无人应答自动 rejected（`auto: "expired"`）。应答方失联检测：正常应答几秒内完成。
6. **恢复**：approval/resolved（allowed-once/rejected/cancelled 一律视为已解决）→ 清该审批超时计时器，无 pending 项时恢复任务执行计时。
7. **兜底**：也可在 dsh Web UI 人工处理；通知失败不影响任务。

## 应答校验与错误语义

- 任务条目不存在/已过期（g.ops 条目仅活到任务终态，终态即删除）：`任务不存在或已过期（rpcId: xxx）：只可应答本会话近期提交的 dsh 任务审批`
- approval 不在待办列表：`审批 xxx 不在任务 yyy 的待办列表（可能已被应答/超时）。已知: …`（列出已知项及状态）
- 已应答：`审批 xxx 已应答（allowed-once/rejected），勿重复应答`
- 应答未接受（`!j.accepted`）：`审批应答未接受（reason）：可能已超时或被其他方处理，任务侧会自行感知`

## 返回

成功：`已放行/已拒绝审批 <approvalId> [toolName]（理由）`，details `{ dsh: { rpcId, approvalId, toolName, outcome, accepted: true } }`。

## 关联

- 通知来自 dsh_run 任务的事件循环（approval/requested 帧）；任务本身用 dsh_run 提交，详见 dsh-run 技能。
- 审批超时配置 approvalTimeoutMs 的解析与 config.json 单一事实源规则见 dsh-run 技能「配置单一事实源」。
