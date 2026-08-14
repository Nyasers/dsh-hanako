# DSHana

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）接入 Hana，作为进程外 subagent 使用。任务执行走 **dsh web host**（`--profile web`），dsh 官方 Web UI 可见任务会话，账本锁进插件数据目录。

## 安装（人类版，四步）

1. **拖入 zip 包**：把 `dsh-hanako-v0.7.1.zip` 拖进 Hana 插件安装界面（或解压到插件目录），插件即完成装载
2. **配置 apiKey**：打开插件设置（DSHana），在「DeepSeek API Key」填入你的 key（设置界面可见，Agent 不代填）
3. **让 agent 完成安装**：对你的 Agent 说「帮我完成 DSHana 的安装」。Agent 会按插件自带技能完成剩余步骤：探测本机 node 路径并写入配置、在插件目录 npm ci 部署依赖（约 30~45 秒，无人值守）、把默认工作目录设为你的项目目录
4. **重启 Hana**：核心配置在插件加载时注入，重启后生效。重启后让 Agent 跑一个最小 `dsh_run` 试任务验证，即可正常派活

安装遇到问题，把报错丢给 Agent 即可（技能里有完整排错表）。

## 原理（v0.4.0 架构）

- 插件加载（onload）即拉起常驻 dsh web host：`node <插件根>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --port <webPort>`，DSH_HOME 指向 `<插件数据目录>/dsh-home`（会话/存储/设置全部落插件目录，不碰 `~/.dsh`）
- `dsh_run` 工具每次调用经 `/api` 网关：`session.create` → `session.prompt` → WebSocket `events.mux` 订阅事件流 → 收集最终输出
- 会话按 workspace 落盘 `dsh-home/sessions/<workspace>/<sessionId>/session.jsonl.zstd`，**dsh Web UI（http://127.0.0.1:3080）实时可见任务会话**（含运行中状态）
- 卸载/重载/禁用时回收 web host 进程；启动失败记录 `webLastError`（fire-and-forget 不阻塞 onload，工具调用时重试）

## 工具

`dsh_run(task, cwd?, timeout?, wait?, agentPreset?, reasoningEffort?, sessionId?)`

- `task`：任务描述，作为用户消息发给 dsh 编码 agent
- `cwd`：沙箱工作目录（bash 与文件系统工具的活动范围），默认 `defaultCwd`；resume 时（传了 `sessionId`）可省略，沿用会话已有 cwd
- `timeout`：超时秒数，默认 `defaultTimeoutMs`
- `wait`：false（默认）= 异步，立即返回，完成后宿主唤醒、结果后台送达；true = 同步等结果直接返回
- `agentPreset`：agent 预设模式 `standard`（默认）/ `code` / `cordis` / `minimal`，缺省用插件配置 `agentPreset`（v0.5.2 起）
- `reasoningEffort`：推理强度 `off` / `high`（默认）/ `max`，缺省用插件配置 `reasoningEffort`（v0.5.3 起）
- `sessionId`：复用已有 dsh 会话（resume，v0.5.5 起）：传上次任务的 sessionId（dsh_run 回调/卡片里带，或 dsh Web UI 会话列表）则在该会话上继续，agent 保留上文（上下文继承，省上下文重建与时间）；目标会话应已空闲（上次任务已结束）。无 sessionId 时新建会话（原行为）

权限：`external_side_effect`，Auto 模式下调用会送审。

`dsh_approve(opId, approvalId, outcome?)`

- 应答 dsh 任务挂起的权限审批（approval/policy=ask 触发 approval/requested 时任务等待应答）
- `opId` + `approvalId`：来自宿主 deferred 通道的 dsh-approval 通知（同一任务可挂起多个审批，逐个应答）
- `outcome`：`allowed-once`（默认，仅放行该次）/ `rejected`（拒绝，agent 改用其他方式）
- 内部经 `POST /api/respond` 应答（client-response 信封，rpcId 路由 web host pending 表）；无人应答时审批仍可在 dsh Web UI 人工处理

权限：`external_side_effect`。

`dsh_cancel(opId)`

- 取消一个已派发的 dsh 任务（主动止损）：按 `dsh_run` 返回的 `opId` 请求取消运行中的任务
- 内部调 `POST /api/session.cancel`（client-request 信封，rpcId 回显校验）中断该会话，dsh agent 收到中断后任务以 aborted 终态收尾（deferred 唤醒带「dsh_run 已取消」）
- 已结束的任务幂等返回提示无需取消；`opId` 只可取消本会话近期提交的任务（op 快照内存保留最近 50 条）
- 与超时（`timeout`）互补：误派/卡死任务可主动止损，配合既有审批暂停机制

权限：`external_side_effect`。

`dsh_ops(status?)`

