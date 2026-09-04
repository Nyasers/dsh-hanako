# DSHana 设计

插件 id：`dsh-hanako`。把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）接进 Hana。

## 架构总览（进程内 boot）

```text
Hana 宿主进程
  ├─ 插件 bundle（dist/index.js，零 @deepseek-ai 静态依赖——D6 解耦）
  │    └─ 运行时 import dsh-pkg? 不——插件根 node_modules/@deepseek-ai/dsh/lib/profile-boot-*.js
  │         （webpackIgnore 原生 import；版本随插件声明，DSH 是插件 dependencies）
  │         → runProfile() → boot() 自建 cordis Context（DSH 符号是宿主子集，同进程无冲突）
  │              → 加载 $DSH_HOME/profiles/dshana（junction → 插件 dist/cordis）
  │                   → dsh-* 官方插件（从插件 node_modules 依赖树解析）
  │                   → @dsh-hanako/* 子插件（bridge / bus / app / logger / clipboard / theme / provider / settings）
  └─ 3080 端口 = 宿主进程内 webserver（无独立 DSH 子进程）
```

- **进程内 boot**：`ensureWebHost` → `bootInproc`（动态 import profile-boot → `runProfile`），webserver 保留在宿主进程内 bind；`closeProcess` → `ctx.fiber.dispose()`（不用 runProfile 返回的 shutdown 控制器——其 `shutdown()` 写 process.exitCode、`interrupt()` 会 process.exit 杀宿主进程）
- **依赖形态**：DSH 是插件根 `package.json` 的 dependencies（`@deepseek-ai/dsh` + `@deepseek-ai/cordis` 固定版本随插件发版）；运行时 `pnpm install --prod` 装进**插件根 node_modules**（dsh-pkg 独立安装区已退役——无部署声明副本，版本单一事实源 = 插件声明本身，无 version/tag 逃生门）；`resolveDshPkgDir` 恒插件根
- **更新 = 插件发版**：DSH 版本检查/更新整链移除（`updateDsh` / `checkDshUpdate` / `/webui/check-update` / `/webui/update-dsh` / `dsh_install` 的 check/update 全删）；settings 版本卡只显示本地版本
- **免鉴权数据面**：`@dsh-hanako/bridge` 提供 connection 等价服务（`requestRejection` 恒 undefined = 免 401/403）+ `/api` HTTP 载体（信封解析 → interceptor 分发，协议与官方 rpcFetchHandler 一致）——替代官方 dsh-client-connection 的 BrowserAuth token/cookie 鉴权面；官方 gateway / api-* 插件零改动激活；remote.mux 事件流由 gateway 自带自动放行
- **WebUI**：`@dsh-hanako/app` 经 webserver `registerFallback` serve 官方 dist 到**根路径**（无 /webui/ 前缀、无 URL 改写），iframe 直嵌 `http://127.0.0.1:<webPort>/`
- **消息总线**：`@dsh-hanako/bus`（dshana.bus WS 服务端，/api/dshana.bus upgrade 路由 + RPC 翻译器 + 事件流转发）↔ 宿主 `src/lib/bus.js`（WS 客户端）；进程间唯一通道

## 工具

宿主 Agent 工具面收敛为**单工具 `dsh_session`**（源码 `tools/session.js` 分派壳 + `tools/subtool/{run,query,cancel,approve}.js`——每操作独立 execute，subtool 不再单独注册）。**完整调用手册见 [dsh-session](src/skills/dsh-session/SKILL.md)**：

| action | 用途 | 实现 |
| --- | --- | --- |
| `create` / `send` | 新建会话+提交 / 续已有会话（task+cwd 必填，resume 语义） | subtool/run（合并原 dsh_run） |
| `list` / `get` | 会话清单 / 凭 sessionId 取内容（projcache + jsonl zstd 本地读） | subtool/query |
| `cancel` | 取消任务（sessionId 必填，幂等） | subtool/cancel（原 dsh_cancel） |
| `approve` | 应答会话挂起审批（allowed-once/rejected，决策看 args） | subtool/approve（原 dsh_approve） |

`dsh_install` 已退役：依赖安装由自动链 + Bootstrap 自举承担（D6 零干预），能力层 `lib/bootstrap.js`（installDeps/verifyDeps）保留供插件生命周期使用。

