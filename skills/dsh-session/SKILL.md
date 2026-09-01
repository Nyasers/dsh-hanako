---
name: dsh-session
description: "dsh_session 工具手册（源码 tools/dsh-session.js 核对；合并原 dsh_run / dsh_cancel）。触发场景：提交 DSH 任务（action=create 新建会话+提交 / send 续已有会话，task 必填，cwd 默认配置，超时/预设/推理强度/provider/model 可选，sessionId 即访问凭证）、取消任务（action=cancel，sessionId 必填，幂等）、查会话清单（action=list，解析 session_projcache，limit 默认 10）、凭 sessionId 取会话内容与最终结论（action=get，读会话 jsonl zstd 容器本地解压）、resume 复用会话（send 传上次 sessionId 即续）。需要提交/取消/查询 DSH 任务或会话前先读本技能。"
---

# dsh_session 工具手册

DSH 会话全生命周期工具（合并原 `dsh_run` / `dsh_cancel` 能力）。权限 `external_side_effect`（external_llm_api，create/send 消耗宿主 provider 额度；cancel 改变会话状态）。实现 `tools/dsh-session.js`（list/get 本地实现 + create/send 复用 `tools/dsh-run.js` 的 execute + cancel 复用 `tools/dsh-cancel.js` 的 execute，三者不再独立注册）。

## 参数契约

`required: ["action"]`：

| 参数 | 类型 | 语义 |
|---|---|---|
| `action` | string | `list` / `get` / `create` / `send` / `cancel`（见下各节） |
| `limit` | integer | 仅 list：返回条数（默认 10，有效 1~100） |
| `sessionId` | string | get/send/cancel 必传（形如 `session-<uuid>`，取自回调/卡片/list；dsh-home 存在即读） |
| `task` | string | create/send 必传：任务描述/消息文本 |
| `cwd` | string | 仅 create：默认可写工作区（缺省用插件配置 defaultCwd） |
| `timeout` | number | 仅 create/send：任务超时（秒），缺省用配置 defaultTimeoutSec（0/缺失回落 600s） |
| `agentPreset` | string | 仅 create/send：agent 预设（standard/ptc/cordis/minimal） |
| `reasoningEffort` | string | 仅 create/send：推理强度（off/high/max，显式传才指定） |
| `provider` | string | 仅 create/send：显式 provider（显式即成为 dsh 新默认） |
| `model` | string | 仅 create/send：显式 model id（与 provider 一起传时覆盖 dsh 默认） |

## action=create：新建会话 + 提交任务（原 dsh_run）

- **不允许传 sessionId**（新建；续会话用 send）
- **task 必填**；cwd 缺省用配置 defaultCwd（两者至少给一个）
- 固定异步：立即返回 `{ content: "任务已提交给 dsh（rpcId: xxx）…", details: { dsh: { rpcId, status: "running", cwd }, card: { route: "/card/op?sessionId=…&rpcId=…&timeoutMs=…" } } }`；deferred 注册 taskId=任务 rpcId（type=dsh-run，失败也唤醒），完成后宿主投递 `<hana-background-result>`
- 提交链路：`session.create`（新建：`{cwd, agentPreset?}`）→ 记 sessionId + cwd → `selectModel`（仅显式传 provider/model/effort 时；model-unavailable 报错降级不带 effort 重试）→ `session.prompt`（mode=queue，立即 accepted）→ 经总线 events 频道事件循环（bus 插件订阅 `$events` 转发）→ 终态
- 事件流（dsh 0.1.2）：事件不直连 remote.mux——`@dsh-hanako/bus` 在 dsh 进程内订阅 `$events` 并经总线转发（ready/emit/waterfall）。`api-session/status false` 即任务终态；`api-session/error` 记失败兜底；waterfall 帧已回投 next
- **终态映射**：`api-session/status [sid, false]` → `end_turn`（无 error 时）；出现过 `api-session/error` → `error`；流结束无终态帧兜底 `end_turn`
- 超时：任务超时（timeout 秒）会终止并报错；审批挂起不暂停计时
- 卡片：`/card/op?sessionId=…&rpcId=…`（实时日志/进度，插件重启后可恢复）

## action=send：续已有会话发消息（原 dsh_run resume）

- **sessionId + task 必填**（续上次会话；cwd 沿用会话已有值，提交层自动查询）
- 其余行为与 create 相同（提交 → 事件流 → 终态 → 卡片）

## action=cancel：取消任务（原 dsh_cancel）

- **sessionId 必填**（dsh_run 回调/卡片 URL 里带；取消一律显式传 sessionId）
- 幂等：任务已结束返回无需取消；运行期协调条目以 sessionId 键控，极早 cancel 跳过标记
- 总线 Unary RPC `session.cancel` → 任务以 aborted 终态收尾 → 唤醒 Agent
- 卡死/误派/不再需要结果时止损用

## action=list：会话清单

解析 `session_projcache.json`（dsh-home 唯一事实源）：`{ sessionId, title, cwd?, createdAt?, lastPromptAt?, usage?, turns?, steps?, llmMs? }`，按 lastPromptAt 降序取最近 N 条。纯本地读，不调 dsh web host。

## action=get：凭 sessionId 直取会话内容

projcache 元数据 + summary（jsonl 最后一条 assistant/message 的 text，截断 ≤4000）。jsonl `<dataDir>/dsh-home/sessions/<cwd-key>/<sessionId>/session.jsonl.zstd` 是多帧 zstd 容器（帧 magic `0xFD2FB528`），node:zlib 逐帧解压拼接。

## 使用场景

- 提交任务：`create`（新任务）或 `send`（续上次 sessionId——先 list/get 确认会话）
- 止损：`cancel`（卡死/误派）
- 回看：`list`（清单）→ `get`（最终结论/内容）

## 关联

- `dsh_install`：依赖安装/验证（dsh 未就绪时先装）
- `dsh_approve`：审批应答（独立工具——权限应答语义正交；sessionId 同键）
- 事件流/总线：`@dsh-hanako/bus`（消息总线，dshana.bus WS 服务端）
