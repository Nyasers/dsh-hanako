---
name: dshana
description: "dshana App（把 DeepSeek Harness 接进 Hana 的受管子代理执行器）的使用、排错与工具手册。触发场景：提交/查询/取消 DSH 任务、应答审批（dshana action=open/reply/close/get/approve 任一动作前）、DSHana 卡显示未启动/启动中/需要处理（三态自举页）、DSH 起不来或启动超时、DSH 任务失败排查、默认模型怎么配、DSH Web UI 打不开、主题跟随宿主、DeepSeek Harness 相关。遇到 dshana 相关需求优先读本技能再动手。"
---

# dshana 使用、排错与工具手册

DSHana 把 DeepSeek Harness（DSH）作为**受管子代理执行器**接进 Hana：App 加载后自动拉起一个受管 Node runtime，里面跑 DSH web 服务；DSH 前端以**同文档注入**方式挂进 DSHana 卡（不是 iframe 内嵌）。DSH 依赖随 App 包物化，**运行时不需要安装任何东西**。

## 架构一句话

`apply(ctx)` 注册工具与路由 → 微任务触发 `ctx.runtime.start` 拉起受管 runtime → 壳页轮询 boot 状态 → 就绪后取 DSH index 注入当前页面。DSH 与宿主之间：指令走 runtime 控制面（`/_control` + loopback HTTP RPC），模型推理走宿主 `ctx.models`，凭据不进 DSH 进程。

## 首次安装（无需配置）

- **无需装依赖、无需配 Node**：DSH 及其依赖树随包分发在安装目录 `node_modules`，启动只做 profile 种子化 + 服务监听。
- **无需配 API Key / 模型**：推理经受管 runtime 内 `hana.models` 发起，provider 凭据留在宿主。
- **默认模型**：读 DSH 自身配置（`DSH_HOME/settings.yaml` 的 `agent-default-model`）。
- **数据目录**：固定用 App 内置独立目录（App 数据目录下的 `.dsh`），开箱即用；共享已有目录 / 切换数据源暂不提供。
- `dshana(action="open")` 每次调用**必须显式传 `cwd`**。

## DSHana 卡三态

壳页轮询 `GET /api/apps/dshana/routes/dshana/boot-state`，按 `phase` 渲染：

| 状态 | 表现 | 怎么办 |
|---|---|---|
| 未启动（idle） | 说明 + 「启动 DSH」按钮 | App 加载后会自动拉起；也可手动点 |
| 启动中（starting） | 阶段时间线 + 日志尾滚动 | 等即可（首次含 profile 种子化） |
| 就绪（ready） | 页面装载 DSH Web UI | 直接用 |
| 需要处理（error / stopped） | 失败原因 + 原始错误折叠 | 看指引重试；端口占用会自动换端口 |

**读状态的出口**：`boot-state`（壳页与 Agent 都用；含 phase/error/userText）。App 侧不再写文件日志——日志一律走宿主 `ctx.logger`，受管子进程输出由宿主运行日志捕获。

## 工具手册：`dshana(action, …)`

宿主 Agent 面**仅此一个工具**（一个插件一个同名工具，动作以顶层 `action` 区分），装配见 `src/tools/index.ts`，各动作见 `src/tools/actions/<action>.ts`，每个文件 = 一个同名操作。

语义对齐 subagent：`open` ≈ `subagent`（创建即带任务）、`reply` ≈ `subagent_reply`（按句柄续同一个）、`close` ≈ `subagent_close`（收工）；`get` / `list` / `approve` 是本项目特色（subagent 没有）。

推理经受管 runtime 内 `hana.models` 发起，消耗宿主 provider 额度，provider 凭据留在宿主。

### 参数契约

顶层 `action` 必填，每个子命令只认自己的字段（`oneOf` 分支 + `additionalProperties: false`，所以 `open` 的 schema 里没有 `approvalId`）。

