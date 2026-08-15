# DSHana

插件 id：`dsh-hanako`。把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）接进 Hana，作为进程外 subagent 使用。任务执行走 **dsh web host**（`--profile web`），dsh 官方 Web UI 以 **DSHana 标签页**内嵌在 Hana 顶部，可见全部任务会话；账本与依赖锁进插件数据目录。

## 安装（人类版，四步）

1. **拖入 zip 包**：把插件的 release zip（`dsh-hanako-v<version>.zip`，从 GitHub Releases 下载）拖进 Hana 插件安装界面（或解压到插件目录），插件即完成装载
2. **配置 apiKey**：打开插件设置（DSHana），在「DeepSeek API Key」填入你的 key（设置界面可见，Agent 不代填）
3. **让 agent 完成安装**：对你的 Agent 说「帮我完成 DSHana 的安装」。Agent 会按插件自带技能完成剩余步骤：探测本机 node 路径并写入配置、在插件数据目录 npm ci 部署依赖（约 30~45 秒，无人值守）、把默认工作目录设为你的项目目录。依赖部署也可**页面自装**：打开 DSHana 标签页，在未就绪诊断的 deps 卡片点「安装依赖」（v0.8.6+，无需 Agent 介入）
4. **重启 Hana（可选）**：配置写入 config.json 后即被**现读**——t1「检测 Node」与 t3「手动启动 web host」都直读 config.json（启动链路 resolveNodePath → spawn），Agent 直写配置后**无需重启**即可用新 node 拉起；仅旧 web host 进程存活（g.web.ready）时需先杀进程或重启 Hana。重启后让 Agent 跑一个最小 `dsh_run` 试任务验证，即可正常派活

安装遇到问题，把报错丢给 Agent 即可（技能里有完整排错表）。

## 工具

`dsh_run(task, cwd?, timeout?, wait?, agentPreset?, reasoningEffort?, sessionId?)`

- `task`：任务描述，作为用户消息发给 dsh 编码 agent
- `cwd`：沙箱工作目录（bash 与文件系统工具的活动范围），默认 `defaultCwd`；resume 时（传了 `sessionId`）可省略，沿用会话已有 cwd
- `timeout`：超时秒数，默认 `defaultTimeoutMs`
- `wait`：false（默认）= 异步，立即返回，完成后宿主唤醒、结果后台送达；true = 同步等结果直接返回
- `agentPreset`：agent 预设模式 `standard`（默认）/ `code` / `cordis` / `minimal`，缺省用插件配置
- `reasoningEffort`：推理强度 `off` / `high`（默认）/ `max`，缺省用插件配置
- `sessionId`：复用已有 dsh 会话（resume）：传上次任务的 sessionId 在该会话上继续，agent 保留上文（省上下文重建）；目标会话应已空闲。无 sessionId 时新建会话

权限：`external_side_effect`，Auto 模式下调用会送审。

`dsh_approve(opId, approvalId, outcome?)`

- 应答 dsh 任务挂起的权限审批（approval/policy=ask 触发 approval/requested 时任务等待应答）
- `opId` + `approvalId`：来自宿主 deferred 通道的 dsh-approval 通知（同一任务可挂起多个审批，逐个应答）
- `outcome`：`allowed-once`（默认，仅放行该次）/ `rejected`（拒绝，agent 改用其他方式）
- 内部经 `POST /api/respond` 应答；无人应答时审批仍可在 dsh Web UI 人工处理

权限：`external_side_effect`。

`dsh_cancel(opId)`

- 取消一个已派发的 dsh 任务（主动止损）：按 `dsh_run` 返回的 `opId` 请求取消运行中的任务
- 内部调 `POST /api/session.cancel` 中断该会话，dsh agent 收到中断后任务以 aborted 终态收尾
- 已结束的任务幂等返回提示无需取消；`opId` 只可取消本会话近期提交的任务

权限：`external_side_effect`。

`dsh_ops(status?)`