- 查询 dsh 任务历史（op 快照，v0.5.7 起）：不传返回全部（最多 50 条，最新在前），传 `status` 过滤（`running` / `ok` / `error` / `interrupted`）
- 每条返回 opId / 任务（前 80 字符）/ 状态 / 耗时 / usage 摘要（字段存在才带），供对账与回溯
- **历史已落盘**（v0.5.7 起，v0.7.1 改 JSONL，v0.7.2 去 output 化）：op 快照写 `<数据目录>/ops.jsonl`（JSON Lines 增量追加：终态只 append 一行，300ms 防抖，写失败静默不阻塞主流程），插件启动时自动恢复——**重启后仍可查历史任务与结论**；v0.7.2 起终态行不再落盘完整 output（完整输出在内存 op 快照/卡片；重启后经 `sessionRecord` 链接字段指向 dsh-home/sessions/<...>/session.jsonl.zstd 完整会话日志回溯，单一事实源）；重启时仍为运行中的任务标记为 `interrupted`（重启即中断，符合事实）；旧版 `ops.json`（JSON 数组）首次启动自动迁移

权限：只读（仅读本插件内存中的 op 快照，不调外部 API，无副作用）。

`dsh_search(query)`

- 跨会话内容搜索（v0.5.10 起）：给 `query` 关键词（1~500 字符，自动 trim），经 dsh web host `session.search` RPC 跨全部历史会话内容匹配
- 返回命中的会话（`sessionId` + 内容摘要 `snippet` ≤240 字符，最多 20 条 + `hasMore` 指示是否还有更多）
- 命中后可用 `dsh_run` 的 `sessionId` 参数 resume 该会话继续（上下文继承，知识复用）

权限：只读（session.search 查询，不改变任何会话）。

## 任务反馈卡片

工具返回时宿主立即渲染 iframe 卡片（`details.card` 机制，与 download-progress 同构），**异步模式下无需等任务完成**：

- 提交即显示「运行中」卡片，实时刷新状态与耗时
- **两级输出（PTC 式压缩）**：摘要区默认展开（运行中为输出尾部实时预览；完成后为最终结论摘要），完整输出超长时经「完整输出 (N 字符)」按钮懒加载（`/ops/output`，默认折叠，加载后缓存不再重复请求；运行中展开则每约 3 秒自动刷新）
- **回调压缩**：异步完成回调默认只带最终结论摘要（`callbackMode=summary`，锚点 = dsh 最后一条 assistant 消息），完整输出保留在卡片 op 快照与 dsh Web UI（sessionId 定位），不占 Agent 上下文；设 `callbackMode=full` 可回传全量
- 任务描述、cwd、开始时间、超时配置
- **Token 账目**（v0.5.6 起）：任务完成后（ok/error 终态）卡片详情区显示 usage 统计 `Token: in / out / cache / thinking`（未收集到 usage 时不显示该行），同步返回与异步回调均带 usage，可对账
- 失败时显示错误信息（对话主区同时有错误文本）

完成/失败时经宿主 deferred 通道唤醒 Agent（结果后台送达），无需轮询等待。

## 审批自动化（v0.5.0 起，v0.5.12 收敛为唯一流程）

dsh 会话默认 `approval/policy=ask`：agent 请求越界权限（如提权执行命令）时发出 approval/requested，任务挂起等应答。插件在事件流捕获审批帧（保留 web host 路由所需的 rpcId），把审批上下文存进 op 快照，并经宿主 deferred 通道（独立 taskId，不占任务完成通道）投递 `dsh-approval` 通知唤醒 Agent；Agent 收到后调 `dsh_approve` 工具应答（allowed-once / rejected），任务继续。无人应答时兜底在 dsh Web UI 人工处理。

**唯一审批流程（v0.5.12 起）**：审批挂起 → 插件通知 Agent（**附命令/路径原文**，tool/call 参数按 callId 反查；v0.5.13 起 code preset 子调用参数经 tool/code-dispatch-start 精确缓存）→ Agent 用 `dsh_approve` 应答 → 无人应答超时自动拒绝。**审批模式（manual/auto）与白名单（autoApprovePatterns）已移除**——所有审批一律过 Agent 决策，无自动放行。

**超时自动拒绝（v0.5.8 起，v0.5.12 起为唯一审批配置 `approvalTimeoutMs`）**：审批挂起超过 `approvalTimeoutMs`（默认 30000ms = 30 秒；语义为应答方失联检测——正常应答几秒内完成，30s 无应答可判失联）无人应答时自动 `rejected`（op 快照标记 `auto:"expired"`），agent 收到拒绝后改用其他方式，任务不再无限挂起；宿主重启场景由会话中断兜底（web host 随宿主重启，挂起审批随进程消亡），不走超时拒绝；`approvalTimeoutMs: 0` 禁用超时拒绝（保持原行为）。配置直读 config.json，改后对新审批立即生效。

