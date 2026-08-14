---
name: dsh-hanako
description: "dsh-hanako 插件（把 DeepSeek Harness 接进 Hana 的进程外 subagent 执行器）的配置辅助与使用指南。触发场景：dsh-hanako 刚装好需要配置、配置 nodePath/apiKey/defaultCwd、依赖缺失需要 npm ci 安装、registry 镜像切换、插件构建打包（npm run build/pack）、发版、web host 起不来、dsh 任务失败排查、审批怎么应答、dsh_run/dsh_approve/dsh_cancel/dsh_ops/dsh_search 怎么用、DeepSeek Harness 相关。遇到 dsh-hanako 相关需求优先读本技能再动手。"
---

# dsh-hanako 配置辅助与使用指南

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh，DeepSeek 官方开源 agent harness）接进 Hana 的插件：插件加载即拉起常驻 dsh web host（`--profile web`），`dsh_run` 工具把任务交给 dsh 编码 agent 在沙箱内执行（DeepSeek 官方 API、文件系统/沙箱工具、上下文压缩、subagent 级联），dsh Web UI（默认 `http://127.0.0.1:3080`）可见全部任务会话。

## 首次安装配置（重点：Agent 辅助用户完成）

装好后 web host 可能起不来，因为**关键配置尚未填写**：config.json 由宿主在设置界面填写后生成、**不随包分发**（插件包不携带任何配置），路径类配置项（nodePath/defaultCwd）初始为空、不预设默认路径。按顺序辅助用户完成：

### 0. 先看现状

插件配置存在宿主插件数据目录的 `config.json`（`global` 作用域），路径规律：

```
<宿主插件数据目录>/dsh-hanako/config.json
```

（Windows 常见 `%USERPROFILE%\.hanako\plugin-data\dsh-hanako\config.json`；实际以宿主为准，可用文件工具定位 `plugin-data/dsh-hanako/config.json`。）读取它确认 `global` 下各项当前值。

### 1. nodePath（必改，最可能拦路）

- **为什么**：nodePath 初始为空（不存在随包默认值），未填时 web host 启动报 `node 可执行文件不存在`（或类似）；不要假设它指向任何机器，由用户填自己机器的路径
- **怎么找对方机器的 node**：探测本机可用的 Node 24+，例如 `fnm exec -- node -v`、`where node`（Windows cmd）/ `Get-Command node`（PowerShell），或查看 fnm 安装目录 `%USERPROFILE%\AppData\Roaming\fnm\node-versions\<版本>\installation\node.exe`
- **怎么改**：引导用户在插件设置界面「Node.js 可执行文件路径」填入探测到的 node.exe 绝对路径；Agent 拿到用户确认的路径后也可直接写 config.json 的 `global.nodePath`
- **改后必须重启 Hana**：nodePath 是插件加载时注入的配置快照，web host 随插件生命周期拉起，不重启不生效

### 2. apiKey（必填）

- **为什么**：dsh 走 DeepSeek 官方 API，无 key 时 web host 启动报 `找不到 DEEPSEEK_API_KEY`
- **怎么填**：**Agent 不要代填**（密钥经工具参数会留在会话与日志里）——引导用户在插件设置界面「DeepSeek API Key」填写，宿主写入 config.json。Agent 只检查「已填 / 未填」状态
- 其他兜底途径（用户有文件时）：key 写入 `dsh-home/.credentials.yaml` 或 `~/.dsh/.credentials.yaml`（插件按 apiKey → dsh-home/.credentials.yaml → ~/.dsh/.credentials.yaml 链解析）
- **改后重启 Hana**：key 在 web host 启动时注入进程环境变量，重启后随新进程生效

### 3. defaultCwd（建议改）

- 初始为空（不预设路径）；为空且工具调用未显式传 cwd 时，任务提交报 `cwd 不能为空`
- 引导用户改成对方实际的沙箱工作目录（dsh agent 读写文件的活动范围）

### 4. 其余项（默认即可用）

`model`（deepseek-v4-flash）/ `agentPreset`（standard）/ `reasoningEffort`（high）/ `approvalTimeoutMs`（30000）/ `webPort`（3080）/ `callbackMode`（summary）/ `defaultTimeoutMs`（600000）——默认值开箱可用，非必要不动。