- 查询 dsh 任务历史（op 快照）：不传返回全部（最多 50 条，最新在前），传 `status` 过滤（`running` / `ok` / `error` / `interrupted`）
- 每条返回 opId / 任务（前 80 字符）/ 状态 / 耗时 / usage 摘要，供对账与回溯
- **历史已落盘**：op 快照写 `<数据目录>/ops.jsonl`（JSON Lines 增量追加），插件启动时自动恢复——重启后仍可查历史任务与结论；终态行不落盘完整 output（完整输出在内存 op 快照/卡片，重启后经 `sessionRecord` 链接指向 dsh-home 会话完整日志回溯）；旧版 `ops.json` 首次启动自动迁移

权限：只读。

`dsh_search(query)`

- 跨会话内容搜索：给 `query` 关键词（1~500 字符），经 dsh web host `session.search` RPC 跨全部历史会话内容匹配
- 返回命中的会话（`sessionId` + 内容摘要 ≤240 字符，最多 20 条 + `hasMore`）
- 命中后可用 `dsh_run` 的 `sessionId` 参数 resume 该会话继续（上下文继承，知识复用）

权限：只读。

## dsh Web UI（DSHana 标签页）

配置 `webPort`（默认 3080）时，**插件加载即拉起** `dsh --profile web`（dsh 官方浏览器 UI：观察任务会话、模型配置、密钥管理），卸载/重载时一并回收。设 `webPort: 0` 可关闭。

插件顶部 tab 注册页面（manifest `contributes.page`，route `/webui`），iframe 内嵌 `http://127.0.0.1:<webPort>/`：

- **就绪加载**：服务端先探测 host，未就绪时页面显示**自检诊断列表**（见「连接失败自检与自愈」）并轮询 `/webui/health`（3s，隐藏时 5s），就绪后挂载 iframe；health 请求回传 `X-Hana-Plugin-Surface-Session` 凭证
- **主题跟随**：见下节

### 主题跟随

DSHana 标签内 dsh 主题与宿主 Hana 联动：

| dsh 偏好 | 标签页效果 |
| --- | --- |
| `system`（默认） | 跟随 Hana 当前主题（明暗 + 配色） |
| `light` / `dark` | dsh 内置原生配色 |

**机制**（宿主声明，无静态主题表）：

1. **明暗**：壳页面按 `hana-theme` query 映射 `color-scheme`（深色主题 → dark），Chromium 让跨源 iframe 的 `prefers-color-scheme` 继承父页面 color-scheme，dsh 的 `system` 解析即跟随宿主明暗
2. **配色**：壳桥 `getComputedStyle` 读宿主 `theme.css`（宿主动态端点 `/api/plugins/theme.css?theme=<id>`，返回压平为 `:root` 的扁平版，插件页面 link 即生效）的 16 个主题变量（bg 层次 / 文字三阶 / accent 三态 / border / green / danger / userBg / overlay 三档 / dropOverlay），回传给注入的 `dsh-hana-theme` cordis 插件，写 **body 层 `!important` 覆盖**（dsh 的 presenter 把 token 以 inline style 写到 body，覆盖必须同层才压得过）
3. **覆盖范围**：72 个 `--dsw-alias-*` + `--dsw-specific-*` token（bg 层次/遮罩/文字/brand/button/border/interactive/markdown/state/组件专用/滚动条），功能性颜色保留原生（照片查看器黑底、danger·warn 语义色、按钮反白文字、toast·tooltip 深色浮层、工具栏半透明、骨架屏、反白边框）
4. **分发**：cordis 插件经 dsh-host-webserver `tapIndex` 注入 index 响应；插件本体在安装目录 `assets/dsh-cordis/dsh-hana-theme/`（file:// URL 由 dsh-run.js 启动前渲染 patch 模板注册，与 session-query patch 同机制）

**生效时机**：用户切 dsh 偏好或宿主切 Hana 主题后，**重开 DSHana 标签页生效**（主题 CSS 只在打开标签页时拉取一次；重开即拉最新主题，宿主新增/修改主题零适配）。

## 连接失败自检与自愈（v0.8.4+）