## dsh Web UI（随插件生命周期管理）

配置 `webPort`（默认 3080）时，**插件加载即拉起** `dsh --profile web`（dsh 官方浏览器 UI，观察任务会话、模型配置、密钥管理），卸载/重载时一并回收。设 `webPort: 0` 可关闭。

## 事件流通道（WebSocket，勿回退 SSE）

dsh 的 `/api/events.mux` **要求 WebSocket 升级**：GET 返回 `426 Upgrade Required`（响应头 `upgrade: websocket`），用 fetch + SSE 解析是错的。事件流必须 `ws://127.0.0.1:<port>/api/events.mux`（Node 22+ 内置全局 WebSocket）：

- 连接后收到 `session/subscribed` 帧（`{type, sessionId, lastSeq}`，sessionId 是本连接绑定的会话，**不是**会话清单）
- 之后收到各会话事件（assistant/chunk 等），帧为 JSON，`payload` 即 MuxFrame
- 订阅按连接绑定，会话列表请从 `dsh-home/sessions/` 落盘目录或 Web UI 获取

## 前置（v0.6.0 轻量化：依赖按需部署）

- **依赖不随包（v0.6.0 起）**：zip 只含代码 bundle（根 index.js + tools/，标准插件形态）+ 配置 + 技能 + lockfile（约 0.1MB），`node_modules` 不再随插件分发。dsh 依赖树（`@deepseek-ai/dsh` + node-pty/koffi 原生模块，约 246MB）由 **Agent 在部署时 npm ci 到数据目录 `dsh-pkg/`**（详见插件技能 `skills/dsh-hanako/SKILL.md`「依赖自主部署」章节；已验证 npm ci 无人值守 35~45s，零脚本批准、无编译工具链——koffi 走官方预编译分包 `@koromix/koffi-<platform>`、node-pty 发布自带 prebuilds）。registry 不通时切镜像（如 `--registry=https://registry.npmmirror.com`）。
- **依赖位置解析链**：`<dataDir>/dsh-pkg`（Agent 部署，优先）→ 插件安装目录 `node_modules`（兼容旧形态）；`package-lock.json` 锁死版本（koffi 3.1.4 等，含 integrity 校验）。
- **插件本体 rspack 打包（v0.6.0 起，v0.6.1 修正结构）**：`scripts/build.mjs` 把 index.js + 5 工具 bundle 到 `dist/`（中间产物，ESM、压缩、import.meta.url 运行时语义）；`scripts/pack.mjs` 打包时铺平到标准位置（根 `index.js` + `tools/`），**交付物无 dist/ 目录**，manifest 指向标准路径；构建工具（@rspack/core）声明为 devDependencies（构建契约，Agent 部署 npm ci --omit=dev 不安装），本地构建走 RSPACK_ENV 独立构建环境或本机 dev 依赖。
- Node 24+（fnm 管理的 node.exe 绝对路径，`nodePath` 配置）
- **API key 通过插件配置项 `apiKey` 提供**（插件设置界面填写，宿主写入 `config.json`）；不填时回退文件读取（dsh-home/.credentials.yaml → ~/.dsh/.credentials.yaml）

## 凭据解析（resolveApiKey，绕宿主配置快照）

宿主注入给工具调用的 `ctx.config` 是**插件加载时的配置快照**——之后在设置界面填的 key 不会进快照。因此 key 解析优先级：

1. 宿主注入的 `cfg.apiKey`
2. **直接读 `dataDir/config.json` 的 `global.apiKey`**（宿主写的配置文件，改配置即时生效，无需重启）
3. 文件兜底：dsh-home/.credentials.yaml → ~/.dsh/.credentials.yaml

## 架构说明

- **插件本体 rspack bundle（v0.6.0 起）**：`index.js` + `tools/*.js` 源码经 `scripts/build.mjs` 打包到 `dist/`（多入口 ESM、production 压缩、`output.library: {type:"module"}` 保留具名导出、构建后处理把静态化 `import.meta.url` 恢复运行时语义），`scripts/pack.mjs` 铺平到标准位置交付（根 `index.js` + `tools/`，无 dist/）。工具逻辑集中在 `tools/dsh-run.js`（任务执行），审批应答在 `tools/dsh-approve.js`（共享 `globalThis.__dshHanako` 单例的 op 快照，不拆共享 lib）。Hana 以带 `?t=` 时间戳的 URL 加载 tools 文件（热更新）。
- **进程单例挂 `globalThis.__dshHanako`**：`index.js` 卸载清理时读取（不 import 插件文件，避免读到旧模块缓存）。
- **宿主 tools 模块缓存**：宿主按插件 id 缓存 tools 模块，dev 槽位与正式版同 id 时 enable 会复用缓存——**改代码后必须重启 Hana 才加载新 tools**（工具血不换，只有重启换）。
- **依赖随插件走（正式 npm 声明）**：`package.json` 声明 `@deepseek-ai/dsh`，`node_modules/`（186MB 解压 / 57MB zip）随 zip 分发，v0.4.2 起不再保留任何本地仓库/旧版配置兼容项。

