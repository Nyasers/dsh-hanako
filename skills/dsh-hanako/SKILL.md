---
name: dsh-hanako
description: "dsh-hanako 插件（把 DeepSeek Harness 接进 Hana 的进程外 subagent 执行器）的配置辅助与使用指南。触发场景：dsh-hanako 刚装好需要配置 defaultCwd、依赖缺失需要安装（DSHana 标签页自装或 Agent 手动 npm i）、标签页自检/自愈（安装依赖/手动启动/检测依赖）、web host 起不来（先看标签页自检 t1/t2）、dsh 任务失败排查、审批怎么应答、dsh_run/dsh_approve/dsh_cancel/dsh_ops/dsh_search 怎么用、默认模型怎么配（dsh 设置页「默认模型」块，provider/model/思考三级联动）、DeepSeek Harness 相关。遇到 dsh-hanako 相关需求优先读本技能再动手。"
---

# dsh-hanako 配置辅助与使用指南

把 DeepSeek Harness（dsh）接进 Hana：加载即拉起 dsh web host（--profile web），dsh_run 交任务给 dsh agent 执行，Web UI（http://127.0.0.1:3080）可见全部会话。

## 首次安装配置（Agent 辅助用户完成）

config.json 由宿主设置界面生成、**不随包分发**；defaultCwd 初始为空。按序完成：

**0. 先看现状**：配置在 <宿主插件数据目录>/dsh-hanako/config.json（Windows 常见 %USERPROFILE%\.hanako\plugin-data\dsh-hanako\config.json）。**全新安装**：插件初始化自动生成默认配置（ensureConfigJson：无 config.json 时按 manifest 默认值生成 `{ schemaVersion, global, agents, sessions }`，已存在则不动，原子写 + 失败静默），无需手动保存，装完即可在设置界面看到默认值。**无需配置 API Key / 模型 / Node 路径**：凭据由 dsh-hana-provider 插件直读宿主 `provider-catalog.json`，模型跟随宿主 `models.json`（dsh models 页设置默认）；web host 使用宿主 electron 进程自身的 Node 运行时（`process.execPath`，`ELECTRON_RUN_AS_NODE=1`），**无需用户单独安装 Node.js**。

**1. defaultCwd（建议）**：为空且未传 cwd 时报 `cwd 不能为空`；设为项目沙箱目录。

**2. 其余项默认可用**：approvalTimeoutMs（30000）/ webPort（3080）/ callbackMode（summary）/ defaultTimeoutMs（1800000）。agentPreset / reasoningEffort 不需要配置：工具不显式传时用 dsh 默认（dsh Web UI 可调 agent 预设与思考强度）。任务模型不需要配置：默认用 dsh 默认模型（settings.yaml `agent-default-model`），可在 **dsh 设置页「默认模型」配置块**直接配置（Provider/模型/思考强度三级联动，选项 = dsh 全部可用 provider，保存即生效），`dsh_run` 工具参数 `provider`/`model`/`reasoningEffort` 可显式覆盖（显式时 selectModel，dsh 会把所选模型写回全局默认 settings.yaml——显式指定即成为新默认）。

**3. 配置生效铁律（实时）**：「改完都要重启 Hana」不成立：t1 依赖/t2 进程状态直读 config.json/单例实时；t2 手动启动链路 resolveDshPkgDir → spawn，直写后无需重启；仅旧进程存活（g.web.ready=true）需先杀进程或重启。

## 依赖自主部署（页面自装首选，Agent npm i 兜底）

