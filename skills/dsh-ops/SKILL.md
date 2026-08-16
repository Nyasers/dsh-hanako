---
name: dsh-ops
description: "dsh_ops 工具手册（源码 tools/dsh-ops.js 核对）。触发场景：查 dsh 任务历史/对账/回溯、dsh_ops 怎么用（status 过滤 running/ok/error/interrupted，cancelling 归 running）、返回字段（opId/status/task/stopReason/durationMs/startedAt/endedAt/usage/resumeSessionId/sessionId）、50 条内存上限、重启后仍可查（ops.jsonl 落盘恢复，running → interrupted）、最新在前。需要查 dsh 任务历史前先读本技能。"
---

# dsh_ops 工具手册

查询 dsh 任务历史（op 快照）。**纯本地内存读**（`globalThis.__dshHanako.ops`，含 ops.jsonl 落盘恢复内容），不调 web host，无副作用（权限 `local_read`）。实现 `tools/dsh-ops.js`。

## 参数契约

`required: []`，可选：

| 参数 | 类型 | 语义 |
|---|---|---|
| `status` | enum: running/ok/error/interrupted | 过滤：running=运行中（**含已请求取消未收尾的 cancelling 任务**）/ ok=成功 / error=失败（含超时 timeout、取消 aborted）/ interrupted=上次运行中断（重启恢复时标记）。不传返回全部 |

## 数据源与容量（源码核实）

- 数据源：内存 ops Map（插件启动时 loadOps 从落盘恢复，重启后仍可查）。
- **上限 `OP_KEEP = 50` 条**：超出裁最老（终态结果文本已进对话 content，卡片只是增强展示）。
- 返回最新在前（Map 插入序倒序）。

## 返回结构

- 空：`暂无 dsh 任务记录`，details `{ dsh: { count: 0, status: … } }`。
- 每条摘要字段（存在才带）：`opId / status / task(≤80 字符) / stopReason / durationMs / startedAt / endedAt / usage / resumeSessionId / sessionId`。
- 行格式：`opId · status · 耗时(秒) · task前40字`；details `{ dsh: { count, status, ops: [完整摘要数组] } }`（供对账与回溯）。

## 落盘机制（背景）

- 终态行追加写 `<dataDir>/ops.jsonl`（JSONL 增量，防抖 300ms；旧版 ops.json 首次启动自动迁移）。
- 终态行**不落完整 output**（在内存快照与 dsh 会话完整记录里），带 `sessionRecord` 链接 → `dsh-home/sessions/<projectKey(cwd)>/<encodeSegment(sessionId)>/session.jsonl.zstd`（存在性校验 + 扫描兜底，找不到省略链接）。
- 重启恢复：仍为 running 的 op 标为 `interrupted`（`status: "interrupted"` + interruptedAt 时间戳），终态原样恢复；恢复后回写对齐文件。

## 使用场景

- 任务完成/失败后对账：opId、耗时、usage、stopReason 一次看清。
- 回溯历史任务：跨会话查结论（task 前 80 字符）。
- 排查：status=error 查失败清单；status=interrupted 查重启打断的任务。

## 关联

- 完整输出不在 dsh_ops 返回里：取卡片 op 快照（懒加载）或 dsh Web UI（sessionId 定位会话）。
- 需要按内容搜历史会话用 dsh_search（可拿到 sessionId 再 resume，见 dsh-search 技能）。
