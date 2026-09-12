---
name: dshana
description: "dshana App（把 DeepSeek Harness 接进 Hana 的受管子代理执行器）的使用与排错指南。触发场景：DSHana 卡显示未启动/启动中/需要处理（三态自举页）、DSH 起不来或启动超时、DSH 任务失败排查、审批怎么应答（dshana_session action=approve）、默认模型怎么配、DSH Web UI 打不开、主题跟随宿主、DeepSeek Harness 相关。遇到 dshana 相关需求优先读本技能再动手。"
---

# dshana 使用与排错指南

DSHana 把 DeepSeek Harness（DSH）作为**受管子代理执行器**接进 Hana：App 加载后自动拉起一个受管 Node runtime，里面跑 DSH web 服务；DSH 前端以**同文档注入**方式挂进 DSHana 卡（不是 iframe 内嵌）。DSH 依赖随 App 包物化，**运行时不需要安装任何东西**。

## 架构一句话

`apply(ctx)` 注册工具与路由 → 微任务触发 `ctx.runtime.start` 拉起受管 runtime → 壳页轮询 boot 状态 → 就绪后取 DSH index 注入当前页面。DSH 与宿主之间：指令走 runtime 控制面（`/_control` + loopback HTTP RPC），模型推理走宿主 `ctx.models`，凭据不进 DSH 进程。

## 首次安装（无需配置）

- **无需装依赖、无需配 Node**：DSH 及其依赖树随包分发在安装目录 `node_modules`，启动只做 profile 种子化 + 服务监听。
- **无需配 API Key / 模型**：推理经受管 runtime 内 `hana.models` 发起，provider 凭据留在宿主。
- **默认模型**：读 DSH 自身配置（`DSH_HOME/settings.yaml` 的 `agent-default-model`）。
- **数据目录**：固定用 App 内置独立目录（App 数据目录下的 `.dsh`），开箱即用；共享已有目录 / 切换数据源暂不提供。
- `dshana_session(action="create")` 每次调用**必须显式传 `cwd`**。

## DSHana 卡三态

壳页轮询 `GET /api/apps/dshana/routes/dshana/boot-state`，按 `phase` 渲染：

| 状态 | 表现 | 怎么办 |
|---|---|---|
| 未启动（idle） | 说明 + 「启动 DSH」按钮 | App 加载后会自动拉起；也可手动点 |
| 启动中（starting） | 阶段时间线 + 日志尾滚动 | 等即可（首次含 profile 种子化） |
| 就绪（ready） | 页面装载 DSH Web UI | 直接用 |
| 需要处理（error / stopped） | 失败原因 + 原始错误折叠 | 看指引重试；端口占用会自动换端口 |

**读状态的出口**：`boot-state`（壳页与 Agent 都用；含 phase/error/userText）。App 侧不再写文件日志——日志一律走宿主 `ctx.logger`，受管子进程输出由宿主运行日志捕获。

## 工具速查

| 工具 | 用途 | 关键点 |
|---|---|---|
| `dshana_session(action, task?, cwd?, …)` | 会话全生命周期（宿主 Agent 面唯一工具） | action ∈ create（提交，task+cwd 必填，异步提交后主动结束回合）/ send（续会话）/ cancel（取消）/ list/get（回看）/ approve（应答审批：sessionId+approvalId，决策看 args 不听 reason） |

`sessionId` 即访问凭证；`list`/`get` 纯本地读会话文件，DSH 未启动也可用。

## 主题

只有 DSH 主题偏好为 **system** 时跟随宿主配色（经 `@dshana/theme` 子插件注入）；在 DSH 内显式选 light/dark 时完全用 DSH 自己的主题，宿主配色不介入。

## 排错表

| 现象 | 原因 | 处理 |
|---|---|---|
| 卡在「启动中」很久 | profile 种子化/首次 boot 较慢 | 看日志尾；`boot-state` 的 `logTail` 会滚动显示进度 |
| 状态转「需要处理」 | runtime 启动失败 | 看 `error.userText` 与原始错误；日志定位 |
| 提示端口被占用 | 端口竞争 | 会自动换随机端口重试；持续失败看日志 |
| DSH Web UI 打不开但状态就绪 | 注入失败 / surface 票据缺失 | 重开卡；反复出现查中继前缀与 surface 授权 |
| `dshana_session` 报 runtime 未就绪 | DSH 还没起来 | 等就绪或点「启动 DSH」；持续失败看 boot 状态 |
| 默认模型改了不生效 | DSH 内存态与文件不一致 | 重启 DSH（停止后重新启动）再确认 |
| 主题没跟随宿主 | DSH 主题偏好是 light/dark 而非 system | 在 DSH 设置里改回 system |
| bash 报 `E_ACCESSDENIED` | DSH bash 沙箱 Windows 限制 | 改用文件系统工具（write/read/edit） |

## 已知限制

- **升级 DSH = 装新 App 包 + 重启宿主**：DSH 版本随 App 声明，无独立升级通道。
- 拆窗、钉回、切页面都不停 DSH 后台；停 App 或退出 Hana 才由宿主回收进程。
- 越界权限默认走审批：deferred 通知 → `dshana_session(action="approve", …)` 应答；`approvalTimeoutSec` 内无人应答自动拒绝（缺省 30 秒；仅显式设 0 禁用）。
- 任务默认新建会话；传 sessionId 复用（resume）；会话与账本在 App 数据目录内。
