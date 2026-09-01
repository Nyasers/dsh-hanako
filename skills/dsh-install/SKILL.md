---
name: dsh-install
description: "dsh_install 工具手册（源码 tools/dsh-install.js + tools/lib/install.js 能力层核对）。触发场景：安装 DeepSeek Harness（dsh）依赖（action=install，按插件声明版本 pnpm install --prod 到插件根 node_modules——dsh-pkg 已退役，版本严格锁插件声明无 version/tag 逃生门；registry 兜底 + 自动运行级重验 + autoStart）、检测依赖完整性（action=verify，运行级冒烟只读）、dsh_run 报「dsh 包未就绪」、DSHana 标签页不可用/依赖缺失、安装卡片（/card/dep 实时 pnpm 日志）、安装进行中重复调用返回状态。需要安装或验证 dsh 前先读本技能。"
---

# dsh_install 工具手册

安装/验证 DeepSeek Harness（dsh）依赖（T7d：版本检查/更新整链移除——更新 dsh = 更新插件发版）。权限 `external_side_effect`（external_api）。实现 `tools/dsh-install.js`，宿主能力层 `tools/lib/install.js`（`installDepsFromPlugin` / `verifyDepsSmoke`），经单例 `g.installDeps` / `g.verifyDeps` 调用，不静态 import。

## 参数契约

`required: []`（全部可选，默认 `action=install`）：

| 参数 | 类型 | 语义 |
|---|---|---|
| `action` | string | `install`（默认）= 安装依赖（按插件声明版本 pnpm install --prod 到插件根 node_modules，官方源失败自动重试 npmmirror + 自动运行级重验 + autoStart；已装版本与声明一致时跳过）；`verify` = 只检测依赖完整性（node cliBin --version 运行级冒烟，能跑 = 依赖图完整，只读不改动） |
| `wait` | boolean | `false`（默认）= 异步：install 立即返回 + 渲染安装卡片（实时 pnpm 日志），完成后宿主唤醒、结果后台送达；`true` = 同步：等安装跑完直接返回（pnpm install 可能耗时数分钟，阻塞当前回合） |
| `autoStart` | boolean | install 完成后是否自动启动 web host（默认 true：web host 未运行时经 g.startWebHost 拉起；失败不阻断结果上报）。verify 忽略 |

## 行为（源码核实）

**install**：① 并发防护——依赖安装中（`g.deps.status === "installing"` 或 `"running"`）重复调用返回 `{ ok:false, state:'installing' }` 不重复执行；② `g.installDeps(cfg)`（T7a 起版本单一事实源 = 插件根 package.json 的 dependencies）：部署目标 = **插件根**（T7d：dsh-pkg 退役——pnpm install --prod 按插件根声明拉取到插件 node_modules，无部署声明副本）→ **幂等检查**（cliBin 存在且已装版本 === 声明版本 → 跳过安装直接运行级重验，verifyDepsSmoke 失败走重装）→ 停 web host（`closeProcess`，Windows 文件锁前提）→ **npm → pnpm 升级兼容清理 + dsh-pkg 退役**（删 `package-lock.json` / `pnpm-lock.yaml` / 扁平 `node_modules`；旧数据目录 dsh-pkg 整体删除）→ node 代理脚本（数据目录 `pnpm-proxy/`，指向解析后的 node 执行体——默认宿主 electron node；配置 `nodejsPath` 时用自定义系统 node，PATH 首部指向代理目录让 koffi/node-pty 的 install script 找到 node）→ `pnpm install --prod --reporter=ndjson`（按插件根声明拉取，官方源失败自动重试 `--registry=https://registry.npmmirror.com`）→ 校验 cliBin → 清缓存强制运行级重验（`verifyDepsSmoke`，`g.deps.result` 刷新）；③ 完成后 autoStart（默认 true）：`g.web.ready` 已就绪跳过（返回 null）/ 未起经 `g.startWebHost(ctx.config, dataDir)` 拉起（成功 true / 失败 false，**失败不阻断结果上报**）→ `{ ok:true, state:'installed', cliBin, version?, autoStart?, skipped? }`。

**verify**：`g.verifyDeps(cfg)`（node cliBin --version 冒烟，10s 超时，结果缓存 `g.deps.result`）→ `{ verified, version, error? }`。

**异步模式**：`install` 默认异步——立即返回 + 渲染**安装卡片**（`/card/dep`，见下节），经宿主 deferred 通道注册唤醒（taskId 统一 `dsh_install_*` 前缀；meta.type 统一 `"dsh-install"`），后台完成/失败后宿主唤醒带回结果。

## 安装/升级卡片（v0.13.0）

异步 install/update 会渲染「安装/升级卡片」——形态与 dsh_run 任务卡片同构（iframe EventSource）：

