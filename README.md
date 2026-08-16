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
4. **分发**：cordis 插件经 dsh-host-webserver `tapIndex` 注入 index 响应；插件本体在安装目录 `dsh-plugin/dsh-hana-theme/`（包名 `dsh-hana-theme` 注册，dsh-run.js 启动前在 `$DSH_HOME/profiles/node_modules` 建 junction 指向安装目录，与四内嵌插件（logger/theme/provider/default-model）统一机制）

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
| **t3 DSH 进程** | 单例 web 状态：未启动 / 启动中 / 已就绪但探测未中 / 已退出（webLastExit 持久记录：code/signal/时间/stderr）/ 启动失败（webLastError）；诊断区显示**「本次会话日志」路径**（`<dataDir>/logs/<YYYYMMDD-HHmmss-SSS>.log` 时间戳会话文件，v0.10.8+） | 卡片按钮「手动启动 web host」；**t2 未通过时按钮禁用**（msg「依赖未就绪，请先安装/重新安装依赖」） |

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
- **SSE 推送渲染（v0.11.0+）**：卡片启动先收 baseline（会话 jsonl 恢复快照），再经 `/ops/stream` 收 DSH mux 实时事件（assistant/chunk 文本增量节流渲染、blocks/usage 收集、turn/end 定终态）。插件零任务状态存储，session.jsonl 为唯一事实源，重启后旧卡片仍可从日志恢复
- **两级输出（PTC 式压缩）**：摘要区默认展开（运行中为输出尾部实时预览；完成后为最终结论摘要），完整输出超长时经「完整输出」按钮懒加载（默认折叠）
- **回调压缩**：异步完成回调默认只带最终结论摘要（`callbackMode=summary`，锚点 = dsh 最后一条 assistant 消息），完整输出保留在卡片（jsonl 恢复）与 dsh Web UI，不占 Agent 上下文；设 `callbackMode=full` 可回传全量
- **Token 账目**：任务完成后卡片详情区显示 usage 统计 `Token: in / out / cache / thinking`（API 未返回 cache/thinking 明细时不显示对应项）
- 失败时显示错误信息

完成/失败时经宿主 deferred 通道唤醒 Agent，无需轮询等待。

## 审批流程

dsh 会话默认 `approval/policy=ask`：agent 请求越界权限时发出 approval/requested，任务挂起等应答。插件捕获审批帧（保留 rpcId），把审批上下文存进运行期协调条目（终态即删，不落任务快照），经宿主 deferred 通道投递 `dsh-approval` 通知唤醒 Agent；Agent 收到后调 `dsh_approve` 应答（allowed-once / rejected），任务继续。

**唯一流程**：审批挂起 → 插件通知 Agent（**附命令/路径原文**，tool/call 参数按 callId 反查；code preset 子调用参数经 tool/code-dispatch-start 精确缓存）→ Agent 用 `dsh_approve` 应答 → 无人应答超时自动拒绝（`approvalTimeoutMs`，默认 30s，应答方失联检测；0 禁用）。**审批模式（manual/auto）与白名单（autoApprovePatterns）已移除**——所有审批一律过 Agent 决策，无自动放行。无人应答时兜底在 dsh Web UI 人工处理。

## 事件流通道（WebSocket）

dsh 的 `/api/events.mux` **要求 WebSocket 升级**：GET 返回 `426 Upgrade Required`，用 fetch + SSE 解析是错的。事件流必须 `ws://127.0.0.1:<port>/api/events.mux`（Node 22+ 内置全局 WebSocket）：

- 连接后收到 `session/subscribed` 帧（`{type, sessionId, lastSeq}`，sessionId 是本连接绑定的会话，不是会话清单）
- 之后收到各会话事件（assistant/chunk 等），帧为 JSON，`payload` 即 MuxFrame
- 订阅按连接绑定，会话列表从 `dsh-home/sessions/` 落盘目录或 Web UI 获取

## 架构

