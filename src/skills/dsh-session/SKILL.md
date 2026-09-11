---
name: dsh-session
description: "dshana_session 工具手册（DSH 会话全生命周期：create/send/list/get/cancel/approve 六 action 均已接线）。触发场景：提交 DSH 任务（action=create 新建会话+提交 / send 续已有会话，task/cwd 必填，预设/推理强度/provider/model 可选，sessionId 即访问凭证）、查会话清单（action=list）、凭 sessionId 取会话内容与最终结论（action=get）、取消任务（action=cancel）、应答审批（action=approve）。需要提交/查询/取消 DSH 任务或应答审批前先读本技能。"
---

# dshana_session 工具手册

DSH 会话工具（App v2：隔离 App 进程 + 受管 DSH runtime + ctx.tasks 回投）。宿主 Agent 面**仅此一个**工具，六 action 全在这一处。

推理经受管 runtime 内 `hana.models` 发起，消耗宿主 provider 额度，provider 凭据留在宿主。

## 参数契约

required: ["action"]

| 参数 | 类型 | 语义 |
|---|---|---|
| action | string | list / get / create / send / cancel / approve |
| limit | integer | 仅 list：返回条数（默认 10，有效 1~100） |
| sessionId | string | get/send/cancel/approve 必传（形如 session-<uuid>；取自返回或清单） |
| approvalId | string | 仅 approve：审批 id（同一任务可能挂起多个审批，逐个应答） |
| outcome | enum | 仅 approve：allowed-once（放行单次，安全默认）/ rejected（拒绝） |
| task | string | create/send 必传：任务描述/消息文本 |
| cwd | string | 仅 create 必传：工作目录（无 defaultCwd 回退，每次显式指定） |
| timeout | number | 仅 create/send：任务超时（秒），缺省用 `defaultTimeoutSec` |
| agentPreset | string | 仅 create/send：agent 预设（standard/ptc/cordis/minimal） |
| reasoningEffort | string | 仅 create/send：推理强度（off/high/max） |
| provider | string | 仅 create/send：显式 provider（显式即成为 DSH 新默认） |
| model | string | 仅 create/send：显式 model id（与 provider 一起传时覆盖 DSH 默认） |

## action=create：新建会话 + 提交任务

- **不允许传 sessionId**（新建；续会话用 send）；**task + cwd 必填**
- **固定异步**：立即返回 `{ content, details: { dsh: { action, sessionId, status: "running", cwd, ... } } }`；任务在后台执行，完成/失败作为后台结果投递回发起会话，Agent 结束回合即可收到；要看过程或最终结论用 `action=get`
- 提交链路：`ctx.tasks.create` → 受管 runtime 就绪 → `session.create` →（显式传 provider/model/effort 时才 `selectModel`）→ 写会话↔任务映射 → `session.prompt`（queue）→ runtime task-bridge 按映射回投终态

## action=send：续已有会话发消息

- **sessionId + task 必填**；cwd 沿用会话已有值（持久非活跃会话自动 resume）
- 同会话多次 send 由 App 侧串行化，按提交顺序排队，不并发

## action=cancel：取消任务

- **sessionId 必填**
- 链路：通知 DSH `session.cancel`（中止模型流 / 工具 / 终端）→ 收敛为明确取消终态；只停本工作，不影响共享 runtime 上的其他会话

## action=approve：应答挂起审批

- **sessionId + approvalId 必填**（同一任务可能挂起多个审批，逐个应答）
- **outcome**：`allowed-once`（默认，放行本次）/ `rejected`（拒绝）
- **决策看 args（具体要执行什么），不听 reason（模型自述不可尽信）**：合理放行，危险拒绝
- 审批超时未应答按 `approvalTimeoutSec` 自动拒绝（缺省 30 秒；显式设 0 则禁用自动拒绝）

## action=list：会话清单

解析 `session_projcache.json`：`{ sessionId, title, cwd?, createdAt?, lastPromptAt?, usage?, turns?, steps?, llmMs? }`，按 `lastPromptAt` 降序取最近 N 条。纯本地读，DSH 未启动也可用。

## action=get：凭 sessionId 取会话内容

projcache 元数据 + summary（jsonl 最后一条 `assistant/message` 的 text，截断 ≤4000）。jsonl 为多帧 zstd 容器（帧 magic `0xFD2FB528`），`node:zlib` 逐帧解压拼接。

## 典型用法

- 提交任务：create（新任务）或 send（续上次 sessionId，先 list/get 确认）
- 回看：list（清单）→ get（最终结论）
- 止损：cancel；越界权限：approve

## 关联

- 故障排查、三态自举页、数据源与主题：见 [dsh-hanako 技能](../dsh-hanako)
- 会话与账本在 App 数据目录内（不碰 `~/.DSH`）
