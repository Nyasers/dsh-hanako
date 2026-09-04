---
name: dsh-hanako
description: "dsh-hanako 插件（把 DeepSeek Harness 接进 Hana 的进程内嵌 subagent 执行器）的配置辅助与使用指南。触发场景：dsh-hanako 刚装好需要配置（默认即可，无需手动装依赖/配 Node）、DSHana 标签页显示自举中/需要处理（errorClass 人话指引）、web host 起不来（先开标签页看三态自举页：booting 阶段/action-needed 指引/ready 直嵌）、依赖安装全自动（自动链/自举页三态，无手动工具无手动按钮）、DSH 任务失败排查、审批怎么应答（dsh_session action=approve）、默认模型怎么配（DSH 设置页「DSHana 设置」分页，provider/model/思考三级联动）、DSH 版本（更新 DSH = 更新插件发版 + 重启宿主）、安装进度实时日志（自动链/卡片）、DeepSeek Harness 相关。遇到 dsh-hanako 相关需求优先读本技能再动手。"
---

# dsh-hanako 配置辅助与使用指南

把 DeepSeek Harness（DSH）接进 Hana：插件加载即启动**自动链状态机**（依赖自举 → 进程内拉起 DSH web host），DSH Web UI（http://127.0.0.1:3080）以 **DSHana 标签页**（Bootstrap 三态自举页）内嵌可见全部会话。

## 首次安装配置（Agent 辅助用户完成）

config.json 由宿主设置界面生成、**不随包分发**，缺省全部可用，无需人工预配置：

- **无需手动装依赖 / 无需 Node 路径**：插件加载（onStartUp）自动链会幂等检查并按插件声明（插件根 package.json 的 dependencies，固定版本）自动 `pnpm install --prod` 装进**插件根 node_modules**，装好自动拉起 web host——全程无手动按钮。web host 默认用宿主 electron 自身 Node 运行时（`process.execPath`，`ELECTRON_RUN_AS_NODE=1`）。
- **可选配置 `nodejsPath`**：macOS 上 Electron 内嵌 node 跑 pnpm 触发签名校验失败（macos-signature）时，在 **DSH 设置页「DSHana 设置」→ 自定义 NodeJS 路径**（或 config.json `global.nodejsPath`）填系统 node 绝对路径（如 /opt/homebrew/bin/node）；保存 config.json 后自动链会**自动续跑**（config watch），无需重启、无需手动操作页面。
- **无需配置 API Key / 模型**：凭据由 @dsh-hanako/provider 直读宿主 `provider-catalog.json`，模型跟随宿主 `models.json`。任务默认模型 = DSH 默认模型，可在「DSHana 设置」分页「默认模型」卡片配置（provider/model/思考三级联动）。
- **DSH 版本卡片**：只显示本地 DSH 版本 + 「更新 DSH = 更新插件发版」说明；**升级 dsh = 装新插件包 + 重启宿主**（进程内 ESM 缓存豁免不可行，见已知限制）。
- `dsh_session(action="create")` 每次调用**必须显式传 `cwd`**（defaultCwd 已删除）。

**配置生效（实时）**：nodejsPath 等配置运行期直读 config.json/单例（resolveNodeExec 每次 spawn 前解析），保存即对下一次子进程生效；停等类失败（macos-signature）保存 config.json 后自动链续跑。仅「进程内 boot 的旧模块缓存」类问题需要重启宿主（restart-needed，见下）。

## 启动自动链（T2 状态机，全自动，页面无手动入口）

插件 onload 后自动链在后台推进（无常驻轮询，失败退避重试），阶段持久状态存单例 `g.boot`：

1. **ensure-deps**：幂等检查/安装 dsh 依赖（cliBin 在且版本===声明 + 静态核对通过 → 秒过跳过；否则 pnpm install --prod，官方源失败自动切 npmmirror）→
2. **booting**：进程内启动 DSH web host（`g.startWebHost`）→
3. **ready**：收敛（web host 就绪，标签页直嵌 iframe）

**失败决策（errorClass 分类，T1）**：install/boot 失败先分类再行动——

- **可恢复自动退避重试**（network / environment / unknown / native-toolchain）：退避 30s → 2m → 10m → 30m（cap），插件生命周期内持续，网络/工具链/环境恢复后**自动完成**，无需操作。
- **不可自动恢复 → 停等条件变化**（macos-signature 等配置类 / declaration 声明问题 / restart-needed 升级缓存残留）：页面给明确指引；条件满足后自动续跑（配置保存 / 插件更新 / 重启宿主）。

状态快照单一出口 `GET /webui/boot-state`（T3）：`{ phase, ready, deps:{ status,errorClass,guidance,error,version,logTail }, boot:{ attempt,nextRetryAt,errorClass,guidance,lastError }, web:{ ready,lastError } }`——标签页只消费它渲染三态（见下），Agent 排查也直接读它。

## DSHana 标签页（Bootstrap 三态自举页，T4）

标签页（主卡 DSHana route `/main`；子卡 dshana-sidebar route `/sidebar`、`pageOf: dshana`——两卡同壳页按 `?dshana-view=<view>` 装配视图：main 视图 = 接收端 receive、sidebar 视图 = 发射端 emit）按 `boot-state` 渲染三态，**无任何可点的启动/安装/检测按钮**（手动入口已随 T5 退役）：