- **依赖按需部署**：zip 零依赖（约 0.1MB，代码 bundle + 配置 + 技能 + lockfile）。dsh 依赖树（`@deepseek-ai/dsh` + node-pty/koffi 原生模块，约 246MB）由 Agent 部署时 **npm ci 到数据目录 `dsh-pkg/`**（升级安装整体替换插件目录不丢依赖；registry 不通时切镜像 `--registry=https://registry.npmmirror.com`），也可在 DSHana 标签页 deps 卡片点「安装依赖」自动完成（v0.8.6+，命令同上）。解析链：`<dataDir>/dsh-pkg` 优先 → 插件安装目录 `node_modules`（兼容旧形态）。依赖完整性另经**运行级验证**（`node cliBin --version`，v0.8.7+，能跑 = 依赖图完整，防 npm ci 中断/--omit=peer 误用造成的假就绪）
- **插件本体 rspack bundle**：`index.js` + `tools/*.js` 经 `scripts/build.mjs` 打包，`scripts/pack.mjs` 铺平到标准位置交付（根 `index.js` + `tools/`，无 dist/）。构建工具 @rspack/core 声明为 devDependencies（构建契约，部署 `--omit=dev` 不装）
- **dsh 启动 patch overlay**：dsh-run.js spawn `dsh --profile web --patch <...> --port <...>`，启动前渲染单一模板 `dsh-plugin/dsh-hanako.patch.yml.tpl` 为机器绝对路径写数据目录 `dsh-hanako.patch.generated.yml`（五段：session-query 全文搜索默认启用 `openAt: first-search` + dsh-hana-logger 统一日志服务注册 + dsh-hana-theme 主题插件注册 + dsh-hana-provider 宿主 provider 跟随注册 + dsh-hana-default-model 设置页默认模型配置块注册；v0.9.5 起 provider 段**恒渲染**——无配置项，宿主数据目录直接探测（插件安装形态 `<宿主数据目录>/plugins/<pluginId>` 上溯定位 models.json / provider-catalog.json），default-model 段同样恒挂载；四段 cordis 插件均**包名注册**（`name: dsh-hana-logger / dsh-hana-theme / dsh-hana-provider / dsh-hana-default-model`，非 file:// URL，因 dsh client 模块发现按 `require.resolve('<name>/package.json')` 解析，file:// 不可解析），dsh-run.js spawn 前在 `$DSH_HOME/profiles/node_modules` 幂等创建 junction 指向插件安装目录 `dsh-plugin/<同名包>`（与 dsh 自维护的 junction farm 同机制——dsh 的 `healProfilesModuleFallback` 只管理自身依赖闭包，不碰外来 junction））；模板缺失/渲染失败不挂任何 patch 记 warn（会话全文搜索保持上游默认禁用）——patch 缺失时优雅降级不阻断启动
- **凭据与模型跟随**（v0.9.5+）：dsh-hana-provider 插件恒开直读 Hana 宿主 `provider-catalog.json`（凭据）+ `models.json`（模型），dsh models 页出现 Hana 全部 provider；配置热跟随 = **宿主 push**（v0.10.7：宿主侧经 `ctx.resources.watch` 感知两文件变化，bus 派发 `resource.changed` → 防抖 300ms → POST dsh web host `/api/hana-provider.refresh`，dsh 侧插件重读配置 `handle.replace()` 原子更新，不再自建 fs.watch）；任务模型默认 = dsh 默认模型（`settings.yaml` 的 `agent-default-model`），`dsh_run` 工具参数 `provider`/`model`/`reasoningEffort` 显式覆盖（显式时 selectModel，dsh 会把所选模型写回全局默认 settings.yaml）
- **统一日志**（v0.10.8）：DSHana 插件全量运行日志 = `<dataDir>/logs/` 下**时间戳会话文件** `<YYYYMMDD-HHmmss-SSS>.log`（每次插件会话一个，文件名即应用层创建时刻，毫秒级唯一），DSHana 诊断面板/错误信息直接显示当前会话日志路径。内容 = index.js 生命周期 + web host 进程 stdout/stderr **全量落盘** + theme/provider/default-model 三个内嵌插件诊断（经 **dsh-hana-logger** 统一日志服务写日志——cordis `provide 'hanaLogger'` / `inject ['hanaLogger']`（服务名驼峰与属性访问一致，不能用 'logger'——cordis 内置 LoggerService 冲突，也不能用连字符名——注入属性按服务名原样挂载），单一实现，src 前缀不变；**logPath 仅 logger 段注入**，消费方零配置）+ dsh-run 工具关键路径；行格式 `[HH:mm:ss.SSS] [out|err|provider|theme|default-model|hana] 内容`（文件名即创建时刻，无首行冗余），provider 前缀记 refresh 成功（provider/模型数/耗时）/失败/收到刷新请求。**旧日志 zstd 压缩、全部保留**（同 dsh session 持久化哲学）：插件 onload 时把上一会话及更早的时间戳 `.log` 用 **Node 内置 `node:zlib` zstd**（零依赖，标准格式 magic `28b52ffd`，任何 zstd 工具可解）压缩为 `.log.zst` 后删原文件，不删除任何历史；web host 多次重启（失败重试/手动重启）不换会话文件，同一插件会话日志连续。**启动失败排查**：诊断界面看 stderr 尾部（截断 ≤800）与「本次会话日志」路径 → 完整日志打开该时间戳文件，历史日志看 `.zst` 压缩文件
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

