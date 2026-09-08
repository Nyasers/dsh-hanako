---
name: dsh-session
description: "dsh_session 工具手册（App v2 步骤 3 核对：create/send 已接线——ctx.tasks.create + 受管 DSH runtime + task-map 回投；cancel/approve 待步骤 4）。触发场景：提交 DSH 任务（action=create 新建会话+提交 / send 续已有会话，task/cwd 必填，预设/推理强度/provider/model 可选，sessionId 即访问凭证）、查会话清单（action=list，解析 session_projcache，limit 默认 10）、凭 sessionId 取会话内容与最终结论（action=get，读会话 jsonl zstd 容器本地解压）；resume 复用会话（send 传上次 sessionId 即续）。需要提交/查询 DSH 任务或会话前先读本技能。"
---

# dsh_session 工具手册

DSH 会话工具（App v2：隔离 App 进程 + 受管 DSH runtime + ctx.tasks 回投）。create/send 消耗宿主 provider 额度（模型推理经受管 runtime 内 hana.models，provider 凭据留在宿主）。实现 tools/session.js（注册分派壳）+ tools/subtool/query.js（list/get 只读查询）+ lib/session-run.js（create/send 提交链，v2 步骤 3）；cancel/approve 是迁移步骤 4 内容（本版返回明确未接线错误）。宿主 Agent 面仅 dsh_session。

## 参数契约

required: ["action"]：

| 参数 | 类型 | 语义 |
|---|---|---|
| action | string | list / get / create / send / cancel / approve（见下各节） |
| limit | integer | 仅 list：返回条数（默认 10，有效 1~100） |
| sessionId | string | get/send/cancel/approve 必传（形如 session-<uuid>，取自返回/清单；dsh-home 存在即读） |
| approvalId | string | 仅 approve：审批 id（审批通知里带；同一任务可能挂起多个审批，逐个应答） |
| outcome | enum | 仅 approve：allowed-once（放行单次，安全默认）/ rejected（拒绝该请求） |
| task | string | create/send 必传：任务描述/消息文本 |
| cwd | string | 仅 create 必传：沙箱工作目录（defaultCwd 配置已删除，每次调用显式指定） |
| timeout | number | 仅 create/send：任务超时（秒），缺省用配置 defaultTimeoutSec |
| agentPreset | string | 仅 create/send：agent 预设（standard/ptc/cordis/minimal） |
| reasoningEffort | string | 仅 create/send：推理强度（off/high/max，显式传才指定） |
| provider | string | 仅 create/send：显式 provider（显式即成为 DSH 新默认） |
| model | string | 仅 create/send：显式 model id（与 provider 一起传时覆盖 DSH 默认） |

## action=create：新建会话 + 提交任务

- **不允许传 sessionId**（新建；续会话用 send）
- **task + cwd 必填**（defaultCwd 配置已删除，无回退）
- **固定异步（v1 语义不变）**：立即返回 { content: 文本, details: { dsh: { action, sessionId, rpcId, taskId, status: "running", cwd } } }；任务在后台执行，完成/失败结果会作为后台结果投递回发起会话（Hana task 终态 → 宿主投递），Agent 结束回合即可收到；需要执行过程/最终结论时用 action=get（sessionId）读会话 jsonl
- 提交链路（v2）：ctx.tasks.create({callToken,...}) → 受管 DSH runtime 就绪 → session.create（新建：{cwd, agentPreset?}）→ selectModel（仅显式传 provider/model/effort 时；model-unavailable 报错降级不带 effort 重试）→ 写会话↔任务映射（<dataDir>/dshana/taskmaps/）→ session.prompt（mode=queue，立即 accepted）→ 受管 runtime task-bridge 订阅 DSH 会话事件并按映射回投任务状态/终态
- **终态映射（受管 runtime 内）**：api-session/status [sid, false] / session/event turn/end completed → 任务 complete；reason.kind=error 或出现过 api-session/error → 任务 fail
- 模型推理：DSH agent 经 provider adapter（@dsh-hanako/provider v2）调宿主 hana.models.stream（NDJSON；requestId 定向取消；done.assistant 签名回放跨 turn 保留）
- 同会话 send 由 App 侧串行化（同一会话顺序续跑，不并发）；执行超时/取消是步骤 4 内容

## action=send：续已有会话发消息

- **sessionId + task 必填**（续上次会话；cwd 沿用会话已有值——持久非活跃会话由提交层自动查询并以 session.create resume，活跃会话直接 prompt）
- 其余行为与 create 相同（提交 → task-bridge 回投终态）；同会话多次 send 按提交顺序排队执行

## action=cancel：取消任务

- **sessionId 必填**（create/send 返回/清单里带；取消一律显式传 sessionId）
- **迁移状态：App v2 步骤 4 内容，当前版本返回「未接线」错误**——接线形态：观察 Hana task canceled/aborted → 通知对应 DSH session 的 session.cancel（中止模型 requestId/工具/终端）→ 明确取消终态；只关本工作资源，不误停共享 runtime 的其他会话
- 幂等/卡死止损语义在步骤 4 接线后保留

## action=approve：应答会话挂起审批

- **sessionId + approvalId 必填**：sessionId 标识审批所属的任务会话，approvalId 标识该会话内具体的一个审批（同一任务可能挂起多个审批，逐个应答）
- **outcome**：allowed-once（默认，安全默认值：放行单次仅本次操作）/ rejected（拒绝该请求）
- **决策：看 args（具体执行了什么），不听 reason（model 自述不可尽信）**——合理放行，危险拒绝
- **迁移状态：App v2 步骤 4 内容，当前版本返回「未接线」错误**——接线形态：审批 = Hana task（requestApproval 以父 taskId 为范围）↔ DSH approval/request 瀑布帧映射；用户决定 → respondApproval 结算 → 终态 outcome 交给正确的 DSH 等待者（watch/对账）；拒绝/超时/重启都不隐式放行

## action=list：会话清单

解析 session_projcache.json（dsh-home 唯一事实源）：{ sessionId, title, cwd?, createdAt?, lastPromptAt?, usage?, turns?, steps?, llmMs? }，按 lastPromptAt 降序取最近 N 条。纯本地读，不调 DSH（runtime 未启动也可读）。

## action=get：凭 sessionId 直取会话内容

projcache 元数据 + summary（jsonl 最后一条 assistant/message 的 text，截断 ≤4000）。jsonl <dataDir>/dsh-home/sessions/<cwd-key>/<sessionId>/session.jsonl.zstd 是多帧 zstd 容器（帧 magic 0xFD2FB528），node:zlib 逐帧解压拼接。

## 使用场景

- 提交任务：create（新任务）或 send（续上次 sessionId——先 list/get 确认会话）
- 回看：list（清单）→ get（最终结论/内容）
- 止损/审批：cancel 与 approve 属迁移步骤 4，本版返回未接线错误

## 关联

- dsh_install 已退役：依赖安装在受管 runtime 首启自动完成（dataDir/runtime 安装区）
- v2 迁移：create/send 已接线（步骤 3：provider adapter + ctx.tasks 回投）；cancel/approve、UI/审批/取消链、旧数据迁移见 DESIGN.md「App v2 迁移状态」与 specs/DSHana迁移到HanaAppV2.md（步骤 4/5）