### 5. 配置生效铁律

**任何核心配置（nodePath/apiKey/defaultCwd/webPort）改完都要重启 Hana**：宿主按插件 id 缓存 tools 模块与配置快照，只有重启才重新加载。

## 依赖自主部署（npm ci，Agent 可无人值守完成）

dsh 运行需要 `@deepseek-ai/dsh` 依赖树（含原生模块 node-pty/koffi）。依赖位置两个可能：**数据目录 `dsh-pkg/`**（轻量分发形态，依赖按需安装，**优先**：resolveDshPkgDir 先找它）或**插件安装目录 `node_modules/`**（zip 自带，兑底）。Agent 检测到依赖缺失时自主完成部署，无需用户介入（除网络/镜像场景）。

**部署位置选 dsh-pkg 的理由**：升级安装会整体替换插件目录、清掉 node_modules；数据目录随插件生命周期保留，装 dsh-pkg 后升级不再丢依赖。部署：把插件目录的 `package.json` + `package-lock.json` 复制进 `dsh-pkg/` 再执行 npm ci。

### 检测依赖缺失

- web host 启动报 `dsh 包未就绪：<路径>\node_modules\@deepseek-ai\dsh\lib\bin.js 不存在`，或检查目标目录（插件根 / `dsh-pkg`）下 `node_modules/@deepseek-ai/dsh/lib/bin.js` 不存在

### npm ci 部署（核心动作，已验证：35s 无人值守完成）

前置：部署目录必须有 `package.json` + `package-lock.json`（插件包自带；lockfile 锁死依赖版本，npm ci 严格按它安装，含 integrity 校验）。

**dev 依赖不装（`--omit=dev`）**：构建工具（@rspack/core）声明在插件 package.json 的 devDependencies，仅为开发者本地构建契约（`npm run build`/`npm run pack` 用），Agent 部署只需 dsh 运行时树，命令显式加 `--omit=dev` 剔除 dev 树——避免把 rspack 构建链（约 40MB）装进 dsh-pkg。

**dsh 声明在 peerDependencies**：npm 7+ 在部署 `--omit=dev` 下仍自动安装 peer（实测 528 包，dsh 0.1.0-rc.6 可运行、rspack 不装），与 dependencies 声明行为等价；CI 构建侧用 `--omit=peer` 只装 dev 树（rspack，11 包 2s）。**部署命令必须保留 peer 自动装（`--omit=dev`，不可用 `--omit=peer`）**：dsh 树内部含 peer 依赖（cordis 生态，如 @deepseek-ai/cordis-plugin-group），`--omit=peer` 会一并跳过导致 dsh 不可运行（实测 ERR_MODULE_NOT_FOUND）。不用 optionalDependencies：rspack 的 native binding 自身是 optional 依赖，`--omit=optional` 会误伤它（npm/cli#4828 同源）。peer 自动装默认开启且可靠：npm 11（Node 24 自带）已移除 auto-install-peers 配置项（CLI/env 均报 Unknown），不可关闭，实测 528 包必装 dsh；部署后验证 `dsh lib/bin.js --version` 为最终兜底。

```powershell
# 1. 定位 node 与 npm-cli（node 不在 PATH 时用绝对路径）
$node = <nodePath 或探测到的 node.exe 绝对路径>
$npmCli = "$(Split-Path $node)\node_modules\npm\bin\npm-cli.js"
# 1.5 关键：把 node 目录加进 PATH。绝对路径启动 npm 时，koffi/node-pty 的 install script
#     经 cmd.exe 起子进程 node（如 node ./cnoke.cjs），PATH 缺 node 会报 'node' is not recognized 直接失败
$env:PATH = "$(Split-Path $node);$env:PATH"
# 2. 在部署目录执行（目录需含 package.json + package-lock.json）
Set-Location <部署目录：插件根或数据目录 dsh-pkg>
& $node $npmCli ci --omit=dev --no-audit --no-fund
```

验证产物：

```powershell
& $node -e "require('koffi'); require('node-pty'); console.log('native OK')"  # 需在部署目录 node_modules 可见
& $node <部署目录>/node_modules/@deepseek-ai/dsh/lib/bin.js --version   # 应输出 0.1.0-rc.6
```