## 已知限制

- **bash 工具在 Windows 上可能 `E_ACCESSDENIED`**（dsh-bash-sandbox 创建 bash 服务实例失败，属 dsh 沙箱环境限制，非本插件问题）。文件系统工具（write/read/edit）在 workspace-write 沙箱下工作正常，Windows 上优先用文件系统工具。
- 越界权限请求默认走**审批自动化**：插件捕获 approval/requested（保留 rpcId）→ deferred 通知 Agent → `dsh_approve` 工具应答（allowed-once/rejected）；无人应答时兜底 dsh Web UI 人工审批（v0.5.0 起，v0.4.2 曾移除无效的 `permission` 自动应答配置）。
- **同步模式（wait=true）无审批通知**：同步调用时 Agent 在等结果，审批挂起只能靠 dsh Web UI 人工处理（或超时）。长任务建议用异步模式。
- 默认每个任务新建独立 session；传 `sessionId` 可复用已有会话（resume，v0.5.5 起，跨任务继承上下文）。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `apiKey` | 空 | DeepSeek API Key（推荐，插件设置界面填写）。安装后必填（dsh 走 DeepSeek 官方 API，无 key web host 起不来），改后重启 Hana 生效 |
| `model` | `deepseek-v4-flash` | dsh 任务模型 id（provider 固定 deepseek-official，模型名 pass-through 直传）：内置 `deepseek-v4-flash` / `deepseek-v4-pro`，可填其他 DeepSeek 模型 id；改后对新任务立即生效（直读 config.json，无需重启） |
| `agentPreset` | `standard` | dsh_run 提交任务的默认 agent 预设：standard=完整编码 agent（默认）/ code=工具呈现批量调用（适合大型编码任务）/ cordis=可读写运行时的 agent / minimal=固定提示词精简 agent；工具调用可显式覆盖；改后对新任务立即生效（直读 config.json） |
| `reasoningEffort` | `high` | dsh_run 提交任务的默认推理强度：off=关闭思考 / high=高（默认）/ max=最高；工具调用可显式覆盖；改后对新任务立即生效（直读 config.json） |
| `approvalTimeoutMs` | `30000` | 审批唯一配置（v0.5.12 起）：审批挂起超过该时长无人应答自动 rejected（应答方失联检测，宿主重启场景由会话中断兜底）；0=禁用；改后对新审批立即生效（直读 config.json） |
| `nodePath` | fnm node 24.18 绝对路径 | 启动 web host 的 node.exe（需 Node 24+）。注意：默认值可能指向打包者机器路径，安装后请改为本机 node 路径，改后重启 Hana 生效 |
| `defaultCwd` | `E:\Hanako\workspace` | 默认沙箱工作目录（安装后建议改为本机实际目录） |
| `defaultTimeoutMs` | 600000 | 默认超时（毫秒） |
| `webPort` | 3080 | dsh Web UI 端口：>0 插件加载即拉起 web host（卸载一并回收），0 关闭 |
| `callbackMode` | `summary` | 异步完成回调输出体量：summary=只带最终结论摘要（默认，省上下文）/ full=全量（上下文占用大） |

## 版本历史

- **v0.7.3**（2026-08-14）：修复 v0.7.2 sessionRecord 链接迁移盲区——`serializeOpRow` 构造 `sessionRecord` 改为经 `resolveSessionRecord` **存在性校验 + 扫描兜底**：先按 `<projectKey(cwd)>/<encodeSegment(sessionId)>/` 探测（新任务 `sessionCwd` 恒正确，一次 existsSync 直接命中，零额外扫描成本）；未命中（projectKey 漂移——旧 v0.7.1 行无 `sessionCwd`，loadOps 回写迁移回退 `op.cwd`，而 resume 任务 op.cwd 是用户传入/defaultCwd，与会话实际落盘目录可能不一致）再按 encodedId 扫描 `sessions/*/` 定位真实路径；仍找不到则**省略链接**（诚实缺失，优于坏链接——完整记录仍可经 sessionId 在 dsh Web UI / sessions 目录定位）。兼容 zstd / compression:none 两种会话文件后缀。新任务（`sessionCwd` 正确）不受影响；找不到真实文件时不构造链接也不阻塞主流程。

