# DSHana 设计

插件 id：`dsh-hanako`。把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）接进 Hana。

## 架构总览（受管 runtime）

```text
Hana 宿主进程（App 隔离进程内加载 dist/index.js）
  ├─ App 侧：apply(ctx)
  │    ├─ ctx.tools.register(dshana_session)         工具（六 action）
  │    ├─ ctx.routes.register(/dshana/*)             壳页/诊断面（boot-state|health|start|stop）
  │    └─ ctx.runtime.start({ runtime:"node", entry:"runtime/dsh-host.mjs",
  │           cwd:ctx.dataDir, service:{ port:<随机>, readyMarker:"..." } })
  │              ↓ 受管 Node 子进程
  ├─ runtime/dsh-host.mjs（dist/runtime，rspack 产物）
  │    └─ 原生 import 安装目录 node_modules/@deepseek-ai/dsh/lib/profile-boot-*.js
  │         → runProfile() → cordis Context
  │              → 加载 $DSH_HOME/profiles/dshana（junction → 安装目录 cordis/）
  │                   → dsh-* 官方插件 + @dsh-hanako/* 子插件
  │         → HTTP 服务监听本地端口（宿主按 readyMarker 判定就绪）
  └─ 浏览器面：/api/apps/dsh-hanako/routes/_runtime/<runtimeId>/ 由宿主自动代理
```

- **受管 runtime**：DSH 跑在 `ctx.runtime.start` 拉起的独立 Node 子进程中（不再是宿主进程内 boot）。App 侧与子进程分责：App 管启动/停止/状态，子进程管 DSH 的 cordis 生命周期；崩溃可被父侧识别并重起。
- **依赖形态（自包含打包）**：DSH 及其依赖树由 `scripts/pack.mjs` 在构建时物化进**安装目录** `node_modules`，运行时**不再安装、不再 spawn pnpm**（v1 的 `ensure-deps` / `lib/pnpm.js` / `lib/bootstrap.js` / `lib/errclass.js` 已删除）。版本单一事实源 = 包内依赖树。
- **更新 = 装新 App 包 + 重启宿主**：无独立升级通道；升级后需重启宿主以清掉旧模块缓存。
- **连接与鉴权交回官方**：`@dsh-hanako/bridge` 已退役；`dsh-web-app` 层的官方 connection（BrowserAuth token/cookie）与 frontend-static 各自负责其位，App 侧只经 runtime 中继补 cookie。
- **DSH Web UI**：DSH 前端以**同文档注入**方式挂进壳页（`dsh-inject.js`：取 index → 搬 link/script → 装配 `__DSH_TRANSPORT__` + 流 mux），不再用 iframe 内嵌；到 runtime 的请求走宿主代理前缀 + 路径票据。

## 工具

宿主 Agent 工具面为**单工具 `dshana_session`**（源码 `tools/session.js` 分派壳 + `tools/subtool/query.js` 只读查询 + `lib/session-run.js` 提交链 + `lib/cancel-chain.js` / `lib/approve-respond.js` 编排）。**完整调用手册见 [dsh-session](src/skills/dsh-session/SKILL.md)**：

| action | 用途 | 实现 |
| --- | --- | --- |
| `create` / `send` | 新建会话+提交 / 续已有会话（task+cwd 必填，resume 语义） | `lib/session-run.js` |
| `list` / `get` | 会话清单 / 凭 sessionId 取内容（projcache + jsonl zstd 本地读） | `tools/subtool/query.js` |
| `cancel` | 取消任务（sessionId 必填） | `lib/cancel-chain.js` |
| `approve` | 应答会话挂起审批（allowed-once/rejected，决策看 args） | `lib/approve-respond.js` |

提交链路：`ctx.tasks.create` → 受管 runtime 就绪 → `session.create` →（显式传 provider/model/effort 时才 `selectModel`）→ 写会话↔任务映射（`<dataDir>/dshana/taskmaps/`）→ `session.prompt`（queue）→ runtime task-bridge 按映射回投任务状态与终态。

## DSH Web UI（DSHana 卡）

DSHana 以**单卡 + 自带功能面板**注册（manifest `contributes.cards[0]`：卡 id `dshana`、route `/main.html`、`functionPanel.route` = `/sidebar.html`；`siteNavEntry` 为本项目有意保留的形态差异）：

