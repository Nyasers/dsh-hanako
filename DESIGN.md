## 工具

五个工具由插件注册（实现 `tools/*.js`；vX 起 dsh_update 并入 dsh_install 四合一），**完整调用手册（参数语义、返回结构、错误码、审批通道、副作用）见各工具的 SKILL**：

| 工具 | 用途 | 调用手册 |
| --- | --- | --- |
| `dsh_run` | 提交任务给 dsh agent 执行（默认异步，wait=true 同步；provider/model 显式覆盖） | [dsh-run](skills/dsh-run/SKILL.md) |
| `dsh_install` | 安装/验证 dsh 依赖 + 检查/更新 dsh 版本四合一（action=install/verify/check/update；install 可指定 version/tag，自动重试 registry + 自动运行级重验 + autoStart，渲染安装卡片；check 本地 + 远端 dist-tags + 基线 tag；update 重启 web host，正在执行的任务中断，渲染升级卡片） | [dsh-install](skills/dsh-install/SKILL.md) |
| `dsh_approve` | 应答 dsh 任务挂起的权限审批（allowed-once / rejected） | [dsh-approve](skills/dsh-approve/SKILL.md) |
| `dsh_cancel` | 取消运行中的 dsh 任务（主动止损，幂等） | [dsh-cancel](skills/dsh-cancel/SKILL.md) |
| `dsh_session` | 统一会话查询（list=清单与摘要 / get=凭 sessionId 直取内容（summary），仅限 agent 自己创建的会话——config.json sessions 注册表作用域） | [dsh-session](skills/dsh-session/SKILL.md) |

## dsh Web UI（DSHana 标签页）

配置 `webPort`（默认 3080）时，**插件加载即拉起** `dsh --profile web`（dsh 官方浏览器 UI：观察任务会话、模型配置——Hana 宿主 provider），卸载/重载时一并回收。设 `webPort: 0` 可关闭。

DSHana 以**整页卡片**注册（manifest `contributes.cards[]`，id `dshana`，type `webview`，route `/webui`，realization `page`，含 `functionPanel` 左侧功能面板贡献），卡片 iframe 内嵌 `http://127.0.0.1:<webPort>/`：

- **功能面板（functionPanel）**：manifest 声明 `functionPanel: { id: "dshana-panel", label: "DSHana" }`，面板内容由壳页运行时推送（`hana.panel.set`，宿主内置原语渲染，面板宽度 180–400px 可拖）：**status 段**（web host 状态运行中/未就绪/启动中/安装依赖中 + 端口，deltaTone 按状态 success/danger/warning）、**actions 段**（手动启动 / 安装依赖 / 检测依赖 / 复制日志路径四个常驻操作，`activation: { kind: "emit" }` 回传壳页执行现有 fetch 逻辑）、**meta 段**（日志会话路径只读展示，有值才推）。面板事件经 `hana.panel.onEvent` 分发到 startWebHost/installDeps/verifyDeps/copyLogPath；宿主刷新 tick（`refresh: { intervalMs: 5000 }`）经 `hana.panel.onRefresh` 触发轻量 health 重读并同步面板。**降级**：宿主未注入/不支持面板时 pushPanel 内部吞错，页面功能回退现状不受影响。壳页内置最小 hana 桥（与 @hana/plugin-sdk 同协议 hana.plugin.ui v1，插件 bundle 不引入 SDK 包），浏览器侧 fetch 一律走 `hana.api.fetch`（自动带 `X-Hana-Plugin-Surface-Session` 头，替代旧 surfaceHeaders 手动拼接）。
- **就绪加载（v0.22.1+ 就绪事件化）**：按总线连接状态（`g.dshanaBus.status().connected`）判定就绪——已连接直接渲染 iframe；未连接渲染**加载态**（「正在启动 DSH web host…」）并订阅 `GET /webui/events` 就绪事件流（SSE 式 chunked）：宿主 bus ready（hello-ok）后推 `ready` 事件 → 壳页动态挂载 iframe；web host 启动失败推 `diagnostics` 事件（readDiagnostics 自检）→ 壳页直接显示自检；web host 停机推 `pending` 事件 → 退回加载态。**30s 超时兜底**：未收到 ready 引导用户刷新页面/查看诊断（一次性 `/webui/health` 查询渲染自检，不轮询）。页面桥（父窗口 postMessage `{ type:"ready" }` 或 `hana.plugin.ui` 事件 `dsh.ready`）也可直接触发挂载。旧「服务端 probeHost + 浏览器 3s 轮询 `/webui/health` 挂载」链路退役；`/webui/health` 保留为**纯诊断端点**（返回 readDiagnostics 自检 + web host 状态，probeHost 仅诊断路径使用）。
- **主题跟随**：见下节

### 主题跟随

DSHana 标签内 dsh 主题与宿主 Hana 联动：

| dsh 偏好 | 标签页效果 |
| --- | --- |
| `system`（默认） | 跟随 Hana 当前主题（明暗 + 配色） |
| `light` / `dark` | dsh 内置原生配色 |

**机制**（宿主声明，无静态主题表）：