- **v0.7.2**（2026-08-14）：ops.jsonl 终态行不再落盘 output——完整输出（哪怕截断）不再进账本，改为存 `sessionRecord` 链接字段指向 dsh 会话完整记录 `dsh-home/sessions/<projectKey(cwd)>/<encodeSegment(sessionId)>/session.jsonl.zstd`（完整输出仍在内存 op 快照/卡片；重启后经链接回溯完整会话日志，单一事实源）。op 快照新增 `sessionCwd`（session.create 后记录，resume 时与 op.cwd 可能不一致，构造链接用）；路径算法复刻 `@deepseek-ai/dsh-session-persistence-jsonl@0.1.0-rc.6`（依赖被 package-lock.json 锁死 rc.6，漂移风险可控；链接失效不影响主流程——完整记录仍可经 sessionId 在 dsh Web UI 定位）。恢复端逻辑不变（逐行解析 + opId 去重照旧），恢复后回写自动把旧行按新格式重写（output 丢弃、sessionRecord 若可构造则补上）——期望的迁移行为。dsh_ops 行为不变（仍读内存快照）。

- **v0.7.1**（2026-08-14）：op 历史落盘 JSON 改 JSONL。`<数据目录>/ops.json`（整文件 JSON 数组，每次终态全量重写）→ `ops.jsonl`（JSON Lines 增量追加：终态只 append 一行，O(1) 不再全量序列化历史；dirty 集合只写变更 op，300ms 防抖不变）。恢复端：逐行解析，单行损坏跳过只丢该条（旧格式整体 JSON.parse 失败则全丢）、同一 op 多行（中间态 sessionId 行 + 终态行）按 opId 去重留最后一行；恢复后（interrupted 标记 + OP_KEEP 裁剪）回写对齐文件，压缩历史行、持久化 interrupted 标记（重启不再重复标记新时间戳）、防文件无界增长。旧版 `ops.json` 首次启动自动迁移为 jsonl 并删除旧文件。dsh_ops 行为不变（仍读内存快照）。

- **v0.7.0**（2026-08-14）：改名 **DSHana**——插件 id 改为 `dsh-hanako`（工具全名前缀随之变为 `dsh-hanako_dsh_*`），显示名 DSHana，内部单例（`globalThis.__dshHanako`）/日志前缀/ruleId 全部统一；技能目录随 id 改为 `skills/dsh-hanako/`；README 新增人类版安装步骤（拖 zip → 配 apiKey → 让 agent 安装 → 重启）。配置数据目录随 id 变更为 `plugin-data/dsh-hanako/`（旧 dsh-runner 数据目录可手动迁移）。

- **v0.6.2**（2026-08-14）：配置默认值修正——manifest 不再预设路径类默认值。`nodePath`/`defaultCwd` 的 default 从打包者机器路径（`E:\Dev\fnm\...`/`E:\Hanako\workspace`）改为空字符串：config.json 由宿主在设置界面填写后生成、不随包分发，插件包不携带配置、不预设指向任何机器的路径；未配置时分别报 `node 可执行文件不存在` / `cwd 不能为空` 引导填写。SKILL 首次配置章节同步修正（删除「默认指向打包者机器」表述）。已配置实例不受影响（宿主快照优先于 default）。

- **v0.6.1**（2026-08-14）：包结构修正——产物去掉 dist/ 目录，恢复标准插件形态。v0.6.0 把 bundle 输出到 `dist/` 并让 manifest 指向 `dist/index.js` / `dist/tools/*.js`，导致宿主按标准结构（根 `index.js` + `tools/`）加载时工具不可用。v0.6.1：bundle 产物经 `scripts/pack.mjs` 铺平到标准位置（`dist/index.js` → 根 `index.js`，`dist/tools/*.js` → `tools/*.js`），manifest 回滚为 `entry=index.js` + `tools=./tools/*.js`（与 v0.5.x 同构）；zip 结构 = 标准插件包（无 dist/），宿主加载零变化。构建产物 dist/ 仅为中间产物（`scripts/build.mjs` 输出），不进入交付物。**依赖瘦身废弃（本版起）**：依赖完整安装（npm ci 后约 246MB），不再做瘦身——瘦身是 zip 随包分发时代的体积优化，轻量化后依赖不随包，失去意义；`scripts/slim-dsh-pkg.mjs` 已删除。

- **v0.6.0**（2026-08-14）：轻量化分化——依赖剥离 + 插件本体 rspack 打包 + Agent 自主部署依赖闭环（**注：v0.6.0 包结构有缺陷，dist/ 目录导致工具加载失败，已被 v0.6.1 修正**）。① **交付物从 57MB → 0.1MB**：`node_modules` 不再随包，zip 只含 bundle + manifest + package.json/lockfile + skills + app/routes/config；② **依赖装到数据目录**：Agent 部署时 npm ci 到 `<dataDir>/dsh-pkg`（锁 version 由 package-lock.json 保证，含 integrity；已验证无人值守 35~45s，零脚本批准、无编译工具链——koffi 官方预编译分包、node-pty 自带 prebuilds），依赖位置解析链 `dataDir/dsh-pkg` 优先 → 插件根兑底；③ **rspack 构建链**：`scripts/build.mjs`（多入口 ESM、`usedExports/sideEffects` 关闭防空壳、`output.library module` 保留具名导出、构建后处理恢复 `import.meta.url` 运行时语义），`scripts/pack.mjs`（一键 build + 铺平打包 + zip + SHA256）；④ 依赖缺失报错引导 Agent npm ci（含 registry 镜像切换）。