- **自举台**：DSHANA 字标 + 细圆环 + 一行状态小字；报错时下方直接一块 `<pre>`（时间线/折叠详情已撤）。boot-state 由**主卡单独轮询**，FP 只读跨面共享快照（订阅，不重复取）；owner 不在场（快照不存在/下线/过旧）时 FP 才自取。
- **三态 + 设置页**：default（full / detached 共用一页 = 整幅 DSH UI，顶部 44px 让位宿主 chrome）/ main（主卡，无 DSH 侧栏——侧栏归 FP）/ sidebar（FP，只有侧栏）；settings 是 App 自己的设置页（`ui.route`，不注入 DSH）。面由**页面静态声明**（`<meta name="hana-dshana-role">` + `data-dshana-view`）；映射到 DSH 侧上游角色词：default→standalone / sidebar→navigation / main→workspace。`?dshana-view=` 与 `@dsh-hanako/view` 均已退役。
- **注入鉴权**：壳页以 `appSurfaceSession` 作为 `_surface` 路径段取得运行时代理凭据（同源预请求种 `hana_app_runtime` cookie 兜住子请求）；未取得票据时不下挂内容，面板上说明原因。

### 设置面

- **DSH 内设置**：`agent-default-model`（默认模型，Provider/模型/思考强度三级联动）与 DSH 版本显示，由 `@dsh-hanako/settings` 子插件在 DSH 设置页的分页承载。
- **App 级设置**（数据源、两个超时）：迁到 App 自绘设置页，由宿主设置区渲染（`contributes.settings.ui.route`），不依赖 DSH 运行。见 `specs/current/sample-align`。

## 主题跟随

`@dsh-hanako/theme` 经 `tapIndex` 注入 index 响应：静态 fallback + 动态桥脚本，向壳页索取宿主主题 vars → 写 body 层 `!important` 覆盖 `--dsw-alias-*` / `--dsw-specific-*`。

**跟随语义（有意自持）**：仅当 DSH 主题偏好为 `system` 时跟随宿主配色；显式 `light`/`dark` 时完全用 DSH 自己的主题，宿主配色不介入。偏好变更经事件驱动重读（不再周期轮询）。此语义与官方样例的「无条件双 palette 替换」不同，是保留项。

## 启动与状态

- **启动触发**：App `apply` 完成后经微任务触发一次 `ensureManagedRuntime`（single-flight，不占 apply 同步栈——宿主对 apply 有 60s bootstrap 超时）；`dshana_session` 首调与 `POST /dshana/start` 是可重入的兜底入口。
- **就绪判定**：宿主 `ctx.runtime.get(runtimeId).state === "ready"`，配合子进程末行 `readyMarker`。
- **失败面**：`managed-runtime.js` 的 `START_ERROR_HINTS` 按 code（port-busy / port-unreachable / boot-failed / deps / seed / not-authorized）给中文指引，壳页 action 态展示。

## 已知限制

- **升级 DSH = 装新 App 包 + 重启宿主**：宿主进程内的模块缓存无法从插件侧豁免。
- **bash 工具在 Windows 上可能 `E_ACCESSDENIED`**（dsh-bash-sandbox 的环境限制）。文件系统工具正常，Windows 上优先用文件系统工具。
- **主题仅在 DSH 偏好为 system 时跟随宿主**（见上，有意为之）。
- 越界权限请求默认走审批：deferred 通知 → `dshana_session(action="approve")` 应答；无人应答按 `approvalTimeoutSec` 自动拒绝。

## App v2 迁移状态（feat/app-v2-migration，接口基线 Hana 0.930.1）

本分支把 DSHana 从「v1 宿主插件（宿主进程内 boot DSH）」迁移为「Hana App v2（隔离 App 进程 + `apply(ctx)`）」，执行顺序见 `specs/DSHana迁移到HanaAppV2.md` §13。以上各节描述的是 v1 架构（进程内 boot / 总线 / 卡片），随迁移逐刀更新。

**已落地（步骤 1：manifest / apply 入口 / 设置 / 工具注册，验证 list/get）：**

