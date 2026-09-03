---
name: dsh-session
description: "dsh_session 工具手册（源码 src/tools/session.js 核对；合并原 dsh_run / dsh_cancel / dsh_approve，操作按 subtool 模块化）。触发场景：提交 DSH 任务（action=create 新建会话+提交 / send 续已有会话，task/cwd 必填，超时/预设/推理强度/provider/model 可选，sessionId 即访问凭证）、取消任务（action=cancel，sessionId 必填，幂等）、查会话清单（action=list，解析 session_projcache，limit 默认 10）、凭 sessionId 取会话内容与最终结论（action=get，读会话 jsonl zstd 容器本地解压）、应答会话挂起审批（action=approve：sessionId/approvalId 必填，outcome=allowed-once/rejected，决策看 args 不听 reason，宿主审批适配应答经总线 respond 回投）、resume 复用会话（send 传上次 sessionId 即续）。需要提交/取消/查询/审批 DSH 任务或会话前先读本技能。"
---

# dsh_session 工具手册

DSH 会话全生命周期工具（合并原 `dsh_run` / `dsh_cancel` / `dsh_approve` 能力）。权限 `external_side_effect`（external_llm_api，create/send 消耗宿主 provider 额度；cancel/approve 改变会话/审批状态）。实现 `tools/session.js`（注册分派壳）+ `tools/subtool/{run,query,cancel,approve}.js`（各操作独立 execute：run=create/send 提交、query=list/get 只读查询、cancel、approve——subtool 不再单独注册，宿主 Agent 面仅 dsh_session）。

## 参数契约

`required: ["action"]`：

| 参数 | 类型 | 语义 |
|---|---|---|
| `action` | string | `list` / `get` / `create` / `send` / `cancel` / `approve`（见下各节） |
| `limit` | integer | 仅 list：返回条数（默认 10，有效 1~100） |
| `sessionId` | string | get/send/cancel/approve 必传（形如 `session-<uuid>`，取自回调/卡片/list；dsh-home 存在即读） |
| `approvalId` | string | 仅 approve：审批 id（审批通知里带；同一任务可能挂起多个审批，逐个应答） |
| `outcome` | enum | 仅 approve：`allowed-once`（放行单次，安全默认）/ `rejected`（拒绝该请求） |
| `task` | string | create/send 必传：任务描述/消息文本 |
| `cwd` | string | 仅 create 必传：沙箱工作目录（defaultCwd 配置已删除，每次调用显式指定） |
| `timeout` | number | 仅 create/send：任务超时（秒），缺省用配置 defaultTimeoutSec（0/缺失回落 600s） |
| `agentPreset` | string | 仅 create/send：agent 预设（standard/ptc/cordis/minimal） |
| `reasoningEffort` | string | 仅 create/send：推理强度（off/high/max，显式传才指定） |
| `provider` | string | 仅 create/send：显式 provider（显式即成为 DSH 新默认） |
| `model` | string | 仅 create/send：显式 model id（与 provider 一起传时覆盖 DSH 默认） |

## action=create：新建会话 + 提交任务（原 dsh_run）

- **不允许传 sessionId**（新建；续会话用 send）
- **task + cwd 必填**（defaultCwd 配置已删除，无回退）
- **任务发起后主动结束当前回合**：create/send 固定异步提交，提交后 Agent 应立即 return（结束回复），让宿主通过 deferred 投递回调（任务完成/审批挂起/失败）。审批通知走 interlude 型 deferred，但 interlude 同样在回合结束时才落地（实测不能在结束回合前插入时间线），不结束回合同样收不到。
- 固定异步：立即返回 `{ content: [{ type: "text", text: "任务已提交给 DSH（rpcId: xxx）…" }], details: { dsh: { rpcId, status: "running", cwd }, card: { route: "/card/op?sessionId=…&rpcId=…&timeoutMs=…" } } }`；deferred 注册 taskId=任务 rpcId（type=dsh-run，失败也唤醒），完成后宿主投递 `<hana-background-result>`
- 提交链路：`session.create`（新建：`{cwd, agentPreset?}`）→ 记 sessionId + cwd → `selectModel`（仅显式传 provider/model/effort 时；model-unavailable 报错降级不带 effort 重试）→ `session.prompt`（mode=queue，立即 accepted）→ 经总线 events 频道事件循环（bus 插件订阅 `$events` 转发）→ 终态
- 事件流（DSH 0.1.2）：事件不直连 remote.mux——`@dsh-hanako/bus` 在 DSH 进程内订阅 `$events` 并经总线转发（ready/emit/waterfall）。`api-session/status false` 即任务终态；`api-session/error` 记失败兜底；waterfall 帧已回投 next
- **终态映射**：`api-session/status [sid, false]` → `end_turn`（无 error 时）；出现过 `api-session/error` → `error`；流结束无终态帧兜底 `end_turn`
- 超时：任务超时（timeout 秒）会终止并报错；审批挂起暂停计时（审批等待是外部决策，不计入执行超时，应答后恢复）
- 卡片：`/card/op?sessionId=…&rpcId=…`（实时日志/进度，插件重启后可恢复）