- **v0.5.15**（2026-08-14）：SKILL 增补「依赖自主部署」闭环（Agent 可无人值守完成）。经 POC 实测验证：`npm ci` 35s 完成（528 包），零脚本批准、无编译工具链需求——koffi 走官方预编译分包（`@koromix/koffi-<platform>`）、node-pty 发布自带 prebuilds（win32 走 ConPTY，spawn-helper 仅 darwin 需要）、npm 11 默认阻止 install scripts 不影响产物；`package-lock.json`（v3，588 包）锁死依赖版本（koffi 3.1.4 无漂移）。SKILL.md 新增章节：依赖缺失检测 → npm ci 部署命令（node 不在 PATH 的绝对路径姿势）→ 产物验证 → **registry 镜像切换**（默认源不通/慢时 `--registry=https://registry.npmmirror.com`，镜像只影响 registry 层，无独立二进制下载）→ 部署后重启 Hana；排错表依赖类错误统一指向 npm ci。

- **v0.5.14**（2026-08-14）：首次安装可配置闭环（信息只走有效渠道，README 不做引导——README 非 Agent 信息源，配置引导只经 skills/ 与 manifest description）。① 新增插件自带技能 `skills/dsh-hanako/SKILL.md`（Agent 知识注入渠道，随插件分发，装好即出现在 Agent 技能库）：含首次安装配置清单（nodePath 必改——默认值可能指向打包者机器路径、apiKey 必填——Agent 不代填引导用户在设置界面填、defaultCwd 建议改）、配置自检与验证步骤、工具速查、审批应答流程、排错表、已知限制。② manifest 的 nodePath/apiKey description 补充首次配置提示（设置界面可见，改后重启生效）。

- **v0.5.13**（2026-08-14）：审批 args 通知实跑修复。v0.5.12 实跑暴露：code preset 下 run_code 内联的工具调用（write/read）以子调用形式派发，参数在 `tool/code-dispatch-start` 事件而非独立 `tool/call` 帧，且审批帧 callId 带 `:code:N` 后缀与根调用不一致，导致按 callId 反查 miss、审批通知 args 为 null。修复：① 监听 `tool/code-dispatch-start` 按 subCallId 缓存子调用参数（精确命中审批帧 callId）；② 反查 miss 时剥 `:code:N` 后缀回退 run_code 根调用（args 为整段代码原文，兜底呈现）。附：本轮实跑中 30s 无人应答触发超时自动拒绝，approvalTimeoutMs 兜底在真实链路验证生效。

- **v0.5.12**（2026-08-14）：审批配置收敛 + 移除可选配置项。① 移除 `approvalMode`（manual/auto 模式切换）与 `autoApprovePatterns`（内容级白名单自动放行）两个配置项：审批形态固定唯一——挂起 → deferred 通知 Agent（**附 tool/call 参数原文**，命令/路径按 callId 从缓存反查，Agent 看「具体执行了什么」决策而非只听 model 自述）→ Agent 用 dsh_approve 应答；无人应答超时自动拒绝（`approvalTimeoutMs` 成为唯一审批配置，默认 30s 应答方失联检测，0=禁用）。② 移除「（可选）」配置项 `dshPkgDir` / `credentialsPath`：dsh 包固定用插件安装目录（依赖随插件分发），凭据固定走 apiKey → 插件数据目录 dsh-home/.credentials.yaml → ~/.dsh/.credentials.yaml 链，无需配置。③ config.json 残留旧键（approvalMode/autoApprovePatterns）不再读取。

- **v0.5.11**（2026-08-14）：会话全文搜索默认启用（dsh_search 开箱即用）。dsh 上游默认 `session-query-sqlite` 配 `openAt: never`（全文搜索 opt-in，base 与 web-app 两层 patch 均为 never），v0.5.10 的 dsh_search 装上会报 `SESSION_QUERY_SEARCH_DISABLED`。本次新增 `config/session-query.patch.yml` overlay（`openAt: first-search` + `path: ':memory:'`），web host 启动（dsh-run.js spawn）显式传 `--patch`（launcher flag，位于 `--port` 之前；patch 文件缺失时优雅降级不阻断启动）。效果：插件作为部署方默认启用搜索，`first-search` 推迟 SQLite 导入/句柄打开到首次搜索（启动输出保持干净），索引进程内自会话日志重建（历史日志持久，重启后首次搜索重新索引）；`dsh_search` 无需额外配置即可用