- `src/manifest.json` 改为 App v2 契约：`version 1.0.0-beta.5`、`entry index.js`、`icon assets/icon.png`、`minAppVersion 0.930.1`、capabilities 取指南 §3 七项（`app/tools.expose-to-model`、`app/tasks.manage`、`app/session.start-turn`、`app/models.infer`、`app/runtime.execute`、`app/runtime.local-machine`、`app/runtime.network`）。v1 专属/过时字段移除：`author`、`trust`、`activationEvents`（v2 无）、`ui.hostCapabilities`、`contributes.cards`（UI 迁移步骤回归）、`contributes.configuration → contributes.settings`、`network` 白名单（步骤 1 无 App 级 fetch；DSH 外网走受管 runtime 自身网络）。
- `src/index.js`：`class + onload()` → `export apply(ctx)`（兼导出 `default { apply }`）；apply 注册完即返回。统一日志只走宿主 `ctx.logger`（App 侧文件日志与 runtime watch 镜像已退役，见 spec §8 j）；globalThis 宿主单例退役 → `src/lib/app-runtime.js` module-scope 运行包。
- 工具注册：`ctx.tools.register`，工具名保留 `dshana_session`（v2 无自动 `pluginId_` 前缀、全局唯一；决策与冲突面见 `src/tools/session.js` 头注释）。action 参数与返回语义不变；本步骤仅 `list`/`get` 可用（DSH 未启动仍离线可读），`create`/`send`/`cancel`/`approve` 返回明确「待迁移步骤 2 接线」错误。
- 设置：`contributes.settings`（approvalTimeoutSec / defaultTimeoutSec），工具执行期经 `ctx.config.get`（apply 完成后才登记，apply 顶层不读）。原先的 nodejsPath 与 servicePort 已随 T5 裁撤（无消费方 / 端口不再暴露）。
- 数据读路径迁到 `ctx.dataDir`（宿主 `app-data/<id>/`）：list/get 读当前源的 `<DSH_HOME>/...`（projcache + jsonl zstd）；旧插件数据迁移只留接缝（`lib/app-runtime.js appDataDir` 注释），本步骤不做迁移脚本。
- 构建：`node src/build.js` 产物 `dist/` = App 安装目录形态（根 `manifest.json` + `index.js` + `assets/icon.png` + `skills/`）；v1 的 `dist/routes/` 壳不再生成。

**已落地（步骤 2：DSH 迁入 App 受管 Node runtime，local-machine/external + readyMarker 就绪门）：**

