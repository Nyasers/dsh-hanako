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

## App v2 迁移状态（feat/app-v2-migration，接口基线 Hana 0.930.1）

本分支把 DSHana 从「v1 宿主插件（宿主进程内 boot DSH）」迁移为「Hana App v2（隔离 App 进程 + `apply(ctx)`）」，执行顺序见 `specs/DSHana迁移到HanaAppV2.md` §13。以上各节描述的是 v1 架构（进程内 boot / 总线 / 卡片），随迁移逐刀更新。

**已落地（步骤 1：manifest / apply 入口 / 设置 / 工具注册，验证 list/get）：**

- `src/manifest.json` 改为 App v2 契约：`version 2.0.0-beta.1`、`entry index.js`、`icon assets/icon.png`、`minAppVersion 0.930.1`、capabilities 取指南 §3 七项（`app/tools.expose-to-model`、`app/tasks.manage`、`app/session.start-turn`、`app/models.infer`、`app/runtime.execute`、`app/runtime.native`、`app/runtime.network`）。v1 专属/过时字段移除：`author`、`trust`、`activationEvents`（v2 无）、`ui.hostCapabilities`、`contributes.cards`（UI 迁移步骤回归）、`contributes.configuration → contributes.settings`、`network` 白名单（步骤 1 无 App 级 fetch；DSH 外网走受管 runtime 自身网络）。
- `src/index.js`：`class + onload()` → `export apply(ctx)`（兼导出 `default { apply }`）；apply 注册完即返回。统一日志平移写 `ctx.dataDir/logs`；globalThis 宿主单例退役 → `src/lib/app-runtime.js` module-scope 运行包。
- 工具注册：`ctx.tools.register`，工具名保留 `dsh_session`（v2 无自动 `pluginId_` 前缀、全局唯一；决策与冲突面见 `src/tools/session.js` 头注释）。action 参数与返回语义不变；本步骤仅 `list`/`get` 可用（DSH 未启动仍离线可读），`create`/`send`/`cancel`/`approve` 返回明确「待迁移步骤 2 接线」错误。
- 设置：`contributes.settings`（approvalTimeoutSec / defaultTimeoutSec / nodejsPath），工具执行期经 `ctx.config.get`（apply 完成后才登记，apply 顶层不读）。
- 数据读路径迁到 `ctx.dataDir`（宿主 `app-data/<id>/`）：list/get 读 `<dataDir>/dsh-home/...`（projcache + jsonl zstd）；旧插件数据迁移只留接缝（`lib/app-runtime.js appDataDir` 注释），本步骤不做迁移脚本。
- 构建：`node src/build.js` 产物 `dist/` = App 安装目录形态（根 `manifest.json` + `index.js` + `assets/icon.png` + `skills/`）；v1 的 `dist/routes/` 壳不再生成。

**已落地（步骤 2：DSH 迁入 App 受管 Node runtime，native/external + readyMarker 就绪门）：**