- **v0.5.10**（2026-08-14）：跨会话内容搜索工具 dsh_search。新增 `dsh_search(query)` 工具：经 dsh web host `session.search` unary RPC（client-request 信封，rpcId 回显校验）跨历史会话内容搜索——query trim 后 1~500 字符、不得含 NUL（与 host schema 对齐），响应 value `{ items: [{sessionId, snippet}], hasMore }`（snippet ≤240 Unicode code points，最多 20 条 + hasMore）；命中后可用 dsh_run 的 sessionId 参数 resume 会话继续（上下文继承，知识复用）；只读查询不改变任何会话

- **v0.5.9**（2026-08-14）：白名单升级为内容级匹配 + 审批超时默认收敛。白名单：事件流缓存 `tool/call` 帧的参数原文（模块级 `toolCallCache`，key=`opId::callId`，value=`{name,args}`，兼容 session/event 包裹事件与直发帧两种结构，运行期缓存不落盘，任务终态 finally 随 approvalTimers 一并清理）；审批自动放行判定由「toolName 精确 + reason 子串」改为内容级：匹配源按优先级为 tool/call 参数原文（按 approval.callId 反查，命令/路径原文，真正执行了什么）→ reason（model 自述，降级用）→ toolName（工具名，最低优先级兜底——bash/pwsh 都能执行任意命令，命中工具名不代表命令安全），任一 pattern 子串命中任一源即自动 allowed-once（如 `["_tmp/"]` 只放行目标路径含 `_tmp/` 的写、`["git status"]` 只放行该命令）；未命中（notify + 超时计时器）与 manual 模式行为不变，approval/resolved 帧、approvalTimers、respondApprovalLocal 等机制不动。审批超时默认由 120000ms 收敛为 30000ms（语义定位「应答方失联检测」：正常应答几秒内完成，30s 无应答可判失联；宿主重启场景由会话中断兜底，不走超时拒绝）

- **v0.5.8**（2026-08-14）：审批策略进阶——审批模式总开关 + 白名单自动放行 + 超时自动拒绝。新增 `approvalMode` 审批模式总开关（`manual`=全人工（默认，白名单/超时自动拒绝均不启用，行为等同 v0.5.7）；`auto`=启用自动化策略）；新增 `autoApprovePatterns` 配置（字符串数组）：审批 `toolName` 精确匹配或 `reason` 子串包含任一 pattern 即自动 `allowed-once`（不发人工通知，op 快照标记 `auto:"allowed"`，自动放行应答失败回退人工通知兜底）；新增 `approvalTimeoutMs` 配置（默认 120000ms，0 禁用）：未命中白名单的审批挂起超过时限无人应答自动 `rejected`（标记 `auto:"expired"`，agent 改用其他方式）。两项均直读 config.json（设置界面改动对新审批立即生效，manifest 默认值兜底）。实现：审批应答信封复用 dsh_approve 的 client-response 协议（respondApprovalLocal 内联实现，不 import 工具文件）；超时拒绝计时器存模块级 `approvalTimers`（key=opId::approvalId，不挂 op 快照防落盘序列化），approval/resolved 帧与任务终态（finally）清理防泄漏；多审批交错时自动放行/超时拒绝后仍按「无 pending 才恢复计时」的 v0.5.1 语义恢复执行超时

- **v0.5.7**（2026-08-14）：op 历史落盘 + 查询工具 dsh_ops。op 快照（任务/状态/结论/usage）终态落盘 `<数据目录>/ops.json`：300ms 防抖（多次终态只写最后一次），output 截断至 2000 字符控体积，写失败 try/catch 静默不阻塞主流程；单例记 `dataDir`（doExecute 与 startWebHostFromPlugin 双调用点共用，落盘/恢复同源）。插件启动时 `loadOps()` 恢复历史：`_opsLoaded` 标记幂等防重复，重启前仍 running 的 op 标 `interrupted` + `interruptedAt`（重启即中断，符合事实），终态原样恢复，恢复后遵守 OP_KEEP 裁剪（超出删最老）；文件不存在/损坏静默忽略（空 Map 启动）。新增 `dsh_ops(status?)` 查询工具（只读本地 op 快照，status 过滤 + opId/任务/状态/耗时/usage 摘要，重启后仍可查历史）

- **v0.5.6**（2026-08-14）：usage token 统计进 op 快照 + 卡片展示。dsh_run 事件循环收集的 `lastUsage`（assistant/message 的 d.usage：inputTokens / outputTokens / cacheReadTokens / reasoningTokens）在 ok 与 error 终态统一写入 op 快照（`usage` 字段，未收集到为 null；取消/超时前已产生的消耗同样可对账），卡片详情区新增 Token 行（有 usage 才显示，格式 `in / out / cache / thinking`）；同步返回与异步回调此前已带 usage，本次补齐快照与卡片展示

