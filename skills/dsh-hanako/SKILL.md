---
name: dsh-hanako
description: "dsh-hanako 插件（把 DeepSeek Harness 接进 Hana 的进程外 subagent 执行器）的配置辅助与使用指南。触发场景：dsh-hanako 刚装好需要配置、配置 nodePath/defaultCwd、依赖缺失需要安装（DSHana 标签页自装或 npm ci）、registry 镜像切换、标签页自检/自愈（安装依赖/手动启动/检测依赖）、web host 起不来（先看标签页自检 t1/t2/t3）、发版、dsh 任务失败排查、审批怎么应答、dsh_run/dsh_approve/dsh_cancel/dsh_ops/dsh_search 怎么用、默认模型怎么配（dsh 设置页「默认模型」块，provider/model/思考三级联动）、DeepSeek Harness 相关。遇到 dsh-hanako 相关需求优先读本技能再动手。"
---

# dsh-hanako 配置辅助与使用指南

把 DeepSeek Harness（dsh）接进 Hana：加载即拉起 dsh web host（--profile web），dsh_run 交任务给 dsh agent 执行，Web UI（http://127.0.0.1:3080）可见全部会话。

## 首次安装配置（Agent 辅助用户完成）

config.json 由宿主设置界面生成、**不随包分发**；nodePath/defaultCwd 初始为空。按序完成：

**0. 先看现状**：配置在 <宿主插件数据目录>/dsh-hanako/config.json（Windows 常见 %USERPROFILE%\.hanako\plugin-data\dsh-hanako\config.json）。**找不到**（全新安装）：先引导用户在设置界面保存一次（任意改动即触发写入），不要跳过直接写文件（宿主以设置界面为准，直接写可能被覆盖）。**无需配置 API Key / 模型**（v0.9.5+）：凭据由 dsh-hana-provider 插件直读宿主 `provider-catalog.json`，模型跟随宿主 `models.json`（dsh models 页设置默认）。

**1. nodePath（必改）**：未填时启动报 `node 可执行文件不存在`。探测本机 Node 24+：`where node`（cmd）/ `Get-Command node`（PowerShell）等。改法：设置界面填 node.exe 绝对路径、Agent 确认后直写 config.json `global.nodePath`，或**标签页 t1 候选列表点「采用」**（未配置时展示本机探测候选，写入 config.json）。**候选探测链按通用性排序**：PATH 最通用（任何 node 管理器/官方安装都会把 node 目录或 shim 放进 PATH）→ Program Files 官方安装 → nvm-windows/fnm/volta 等工具特定变量仅作补充（只认环境变量信号，不假设用户用特定版本管理器）；「采用」时服务端会真实校验 node --version + npm-cli.js。**生效分层**：检测层（标签页 t1）实时生效（resolveNodePath 直读 config.json 优先）；启动层同样现读——t3「手动启动」链路 startWebHostFromPlugin → ensureWebHost → resolveNodePath → spawn，无需重启即用新 node；仅旧进程存活（g.web.ready=true）时先杀进程（任务管理器/Stop-Process）再点，或重启 Hana。

**2. defaultCwd（建议）**：为空且未传 cwd 时报 `cwd 不能为空`；设为项目沙箱目录。

**3. 其余项默认可用**：agentPreset（standard）/ approvalTimeoutMs（30000）/ webPort（3080）/ callbackMode（summary）/ defaultTimeoutMs（600000）。任务模型不需要配置：默认用 dsh 默认模型（settings.yaml `agent-default-model`），可在 **dsh 设置页「默认模型」配置块**直接配置（Provider/模型/思考强度三级联动，选项 = dsh 全部可用 provider，保存即生效），`dsh_run` 工具参数 `provider`/`model`/`reasoningEffort` 可显式覆盖（显式时 selectModel，dsh 会把所选模型写回全局默认 settings.yaml——显式指定即成为新默认）。