dsh 依赖（@deepseek-ai/dsh + node-pty/koffi）位置：**数据目录 dsh-pkg/**（优先，升级不丢依赖）→ 插件目录 node_modules（zip 自带，兑底）。部署 = 复制插件根 package.json 到部署目录 → 在 pkgDir 下创建指向宿主 electron node 的代理脚本（node.cmd/node）→ `node npm-cli.js i @deepseek-ai/dsh --omit=dev --loglevel=http`。npm-cli.js 来自插件安装目录 node_modules/npm/bin/npm-cli.js。

**页面自装（首选，v0.8.6+，无需 Agent）**：打开 DSHana 标签页（未就绪显示 t1/t2）→ deps 卡片点「安装依赖」→ 插件自动完成（复制 package.json 到 dsh-pkg → 创建 node 代理脚本（pkgDir/node.cmd → 宿主 electron node）→ `node npm-cli.js i @deepseek-ai/dsh --omit=dev --loglevel=http`，PATH 首部指向 pkgDir 让 install script 找到宿主 node，官方源失败自动重试 npmmirror → 校验 cliBin → 自动运行级重验 `node cliBin --version`）。安装中显示实时进度（npm 输出尾部+更新时间，3s 轮询刷新）；完成后无需重启，去 t2 点「手动启动」。验证失败（「存在但依赖不完整」）→ 点「重新安装依赖」；可随时点「检测依赖」重验。**t1→t2 门禁**：t1 未过（缺失/验证失败/安装中/检测中）时 t2 按钮禁用（msg「依赖未就绪，请先安装/重新安装依赖」）。

**手动兜底仅用于标签页不可访问的情况**。手动命令详见下方。

#### Agent 手动 npm i（兜底）

```powershell
# 部署目录（数据目录 dsh-pkg）
$pkgDir = <数据目录>/dsh-pkg
# npm-cli.js 来自插件安装目录
$npmCli = <插件安装目录>/node_modules/npm/bin/npm-cli.js

# 优先用本机已安装的 Node；无则需先创建 node 代理脚本指向宿主 electron node
$node = <本机 node.exe 绝对路径，如 C:\Program Files\nodejs\node.exe>
& $node $npmCli i @deepseek-ai/dsh --omit=dev --loglevel=http
```

> **注意**：koffi/node-pty 的 install script 会起子进程调用 `node`。本机 Node 已在 PATH 中时直接可用；若 PATH 缺 node，报 `'node' is not recognized` 时需要创建代理脚本：

- **--omit=dev**：剔除 rspack 构建树（~40MB）；`npm i @deepseek-ai/dsh` 只装 dsh 及其中间依赖（不需 lockfile，增量安装）；**不可用 --omit=peer**（跳过 dsh 的 peer → ERR_MODULE_NOT_FOUND）。npm-cli.js 定位：来自插件安装目录 node_modules/npm/bin/npm-cli.js（zip 不包含 node_modules，npm 包随宿主 electron 安装）。PATH 处理：代理脚本（pkgDir/node.cmd）将子进程 node 请求转发到宿主 electron node，PATH 首部指向 pkgDir 即可。
- **registry 镜像**：默认源失败切 `--registry=https://registry.npmmirror.com`（或持久化 `npm config set registry https://registry.npmmirror.com`）；镜像只影响 registry 层，koffi/node-pty 产物同源。重跑前残留不完整先 `Remove-Item node_modules -Recurse -Force`。
- **部署后**：Agent 手动路径依赖就位后重启 Hana（tools 缓存）；页面自装无需重启。装完调一次 dsh_run 触发拉起。

> **旧命令参考**：早期版本使用 `npm ci --omit=dev --no-audit --no-fund`（需完整 lockfile，复制 package-lock.json 到部署目录），现已改为 `npm i @deepseek-ai/dsh --omit=dev --loglevel=http`（只需 package.json 中 peerDependencies 声明，无 lockfile 也能增量安装）。

## 配置完成后验证

1. 打开 DSHana 标签页看自检（t1 依赖 / t2 进程，每项 ✓/✗ + 修复指引），按序修：t1 ✗ → deps 卡片「安装依赖/重新安装依赖」；t2 ✗ → 点「手动启动 web host」
2. 跑最小试任务 `dsh_run(task="用文件写入工具在沙箱工作目录内创建 hello.txt，内容 hi，然后读回确认", cwd=<defaultCwd>)`，异步提交
3. 卡片不报 web host 错误 → 起来；完成后看摘要；浏览器开 http://127.0.0.1:3080 可见会话（可选）
4. 失败按排错表定位

## 工具速查

| 工具 | 用途 | 关键点 | 详情 |
|---|---|---|---|
| `dsh_run(task, cwd?, timeout?, wait?, agentPreset?, reasoningEffort?, provider?, model?, sessionId?)` | 提交任务 | 默认异步（后台送达）；wait=true 同步；provider/model 显式覆盖模型（显式时 selectModel，写回 dsh 全局默认）；sessionId resume | [dsh-run 技能](dsh-run) |
| `dsh_approve(opId, approvalId, outcome?)` | 应答审批 | allowed-once 放行 / rejected 拒绝；通知带 args 命令原文 | [dsh-approve 技能](dsh-approve) |
| `dsh_cancel(opId)` | 取消任务 | 误派/卡死止损；幂等 | [dsh-cancel 技能](dsh-cancel) |
| `dsh_ops(limit?)` | 查会话清单与摘要 | 解析 dsh 会话缓存 session_projcache 可查；limit 默认 10；最新在前 | [dsh-ops 技能](dsh-ops) |
| `dsh_search(query)` | 跨会话搜索 | 命中后可 resume；snippet ≤240 字符 | [dsh-search 技能](dsh-search) |

**工具调用的完整参数语义、返回结构、错误码、审批通道、副作用分别见上述五个独立工具技能（均从源码 tools/*.js 核对）**——本表只是速查。

### 标签页自愈路由（浏览器按钮调用，Agent 一般不直接调）

| 路由 | 用途 |
|---|---|
| `GET /webui` | 页面壳（就绪探测 + 主题 + 首帧自检） |
| `GET /webui/health` | 就绪探测；未就绪附带 diagnostics（自检数据源，3s 轮询） |
| `POST /webui/start` | 手动启动 web host（t3 按钮） |
| `POST /webui/install-deps` | 安装依赖（npm i @deepseek-ai/dsh --omit=dev 到 dsh-pkg，创建 node 代理脚本，npmmirror 兜底；t1 按钮） |
| `GET /webui/verify-deps` | 运行级依赖检测（node cliBin --version；进页自动一次 + 手动） |

## 审批流程（Agent 应答）

dsh 请求越界权限时任务挂起，插件经 deferred 发 dsh-approval 通知（opId/approvalId/reason/**args 命令路径原文**）。应答：读 args 判断 → 合理 `dsh_approve(opId, approvalId, "allowed-once")`，危险 `"rejected"`；无人应答超时（approvalTimeoutMs，默认 30s）自动拒绝；也可 dsh Web UI 人工处理。**决策看 args（执行了什么），不听 reason（model 自述）**。

## 排错表

**web host 起不来先开 DSHana 标签页看自检**（t1 依赖存在性+运行级验证 / t2 进程状态）。**门禁链**：t1 未过（缺失/验证失败/安装中/检测中）→ t2「手动启动」锁（msg「依赖未就绪…」）。按 t1→t2 修。

| 现象 | 原因 | 处理 |
|---|---|---|
| 报 `dsh 包未就绪：...bin.js 不存在` | 依赖缺失 | 首选标签页 deps「安装依赖」；或手动 npm i @deepseek-ai/dsh（目录需 package.json） |
| deps「存在但依赖不完整：ERR_MODULE_NOT_FOUND」 | 依赖图缺 peer（--omit=peer/中断假就绪） | 点「重新安装依赖」重跑 npm i（自动重验）；或「检测依赖」重验 |
| 显示「正在检测依赖完整性…」/「检测中…」 | 运行级验证中（数百 ms~10s） | 等待（进页自动一次）或手动点「检测依赖」 |
| t2 按钮禁用（msg「依赖未就绪…」） | t1 未过（缺失/验证失败/安装中/检测中） | 先完成 t1 再点「手动启动 web host」 |
| 升级/重装后 web host 起不来 | 升级清掉插件目录 node_modules | 依赖部署到**数据目录 dsh-pkg/**（升级不丢），页面自装或 npm i @deepseek-ai/dsh；装完调 dsh_run 重试拉起 |
| 报 `dsh web 启动超时（...端口未就绪）` | 依赖未就绪或端口被占用 | 先确认 t1 依赖已安装；webPort 被占用时改端口 |
| bash 报 `E_ACCESSDENIED` | dsh bash 沙箱 Windows 限制 | 改用文件系统工具（write/read/edit） |
| npm i 下载失败/超时 | registry 网络 | 切 `--registry=https://registry.npmmirror.com`（页面自装已内置重试），仍失败查代理 |
| 改了配置/代码不生效 | 宿主 tools 模块缓存 | 重启 Hana |

## 已知限制

- 主题跟随：system 跟随宿主，light/dark 原生；切偏好/主题后重开标签页生效
- bash 在 Windows 可能 E_ACCESSDENIED（dsh 沙箱限制）；文件工具正常，Windows 优先用
- wait=true 同步模式无审批通知（只能 Web UI 或超时）；长任务建议异步
- 越界权限默认走审批：deferred 通知 → dsh_approve 应答；30s 超时自动拒绝
- 任务默认新建会话；传 sessionId 复用（resume）
- 会话/账本在插件数据目录 dsh-home/，不碰 ~/.dsh
