---
name: dsh-session
description: "dshana_session 工具手册（DSH 会话全生命周期：create/send/list/get/cancel/approve 六 action 均已接线）。触发场景：提交 DSH 任务（action=create 新建会话+提交 / send 续已有会话，task/cwd 必填，预设/推理强度/provider/model 可选）、查会话清单（action=list）、取会话内容与最终结论（action=get，taskId 或 sessionId）、取消任务（action=cancel，taskId 优先）、应答审批（action=approve，approvalId 即可）。调用模型：句柄默认（taskId/approvalId，按宿主记录的来源会话校验归属）、凭证显式（sessionId = 我要跨对话）。需要提交/查询/取消 DSH 任务或应答审批前先读本技能。"
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
| sessionId | string | **显式凭证路径**：send 必传；get/cancel/approve 可用。显式传入 = “我要跨对话操作”，跳过归属校验 |
| taskId | string | **句柄路径**（宿主 task id：create/send 返回或任务通知里带）：get/cancel/approve 可传，工具自己解析会话并按宿主记录的来源会话校验归属（与 sessionId 至少给一个） |
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

- **目标二选一**：`taskId`（句柄路径，默认；工具自己解析会话并按宿主记录的来源会话校验归属）或 `sessionId`（显式凭证路径，跨对话用）
- 链路：通知 DSH `session.cancel`（中止模型流 / 工具 / 终端）→ 收敛为明确取消终态；只停本工作，不影响共享 runtime 上的其他会话
- 句柄反查不到（任务已被回收 / 映射已清理）会**明确报错**，不会拿猜出来的会话继续操作

## action=approve：应答挂起审批

- **approvalId 必填**（审批通知里带；同一任务可挂起多个审批，逐个应答）——它是唯一句柄，会话由工具解析（句柄路径会校验归属）；`sessionId` 仅在“我要跨对话”时显式传
- **outcome**：`allowed-once`（默认，放行本次）/ `rejected`（拒绝）
- **决策看 args（具体要执行什么），不听 reason（模型自述不可尽信）**：合理放行，危险拒绝
- 审批超时未应答按 `approvalTimeoutSec` 自动拒绝（本 App 缺省 30 秒；显式设 0 则禁用自动拒绝）。注意宿主自身的 `timeoutMs` 默认是 0（不禁用即不超时）—— 30 秒是 App 侧策略

## action=list：会话清单

官方 `session/list` 取数（**需 DSH 运行时在线**，未就绪会先拉起）：`{ sessionId, title, cwd?, updatedAt, lastPromptAt?, turns?, steps?, llmMs?, usage? }`，按 `lastPromptAt`（缺失则 `updatedAt`）降序取最近 N 条。

- `title` 来自会话投影 `projections.values.title`（自动生成或用户改名；未命名的会话为空）
- DSH 侧摘要**没有 `createdAt`**，所以这里给的是 `updatedAt`（与原口径的差异）

## action=get：取会话内容（taskId 或 sessionId）

| | |
|---|---|
| 取数 | `session/list` 定该会话读位点 `projections.asOfSeq` → `session/page` 在该 cut 上取尾部一窗 records |
| 口径 | **最后一次 user 消息之后、最后一次 assistant 输出**就是本轮结论（一次 create/send = 一轮）；文本截断 ≤4000 |

会显式标注、不静默篡改的情形：本轮尚无输出（退到更早的最近结论）／窗口内无 user 消息／该轮被中断／**该轮以错误结束**（模型或工具报错时 DSH 只写 `attempt` + `turn/end`，这里把错误原因透出来）／还有更早轮次未读。

注：会话日志已是 V3 格式，**不再自读 `session_projcache.json` / `session.jsonl.zstd`**（格式演进交回官方）；DSH 未启动时 list/get 不可用。

## 典型用法

- 提交任务：create（新任务）或 send（续上次 sessionId，先 list/get 确认）
- 回看：list（清单）→ get（最终结论）
- 止损：cancel；越界权限：approve

## 关联

- 故障排查、三态自举页、数据源与主题：见 [dshana 技能](../dshana)
- 会话与账本在 App 数据目录内（不碰 `~/.DSH`）