- 受管 runtime 入口 `runtime/dsh-host.mjs`（源码 `src/runtime/`，rspack → `dist/runtime/dsh-host.mjs`，见 `src/runtime/rspack.config.mjs`）：App 自有参数解析（`--port/--data-dir/--hana-task-id/--deps-root/--cordis-src/--ready-marker/--no-ensure`，与 `src/lib/managed-runtime.js buildRuntimeArgs()` 对偶）→ `connectAppRuntime()`（无父 IPC fd → 可操作报错 + 退出码 3，不假装能跑）→ 进程级 env（`DSH_HOME=<dataDir>/dsh-home`、`DSHANA_ROOT=<dataDir>/runtime`、`DSHANA_HOME=<dataDir>`，不改宿主进程环境）→ 依赖 ensure → profile 种子化（`initProfile` + `node_modules/@dsh-hanako` scope 链接 → installDir `cordis/`，junction/拷贝回退）→ 动态定位 DSH（`locate.js`，profile-boot/app-boot，webpackIgnore 原生 import）→ `runProfile`（profile dshana、显式端口、`--no-open`）→ **就绪门**（webServer 服务端口 === 期望端口 且 HTTP 探测成功）→ stdout 打 `readyMarker`（唯一出口；失败路径绝不打印 READY）→ SIGTERM/SIGINT/父断连有序释放（关 DSH fiber → 再 `hana.close()`；拿到流式响应不能立刻 close，本步未接流）。退出码契约：2=usage/3=IPC 不可用/4=deps/5=seed/6=boot/7=port。
- App 侧封装 `src/lib/managed-runtime.js`：`ensureManagedRuntime()`（单例 single-flight：**一个 App runtime 服务多个 DSH 会话**，首次 create 触发启动——设计见模块头注释与 tools/session.js 接线桩）解析 servicePort（manifest `servicePort` 设置，默认 4317）→ `ctx.runtime.start({ runtime:"node", entry:"runtime/dsh-host.mjs", profile:"native", network:"external", service:{ port, readyMarker:"DSH_READY" }, writeRoots/readRoots:[dataDir], args })` → `ctx.runtime.get` 轮询到 ready（不能把 runtimeId 当就绪）→ 失败归类（`err.code`：port-busy/deps/seed/boot-failed/not-authorized/timeout/unknown，message 带用户指引）+ runtime watch 日志尽力镜像（src=dsht 进 App 会话日志）；`disposeManagedRuntime()`/`stopManagedRuntime()`（App 卸载/更新前停 runtime，Windows .node 锁纪律）；`parseServicePort`/`buildRuntimeArgs`/`classifyRuntimeFailure` 纯函数可单测。
- `src/tools/session.js`：create/send/cancel/approve 的「未接线」错误保留，分支前补步骤 3 接线桩注释（ensureManagedRuntime 调用形态 + taskId/映射/取消链落点）；list/get 仍离线可读。`src/index.js` disposer 接 disposeManagedRuntime。
- manifest 增 `contributes.settings.servicePort`（integer，默认 4317，显式端口契约禁 0）；`src/build.js` 增 runtime bundle 编译（先主 bundle 清 dist，再追加 runtime/，再做 URL 回写/terser/断言）。
- 单测 `tests/*.test.mjs`（node --test）：child options parse、managed-runtime 端口/参数/错误归类、ensure-deps 声明/版本/marker 纯函数。本地验证：`node src/build.js` 通过；`node dist/runtime/dsh-host.mjs` 直跑给出清晰报错（无父 IPC / 缺参）。真机 AppHost 启动验证待装包后做（见交付物注释「已测/未测边界」）。

**依赖部署（v2）（决策，步骤 2 落定——「随包 vs dataDir 安装区 vs 混合」）**

- **结论：dataDir 安装区（`<dataDir>/runtime/`，首启 pnpm 安装）+ 版本随包声明，无独立 DSH 升级通道（升级 dsh = App 发版，与 v1「声明单一事实源」语义一致）。**
- 依据：① App installDir（宿主 `<HANA_HOME>/apps/<appId>`）只读（实测：App 进程 fs-write 白名单只有 dataDir），v1「pnpm install --prod 进插件根 node_modules」物理不可行；② 一份 App 产物要跨 Windows/macOS/Linux，native 产物（node-pty/koffi/sharp 等）按平台/ABI 由 pnpm 在目标机解析，随包单份 ZIP 无法同时携带三平台 addon（逐平台打包破坏单产物约束）；③ 实测体量：`node_modules` 全量 312MB（含构建 devDeps）、`@deepseek-ai` 闭包 ~25MB、含非 scope 运行时依赖整体 ~100-200MB——进 App ZIP 不现实。
- 布局（固定路径 + 覆盖，无版本目录；`ensure-deps.js`）：`app-data/dsh-hanako/runtime/{package.json, pnpm-workspace.yaml, pnpm-lock.yaml}`（installDir 三件套覆盖，随 App 发版）→ `node_modules/`（pnpm install --prod --frozen-lockfile 产物，depsRoot 默认指向）→ `.runtime-ok`（幂等标记 {manifest:{dsh,cordis},at}，声明版本变化即重装）。pnpm 引导复用 v1 `src/lib/pnpm.js`（单文件 pnpm.mjs 下载 + sha512 + worker，缓存 dataDir/pnpm-dist）；node 代理（runtime/node.cmd → process.execPath）+ PATH 前缀让 koffi/node-pty install script 找到解释器（v1 T7d 同款）。
- 解析：`dsh-host.mjs` 经显式路径定位 depsRoot（`ensure-deps.js`/`locate.js`，与 v1 loadInprocDsh 同款 createRequire + .pnpm 枚举 + webpackIgnore 原生 import）；profile boot 的模块回退 farm（dsh-app-boot `healProfilesModuleFallback`，把 dsh 安装闭包镜像成 `$DSH_HOME/profiles/node_modules` 链接）自动覆盖官方插件树解析；`@dsh-hanako/*`（cordis 产物随包 installDir `cordis/`，只读可读）经 profile `node_modules/@dsh-hanako` scope 链接（junction 指向只读目录可读；App 更新换目录后漂移由种子化自愈重建，失败回退整体拷贝）。
- Windows native 文件锁与停止更新约束（指南 §4）：依赖变更重装前必须先停占用 .node 的 DSH 进程/worker/终端——受管形态下 DSH 只跑在单例 runtime（App 可控 stop），ensure 发生在「旧 runtime 已停/未起」的启动前窗口；App 卸载/更新/停止统一先 `ctx.runtime.stop`。随包方案更新会整体替换 installDir（同样受锁约束且 ZIP 重），故未采用。
- 已测/未测边界：版本比对/marker/拷贝三件套/参数构造已单测；pnpm 网络安装路径（首次真实 AppHost 运行）未在本刀本地跑通（无网络），代码路径与 v1 同源（pnpm.js），真机装包后由主上下文验证。