- 受管 runtime 入口 `runtime/dsh-host.mjs`（源码 `src/runtime/`，rspack → `dist/runtime/dsh-host.mjs`，见 `src/runtime/rspack.config.mjs`）：App 自有配置解析（唯一 argv = 私有运行时配置文件路径，schema 见 `src/runtime/options.js`，与 `src/lib/managed-runtime.js buildRuntimeConfig()` 对偶）→ `connectAppRuntime()`（无父 IPC fd → 可操作报错 + 退出码 3，不假装能跑）→ 进程级 env（`DSH_HOME=<dataDir>/.dsh`、`DSHANA_ROOT=<dataDir>/runtime`、`DSHANA_HOME=<dataDir>`，不改宿主进程环境）→ 依赖 ensure → profile 种子化（`initProfile` + `node_modules/@dsh-hanako` scope 链接 → installDir `cordis/`，junction/拷贝回退）→ 动态定位 DSH（`locate.js`，profile-boot/app-boot，webpackIgnore 原生 import）→ `runProfile`（profile dshana、配置中的 dshPort、`--no-open`）→ **就绪门**（webServer 服务端口 === 期望端口 且 HTTP 探测成功）→ stdout 打 `readyMarker`（唯一出口；失败路径绝不打印 READY）→ SIGTERM/SIGINT/父断连有序释放（关 DSH fiber → 再 `hana.close()`；拿到流式响应不能立刻 close，本步未接流）。退出码契约：2=usage/3=IPC 不可用/4=deps/5=seed/6=boot/7=port。
- App 侧封装 `src/lib/managed-runtime.js`：`ensureManagedRuntime()`（单例 single-flight：**一个 App runtime 服务多个 DSH 会话**，首次 create 触发启动——设计见模块头注释与 tools/session.js 接线桩）父进程随机选取中继端口与 DSH 内部端口（区间 38000..52000，见 `choosePort`/`pickPorts`；宿主 service 端口契约只收确定整数，故不能交给宿主分配）→ `ctx.runtime.start({ runtime:"node", entry:"runtime/dsh-host.mjs", profile:"local-machine", network:"external", cwd:dataDir, service:{ port:中继端口, readyMarker:带随机 opaque }, args:[私有配置文件路径] })`（契约禁止 readRoots/writeRoots/callToken/taskId，故一律不带） → `ctx.runtime.get` 轮询到 ready（不能把 runtimeId 当就绪；端口占用 port-busy 自动换随机端口重试，上限 3 次）→ 失败归类（`err.code`：port-busy/deps/seed/boot-failed/not-authorized/timeout/unknown，message 带用户指引）+ runtime watch 日志尽力镜像（src=dsht 进 App 会话日志）；每次命中 ready 缓存先经 runtime.get 探活，子进程崩溃/被宿主回收则清单例并重起；失败路径把端口与两把 key 归零（`bridgeAccess()` 不再放出死端口）；`disposeManagedRuntime()`/`stopManagedRuntime()`（App 卸载/更新前停 runtime，Windows .node 锁纪律）；`choosePort`/`pickPorts`/`makeReadyMarker`/`classifyRuntimeFailure` 纯函数可单测。
- `src/tools/session.js`：create/send/cancel/approve 的「未接线」错误保留，分支前补步骤 3 接线桩注释（ensureManagedRuntime 调用形态 + taskId/映射/取消链落点）；list/get 仍离线可读。`src/index.js` disposer 接 disposeManagedRuntime。
- `src/build.js` 增 runtime bundle 编译（先主 bundle 清 dist，再追加 runtime/，再做 URL 回写/terser/断言）。
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
- **决策 B（provider adapter 分界）**：模型推理在受管子进程内经 connectAppRuntime().models 发起；requestId 由 adapter 自管（models.cancel(requestId) 定向）；身份二选一（《DSHana 调用 Hana 模型接口指南》§3/§5，src-cordis/plugins/provider/lib/identity.js）：有会话→任务映射（dshana_session 委派、任务仍活动）传 taskId（宿主校验属主），没有映射（DSH Web UI 自建会话，或委派任务终结后用户继续在 Web UI 里跑）则 callToken/taskId 都不传 = 归属 App 自己；stream 不接受 scope（那是 models.utility 的参数）。provider/model 显式选择：目录 = hana.models.list() 投影，provider/model id 原样透传（宿主逐条 n.provider===provider && n.id===model 匹配），不做二次命名。@dsh-hanako/provider 插件 v2 重写为自实现 LlmAdapter（dsh-llm 动态 import，同 v1 profiles 基座解析）：listModels/resolveModel 读目录快照；stream() 把 DSH Message 转换（user/assistant/toolResult + 回放签名，lib/messages.js）→ hana.models.stream({requestId, ...身份, provider, model, messages, systemPrompt, tools, reasoningEffort?, maxTokens?, temperature?}) → NDJSON 逐行解析（跨 chunk 半行余量，lib/ndjson.js；**HTTP 非 2xx 先报状态+响应体**，不吞成 STREAM_CLOSED）→ 事件处理（start/text-delta/reasoning-delta/tool-call/done/error）；error = 失败不算成功；done.assistant 完整保存回放（textSignature/signature/thoughtSignature 续接签名进 ReplayEnvelope{kind:hana}，DSH assistant source.replayState）并原样产块（block-start/delta/block-end/usage/finish，工具 arguments 为 JSON 字符串）；流未以 done 结束 → STREAM_CLOSED；图片 base64+MIME（attachment store readImageRequest，不传路径/URL；store 缺失报 UNSUPPORTED_CONTENT）。DSH 自己的工具循环不变（Hana 不执行传入 tools schema，仅声明）；工具执行后 role:toolResult + toolCallId/toolName/content/isError 放回 messages（lib/messages.js 拆分）。hana client 句柄 = globalThis.__dshanaHana（dsh-host.mjs connectAppRuntime 后、runProfile 前设置，与子插件同进程共享；释放顺序：停 task-bridge → ctx dispose → 清句柄 → hana.close，main.js 实现）。
- **create/send 业务链**（src/lib/session-run.js submitDshTask → tools/session.js）：execute（含宿主 context.callToken）→ ctx.tasks.create({callToken, label, metadata})（callToken 只此一次消费，不落盘不落日志）→ ensureManagedRuntime({taskId})（未起则启动到 ready，失败归类 err.code 并 fail(taskId)）→ 会话建立（create=session.create{cwd, agentPreset?}；send=session.list 查持久会话（带 cwd）则 session.create resume，活跃 Map 会话直接 prompt，list 不含=不存在由 prompt admission 报 session/not-found）→ 显式 provider/model/effort 才 session/selectModel（model-unavailable 降级不带 effort 重试）→ 写 task-map（先于 prompt）→ session.prompt fire（mode:queue, content:[{type:text}], requestId=rpcId）。返回 { promise, ready }：ready 在 prompt accepted 后 resolve 定位键 {action, sessionId, rpcId, taskId, cwd}（execute 随即返回，v1 语义不变）；promise 后台等 Hana task 终态（child task-bridge complete/fail → 宿主 deferred:resolve/fail 投递来源会话）并释放同会话串行化锁。
- **task-bridge（受管 runtime 内，src/runtime/task-bridge.js）**：DSH boot 就绪后、readyMarker 前挂载，ctx.on 订阅 api-session/status|error|activity + session/event（进程内直订——turn 生命周期不经 $events）；按 <dataDir>/dshana/taskmaps/<sessionId>.json（App 写、sessionId 即文件名天然隔离多会话，决策 C/D）把事件回投：running 进度 ctx.tasks.update、终态 complete(taskId, minimal 定位结果)/fail(taskId, message)。终态判定语义与 v1 run.js consume 对齐：api-session/status false / session/event turn/end（reason.kind=error → 失败；completed → 成功，pendingFailure 兜底判失败）；先到先收、幂等、终态后删映射。
- **决策 C（映射持久化）**：taskId↔dshSessionId↔rpcId 映射落 dataDir 文件（src/lib/task-map.js，原子写 + TTL prune；子进程 task-bridge/provider 只经 connectAppRuntime 拿 tasks/models/network.fetch，读不到 App ctx.storage——跨进程关联必须落在两者共享可读处，runtime writeRoots 含 dataDir）。不复刻 ctx.storage.agent 镜像副本（512KB/16MB 上限与双写漂移风险）；App 侧跨重启检索任务/会话关系待步骤 4 按需补索引。64KiB 任务 JSON 限制由宿主门强制——metadata/result 只放小定位键。callToken 不落盘不落日志（指南 §5 硬约束，task-map 结构即证明）。
- **决策 D（并发纪律）**：同 DSH session 的 create/send 由 App 进程内串行化（src/lib/session-serialize.js，与 v1 withSessionTurn 同语义；锁持有到任务终态——否则同一 session 两个任务会互吃对方的终态事件/映射）；不同 session 互不共享「当前任务」（task-map 按 sessionId 分文件）；一个 runtime 服务多会话时各请求自带 taskId（models.stream.taskId、task 记录 taskId、prompt 信封 rpcId 作 jsonl data.source.rpcId 关联键）。
- **工具接线**：tools/session.js create/send 分支接 submitDshTask（返回语义与 v1 一致：fire 即回、终态投递来源会话、内容 action=get）；cancel/approve 保留步骤 4 明确「未接线」错误（含使用指引）。list/get 离线读不变（projcache + jsonl zstd）。
- 端口不再有设置项：servicePort/nodejsPath 随 T5 裁撤（父进程区间随机选端口 38000..52000 + 占用换端口重试；用户不再需要配置端口）。
- 单测新增（node --test 全绿 62 例）：rpc-envelope（信封/网关 method 斜杠/requestId 注入）、task-map（路径/读写删/TTL/不落 callToken）、session-serialize（同会话串行/跨会话并行/槽位）、provider-ndjson（跨 chunk 半行/flush/坏行）、provider-catalog（routes/efforts/元数据）、provider-messages（assistant 签名/tool-result 拆分/图片/UNSUPPORTED_CONTENT）、provider-stream（done→chunks/回放信封/EMPTY_RESPONSE/max-tokens）、task-bridge（事件归类）。构建：node src/build.js 与 node src-cordis/build.js 通过（dist 内含 taskmaps/task-bridge/__dshanaHana 标记）。
- 已测/未测边界（步骤 3）：真机 AppHost 实跑 create/send 模型流未在本刀跑通（无宿主环境/网络），装包后由主上下文验收：① tasks 生命周期与结果投递；② task-bridge 终态对账；③ provider adapter 被 DSH agent 循环调用的消息/块序与跨 turn done.assistant 回放；④ 同会话两次 send 串行；⑤ DSH 图片附件 base64 路径；⑥ 两会话并发（宿主模型流并发上限 2）；⑦ runtime 中途重启后 send 的 resume 路径；⑧ 执行超时/取消（依赖步骤 4 session.cancel）。本步模型流不逐块实时打字（done 时一次性产块，功能等价；DSH Web UI 实时性属步骤 4/5 面）。