web host 未就绪时，DSHana 标签页不再只显示「正在重试…」——未就绪诊断区展示**自检诊断列表**（配色跟随宿主主题的 CSS 变量），逐项检查并给出修复指引，同时保留 3s 轮询（就绪后自动挂载 iframe、诊断区消失）。三项检查（每项 ✓/✗ + 详情 + 修复指引）：

| 检查项 | 判定 | 操作 |
| --- | --- | --- |
| **t1 Node.js 配置** | nodePath 是否配置 + 路径是否存在 + **运行级可用性**（`node --version` 可执行 + node 同目录 `npm-cli.js` 存在，v0.8.10+） | 卡片按钮「检测 Node」（常驻，检测中禁用）；未配置时展示**候选列表**（探测链按通用性：PATH → Program Files → nvm-windows/fnm/volta 等工具变量，点「采用」写入 config.json，服务端真实校验）；修复双路径：去插件设置界面填写/修正 node.exe 路径，或让 Agent 协助（探测本机 node → 引导确认 → 写 config.json）——**直写后 t1 检测实时生效**（resolveNodePath 直读 config.json，可先点「检测 Node」验证），t3「手动启动 web host」同样现读 config.json 用新 node 拉起（无需重启；仅旧进程存活时先杀进程）。**t1 未通过 → t2/t3 全锁**（msg「Node.js 不可用，请先修复」） |
| **t2 dsh 依赖** | 存在性（cliBin 文件存在）+ **运行级验证**（`node <cliBin> --version` 沿 import 图加载 cordis 模块树，能跑 = 依赖完整，抓 `ERR_MODULE_NOT_FOUND` 类假就绪） | 卡片按钮：缺失「安装依赖」/ 验证失败「重新安装依赖」/ 常驻「检测依赖」/ 安装中「安装中…」禁用。安装过程显示 npm ci **实时进度**（stdout/stderr 流式 → installLog 尾部 + 更新时间，3s 轮询刷新） |
| **t3 DSH 进程** | 单例 web 状态：未启动 / 启动中 / 已就绪但探测未中 / 已退出（webLastExit 持久记录：code/signal/时间/stderr）/ 启动失败（webLastError） | 卡片按钮「手动启动 web host」；**t2 未通过时按钮禁用**（msg「依赖未就绪，请先安装/重新安装依赖」） |

**自愈闭环**：t1 不可用（未配置/路径失效/检测失败）→ 先修 t1（设置界面或 Agent 协助，t1 未过时 t2/t3 全锁）→ t2 缺失 → deps 卡片「安装依赖」自动完成（复制插件 package.json+lock 到数据目录 `dsh-pkg/` → npm ci `--omit=dev` → 校验 → 自动运行级重验，官方源失败自动重试 npmmirror）→ t2 转 ✓ → t3 按钮解锁 → 「手动启动 web host」拉起进程 → 轮询就绪切 iframe。运行级检测「进标签页自动一次 + 手动「检测依赖」/「检测 Node」按钮」（v0.8.8/0.8.10 起，不再随 3s 轮询重复触发）。

**任务持续**：npm ci 与 web host 都是宿主进程 spawn 的子进程——离开标签页任务继续，返回后重新渲染诊断仍可见进度（单例内存态；宿主重启则中断，需重装依赖）。

### 路由

| 路由 | 用途 |
| --- | --- |
| `GET /webui` | 页面壳（就绪探测 + 主题注入 + 首帧自检诊断） |
| `GET /webui/health` | 就绪探测（浏览器端 3s 轮询源；未就绪时附带 `diagnostics` 字段供渲染） |
| `POST /webui/start` | 手动启动 web host（`ready` / `starting` / 触发启动三态） |
| `POST /webui/install-deps` | 安装依赖：npm ci `--omit=dev` 部署到数据目录 `dsh-pkg`，完成后自动运行级重验 |
| `GET /webui/verify-deps` | 运行级依赖检测（`node cliBin --version`，只读；进标签页自动一次 + 手动「检测依赖」按钮） |
| `GET /webui/verify-node` | 运行级 Node/npm 可用性检测（`node --version` + `npm-cli.js`，只读；进标签页自动一次 + 手动「检测 Node」按钮） |
| `POST /webui/adopt-node` | 采用 Node 候选（t1 候选列表「采用」按钮；服务端校验后写入 config.json 的 global.nodePath） |

