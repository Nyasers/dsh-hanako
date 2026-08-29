---
name: dsh-session
description: "dsh_session 工具手册（源码 tools/dsh-session.js 核对）。触发场景：查 dsh 会话清单/对账/回溯（action=list，limit 默认 10、有效范围 1~100，数据源 = dsh 会话持久化缓存 <dataDir>/dsh-home/storages/session_projcache.json，dsh-home 唯一事实源，重启后仍可查）、凭 sessionId 直取会话内容（action=get：元数据 + 最终结论 summary，读会话 jsonl 的 zstd 多帧容器本地解压；minimal 回调拿到定位键后取内容就走这个，sessionId 即访问凭证）。search 模式已移除（dsh 默认 openAt: never 禁用全文搜索，插件不再注入 session-query-sqlite patch）。需要查/取 dsh 会话前先读本技能。"
---

# dsh_session 工具手册

DSH 会话统一查询工具（list / get 两模式，只读）。**均为纯本地文件读**（list 解析
`session_projcache.json`，get 再读会话 jsonl 的 zstd 容器本地解压），不调 web host。
不改变任何会话。实现 `tools/dsh-session.js`。

**权限模型：sessionId 即访问凭证**——会话存在性与内容的唯一事实源在 **dsh-home**
（`sessions/` + `session_projcache.json`）。拿得到 sessionId（dsh_run 回调 / list 清单）
即可 get / resume，拿不到天然无所有权，无需额外所有权表。search 模式已移除（dsh 默认
`openAt: never` 禁用全文搜索，插件也不再注入 session-query-sqlite patch 覆盖启用）——
不再有全局全文搜索入口。

数据定位键统一为 **sessionId**（与 dsh_run 回调同键）：minimal 回调拿到
`{ status, rpcId, sessionId }` 定位键后，取会话内容直接用
`dsh_session(action="get", sessionId=<id>)`——不再需要关键词搜索先决条件。

## 参数契约

`required: ["action"]`，其余按模式：

| 参数 | 类型 | 语义 |
| --- | --- | --- |
| `action` | string（必填） | `list`=会话清单 / `get`=凭 sessionId 直取会话内容 |
| `limit` | integer | **仅 list**：返回条数（按 lastPromptAt 最新在前，取最近 N 条）。**默认 10，有效范围 1~100，超出自动收敛到边界** |
| `sessionId` | string | **仅 get（必传）**：目标会话 id（形如 `session-<uuid>`，取自 dsh_run 回调 / 卡片 URL / list 结果；dsh-home 存在即读） |

## action=list：会话清单与摘要（继承 dsh_ops）

**纯本地文件读**（解析 dsh 官方会话持久化缓存 `session_projcache.json`），不调 web host，无副作用。

### 数据源（源码核实）

- 路径：`<dataDir>/dsh-home/storages/session_projcache.json`（dataDir = 插件数据目录，经 `globalThis.__dshHanako.dataDir` 取，缺失时兜底插件根 `data/`）。
- 这是 dsh 官方 session-persistence 单元的 proj cache（`{ unit: {name:"session_projcache"}, tables: { sessions: { "<sessionId>": {...} } } }`），由 dsh 侧持久化维护——**dsh-home 唯一事实源，重启后仍可查**。
- 容错：文件不存在 / JSON 损坏 / 结构不符 → 空结果，不抛错。
- 无 `status` 参数——数据源没有 running/ok/error/interrupted 状态语义（会话没有任务状态字段）。

### 返回字段（每条摘要对象，字段存在才带，null 兜底）

- `sessionId`：会话 id（proj cache 的 key，形如 `session-<uuid>`）
- `title`：会话标题（`rows.title.val`，null → `""`）
- `cwd`：会话工作目录（`identity.cwd`）
- `createdAt`：创建时间（`identity.createdAt`，毫秒时间戳）
- `lastPromptAt`：最近提示时间（`rows.sessionListMetadata.val.lastPromptAt`，缺失 → 兜底 `createdAt`）
- `usage`：token 用量（`rows.tokenUsage.val.totals`：uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens）
- `turns` / `steps` / `llmMs`：会话统计（`rows.sessionStats.val` 对应字段）

### 排序与行格式

- 排序：`lastPromptAt` 降序（最新在前；缺失时兜底 `createdAt`，仍缺失排最后）。
- 行格式：`<sessionId> · <title前40字> · <cwd>`。
- 返回：`DSH 会话清单（共 N 条，最新 M 条）：` + 每会话一行；details `{ dsh: { action:"list", count, limit, sessions: [完整摘要数组] } }`（供对账与回溯）。