**遗留（步骤 4b/5 收口已由本刀合入代码侧——见文末「步骤 4b/5 收口（代码侧）」；此处只剩真机/后续刀项）：**

- 真机 AppHost 验收（装包后，主上下文与姐姐协调）：① 宿主审批通知形态与 watch SSE 实测对账；② 宿主取消 UI 端到端；③ 重启恢复（App 进程重启后 in-process 队列/后台 watcher 重建 + task-map 残留判定——仍属后续刀）；④ ui/ 壳页到 App routes 的 surface 授权/cookie 形态；⑤ DSH Web UI 在代理前缀下的资源/API/WS base 适配（宿主不重写任意 SPA——壳页就绪态已就位，DSH 侧 base 适配待对账）；⑥ 旧数据迁移真机执行（--apply 停机协调）。
- activation on-demand（manifest activation.mode）决策仍留稳定后（指南 §11）。
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
  瀑布事件）。有 task-map（dshana_session 发起的会话）→ hana.tasks.requestApproval({taskId,
  label, details:{dshSessionId,rpcId,toolName,callId,reason,args}, timeoutMs})（以父 taskId
  为范围，不需 callToken；timeoutMs 快照经映射下传，0=宿主不自动拒绝）→ 映射文件记
  approvals 条目（App approve 校验归属/去重）→ 挂起 ApprovalOutcome 承诺 watch(approvalId)
  等终态：allowed-once/rejected 原样投给该 approvalId 的 DSH 等待者（承诺闭包天然定向，
  不广播）；终态无 outcome（父任务结束/撤销/审批超时）→ rejected（fail closed，绝不隐式
  放行；指南 §9）。App 侧 dshana_session(action=approve) = approve-respond.js 校验 task-map
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
- src/lib/approve-respond.js：dshana_session approve 应答（归属校验 + respondApproval + 回填）。
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
   卡片），dshana_session(action=approve) 是否被模型正确选用——approve 分支无本地依赖，纯
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