## action=send：续已有会话发消息（原 dsh_run resume）

- **sessionId + task 必填**（续上次会话；cwd 沿用会话已有值，提交层自动查询）
- 其余行为与 create 相同（提交 → 事件流 → 终态 → 卡片）

## action=cancel：取消任务（原 dsh_cancel）

- **sessionId 必填**（dsh_run 回调/卡片 URL 里带；取消一律显式传 sessionId）
- 幂等：任务已结束返回无需取消；运行期协调条目以 sessionId 键控，极早 cancel 跳过标记
- 总线 Unary RPC `session.cancel` → 任务以 aborted 终态收尾 → 唤醒 Agent
- 卡死/误派/不再需要结果时止损用

## action=approve：应答会话挂起审批（原 dsh_approve）

- **sessionId + approvalId 必填**（审批通知里带；全链路唯一定位键 = 任务 sessionId，同键即应答该会话挂起的审批；同一任务可能挂起多个审批，逐个应答）
- **outcome**：`allowed-once`（默认，安全默认值：放行单次仅本次操作）/ `rejected`（拒绝该请求）
- **审批触发**：DSH agent 请求越界权限（approval/requested）→ 任务挂起，审批上下文存 `g.ops[sessionId].activeApprovals`；宿主经 deferred（interlude 型）投递 dsh-approval 通知，payload：`{ kind, rpcId, sessionId, approvalId, toolName, callId, reason, args, taskPreview }`（args = 工具调用参数原文，命令/路径）
- **决策：看 args（具体执行了什么），不听 reason（model 自述不可尽信）**——合理放行，危险拒绝
- **应答链路**：应答经总线 RPC（callUnaryBus）发 `method="respond"` → bus 翻译器自环调 `POST /api/$events/result`（eventId = 审批帧 eventId，outcome `{ kind: 'result', value }`）；总线未连接降级 HTTP 直连
- **超时**：`approvalTimeoutSec`（config.json `global.approvalTimeoutSec` 优先；缺省回落配置快照 30 秒 = manifest 默认，仅显式设 0 才禁用）内无人应答自动 rejected（`auto: expired`）
- **审批挂起暂停执行超时计时**（审批等待是外部决策，不计入任务超时；应答/超时后恢复）；应答成功/超时后任务继续跑至终态
- **兜底**：DSH Web UI（webPort 默认 3080）人工处理仍可用
- **错误语义**：任务不存在/已过期、审批不在待办列表（可能已应答/超时）、已应答勿重复应答、应答未接受（可能超时/他方处理）——按返回消息处理即可

## action=list：会话清单

解析 `session_projcache.json`（dsh-home 唯一事实源）：`{ sessionId, title, cwd?, createdAt?, lastPromptAt?, usage?, turns?, steps?, llmMs? }`，按 lastPromptAt 降序取最近 N 条。纯本地读，不调 DSH web host。

## action=get：凭 sessionId 直取会话内容

projcache 元数据 + summary（jsonl 最后一条 assistant/message 的 text，截断 ≤4000）。jsonl `<dataDir>/dsh-home/sessions/<cwd-key>/<sessionId>/session.jsonl.zstd` 是多帧 zstd 容器（帧 magic `0xFD2FB528`），node:zlib 逐帧解压拼接。

## 使用场景

- 提交任务：`create`（新任务）或 `send`（续上次 sessionId——先 list/get 确认会话）
- 止损：`cancel`（卡死/误派）
- 回看：`list`（清单）→ `get`（最终结论/内容）
- 审批：收到 dsh-approval 通知后 `approve`（sessionId+approvalId+outcome，决策看 args 不听 reason）

## 关联

- `dsh_install` 已退役：依赖安装由自动链 + Bootstrap 自举承担（无需手动工具）
- 事件流/总线：`@dsh-hanako/bus`（消息总线，dshana.bus WS 服务端）；审批瀑布帧广播不区分会话（宿主按 sessionId 归属过滤尚未实现）