**已落地（步骤 3：provider adapter 重写（DSH 推理走 hana.models）+ create/send 任务回投与工具循环）：**

- **manifest 增顶层 network 声明**（决策 A）：{ allowedHosts:["127.0.0.1"], methods:["GET","POST"], allowLocalhost:true, defaultTimeoutMs:60000, maxResponseBytes:8388608 }——App 进程（Node Permission Model，无 --allow-net，唯一出网面 = ctx.network.fetch 宿主门）到受管 runtime DSH web 服务的 loopback RPC 通道。v2 manifest 校验只认 allowedHosts/allowLocalhost/methods/defaultTimeoutMs/maxResponseBytes 五键（别名 hosts 会被拒）；127.0.0.1 属私网且 http 非 https，缺 allowLocalhost:true 必被拒（核对记录，见 src/lib/managed-runtime.js 头注释与 manifest 注释）。
- **决策 A（App → 受管 runtime 指令通道）= runtime service loopback HTTP RPC，复用 v1 信封/翻译器协议**（src/lib/rpc-envelope.js 纯函数：client-request 信封 + session.* 的 request/_request 包装 + requestId 注入；DSH 网关校验 body.method === 端点路径段（斜杠形态，official rpc-host 与 @dsh-hanako/bridge 同款）；响应 rpcId 回显 + result.ok）。**不用** 宿主 /api/apps/<appId>/routes/_runtime/<runtimeId>/ 代理：那是浏览器 surface（HttpOnly cookie + surface 授权 + WS upgrade）的 UI 通道（步骤 4/5 用），App 进程无 cookie 会话面且受管 runtime 无 getService 之类 App 门（hostCall 白名单只有 tasks/models/network）。App 侧 fetch 经 ctx.network.fetch（唯一出网面，宿主代执行），服务端 = 子进程 DSH web /api 原生端点（零新增 server 面）。
- **决策 B（provider adapter 分界）**：模型推理在受管子进程内经 connectAppRuntime().models 发起；requestId 由 adapter 自管（models.cancel(requestId) 定向）；taskId 从会话→任务映射解析（宿主 scope 校验，taskId 属主）。provider/model 显式选择：目录 = hana.models.list() 投影，provider/model id 原样透传（宿主逐条 n.provider===provider && n.id===model 匹配），不做二次命名。@dsh-hanako/provider 插件 v2 重写为自实现 LlmAdapter（dsh-llm 动态 import，同 v1 profiles 基座解析）：listModels/resolveModel 读目录快照；stream() 把 DSH Message 转换（user/assistant/toolResult + 回放签名，lib/messages.js）→ hana.models.stream({requestId, taskId, provider, model, messages, systemPrompt, tools, reasoningEffort?, maxTokens?, temperature?}) → NDJSON 逐行解析（跨 chunk 半行余量，lib/ndjson.js）→ 事件处理（start/text-delta/reasoning-delta/tool-call/done/error）；error = 失败不算成功；done.assistant 完整保存回放（textSignature/signature/thoughtSignature 续接签名进 ReplayEnvelope{kind:hana}，DSH assistant source.replayState）并原样产块（block-start/delta/block-end/usage/finish，工具 arguments 为 JSON 字符串）；流未以 done 结束 → STREAM_CLOSED；图片 base64+MIME（attachment store readImageRequest，不传路径/URL；store 缺失报 UNSUPPORTED_CONTENT）。DSH 自己的工具循环不变（Hana 不执行传入 tools schema，仅声明）；工具执行后 role:toolResult + toolCallId/toolName/content/isError 放回 messages（lib/messages.js 拆分）。hana client 句柄 = globalThis.__dshanaHana（dsh-host.mjs connectAppRuntime 后、runProfile 前设置，与子插件同进程共享；释放顺序：停 task-bridge → ctx dispose → 清句柄 → hana.close，main.js 实现）。
- **create/send 业务链**（src/lib/session-run.js submitDshTask → tools/session.js）：execute（含宿主 context.callToken）→ ctx.tasks.create({callToken, label, metadata})（callToken 只此一次消费，不落盘不落日志）→ ensureManagedRuntime({taskId})（未起则启动到 ready，失败归类 err.code 并 fail(taskId)）→ 会话建立（create=session.create{cwd, agentPreset?}；send=session.list 查持久会话（带 cwd）则 session.create resume，活跃 Map 会话直接 prompt，list 不含=不存在由 prompt admission 报 session/not-found）→ 显式 provider/model/effort 才 session/selectModel（model-unavailable 降级不带 effort 重试）→ 写 task-map（先于 prompt）→ session.prompt fire（mode:queue, content:[{type:text}], requestId=rpcId）。返回 { promise, ready }：ready 在 prompt accepted 后 resolve 定位键 {action, sessionId, rpcId, taskId, cwd}（execute 随即返回，v1 语义不变）；promise 后台等 Hana task 终态（child task-bridge complete/fail → 宿主 deferred:resolve/fail 投递来源会话）并释放同会话串行化锁。
- **task-bridge（受管 runtime 内，src/runtime/task-bridge.js）**：DSH boot 就绪后、readyMarker 前挂载，ctx.on 订阅 api-session/status|error|activity + session/event（进程内直订——turn 生命周期不经 $events）；按 <dataDir>/dshana/taskmaps/<sessionId>.json（App 写、sessionId 即文件名天然隔离多会话，决策 C/D）把事件回投：running 进度 ctx.tasks.update、终态 complete(taskId, minimal 定位结果)/fail(taskId, message)。终态判定语义与 v1 run.js consume 对齐：api-session/status false / session/event turn/end（reason.kind=error → 失败；completed → 成功，pendingFailure 兜底判失败）；先到先收、幂等、终态后删映射。
- **决策 C（映射持久化）**：taskId↔dshSessionId↔rpcId 映射落 dataDir 文件（src/lib/task-map.js，原子写 + TTL prune；子进程 task-bridge/provider 只经 connectAppRuntime 拿 tasks/models/network.fetch，读不到 App ctx.storage——跨进程关联必须落在两者共享可读处，runtime writeRoots 含 dataDir）。不复刻 ctx.storage.agent 镜像副本（512KB/16MB 上限与双写漂移风险）；App 侧跨重启检索任务/会话关系待步骤 4 按需补索引。64KiB 任务 JSON 限制由宿主门强制——metadata/result 只放小定位键。callToken 不落盘不落日志（指南 §5 硬约束，task-map 结构即证明）。
- **决策 D（并发纪律）**：同 DSH session 的 create/send 由 App 进程内串行化（src/lib/session-serialize.js，与 v1 withSessionTurn 同语义；锁持有到任务终态——否则同一 session 两个任务会互吃对方的终态事件/映射）；不同 session 互不共享「当前任务」（task-map 按 sessionId 分文件）；一个 runtime 服务多会话时各请求自带 taskId（models.stream.taskId、task 记录 taskId、prompt 信封 rpcId 作 jsonl data.source.rpcId 关联键）。
- **工具接线**：tools/session.js create/send 分支接 submitDshTask（返回语义与 v1 一致：fire 即回、终态投递来源会话、内容 action=get）；cancel/approve 保留步骤 4 明确「未接线」错误（含使用指引）。list/get 离线读不变（projcache + jsonl zstd）。
- manifest servicePort 下限随宿主 runtime service 端口契约收紧到 1024..65535（managed-runtime.js parseServicePort 同步；tests 更新）。
- 单测新增（node --test 全绿 62 例）：rpc-envelope（信封/网关 method 斜杠/requestId 注入）、task-map（路径/读写删/TTL/不落 callToken）、session-serialize（同会话串行/跨会话并行/槽位）、provider-ndjson（跨 chunk 半行/flush/坏行）、provider-catalog（routes/efforts/元数据）、provider-messages（assistant 签名/tool-result 拆分/图片/UNSUPPORTED_CONTENT）、provider-stream（done→chunks/回放信封/EMPTY_RESPONSE/max-tokens）、task-bridge（事件归类）。构建：node src/build.js 与 node src-cordis/build.js 通过（dist 内含 taskmaps/task-bridge/__dshanaHana 标记）。
- 已测/未测边界（步骤 3）：真机 AppHost 实跑 create/send 模型流未在本刀跑通（无宿主环境/网络），装包后由主上下文验收：① tasks 生命周期与结果投递；② task-bridge 终态对账；③ provider adapter 被 DSH agent 循环调用的消息/块序与跨 turn done.assistant 回放；④ 同会话两次 send 串行；⑤ DSH 图片附件 base64 路径；⑥ 两会话并发（宿主模型流并发上限 2）；⑦ runtime 中途重启后 send 的 resume 路径；⑧ 执行超时/取消（依赖步骤 4 session.cancel）。本步模型流不逐块实时打字（done 时一次性产块，功能等价；DSH Web UI 实时性属步骤 4/5 面）。