**无需工具链、无需批准脚本**：koffi 走官方预编译分包（`@koromix/koffi-<platform>`），node-pty 发布自带 prebuilds（win32 走 ConPTY，spawn-helper 仅 darwin 需要）；npm 11 默认阻止 install scripts 不影响产物。

**已踩坑（2026-08-14 实机）**：用绝对路径启动 npm-cli.js 且未加 PATH 时，koffi 的 install script（`node ./cnoke.cjs -P . -D src/koffi --prebuild --release`）与 node-pty 的 `scripts/prebuild.js` 均因子进程找不到 node 失败（`'node' is not recognized`），npm 报 `command failed`，随后 cleanup 的 EPERM rmdir 警告属连锁反应、非主因。修复：npm ci 前 `$env:PATH = "<node目录>;$env:PATH"` 重跑即过（实测 528 包 / 32s）。失败重跑前若 node_modules 残留不完整，先 `Remove-Item node_modules -Recurse -Force` 清掉再跑。

### registry 镜像（网络不通/慢时）

npm 默认 registry（registry.npmjs.org）不通或超时时，切镜像重跑：

```powershell
& $node $npmCli ci --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund
# 或持久化：npm config set registry https://registry.npmmirror.com
```

其他可用镜像：淘宝 npmmirror（国内）、官方源（海外）。Agent 先试默认源，失败再切镜像，镜像也失败则检查代理/网络后重试。**镜像只影响 npm registry 层**——koffi 分包与 node-pty prebuilds 都来自 registry，无独立二进制下载。

### 部署后

依赖就位后**重启 Hana**（宿主按插件 id 缓存 tools 模块，加载期才读依赖），再跑最小 `dsh_run` 试任务验证。

## 主题跟随（dsh WebUI ↔ Hana 主题，v0.8.1）

DSHana 标签内 dsh 主题与宿主 Hana 联动，语义一句话：

| dsh 偏好 | 标签页效果 |
| --- | --- |
| `system`（默认） | 完整跟随 Hana 主题：11 个 Hana 主题的明暗 + 配色 |
| `light` / `dark` | 保持 dsh 内置原生配色，不受影响 |

**部署要点**（部署方 Agent 需要知道的）：

- **文件随包分发**：`assets/dsh-cordis/dsh-hana-theme/`（index.js + package.json）随插件包分发，升级自动更新；缺失时主题不跟随，但不影响其他功能
- **patch 自动渲染**：dsh-run.js 启动前把 `config/hana-theme.patch.yml.tpl` 渲染成本机路径写到数据目录 `hana-theme.patch.generated.yml`，与 session-query.patch.yml 一起作为 `--patch` 传给 dsh 启动器；模板缺失时优雅降级（跳过该 patch）
- **生效时机**：用户切 dsh 偏好后需**重开 DSHana 标签页**生效（加载时判定一次，不轮询）；宿主切 Hana 主题（跨明暗）即时跟随，同明暗主题间切换需刷新标签页（配色相近，影响小）
- **dsh 偏好需为 system 才跟随明暗**：settings.yaml `ui-theme.preference` 非 system 时不注入

**排错**（按顺序查）：

| 现象 | 检查点 | 处置 |
| --- | --- | --- |
| iframe 内 dsh 不跟随明暗 | dsh 偏好 + 壳页面 color-scheme | 确认 settings.yaml `ui-theme.preference` 为 system；确认 `/webui` 响应 html 有 `color-scheme:dark\|light` |
| 配色不注入（dsh 原生色） | 生成 patch 是否存在 | 查数据目录 `hana-theme.patch.generated.yml`（dsh-run.js 启动时生成）；确认安装目录 `assets/dsh-cordis/dsh-hana-theme/` 存在（index.js） |
| 配色不注入（patch 在） | dsh 启动日志 | 重启后查 stderr 有无 `dsh-hana-theme` 加载错误（webServer inject 失败/模块解析失败） |
| 主题切换不实时 | 壳桥是否工作 | 壳页面（webui.js）需有 message 监听回传 `dshHanaTheme`；dsh 页面需能 postMessage（跨源 OK） |
| 同明暗主题切换不跟随 | 已知限制 | 配色相近可接受；刷新标签页即更新 |