## 任务反馈卡片

工具返回时宿主立即渲染 iframe 卡片（`details.card` 机制），**异步模式下无需等任务完成**：

- 提交即显示「运行中」卡片，实时刷新状态与耗时
- **两级输出（PTC 式压缩）**：摘要区默认展开（运行中为输出尾部实时预览；完成后为最终结论摘要），完整输出超长时经「完整输出」按钮懒加载（默认折叠）
- **回调压缩**：异步完成回调默认只带最终结论摘要（`callbackMode=summary`，锚点 = dsh 最后一条 assistant 消息），完整输出保留在卡片 op 快照与 dsh Web UI，不占 Agent 上下文；设 `callbackMode=full` 可回传全量
- **Token 账目**：任务完成后卡片详情区显示 usage 统计 `Token: in / out / cache / thinking`
- 失败时显示错误信息

完成/失败时经宿主 deferred 通道唤醒 Agent，无需轮询等待。

## 审批流程

dsh 会话默认 `approval/policy=ask`：agent 请求越界权限时发出 approval/requested，任务挂起等应答。插件捕获审批帧（保留 rpcId），把审批上下文存进 op 快照，经宿主 deferred 通道投递 `dsh-approval` 通知唤醒 Agent；Agent 收到后调 `dsh_approve` 应答（allowed-once / rejected），任务继续。

**唯一流程**：审批挂起 → 插件通知 Agent（**附命令/路径原文**，tool/call 参数按 callId 反查；code preset 子调用参数经 tool/code-dispatch-start 精确缓存）→ Agent 用 `dsh_approve` 应答 → 无人应答超时自动拒绝（`approvalTimeoutMs`，默认 30s，应答方失联检测；0 禁用）。**审批模式（manual/auto）与白名单（autoApprovePatterns）已移除**——所有审批一律过 Agent 决策，无自动放行。无人应答时兜底在 dsh Web UI 人工处理。

## 事件流通道（WebSocket）

dsh 的 `/api/events.mux` **要求 WebSocket 升级**：GET 返回 `426 Upgrade Required`，用 fetch + SSE 解析是错的。事件流必须 `ws://127.0.0.1:<port>/api/events.mux`（Node 22+ 内置全局 WebSocket）：

- 连接后收到 `session/subscribed` 帧（`{type, sessionId, lastSeq}`，sessionId 是本连接绑定的会话，不是会话清单）
- 之后收到各会话事件（assistant/chunk 等），帧为 JSON，`payload` 即 MuxFrame
- 订阅按连接绑定，会话列表从 `dsh-home/sessions/` 落盘目录或 Web UI 获取

## 架构