**遗留（步骤 4+ 收口）：**

- 步骤 4 本体（本刀 4a 已落地核心，见下方「步骤 4a 架构决策」）：审批/取消/执行超时/watch SSE 对账全链代码与单测已合入；剩真机 AppHost 验收（宿主审批通知形态、watch SSE 实测对账、宿主取消 UI 路径、DSH 超窗升级路径）与重启恢复（App 进程重启后 in-process 队列/后台 watcher 重建 + task-map 残留判定——仍属后续刀）。
- 步骤 4/5：ctx.routes.register + UI/cards/ui/ 静态树（受管服务代理前缀 /api/apps/<appId>/routes/_runtime/<runtimeId>/）、activation on-demand、syncver 联动 cordis 包版本、pack.mjs 的 cordis 版本断言适配 v2 版本域、旧插件数据迁移脚本、@dsh-hanako/{bus,bridge,acp-assist,view,app,settings,theme,clipboard} 子插件在 v2 形态的退役/收敛判断（本刀只重写 provider；其余 apply 容错降级为惰性，随 UI 刀逐刀收口）。
## 步骤 4a 架构决策（approve / cancel / 执行超时 / watch SSE 消费侧）

本刀合入内容对应迁移指南 §5（每 send 新 task、串行化）、§8（models.cancel(requestId)）、
§9（审批与取消全文）在 v2 接线中的逐条落点与决策。**已测/未测边界在下方单列**；以下
决策是「当前实现按宿主 0.930.1 d.ts 契约写、真实宿主形态待装包对账」的依据。