1. **明暗**：壳页面按 `hana-theme` query 映射 `color-scheme`（深色主题 → dark），Chromium 让跨源 iframe 的 `prefers-color-scheme` 继承父页面 color-scheme，dsh 的 `system` 解析即跟随宿主明暗
2. **配色**：壳桥 `getComputedStyle` 读宿主 `theme.css`（宿主动态端点 `/api/plugins/theme.css?theme=<id>`，返回压平为 `:root` 的扁平版，插件页面 link 即生效）的 16 个主题变量（bg 层次 / 文字三阶 / accent 三态 / border / green / danger / userBg / overlay 三档 / dropOverlay），回传给注入的 `@dsh-hanako/theme` cordis 插件，写 **body 层 `!important` 覆盖**（dsh 的 presenter 把 token 以 inline style 写到 body，覆盖必须同层才压得过）
3. **覆盖范围**：72 个 `--dsw-alias-*` + `--dsw-specific-*` token（bg 层次/遮罩/文字/brand/button/border/interactive/markdown/state/组件专用/滚动条），功能性颜色保留原生（照片查看器黑底、danger·warn 语义色、按钮反白文字、toast·tooltip 深色浮层、工具栏半透明、骨架屏、反白边框）
4. **分发**：cordis 插件经 dsh-host-webserver `tapIndex` 注入 index 响应；插件本体在安装目录 `dsh-plugin/@dsh-hanako/theme/`（包名 `@dsh-hanako/theme` 注册，dsh-run.js 启动前在 `$DSH_HOME/profiles/node_modules` 建 junction 指向安装目录——v0.18.1 起五内嵌插件统一 `@dsh-hanako` scope：`profiles/node_modules/@dsh-hanako/<pkg>` → `dsh-plugin/@dsh-hanako/<pkg>`，启动时顺带清理旧名 `dsh-hana-*` 遗留 junction（dsh-hana-default-model / dsh-hana-proxy 等），无条件收敛杜绝混装）

**生效时机**：宿主切 Hana 主题后，壳页接宿主 `hana.theme.changed` 广播**实时跟随**，无需重开标签页（webui-shell 主题桥按新 cssUrl 换 link 重读变量，宿主新增/修改主题零适配）。用户切 dsh 偏好（`system`/`light`/`dark`）现也**实时生效**——@dsh-hanako/theme 注入脚本经 `/api/events.host` WebSocket 订阅 dsh 自身 `settings/document-updated` 变更广播（`ui-theme` namespace），偏好一变即回读 `pref` 并重跑 `applyOrRemove()`，无需重开标签页。

### DSHana 设置分页（v0.9.5 默认模型 → v0.13.0 改名升级）

dsh 设置页左下角齿轮打开设置面板，导航栏出现**原生**「DSHana 设置」分页（settings.section slot 注册——id `dshana-settings`，ledger 驱动导航自动投影，点击切换/内容渲染全走 dsh 原生 React；v0.13.0 由「默认模型」分页改名升级）。分页 = **设置中心式布局**（v0.13.0 UI 重排，不再是「默认模型表单 + 版本块硬堆叠」）：顶部 **DSHana 品牌页头**（齿轮图标 + 标题，`hs-*` 类前缀 = hana-settings，替代改名前的 `hdm-` = hana-default-model），下方**两个并列的分组卡片**（`.hs-card`，卡片头分隔线 + 独立内容区）：

**① 默认模型卡片**：DSHana 的 `agent-default-model`（`settings.yaml`）是任务默认模型的事实源——`dsh_run` 不显式传 `provider` / `model` 时用它。dsh 设置页原生没有该段的配置 UI（`settings.mutate` 对 `agent-default-model` 段不可用，「not exposed to configuration clients」），由本卡片补显式入口：

- Provider / 模型 / 思考强度 三级联动下拉 + 保存按钮 + 当前值回显
- **选项**：`llm.models` RPC 权威列表——dsh 全部可用 provider（宿主注入的 sensenova/agnes/deepseek 与 dsh 单独配置的 deepseek-official 等）；模型按 provider 联动过滤；思考强度按模型 `reasoning.efforts` 动态填充（off/high/max 或 minimal/low/medium/high 等，无 `reasoning` 的模型不显示思考下拉）。**联动行为**：切 provider 自动选中该 provider 第一个模型 + 默认思考强度；打开分页回显当前默认（provider/model/effort 预选到表单，无当前值时自动选第一个 provider）
- **保存即生效**：写 `settings.yaml` 的 `agent-default-model` + 更新内存态，无需重启；此后 `dsh_run` 不显式指定时即用此默认

**② DSH 版本卡片**：`@deepseek-ai/dsh` 版本检查与更新。Agent 工具 `dsh_install`（action=check/update）、DSHana 标签页（`/webui/check-update`、`/webui/update-dsh` + deps 卡片版本行）共用宿主侧 `checkDshUpdate` / `updateDsh`；本分页 v0.18.1 起**检查改 dsh 侧直查**（v0.18.2 起 HTTP 直查 npm registry：fetch `https://registry.npmjs.org/@deepseek-ai/dsh/latest` 的 JSON `version` 字段（pnpm view 语义等价，官方源失败重试一次 npmmirror，15s 超时），不再 spawn pnpm / 不依赖运行时引导；早期实现曾 spawn 宿主 electron node + pnpm 入口执行 `pnpm view @deepseek-ai/dsh version`（pnpm 运行时经 `tools/lib/pnpm.js` `ensurePnpm` 引导：下载 `pnpm-{version}` 的 `pnpm.mjs`（入口 CLI）到数据目录 `pnpm-dist/`），该路径已随 patch 模板 `{{NPM_CLI_PATH}}` 占位符删除；不再经宿主桥接——修复 resources.watch 桥接不可靠导致检查永不完成的问题），更新仍走宿主能力层：

