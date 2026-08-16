---
name: dsh-ops
description: "dsh_ops 工具手册（源码 tools/dsh-ops.js 核对）。触发场景：查 dsh 会话清单/对账/回溯、dsh_ops 怎么用（limit 默认 10、有效范围 1~100）、数据源（dsh 会话持久化缓存 <dataDir>/dsh-home/storages/session_projcache.json，dsh 侧持久化重启后仍可查）、返回字段（sessionId/title/cwd/createdAt/lastPromptAt/usage/turns/steps/llmMs）、排序（lastPromptAt 最新在前）、无 status 过滤、与 dsh_search 的边界（本工具查会话清单与摘要，dsh_search 按内容搜索拿 sessionId 再 resume）。需要查 dsh 会话清单前先读本技能。"
---

# dsh_ops 工具手册

查询 dsh 会话清单与摘要。**纯本地文件读**（解析 dsh 官方会话持久化缓存 `session_projcache.json`），不调 web host，无副作用（权限 `local_read`）。实现 `tools/dsh-ops.js`。

## 数据源（源码核实）

- 路径：`<dataDir>/dsh-home/storages/session_projcache.json`（dataDir = 插件数据目录，经 `globalThis.__dshHanako.dataDir` 取，缺失时兜底插件根 `data/`）。
- 这是 dsh 官方 session-persistence 单元的 proj cache（`{ unit: {name:"session_projcache"}, tables: { sessions: { "<sessionId>": {...} } } }`），由 dsh 侧持久化维护——**重启后仍可查**，不依赖本插件的 ops.jsonl 落盘（该机制已移除）。
- 容错：文件不存在 / JSON 损坏 / 结构不符 → 返回空结果 `暂无 dsh 会话记录`，不抛错。
- 覆盖范围：dsh 全部历史会话（含新建未跑、已结束、dsh Web UI 手动建的会话）。

## 参数契约

`required: []`，可选：

| 参数 | 类型 | 语义 |
|---|---|---|
| `limit` | integer | 返回条数（按 lastPromptAt 最新在前，取最近 N 条）。**默认 10，有效范围 1~100，超出自动收敛到边界** |

无 `status` 参数——新数据源没有 running/ok/error/interrupted 状态语义（会话没有任务状态字段）。

## 返回字段

每条摘要对象（字段存在才带，null 兜底）：

- `sessionId`：会话 id（proj cache 的 key，形如 `session-<uuid>`）
- `title`：会话标题（`rows.title.val`，null → `""`）
- `cwd`：会话工作目录（`identity.cwd`）
- `createdAt`：创建时间（`identity.createdAt`，毫秒时间戳）
- `lastPromptAt`：最近提示时间（`rows.sessionListMetadata.val.lastPromptAt`，缺失 → 兜底 `createdAt`）
- `usage`：token 用量（`rows.tokenUsage.val.totals`：uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens）
- `turns` / `steps` / `llmMs`：会话统计（`rows.sessionStats.val` 对应字段）

无 `status` / `opId` / `stopReason` / `durationMs` / `endedAt` / `resumeSessionId`——新数据源无这些语义。

## 排序与行格式

- 排序：`lastPromptAt` 降序（最新在前）。
- 行格式：`<sessionId> · <title前40字> · <cwd>`。
- 返回：`dsh 会话清单（共 N 条，最新 M 条）：` + 每会话一行；details `{ dsh: { count, limit, sessions: [完整摘要数组] } }`（供对账与回溯）。

## 使用场景

- 对账/回溯：看会话清单、标题、cwd、时间线、token 用量，定位想继续的会话。
- 拿 sessionId 后配合 `dsh_run(task=…, sessionId=…)` resume 该会话继续（上下文继承）。
- 快速了解最近跑过什么（limit 控制条数）。

## 与 dsh_search 的边界

- `dsh_ops`：**按清单查**——全部会话的元数据摘要（标题/cwd/时间/token/统计），适合浏览、对账、按时间/标题定位。
- `dsh_search`：**按内容搜**——给关键词，跨全部历史会话内容匹配（sessionId + snippet），适合记不清标题、只记得内容片段时精确检索。
- 配合：dsh_search 命中拿 sessionId → dsh_run resume；dsh_ops 提供会话级全景（含 dsh_search 不返回的 cwd/时间/token）。

## 关联

- 完整会话内容不在 dsh_ops 返回里：dsh Web UI（sessionId 定位会话）或 dsh_run resume 后查看。
- 任务运行态（running/ok/error、耗时、stopReason）看运行卡片（v0.11.0 起卡片走会话 jsonl 恢复 + SSE 推送，重启后仍可查），不在 dsh_ops 里。
