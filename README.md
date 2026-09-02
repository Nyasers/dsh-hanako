# DSHana

插件 id：`dsh-hanako`。把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）接进 Hana，作为**进程内内嵌 agent**（runProfile 在宿主进程内 boot，无独立 DSH 子进程）。任务执行走 **dshana profile**（进程内 boot），DSH 官方 Web UI 以 **DSHana 标签页**内嵌在 Hana 顶部，可见全部任务会话；账本与 dsh-home 锁进插件数据目录，DSH 依赖装进插件 node_modules（版本随插件声明）。

## 安装

1. **拖入 zip 包**：把插件的 release zip（`dsh-hanako-v<version>.zip`，从 GitHub Releases 下载）拖进 Hana 插件安装界面（或解压到插件目录），插件即完成装载

2. **无需手动装依赖（自动）**：插件加载（onStartUp）时自动安装一次 DSH 依赖（幂等：已装且与插件声明版本一致 + 运行级验证通过则秒过跳过；缺失/版本漂移/依赖不完整才真跑 pnpm install --prod，官方源失败自动重试 npmmirror），装好后自动拉起 web host，首次启动即装完即用。**仅当自动安装失败（如离线/网络受限）时**才需人工介入：打开 DSHana 标签页（未就绪显示 t1/t2 自检）→ deps 卡片点「安装依赖」——页面自动完成部署，完成后去 t2 点「手动启动 web host」；**也可让 Agent 调 `dsh_install` 工具**（异步默认，渲染安装卡片显示实时 pnpm 日志，安装完成自动拉起 web host；`dsh_install(action="verify")` 只检测依赖完整性）。

3. **验证**：装完让 Agent 跑一次 `dsh_session(action="create", task="…", cwd="<项目沙箱目录>")` 最小试任务验证，卡片不报 web host 错误即安装成功。

**无需配置 API Key / 模型**：DSH 凭据由 @dsh-hanako/provider 插件直读 Hana 宿主 `provider-catalog.json`，模型跟随宿主 `models.json`。任务模型默认 = DSH 默认模型（`settings.yaml` 的 `agent-default-model`），可在 **DSH 设置页「DSHana 设置」分页**直接配置（页头下方「默认模型」卡片：Provider/模型/思考强度三级联动，保存即生效）；同分页的 **「DSH 版本」卡片**显示本地 DSH 版本（版本严格锁插件声明——更新 DSH = 更新插件发版）。`dsh_session` 工具参数 `provider` / `model` / `reasoningEffort` 可显式覆盖。

安装遇到问题，把报错丢给 Agent 即可（技能里有完整排错表）。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `approvalTimeoutSec` | `30` | 审批挂起超过该时长（秒）无人应答自动 rejected（应答方失联检测）；0=禁用；改后对新审批立即生效 |
| `defaultTimeoutSec` | 1800 | 默认超时（秒，30 分钟） |
| `nodejsPath` | 空 | 自定义 Node.js 路径（可选）：指定系统 node 可执行文件绝对路径（如 /opt/homebrew/bin/node）。留空用 Electron 自带 node；macOS 上 Electron 内嵌 node 跑 pnpm 签名校验失败时填此项解决。路径不存在时警告并降级回退 |
| `webPort` | 3080 | DSH Web UI 端口：>0 插件加载即拉起 web host（卸载一并回收），0 关闭 |

## License

This project is licensed under the **Mozilla Public License 2.0**.
See the [LICENSE](LICENSE) file for details.