## 步骤 4b/5 收口（代码侧）——routes/UI/cards + 数据迁移 + 打包（本刀合入）

指南 `10`（Web UI/HTTP/SSE/WS 迁移）、`12`（旧数据迁移）、`13` 步骤 5 的「代码侧」在本刀收口。
真机 AppHost 验收（DSH UI 交互、surface 授权、代理前缀端到端）留装包后由主上下文做——下方
「已测/未测边界」单列。

### 宿主实证记录（server 0.930.1 bundle，只读查证）

- **受管服务代理 = 宿主自动暴露，App routes 不需要转发**：bundle 含
  `const Uee = "hana_app_runtime"`、`u1e(appId, runtimeId) = /api/apps/<appId>/routes/_runtime/<runtimeId>/`
  与代理 express 路由 `/apps/:appId/routes/_runtime/:runtimeId/*`（ayr 函数族）：请求带
  `upgrade: websocket` 走 upgradeWebSocket 转发（二进制/文本帧，缓冲上限 1MB），其余方法按
  runtime 记录端口 fetch 到 `127.0.0.1:<port>`（重定向 Location 重写回代理前缀；剥离
  authorization/cookie/host 等请求头；strip `appSurfaceSession`/iframe ticket/agentId 查询参）。
  首次携带 `?appSurfaceSession=` 或 `X-Hana-App-Surface-Session` 的响应会 Set-Cookie
  `hana_app_runtime=<surfaceToken>; Path=/api/apps/<id>/routes/_runtime/<rid>/; HttpOnly;
  SameSite=Strict` 供后续子请求。因此本 App 的 ctx.routes **只做壳页/诊断面**；DSH Web UI/
  API/SSE/WS 一律指向该前缀。
- **ctx.routes.register**：单 bundle 只能 register 一次；registrar 收到 Hono sub-app（SKILL/
  SDK d.ts：`register(registrar:(app)=>unknown)`，可返回 Promise 由宿主 await 后发布）；
  公开 URL `/api/apps/<appId>/routes/<subpath>`，鉴权 app_route（宿主登录或本 App surface
  会话）。处理函数在 App 进程内执行（与 ctx.tools.execute 同生命周期，共享 App 运行包/受管
  runtime 单例——路由模块直接调 lib/managed-runtime.js 是本设计前提）。
- **ui/ 静态树**：宿主 `GET/HEAD /apps/:appId/ui/*` 直接服务 App 安装目录 `ui/` 子树
  （Z8t 防目录逃逸；scoped surface 路径 `/api/apps/<appId>/ui/_surface/<sessionToken>/...`
  由 iframe-ticket 端点下发 uiBasePath——页面相对资源在此 base 下继承授权）。App 自身 ui/
  页面资源一律相对路径（指南 `10` 禁根绝对 URL）；face 映射 `/api/apps/<appId>/ui/<image>`。
- **contributes.cards v2 字段白名单**（宿主 readManifest 实证）：
  `id/title/description/route/embedUrl/cardForm/titlebar/realization/pageOf/siteNavEntry/
  fpFullPanel/functionPanel/face/formFactors`——realization:"page" + siteNavEntry、pageOf 均
  可用（宿主 schema 校验同 SKILL）。route 值 = ui/ 相对路径（须对应真实文件，宿主按文件名
  服务，无扩展名推断——route 用 `/dshana/main.html` 形态）。

### 交付 1：ctx.routes.register 单 registrar（壳页/诊断面）

- 新 src/routes/dshana-routes.js（v1 routes/webui.js + card.js 两工厂合并语义）：端点
  `GET /dshana/boot-state`、`GET /dshana/health`、`POST /dshana/start`（fire-and-forget，
  202 即回，壳页轮询跟进）、`POST /dshana/stop`。依赖注入（getSnapshot/start/stop）可单测；
  index.js apply 用 defaultDshanaRouteDeps(ctx) 接真实实现（读 managedRuntimeDetails）。
- src/lib/boot-state.js：归一化快照 `{phase,ready,runtimeId,proxyPrefix,service,error,
  note,updatedAt}` 与 runtimeProxyPrefix()（前缀宿主契约单点）。**ready 门**：service.state
  === ready 才给 proxyPrefix（绝不因 runtimeId 存在就展示端点——宿主在 readyMarker 后才发布
  服务）。阶段文案覆盖 idle/starting/ready/error/stopped。