- **本地版本**：dsh 侧直读 dsh-pkg `package.json`（零延迟，挂载即显示）；远端版本 dsh 侧 HTTP 直查（同款 fetch npm registry）→ `{ localVersion, latestVersion, updateAvailable, error? }`（zero-dep semver 比较，`-rc.x` 预发布按序号比）
- **更新闭环**：「更新到最新」→ `POST /api/hana-settings.request-update` → 经 **dshana.bus 进程间消息总线**（`@dsh-hanako/bridge` 在 dsh webserver 注册 `/api/dshana.bus` upgrade 路由，宿主插件连接后双向收发 JSON 文本帧 `{ channel, payload }`）发 `update.request` 直投宿主（v0.22.1 起替代 `POST /child/post` 单向 HTTP 反向信道——`/child/post` 已退役；再往前是 update-request.json 文件桥，早已退役）→ 宿主 `updateDsh`（停 web host → `installDepsFromPlugin`（pnpm add `@deepseek-ai/dsh`，按配置基线 dshTag，默认 latest）→ 起 web host → 读新版本）→ 结果走内存态 `g.update`（v0.24 状态收敛：update-result.json 退役）并经总线回投 `update.result` → **v0.22.1+ 事件化**：前端订阅 `GET /api/hana-settings.update-stream` 事件流（SSE 式 chunked，宿主经总线 update.progress/update.result 回投驱动）直到 done/error——替代旧 2s 轮询 update-status；事件缺失时手动刷新（update-status 一次性查询兜底：设置页后端事件缓存优先；update-result.json 已退役无文件兜底）。bus 未就绪（无已连接客户端）时 request-update 返回 `{ ok:false, error:"消息总线未连接" }`；config 未下发（hello 未完成）时 check-version/update-status 返回 `{ ok:false, error:"总线配置未就绪" }`。done 显示「更新完成 vX.Y.Z，请重启 DSHana 使完全生效」
- **并发防护**：宿主 `g.check.status` / `g.update.status` 状态（v0.24 起分组结构化）——检查/更新进行中重复请求跳过（请求触发层 + 能力层双重防护）；检查另加 5s 时间窗防 npm view 重复跑
- **基线差异说明**：本卡片检查恒直查 `latest`；宿主侧检查/更新（Agent 工具 `dsh_install`、标签页 `/webui/check-update`、`/webui/update-dsh`）未显式传 version/tag 时按配置基线 `dshTag`（默认 latest）执行，基线非 latest 时两者结果可能不同

**机制**：`@dsh-hanako/settings` 插件按 dsh client 插件规范双端部署——后端（`index.js`）注册 `POST /api/hana-settings.read` / `.save` / `.check-version` / `.request-update` / `.update-status` + `GET /api/hana-settings.update-stream` 六条路由（`webServer.register` exact，read/save 经 `agentDefaultModel` 服务读写，check-version dsh 侧直查远端（dshPkgDir 来自总线配置 `dshanaBus.getConfig()`，config 未下发报「总线配置未就绪」），update 经 **dshanaBus 消息总线**（`@dsh-hanako/bridge` 提供 dshanaBus 服务）发 `update.request` 直投宿主，订阅 update.progress/update.result 事件缓存（v0.24 起 update-result.json 退役，无文件兜底））；前端（`client.js`，package.json 的 `dsh.client` 声明 + `exports["./client"]` 指向）注册 `settings.section` slot 原生渲染分页。包名注册经 `$DSH_HOME/profiles/node_modules` junction 解析（dsh-run.js 启动前幂等创建）

## 连接失败自检与自愈

web host 未就绪时，DSHana 标签页不再只显示「正在重试…」——未就绪诊断区展示**自检诊断列表**（配色跟随宿主主题的 CSS 变量），逐项检查并给出修复指引；同四项操作（手动启动/安装依赖/检测依赖/复制日志路径）常驻左侧**功能面板**（functionPanel actions 段），页面主体与面板按钮共享同一套 fetch 逻辑。**两项检查**（每项 ✓/✗ + 详情 + 修复指引）：

| 检查项 | 判定 | 操作 |
| --- | --- | --- |
| **t1 dsh 依赖** | 存在性（cliBin 文件存在）+ **运行级验证**（`node <cliBin> --version` 沿 import 图加载 cordis 模块树，能跑 = 依赖完整，抓 `ERR_MODULE_NOT_FOUND` 类假就绪） | 卡片按钮：缺失「安装依赖」/ 验证失败「重新安装依赖」/ 常驻「检测依赖」/ 安装中「安装中…」禁用。安装过程显示 pnpm add **实时进度**（--reporter=ndjson 结构化进度事件流 → 解析为可读进度行 → installLog 尾部 + 更新时间，3s 轮询刷新） |
| **t2 DSH 进程** | 单例 web 状态：未启动 / 启动中 / 已就绪但探测未中 / 已退出（webLastExit 持久记录：code/signal/时间/stderr）/ 启动失败（webLastError）；诊断区显示**「本次会话日志」路径**（`<dataDir>/logs/<YYYYMMDD-HHmmss-SSS>.log` 时间戳会话文件，v0.10.8+） | 卡片按钮「手动启动 web host」；**t1 未通过时按钮禁用**（msg「依赖未就绪，请先安装/重新安装依赖」） |

**自愈闭环**：t1 缺失 → deps 卡片「安装依赖」自动完成（写最小 package.json + 复制 pnpm-workspace.yaml（allowBuilds 白名单）到数据目录 `dsh-pkg/` → 创建指向宿主 electron node 的代理脚本 `pkgDir/node.cmd` → 清旧 npm 残留（package-lock.json / pnpm-lock.yaml / 扁平 node_modules）→ pnpm add `@deepseek-ai/dsh --reporter=ndjson` → 校验 → 自动运行级重验，官方源失败自动重试 npmmirror）→ t1 转 ✓ → t2 按钮解锁 → 「手动启动 web host」拉起进程 → 轮询就绪切 iframe。运行级检测「进标签页自动一次 + 手动「检测依赖」按钮」，不再随 3s 轮询重复触发。

**任务持续**：pnpm add 与 web host 都是宿主进程 spawn 的子进程——离开标签页任务继续，返回后重新渲染诊断仍可见进度（单例内存态；宿主重启则中断，需重装依赖）。