1. **booting（自举中）**：阶段时间线（依赖就绪 → 启动 Web Host → 就绪）+ 依赖安装实时日志尾滚动 + 重试信息（第 N 次 / 下次自动重试时刻）。自动推进中，等即可。
2. **action-needed（需要处理）**：自动链暂停。页面给出 **errorClass 人话 + 明确操作步骤**（如配置 nodejsPath、装编译工具链、清理磁盘）+ 「自动续跑中/停等」说明（区分可恢复退避重试中 vs 需重启宿主/等条件）；原始错误折叠「详情」。用户只做页面所述环境动作，**完成后自动续跑**。
3. **ready（就绪）**：iframe 直嵌 dsh Web UI。

事件流 `GET /webui/events`（保留）：`ready`（挂载 iframe）/ `pending`（停机退回自举页）/ `diag-changed`（自举状态变化信号：deps 翻转或 web host 启动失败 → 刷新 boot-state）/ `theme-pref`。

## 工具速查

| 工具 | 用途 | 关键点 | 详情 |
|---|---|---|---|
| `dsh_session(action, task?, cwd?, …)` | 会话全生命周期（宿主 Agent 面唯一工具） | action ∈ create（提交，task+cwd 必填，异步提交后主动结束回合）/ send（续会话）/ cancel（取消）/ list/get（回看）/ approve（应答审批：sessionId+approvalId，决策看 args 不听 reason）；操作实现按 subtool 模块化 | [dsh-session 技能](../dsh-session) |

> 依赖安装已全自动（自动链 + Bootstrap 自举，无手动工具）：`g.installDeps`/`g.verifyDeps` 由插件生命周期驱动，标签页只读展示三态。

## 排错表

**web host 起不来 → 先开 DSHana 标签页看三态自举页**：booting 显示阶段/进度/重试；action-needed 直接给 errorClass 人话 + 操作步骤；原始错误折叠「详情」。对照：

| 现象 | 原因 | 处理 |
|---|---|---|
| 页面 action-needed：macos-signature | Electron node 签名校验失败 | 配置 nodejsPath（设置页 → 自定义 NodeJS 路径），保存后自动续跑 |
| 页面 action-needed：native-toolchain | koffi/node-pty 等原生模块编译失败 | 装编译工具链（macOS `xcode-select --install` / Windows VS Build Tools），自动链会重试 |
| 页面 action-needed：environment（EACCES/EPERM/ENOSPC） | 权限/磁盘 | 清理磁盘或调整权限（EBUSY 属锁，自动重试） |
| 页面 action-needed：restart-needed | dsh 已跨版本升级，宿主仍持旧模块缓存 | **重启宿主（Hana）**，重启后自动续跑 |
| 页面 action-needed：declaration / unknown | 声明或上游问题 / 未知 | 无需手动；等插件更新或上报作者，自动链保守重试 |
| booting 长时间无进展 / 事件丢失 | 事件流断或退避间隙 | 页面 30s 兜底/退避到点自动刷新；开会话日志看自动链里程碑 |
| 页面 ready 但任务报 web host 错误 | 端口占用/进程异常 | 查 webPort 占用；开会话日志（自动链 `[hana]` 行）定位 |
| `dsh_session` 报「DSH 包未就绪」 | 依赖缺失/漂移 | 自动链通常已自愈（ensure-deps 阶段自动安装）；仍失败等退避/查会话日志 |
| pnpm install 下载失败/超时 | registry 网络 | 已内置官方源 → npmmirror 自动重试；持续失败查代理/网络 |
| bash 报 `E_ACCESSDENIED` | DSH bash 沙箱 Windows 限制 | 改用文件系统工具（write/read/edit） |
| 改了配置/代码不生效 | 宿主模块缓存 / 需重启的缓存残留 | 配置类实时生效；升级/代码类重启 Hana |

**诊断日志**：全部运行日志在会话日志文件 `<dataDir>/logs/<YYYYMMDD-HHmmss-SSS>.log`（旧日志 onload zstd 压缩 `.log.zst` 保留）。行前缀 src：`out`/`err`（web host）、`hana`（插件生命周期 + 里程碑 `[自动链]`/`[依赖安装]`/`[依赖验证]`）、`pnpm`（pnpm 原始输出逐 chunk 实时落盘）。pnpm/自动链失败先看 `[hana]` 自动链行（errorClass + 退避/停等决策）与 `[pnpm]` 行。

## 已知限制

- **升级 dsh = 装新插件包 + 重启宿主**：插件侧无法豁免宿主进程内 ESM 模块缓存（spec 决策，勿重走弯路）；跨版本升级后 boot 撞旧 .pnpm 缓存 → restart-needed 停等，重启宿主自动续跑
- 主题跟随：system 跟随宿主，light/dark 原生；宿主切主题后壳页实时跟随（经 `hana.theme.changed` + `/webui/events` theme-pref）
- bash 在 Windows 可能 E_ACCESSDENIED（DSH 沙箱限制）；文件工具正常，Windows 优先用
- wait=true 同步模式无审批通知（只能 Web UI 或超时）；长任务建议异步
- 越界权限默认走审批：deferred 通知 → `dsh_session(action="approve", …)` 应答；`approvalTimeoutSec` 内无人应答自动拒绝（缺省回落 30 秒 = manifest 默认；仅显式设 0 禁用自动拒绝）
- 任务默认新建会话；传 sessionId 复用（resume）；会话/账本在插件数据目录 dsh-home/，不碰 ~/.DSH
