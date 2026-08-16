---
name: dsh-search
description: "dsh_search 工具手册（源码 tools/dsh-search.js 核对）。触发场景：跨会话搜索 dsh 历史会话内容、dsh_search 怎么用（query 1~500 字符 trim 无 NUL）、返回结构（items ≤20 条 sessionId+snippet ≤240 字符 + hasMore）、命中后怎么 resume（dsh_run sessionId 复用、上下文继承、知识复用）、只读查询语义、查不到怎么处理。需要搜索 dsh 历史会话前先读本技能。"
---

# dsh_search 工具手册

跨会话搜索历史会话内容（session.search RPC）。只读查询，不改变任何会话。权限 `external_side_effect`（external_api）。实现 `tools/dsh-search.js`。

## 参数契约

`required: ["query"]`：

| 参数 | 类型 | 语义 |
|---|---|---|
| `query` | string | 搜索关键词，**1~500 字符**（自动 trim）；跨全部历史会话内容匹配 |

校验（源码核实）：空 → `query 必填（1~500 字符）`；超 500 → `query 过长（N 字符，最多 500）`；含 NUL → `query 不得包含 NUL 字符`。

## 调用细节

- 调 web host `POST /api/session.search`（client-request 信封，rpcId 回显校验；`full.result.ok` 为假抛 `dsh session.search 失败：<code> <message>`）。
- 响应 `value: { items: [{ sessionId, snippet }], hasMore }`：snippet ≤240 字符（防御性再截断），最多 20 条。
- web host 未就绪时报 `dsh web host 未就绪（请先通过 dsh_run 提交任务拉起）`。

## 返回

- 命中：`匹配 "<query>" 的历史会话（共 N 条[，还有更多]）：\n- <sessionId>\n  <snippet>…` + 提示可用 dsh_run 的 sessionId 参数 resume。
- 空：`未找到匹配 "<query>" 的会话`，details `{ dsh: { query, count: 0, hasMore: false } }`。

## 与 dsh_run 的配合（resume 复用）

命中会话后：

```
dsh_run(task=…, sessionId=<命中的 sessionId>)
```

- 语义：复用已有会话继续，agent 保留上文（省上下文重建，知识复用）。
- resume 时以会话已有 cwd 为准（自动查询沿用，无需传 cwd）；目标会话须已空闲。
- sessionId 也可取自上次 dsh_run 回调/卡片。

## 使用场景

- 想继续上次某个未完成/想接续的任务，但忘了 opId → 按关键词搜到 sessionId 再 resume。
- 跨任务复用知识：之前某个任务里研究过的东西，搜到会话上下文继续用。
- 排查：确认某类任务以前怎么做的（snippet 提供上下文预览）。

## 关联

- 会话清单/摘要（sessionId/title/cwd/时间/token/统计）用 dsh_ops，本工具只按内容搜会话。
- resume 的参数细节与副作用见 dsh-run 技能。