### 路由

| 路由 | 用途 |
| --- | --- |
| `GET /webui` | 页面壳（就绪探测 + 主题注入 + 首帧自检诊断 + functionPanel 面板推送；contributes.cards 整页卡 route） |
| `GET /webui/health` | 纯诊断端点（readDiagnostics 自检结果 + web host 状态；30s 超时兜底/手动刷新数据源，不再做就绪轮询） |
| `GET /webui/events` | 就绪事件流（SSE 式 chunked：ready/pending/diagnostics 事件；壳页就绪事件化的宿主推送通道） |
| `POST /webui/start` | 手动启动 web host（`ready` / `starting` / 触发启动三态） |
| `POST /webui/install-deps` | 安装依赖：pnpm add `@deepseek-ai/dsh` 部署到数据目录 `dsh-pkg`（停 host + 清旧残留 + 最小 package.json + pnpm-workspace.yaml），完成后自动运行级重验 |
| `GET /webui/verify-deps` | 运行级依赖检测（`node cliBin --version`，只读；进标签页自动一次 + 手动「检测依赖」按钮） |

## 任务反馈卡片

工具返回时宿主立即渲染 iframe 卡片（`details.card` 机制），**异步模式下无需等任务完成**：

- 提交即显示「运行中」卡片，实时刷新状态与耗时
- **SSE 推送渲染**：卡片启动先收 baseline（会话 jsonl 恢复快照），再经 `/ops/stream` 收 DSH mux 实时事件（assistant/chunk 文本增量节流渲染、blocks/usage 收集、turn/end 定终态）。插件零任务状态存储，session.jsonl 为唯一事实源，重启后旧卡片仍可从日志恢复
- **两级输出（PTC 式压缩）**：摘要区默认展开（运行中为输出尾部实时预览；完成后为最终结论摘要），完整输出超长时经「完整输出」按钮懒加载（默认折叠）
- **回调压缩（固定 minimal）**：异步完成回调只带定位键 `{ status, rpcId, sessionId }`（sessionId 唯一定位键，不再冗余 id 字段——id 与 sessionId 同值重复），不生成摘要、不占 Agent 上下文；取会话内容用 `dsh_session(action="get", sessionId=<id>)`（读会话 jsonl 直取最终结论 summary），完整输出在卡片（jsonl 恢复）与 dsh Web UI
- **Token 账目**：任务完成后卡片详情区显示 usage 统计 `Token: in / out / cache / thinking`（API 未返回 cache/thinking 明细时不显示对应项）
- 失败时显示错误信息

完成/失败时经宿主 deferred 通道唤醒 Agent，无需轮询等待。

### 安装/升级卡片（v0.13.0）

`dsh_install`（action=install/update）的**异步**流程渲染「安装/升级卡片」——与任务卡片同构（iframe EventSource），但数据源不是 dsh 会话 jsonl（安装/升级不是 dsh 会话），而是**宿主单例**：

- **登记**：异步工具流程生成 `taskId`（统一 `dsh_install_*` 前缀）→ 登记 `g.depTasks`（Map：`taskId → { taskId, kind: install|update, state: running|ok|error, log, at, result }`，kind 按动作区分卡片标题「DSH 安装/DSH 升级」）→ 返回 `details.card.route = /card/dep?taskId=...`（宿主渲染 iframe 卡片，与 dsh_run 同机制）
- **页面** `GET /card/dep?taskId=`（iframe 内容，`data-kind="dep"`）
- **SSE** `GET /ops/dep-stream?taskId=`：首帧快照 + 每 1s 推一次（running 时 npm 日志实时滚动），终态推送后关闭；30s 心跳防代理超时；`GET /ops/dep-status?taskId=` 兜底 JSON
- **数据源**：`g.depTasks` 条目 + `g.deps.log`（installDepsFromPlugin 的 npm i 输出与里程碑同通道 `emitLog` 流式写入内存尾环 ≤8000，实时尾部卡片侧 ≤2000；同流实时写会话日志 src=npm，行规范化）+ 更新终态直接取 `g.depTasks` 条目 `result`（v0.24 起 update-result.json 退役，result 即权威终态）
- **渲染**（app/card.js `initDepCard` 分支，按 `data-kind="dep"` 分流，不触碰任务卡片逻辑）：标题（DSH 安装 / DSH 升级）+ 状态徽标（安装中/升级中/完成/失败）+ npm 日志尾部预格式实时滚动（运行中隐藏滚动条 + 固定滚底）+ 完成结果行（「已安装 vX.Y.Z，web host 已自动启动」/「更新完成 vX，请重启 DSHana 使完全生效」/ 错误信息）

## 审批流程

dsh 会话默认 `approval/policy=ask`：agent 请求越界权限时发出 approval/requested，任务挂起等应答。插件捕获审批帧（保留 rpcId），把审批上下文存进运行期协调条目（终态即删，不落任务快照），经宿主 deferred 通道投递 `dsh-approval` 通知唤醒 Agent；Agent 收到后调 `dsh_approve` 应答（allowed-once / rejected），任务继续。

**唯一流程**：审批挂起 → 插件通知 Agent（**附命令/路径原文**，tool/call 参数按 callId 反查；code preset 子调用参数经 tool/code-dispatch-start 精确缓存）→ Agent 用 `dsh_approve` 应答 → 无人应答超时自动拒绝（`approvalTimeoutSec`，默认 30s，应答方失联检测；0 禁用）。**审批模式（manual/auto）与白名单（autoApprovePatterns）已移除**——所有审批一律过 Agent 决策，无自动放行。无人应答时兜底在 dsh Web UI 人工处理。

## 事件流通道（WebSocket）