**4. 配置生效铁律（检测层实时，启动层现读）**：「改完都要重启 Hana」不成立：t1 检测/t2/t3 状态直读 config.json/单例实时；t3 手动启动链路 resolveNodePath 现读 config.json → spawn，直写后无需重启即用新 node；仅旧进程存活（g.web.ready=true）需先杀进程或重启。

## 依赖自主部署（页面自装首选，Agent npm ci 兜底）

dsh 依赖（@deepseek-ai/dsh + node-pty/koffi）位置：**数据目录 dsh-pkg/**（优先，升级不丢依赖）→ 插件目录 node_modules（zip 自带，兑底）。部署 = 复制插件根 package.json+package-lock.json 到部署目录再 npm ci。

**页面自装（首选，v0.8.6+，无需 Agent）**：打开 DSHana 标签页（未就绪显示 t1/t2/t3）→ deps 卡片点「安装依赖」→ 插件自动完成（复制 lock 到 dsh-pkg → `node npm-cli.js ci --omit=dev --no-audit --no-fund`，官方源失败自动重试 npmmirror，约 30-40s → 校验 cliBin → 自动运行级重验 `node cliBin --version`）。安装中显示实时进度（npm 输出尾部+更新时间，3s 轮询刷新）；完成后无需重启，去 t3 点「手动启动」。验证失败（「存在但依赖不完整」）→ 点「重新安装依赖」；可随时点「检测依赖」重验。**t2→t3 门禁**：t2 未过（缺失/验证失败/安装中/检测中）时 t3 按钮禁用（msg「依赖未就绪，请先安装/重新安装依赖」）。

**Agent 手动 npm ci（兜底）**：检测缺失 = cliBin 不存在（`dsh 包未就绪：...node_modules\@deepseek-ai\dsh\lib\bin.js 不存在`）。命令（PATH 踩坑见下）：

```powershell
$node = <nodePath 绝对路径>
$npmCli = "$(Split-Path $node)\node_modules\npm\bin\npm-cli.js"
$env:PATH = "$(Split-Path $node);$env:PATH"   # 关键：install script 经 cmd 起子进程 node，PATH 缺 node 报 'node' is not recognized
Set-Location <部署目录：插件根或数据目录 dsh-pkg>
& $node $npmCli ci --omit=dev --no-audit --no-fund
```

- **--omit=dev**：剔除 rspack 构建树（~40MB）；dsh 在 peerDependencies，--omit=dev 下 peer 自动装保留 dsh 树（实测 528 包可运行）；**不可用 --omit=peer**（跳过 cordis peer → ERR_MODULE_NOT_FOUND）；不用 --omit=optional（误伤 rspack native binding）；npm 11 无 auto-install-peers 配置项、不可关闭。部署后验证 `& $node <部署目录>/node_modules/@deepseek-ai/dsh/lib/bin.js --version`（应输出 0.1.0-rc.6）。
- **registry 镜像**：默认源失败切 `--registry=https://registry.npmmirror.com`（或持久化 `npm config set registry https://registry.npmmirror.com`）；镜像只影响 registry 层，koffi/node-pty 产物同源。重跑前残留不完整先 `Remove-Item node_modules -Recurse -Force`。
- **部署后**：Agent 手动路径依赖就位后重启 Hana（tools 缓存）；页面自装无需重启。装完调一次 dsh_run 触发拉起。

## 主题跟随（v0.8.1）

dsh 偏好 `system`（默认）→ 跟随 Hana 主题（明暗+配色）；`light`/`dark` → dsh 原生配色。切偏好/切主题后**重开标签页生效**。部署要点：`assets/dsh-cordis/dsh-hana-theme/` 随包分发（缺失仅不跟随主题）；patch 模板 `config/dsh-hanako.patch.yml.tpl`（四段合一：session-query + theme + provider + default-model，v0.9.5 起 provider 段**恒渲染**——hostProvider 恒开跟随宿主，无关闭选项；default-model 段恒挂载）启动前渲染成本机路径写数据目录 `dsh-hanako.patch.generated.yml`（模板缺失/渲染失败回退静态 `session-query.patch.yml`）。排错：不跟随明暗 → 查 settings.yaml `ui-theme.preference` 为 system + /webui 有 color-scheme；配色不注入 → 查 generated patch 与 assets 目录；patch 在仍不注入 → 重启后查 stderr 有无 dsh-hana-theme 加载错误；切换不实时 → 壳页面（webui.js）有 dshHanaTheme message 监听。

## 默认模型配置（v0.9.5）

dsh 任务默认模型 = settings.yaml `agent-default-model`（`dsh_run` 不显式传 provider/model 时用）。设置页原生无该段配置 UI（settings.mutate 不可用），由 `dsh-hana-default-model` 插件补：dsh Web UI 左下角齿轮打开设置面板 → 通用设置上方「默认模型」配置块（Provider/模型/思考强度三级联动 + 保存 + 当前值回显），选项 = `llm.models` 权威列表（全部可用 provider 含宿主 sensenova/agnes/deepseek 与 deepseek-official），保存即写 settings.yaml 生效。部署要点：`assets/dsh-cordis/dsh-hana-default-model/` 随包分发（缺失仅设置页无该块，任务默认模型仍可在 dsh 会话模型选择器设置并写回）；patch 段4 注册；路由 `/api/hana-default-model.read` / `.save`。排错：块不出现 → 查 generated patch 段4 与 assets 目录、stderr 有无 dsh-hana-default-model 加载错误；保存失败 → 看块内错误提示（provider/model 空、服务不可用等）。

## 配置完成后验证

1. 打开 DSHana 标签页看自检（t1 node / t2 依赖 / t3 进程，每项 ✓/✗ + 修复指引），按序修：t1 ✗ → 填 nodePath（设置界面或 Agent 写 config.json；直写后 t1 检测实时生效，点「检测 Node」验证，再点 t3「手动启动」拉起，无需重启）；t2 ✗ → deps 卡片「安装依赖/重新安装依赖」；t3 ✗ → 先确认 t2 过，再点「手动启动 web host」
2. 跑最小试任务 `dsh_run(task="用文件写入工具在沙箱工作目录内创建 hello.txt，内容 hi，然后读回确认", cwd=<defaultCwd>)`，异步提交
3. 卡片不报 web host 错误 → 起来；完成后看摘要；浏览器开 http://127.0.0.1:3080 可见会话（可选）
4. 失败按排错表定位

## 工具速查

| 工具 | 用途 | 关键点 |
|---|---|---|
| `dsh_run(task, cwd?, timeout?, wait?, agentPreset?, reasoningEffort?, provider?, model?, sessionId?)` | 提交任务 | 默认异步（后台送达）；wait=true 同步；provider/model 显式覆盖模型（显式时 selectModel，写回 dsh 全局默认）；sessionId resume |
| `dsh_approve(opId, approvalId, outcome?)` | 应答审批 | allowed-once 放行 / rejected 拒绝；通知带 args 命令原文 |
| `dsh_cancel(opId)` | 取消任务 | 误派/卡死止损 |
| `dsh_ops(status?)` | 查任务历史 | 落盘可查；过滤 running/ok/error/interrupted |
| `dsh_search(query)` | 跨会话搜索 | 命中后可 resume |

### 标签页自愈路由（浏览器按钮调用，Agent 一般不直接调）

| 路由 | 用途 |
|---|---|
| `GET /webui` | 页面壳（就绪探测 + 主题 + 首帧自检） |
| `GET /webui/health` | 就绪探测；未就绪附带 diagnostics（自检数据源，3s 轮询） |
| `POST /webui/start` | 手动启动 web host（t3 按钮） |
| `POST /webui/install-deps` | 安装依赖（npm ci --omit=dev 到 dsh-pkg，npmmirror 兜底；t2 按钮） |
| `GET /webui/verify-deps` | 运行级依赖检测（node cliBin --version；进页自动一次 + 手动） |
| `GET /webui/verify-node` | Node/npm 可用性检测（node --version + npm-cli.js；进页自动一次 + 手动） |

## 审批流程（Agent 应答）

dsh 请求越界权限时任务挂起，插件经 deferred 发 dsh-approval 通知（opId/approvalId/reason/**args 命令路径原文**）。应答：读 args 判断 → 合理 `dsh_approve(opId, approvalId, "allowed-once")`，危险 `"rejected"`；无人应答超时（approvalTimeoutMs，默认 30s）自动拒绝；也可 dsh Web UI 人工处理。**决策看 args（执行了什么），不听 reason（model 自述）**。

## 排错表

**web host 起不来先开 DSHana 标签页看自检**（t1 node 配置+运行级检测 / t2 依赖存在性+运行级验证 / t3 进程）。**门禁链**：t1 未过（未配置/路径失效/检测失败/检测中）→ t2「安装依赖」+ t3「手动启动」全锁（msg「Node.js 不可用…」）；t1 过但 t2 未过 → t3 锁（msg「依赖未就绪…」）。按 t1→t2→t3 修。

| 现象 | 原因 | 处理 |
|---|---|---|
| 报 `node 可执行文件不存在` | nodePath 未配置/失效 | 探测并配置（写 config.json 后手动启动/下次工具调用现读生效，无需重启；旧进程存活先杀） |
| t1「配置存在但不可用」 | node 跑不了/无 npm 分发 | 换完整 node 安装（官方包/fnm）或 Agent 写 config.json；t1 检测实时生效，点「检测 Node」验证后 t3「手动启动」拉起 |
| 报 `dsh 包未就绪：...bin.js 不存在` | 依赖缺失 | 首选标签页 deps「安装依赖」；或手动 npm ci（目录需 package.json+lockfile） |
| deps「存在但依赖不完整：ERR_MODULE_NOT_FOUND」 | 依赖图缺 peer（--omit=peer/中断假就绪） | 点「重新安装依赖」重跑 npm ci（自动重验）；或「检测依赖」重验 |
| 显示「正在检测依赖完整性…」/「检测中…」 | 运行级验证中（数百 ms~10s） | 等待（进页自动一次）或手动点「检测依赖」 |
| t3 按钮禁用（msg「依赖未就绪…」） | t2 未过（缺失/验证失败/安装中/检测中） | 先完成 t2 再点「手动启动 web host」 |
| 升级/重装后 web host 起不来 | 升级清掉插件目录 node_modules | 依赖部署到**数据目录 dsh-pkg/**（升级不丢），页面自装或 npm ci；装完调 dsh_run 重试拉起 |
| 报 `dsh web 启动超时（...端口未就绪）` | 多为 nodePath 未配置/失效 | 同上；webPort 被占用时改端口 |
| bash 报 `E_ACCESSDENIED` | dsh bash 沙箱 Windows 限制 | 改用文件系统工具（write/read/edit） |
| npm ci 下载失败/超时 | registry 网络 | 切 `--registry=https://registry.npmmirror.com`（页面自装已内置重试），仍失败查代理 |
| 改了配置/代码不生效 | 宿主 tools 模块缓存 | 重启 Hana |

## 已知限制

- 主题跟随：system 跟随宿主，light/dark 原生；切偏好/主题后重开标签页生效
- bash 在 Windows 可能 E_ACCESSDENIED（dsh 沙箱限制）；文件工具正常，Windows 优先用
- wait=true 同步模式无审批通知（只能 Web UI 或超时）；长任务建议异步
- 越界权限默认走审批：deferred 通知 → dsh_approve 应答；30s 超时自动拒绝
- 任务默认新建会话；传 sessionId 复用（resume）
- 会话/账本在插件数据目录 dsh-home/，不碰 ~/.dsh
