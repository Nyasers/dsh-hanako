# DSHana

插件 id：`dsh-hanako`。把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）接进 Hana，作为进程外 subagent 使用。任务执行走 **dsh web host**（`--profile web`），dsh 官方 Web UI 以 **DSHana 标签页**内嵌在 Hana 顶部，可见全部任务会话；账本与依赖锁进插件数据目录。

## 安装（人类版，三步）

1. **拖入 zip 包**：把插件的 release zip（`dsh-hanako-v<version>.zip`，从 GitHub Releases 下载）拖进 Hana 插件安装界面（或解压到插件目录），插件即完成装载
2. **让 agent 完成安装**：对你的 Agent 说「帮我完成 DSHana 的安装」。Agent 会按插件自带技能完成剩余步骤：探测本机 node 路径并写入配置、在插件数据目录 npm ci 部署依赖（约 30~45 秒，无人值守）、把默认工作目录设为你的项目目录。依赖部署也可**页面自装**：打开 DSHana 标签页，在未就绪诊断的 deps 卡片点「安装依赖」（v0.8.6+，无需 Agent 介入）
3. **重启 Hana（可选）**：配置写入 config.json 后即被**现读**——t1「检测 Node」与 t3「手动启动 web host」都直读 config.json（启动链路 resolveNodePath → spawn），Agent 直写配置后**无需重启**即可用新 node 拉起；仅旧 web host 进程存活（g.web.ready）时需先杀进程或重启 Hana。重启后让 Agent 跑一个最小 `dsh_run` 试任务验证，即可正常派活

**无需配置 API Key / 模型**（v0.9.5+）：dsh 凭据由 dsh-hana-provider 插件直读 Hana 宿主 `provider-catalog.json`，模型跟随宿主 `models.json`。任务模型默认 = dsh 默认模型（`settings.yaml` 的 `agent-default-model`），可在 **dsh 设置页「默认模型」配置块**直接配置（Provider/模型/思考强度三级联动，保存即生效，见下文），`dsh_run` 工具参数 `provider` / `model` / `reasoningEffort` 可显式覆盖。

安装遇到问题，把报错丢给 Agent 即可（技能里有完整排错表）。

## 工具

五个工具由插件注册（实现 `tools/*.js`），**完整调用手册（参数语义、返回结构、错误码、审批通道、副作用）见各工具的 SKILL**：

| 工具 | 用途 | 调用手册 |
| --- | --- | --- |
| `dsh_run` | 提交任务给 dsh agent 执行（默认异步，wait=true 同步；provider/model 显式覆盖） | [dsh-run](skills/dsh-run/SKILL.md) |
| `dsh_approve` | 应答 dsh 任务挂起的权限审批（allowed-once / rejected） | [dsh-approve](skills/dsh-approve/SKILL.md) |
| `dsh_cancel` | 取消运行中的 dsh 任务（主动止损，幂等） | [dsh-cancel](skills/dsh-cancel/SKILL.md) |
| `dsh_ops` | 查询 dsh 会话清单与摘要（解析 dsh 会话缓存 session_projcache 可查，支持 limit） | [dsh-ops](skills/dsh-ops/SKILL.md) |
| `dsh_search` | 跨会话搜索历史内容，命中可 resume | [dsh-search](skills/dsh-search/SKILL.md) |

## dsh Web UI（DSHana 标签页）

配置 `webPort`（默认 3080）时，**插件加载即拉起** `dsh --profile web`（dsh 官方浏览器 UI：观察任务会话、模型配置——Hana 宿主 provider、会话全文搜索），卸载/重载时一并回收。设 `webPort: 0` 可关闭。

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
4. **分发**：cordis 插件经 dsh-host-webserver `tapIndex` 注入 index 响应；插件本体在安装目录 `dsh-plugin/dsh-hana-theme/`（包名 `dsh-hana-theme` 注册，dsh-run.js 启动前在 `$DSH_HOME/profiles/node_modules` 建 junction 指向安装目录，与 default-model/provider 同机制）

**生效时机**：用户切 dsh 偏好或宿主切 Hana 主题后，**重开 DSHana 标签页生效**（主题 CSS 只在打开标签页时拉取一次；重开即拉最新主题，宿主新增/修改主题零适配）。

### 默认模型配置（v0.9.5）

DSHana 的 `agent-default-model`（`settings.yaml`）是任务默认模型的事实源——`dsh_run` 不显式传 `provider` / `model` 时用它。dsh 设置页原生没有该段的配置 UI（`settings.mutate` 对 `agent-default-model` 段不可用，「not exposed to configuration clients」），由本插件补一个显式入口：

