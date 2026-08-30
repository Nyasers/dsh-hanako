---
name: dsh-run
description: "dsh_run 工具调用手册（源码 tools/dsh-run.js 核对）。触发场景：dsh_run 怎么传参（task/cwd/timeout/wait/agentPreset/reasoningEffort/provider/model/sessionId 的语义与副作用）、异步/同步模式区别与返回结构、后台回调 payload 结构（固定 minimal 定位键）、超时语义（审批挂起暂停计时）、错误码 DSH_ERROR/DSH_TIMEOUT/DSH_ABORTED、provider/model 显式指定的写回副作用（显式即成为 dsh 新默认）、resume 复用会话、agentPreset 选型（standard/code/cordis/minimal）、config.json 单一事实源实时生效。需要提交 dsh 任务前先读本技能。"
---

# dsh_run 工具手册

把任务交给 DeepSeek Harness（dsh）的常驻 web host（--profile web）执行：完整编码 agent、沙箱 bash/文件系统工具、上下文压缩、subagent 级联。权限 `external_side_effect`（external_llm_api，消耗宿主 provider 额度）。实现 `tools/dsh-run.js`（单文件自包含，989 行）。

## 参数契约（源码 parameters + doExecute + submitTask 核实）

`required: ["task"]`，其余可选：

| 参数 | 类型/枚举 | 语义（源码核实） |
|---|---|---|
| `task` | string | 必填。作为用户消息发给 dsh agent；先 trim，空串抛 `task 不能为空`。应含完整上下文与明确交付物 |
| `cwd` | string | 沙箱工作目录。缺省用 config.json `global.defaultCwd`。校验：`cwd 为空且未传 sessionId` 抛 `cwd 不能为空`；**resume（传 sessionId）时 cwd 可空，以会话已有 cwd 为准，传入值被忽略** |
| `timeout` | number（秒） | `> 0` 才采用（×1000），否则 `defaultTimeoutSec`（manifest 默认 1800=30min，可被 config.json 覆盖）。审批挂起时间不计入（见下） |
| `wait` | boolean | false（默认）异步：立即返回 + 运行卡片 + 完成后台送达；true 同步：阻塞当前回合等最终结果直接返回 |
| `agentPreset` | enum: standard/code/cordis/minimal | 显式传优先；缺省 config.json `global.agentPreset`（回退 standard）。code=工具呈现批量调用（适合读改文件 + node --check 编码序列）；standard=完整编码 agent；cordis=可读写运行时；minimal=精简 |
| `reasoningEffort` | enum: off/high/max | v0.9.5 起无全局配置，只接受显式参数；不传为 null（dsh 默认处理，通常 high） |
| `provider` / `model` | string | 显式传 → selectModel 覆盖默认；只传一侧时另一侧从 settings.yaml `agent-default-model` 补齐；都不传不 selectModel，用 dsh 默认。**副作用：selectModel 会写回全局 settings.yaml——显式指定即成为新默认** |
| `sessionId` | string | resume：复用会话上下文继承。自动沿用会话已有 cwd；目标会话须空闲；查不到抛 `目标会话不存在或已归档，无法 resume` |

## 执行链路（submitTask 内部）

```
ensureWebHost（resolveDshPkgDir 定位依赖 → spawn dsh web，DSH_HOME=数据目录 dsh-home，端口就绪上限 60s）
→ session.create（新建：{cwd, agentPreset?}；resume：先 session.list 查会话已有 cwd）
→ 记 op.sessionId + sessionCwd
→ selectModel（仅显式传 provider/model/effort 时；model-unavailable 报错降级不带 effort 重试）
→ session.prompt（mode=queue，立即 accepted）
→ events.mux 事件循环 → 终态
```

事件处理要点：`assistant/chunk` 文本流累积（finish 帧 `reason.kind==="error"` **不是终态信号**——只记 pendingFailure 兜底后继续消费：DSH 侧 LLM 请求失败如 429/400 会进入 agent/request-error waterfall → dsh-llm-retry 指数退避重试，任务实际还在跑，可能继续出 chunk / assistant/message，终态判定以 `turn/end` 为准——官方 UI 客户端同语义）；`llm/retry` 事件经会话日志通道记「LLM 请求失败，退避重试中（第 N 次，延迟 Xms）」（不阻断、不改卡片渲染）；`assistant/message` 收集 usage；`tool/call` 与 `tool/code-dispatch-start` 缓存工具参数原文（审批决策数据源）；`turn/end` 终态判定；`approval/requested`/`approval/resolved` 审批；`stream/error` 事件流错误。

**终态映射**：`completed → end_turn` / `max-tokens → max_tokens` / `aborted → aborted` / `error → error`（failure.message 透传）。流结束无终态帧时：已请求取消（cancelledRequested）且 mux 断流判 aborted（防误报完成）；期间见过 finish error（LLM 请求失败帧）按 error 收尾（pendingFailure 兜底，防 DSH 退避重试中断流/崩溃被误判成功）；否则兜底 end_turn。

## 返回与回调

**异步模式（默认）**：立即返回 `{ content: "任务已提交给 dsh（rpcId: xxx）…", details: { dsh: { rpcId, status: "running", cwd, wait: false }, card: { route: "/card/op?sessionId=…&rpcId=…&timeoutMs=…", … } } }`。deferred 注册 taskId=任务 rpcId（type=dsh-run，trigger_parent_turn，失败也唤醒），完成后宿主投递 `<hana-background-result>`。

