---
name: dsh-run
description: "dsh_run 工具调用手册（源码 tools/dsh-run.js 核对）。触发场景：dsh_run 怎么传参（task/cwd/timeout/agentPreset/reasoningEffort/provider/model/sessionId 的语义与副作用）、固定异步模式与返回结构（wait 参数已退役）、后台回调 payload 结构（固定 minimal 定位键）、超时语义（审批挂起不暂停计时）、错误码 DSH_ERROR/DSH_TIMEOUT/DSH_ABORTED、provider/model 显式指定的写回副作用（显式即成为 dsh 新默认）、resume 复用会话、agentPreset 选型（standard/ptc/cordis/minimal）、config.json 单一事实源实时生效。需要提交 dsh 任务前先读本技能。"
---

# dsh_run 工具手册

把任务交给 DeepSeek Harness（dsh）的常驻 web host（--profile web）执行：完整编码 agent、沙箱 bash/文件系统工具、上下文压缩、subagent 级联。权限 `external_side_effect`（external_llm_api，消耗宿主 provider 额度）。实现 `tools/dsh-run.js`（单文件自包含，989 行）。

## 参数契约（源码 parameters + doExecute + submitTask 核实）

`required: ["task"]`，其余可选：

| 参数 | 类型/枚举 | 语义（源码核实） |
|---|---|---|
| `task` | string | 必填。作为用户消息发给 dsh agent；先 trim，空串抛 `task 不能为空`。应含完整上下文与明确交付物 |
| `cwd` | string | 沙箱工作目录。缺省用 config.json `global.defaultCwd`。校验：`cwd 为空且未传 sessionId` 抛 `cwd 不能为空`；**resume（传 sessionId）时 cwd 可空，以会话已有 cwd 为准，传入值被忽略** |
| `timeout` | number（秒） | `> 0` 才采用（×1000），否则 `defaultTimeoutSec`（manifest 默认 1800=30min，可被 config.json 覆盖）。审批挂起期间继续计时（见下） |
| `agentPreset` | enum: standard/ptc/cordis/minimal | 显式传优先；缺省 config.json `global.agentPreset`（回退 standard）。standard=完整编码 agent；ptc=PTC 模式（以 TypeScript 程序组合多步操作的工具呈现，dsh-agent-presets presets/ptc）；cordis=可读写运行时；minimal=精简。旧值 code（工具呈现批量调用）已并入 ptc（0.1.2 词表无 code，传入映射 ptc） |
| `reasoningEffort` | enum: off/high/max | v0.9.5 起无全局配置，只接受显式参数；不传为 null（dsh 默认处理，通常 high） |
| `provider` / `model` | string | 显式传 → selectModel 覆盖默认；只传一侧时另一侧从 settings.yaml `agent-default-model` 补齐；都不传不 selectModel，用 dsh 默认。**副作用：selectModel 会写回全局 settings.yaml——显式指定即成为新默认** |
| `sessionId` | string | resume：复用会话上下文继承。自动沿用会话已有 cwd；目标会话须空闲；查不到抛 `目标会话不存在或已归档，无法 resume` |

## 执行链路（submitTask 内部）

```text
ensureWebHost（resolveDshPkgDir 定位依赖 → spawn dsh web，DSH_HOME=数据目录 dsh-home，端口就绪上限 60s）
→ session.create（新建：{cwd, agentPreset?}；resume：先 session.list 查会话已有 cwd）
→ 记 op.sessionId + sessionCwd
→ selectModel（仅显式传 provider/model/effort 时；model-unavailable 报错降级不带 effort 重试）
→ session.prompt（mode=queue，立即 accepted）
→ 经总线 events 频道事件循环（bridge 订阅 $events 转发）→ 终态
```

事件处理要点（dsh 0.1.2）：事件流**不直连 remote.mux**——bridge 在 dsh 进程内订阅 $events 并经总线转发（ready/emit/waterfall）。`api-session/status false` 即任务终态（结果从会话投影 projcache 读 title/tokenUsage）；`api-session/error` 记 pendingFailure（失败兜底）；`api-session/activity` 心跳忽略；waterfall 帧 bridge 已回投 next（宿主审批适配未接入——见「审批」段）。