- **依赖按需部署**：zip 零依赖（约 0.1MB，代码 bundle + 配置 + 技能 + lockfile）。dsh 依赖树（`@deepseek-ai/dsh` + node-pty/koffi 原生模块，约 246MB）由 Agent 部署时 **npm ci 到数据目录 `dsh-pkg/`**（升级安装整体替换插件目录不丢依赖；registry 不通时切镜像 `--registry=https://registry.npmmirror.com`），也可在 DSHana 标签页 deps 卡片点「安装依赖」自动完成（v0.8.6+，命令同上）。解析链：`<dataDir>/dsh-pkg` 优先 → 插件安装目录 `node_modules`（兼容旧形态）。依赖完整性另经**运行级验证**（`node cliBin --version`，v0.8.7+，能跑 = 依赖图完整，防 npm ci 中断/--omit=peer 误用造成的假就绪）
- **插件本体 rspack bundle**：`index.js` + `tools/*.js` 经 `scripts/build.mjs` 打包，`scripts/pack.mjs` 铺平到标准位置交付（根 `index.js` + `tools/`，无 dist/）。构建工具 @rspack/core 声明为 devDependencies（构建契约，部署 `--omit=dev` 不装）
- **dsh 启动 patch overlay**：dsh-run.js spawn `dsh --profile web --patch <...> --port <...>`，启动前渲染单一模板 `config/dsh-hanako.patch.yml.tpl` 为机器绝对路径写数据目录 `dsh-hanako.patch.generated.yml`（三段：session-query 全文搜索默认启用 `openAt: first-search` + dsh-hana-theme 主题插件注册 + dsh-hana-provider 宿主 provider 跟随注册）；模板缺失/渲染失败回退静态 `config/session-query.patch.yml`（保底搜索），再缺失不挂 patch 记 warn——patch 缺失时优雅降级不阻断启动
- **凭据解析**：`resolveApiKey` 优先级 = 宿主注入 `cfg.apiKey` → 直读 `dataDir/config.json` 的 `global.apiKey`（改配置即时生效）→ 文件兜底（dsh-home/.credentials.yaml → ~/.dsh/.credentials.yaml）
- **进程单例挂 `globalThis.__dshHanako`**：`index.js` 卸载清理时读取（不 import 插件文件，避免读到旧模块缓存）
- **宿主 tools 模块缓存**：宿主按插件 id 缓存 tools 模块，**改代码后必须重启 Hana 才加载新 tools**

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `apiKey` | 空 | DeepSeek API Key（插件设置界面填写，Agent 不代填）。安装后必填（无 key web host 起不来）。生效分层：手动启动时经 `resolveApiKey` 解析（插件加载快照 cfg.apiKey 非空优先；为空时直读 config.json/凭据文件，改后无需重启）；诊断层自检布尔直读 config.json 实时 |
| `model` | `deepseek-v4-flash` | dsh 任务模型 id（provider 固定 deepseek-official，模型名 pass-through 直传）：内置 `deepseek-v4-flash` / `deepseek-v4-pro`，可填其他 DeepSeek 模型 id；改后对新任务立即生效（直读 config.json） |
| `agentPreset` | `standard` | dsh_run 提交任务的默认 agent 预设；工具调用可显式覆盖；改后对新任务立即生效 |
| `reasoningEffort` | `high` | 默认推理强度：off / high / max；工具调用可显式覆盖 |
| `approvalTimeoutMs` | `30000` | 审批挂起超过该时长无人应答自动 rejected（应答方失联检测）；0=禁用；改后对新审批立即生效 |
| `nodePath` | 空 | 启动 web host 的 node.exe（需 Node 24+）。**安装后必填本机 node 路径**（不预设默认值）。生效分层：t1 检测与手动启动（t3）都现读 config.json（resolveNodePath 直读优先）——改后无需重启即可用新 node 拉起；仅旧 web host 进程存活时需先杀进程或重启 |
| `defaultCwd` | 空 | 默认沙箱工作目录。**安装后建议设为实际项目目录**（为空且未传 cwd 时报 `cwd 不能为空`） |
| `defaultTimeoutMs` | 600000 | 默认超时（毫秒） |
| `webPort` | 3080 | dsh Web UI 端口：>0 插件加载即拉起 web host（卸载一并回收），0 关闭 |
| `callbackMode` | `summary` | 异步完成回调输出体量：summary=只带最终结论摘要（默认，省上下文）/ full=全量 |

## 已知限制

- **bash 工具在 Windows 上可能 `E_ACCESSDENIED`**（dsh-bash-sandbox 创建 bash 服务实例失败，属 dsh 沙箱环境限制，非本插件问题）。文件系统工具（write/read/edit）在 workspace-write 沙箱下工作正常，Windows 上优先用文件系统工具
- **主题跟随**：DSHana 标签内，dsh 偏好 `system`（默认）→ 跟随 Hana 当前主题（明暗 + 配色）；`light`/`dark` → dsh 内置原生配色。用户切 dsh 偏好或宿主切 Hana 主题后，**重开标签页生效**（主题 CSS 打开时拉取一次）
- 越界权限请求默认走审批自动化：插件捕获 approval/requested → deferred 通知 Agent → `dsh_approve` 应答；无人应答超时自动拒绝，兜底 dsh Web UI 人工审批
- **同步模式（wait=true）无审批通知**：同步调用时 Agent 在等结果，审批挂起只能靠 dsh Web UI 人工处理（或超时）。长任务建议用异步模式
- 默认每个任务新建独立 session；传 `sessionId` 可复用已有会话（resume，跨任务继承上下文）