任务提交链路（dsh_session create/send）：`session.create`（新建 `{cwd, agentPreset?}`；send 沿用会话 cwd）→ `selectModel`（仅显式传 provider/model/effort 时）→ `session.prompt`（mode=queue）→ 经总线 events 频道（bus 插件订阅 `$events` 转发）→ 终态（`api-session/status false` = end_turn）。deferred taskId = 任务 rpcId，完成宿主唤醒。

## DSH Web UI（DSHana 标签页）

配置 `webPort`（默认 3080）时插件加载即**进程内 boot**，DSHana 以**父子双卡**注册（manifest
`contributes.cards[]`：主卡 id `dshana` route `/main`（realization:page + siteNavEntry）；子卡 id
`dshana-sidebar` route `/sidebar`、`pageOf: "dshana"`——宿主 functionPanel route 参数落地前的
过渡表达），每卡壳页 iframe 内嵌 `http://127.0.0.1:<webPort>/?dshana-view=<view>`（同源免鉴权）：

- **三态自举页（Bootstrap 壳，T4）**：按总线连接状态判定——已连接直接渲染 iframe；未连接渲染自举页，数据源 = `GET /webui/boot-state`（T3 单一状态出口）+ `GET /webui/events` 事件流（ready/pending/diag-changed/theme-pref）：booting（阶段时间线 + 安装实时日志 + 退避信息）/ action-needed（errorClass 人话 + 操作步骤 + 自动续跑/停等说明）/ ready（iframe 直嵌）。**页面无任何手动按钮**
- **父子双卡视图装配（V5 过渡）**：主卡 dshana 直嵌 main 视图（`?dshana-view=main`，选中态桥 receive）；子卡 dshana-sidebar 直嵌纯侧栏视图（`?dshana-view=sidebar`，emit）——URL 参数驱动装配与桥角色（`@dsh-hanako/view` readView / sync-bridge），单向下行分落两卡；子卡不声明 realization/siteNavEntry/fpFullPanel（宿主 schema：声明 pageOf 的卡 realization 会被删，显式不声明最干净）。旧 manifest 的 fpFullPanel/functionPanel（embedUrl 侧栏）已摘除，fp 集成待宿主 route 参数支持后议
- **iframe 主题桥**：壳页 postMessage 回传宿主主题 vars → 注入的 theme 插件写 body 层 `!important` 覆盖（`--dsw-alias-*` + `--dsw-specific-*` token 映射，无静态主题表）；DSH 偏好 `system`（默认）跟随宿主明暗 + 配色，`light`/`dark` 用原生；偏好变更经 3s 轻量轮询 `settings/describe` 实时重评（旧 events.host WS 端点已随 DSH 0.1.2 退役）

### DSHana 设置分页

DSH 设置页「DSHana 设置」分页（settings.section slot，id `dshana-settings`）：

- **默认模型卡片**：`agent-default-model` 配置 UI（Provider/模型/思考强度三级联动，选项 = `session/modelCatalog` RPC 权威列表；保存写 settings.yaml 立即生效）——`dsh_session` 不显式传 provider/model 时的任务默认
- **DSH 版本卡片**：只显示本地 DSH 版本 + 「更新 DSH = 更新插件版本」说明（更新/检查已移除）

机制：`@dsh-hanako/settings` 双端——后端注册 `/api/hana-settings.read` / `.save` / `.check-version`（只回本地版本）；前端 client.js 注册 slot 原生渲染。

## 主题跟随

`@dsh-hanako/theme` 经 tapIndex 注入 index 响应：静态 fallback（DEFAULT_THEME）+ 动态脚本（postMessage 向壳页索取 `{ themeId, vars }` → 写 body 层 `!important` 覆盖）。DSH 偏好经 `settings/describe` 读取（加载一次 + 3s 轻量轮询，`document.hidden` 时暂停），`system` 应用壳桥 vars、`light`/`dark` 完全原生。

## 启动自动链与错误分类（T1-T5）