dsh 的 `/api/events.mux` **要求 WebSocket 升级**：GET 返回 `426 Upgrade Required`，用 fetch + SSE 解析是错的。事件流必须 `ws://127.0.0.1:<port>/api/events.mux`（Node 22+ 内置全局 WebSocket）：

- 连接后收到 `session/subscribed` 帧（`{type, sessionId, lastSeq}`，sessionId 是本连接绑定的会话，不是会话清单）
- 之后收到各会话事件（assistant/chunk 等），帧为 JSON，`payload` 即 MuxFrame
- 订阅按连接绑定，会话列表从 `dsh-home/sessions/` 落盘目录或 Web UI 获取

## 进程间消息总线（dshana.bus，v0.22.1）

dsh 进程与宿主插件之间的**双向消息总线**（替代旧的 `POST /child/post` 单向 HTTP 反向信道——v0.21.2 引入，本版退役）。只做消息总线，不做代理（无 SW 拦截、无 HTTP 隧道、无请求转发——bridge 历史教训：feat/bridge-channel 曾做三层通道，因宿主 0.769 插件路由再分发（rft）丢失 upgrade raw socket/env 导致 WS#1 不可行，v7 改 HTTP 隧道补、复杂度爆炸，整体 revert（PR #17）；本次握手在 dsh webserver 内完成，不经过宿主路由再分发）：

- **服务端**（dsh 进程内）：`@dsh-hanako/bridge` cordis 插件经 `webServer.registerUpgrade({ path:"/api/dshana.bus", handler })` 注册 upgrade 路由——dsh-host-webserver 的 WebServer 类原生支持 upgrade 路由（`server.on("upgrade")` 按 pathname 分发，handler 拥有 socket 完整协商权，源码已核实），handler 内零依赖手写 RFC6455（`ws-lib.js`：Sec-WebSocket-Key/Accept、帧解析、分片重组、256KB 单帧上限、连接级错误处理与 socket 清理）。要求**首帧 hello**（v0.22.1+ **免鉴权**身份宣告：总线与 mux、`/api/session.*` 同级，本机信任，不再比对 token——patch 静态化后 bridge config 恒空）；5s 未发 hello 关闭；单连接语义（宿主唯一客户端，新连接 hello 通过后旧连接关闭）。提供 `dshanaBus` 服务（emit/on/status/getConfig——getConfig 返回宿主 config 帧下发的 `{ dshPkgDir, dataDir }`）
- **客户端**（宿主插件）：`src/lib/bus.js` 用 Node 22+ 全局 WebSocket（零依赖）连 `ws://127.0.0.1:<webPort>/api/dshana.bus`，open 后首帧发 `hello`（免鉴权，不带 token）；断线指数退避重连（1s→封顶 30s）、应用级心跳 `bus.ping`/`bus.pong`（30s/90s 判死）；单例 `g.dshanaBus`（emit/on/status/close）。web host 就绪点（ensureWebHost 唯一就绪点）`connectBus` + `setBusConfigProvider`（hello-ok 后自动发 config 帧）→ closeProcess/插件卸载 `closeBus`。本机事件 `bus.ready`（hello-ok 到达）/`bus.disconnect`（连接关闭）供宿主侧订阅（壳页就绪事件流、provider 补推）
- **协议**（JSON 文本帧 `{ channel, payload }`）：`hello`/`hello-ok`（握手）/ `config`（宿主下发 `{ dshPkgDir, dataDir }`，替代 patch config 注入）/ `log`（dsh 内部日志 `{ src, line }` → 宿主写会话文件，替代 logPath 注入）/ `update.request`（设置页发起）/ `update.progress`（宿主更新开始回投 `{ state, at }`）/ `update.result`（宿主回投 `{ state, version?, error? }`）/ `provider.refresh`（宿主 provider 路由推送 `{ routes }`，替代 `/api/hana-provider.refresh` HTTP push）/ `provider.refresh.request`（dsh 侧 provider 插件订阅建立后的就绪握手——宿主收到即重推最新 routes，覆盖首批 push 早于子插件订阅建立的时序窗口）/ `bus.ping`/`bus.pong`（心跳）。更新链路：设置页 request-update → dshanaBus.emit("update.request") → 宿主 bus 收到 → `g.updateDsh`（复用现有能力层：停 host → npm i latest → 起 host → 结果走内存态 g.update）→ 开始/完成经总线回投 update.progress/update.result；并发防护复用 `g.update.status === "running"`（进行中重复请求不重复执行）
- **降级**：bus 连接失败不阻断 dsh 启动（信道降级：request-update 报「消息总线未连接」，check-version 走 dsh 侧直查不受影响；config 未下发时 check-version/update-status 报「总线配置未就绪」）；更新结果走内存态 `g.update` + 总线事件（v0.24 起 update-result.json 退役——现役链路总线不通则更新不会发起，无文件兜底场景），update.result 回投尽力而为

## 架构