| action | 必填 | 可选 | 语义 |
|---|---|---|---|
| `open` | task, cwd | label, timeout, agentPreset, reasoningEffort, provider, model | 开一个 DSH 子代理并交首件活（新建会话 + 立即提交首条 prompt） |
| `reply` | task | taskId 或 sessionId（二选一）, timeout, agentPreset, reasoningEffort, provider, model | 往同一个子代理续发消息 |
| `close` | 无 | taskId 或 sessionId（至少一个） | 取消正在跑的任务 |
| `get` | 无 | taskId 或 sessionId（至少一个） | 回看该会话最近一轮的最终结论 |
| `approve` | approvalId | outcome, taskId 或 sessionId | 应答挂起审批 |

> `list`（会话清单）的实现保留在 `actions/list.ts`，但**暂未注册到工具面**（2026-09-13）。

**句柄与凭证**：`taskId`（open/reply 返回）与 `approvalId` 是**句柄路径**，工具自己解析会话并按宿主记录的来源会话校验归属；`sessionId`（形如 `session-<uuid>`）是**凭证路径**，显式传入即视为"我要跨对话操作"，跳过归属校验。

### action=open：开一个子代理并交首件活

- **task + cwd 必填**；不允许传 `sessionId`（续会话用 `reply`）
- **固定异步**：立即返回 `{ content, details: { dsh: { action: "open", taskId, sessionId, rpcId, status: "running", cwd }, card } }`；任务在后台执行，完成/失败作为后台结果投递回发起会话，Agent 结束回合即可收到；要看过程或最终结论用 `get`
- **句柄**：返回值里的 `taskId` 就是后续 `reply` / `close` / `get` 用的句柄，优先用它
- `label` 是显示名（宿主任务列表与结果通知里可见），缺省按动作给默认前缀
- 提交链路：`ctx.tasks.create` → 受管 runtime 就绪 → `session.create` →（显式传 provider/model/effort 时才 `selectModel`）→ 会话↔任务认领（控制面 `bind-task`，落会话日志投影）→ `session.prompt`（queue）→ runtime task-bridge 回投终态

### action=reply：续同一个子代理

- **task 必填**；目标二选一：`taskId`（句柄，默认推荐）或 `sessionId`（凭证，跨对话用）
- cwd 沿用会话已有值（持久非活跃会话自动 resume）
- 同会话多次 reply 由 App 侧串行化，按提交顺序排队，不并发

### action=close：取消正在跑的任务

- 目标二选一：`taskId`（句柄，默认）或 `sessionId`（凭证）
- 链路：通知 DSH `session.cancel`（中止模型流 / 工具 / 终端）→ 收敛为明确取消终态；只停本工作，不影响共享 runtime 上的其他会话
- **与 subagent_close 的差异**：DSH 会话是持久的、随时可 resume，没有实例槽位这回事，`close` 只取消当前活动任务，不"释放实例"
- 句柄反查不到（任务已被回收 / 映射已清理）会**明确报错**，不会拿猜出来的会话继续操作

### action=get：回看某一轮最终结论

| | |
|---|---|
| 目标 | `taskId`（句柄）或 `sessionId`（凭证） |
| 取数 | `session/list` 定该会话读位点 `projections.asOfSeq` → `session/page` 在该 cut 上取尾部一窗 records |
| 口径 | **最后一次 user 消息之后、最后一次 assistant 输出**就是本轮结论（一次 open/reply = 一轮）；文本截断 ≤4000 |

会显式标注、不静默篡改的情形：本轮尚无输出（退到更早的最近结论）／窗口内无 user 消息／该轮被中断／**该轮以错误结束**（模型或工具报错时 DSH 只写 `attempt` + `turn/end`，这里把错误原因透出来）／还有更早轮次未读。

注：会话日志已是 V3 格式，**不再自读 `session_projcache.json` / `session.jsonl.zstd`**（格式演进交回官方）；DSH 未启动时 list/get 不可用。

### action=approve：应答挂起审批