- **v0.5.5**（2026-08-14）：resume 会话复用。dsh_run 新增 `sessionId` 参数：传已有会话 id 时 `session.create` 走 resume（不传 cwd——会话 cwd 已定，避免 session-conflict），agent 保留上文（上下文继承，省上下文重建与时间）；无 sessionId 行为与现状一致（新建会话）。op 快照记录 resumeSessionId 便于卡片对账；cwd 校验放宽（resume 时可空，沿用会话已有 cwd）；session-conflict / agent-preset-conflict 由 dsh 侧返回，插件直接透出

- **v0.5.4**（2026-08-14）：任务取消 dsh_cancel。新增独立工具 `dsh_cancel(opId)`：按 opId 调 dsh web host `session.cancel` 主动取消运行中任务（client-request 信封 + rpcId 回显校验 + result.error code 透传），工具侧标记 `op.cancelledRequested`，dsh-run.js consume 末尾加取消兜底（该标记存在且 mux 断流无终态时判 aborted 而非 end_turn，防误报完成）；cancel 后任务以 aborted 终态收尾（deferred fail 带「dsh_run 已取消」唤醒 Agent，best-effort：任务刚自然完成时 cancel 的 accepted 无副作用）。误派/卡死任务可主动止损，配合既有超时与审批暂停机制

- **v0.5.3**（2026-08-14）：推理强度支持。dsh_run 新增 `reasoningEffort` 参数（off/high/max）+ `reasoningEffort` 插件配置（默认 high），经 `session.selectModel` 透传给 DeepSeek adapter（off=关闭思考 / high=高 / max=最高）；解析走「配置单一事实源」哲学（显式传参 > 直读 config.json 的 global.reasoningEffort > 配置快照），op 快照记录 reasoningEffort 便于卡片对账

- **v0.5.2**（2026-08-14）：agentPreset 模式选择。dsh_run 新增 `agentPreset` 参数 + `agentPreset` 插件配置（默认 standard），经 `session.create` 透传给 dsh（standard / code / cordis / minimal 四预设，未知值由 dsh 报 agent-preset-not-found）；解析走「配置单一事实源」哲学（显式传参 > 直读 config.json 的 global.agentPreset > 配置快照 > 默认值），op 快照记录 agentPreset 便于卡片对账

- **v0.5.1**（2026-08-14）：审批等待暂停超时。dsh_run 超时计时器改为可暂停/恢复状态机（remaining 续算）：approval/requested 首次入列时暂停、approval/resolved 全部解决后恢复（pending 计数语义，多审批交错正确）；审批等待不计入执行超时，避免应答稍慢任务被 session.cancel 误杀

- **v0.5.0**（2026-08-14）：审批自动化。事件流捕获 approval/requested 帧时保留 web host 路由所需的外层 rpcId（此前只取 payload 导致应答断链），审批上下文存 op 快照并经宿主 deferred 通道（独立 taskId）投递 dsh-approval 通知唤醒 Agent；新增 `dsh_approve` 工具应答（allowed-once/rejected，经 `/api/respond`，应答后 pending 移除单次生效）；同步模式无通知的边界写进已知限制

- **v0.4.2**（2026-08-14）：配置清理与模型选择。移除无效/过时配置：`dshRepo`（v0.4.0 已废弃零引用）、`permission`（v0.3.0 ACP 遗留，web host 迁移后从未接线，审批在 dsh Web UI 人工处理）；修正 `dshPkgDir` 描述；新增 `model` 配置（`session.selectModel` 会话级切换，provider=deepseek-official，模型 pass-through，默认 deepseek-v4-flash，改后立即生效）
- **v0.4.1**（2026-08-14）：PTC 式回调压缩。卡片两级输出（摘要区默认展开 + 完整输出懒加载 `/ops/output`，轮询体瘦身只带尾部预览与长度）；异步回调默认只带最终结论摘要（`callbackMode=summary`，`outputMeta` 元信息，完整输出在 op 快照 / web UI 可查）；新增 `callbackMode` 配置
- **v0.4.0**（2026-08-14）：执行后端 ACP → dsh web host /api；DSH_HOME 锁进插件数据目录；**依赖改为正式 npm 声明**（package.json dependencies + allowScripts 声明式批准 + node_modules 随 zip 分发，取代 dsh-pkg 特例目录）；事件流改 WebSocket；apiKey 配置项 + resolveApiKey 绕宿主配置快照；瘦身 245→186MB
- **v0.3.0**：deferred 即时卡片 + Web UI 随插件管理 + Markdown 实时渲染（ACP 后端）