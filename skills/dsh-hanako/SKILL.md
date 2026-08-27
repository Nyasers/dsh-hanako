---
name: dsh-hanako
description: "dsh-hanako 插件（把 DeepSeek Harness 接进 Hana 的进程外 subagent 执行器）的配置辅助与使用指南。触发场景：dsh-hanako 刚装好需要配置 defaultCwd、依赖缺失需要安装（DSHana 标签页自装 / Agent 用 dsh_install 工具 / 手动 pnpm add）、标签页自检/自愈（安装依赖/手动启动/检测依赖/检查更新/更新 DSH）、web host 起不来（先看标签页自检 t1/t2）、dsh 任务失败排查、审批怎么应答、dsh_run/dsh_install/dsh_approve/dsh_cancel/dsh_ops/dsh_search/dsh_update 怎么用、默认模型怎么配（dsh 设置页「DSHana 设置」分页，provider/model/思考三级联动）、DSH 版本检查与更新（dsh_update 工具 / 设置页 DSH 版本块 / 标签页 deps 卡片）、安装/升级卡片（dsh_install / dsh_update 异步渲染 /card/dep 实时日志）、DeepSeek Harness 相关。遇到 dsh-hanako 相关需求优先读本技能再动手。"
---

# dsh-hanako 配置辅助与使用指南

把 DeepSeek Harness（dsh）接进 Hana：加载即拉起 dsh web host（--profile web），dsh_run 交任务给 dsh agent 执行，Web UI（http://127.0.0.1:3080）可见全部会话。

## 首次安装配置（Agent 辅助用户完成）

config.json 由宿主设置界面生成、**不随包分发**；defaultCwd 初始为空。按序完成：

**0. 先看现状**：配置在 <宿主插件数据目录>/dsh-hanako/config.json（Windows 常见 %USERPROFILE%\.hanako\plugin-data\dsh-hanako\config.json）。**全新安装**：插件初始化自动生成默认配置（ensureConfigJson：无 config.json 时按 manifest 默认值生成 `{ schemaVersion, global, agents, sessions }`，已存在则不动，原子写 + 失败静默），无需手动保存，装完即可在设置界面看到默认值。**无需配置 API Key / 模型 / Node 路径**：凭据由 @dsh-hanako/provider 插件直读宿主 `provider-catalog.json`，模型跟随宿主 `models.json`（dsh models 页设置默认）；web host 使用宿主 electron 进程自身的 Node 运行时（`process.execPath`，`ELECTRON_RUN_AS_NODE=1`），**无需用户单独安装 Node.js**。

**1. defaultCwd（建议）**：为空且未传 cwd 时报 `cwd 不能为空`；设为项目沙箱目录。

**2. 其余项默认可用**：approvalTimeoutMs（30000）/ webPort（3080）/ callbackMode（summary）/ defaultTimeoutMs（1800000）。agentPreset / reasoningEffort 不需要配置：工具不显式传时用 dsh 默认（dsh Web UI 可调 agent 预设与思考强度）。任务模型不需要配置：默认用 dsh 默认模型（settings.yaml `agent-default-model`），可在 **dsh 设置页「DSHana 设置」分页 → 「默认模型」卡片**直接配置（Provider/模型/思考强度三级联动，选项 = dsh 全部可用 provider，保存即生效），`dsh_run` 工具参数 `provider`/`model`/`reasoningEffort` 可显式覆盖（显式时 selectModel，dsh 会把所选模型写回全局默认 settings.yaml——显式指定即成为新默认）。**DSH 版本**：同分页「DSH 版本」卡片可检查 `@deepseek-ai/dsh` 版本并一键更新（检查 dsh 侧直查远端 registry，更新走宿主能力层；Agent 用 `dsh_update` 工具 / 标签页 deps 卡片「检查更新」「更新 DSH」同结果）。

**3. 配置生效铁律（实时）**：「改完都要重启 Hana」不成立：t1 依赖/t2 进程状态直读 config.json/单例实时；t2 手动启动链路 resolveDshPkgDir → spawn，直写后无需重启；仅旧进程存活（g.web.ready=true）需先杀进程或重启。

## 依赖自主部署（页面自装首选，Agent pnpm add 兜底）