## 版本历史

- **v0.9.3**（2026-08-15）：t1 候选列表体验完善（空候选提示「未检测到本机可用 Node.js」+ 去用户可见文案写死版本号与版本后缀）+ 配置生效文案统一（t1/t2/t3 依赖相关「重启 Hana」全部改为「立即生效/完成后自动验证」，与页面自愈能力对齐）；含 0.9.1（t1 fix 文案去重启）、0.9.2（候选探测扩展 nvm-windows NVM_HOME / volta VOLTA_HOME，FNM_DIR 多版本遍历刻意不实现）中间迭代
- **v0.9.0**（2026-08-15）：大版本收尾（0.8.3 以来全量迭代，CI 三段式发版，GitHub Release pre-release）——**连接失败自检与自愈体系**（web host 未就绪时标签页自检 t1 node 配置 / t2 dsh 依赖 / t3 进程状态 + 操作按钮进卡片）：t2 依赖运行级验证（`node cliBin --version` 冒烟抓假就绪）+ 页面自装（POST /webui/install-deps，npm ci --omit=dev 部署 dsh-pkg，实时进度）+ 手动启动（POST /webui/start）+ 运行级检测（GET /webui/verify-deps / verify-node，进页自动一次 + 手动按钮）；门禁链 t1→t2→t3（依赖/Node 未通过时下游按钮禁用）；webLastExit 持久退出记录；诊断区主题化（CSS 变量跟随宿主）；配置生效分层（检测层实时 / 启动层现读 config.json / 仅旧进程存活需杀进程）；SKILL 瘦身（15323→7362 字符，移除「构建与打包」章节与构建触发词，定位为排障手册）
- **v0.8.3**（2026-08-15）：风险审查处置——清理 credentialsPath 死路径（manifest 未声明该设置项，错误提示与注释不再引用；凭据文件兜底收敛为 dsh-home/.credentials.yaml → ~/.dsh/.credentials.yaml）；主题插件 file:// URL 加 encodeURI（路径含空格/特殊字符时不再生成非法 URL，主题加载更稳）
- **v0.8.2**（2026-08-15）：文档翻新——README 无版本痕迹化 + 主题跟随章节 + 名称/ID 规范；SKILL 部署运维版（主题排错、config.json 缺失引导）
- **v0.8.1**（2026-08-15）：主题跟随宿主完整落地——`dsh-hana-theme` cordis 插件（tapIndex 注入 index 响应，安装目录 assets/dsh-cordis file:// 加载，patch 模板渲染注册），宿主声明取色（壳桥 getComputedStyle 读 theme.css 16 变量，随宿主更新、新增主题零适配），72 个 `--dsw-alias-*/--dsw-specific-*` token 映射（视觉主表面 + 遮罩 + 滚动条，功能性颜色保留原生），preference 边界（system 才覆盖，light/dark 原生，加载时读一次 settings.describe），覆盖写 body 层 !important（压 dsh presenter 的 body inline）。生效：切偏好/切主题重开标签页
- **v0.8.0**（2026-08-15）：DSHana 标签页主题跟随基础版——壳页面按 hana-theme 映射 color-scheme（跨源 iframe 继承 prefers-color-scheme，dsh system 跟随宿主明暗）；升级清依赖事故处置（npm ci 部署 dsh-pkg，升级不丢依赖）；SKILL 排错表新增升级场景
- **v0.7.5**（2026-08-14）：版本号迭代（功能见 v0.7.x 早期迭代）
- **v0.7.4**（2026-08-14）：版本号迭代（功能见 v0.7.x 早期迭代）