- **v0.11.0**（2026-08-16）：卡片架构大版本——**SSE 推送 + 零状态插件**。① 卡片链路从 HTTP 轮询改为 SSE 服务端推送：新增 `/ops/stream`（先推 baseline = jsonl 恢复快照，再按 sessionId 转发 DSH mux 实时事件），卡片 EventSource 本地拼文本节流渲染、收 blocks/usage、turn/end 定终态，轮询退役（`/ops/status`、`/ops/output` 降级为纯 jsonl 兜底）；② **op Map 退役**：插件不再存任务快照（status/output/summary），session.jsonl 为唯一事实源，运行中归一化（重建窗口无 turn/end 如实显示 running，不再误报完成），审批/取消靠运行期协调条目（终态即删）；③ `dsh_cancel` 支持 sessionId 直接取消；④ 本地超时倒计时（URL timeoutMs + startedAt）；⑤ 顺带合入终态瘦身（op.output 清空留预览）、URL 携带 timeoutMs（恢复态时间行有预算）、词元缺失不显示（cache/thinking 无源不兜 0）
- **v0.10.45**（2026-08-16）：终态瘦身 + URL 携带 timeoutMs——① **内存降级**：任务终态后 op.output 全文清空（只留 1KB outputPreview + outputLength），完整输出按需从会话 jsonl 恢复（recovered 路径 + LRU 缓存），op Map 50 条内存从 MB 级降到 ~150KB；② **URL 带 timeoutMs**：卡片 URL 追加 timeoutMs（会话日志无该配置项），恢复态「时间」行能显示超时预算（readOp 在快照无值时用 URL 值覆盖）
- **v0.10.44**（2026-08-16）：词元缺失不显示——累计器初始化不再把 cacheReadTokens/reasoningTokens 兜成 0（字段恒存在导致 fmtUsage 误显示 0）：缺失字段不初始化，API 未返回（如 deepseek-v4-flash 不报 cache/reasoning 明细）时卡片不显示对应项，真 0 仍显示 0；dsh-run 累计与 routes mergeUsage 同步修正
- **v0.10.43**（2026-08-16）：详情区细节——label 宽度 56px→auto（自适应内容，值区更宽），详情区左右 margin 8px（相对卡片边缩进）
- **v0.10.42**（2026-08-16）：任务行展开保留换行——任务描述含换行符时展开后平铺（HTML 文本节点默认折叠换行为空格），修复：折叠态 `white-space: nowrap`（单行截断不受换行干扰），展开态 `white-space: pre-line`（保留任务描述换行）
- **v0.10.41**（2026-08-16）：滚动摘要预览 1KB——outputPreview 1MB 改 1KB（1024 字符，滚动摘要显示量更足；1MB 轮询体过重）
- **v0.10.40**（2026-08-16）：滚动摘要预览放宽——outputPreview 300 字符 → 1MB（≈不截断，dsh 输出远小于此），滚动摘要直接显示完整输出（不再因 300 字符尾部截取显得量少、文本内容时卡片偏矮）
- **v0.10.39**（2026-08-16）：恢复 body margin——margin:0 视觉贴边太紧，恢复默认 8px，body max-height 600→584（584 + margin 16 = html 600 锁宿主上限不变）
- **v0.10.38**（2026-08-16）：body margin 重置——实测 html 616px = body 600px + 默认 margin 8px×2，body 规则补 `margin: 0`（浏览器默认 8px 未重置导致 documentElement 溢出 16px），html 与 body 对齐 600
- **v0.10.37**（2026-08-16）：纯 CSS 按需拉长——移除 JS 动态限高，改 flex 布局：body `flex column + max-height:600 + box-sizing:border-box`，中间层（#dsh-root/.dsh）参与收缩链（flex:0 1 auto + min-height:0），固定元素 flex-shrink:0，摘要区 `flex:0 1 auto + min-height:0 + overflow-y:auto`；内容短 body 贴合、长时顶满 600、摘要区收缩到剩余空间滚动（本地验证：短 282/中 600/长 600）
- **v0.10.36**（2026-08-16）：摘要区按需拉长——移除写死限高（339），改为 JS 动态计算：渲染后实测固定部分（头部/详情/按钮/meta）高度，摘要区 max-height = 600 - 固定部分 - 2px，body 总高锁 600；内容不足自然贴合、超出内部滚动（视图切换后重新 fit）
- **v0.10.35**（2026-08-16）：运行时完整输出结构化——dsh-run 事件循环同步收集 assistant/message 的 blocks（text/reasoning/tool-call），终态 op.output 改用 `dsh-blocks-v1::JSON`（reasoning 可折叠，与恢复态同构；回调/返回值保持 chunk 流文本）；readOp 的 outputLength 按 text 块口径；卡片终态后重拉一次完整输出（运行时拉的是 chunk 文本，终态刷新为结构化）
- **v0.10.34**（2026-08-16）：切换按钮文案分态——运行中显示「滚动摘要」（实时预览），终态显示「最终结论」，完整输出视图仍「完整输出」
- **v0.10.33**（2026-08-16）：运行态限定滚动行为——滚动条隐藏与固定滚底仅作用于运行中实时预览（.dsh-summary.live 类，render 按 running 切换）：运行中隐藏滚动条并固定滚底跟随最新输出；终态摘要与完整输出视图恢复正常滚动（显示滚动条、自由滚动）
- **v0.10.32**（2026-08-16）：摘要区限高 + 滚底跟随——回退固定高方案：摘要区恢复 max-height 339px（内容短贴合、长则内部滚动），滚动条隐藏（scrollbar-width:none / ::-webkit-scrollbar 隐藏），内容更新与视图切换后自动滚到底部（跟随最新输出）
- **v0.10.31**（2026-08-16）：摘要区高度固定化——限高值（339）保留但由 max-height 改为固定 height：内容不足时留白、超出时内部滚动，卡片高度恒定 ≈600（不再随 md 渲染内容高度波动），所有任务视觉统一
- **v0.10.30**（2026-08-16）：宿主偏移补偿——实测 v0.447.4 宿主 card iframe = 上报 - 16（上报 584→iframe 568，600→584），上报余量 0→+16 补回宿主减去的偏移，让 iframe 贴合 html（html 599.5 → 上报 616 → iframe 600）
- **v0.10.29**（2026-08-16）：限高修正——v0.10.28 限高 361 实测 html 621.5px 超出（实际头部 260.5px 而非估算 238.5px），回调至 339px（600-260.5=339.5），内容重新顶满 600 不超出
- **v0.10.28**（2026-08-16）：高度顶满与 iframe 贴合——按实测（html 553.5px / iframe 568px）调整：摘要区限高 315→361px（内容顶满宿主 600px 上限），上报余量 +30→0（iframe 贴近 html 高度，去除多余空间）
- **v0.10.27**（2026-08-16）：详情区行合并——「开始」与「超时」合并为「时间」行（格式 `<开始时间> / <超时预算>`，如 `20:11:42 / 30m`；无超时或恢复态只显示开始时间），详情区固定 6 行（任务/目录/模型/时间/词元/状态），高度更稳定
- **v0.10.26**（2026-08-16）：恢复快照补齐模型行——从事件窗口内首个 request/header 事件提取实际模型配置（data.header.config 的 provider/model/reasoningEffort，如 deepseek/deepseek-v4-flash/high），恢复卡片详情区不再缺「模型」行（超时行为配置项，日志无源，保持不显示）
- **v0.10.25**（2026-08-16）：恢复输出结构化（reasoning 折叠）——恢复快照的完整输出不再拼 chunk，改为从 assistant/message 的 content blocks 按序收集：`dsh-blocks-v1::JSON`（text 块 markdown 渲染 / reasoning 块渲染为 `<details>` 可折叠「思考过程」/ tool-call 块小字显示工具名）；卡片渲染器 renderBody 识别该前缀（运行时 chunk 流输出不受影响，仍走 mdToHtml）；预览与长度按 text 块文本口径；实测首个任务恢复：reasoning 23 / text 129 / tool-call 187 块，文本 121KB，摘要 2.1KB 分离
- **v0.10.24**（2026-08-16）：恢复输出口径修正——摘要与完整输出对齐运行时语义：① **完整输出** = 事件窗口内 assistant/chunk 的文本增量拼接（与 dsh-run 运行时 textFromChunk 同口径：delta.text ?? block.text ?? text，含 agent 中间叙述；chunk 流无文本时回退 assistant/message 拼接）；② **摘要** = 最后一个 finish（reason.kind==stop，工具循环结束的最终 LLM 调用）之后的 assistant/message 文本（最终回答）；修复恢复卡片摘要与完整输出相同的问题（实测：181KB 过程输出 vs 2.1KB 最终报告）
- **v0.10.23**（2026-08-16）：卡片持久化架构——op 数据从会话日志可恢复（零映射文件）——① **rpcId 关联**：callUnary 暴露 rpcId，session.prompt 调用记录 op.rpcId（与会话 jsonl 的 user/message 事件 data.source.rpcId 同值）；② **URL 推迟生成**：submitTask 加 ready 信号（session.create + prompt 提交后 resolve），卡片 URL 推迟到此后携带 sessionId+rpcId，重启后精确恢复；③ **jsonl 恢复路径**：/ops/status 与 /ops/output 支持 sessionId+rpcId，内存 op Map miss 时从会话日志（追加式多帧 zstd，逐帧解压）按 user/message（data.source.kind==user + rpcId 匹配）定位，取事件窗口重建 op 快照（task/耗时/输出/词元累计/turn-end 原因），缓存 LRU 20 条避免重复解压；④ 旧 opId-only 卡片兼容（内存路径不变）
- **v0.10.22**（2026-08-16）：词元统计修正——卡片词元从「最后一轮 LLM 调用用量」（覆盖式收集，多轮任务严重偏小）改为**任务维度累计**（每轮 assistant/message 的 disjoint usage 求和：未缓存输入/输出/缓存读取/推理），与 dsh 会话投影 tokenUsage.totals 口径对齐（实测：Docker 任务卡片原显示 out 318，实际累计 out 7935 / cache 22528）；resume 复用会话时统计本次任务的消耗，而非会话历史累计
- **v0.10.21**（2026-08-16）：详情区行序调整 + 耗时实时化——① **行序重排**：任务 → 目录 → 模型 → 开始 → 超时 → 词元 → 状态（状态移至末行）；② **运行中耗时实时计算**：头部时长不再用 op 快照值（发出时定格），改用 startedAt 实时推算（now - startedAt），且轮询渲染时即使内容未变化也刷新 dur（每秒走动，终态后回落到准确总耗时）
- **v0.10.20**（2026-08-16）：移除冗余 cwd 行——头部下方的「cwd: …」行与详情区「目录」行重复，删除该行并把高度让给摘要区（限高 293→315px），卡片总高不变、内容区更大
- **v0.10.19**（2026-08-16）：卡片高度与预览收敛——① **限高放宽**：摘要区 280→293px，按实测差距（卡片 586.5px → 600px）放宽，整体贴满宿主上限且不触发 clamp；② **尾部预览截取减半**：运行中摘要的尾部预览从 600 字符减到 300 字符（outputPreview slice 调整），滚动场景下摘要更紧凑
- **v0.10.18**（2026-08-16）：卡片高度稳定化——① **词元行常显**：详情区词元行始终显示（无 usage 时显示「—」），详情区行数结构稳定，卡片高度不再随词元有无波动（解决有词元时偏短、无词元时偏长的观感差）；② **限高下调**：摘要区 max-height 300→280px，配合词元行常显与 +30px 上报余量，有/无词元时卡片高度趋于一致且不超出宿主 600px 上限
- **v0.10.17**（2026-08-16）：agentPreset 默认补齐——标题的 agent 预设未显式传时，从 settings.yaml 的 `agent-presets.default` 读取补齐（如 code），标题显示「DSHana · code」，与 dsh 默认预设一致；显式传参仍优先（op 快照与 session.create 均用补齐后值）
- **v0.10.16**（2026-08-16）：修复三处——① **按钮文案修正**：显示摘要时按钮「摘要」、完整输出时「完整输出」（v0.10.15 写反）；② **切换按钮始终显示**：不再等输出超 600 字符才出现，摘要区上方恒有切换按钮；③ **默认模型解析修复**：readDshDefaultModel 缩进出块判断 `<=2` 误伤 2 空格标准缩进（YAML 子项），改为仅无缩进/非键行才出块——修复「模型」行（provider / model / effort）显示不出来
- **v0.10.15**（2026-08-16）：卡片信息增强与高度定稿——① **标题带 agent 预设**：头部显示「DSHana · <agentPreset>」（未指定时仅 DSHana）；② **新增模型行**：详情区显示 provider / model / reasoningEffort（显式参数优先，缺省从 dsh 默认补齐；op 快照与 /ops/status 新增 agentPreset/reasoningEffort/provider/model 字段）；③ **切换按钮文案简化**：显示摘要时按钮「摘要」、完整输出时「完整输出」（去字符数与箭头）；④ **高度定稿**：上报余量 +30px，摘要区限高 300px，默认状态整体不超出宿主 600px 上限
- **v0.10.14**（2026-08-16）：卡片细节调整——① **切换按钮上移**：完整输出/摘要切换按钮置于摘要区上方（右对齐，margin-bottom 6px）；② **限高回调 + 高度补偿**：摘要区限高 335→320px，高度上报余量 +3→+18px 补回 15px，整体卡片高度保持不变；③ **词元中文化**：详情区标签「Token」改「词元」（值格式 in/out/cache/thinking 保持英文术语）
- **v0.10.13**（2026-08-16）：卡片展示重构——① **标题固定 DSHana**：头部标题行固定显示插件名，任务文本改由详情区任务行承载（单行截断 + 点击展开）；② **摘要/完整输出共用容器**：同一容器按钮切换内容（摘要 ⇄ 完整输出），完整输出仍懒加载缓存、切换即时渲染；③ **摘要区限高 320→335px**：整体卡片高度 +15px，内容区显示更多（总高仍稳在宿主限制内）
- **v0.10.12**（2026-08-16）：卡片背景与高度余量修正——① **背景挪到 body**：`background: var(--tool-bg)` 从 .dsh 容器移到 iframe body（覆盖整块卡片区域，宿主注入变量时生效，未定义回退透明）；② **高度上报 +3px**：scrollHeight 取整后加 3px 余量，抵消宿主 iframe 边框/取整差异，避免内容贴底时出现轻微滚动条
- **v0.10.11**（2026-08-16）：卡片交互与高度治理——① **任务值展开状态持久化**：展开状态存 JS 变量（taskOpen），轮询重建 DOM 后保持展开，不再自动收起（上版 class 存 DOM 的缺陷）；② **摘要区限高内部滚动**：max-height 320px + overflow-y auto，卡片总高稳在宿主 iframe 高度限制内，内容超长时摘要区内滚动、iframe 不再出现滚动条（与完整输出区同款）；③ **卡片整体背景**：`.dsh` 容器加 `background: var(--tool-bg)`（宿主未定义时回退透明）
- **v0.10.10**（2026-08-16）：卡片高度自适应修复 + 任务值单行可展开——① **高度上报增强**：`document.fonts.ready` 字体就绪后补报 + `ResizeObserver` 跟随 body 内容尺寸变化自动重报（防抖 60ms），根治宿主字体异步加载导致卡片刚出现时高度偏小、带滚动条的问题（终态后轮询停止、高度定格在偏小值的时序缺陷）；② **任务值单行可展开**：详情区「任务」行默认单行截断（-webkit-line-clamp 1），点击展开/收起全文（hover accent 色提示可点击）
- **v0.10.9**（2026-08-16）：卡片摘要/输出区排版重做——代码块（纸面分层 + 0.5px 细边框 + 4px 圆角 + 12px 字号）、表格（去四边网格改表头下划线 + 行间细分隔线 + 末行去线 + tabular-nums 数字对齐）、引用（2px accent 边条 + 淡蓝便签底 + 斜体）、标题字重 600→500 + h2 accent 边条、列表圆点着 accent 色、hr 改细线、加粗 500+accent、内联代码加细边框（host 主题变量 + fallback，跨主题可用）
- **v0.10.8**（2026-08-16）：三大功能块 + 统一日志服务——① **宿主 push 配置跟随重构**（方案 A）：宿主侧 `ctx.resources.watch` 感知 models.json / provider-catalog.json 变化，bus 派发 `resource.changed` → 防抖 300ms → POST dsh web host `/api/hana-provider.refresh`，dsh 侧插件重读配置 `handle.replace()` 原子更新，替代 dsh 进程内 fs.watch（manifest 加 `resource.watch` / `network.fetch` capabilities + allowedHosts）；② **统一日志体系定稿**：时间戳会话文件 `<YYYYMMDD-HHmmss-SSS>.log`（文件名=应用层创建时刻，毫秒唯一，不受 NTFS CreationTime 怪癖影响），旧日志 zstd 压缩全部保留（Node 内置 `node:zlib`，标准格式 magic 28b52ffd，零依赖），诊断面板显示当前会话日志路径，**无 latest.log 指针**；③ **junction 无条件重建**（lstatSync 实体判断不跟随，悬空/指向旧路径一律删旧建新，修旧版本悬空 junction 启动报错）；④ **dsh-hana-logger 统一日志服务**——新内嵌 cordis 插件 `provide 'hanaLogger'`（服务名驼峰：不能用 'logger'——cordis 内置 LoggerService 冲突；不能连字符——注入属性按服务名原样挂载），theme/provider/default-model 三插件 `inject ['hanaLogger']` 统一写日志，删除各自内联 appendFileSync 实现（单一实现，src 前缀不变）；logPath 仅 logger 段注入，消费方零配置；patch 模板五段、junction 四包；日志文案精简（无首行冗余、压缩行去括号）。含 0.10.7（assets/ → 根级 dsh-plugin/ 结构重构，git mv 保留历史；移除 session-query 静态回退）、0.10.6（config/ → assets/patches/ 归并）、0.10.5（静态资产 terser/clean-css 压缩，zip 185→168KB）、0.10.4（三插件统一包名注册 hana-theme / hana-provider / hana-default-model 修复列表显示不一致）中间迭代
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