- **页面** `GET /card/dep?taskId=`（iframe 内容，`data-kind="dep"`）
- **SSE** `GET /ops/dep-stream?taskId=`：首帧快照 + 每 1s 推一次（running 时 pnpm 日志实时滚动），终态（ok/error）推送后关闭；30s 心跳防代理超时
- **兜底** `GET /ops/dep-status?taskId=`：EventSource 建立失败时卡片回退一次
- **数据源** = 宿主单例 `g.depTasks`（Map：taskId → { kind: install|update, state: running|ok|error, log, at, result }）+ `g.deps.log`（pnpm install 输出实时尾部）+ 更新终态直接取条目 `result`（v0.24 起 update-result.json 退役）
- **渲染**：标题（DSH 安装 / DSH 升级，按 kind 区分）+ 状态徽标（安装中/升级中/完成/失败）+ pnpm 日志尾部预格式实时滚动（运行中隐藏滚动条 + 固定滚底）+ 完成结果行（「已安装 vX.Y.Z，web host 已自动启动」/「更新完成 vX，请重启 DSHana 使完全生效」/ 错误信息）

## 返回

- **install 同步（wait=true）**：`DSH 依赖安装完成：vX…，web host 已自动启动` / `DSH 依赖安装失败：…`，details `{ dsh: { action:'install', ok, state, version?, autoStart?, error? } }`
- **install 异步（默认）**：立即返回「已在后台执行」，details `{ dsh: { action:'install', state:'installing', taskId }, card: { route:'/card/dep?taskId=…' } }`
- **verify**：`DSH 依赖检测：通过，版本 vX` / `DSH 依赖检测：失败（…）`，details `{ dsh: { action:'verify', verified, version, error } }`
- **check**：`DSH 版本检查：本地 vX，基线 latest vY，可更新` / `已是最新版本` / `未安装` / `远端查询失败…`，details `{ dsh: { action:'check', localVersion, distTags, baselineTag, baselineVersion, updateAvailable, error? } }`
- **update 同步（wait=true）**：`DSH 更新完成：vX…，新任务将使用新版本，请重启 DSHana 使完全生效` 或 `DSH 更新失败：…`，details `{ dsh: { action:'update', ok, state:'done'|'error', version?, error? } }`
- **update 异步（默认）**：立即返回「已在后台执行（将重启 web host，正在执行的任务会中断）」，details `{ dsh: { action:'update', status:'updating', taskId } }`
- **安装中重复调用**：`DSH 依赖安装已在执行中…`，details `{ dsh: { action:'install', state:'installing' } }`；**更新中重复调用**：`DSH 更新已在执行中…`，details `{ dsh: { action:'update', status:'updating' } }`

## 使用场景

- **依赖缺失**：dsh_run 报「dsh 包未就绪：...bin.js 不存在」、DSHana 标签页不可用（t1 依赖 ✗）→ `dsh_install(action="install")` 或 `dsh_install()`（默认 install）
- **验证依赖完整性**：deps 卡片「存在但依赖不完整：ERR_MODULE_NOT_FOUND」→ `dsh_install(action="verify")` 复检，或直接重装
- **版本检查**：Agent 需要确认当前 dsh 版本 / 是否有新版（`dsh_install(action="check")`；指定基线可传 tag 或 version）
- **更新 DSH**：有新版本且当前无运行中任务时（`dsh_install(action="update")`）——**先确认没有正在执行的 dsh 任务**（dsh_session action=list 查会话/看卡片），更新会重启 web host 中断任务
- **装即用 / 升级到指定版本**：默认 autoStart=true，安装完成自动拉起 web host；`version="1.0.0-alpha.1"` 或 `tag="next"` 可指定安装/更新目标

## 示例

```text
dsh_install()                              # 安装依赖（默认按声明版本，异步 + 安装卡片）
dsh_install(action="install", wait=true)   # 同步等待安装完成
dsh_install(action="install", autoStart=false)  # 安装但不自动启动 web host
dsh_install(action="install", version="1.0.0-alpha.1")  # 覆盖声明版本安装指定版本
 dsh_install(action="install", tag="next")  # 按 dist-tag 覆盖安装
 dsh_install(action="verify")               # 只检测依赖完整性
dsh_install(action="check")                # 版本检查（默认基线 latest）
dsh_install(action="check", tag="alpha")   # 按 alpha 基线检查
dsh_install(action="check", version="1.0.0-beta.0")  # 对比指定版本
dsh_install(action="update")               # 异步：后台执行，完成后唤醒带回结果
dsh_install(action="update", wait=true)    # 同步：等更新跑完直接返回
dsh_install(action="update", tag="next")   # 更新到 next 基线
```

## 关联

- 安装进度/日志也可在 DSHana 标签页 deps 卡片查看（同一份 `g.deps.log`）。
- 装完调一次 `dsh_run` 触发任务；web host 未自动启动时可在 DSHana 标签页点「手动启动 web host」。
- 更新进度/结果也可在 dsh 设置页「DSH 版本」卡片（v0.22.1+ 事件驱动：订阅 update-stream 事件流，update.progress/result 驱动；事件缺失手动刷新）或 DSHana 标签页 deps 卡片查看——经总线事件回投（v0.24 起 update-result.json 退役，无文件兜底）。
- 更新后新任务将使用新版本；建议重启 DSHana 使完全生效。更新失败按 deps 卡片/设置页的 error 字段排查（registry 网络、web host 重启失败等，见 dsh-hanako 技能排错表）。
- 依赖部署细节见 dsh-hanako 技能「依赖自主部署」。
