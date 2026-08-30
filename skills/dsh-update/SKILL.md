---
name: dsh-update
description: "dsh_update 工具手册（源码 tools/dsh-update.js + tools/dsh-run.js 能力层核对）。触发场景：检查 @deepseek-ai/dsh 版本（action=check，本地 + 远端 + 可更新判断）、更新 DSH（action=update，停 web host → pnpm add latest → 起 web host，正在执行的任务会中断）、更新执行中重复调用返回状态、wait=true 同步等待、dsh 设置页「DSH 版本块」/ DSHana 标签页 deps 卡片与工具共用同一宿主能力层（单一事实源）。需要检查或更新 dsh 前先读本技能。"
---

# dsh_update 工具手册

检查或更新 DeepSeek Harness（dsh）版本。权限 `external_side_effect`（external_api）。实现 `tools/dsh-update.js`，宿主能力层 `tools/dsh-run.js`（`g.checkDshUpdate` / `g.updateDsh`，挂 globalThis 单例调用，不静态 import）。

## 参数契约

`required: []`（全部可选，默认 `action=check`）：

| 参数 | 类型 | 语义 |
|---|---|---|
| `action` | string | `check`（默认）= 只查版本，只读不改动任何东西；`update` = 执行完整更新（停 web host → pnpm add @deepseek-ai/dsh latest → 起 web host，**正在执行的 dsh 任务会中断**） |
| `wait` | boolean | `false`（默认）= 异步：update 立即返回，更新在后台执行，完成后宿主唤醒、结果后台送达；`true` = 同步：等更新跑完直接返回最终结果（pnpm add 可能耗时数分钟，阻塞当前回合） |

## 行为（源码核实）

**check**：本地版本（运行级验证 verifyDepsSmoke 缓存优先，无则直读 dsh-pkg package.json）+ 远端版本（HTTP 直查 npm registry——fetch `https://registry.npmjs.org/@deepseek-ai/dsh/latest` 的 JSON `version` 字段（pnpm view 语义等价），官方源失败自动重试 npmmirror，15s 超时）→ zero-dep semver 比较（major.minor.patch 三段数字逐个比，预发布 `-rc.x` 视为低于同版本正式版）→ `{ localVersion, latestVersion, updateAvailable, error? }`。结果缓存 `g.check.result`（内存；不再写 `<dataDir>/check-result.json` 桥接文件——dsh 设置页「DSH 版本」卡片检查已改 dsh 侧直查，Agent 工具与 DSHana 标签页直接读返回值）。

**update**：① 置内存态 `g.update.status='running'`（v0.24 起 update-result.json 退役）→ ② 停 web host（closeProcess，Windows 文件锁前提：pnpm add 要替换被 web host 占用的 dsh 包文件）→ ③ `installDepsFromPlugin`（pnpm add @deepseek-ai/dsh latest，官方源失败重试 npmmirror）→ ④ 起 web host（ensureWebHost，失败不阻断结果上报，记 error 字段）→ ⑤ 读新版本 → `g.update.result` 存终态（{ ok, state:'done', version }）→ `status='ok'`；任一步失败 → result 存 `{ ok:false, state:'error', error }`（截断 ≤1500）→ `status='error'`（终态保留，下次更新入口回 running）。**触发信道**：设置页经 **dshana.bus 消息总线**发 `update.request` 直投（`src/lib/bus.js` 订阅 → 调 `updateDsh` → 开始/完成经总线回投 `update.progress { state, at }` / `update.result { state, version?, error? }`（v0.22.1+ 事件化：设置页事件缓存 + update-stream 推送，替代 2s 轮询；v0.24 起 update-result.json 退役，无文件兜底）；v0.22.1 起替代 update-request.json 文件桥与 POST /child/post 反向信道，均已退役，无请求文件可清理）。**并发防护**：更新执行中（`g.update.status === "running"`）重复调用返回 `{ ok:false, state:'updating' }` 不重复执行；检查（`g.check.status`）同理。

**异步模式**：`update` 默认异步——立即返回「已后台执行」，经宿主 deferred 通道注册唤醒（taskId `dup_*`），完成后后台消息带回 `{ tool:'dsh_update', action:'update', status:'done', version }`（失败带 error）。

## 返回

- **check**：`DSH 版本检查：本地 vX / 已是最新版本（vY）/ 可更新 / 未安装 / 远端查询失败…`，details `{ dsh: { action:'check', localVersion, latestVersion, updateAvailable, error? } }`
- **update 同步（wait=true）**：`DSH 更新完成：vX…，新任务将使用新版本，请重启 DSHana 使完全生效` 或 `DSH 更新失败：…`，details `{ dsh: { action:'update', ok, state:'done'|'error', version?, error? } }`
- **update 异步（默认）**：立即返回「已在后台执行（将重启 web host，正在执行的任务会中断）」，details `{ dsh: { action:'update', status:'updating', taskId } }`
- **更新中重复调用**：`DSH 更新已在执行中…`，details `{ dsh: { action:'update', status:'updating' } }`

## 使用场景

- **版本检查**：Agent 需要确认当前 dsh 版本 / 是否有新版（`dsh_update(action="check")`）
- **更新 DSH**：有新版本且当前无运行中任务时（`dsh_update(action="update")`）——**先确认没有正在执行的 dsh 任务**（dsh_session action=list 查会话/看卡片），更新会重启 web host 中断任务
- 与 dsh 设置页「DSHana 设置 → DSH 版本卡片」（v0.18.1 起检查 dsh 侧直查，v0.18.2 起 HTTP 直查 npm registry；更新仍走宿主能力层）、DSHana 标签页 deps 卡片结果一致

## 示例

```
dsh_update()                              # 查版本（默认 check）
dsh_update(action="check")
dsh_update(action="update")               # 异步：后台执行，完成后唤醒带回结果
dsh_update(action="update", wait=true)    # 同步：等更新跑完直接返回
```

## 关联

- 更新进度/结果也可在 dsh 设置页「DSH 版本」卡片（v0.22.1+ 事件驱动：订阅 update-stream 事件流，update.progress/result 驱动；事件缺失手动刷新）或 DSHana 标签页 deps 卡片（30s 超时兜底/手动刷新诊断）查看——经总线事件回投（v0.24 起 update-result.json 退役，无文件兜底）。
- 更新后新任务将使用新版本；建议重启 DSHana 使完全生效。更新失败按 deps 卡片/设置页的 error 字段排查（registry 网络、web host 重启失败等，见 dsh-hanako 技能排错表）。