- **自动链状态机（T2）**：插件 onload 后后台推进 `ensure-deps → booting → ready`（状态存单例 `g.boot = { phase, attempt, nextRetryAt, errorClass, guidance, lastError, timer }`）：依赖幂等安装（按插件根声明 pnpm install --prod，npmmirror 兜底）→ 进程内启动 web host → 收敛。失败退避 30s→2m→10m→30m 自动重试；不可恢复类（macos-signature / declaration / restart-needed）停等条件变化（config 保存 / 插件更新 / 重启宿主），config 类挂 fs.watch 自动续跑
- **错误分类（T1）**：install/boot 失败经 `classifyInstallError` 归六类 errorClass + 一句中文 guidance（存 `g.deps.errorClass` / `g.boot.guidance`）；restart-needed = dsh 跨版本升级缓存残留
- **自举状态快照（T3）**：`GET /webui/boot-state` = `{ phase, ready, deps:{status,errorClass,guidance,error,version,logTail}, boot:{attempt,nextRetryAt,errorClass,guidance,lastError}, web:{ready,lastError} }`——页面/Agent 唯一状态出口
- **Bootstrap 壳页（T4/T5）**：三态渲染见上；旧诊断壳（t1/t2 checks 展示、手动按钮、门禁链）与手动路由（/webui/start、/webui/install-deps、/webui/verify-deps、/webui/health）及 `collectWebDiagnostics` 家族整体退役删除

## 依赖部署与解耦（D6）

- **pnpm 运行时引导**：`lib/pnpm.js` `ensurePnpm` 下载单文件 pnpm.mjs 到数据目录 pnpm-dist/（工具包不 import pnpm）；安装经子进程跑（`pnpm install --prod` 到插件根，pnpm 原生文本直通日志通道——ndjson reporter 已去除 2026-09-03）
- **诊断不 import cordis**：`verifyDepsSmoke` 静态核对（cliBin 为常规文件 + 磁盘版本 === 插件声明，无子进程秒回；磁盘完整性由 pnpm install 保证、可运行性由 boot 裁决）；`readDshInstalledVersion` 直读插件 node_modules/@deepseek-ai/dsh/package.json
- **node 代理**：插件根 node.cmd（与部署物同目录——历史数据目录 pnpm-proxy 漂移教训，PATH 与代理同源绑定），指向解析后的 node 执行体（默认宿主 electron node，配置 nodejsPath 时用系统 node），让 koffi/node-pty 的 install script 找到宿主 node
- **进程内 boot 解耦**：`loadInprocDsh` 运行时动态 import（webpackIgnore 保留原生 import；枚举 profile-boot-*.js 试 runProfile；app-boot 定位 createRequire + .pnpm 枚举双保险）——插件 bundle 零 @deepseek-ai 静态引用，DSH 缺失时诊断/安装引导仍可用

## 进程间消息总线（dshana.bus）

- **服务端**：`@dsh-hanako/bus` cordis 插件经 `webServer.registerUpgrade({ path:"/api/dshana.bus" })` 注册 upgrade 路由，零依赖手写 RFC6455（ws-lib.js）；首帧 hello（免鉴权身份宣告 + 共享秘密校验凭据方法）、单连接语义、心跳
- **协议**：JSON 文本帧 `{ channel, payload }`——hello/hello-ok/config/log/update.*/provider.refresh/rpc.request/rpc.result/bus.ping/bus.pong/events
- **RPC 翻译器**：宿主 Unary RPC（session.create/prompt/selectModel/cancel + respond 审批应答）经总线 rpc.request 投递 → bus 翻译器自环调 DSH /api（协议与 bridge 载体一致）→ rpc.result 回投
- **事件流**：bus 在 DSH 进程内代宿主订阅 remote.mux `$events`，经总线 events 频道转发（ready/emit/waterfall）
- **宿主侧**：`src/lib/bus.js` WS 客户端（指数退避重连 + 心跳 + 单例 g.dshanaBus + connectBus/closeBus/setBusConfigProvider）

## 已知限制

- **升级 dsh = 装新插件包 + 重启宿主**：插件侧无法豁免宿主进程内 ESM 模块缓存（spec 决策，勿重走弯路）；跨版本升级后 boot 撞旧 .pnpm 路径 ENOENT → errorClass=restart-needed 停等，重启宿主后自动链自动续跑
- **bash 工具在 Windows 上可能 `E_ACCESSDENIED`**（dsh-bash-sandbox 创建 bash 服务实例失败，属 DSH 沙箱环境限制）。文件系统工具正常，Windows 上优先用文件系统工具
- **HMR 降级**：进程内 boot 无 `--expose-internals`，dshana profile 的 patchReload live 依赖 HMR 可能静默降级（patch 静态/重启生效，插件升级时 dispose+reboot 重载）
- 越界权限请求默认走审批自动化：插件捕获 approval/requested → 通知 Agent → `dsh_session(action="approve")` 应答；无人应答超时自动拒绝
