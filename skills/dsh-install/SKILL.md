---
name: dsh-install
description: "dsh_install 工具手册（源码 tools/dsh-install.js + tools/lib/install.js 核对）。触发场景：安装 DeepSeek Harness（dsh）依赖（action=install，pnpm add @deepseek-ai/dsh 到 dsh-pkg，registry 兜底 + 自动运行级重验 + autoStart）、检测依赖完整性（action=verify，运行级冒烟只读）、dsh_run 报「dsh 包未就绪」、DSHana 标签页不可用/依赖缺失、安装卡片（/card/dep 实时 pnpm 日志）、安装中重复调用返回状态。需要安装或验证 dsh 依赖前先读本技能。"
---

# dsh_install 工具手册

安装或验证 DeepSeek Harness（dsh）依赖。权限 `external_side_effect`（external_api）。实现 `tools/dsh-install.js`，宿主能力层 `tools/lib/install.js`（`installDepsFromPlugin` / `verifyDepsSmoke`，经单例 `g.installDeps` / `g.verifyDeps` 调用，不静态 import）。

## 参数契约

`required: []`（全部可选，默认 `action=install`）：

| 参数 | 类型 | 语义 |
|---|---|---|
| `action` | string | `install`（默认）= 安装依赖（pnpm add @deepseek-ai/dsh 到数据目录 dsh-pkg，官方源失败自动重试 npmmirror + 自动运行级重验 + autoStart）；`verify` = 只检测依赖完整性（node cliBin --version 运行级冒烟，能跑 = 依赖图完整，只读不改动） |
| `wait` | boolean | `false`（默认）= 异步：install 立即返回 + 渲染安装卡片（实时 pnpm 日志），完成后宿主唤醒、结果后台送达；`true` = 同步：等安装跑完直接返回（pnpm add 可能耗时数分钟，阻塞当前回合） |
| `autoStart` | boolean | install 完成后是否自动启动 web host（默认 true：web host 未运行时经 g.startWebHost 拉起；失败不阻断结果上报）。verify 忽略 |

## 行为（源码核实）

**install**：① 并发防护——依赖安装中（`g.deps.status === "installing"`）重复调用返回 `{ ok:false, state:'installing' }` 不重复执行；② `g.installDeps(cfg)`：停 web host（`closeProcess`，Windows 文件锁前提，部署要删旧 node_modules）→ 写最小 package.json（无 devDeps）+ 复制插件根 `pnpm-workspace.yaml`（`allowBuilds` 放行 dsh 树 build scripts；pnpm 11 配置已迁至 pnpm-workspace.yaml）到 `dsh-pkg/` → 创建指向宿主 electron node 的代理脚本（node.cmd/node，PATH 首部指向 pkgDir 让 koffi/node-pty 的 install script 找到宿主 node）→ **npm → pnpm 升级兼容清理**（删 `package-lock.json` / `pnpm-lock.yaml` / 扁平 `node_modules`，旧 npm 体系残留与 pnpm 的 `.pnpm` 结构混装会破坏 cordis 依赖解析）→ `pnpm add @deepseek-ai/dsh --reporter=ndjson`（官方源失败自动重试 `--registry=https://registry.npmmirror.com`）→ 校验 cliBin → 清缓存强制运行级重验（`verifyDepsSmoke`，`g.deps.result` 刷新）；③ 完成后 autoStart（默认 true）：`g.web.ready` 已就绪跳过（返回 null）/ 未起经 `g.startWebHost(ctx.config, dataDir)` 拉起（成功 true / 失败 false，**失败不阻断结果上报**）→ `{ ok:true, state:'installed', cliBin, version?, autoStart? }`。

**verify**：`g.verifyDeps(cfg)`（node cliBin --version 冒烟，10s 超时，结果缓存 `g.deps.result`）→ `{ verified, version, error? }`。

**异步模式**：`install` 默认异步——立即返回 + 渲染**安装卡片**（`/card/dep`，见下节），经宿主 deferred 通道注册唤醒（taskId `dsh_install_*`），后台完成/失败后宿主唤醒带回结果。

## 安装/升级卡片（v0.13.0）

异步 install/update 会渲染「安装/升级卡片」——形态与 dsh_run 任务卡片同构（iframe EventSource）：

- **页面** `GET /card/dep?taskId=`（iframe 内容，`data-kind="dep"`）
- **SSE** `GET /ops/dep-stream?taskId=`：首帧快照 + 每 1s 推一次（running 时 pnpm 日志实时滚动），终态（ok/error）推送后关闭；30s 心跳防代理超时
- **兜底** `GET /ops/dep-status?taskId=`：EventSource 建立失败时卡片回退一次
- **数据源** = 宿主单例 `g.depTasks`（Map：taskId → { kind: install|update, state: running|ok|error, log, at, result }）+ `g.deps.log`（pnpm add 输出实时尾部）+ 更新终态直接取条目 `result`（v0.24 起 update-result.json 退役）
- **渲染**：标题（DSH 安装 / DSH 升级）+ 状态徽标（安装中/升级中/完成/失败）+ pnpm 日志尾部预格式实时滚动（运行中隐藏滚动条 + 固定滚底）+ 完成结果行（「已安装 vX.Y.Z，web host 已自动启动」/ 错误信息）

## 返回

- **install 同步（wait=true）**：`DSH 依赖安装完成：vX…，web host 已自动启动` / `DSH 依赖安装失败：…`，details `{ dsh: { action:'install', ok, state, version?, autoStart?, error? } }`
- **install 异步（默认）**：立即返回「已在后台执行」，details `{ dsh: { action:'install', state:'installing', taskId }, card: { route:'/card/dep?taskId=…' } }`
- **verify**：`DSH 依赖检测：通过，版本 vX` / `DSH 依赖检测：失败（…）`，details `{ dsh: { action:'verify', verified, version, error } }`
- **安装中重复调用**：`DSH 依赖安装已在执行中…`，details `{ dsh: { action:'install', state:'installing' } }`

## 使用场景

- **依赖缺失**：dsh_run 报「dsh 包未就绪：...bin.js 不存在」、DSHana 标签页不可用（t1 依赖 ✗）→ `dsh_install(action="install")` 或 `dsh_install()`（默认 install）
- **验证依赖完整性**：deps 卡片「存在但依赖不完整：ERR_MODULE_NOT_FOUND」→ `dsh_install(action="verify")` 复检，或直接重装
- **装完即用**：默认 autoStart=true，安装完成自动拉起 web host，无需手动「手动启动 web host」

## 示例

```
dsh_install()                              # 安装依赖（默认，异步 + 安装卡片）
dsh_install(action="install", wait=true)   # 同步等待安装完成
dsh_install(action="install", autoStart=false)  # 安装但不自动启动 web host
dsh_install(action="verify")               # 只检测依赖完整性
```

## 关联

- 安装进度/日志也可在 DSHana 标签页 deps 卡片查看（同一份 `g.deps.log`）。
- 装完调一次 `dsh_run` 触发任务；web host 未自动启动时可在 DSHana 标签页点「手动启动 web host」。
- 更新 dsh 版本用 `dsh_update`（升级卡片同款形态）；依赖部署细节见 dsh-hanako 技能「依赖自主部署」。