- **位置**：dsh Web UI 左下角齿轮打开设置面板，导航栏出现**原生**「默认模型」分页（v0.9.5 正规化升级：不再是 DOM 注入的 tab，而是经 dsh 前端 slot 注册——settings.section slot（id default-model）注册进 ledger 后导航自动投影该分页，点击切换/内容渲染全走 dsh 原生 React 逻辑；图标为设置面板内置的通用齿轮（navIcon 对未知 id 的兜底）），分页内容 = Provider / 模型 / 思考强度 三级联动下拉 + 保存按钮 + 当前值回显
- **选项**：`llm.models` RPC 权威列表——dsh 全部可用 provider（宿主注入的 sensenova/agnes/deepseek 与 dsh 单独配置的 deepseek-official 等）；模型按 provider 联动过滤；思考强度按模型 `reasoning.efforts` 动态填充（off/high/max 或 minimal/low/medium/high 等，无 `reasoning` 的模型不显示思考下拉）。**联动行为**：切 provider 自动选中该 provider 第一个模型 + 默认思考强度；打开分页回显当前默认（provider/model/effort 预选到表单，无当前值时自动选第一个 provider）
- **保存即生效**：写 `settings.yaml` 的 `agent-default-model` + 更新内存态，无需重启；此后 `dsh_run` 不显式指定时即用此默认
- **机制**：`dsh-hana-default-model` 插件按 dsh client 插件规范双端部署——后端（`index.js`）注册 `POST /api/hana-default-model.read` / `.save` 两条路由（`webServer.register` exact，经 `agentDefaultModel` 服务读写）；前端（`client.js`，package.json 的 `dsh.client` 声明 + `exports["./client"]` 指向）注册 `settings.section` slot 原生渲染分页。包名注册经 `$DSH_HOME/profiles/node_modules` junction 解析（dsh-run.js 启动前幂等创建）

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
- **dsh 启动 patch overlay**：dsh-run.js spawn `dsh --profile web --patch <...> --port <...>`，启动前渲染单一模板 `dsh-plugin/dsh-hanako.patch.yml.tpl` 为机器绝对路径写数据目录 `dsh-hanako.patch.generated.yml`（四段：session-query 全文搜索默认启用 `openAt: first-search` + dsh-hana-theme 主题插件注册 + dsh-hana-provider 宿主 provider 跟随注册 + dsh-hana-default-model 设置页默认模型配置块注册；v0.9.5 起 provider 段**恒渲染**——无配置项，宿主数据目录直接探测（插件安装形态 `<宿主数据目录>/plugins/<pluginId>` 上溯定位 models.json / provider-catalog.json），default-model 段同样恒挂载；三段 cordis 插件均**包名注册**（`name: dsh-hana-theme / dsh-hana-provider / dsh-hana-default-model`，非 file:// URL，因 dsh client 模块发现按 `require.resolve('<name>/package.json')` 解析，file:// 不可解析），dsh-run.js spawn 前在 `$DSH_HOME/profiles/node_modules` 幂等创建 junction 指向插件安装目录 `dsh-plugin/<同名包>`）；模板缺失/渲染失败不挂任何 patch 记 warn（会话全文搜索保持上游默认禁用）——patch 缺失时优雅降级不阻断启动
- **凭据与模型跟随**（v0.9.5+）：dsh-hana-provider 插件恒开直读 Hana 宿主 `provider-catalog.json`（凭据）+ `models.json`（模型，fs.watch 热重载），dsh models 页出现 Hana 全部 provider；任务模型默认 = dsh 默认模型（`settings.yaml` 的 `agent-default-model`），`dsh_run` 工具参数 `provider`/`model`/`reasoningEffort` 显式覆盖（显式时 selectModel，dsh 会把所选模型写回全局默认 settings.yaml）
- **设置页默认模型配置**（v0.9.5+）：dsh-hana-default-model 插件按 dsh client 插件规范双端部署（后端 `webServer.register` 两条 `/api/hana-default-model.*` exact 路由 + 前端 `client.js` 注册 `settings.section` slot 原生渲染「默认模型」分页）在 dsh 设置面板补上 `agent-default-model` 配置 UI——Provider/模型/思考强度三级联动（选项 = `llm.models` 权威列表），保存经 `agentDefaultModel` 服务写 `settings.yaml` 并更新内存态，立即生效
- **进程单例挂 `globalThis.__dshHanako`**：`index.js` 卸载清理时读取（不 import 插件文件，避免读到旧模块缓存）
- **宿主 tools 模块缓存**：宿主按插件 id 缓存 tools 模块，**改代码后必须重启 Hana 才加载新 tools**

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `approvalTimeoutMs` | `30000` | 审批挂起超过该时长无人应答自动 rejected（应答方失联检测）；0=禁用；改后对新审批立即生效 |
| `nodePath` | 空 | 启动 web host 的 node.exe（需 Node 24+）。**安装后必填本机 node 路径**（不预设默认值）。生效分层：t1 检测与手动启动（t3）都现读 config.json（resolveNodePath 直读优先）——改后无需重启即可用新 node 拉起；仅旧 web host 进程存活时需先杀进程或重启 |
| `defaultCwd` | 空 | 默认沙箱工作目录。**安装后建议设为实际项目目录**（为空且未传 cwd 时报 `cwd 不能为空`） |
| `defaultTimeoutMs` | 1800000 | 默认超时（毫秒，30 分钟） |
| `webPort` | 3080 | dsh Web UI 端口：>0 插件加载即拉起 web host（卸载一并回收），0 关闭 |
| `callbackMode` | `summary` | 异步完成回调输出体量：summary=只带最终结论摘要（默认，省上下文）/ full=全量 |