- **依赖按需部署**：zip 零依赖（约 0.1MB，代码 bundle + 配置 + 技能；pnpm 不再内置——运行时经 `tools/lib/pnpm.js` `ensurePnpm` 引导，见下）。dsh 依赖树（`@deepseek-ai/dsh` + node-pty/koffi 原生模块，约 246MB）由 Agent 部署时 **pnpm add @deepseek-ai/dsh 到数据目录 `dsh-pkg/`**（写最小 package.json（无 devDeps）+ 复制 pnpm-workspace.yaml（allowBuilds 放行 build scripts）+ 创建指向宿主 electron node 的代理脚本 `pkgDir/node.cmd`，PATH 首部指向 pkgDir，升级安装整体替换插件目录不丢依赖；registry 不通时切镜像 `--registry=https://registry.npmmirror.com`），也可在 DSHana 标签页 deps 卡片点「安装依赖」自动完成（v0.8.6+，命令同上）。解析链：`<dataDir>/dsh-pkg` 优先 → 插件安装目录 `node_modules`（兼容旧形态）。依赖完整性另经**运行级验证**（`node cliBin --version`，v0.8.7+，能跑 = 依赖图完整，防 pnpm add 中断/ --omit=peer 误用造成的假就绪）。**pnpm 运行时引导**（`tools/lib/pnpm.js`）：`ensurePnpm()` 幂等——先 `tryHostChannel()` 探测宿主包管理通道（未来接入点，当前恒 null），再下载 `pnpm@<packageManager 版本>` 的 `dist/pnpm.mjs`（入口 CLI）+ `dist/worker.js`（package 导入 worker，pnpm add 必需；实测确认，缺 worker.js 时导入 worker 静默退出 1）两个文件（unpkg 直链优先、jsdelivr 兜底，逐文件 sha256 校验，原子落位）到 `<dataDir>/pnpm-dist/pnpm-{version}/`（缓存独立于 dsh-pkg）；`installDepsFromPlugin` / `verifyDepsSmoke`（依赖运行级验证的 pnpm 引导检查）共用（并发触发只下载一次，模块级 promise 单例）；v0.18.2 起 `npmViewDistTags`（lib/check.js）与 settings 侧检查改 **HTTP 直查 npm registry**，patch 模板 `{{NPM_CLI_PATH}}` 占位符删除——pnpm.js 消费方收敛为 install.js（installDepsFromPlugin + verifyDepsSmoke）
- **插件本体 rspack bundle**：`index.js` + `tools/*.js` 经 `scripts/build.mjs` 打包，`scripts/pack.mjs` 铺平到标准位置交付（根 `index.js` + `tools/`，无 dist/）。构建工具 @rspack/core 声明为 devDependencies（构建契约，部署 pnpm add 不装 dev 树）。**v0.13.0 lib 提取**：安装/检查/更新能力层与共用状态抽到 `tools/lib/`——`lib/state.js`（getSingleton 单例 + 环境常量 IS_WIN/PLUGIN_ROOT/manifestDefaults + 子进程 node 动态解析 resolveNodeExec/resolveNodeExecEnv（config.json `global.nodejsPath` 可选自定义，默认 Electron 自带 node）+ `g.depTasks` 默认）、`lib/install.js`（resolveDshPkgDir / installDepsFromPlugin / verifyDepsSmoke / semver 比较 / readDshInstalledVersion）、`lib/check.js`（checkDshUpdate）；rspack 入口（dsh-run/dsh-install）静态 import lib，bundle 内联（?t= 重载即刷新）；**非 bundle 侧（routes/webui.js、index.js）保持经 globalThis 单例调用，不 import lib**
- **dsh 启动 patch overlay（v0.22.1+ 静态化）**：dsh-run.js spawn `dsh --profile web --patch <...> --port <...>`，`--patch` 直接指向**静态文件** `dsh-plugin/dsh-hanako.patch.yml`（六段纯 insert：`@dsh-hanako/logger` 统一日志服务（总线 log 帧转发）+ `@dsh-hanako/clipboard` 剪贴板桥 + `@dsh-hanako/theme` 主题插件 + `@dsh-hanako/provider` 宿主 provider 跟随 + `@dsh-hanako/settings` 设置页 DSHana 设置分页 + `@dsh-hanako/bridge` 进程间消息总线服务端，**全部零 config**——busToken 免鉴权（hello 不再比对 token）、dshPkgDir/dataDir 改经总线 config 帧下发（bridge `getConfig()`）、logPath 占位符删除（日志改总线 log 帧转发）；`dsh-hanako.patch.yml.tpl` 模板与 `dsh-hanako.patch.generated.yml` 生成逻辑、全部占位符替换（`{{DSH_PKG_DIR}}`/`{{LOG_PATH}}`/`{{DATA_DIR}}`/`{{BUS_TOKEN}}`）整层退役）。各段 cordis 插件均**包名注册**（`name: @dsh-hanako/logger / @dsh-hanako/theme / @dsh-hanako/provider / @dsh-hanako/settings / @dsh-hanako/clipboard / @dsh-hanako/bridge`，非 file:// URL，因 dsh client 模块发现按 `require.resolve('<name>/package.json')` 解析，file:// 不可解析），dsh-run.js spawn 前在 `$DSH_HOME/profiles/node_modules` 幂等创建 junction 指向插件安装目录 `dsh-plugin/@dsh-hanako/<同名>`（v0.18.1 统一 `@dsh-hanako` scope；与 dsh 自维护的 junction farm 同机制——dsh 的 `healProfilesModuleFallback` 只管理自身依赖闭包，不碰外来 junction）；启动时顺带清理 `dsh-hana-*` 旧名遗留 junction（dsh-hana-default-model / dsh-hana-proxy 等，无条件收敛杜绝混装）；静态文件缺失（安装不完整）不挂任何 patch 记 warn（内嵌插件降级不可用，dsh 启动不受影响）——patch 缺失时优雅降级不阻断启动