## 构建与打包（开发者）

插件本体 rspack 打包，构建工具声明在 devDependencies（构建契约，Agent 部署 `--omit=dev` 剔除，见上）。开发者本地构建：

```powershell
# 0. node 目录加进 PATH（npm run 的脚本经 cmd 执行，PATH 缺 node 报 'node' is not recognized）
$env:PATH = "<node目录>;$env:PATH"
# 可选：指定独立构建环境（推荐，见下）；不设则回退本机 node_modules
$env:RSPACK_ENV = "E:\Hanako\workspace\_tmp\build-env"
npm run build          # rspack bundle 到 dist/（中间产物）：index.js + 5 工具，多入口 ESM 压缩
npm run pack           # 全链打包：build → 铺平标准插件形态 → zip + SHA256 归档 releases/（铺平中间产物在 _tmp/pkg/，可清空）
npm run pack -- 0.7.1  # 指定版本；缺省用 package.json 的 version（版本单一事实源）
```

### 构建环境与依赖

- **主题来源（宿主声明，v0.8.1 重构）**：无静态主题表。壳页面 html 带 `data-theme`（=hana-theme query），宿主的 `/api/plugins/theme.css?theme=` 变量选择器匹配生效，壳桥 getComputedStyle 读 16 个主题变量回传注入脚本；宿主切主题 → iframe URL 重建重载 → 新值；宿主新增/修改主题零适配
- **构建实际只用 `@rspack/core`**（build.mjs 编程 API `rspack({...})`，不用 cli）；devDependencies 声明 `@rspack/core`，版本与独立构建环境（`_tmp/build-env`，1.7.12）一致，声明与实际构建用同一事实
- **RSPACK_ENV 优先**：设置时从该目录解析 @rspack/core，否则回退本地 node_modules（本机 `npm install` 后可用）
- **改 devDependencies 必须同步 lockfile**：`npm install --package-lock-only` 更新 root 声明 + 包树（rspack 树），dsh 运行时树不动；不同步则 Agent 端 npm ci 撞 lockfile 严格校验（EUSAGE，`package.json and package-lock.json are not in sync`）
- **Agent 部署必带 `--omit=dev`**：lockfile 含 dev 树后，全量 npm ci 会把 rspack 构建链（约 40MB）装进 dsh-pkg；`--omit=dev` 后仍 528 包，与无 dev 声明时等价
- 交付物无 dist/ 目录：pack.mjs 把 bundle 铺平到标准位置（根 index.js + tools/），manifest 指向标准路径

## 配置完成后验证

1. 重启 Hana 后，跑一个最小试任务：`dsh_run(task="用文件写入工具在沙箱工作目录内创建 hello.txt，内容 hi，然后读回确认", cwd=<defaultCwd>)`，异步提交
2. 观察：任务卡片出现且不报 web host 启动错误 → web host 起来了；完成后看结果摘要
3. 浏览器打开 `http://127.0.0.1:3080` 应能看到任务会话（可选）
4. 失败时按下方排错表定位

## 工具速查

| 工具 | 用途 | 关键点 |
|---|---|---|
| `dsh_run(task, cwd?, timeout?, wait?, agentPreset?, reasoningEffort?, sessionId?)` | 提交任务给 dsh | 默认异步（完成后台送达）；`wait=true` 同步；`sessionId` 复用会话 resume |
| `dsh_approve(opId, approvalId, outcome?)` | 应答审批 | 收到 dsh-approval 通知时调用；`allowed-once`=放行单次 / `rejected`=拒绝；通知带命令/路径原文（args）供决策 |
| `dsh_cancel(opId)` | 取消运行中任务 | 误派/卡死止损 |
| `dsh_ops(status?)` | 查任务历史 | 重启后仍可查（落盘）；status 过滤 running/ok/error/interrupted |
| `dsh_search(query)` | 跨会话搜索 | 命中后可用 sessionId resume |

## 审批流程（Agent 应答）

dsh agent 请求越界权限（如提权写沙箱外文件）时任务挂起，插件经 deferred 通道发来 `dsh-approval` 通知（带 opId / approvalId / toolName / callId / reason / **args 命令路径原文** / taskPreview）。收到后：