## 已知限制

- **bash 工具在 Windows 上可能 `E_ACCESSDENIED`**（dsh-bash-sandbox 创建 bash 服务实例失败，属 dsh 沙箱环境限制，非本插件问题）。文件系统工具（write/read/edit）在 workspace-write 沙箱下工作正常，Windows 上优先用文件系统工具
- **主题跟随**：DSHana 标签内，dsh 偏好 `system`（默认）→ 跟随 Hana 当前主题（明暗 + 配色）；`light`/`dark` → dsh 内置原生配色。用户切 dsh 偏好或宿主切 Hana 主题后，**重开标签页生效**（主题 CSS 打开时拉取一次）
- 越界权限请求默认走审批自动化：插件捕获 approval/requested → deferred 通知 Agent → `dsh_approve` 应答；无人应答超时自动拒绝，兜底 dsh Web UI 人工审批
- **同步模式（wait=true）无审批通知**：同步调用时 Agent 在等结果，审批挂起只能靠 dsh Web UI 人工处理（或超时）。长任务建议用异步模式
- 默认每个任务新建独立 session；传 `sessionId` 可复用已有会话（resume，跨任务继承上下文）

## 版本历史

- **v0.10.3**（2026-08-16）：dsh_ops 翻新——不再用 ops.jsonl 记录历史，直接解析 dsh 会话持久化缓存 `<dataDir>/dsh-home/storages/session_projcache.json`；新增 `limit` 参数（默认 10，范围 1~100）只返回最新几条；移除 `status` 过滤（新数据源无状态语义），主键由 opId 改为 sessionId，返回 sessionId/title/cwd/createdAt/lastPromptAt/usage/turns/steps/llmMs；同步移除 dsh-run 的 ops.jsonl 落盘/恢复机制（-180 行，运行期 op 快照保留，卡片/审批/取消不受影响；旧 ops.jsonl 数据文件保留不删）。主 SKILL 精简：删除主题跟随/默认模型配置冗余章节（使用语义并入首次安装配置与已知限制，约 -2100 字符），description 移除「发版」残留；SKILL 路由表补 POST /webui/adopt-node 与 README 对齐
- **v0.10.2**（2026-08-16）：config.json 自动初始化——插件初始化（onload 拉起 web host / 首次工具调用）时若 `<数据目录>/config.json` 不存在，按 manifest 默认值自动生成（`ensureConfigJson`：`{ schemaVersion: 1, global: { ...manifestDefaults }, agents: {}, sessions: {} }`，幂等不覆盖已有内容、原子写 + 失败静默）；全新安装免「先保存一次」引导，装完即可在设置界面看到默认值
- **v0.10.1**（2026-08-16）：配置项收敛与工具技能体系——**移除 hostProvider 配置项**（modelsPath/catalogPath 不再配置，宿主 provider 路径直接探测：`HANA_HOME`（宿主进程注入）→ 插件安装形态 `<宿主数据目录>/plugins/<pluginId>` 上溯 → `homedir()/.hanako`，存在性验证命中；清除 manifest/文档中的开发机路径泄漏）；**移除 agentPreset 配置项**（不显式传时不传 `session.create` 的 agentPreset 字段，用 dsh Web UI 默认 agent 预设，reasoningEffort 同理）；`defaultTimeoutMs` 默认 600000 → 1800000（10 分钟对编码任务偏短，默认 30 分钟）；**新增五个独立工具 SKILL**（dsh-run/dsh-approve/dsh-cancel/dsh-ops/dsh-search，从源码 tools/*.js 核对参数语义/返回结构/错误码/审批通道/副作用），索引 skill 工具速查挂接，README 工具章节精简为列举 + SKILL 链接
- **v0.9.5**（2026-08-15）：彻底移除插件自身「填 API Key」「手动设置模型」回退路径——删除 `apiKey` / `model` / `reasoningEffort`（全局）配置与 `.credentials.yaml` / config.json 读取链；`hostProvider` 恒开跟随宿主（无「关闭」选项，不再有官方 API 回退路线），凭据直读宿主 `provider-catalog.json`；任务模型默认 = dsh 默认（settings.yaml `agent-default-model`），`dsh_run` 工具参数 `provider`/`model`/`reasoningEffort` 显式覆盖（显式时 selectModel，dsh 会把所选模型写回全局默认）；**新增 dsh-hana-default-model 插件——dsh 设置页「默认模型」配置块**（Provider/模型/思考强度三级联动（切 provider 自动选中首个模型 + 默认思考强度，打开分页回显当前默认），选项 = llm.models 权威列表全部 provider，保存即写 agent-default-model 生效，补上 settings 页缺失的该段配置 UI）；**默认模型分页正规化升级**——前端由 tapIndex DOM 注入改为 dsh 前端 `settings.section` slot 注册原生渲染（client.js + package.json `dsh.client` 声明，patch 段4 包名注册 + `$DSH_HOME/profiles/node_modules` junction 解析，导航自动投影分页、点击切换全走原生 React）；诊断不再显示 apiKey。含 0.9.4（dsh-hana-provider 宿主 provider 直通定稿：dsh_run 加入 provider/model/reasoningEffort 工具参数与 selectModel 显式分支、readDshDefaultModel、错误透传）中间迭代
- **v0.9.3**（2026-08-15）：t1 候选列表体验完善（空候选提示「未检测到本机可用 Node.js」+ 去用户可见文案写死版本号与版本后缀）+ 配置生效文案统一（t1/t2/t3 依赖相关「重启 Hana」全部改为「立即生效/完成后自动验证」，与页面自愈能力对齐）；含 0.9.1（t1 fix 文案去重启）、0.9.2（候选探测扩展 nvm-windows NVM_HOME / volta VOLTA_HOME，FNM_DIR 多版本遍历刻意不实现）中间迭代
- **v0.9.0**（2026-08-15）：大版本收尾（0.8.3 以来全量迭代，CI 三段式发版，GitHub Release pre-release）——**连接失败自检与自愈体系**（web host 未就绪时标签页自检 t1 node 配置 / t2 dsh 依赖 / t3 进程状态 + 操作按钮进卡片）：t2 依赖运行级验证（`node cliBin --version` 冒烟抓假就绪）+ 页面自装（POST /webui/install-deps，npm ci --omit=dev 部署 dsh-pkg，实时进度）+ 手动启动（POST /webui/start）+ 运行级检测（GET /webui/verify-deps / verify-node，进页自动一次 + 手动按钮）；门禁链 t1→t2→t3（依赖/Node 未通过时下游按钮禁用）；webLastExit 持久退出记录；诊断区主题化（CSS 变量跟随宿主）；配置生效分层（检测层实时 / 启动层现读 config.json / 仅旧进程存活需杀进程）；SKILL 瘦身（15323→7362 字符，移除「构建与打包」章节与构建触发词，定位为排障手册）
- **v0.8.3**（2026-08-15）：风险审查处置——清理 credentialsPath 死路径（manifest 未声明该设置项，错误提示与注释不再引用；凭据文件兜底收敛为 dsh-home/.credentials.yaml → ~/.dsh/.credentials.yaml）；主题插件 file:// URL 加 encodeURI（路径含空格/特殊字符时不再生成非法 URL，主题加载更稳）
- **v0.8.2**（2026-08-15）：文档翻新——README 无版本痕迹化 + 主题跟随章节 + 名称/ID 规范；SKILL 部署运维版（主题排错、config.json 缺失引导）
- **v0.8.1**（2026-08-15）：主题跟随宿主完整落地——`dsh-hana-theme` cordis 插件（tapIndex 注入 index 响应，安装目录 dsh-plugin file:// 加载，patch 模板渲染注册），宿主声明取色（壳桥 getComputedStyle 读 theme.css 16 变量，随宿主更新、新增主题零适配），72 个 `--dsw-alias-*/--dsw-specific-*` token 映射（视觉主表面 + 遮罩 + 滚动条，功能性颜色保留原生），preference 边界（system 才覆盖，light/dark 原生，加载时读一次 settings.describe），覆盖写 body 层 !important（压 dsh presenter 的 body inline）。生效：切偏好/切主题重开标签页
- **v0.8.0**（2026-08-15）：DSHana 标签页主题跟随基础版——壳页面按 hana-theme 映射 color-scheme（跨源 iframe 继承 prefers-color-scheme，dsh system 跟随宿主明暗）；升级清依赖事故处置（npm ci 部署 dsh-pkg，升级不丢依赖）；SKILL 排错表新增升级场景
- **v0.7.5**（2026-08-14）：版本号迭代（功能见 v0.7.x 早期迭代）
- **v0.7.4**（2026-08-14）：版本号迭代（功能见 v0.7.x 早期迭代）