**后台回调 payload（固定 minimal，v0.21.3 后续演进收口）**：
```
{ status, rpcId, sessionId }
```
只带定位键，不含 output/outputMeta/summary/usage/stderr 等大字段、不生成摘要、不占 Agent 上下文。**sessionId 唯一定位键**（v0.21.x 起不再冗余 id 字段——id 与 sessionId 同值重复，收敛到只留 sessionId；与 dsh_session / dsh_run resume 的定位键一致）：主上下文收到回调后**凭 sessionId 直接取会话内容**——`dsh_session(action="get", sessionId=<id>)` 直取最终结论 summary（读会话 jsonl），或 dsh_run resume 续接。失败回调（failDeferredWake）error 尽力带定位键：有 sessionId（提交成功后的执行失败）时 `error.sessionId`；提交失败无 sessionId 时 `error.rpcId`（可为空串）。**完整输出永远在卡片（会话 jsonl 恢复）+ dsh Web UI（sessionId 定位）可查**。

**同步模式（wait=true）**：content = `res.output` +（非 end_turn 附 `[stopReason: …]`）；details.dsh = `{ sessionId, stopReason, usage, cwd, rpcId, wait: true }`（`sessionId` 唯一定位键，同异步回调；不再冗余 id 字段），stderr 附 `dshStderr`（截 2000）。阻塞当前回合、无卡片进度；长任务建议异步。

## 超时语义

- 窗口 = `input.timeout × 1000` 或 `defaultTimeoutSec × 1000`（manifest 默认 1800s=30min）。
- **审批挂起暂停计时**：approval/requested 时扣减已流逝时间清 timer，全部审批解决后按 remaining 续算（外部决策等待不计入执行时间）；多审批以「无任何 pending 项」为准恢复。
- 超时抛 `DSH_TIMEOUT`，随后 best-effort 调 session.cancel；取消抛 `DSH_ABORTED`。
- 失败路径也带 usage（取消/超时前消耗可对账）；catch 以 `status: "error"` 终态收尾并落盘。

## 错误码速查

| 错误码 | stopReason | 触发 |
|---|---|---|
| `DSH_ERROR` | error | 任务执行失败（turn/end error 的 failure.message 透传；finish 帧 429/400 先走 DSH 侧退避重试，仅重试耗尽/断流兜底 pendingFailure 时按 error 收尾） |
| `DSH_TIMEOUT` | timeout | 超时（审批挂起时间不计入） |
| `DSH_ABORTED` | aborted | dsh_cancel / 外部 signal 中止 |

## 审批（挂起 → dsh_approve 应答）

dsh agent 请求越界权限时任务挂起，插件经 deferred 通知（taskId = `` `${rpcId}::approval::${approvalId}` ``，rpcId 为任务级 rpcId），payload 带 `toolName/callId/reason/args(命令路径原文)/taskPreview`。用 `dsh_approve(rpcId, approvalId, "allowed-once"/"rejected")` 应答（默认 allowed-once）；超时 `approvalTimeoutSec`（默认 30s，0=禁用）无人应答自动 rejected；也可靠 Web UI 人工处理。**决策看 args（执行了什么），不听 reason（model 自述）**。详见 dsh-approve 技能。

## 配置单一事实源（resolve* 函数）

defaultCwd / approvalTimeoutSec / defaultTimeoutSec / nodejsPath 优先直读 `<dataDir>/config.json` 的 `global.*`（设置界面或 Agent 直写都即时生效），无则回退快照 → manifest 默认。旧毫秒键（approvalTimeoutMs / defaultTimeoutMs）由迁移自动换算为秒并删除，读取侧也保留旧键兜底（迁移未跑时不丢配置）。**config.json 由插件自动初始化**（ensureConfigJson：无文件时按 manifest 默认值生成，幂等不覆盖、原子写、失败静默），全新安装免手动保存。**「改完都要重启 Hana」不成立**（仅 tools 模块缓存场景需重启）。

下表为 manifest 默认值（随包分发的事实）；实际生效值以 config.json 为准（未覆盖时等于默认）：

| 配置 | manifest 默认 | 备注 |
|---|---|---|
| agentPreset | standard | 工具显式传时优先 |
| approvalTimeoutSec | 30 | 单位：秒；0/负数 = 禁用超时拒绝 |
| defaultTimeoutSec | 1800 (30min) | 单位：秒；未显式传 timeout 时用；可被 config.json 覆盖 |
| webPort | 3080 | 0 不生效 |

依赖位置：数据目录 `dsh-pkg/` 优先（升级不丢），回退插件 node_modules。

## 使用决策

- 需要完整编码 agent 深度执行（实现/重构/调试/测试、沙箱实验、与当前对话隔离的长任务）→ dsh_run 默认异步提交。
- 日常小代码任务 → subagent 协作（平台原生、隔离上下文），不注入 dsh。
- **provider/model 显式指定 = 写回 dsh 全局新默认**（settings.yaml），要长期固定某模型请在 dsh models 页设默认。
- resume 复用：dsh_session action=list 找到历史会话或复用上次回调 sessionId → `dsh_run(sessionId=…)`，省上下文重建。