- index.js：ctx.routes.register 缺失（宿主过旧）→ warn 降级（DSH 仅 dshana_session 可用）；
  registrar 抛错 → 抬高中止 App 加载（显式失败优于静默残缺）；disposer 注销。

### 交付 2：contributes.cards 回归（v2 schema）

- manifest 单卡：id dshana（route `/dshana/main.html`，realization:"page" +
  siteNavEntry + fpFullPanel，cardForm:"flush"），同卡 `functionPanel`
  `{ id: "dshana-sidebar-panel", label: "DSHana 状态", route: "/dshana/sidebar.html" }`
  ——FP 由主卡自带（宿主 0.944.2+ 的 route 形态），不再用 `pageOf` 同伴卡过渡。
- 壳页三态（精简版，v2 无自动链 UI）：idle（说明 + 「启动 DSH」按钮 → POST /dshana/start）、
  starting（轮询 boot-state）、error/action-needed（错误码 + 用户可读指引 + 重试）、ready
  （iframe src = 宿主代理前缀 + `?dshana-view=main|sidebar`）。**DSH UI 的 SPA base 适配**
  （资源/API/WS 前缀）宿主不代做，真机对账（见下）。

### 交付 3：ui/ 静态树归位

- src/ui/{main.html, sidebar.html, app-shell.js}（build:src 复制到 dist/ui/）：
  页面同层相对引用（`./app-shell.js`），无根路径绝对 URL；appId/路由前缀由页面
  location.pathname 推导（/api/apps/<appId>/... 段），不硬编码整 URL。壳页轮询 boot-state、
  POST start/stop；主题桥（同文档，`dshHanaThemeRequest`）best-effort。剪贴板已改由
  `@dsh-hanako/clipboard` 的 client 半 shadow `navigator.clipboard.writeText`，原生被据时直调
  `__DSHANA__.clipboardWrite`（旧 `__dshCopy` 消息协议已删）。

### 交付 4：旧插件数据迁移（交付代码与 --check 路径，本刀不真跑）

- src/lib/legacy-migrate.js（纯 node 内置）+ scripts/migrate-legacy.mjs CLI：
  `--check`（默认，只读计划）/`--apply`/`--force`/`--source|--hanako-home`/`--target`
  （缺省取 DSHANA_LEGACY_HOME/DSHANA_DATA_DIR）。流程 = 备份（目标数据区
  `migration-backup/`，**已存在不覆盖唯一备份**）→ 复制 dsh-home/{sessions,storages,
  settings.yaml,.anonymous-user-id} 与 logs、config.json（参考拷贝
  legacy-config.json + 设置建议输出；不代写宿主 preferences）→ 校验（会话数/workspace.json
  可解析/marker 落位，verifyMigration）→ 幂等标记 `dataDir/dshana/migrated.json`
  {source,at,stats,backupDir}。**profiles/ 不迁移**（其 node_modules/@dsh-hanako 是 junction
  指向 v1 安装目录，v2 runtime seed.js 每次启动用 installDir cordis/ 自愈重建——「profile 引用
  修复」= 由种子化重建承接）；node_modules/.node 不迁移（App 依赖走 dataDir/runtime 区 pnpm
  重装，无文件锁问题）。源只读不删（回退材料 = 旧插件数据原地保留）；--apply 打印停机指引
  （先停旧插件写入，主上下文与姐姐协调）。Windows：path.join 原生分隔符、junction 在跳过
  列表、reparse 不入复制。

### 交付 5：pack/syncver 收口（版本线）

- 版本线为单一 1.x 线（开发期停在最后已发布基线、发版经 `pnpm version` 推进、DSH 跟随策略），
  细节与依据见 `specs/dshana-v2-定案与待议-2026-09-10.md` §5；cordis 包（roster + plugins，
  10 个 package.json）**等值跟随**主版本（无独立版本线）；build metadata（+dsh-<dsh 依赖>）由
  version-hook 发版时统一拼回再同步。syncver.mjs 头注释记录版本线语义。
- pack.mjs：静态项补 THIRD_PARTY_NOTICES.md；cordis dist 断言按清单校验（现 10 包）；
  新增 dist/ui 断言（route 资源 fail-closed）；zip 形态不变（dist 根 manifest/index.js +
  三件套 + NOTICE/THIRD_PARTY_NOTICES + cordis + ui，无 node_modules）。

### 交付 6：@dsh-hanako/* 子插件 v2 收敛判断（落到 DESIGN；代码侧不动 roster，防 boot 破坏）