- **决策 E（取消链分侧与顺序 = App 发起 RPC、DSH 真中止后宿主才 canceled）**：
  App 主进程（tools/session.js cancel / session-run 超时看门狗）经 loopback HTTP RPC 直调
  DSH web /api/session/cancel（lib/dsh-rpc.js rpcSessionCancel + rpc-envelope 复用——与
  create/send 同一条指令面），并先写映射 cancel 标记（markCancelRequested）。受管 runtime
  task-bridge 在 DSH turn/end(aborted)（或自然终态但已有 cancel 标记，v1 cancelledRequested
  同款语义）时把宿主任务结算成 hana.tasks.cancel——**canceled 只在 DSH 真中止后标记**
  （指南 §9 第 4 步：不能宿主标 canceled 而 DSH 还在跑）。宿主侧取消反向触发（Hana task
  canceled/aborted，来源会话停止按钮等）= task-bridge 对 running 任务经 hana.tasks.watch
  (taskId) SSE 观察，取消到达 → 本进程 DSH session.cancel + cancelSessionModelRequests
  （只停本会话 requestId；单例 runtime 不误停他人会话）。取消确认窗口（App 侧
  CANCEL_CONFIRM_MS=15s 轮询 tasks.get）超窗未确认 → 升级 ctx.tasks.cancel 兜底并如实
  告知（残余风险：DSH 进程若真未响应，宿主已 canceled——写入本刀真机边界验收项）。