## action=get：凭 sessionId 直取会话内容

**minimal 回调定位链路的配套能力**：主上下文收到 `{ status, rpcId, sessionId }` 定位键后，
凭 `sessionId` 直接取该会话的元数据 + 最终结论，无需知道内容先验知识。
权限模型：sessionId 即凭证——凭 id 在 dsh-home 存在即读，不存在返回错误。

### 数据源（源码核实）

- 元数据：projcache 条目（同 list 字段：sessionId/title/cwd/createdAt/lastPromptAt/usage/turns/steps/llmMs，字段存在才带）。
- 内容：会话日志文件 `<dataDir>/dsh-home/sessions/<cwd-key>/<sessionId>/session.jsonl.zstd`（cwd-key = cwd 编码目录名，如 `E:\Hanako\workspace` → `--E-Hanako-workspace--`）。
- **定位**：先按 projcache `identity.cwd` 猜编码目录，失败则遍历 `sessions/` 下全部 cwd-key 子目录找 sessionId 同名目录（稳妥兜底）。
- **解压**：Node 内置 `node:zlib` `zstdDecompressSync`（Node 22+，插件运行在宿主 node 24）。文件是 dsh **逐批 append 的多帧 zstd 容器**（每批一帧，帧 magic `0xFD2FB528`）——`zstdDecompressSync` 一次只解一帧，需按 magic 定位帧起点**逐帧解压再拼接**，直接解整个文件可能报错。
- **解析**：jsonl 逐行 `JSON.parse`（容错跳过坏行），记录最后一条 `type==="assistant/message"` 的 `data.message.content` 中 `type==="text"` 的 text 拼接（同 `textFromMessageBlocks` 语义）。

### 返回

- 成功：`content` = `会话 <sessionId>（<title> · <cwd>）：\n最终结论（<turns> turn）：\n<summary>`；details `{ dsh: { action:"get", sessionId, ok:true, summary, summaryLength, turns, meta } }`。
- `summary` = 会话最终结论（最后一条 assistant/message 的 text），**截断 ≤4000 字符**（超出加 `…`）；无文本汇报时 `（会话无最终文本汇报）`。
- 会话不存在（日志文件缺失）：返回 `{ ok:false, error }` 风格错误（`找不到会话 <sessionId> 的日志文件…`），不抛 stack。
- 解压失败（文件损坏/格式异常）：返回 `{ ok:false, error }`（`日志文件解压失败…`），不抛 stack；可在 DSH Web UI 查看。

### 真实调用示例

```
dsh_session(action="get", sessionId="session-6e643d47-eaac-4dad-9fbf-0e284622807b")
```

→ summary：`上一次命令失败是因为输出中的错误信息显示 \`node\` 未被识别为 cmdlet、函数、脚本文件或可执行程序，即 node 不在当前 PowerShell 环境的 PATH 中（常见安装路径也找不到），导致 \`node -e\` 无法启动而退出码为 1。`

## 使用场景

- **minimal 回调续接**：异步任务完成收到 `{ status, rpcId, sessionId }` 定位键 → `dsh_session(action="get", sessionId=<id>)` 直取最终结论（summary），需要更多内容再 resume 或看 DSH Web UI。
- **对账/回溯**：`action=list` 看会话清单（标题/cwd/时间线/token 用量），定位想继续的会话。
- **取消前定位**：`action=list` 查会话清单按 sessionId 定位，再 dsh_cancel（见 dsh-cancel 技能）。

## 已移除：search 模式

- 旧版曾提供 `action=search`（调 web host `POST /api/session.search` 跨全部历史会话内容匹配），
  依赖插件注入 session-query-sqlite patch（`openAt: first-search`）启用全文搜索。
- 已移除：dsh 默认 `openAt: never` 禁用全文搜索，插件不再注入 patch 覆盖——不再有全局全文
  搜索入口（session-query 服务无调用方授权，禁用即收敛）。取内容用 `action=get`，找会话用 `action=list`。

## 关联

- 完整会话内容不在 list 返回里：get 给最终结论 summary（≤4000 字符）；全量输出在 DSH Web UI（sessionId 定位会话）或 dsh_run resume 后查看。
- 任务运行态（running/ok/error、耗时、stopReason）看运行卡片（卡片走会话 jsonl 恢复 + SSE 推送，重启后仍可查），不在 dsh_session 里。
- resume 的参数细节与副作用见 dsh-run 技能。