1. 读 `args`（或通知里的 reason/taskPreview）判断该次操作是否合理
2. 合理 → `dsh_approve(opId, approvalId, "allowed-once")` 放行单次；危险 → `"rejected"` 拒绝
3. 无人应答超过 `approvalTimeoutMs`（默认 30s）自动 rejected（应答方失联兜底）
4. 也可在 dsh Web UI 人工处理

**决策依据**：看 args 里「具体执行了什么」（命令/路径原文），不要只听 reason（model 自述）。

## 排错表

| 现象 | 原因 | 处理 |
|---|---|---|
| 工具调用报 `node 可执行文件不存在：<路径>` | nodePath 未配置（初始为空）或路径失效 | 按上文第 1 步探测本机 node 并配置，重启 |
| 报 `找不到 DEEPSEEK_API_KEY` | apiKey 未填 | 按第 2 步引导用户填，重启 |
| 报 `dsh 包未就绪：...bin.js 不存在` | 依赖缺失/被裁剪（现役 zip 自带 node_modules，先确认解压完整；轻量分发形态需自行部署） | 按「依赖自主部署」章节 npm ci（部署目录需含 package.json + lockfile） |
| 升级/重装插件后 web host 起不来（报 `dsh 包未就绪`） | 升级安装会**整体替换插件目录，清掉 node_modules**（zip 是零依赖形态，不含运行时树） | 依赖部署到**数据目录 `dsh-pkg/`**（`<宿主插件数据目录>/dsh-hanako/dsh-pkg`，resolveDshPkgDir 优先位置，升级不丢），npm ci 见下；装完调一次 dsh_run 触发 web host 重试拉起（onload 已失败不会自动重拉） |
| 报 `dsh web 启动超时（...端口未就绪）` | web host 起不来（多为 nodePath/apiKey 问题） | 同上两项；`webPort` 被占用时改端口 |
| 任务执行中 bash 报 `E_ACCESSDENIED` | dsh bash 沙箱在 Windows 的限制 | 改用文件系统工具（write/read/edit），Windows 上文件工具正常 |
| npm ci 下载失败/超时 | registry 网络问题 | 切镜像 `--registry=https://registry.npmmirror.com` 重跑，仍失败查代理 |
| 改了配置/代码不生效 | 宿主 tools 模块缓存 | 重启 Hana |

## 已知限制

- **主题跟随语义（v0.8.1）**：dsh 主题偏好 `system`（默认）→ DSHana 标签内完整跟随 Hana 宿主主题（11 个主题）：明暗经壳页面 `color-scheme` 传导，配色由注入的 `dsh-hana-theme` cordis 插件感知——宿主声明：壳页面 html\[data-theme\] 使 theme.css 变量生效，壳桥 getComputedStyle 回传 16 个主题变量渲染值（随宿主更新，新增主题零适配），body 层 `!important` 覆盖 70 个 `--dsw-alias-\*` + `--dsw-specific-\*` token（视觉主表面），mask/scrollbar/toast/tooltip/warn 特殊层保留原生。**preference = light/dark → 完全不覆盖，dsh 内置原生配色**（注入脚本加载时读一次 settings.describe 判定，不轮询；用户切 preference 后重开标签页生效）。宿主切主题（跨明暗）即时跟随；同明暗主题切换需刷新标签页（配色相近）。覆盖必须写 body 层（dsh presenter 把 token 以 inline 写 body，html 继承值压不过）
- **bash 工具在 Windows 可能 `E_ACCESSDENIED`**（dsh 沙箱环境限制，非插件问题）；文件系统工具（write/read/edit）在 workspace-write 沙箱下正常，Windows 优先用文件工具
- **同步模式（wait=true）无审批通知**：审批挂起只能靠 Web UI 人工处理或超时；长任务建议异步
- 越界权限请求默认走审批：插件捕获 approval/requested → deferred 通知 Agent → dsh_approve 应答；无人应答 30s 超时自动拒绝
- 每次任务默认新建独立会话；传 `sessionId` 可复用（resume，上下文继承）
- 任务会话/账本落在插件数据目录 `dsh-home/`，不碰 `~/.dsh`