- **决策 F（watch SSE 消费侧 = 受管 runtime 子进程）**：需要「宿主审批 outcome → DSH
  approval/request 等待者」与「宿主 task 取消 → DSH session.cancel」的都是 runtime 内模块
  （approval-bridge / task-bridge）；App 主进程不消费 SSE（应答走 ctx.tasks.respondApproval
  的返回值即权威，取消终态用轮询 tasks.get）。故 watch-SSE 解析/对账（lib/watch-sse.js）
  打进受管 runtime bundle（src/runtime → ../lib 同图内联），消费处只有子进程。SSE 与
  NDJSON 分开解析（指南 §9）：models.stream 是逐行 NDJSON（provider lib/ndjson.js）；
  watch 是 event:/data: 多行块（createSseDecoder），snapshot 首条 + app-task 后续 + reset
  （缓冲溢出）与断线都要先 get() 对账（runWatchReconcile）。
- **决策 G（审批分侧 = runtime 创建与等待、App 应答）**：DSH 审批请求（sandbox 升级
  approval/policy=ask）→ ApprovalService 走 ctx.waterfall(scopeTarget(agent),
  'approval/request')——approval-bridge 以 ctx.on('approval/request', …, { global: true,
  prepend: true }) 认领（v1 实证：无 scope ctx.on 因 context filter 收不到 agent-scope
  瀑布事件）。有 task-map（dsh_session 发起的会话）→ hana.tasks.requestApproval({taskId,
  label, details:{dshSessionId,rpcId,toolName,callId,reason,args}, timeoutMs})（以父 taskId
  为范围，不需 callToken；timeoutMs 快照经映射下传，0=宿主不自动拒绝）→ 映射文件记
  approvals 条目（App approve 校验归属/去重）→ 挂起 ApprovalOutcome 承诺 watch(approvalId)
  等终态：allowed-once/rejected 原样投给该 approvalId 的 DSH 等待者（承诺闭包天然定向，
  不广播）；终态无 outcome（父任务结束/撤销/审批超时）→ rejected（fail closed，绝不隐式
  放行；指南 §9）。App 侧 dsh_session(action=approve) = approve-respond.js 校验 task-map
  approvals 表（属于该会话且 pending）→ ctx.tasks.respondApproval({approvalId,outcome}) →
  runtime watch 观察 outcome 投递给 DSH。DSH 请求侧 abort（回合取消）→ 宿主审批收尾应答
  rejected（不留孤儿）+ resolve 'cancelled'（取消绝不当授权）。审批等待不计入执行超时：
  超时 cancel 链会让 req.signal 中止走此路径；宿主审批由 timeoutMs 独立自动拒绝。
- **决策 H（task-map 扩展为工作单元协调文件）**：同 session 单 JSON（既有决策 C/D 键）上
  追加 timeoutSec/approvalTimeoutMs（提交快照，跨进程下传 App settings）、cancel{at,reason}
  （取消标记）、approvals[]（审批条目）——读-改-写全原子（updateTaskMap/patchTaskMap/
  addApproval/settleApproval/markCancelRequested）。DSH 侧事件单飞 + App 同会话串行化
  使同文件并发写窗口极小；损坏/缺失一律 null 容错。callToken 依旧绝不落盘。
- **决策 I（执行超时 = 走 cancel 链，不是只 fail task）**：session-run 提交后台
  waitTaskTerminalWithTimeout：timeoutSec（显式参数或 App defaultTimeoutSec，manifest 默认
  1800/非法回落 600）超时 → cancelSessionWork(reason='timeout')（标记 + session.cancel +
  确认窗口）→ DSH 真中止后宿主 canceled。审批等待期间不触发（DSH turn 未结束 + 宿主审批
  timeoutMs 独立拒绝；DSH 回合中止经由 abort 信号路径）。