**终态映射**：`api-session/status [sid, false]` → `end_turn`（无 error 事件时）；出现过 `api-session/error` → `error`（failure.message 透传）；流结束无终态帧兜底 `end_turn`。

## 返回与回调

**固定异步（唯一模式，wait 参数已退役）**：立即返回 `{ content: "任务已提交给 dsh（rpcId: xxx）…", details: { dsh: { rpcId, status: "running", cwd }, card: { route: "/card/op?sessionId=…&rpcId=…&timeoutMs=…", … } } }`。deferred 注册 taskId=任务 rpcId（type=dsh-run，trigger_parent_turn，失败也唤醒），完成后宿主投递 `<hana-background-result>`。

**后台回调 payload（固定 minimal，v0.21.3 后续演进收口）**：
```text
{ status, rpcId, sessionId }
```
只带定位键，不含 output/outputMeta/summary/usage/stderr 等大字段、不生成摘要、不占 Agent 上下文。**sessionId 唯一定位键**（v0.21.x 起不再冗余 id 字段——id 与 sessionId 同值重复，收敛到只留 sessionId；与 dsh_session / dsh_run resume 的定位键一致）：主上下文收到回调后**凭 sessionId 直接取会话内容**——`dsh_session(action="get", sessionId=<id>)` 直取最终结论 summary（读会话 jsonl），或 dsh_run resume 续接。失败回调（failDeferredWake）error 尽力带定位键：有 sessionId（提交成功后的执行失败）时 `error.sessionId`；提交失败无 sessionId 时 `error.rpcId`（可为空串）。**完整输出永远在卡片（会话 jsonl 恢复）+ dsh Web UI（sessionId 定位）可查**。

（wait=true 同步模式已随 wait 参数一并退役：长任务阻塞当前回合无收益，取结果走 dsh_session get。）

## 超时语义

- 窗口 = `input.timeout × 1000` 或 `defaultTimeoutSec × 1000`（manifest 默认 1800s=30min）。
- **执行超时在整个任务期间连续计时，审批挂起不暂停**（宿主审批适配未接入——任务挂起等人工处理期间 timer 照走；无人应答时任务可能因超时被回收）。
- 超时抛 `DSH_TIMEOUT`，随后 best-effort 调 session.cancel；取消抛 `DSH_ABORTED`。
- 失败路径也带 usage（取消/超时前消耗可对账）；catch 以 `status: "error"` 终态收尾并落盘。

## 错误码速查

| 错误码 | stopReason | 触发 |
|---|---|---|
| `DSH_ERROR` | error | 任务执行失败（turn/end error 的 failure.message 透传；finish 帧 429/400 先走 DSH 侧退避重试，仅重试耗尽/断流兜底 pendingFailure 时按 error 收尾） |
| `DSH_TIMEOUT` | timeout | 超时（审批挂起不暂停计时） |
| `DSH_ABORTED` | aborted | dsh_cancel / 外部 signal 中止 |

## 审批（现状：Web UI 人工处理）

dsh agent 请求越界权限时任务挂起（approval/requested，bridge 已自动回投 next 保持服务端不挂）。**当前宿主侧审批应答适配未接入**（事件循环收到 waterfall 帧仅记日志）——审批只能在 **DSH Web UI**（webPort，默认 3080）里人工处理：允许（allowed-once）或拒绝（rejected）。执行超时在审批挂起期间**继续计时**（见上），长时间无人处理可能因任务超时被回收。`dsh_approve` 工具与审批通知链路（deferred taskId `` `${rpcId}::approval::${approvalId}` ``）为预留接口，随宿主审批适配接入后生效。

## 配置单一事实源（resolve* 函数）

defaultCwd / approvalTimeoutSec / defaultTimeoutSec / nodejsPath 优先直读 `<dataDir>/config.json` 的 `global.*`（设置界面或 Agent 直写都即时生效），无则回退快照 → manifest 默认。**config.json 不自动生成**（vX migrate 体系退役：ensureConfigJson 已删除，配置读取侧 resolve* 缺省回退兜底——新装无 config.json 时用 manifest 默认值，无需手动保存）。读取侧保留旧毫秒键（approvalTimeoutMs / defaultTimeoutMs）兜底换算（升级不丢配置）。**「改完都要重启 Hana」不成立**（仅 tools 模块缓存场景需重启）。

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