dsh 依赖（@deepseek-ai/dsh + node-pty/koffi）位置：**数据目录 dsh-pkg/**（优先，升级不丢依赖）→ 插件目录 node_modules（zip 自带，兑底）。部署 = 在 pkgDir 写入**最小 package.json**（无 devDeps，插件根的 devDeps 是 rspack 构建树，不复制进部署目录）+ 复制插件根 `pnpm-workspace.yaml`（`allowBuilds` 白名单放行 dsh 树 build scripts）→ 在 pkgDir 下创建指向宿主 electron node 的代理脚本（node.cmd/node）→ 清理旧依赖残留（`package-lock.json` / `pnpm-lock.yaml` / 扁平 node_modules，npm 体系升级兼容）→ `node <pnpm 入口> add @deepseek-ai/dsh --loglevel=http`。pnpm 入口 = **运行时引导**（插件 `tools/lib/pnpm.js` `ensurePnpm`：下载 `pnpm-{version}` 的 `pnpm.mjs`（入口 CLI）+ `worker.js`（导入 worker，pnpm add 必需）到数据目录 `pnpm-dist/`，缓存独立于 dsh-pkg，zip 不再内置 node_modules/pnpm）。pnpm 11 的 `add` 命令不支持 `--omit` 旗标，最小 package.json 无 devDeps 即天然只装 dsh 运行时树。

**页面自装（首选，v0.8.6+，无需 Agent）**：打开 DSHana 标签页（未就绪显示 t1/t2）→ deps 卡片点「安装依赖」→ 插件自动完成（停 web host → 写最小 package.json + 复制 pnpm-workspace.yaml 到 dsh-pkg → 创建 node 代理脚本（pkgDir/node.cmd → 宿主 electron node）→ 清旧 npm 残留 → `pnpm add @deepseek-ai/dsh --loglevel=http`（pnpm 入口为运行时引导产物，见上），PATH 首部指向 pkgDir 让 install script 找到宿主 node，官方源失败自动重试 npmmirror → 校验 cliBin → 自动运行级重验 `node cliBin --version`）。安装中显示实时进度（pnpm 输出尾部+更新时间，3s 轮询刷新）；完成后无需重启，去 t2 点「手动启动」。验证失败（「存在但依赖不完整」）→ 点「重新安装依赖」；可随时点「检测依赖」重验。**t1→t2 门禁**：t1 未过（缺失/验证失败/安装中/检测中）时 t2 按钮禁用（msg「依赖未就绪，请先安装/重新安装依赖」）。

**手动兜底仅用于标签页不可访问的情况**。手动命令详见下方。

#### Agent 手动 pnpm add（兜底）

```powershell
# 部署目录（数据目录 dsh-pkg）
$pkgDir = <数据目录>/dsh-pkg
# pnpm 入口 = 运行时引导产物（插件 tools/lib/pnpm.js ensurePnpm 下载的 pnpm.mjs；
# 首次会联网下载 pnpm.mjs + worker.js 到数据目录 pnpm-dist/）
$pnpmCli = <数据目录>/pnpm-dist/pnpm-11.24.0/pnpm.mjs

# 优先用本机已安装的 Node；无则需先创建 node 代理脚本指向宿主 electron node
$node = <本机 node.exe 绝对路径，如 C:\Program Files\nodejs\node.exe>
& $node $pnpmCli add @deepseek-ai/dsh --loglevel=http
```

> **注意**：koffi/node-pty 的 install script 会起子进程调用 `node`。本机 Node 已在 PATH 中时直接可用；若 PATH 缺 node，报 `'node' is not recognized` 时需要创建代理脚本。手动兜底前先停 web host（部署要删旧 node_modules，Windows 上被运行中进程加载的原生模块会锁文件）。

- **无 --omit 旗标**：pnpm 11 的 add 命令不支持 `--omit`（报 Unknown option: 'omit'）；部署目录用最小 package.json（无 devDeps），pnpm add 天然只装 dsh 运行时树，不装 rspack 构建树（~40MB）。**不可用 --omit=peer**（跳过 dsh 的 peer → ERR_MODULE_NOT_FOUND）。allowBuilds 放行由 pnpm-workspace.yaml 提供（package.json 的 allowScripts 在 pnpm 11 不再读取）。pnpm 入口定位：运行时引导（`tools/lib/pnpm.js` `ensurePnpm` 下载 pnpm.mjs + worker.js 到数据目录 pnpm-dist/，zip 不再内置 pnpm；首次引导需联网，unpkg/jsdelivr 双源 + sha256 校验）。PATH 处理：代理脚本（pkgDir/node.cmd）将子进程 node 请求转发到宿主 electron node，PATH 首部指向 pkgDir 即可。
- **registry 镜像**：默认源失败切 `--registry=https://registry.npmmirror.com`（或持久化 `pnpm config set registry https://registry.npmmirror.com`）；镜像只影响 registry 层，koffi/node-pty 产物同源。重跑前残留不完整先 `Remove-Item node_modules -Recurse -Force`（会连带清 package-lock.json / pnpm-lock.yaml，全新构建）。
- **部署后**：Agent 手动路径依赖就位后重启 Hana（tools 缓存）；页面自装无需重启。装完调一次 dsh_run 触发拉起。

> **旧命令参考**：npm 时代部署为 `node npm-cli.js i @deepseek-ai/dsh --omit=dev --loglevel=http`（复制插件根 package.json，含 devDeps 需 --omit 剔除）；pnpm 迁移后弃用（pnpm 11 add 无 --omit，改最小 package.json + pnpm add）。

## 配置完成后验证

1. 打开 DSHana 标签页看自检（t1 依赖 / t2 进程，每项 ✓/✗ + 修复指引），按序修：t1 ✗ → deps 卡片「安装依赖/重新安装依赖」；t2 ✗ → 点「手动启动 web host」
2. 跑最小试任务 `dsh_run(task="用文件写入工具在沙箱工作目录内创建 hello.txt，内容 hi，然后读回确认", cwd=<defaultCwd>)`，异步提交
3. 卡片不报 web host 错误 → 起来；完成后看摘要；浏览器开 http://127.0.0.1:3080 可见会话（可选）
4. 失败按排错表定位

## 工具速查

| 工具 | 用途 | 关键点 | 详情 |
|---|---|---|---|
| `dsh_run(task, cwd?, timeout?, wait?, agentPreset?, reasoningEffort?, provider?, model?, sessionId?)` | 提交任务 | 默认异步（后台送达）；wait=true 同步；provider/model 显式覆盖模型（显式时 selectModel，写回 dsh 全局默认）；sessionId resume | [dsh-run 技能](dsh-run) |
| `dsh_install(action?, wait?, autoStart?)` | 安装/验证 dsh 依赖 | action=install 安装（默认，registry 兜底 + 自动运行级重验 + autoStart 自动拉起 web host，渲染安装卡片）；action=verify 只检测完整性；异步默认 + 完成回调，wait=true 同步；安装中重复调用返回状态 | [dsh-install 技能](dsh-install) |
| `dsh_update(action?, wait?)` | 检查/更新 DSH | action=check 查版本（默认）；action=update 完整更新（停 web host → pnpm add latest → 起 web host，**正在执行的任务会中断**，渲染升级卡片）；update 默认异步后台执行 + 完成回调，wait=true 同步；更新中重复调用返回状态不重复执行 | [dsh-update 技能](dsh-update) |
| `dsh_approve(opId, approvalId, outcome?)` | 应答审批 | allowed-once 放行 / rejected 拒绝；通知带 args 命令原文 | [dsh-approve 技能](dsh-approve) |
| `dsh_cancel(opId)` | 取消任务 | 误派/卡死止损；幂等 | [dsh-cancel 技能](dsh-cancel) |
| `dsh_ops(limit?)` | 查会话清单与摘要 | 解析 dsh 会话缓存 session_projcache 可查；limit 默认 10；最新在前 | [dsh-ops 技能](dsh-ops) |
| `dsh_search(query)` | 跨会话搜索 | 命中后可 resume；snippet ≤240 字符 | [dsh-search 技能](dsh-search) |

**工具调用的完整参数语义、返回结构、错误码、审批通道、副作用分别见上述七个独立工具技能（均从源码 tools/*.js 核对）**——本表只是速查。

### 标签页自愈路由（浏览器按钮调用，Agent 一般不直接调）

| 路由 | 用途 |
|---|---|
| `GET /webui` | 页面壳（就绪探测 + 主题 + 首帧自检） |
| `GET /webui/health` | 就绪探测；未就绪附带 diagnostics（自检数据源，3s 轮询） |
| `POST /webui/start` | 手动启动 web host（t3 按钮） |
| `POST /webui/install-deps` | 安装依赖（pnpm add @deepseek-ai/dsh 到 dsh-pkg，停 host + 清旧残留 + 创建 node 代理脚本，npmmirror 兜底；t1 按钮） |
| `GET /webui/verify-deps` | 运行级依赖检测（node cliBin --version；进页自动一次 + 手动） |
| `GET /webui/check-update` | 版本检查（deps 卡片「检查更新」；pnpm view，官方源失败重试 npmmirror） |
| `POST /webui/update-dsh` | 更新 DSH（deps 卡片「更新 DSH」；停 web host → pnpm add latest → 起 web host，**正在执行的任务中断**） |

## DSH 检查与更新（v0.13.0；v0.18.1 设置页检查改 dsh 侧直查）

`@deepseek-ai/dsh` 版本检查与更新收敛为**宿主能力层单一事实源**（tools/lib/ `checkDshUpdate` / `updateDsh` / `installDepsFromPlugin` / `verifyDepsSmoke`，经单例挂载），Agent 工具与标签页共用同一套逻辑，结果一致；dsh 设置页「DSH 版本」卡片 v0.18.1 起**检查改 dsh 侧直查**（同款 `pnpm view`），更新仍走宿主能力层：

1. **Agent 工具 `dsh_update`**：`action=check`（默认）查 `{ localVersion, latestVersion, updateAvailable, error? }`，只读不改；`action=update` 执行完整更新（停 web host → pnpm add @deepseek-ai/dsh latest → 起 web host），默认异步（后台执行 + **升级卡片**实时日志，完成后宿主唤醒带回结果），`wait=true` 同步等待；更新会重启 web host、正在执行的任务会中断，`update` 前确认无运行中任务；更新执行中重复调用返回状态不重复执行
2. **DSHana 标签页 deps 卡片**（web host 未就绪时可见）：版本行显示「当前版本 / 最新版本 / 可更新状态」+「检查更新」「更新 DSH」按钮（更新前两段式确认）；更新中显示进度（update-result.json 状态），完成显示「更新完成 vX，请重启 DSHana 使完全生效」；更新/安装期间页面自动退到诊断页显示进度，完成后自动切回并刷新
3. **dsh 设置页「DSHana 设置」分页 → 「DSH 版本」卡片**：本地版本直读 dsh-pkg package.json（挂载即显示），远端版本 **dsh 侧直查**（后端 spawn 宿主 electron node + pnpm.cjs 执行 `pnpm view @deepseek-ai/dsh version`，官方源失败重试 npmmirror，15s 超时；v0.18.1 起不再经宿主桥接——修复了宿主 resources.watch 桥接不可靠导致检查永不完成的问题）；「更新到最新」→ 两段式确认 → 写 update-request.json（宿主 5s 轮询感知）→ 宿主执行更新 → 每 2s 轮询 update-status 直到 done/error
4. **Agent 工具 `dsh_install`**（依赖缺失/安装场景）：`action=install`（默认）pnpm add @deepseek-ai/dsh 到 dsh-pkg（registry 兜底 + 自动运行级重验 + autoStart 自动拉起 web host），默认异步 + **安装卡片**实时日志 + 完成回调，`wait=true` 同步；`action=verify` 只检测依赖完整性（运行级冒烟）；安装中（`g.depsInstalling`）重复调用返回状态不重复执行

**并发与一致性**：检查 `g.checking` / 更新 `g.updating` / 安装 `g.depsInstalling` 进行中重复请求跳过（更新轮询触发层 + 能力层双重防护）；检查结果缓存 `g.checkResult`（内存，5s 时间窗防 pnpm view 重复跑；不再写 check-result.json 桥接文件）；更新结果写 `<dataDir>/update-result.json { state: done|error, version?, error?, at }`（设置页/标签页轮询读）。

**安装/升级卡片（v0.13.0）**：dsh_install / dsh_update 异步流程渲染 iframe 卡片（`/card/dep`，与任务卡片同构）——登记宿主单例 `g.depTasks`（taskId → kind/state/log/at/result），SSE `/ops/dep-stream`（首帧快照 + 每 1s npm 日志实时滚动，终态关闭）+ 兜底 `/ops/dep-status`；显示标题（DSH 安装 / DSH 升级）+ 状态徽标 + 日志实时滚动 + 完成结果（「已安装 vX，web host 已自动启动」/「更新完成 vX，请重启 DSHana 使完全生效」/ 错误信息）。

## 审批流程（Agent 应答）

dsh 请求越界权限时任务挂起，插件经 deferred 发 dsh-approval 通知（opId/approvalId/reason/**args 命令路径原文**）。应答：读 args 判断 → 合理 `dsh_approve(opId, approvalId, "allowed-once")`，危险 `"rejected"`；无人应答超时（approvalTimeoutMs，默认 30s）自动拒绝；也可 dsh Web UI 人工处理。**决策看 args（执行了什么），不听 reason（model 自述）**。

## 排错表

**web host 起不来先开 DSHana 标签页看自检**（t1 依赖存在性+运行级验证 / t2 进程状态）。**门禁链**：t1 未过（缺失/验证失败/安装中/检测中）→ t2「手动启动」锁（msg「依赖未就绪…」）。按 t1→t2 修。

**诊断日志**：全部运行日志在会话日志文件 `<dataDir>/logs/<YYYYMMDD-HHmmss-SSS>.log`（DSHana 标签页 t2 诊断区显示路径；旧日志 onload 时 zstd 压缩为 `.log.zst` 全部保留）。行前缀 src：`out`/`err`（dsh web host stdout/stderr）、`provider`/`theme`/`settings`（内嵌插件诊断）、`hana`（插件生命周期 + 里程碑 `[依赖安装]`/`[依赖验证]`/`[版本检查]`/`[DSH 更新]`）、`pnpm`（pnpm add 原始输出**逐 chunk 实时落盘**，行规范化 `\r` 进度帧已折行）。pnpm add 失败 / 更新失败 / 依赖验证失败：先开会话日志看 `[pnpm]` 行 + 对应 `[hana]` 里程碑（含退出码/registry 重试/错误尾），再按下表处理。

| 现象 | 原因 | 处理 |
|---|---|---|
| 报 `dsh 包未就绪：...bin.js 不存在` | 依赖缺失 | 首选标签页 deps「安装依赖」；或 Agent 调 `dsh_install`（默认 install，自动重试 registry + 自动重验 + autoStart 拉起 web host，异步渲染安装卡片）；或手动 pnpm add @deepseek-ai/dsh（目录需 package.json） |
| deps「存在但依赖不完整：ERR_MODULE_NOT_FOUND」 | 依赖图缺 peer（--omit=peer/中断假就绪） | 点「重新安装依赖」重跑 pnpm add（自动重验）；或「检测依赖」重验 |
| 显示「正在检测依赖完整性…」/「检测中…」 | 运行级验证中（数百 ms~10s） | 等待（进页自动一次）或手动点「检测依赖」 |
| t2 按钮禁用（msg「依赖未就绪…」） | t1 未过（缺失/验证失败/安装中/检测中） | 先完成 t1 再点「手动启动 web host」 |
| 升级/重装后 web host 起不来 | 升级清掉插件目录 node_modules | 依赖部署到**数据目录 dsh-pkg/**（升级不丢），页面自装或 pnpm add @deepseek-ai/dsh；装完调 dsh_run 重试拉起 |
| 报 `dsh web 启动超时（...端口未就绪）` | 依赖未就绪或端口被占用 | 先确认 t1 依赖已安装；webPort 被占用时改端口 |
| bash 报 `E_ACCESSDENIED` | dsh bash 沙箱 Windows 限制 | 改用文件系统工具（write/read/edit） |
| pnpm add 下载失败/超时 | registry 网络 | 切 `--registry=https://registry.npmmirror.com`（页面自装已内置重试），仍失败查代理 |
| 版本检查显示「检查失败」/「最新版本 未知」 | pnpm view 官方源 + npmmirror 都失败（网络/registry） | 稍后重试（能力层已自动重试镜像一次）；查代理/网络 |
| 更新 DSH 后 web host 起不来 / 更新失败 | pnpm add 失败或 web host 重启失败 | 看 deps 卡片/设置页更新状态（update-result.json 的 error 字段）；按 t1→t2 自检修复后「手动启动 web host」 |
| 改了配置/代码不生效 | 宿主 tools 模块缓存 | 重启 Hana |

## 已知限制

- 主题跟随：system 跟随宿主，light/dark 原生；宿主切 Hana 主题后壳页接 `hana.theme.changed` 广播**实时跟随**（无需重开），切 dsh 偏好也**实时生效**（经 `/api/events.host` WS 订阅 `settings/document-updated` 的 `ui-theme` 变更）
- bash 在 Windows 可能 E_ACCESSDENIED（dsh 沙箱限制）；文件工具正常，Windows 优先用
- wait=true 同步模式无审批通知（只能 Web UI 或超时）；长任务建议异步
- 越界权限默认走审批：deferred 通知 → dsh_approve 应答；30s 超时自动拒绝
- 任务默认新建会话；传 sessionId 复用（resume）
- 会话/账本在插件数据目录 dsh-home/，不碰 ~/.dsh