- **决策 J（活动模型 requestId 注册表 = globalThis，跨 bundle 共享）**：provider adapter
  流开始把 requestId 记入 globalThis.__dshanaActiveModelRequests（Map<sessionId,Set>），
  流收尾注销；task-bridge 取消时按会话定向 hana.models.cancel（lib/model-requests.js 只读
  消费）。provider（cordis bundle）与 task-bridge（dsh-host bundle）不能互相 import——
  globalThis 约定（与 __dshanaHana 同款），键名两侧字面一致。

**步骤 4a 已落地清单：**

- src/lib/task-map.js：approvals/cancel/timeout 快照 + 原子读改写（步骤 4a 扩展）。
- src/lib/watch-sse.js：SSE 解码/帧解释（snapshot/app-task/reset/结构兜底）、终态判定、
  审批 outcome 映射（fail-closed）、runWatchReconcile（先 get 对账、reset/断线重连退避）。
- src/lib/dsh-rpc.js / service-base.js：注入式 /api RPC（App ctx.network.fetch 与 runtime
  Node fetch 共用）；rpcSessionCancel + cancelAccepted。
- src/lib/cancel-chain.js：cancel 编排（planCancel/executeCancel/awaitCancelTerminal/
  cancelSessionWork）、任务/审批超时解析（App settings 注入）；session-run 的 rpcCall 收敛
  到 dsh-rpc，serviceBase 拆叶子模块（防环）。
- src/lib/approve-respond.js：dsh_session approve 应答（归属校验 + respondApproval + 回填）。
- src/lib/model-requests.js：活动 requestId 注册表消费侧（运行时 bundle）。
- src/runtime/approval-bridge.js：DSH approval/request global+prepend 认领 → requestApproval
  → 映射记录 → watch(approvalId) 对账 → outcome 只投正确等待者；tool-call 缓存供 args
  证据；signal abort → 宿主 rejected 收尾 + DSH 'cancelled'。
- src/runtime/task-bridge.js：cancel 标记结算（DSH 中止后 canceled）；宿主任务 watch 反向
  cancel（session.cancel + 定向 models.cancel，只本会话）；settle 幂等。
- src/runtime/main.js：挂 approval-bridge；task-bridge 传 serviceBaseUrl；shutdown 停两桥。
- src-cordis/plugins/provider/index.js：活动模型流注册/注销（globalThis 注册表）。
- src/tools/session.js：cancel/approve 分支接线（移「未接线」）；manifest description 更新。
- 单测新增 21 例（watch-sse 9 / task-map-ext 4 / cancel-chain 3 / approval-bridge 5）+
  src-cordis provider 注册表不新增测试面（纯注册）。既有 104 例 + 新增 21 例 = 125 全绿；
  node src/build.js 与 node src-cordis/build.js 通过（dist 内含 approval-bridge/requestApproval/
  cancel 链标记）。

**真机/后续验收边界（本刀代码侧未跑通宿主，装包后由主上下文验收）：**

1. 宿主审批通知形态：requestApproval 创建后来源会话如何收到「待审批」通知（文案/审批 UI/
   卡片），dsh_session(action=approve) 是否被模型正确选用——approve 分支无本地依赖，纯
   应答宿主；通知形态属宿主侧。
2. watch SSE 实测对账：host watch(taskId/approvalId) 的事件名/载荷是否确为 snapshot/
   app-task/reset（按指南措辞实现 + 结构兜底）；get(approvalId) 与 get(taskId) 是否都受理。
3. 宿主取消 UI（来源会话停止按钮）路径端到端：host task canceled → runtime watch 反向
   session.cancel → DSH turn/end aborted → 宿主 canceled，两会话并发不串扰。
4. 取消确认窗口超窗升级（CANCEL_CONFIRM_MS=15s）的实测触发面与文案。
5. 审批 timeoutMs 自动拒绝是否即时进入 watch 流（host 行为）；超时后 approve 应答的宿主
   报错文案形态。
6. 执行超时走 cancel 链端到端（DSH agent 正在跑工具/长推理时被 session.cancel 中止），
   超时后任务终态 = canceled 且内容不误标成功。
7. DSH Web UI 直开会话的审批（无 task-map → next() 委托 → 无应答者 fail-closed）与 DSH
   自身 approval/policy 语义核对。
8. 重启恢复（App 重启后 in-process 队列重建）仍属后续刀（本刀未动 apply 进程内协调态）。