- **approvalId 必填**（审批通知里带；同一任务可挂起多个审批，逐个应答）——它是唯一句柄，会话由工具解析（句柄路径会校验归属）；`sessionId` 仅在"我要跨对话"时显式传
- **outcome**：`allowed-once`（默认，放行本次）/ `rejected`（拒绝）
- **决策看 args（具体要执行什么），不听 reason（模型自述不可尽信）**：合理放行，危险拒绝
- 审批超时未应答按 `approvalTimeoutSec` 自动拒绝（本 App 缺省 30 秒；显式设 0 则禁用自动拒绝）。注意宿主自身的 `timeoutMs` 默认是 0（不禁用即不超时）——30 秒是 App 侧策略

### list（会话清单，冻结禁用）

`actions/list.ts` 是官方 `session/list` 的只读封装（带 `title`/`cwd`/`updatedAt`/`lastPromptAt`/turns/usage 等字段），**冻结禁用**（2026-09-13）：任务绑定语义下会话靠句柄定位，不做 cursor / sourceId 那套"先 list 发现再操作"的配套（sourceId 还另有一层理由：它本来只为"防源漂移"，而数据源切换入口已暂撤回 503）。需要"列会话"时改走宿主提供给 Agent 的内置任务查询工具（模型侧，本环境是 `check_pending_tasks`）——dshana 的 open/reply 建的就是本会话的后台任务，本来就出现在那份清单里，不需要本工具再开一扇只读门。

要重新启用本模块：在 `src/tools/index.ts` 的 import、ACTIONS 与 description 里加回即可。

### 典型用法

- 开活：`open`（新任务）或 `reply`（往已有子代理续；先 `get` 确认）
- 回看：`get`（最终结论）
- 止损：`close`；越界权限：`approve`

`sessionId` 即访问凭证；`get` 纯本地读会话文件，DSH 未启动时不可用。

## 主题

只有 DSH 主题偏好为 **system** 时跟随宿主配色（经 `@dshana/theme` 子插件注入）；在 DSH 内显式选 light/dark 时完全用 DSH 自己的主题，宿主配色不介入。

## 排错表

| 现象 | 原因 | 处理 |
|---|---|---|
| 卡在「启动中」很久 | profile 种子化 / 首次 boot 较慢 | 看日志尾；`boot-state` 的 `logTail` 会滚动显示进度 |
| 状态转「需要处理」 | runtime 启动失败 | 看 `error.userText` 与原始错误；日志定位 |
| 提示端口被占用 | 端口竞争 | 会自动换随机端口重试；持续失败看日志 |
| DSH Web UI 打不开但状态就绪 | 注入失败 / surface 票据缺失 | 重开卡；反复出现查中继前缀与 surface 授权 |
| `dshana` 报 runtime 未就绪 | DSH 还没起来 | 等就绪或点「启动 DSH」；持续失败看 boot 状态 |
| 默认模型改了不生效 | DSH 内存态与文件不一致 | 重启 DSH（停止后重新启动）再确认 |
| 主题没跟随宿主 | DSH 主题偏好是 light/dark 而非 system | 在 DSH 设置里改回 system |
| bash 报 `E_ACCESSDENIED` | DSH bash 沙箱 Windows 限制 | 改用文件系统工具（write/read/edit） |

## 已知限制

- **升级 DSH = 装新 App 包 + 重启宿主**：DSH 版本随 App 声明，无独立升级通道。
- 拆窗、钉回、切页面都不停 DSH 后台；停 App 或退出 Hana 才由宿主回收进程。
- 越界权限默认走审批：deferred 通知 → `dshana(action="approve", …)` 应答；`approvalTimeoutSec` 内无人应答自动拒绝（缺省 30 秒；仅显式设 0 禁用）。
- 任务默认新建会话；`reply` 传 taskId 句柄或 sessionId 凭证续用（resume）；会话与账本在 App 数据目录内（不碰 `~/.dsh`）。