逐插件职责与 v2 判断（profile cordis.patch.yml 行序保留——移除任何行都需要真机 boot 验证，
本刀只做收敛判断与惰性标注，物理退役随 UI 真机验收刀收口）：

| 子插件 | v1 职责 | v2 判断 | 说明 |
|---|---|---|---|
| provider | host provider 目录直连（apiKey/baseURL） | **保留必装（已 v2 重写）** | hana.models 推理 adapter（迁移步骤 3） |
| bridge | 免鉴权 connection 等价服务 + /api HTTP 载体（DSH Web 数据面必需） | **保留（v2 仍必需）** | DSH UI 经代理前缀直连 /api/* 时同款免 401/403 依赖；App→runtime RPC 走官方 gateway /api 端点同依赖其 interceptor 面 |
| app | serve fork 官方前端到根路径（宿主 WebUI iframe 载体） | **保留（惰性优先）** | DSH Web UI 根页面服务仍走 webserver fallback；v2 经代理前缀访问不变；内容面待 UI 真机验收 |
| view | client 端 root 装配（main/sidebar 视图、layout 服务） | **保留（惰性优先）** | DSH UI 视图装配属 DSH 侧；URL 三态参数与壳页 ?dshana-view 约定一致即可 |
| theme | 壳页 postMessage 主题注入（tapIndex 注入桥） | **保留（桥壳页侧需对账）** | v2 壳页 app-shell.js 已实现 dshHanaThemeRequest 应答（best-effort）；TOKEN_MAP 对齐待真机 |
| clipboard | 剪贴板桥（宿主 capability 写剪贴板） | **保留（改为 client 半 shadow）** | v2 无宿主 capability 白名单——壳页 navigator.clipboard/execCommand 兜底，失败如实回执；正式路径待 hana.clipboard 能力面确认 |
| settings | DSH Web 设置页「DSHana 设置」分页（默认模型/版本卡 + 更新总线） | **已退役（2026-09-12，改由 App 自己设置页承担）** | v1 更新链路（dshana.bus → 宿主）v2 无宿主侧；本地版本卡/默认模型 UI 保留；更新段退役（App 发版即 DSH 升级）——真机验收刀随 UI 修剪 |
| logger | DSH 内日志收集 → dshanaBus → 宿主会话文件 | **已退役（2026-09-12）** | bus 一走它只剩“写一行到 cordis logger”，无存在价值；唯一消费者 theme 改为直接用内建 LoggerService（行首 `[theme]`） | v2 无宿主 WS 连接，总线缓冲不再送达；受管 runtime stdout 由宿主 runtime 日志承载（App 侧不再落盘，见 spec §8 j）——真机后移除总线转发段 |
| bus | dshana.bus WS 服务端（宿主插件 IPC 通道） | **已退役（2026-09-12）** | v2 宿主不再连 dshana.bus：App→runtime = loopback HTTP RPC（决策 A），runtime→宿主 = connectAppRuntime（tasks/models）。无消费方即死代码——真机确认 logger/settings 无注入依赖后从 patch.yml 移除 |
| acp-assist | dsh-acp agent 工厂 setup 后置（补 ACP 会话缺的默认 preset） | **已退役（2026-09-10）** | v2 不装载 dsh-acp，patch 对象不存在；roster 行与插件目录已删。依据见 `specs/dshana-v2-定案与待议-2026-09-10.md` §10 |

### 已测/未测边界（本刀）

- 已测：node src/build.js 与 node src-cordis/build.js 通过（dist 含 ui/ + manifest cards +
  dshana-routes 接线）；单测 143 例全绿（新增 boot-state 7 + dshana-routes 6 + legacy-migrate
  5 = 18 例；既有 125 例保持）。pack.mjs 版本断言/静态清单逻辑改动后未实跑（留发版时验证）。
- 未测（真机 AppHost 装包后由主上下文验收）：① ui/ 壳页 → /routes/dshana/* 的 surface
  授权形态（scoped uiBasePath/iframe ticket → cookie/hana.api，代码按同源相对 fetch 写，
  实证文件见 bundle iFt/eFt/uVe）；② DSH Web UI 在代理前缀下 SPA 资源/API/WS 的 base 适配
  （宿主不重写 HTML/根路径——需 DSH 侧或 App 侧改写，见 manifest/壳页注释）；③ /dshana/start
  fire-and-forget 的宿主 route 并发语义（boot 数分钟窗口内宿主对 App route 请求无超时回收）；
  ④ 壳桥 theme vars 的 TOKEN_MAP 对齐 + clipboard 正式路径；⑤ migration --apply 真机执行
  （含 Windows junction/文件锁/旧插件停机协调）。