123: - **凭据与模型跟随**：@dsh-hanako/provider 插件恒开直读 Hana 宿主 `provider-catalog.json`（凭据）+ `models.json`（模型），dsh models 页出现 Hana 全部 provider；配置热跟随 = **宿主 push**（v0.10.7：宿主侧经 `ctx.resources.watch` 感知两文件变化，bus 派发 `resource.changed` → 防抖 300ms → **v0.22.1+ 经 dshana.bus 消息总线 emit("provider.refresh", { routes }) 推送**（替代 POST `/api/hana-provider.refresh` HTTP push——HTTP push 链路已退役，总线为进程间唯一通道；bus 未连接记待补推，bus.ready 后自动补推最新 routes 覆盖连接窗口期），dsh 侧插件订阅 `provider.refresh` 事件重读配置 `handle.replace()` 原子更新，不再自建 fs.watch）；任务模型默认 = dsh 默认模型（`settings.yaml` 的 `agent-default-model`），`dsh_run` 工具参数 `provider`/`model`/`reasoningEffort` 显式覆盖（显式时 selectModel，dsh 会把所选模型写回全局默认 settings.yaml）
124: - **统一日志**（v0.10.8）：DSHana 插件全量运行日志 = `<dataDir>/logs/` 下**时间戳会话文件** `<YYYYMMDD-HHmmss-SSS>.log`（每次插件会话一个，文件名即应用层创建时刻，毫秒级唯一），DSHana 诊断面板/错误信息直接显示当前会话日志路径。内容 = index.js 生命周期 + web host 进程 stdout/stderr **全量落盘** + theme/provider/settings 三个内嵌插件诊断（经 **@dsh-hanako/logger** 统一日志服务写日志——cordis `provide 'hanaLogger'` / `inject ['hanaLogger']`（服务名驼峰与属性访问一致，不能用 'logger'——cordis 内置 LoggerService 冲突，也不能用连字符名——注入属性按服务名原样挂载），单一实现，src 前缀不变；**v0.22.1+ 日志改总线 log 帧转发**（logger 插件不再写 logPath 文件——bus 未连接时有界环形缓冲 ≤500 行、连接后按序补发，宿主 bus.js 监听 log 通道 → g.appendLog 写会话文件；bridge 自身日志同样经总线 log 帧直投））+ dsh-run 工具关键路径；行格式 `[HH:mm:ss.SSS] [out|err|provider|theme|settings|hana|pnpm] 内容`（文件名即创建时刻，无首行冗余；**pnpm src = 依赖安装/升级的 pnpm add 输出实时流**——installDepsFromPlugin `emitLog` 逐 chunk 写会话日志，取代旧「命令完成后一次性写入」；会话日志**行规范化**：`\r\n`/裸 `\r`（pnpm 进度帧、TTY 重绘）统一折行、逐行加 `[ts] [src]` 前缀、空行丢弃，保证每行都带时间戳/来源），provider 前缀记 refresh 成功（provider/模型数/耗时）/失败/收到刷新请求，settings 前缀记默认模型保存/版本检查/更新请求。**旧日志 zstd 压缩、全部保留**（同 dsh session 持久化哲学）：插件 onload 时把上一会话及更早的时间戳 `.log` 用 **Node 内置 `node:zlib` zstd**（零依赖，标准格式 magic `28b52ffd`，任何 zstd 工具可解）压缩为 `.log.zst` 后删原文件，不删除任何历史；web host 多次重启（失败重试/手动重启）不换会话文件，同一插件会话日志连续。**启动失败排查**：诊断界面看 stderr 尾部（截断 ≤800）与「本次会话日志」路径 → 完整日志打开该时间戳文件，历史日志看 `.zst` 压缩文件
125: - **DSHana 设置分页**（v0.9.5 默认模型 → v0.13.0 改名升级 + UI 重排 → v0.18.1 收敛 `@dsh-hanako` scope）：@dsh-hanako/settings 插件按 dsh client 插件规范双端部署（后端 `webServer.register` 五条 `/api/hana-settings.*` exact 路由（read/save/check-version/request-update/update-status）+ 前端 `client.js` 注册 `settings.section` slot（id `dshana-settings`）原生渲染分页）——设置中心式布局：页头 DSHana 品牌区 + 两个并列分组卡片；① 默认模型卡片：`agent-default-model` 配置 UI（Provider/模型/思考强度三级联动，选项 = `llm.models` 权威列表，保存经 `agentDefaultModel` 服务写 `settings.yaml` 并更新内存态，立即生效）；② DSH 版本卡片：`@deepseek-ai/dsh` 版本检查与更新，**检查 v0.18.1 起 dsh 侧直查**（v0.18.2 起 HTTP 直查 npm registry——fetch `https://registry.npmjs.org/@deepseek-ai/dsh/latest` 的 JSON `version` 字段（pnpm view 语义等价），不再 spawn pnpm；更新经 **dshanaBus 消息总线**发 `update.request` 直投宿主 → `updateDsh` → 结果走内存态 `g.update` + 总线回投（v0.24 起 update-result.json 退役；v0.22.1 起替代 update-request.json 文件桥与 /child/post 反向信道，全部已退役），Agent 工具 `dsh_install`、DSHana 标签页（`/webui/check-update`、`/webui/update-dsh`）、本分页共用同一能力层（单一事实源）
126: - **DSH 检查/更新能力层**（v0.13.0；v0.18.1 设置页检查改 dsh 侧直查；vX 基线改 dist-tag 体系）：`tools/lib/` 提取后挂单例 `g.checkDshUpdate` / `g.updateDsh` / `g.installDeps` / `g.verifyDeps`（Agent 工具 dsh_install（四合一）、webui 路由共用，单一事实源；设置页检查 v0.18.1 起由 dsh 侧 @dsh-hanako/settings 内嵌直查）——`checkDshUpdate`（lib/check.js）：本地版本（verifyDepsSmoke 缓存优先/直读 dsh-pkg package.json）+ 远端版本（**HTTP 直查 npm registry 根包 JSON**——fetch `https://registry.npmjs.org/@deepseek-ai/dsh` 的 `dist-tags` 字段（tag → version 全量映射，官方源失败重试 npmmirror，15s 超时；v0.18.2 起替代 spawn pnpm view，不再依赖 pnpm 引导））+ zero-dep semver 比较 → `{ localVersion, distTags, baselineTag, baselineVersion, updateAvailable, error? }`（基线 tag = 显式 tag / 配置 dshTag / latest；version 参数优先于 tag；latestVersion 保留为 baselineVersion 别名），结果缓存 `g.check.result`（内存，不再写 check-result.json 桥接文件）；`updateDsh`（lifecycle.js，组合 lib 的 installDepsFromPlugin/verifyDepsSmoke）：停 web host → pnpm add（spec 可指定版本/tag，缺省配置基线 dshTag）→ 起 web host → 读新版本 → 结果走内存态 `g.update`（{ status, result, error, time }，v0.24 退役 update-result.json）；`installDepsFromPlugin` / `verifyDepsSmoke`（lib/install.js）：依赖部署（spec 同源支持版本/tag）与运行级验证；并发防护 `g.check.status` / `g.update.status` / `g.deps.status`（进行中重复调用返回状态不重复执行）
- **进程单例挂 `globalThis.__dshHanako`**：`index.js` 卸载清理时读取（不 import 插件文件，避免读到旧模块缓存）
- **宿主 tools 模块缓存**：宿主按插件 id 缓存 tools 模块，**改代码后必须重启 Hana 才加载新 tools**
- **dsh-run 模块结构**（任务提交链路收敛）：`tools/dsh-run.js` 是有状态任务提交核心 + 工具契约（submitTask 事件循环 / 审批状态机 / doExecute / execute / name / description / parameters / sessionPermission），纯协议/解析/唤醒已剥离：
  - `lib/state.js` — getSingleton（globalThis 单例）+ 环境常量（IS_WIN / PLUGIN_ROOT / manifestDefaults）+ 子进程 node 动态解析（resolveNodeExec / resolveNodeExecEnv：读 config.json `global.nodejsPath`，自定义系统 node 可选；默认 Electron 自带 node，ELECTRON_RUN_AS_NODE=1 仅 Electron 分支注入）+ g.depTasks 默认
  - `lib/install.js` — resolveDshPkgDir / installDepsFromPlugin / verifyDepsSmoke / semver 比较 / readDshInstalledVersion
  - `lib/check.js` — checkDshUpdate（npmViewDistTags + 本地版本直读 + semver 比较）
  - `lib/config.js` — 配置解析（纯解析零状态）：readDshDefaultModel / readDshDefaultPreset / resolveReasoningEffort / resolveApprovalTimeoutSec / resolveDefaultTimeoutSec / resolveDefaultCwd
  - `lib/wake.js` — deferred 唤醒协议 + 审批挂起通知：registerDeferredWake / resolveDeferredWake / failDeferredWake / notifyApprovalWake（dsh-run / dsh-install 两入口共享，消除三重复；meta.type 由调用方传入——dsh-install 的 install/update 动作统一用 "dsh-install"，原 dsh-update 标识废弃）
  - `lib/protocol.js` — dsh web /api 网关协议层（纯协议零状态）：nextRpcId / callUnary / openMux / textFromChunk / textFromMessageBlocks
  - `app/lifecycle.js` — web host 生命周期（启动/自检/更新/三条 watch）：原在本文件，分离后独立，经静态 import 供 dsh-run 使用 ensureWebHost / ensureConfigJson，顶层 mountLifecycle 挂单例字段
  - **保留在 dsh-run**：createOpEntry（运行期协调条目，键 = 任务 rpcId）/ respondApprovalLocal / approvalTimers / toolCallCache / cacheToolCall / submitTask / doExecute / execute / 工具契约——与审批状态机（g.ops 协调状态（键 = 任务 rpcId）/ approvalTimers / toolCallCache）紧耦合，拆出要跨模块传递大量运行状态，保留在此
