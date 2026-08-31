# DSHana

插件 id：`dsh-hanako`。把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）接进 Hana，作为进程外 subagent 使用。任务执行走 **dsh web host**（`--profile web`），dsh 官方 Web UI 以 **DSHana 标签页**内嵌在 Hana 顶部，可见全部任务会话；账本与依赖锁进插件数据目录。

## 安装

1. **拖入 zip 包**：把插件的 release zip（`dsh-hanako-v<version>.zip`，从 GitHub Releases 下载）拖进 Hana 插件安装界面（或解压到插件目录），插件即完成装载

2. **打开 DSHana 标签页自装**：插件加载后自动拉起 web host，若未就绪则显示诊断列表。点击 deps 卡片的「安装依赖」——页面自动完成部署（复制 package.json、创建 node 代理脚本、`npm i @deepseek-ai/dsh`、运行级验证），无需 Agent 介入（v0.8.6+）。完成后去 t2 点「手动启动 web host」即可。**也可让 Agent 调 `dsh_install` 工具**（异步默认，渲染安装卡片显示实时 npm 日志，安装完成自动拉起 web host；`dsh_install(action="verify")` 只检测依赖完整性）。

3. **验证**：装完让 Agent 跑一次 `dsh_run` 最小试任务验证，卡片不报 web host 错误即安装成功。

**无需配置 API Key / 模型**：dsh 凭据由 @dsh-hanako/provider 插件直读 Hana 宿主 `provider-catalog.json`，模型跟随宿主 `models.json`。任务模型默认 = dsh 默认模型（`settings.yaml` 的 `agent-default-model`），可在 **dsh 设置页「DSHana 设置」分页**直接配置（页头下方「默认模型」卡片：Provider/模型/思考强度三级联动，保存即生效，见下文）；同分页的 **「DSH 版本」卡片**提供 `@deepseek-ai/dsh` 版本检查与一键更新（检查 dsh 侧直查远端 registry，更新走宿主能力层；Agent 用 `dsh_install` 工具 action=check/update 也可用）。`dsh_run` 工具参数 `provider` / `model` / `reasoningEffort` 可显式覆盖。

安装遇到问题，把报错丢给 Agent 即可（技能里有完整排错表）。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `approvalTimeoutSec` | `30` | 审批挂起超过该时长（秒）无人应答自动 rejected（应答方失联检测）；0=禁用；改后对新审批立即生效（v0.25 起单位由毫秒改为秒，旧键 `approvalTimeoutMs` 由迁移自动换算删除） |
| `defaultCwd` | 空 | 默认沙箱工作目录。**安装后建议设为实际项目目录**（为空且未传 cwd 时报 `cwd 不能为空`） |
| `dshTag` | `latest` | DSH 检查/更新跟随的 npm dist-tag（更新基线，可选 next/alpha 等）。dsh_install 工具未显式传 version/tag 时使用 |
| `defaultTimeoutSec` | 1800 | 默认超时（秒，30 分钟）。v0.25 起单位由毫秒改为秒，旧键 `defaultTimeoutMs` 由迁移自动换算删除 |
| `nodejsPath` | 空 | 自定义 Node.js 路径（可选）：指定系统 node 可执行文件绝对路径（如 /opt/homebrew/bin/node）。留空用 Electron 自带 node；macOS 上 Electron 内嵌 node 跑 pnpm 签名校验失败时填此项解决。路径不存在时警告并降级回退 |
| `webPort` | 3080 | dsh Web UI 端口：>0 插件加载即拉起 web host（卸载一并回收），0 关闭 |

## License

This project is licensed under the **Mozilla Public License 2.0**.
See the [LICENSE](LICENSE) file for details.