- **分发纪律（历史约束）**：Hana 以带 ?t= 时间戳的 URL 加载 tools/*.js（热更新缓存破坏），但 tools 内部静态 import 的相对模块是无 query 的固定 URL，Node ESM 按 URL 缓存、永不刷新。分发形态宿主加载 dist/tools/*.js（rspack bundle，build.mjs 入口内联 import），?t= 重载即刷新；因此 rspack 入口（dsh-run 等）可静态 import lib 与本插件 app/lifecycle.js（内联进 bundle）。非 bundle 侧（routes/webui.js、index.js）保持经 globalThis 单例调用

## 已知限制

- **bash 工具在 Windows 上可能 `E_ACCESSDENIED`**（dsh-bash-sandbox 创建 bash 服务实例失败，属 dsh 沙箱环境限制，非本插件问题）。文件系统工具（write/read/edit）在 workspace-write 沙箱下工作正常，Windows 上优先用文件系统工具
- **主题跟随**：DSHana 标签内，dsh 偏好 `system`（默认）→ 跟随 Hana 当前主题（明暗 + 配色）；`light`/`dark` → dsh 内置原生配色。宿主切 Hana 主题后壳页接 `hana.theme.changed` 广播**实时跟随**（无需重开标签页）；用户切 dsh 偏好也**实时生效**（@dsh-hanako/theme 注入脚本经 `/api/events.host` WebSocket 订阅 `settings/document-updated` 的 `ui-theme` 变更，回读 pref 并重跑 applyOrRemove）
- 越界权限请求默认走审批自动化：插件捕获 approval/requested → deferred 通知 Agent → `dsh_approve` 应答；无人应答超时自动拒绝，兜底 dsh Web UI 人工审批
- **同步模式（wait=true）无审批通知**：同步调用时 Agent 在等结果，审批挂起只能靠 dsh Web UI 人工处理（或超时）。长任务建议用异步模式
- 默认每个任务新建独立 session；传 `sessionId` 可复用已有会话（resume，跨任务继承上下文）
