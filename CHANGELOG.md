# Changelog

## Unreleased（refactor/t7b-retire-spawn）

- **T7b 步骤 5：spawn 分支整体退役**（PR #40 之一）：删 bootSpawn（child_process.spawn + --expose-internals）+ WEB_PROCESS_MODE 逃生开关；ensureWebHost 唯一形态 = 进程内 runProfile；waitWebReady 去 spawn 快速失败分支；closeProcess 唯一 dispose 路径。保留：verifyDepsSmoke 冒烟 + pnpm install 子进程（D6 解耦设计）。
- **dsh-pkg 退役 + 更新/检查链整链移除**：部署目标 dsh-pkg → 插件根（pnpm install --prod 按插件声明，无部署声明副本，版本单一事实源 = 插件声明本身）；version/tag 逃生门移除；updateDsh / checkDshUpdate / check.js / resolveDshTag / /webui/check-update / /webui/update-dsh 全删；dsh_install 收敛 install/verify；settings 版本卡去更新功能（只显示本地版本）。实机成本：插件根 pnpm install --prod ≈19s（store 硬链接）。
- **@dsh-hanako 子插件改名**：api-bridge → bridge（数据面桥）、bridge → bus（消息总线，与宿主 bus.js 对称）、web-app → app（WebUI 载体）。
- **工具收敛（T7e）**：dsh_session 全生命周期（list/get/create/send/cancel，合并 dsh_run + dsh_cancel）；HANAKO_TOOLS = [dshSession, dshInstall, dshApprove]（approve 独立：权限应答语义正交）。
- **文档清理**：CHANGELOG legacy 清理；SKILL description 去版本标记（Agent 调用不关心迭代史）；dsh-install/dsh-run/dsh-cancel SKILL 收敛。

## v1.0.0-alpha.4（2026-09-01）

- **T7b 进程内 boot dsh + 免鉴权 WebUI + 根路径 serve**（feat/t7b-inproc-boot，PR #39）。
① **进程内 boot**：ensureWebHost 分派 bootInproc（runProfile 在宿主进程内拉起 dsh，3080 归宿主进程，无独立 dsh 子进程）；动态 import 带 webpackIgnore（rspack 编译改写绕行）；closeProcess 改 ctx.fiber.dispose()；app-boot 定位双保险（createRequire + .pnpm 枚举）。
② **拔鉴权墙**：新增 @dsh-hanako/api-bridge（免鉴权 connection 等价服务 + /api HTTP 载体，requestRejection 恒 undefined 免 401/403）；gateway/api-* 插件零改动激活；remote.mux 由 gateway 自带自动放行。
③ **WebUI 根路径**：web-app 改 registerFallback serve 官方 dist 到根路径（删 /webui/ 前缀 + URL 改写）；iframe 直嵌根路径（去 ?dshReload bust）。
④ **client 侧 connection 载体**：vendored 官方 dsh-client-connection@0.1.2-alpha.3 client bundle（id 改写，dsh.client 声明）——浏览器侧 provide connection，client boot 从 40 pending 恢复。
⑤ settings/theme 适配 dsh 0.1.2（modelCatalog RPC、settings/describe、3s 轮询替代 events.host WS）。
⑥ CodeRabbit 两轮全修（就绪失败回收、install smoke 强校验、bus 竞态、logger 保序等 12 条）+ lockfile 同步（frozen-lockfile 修复）。
验证：进程内 boot + dsh_run 闭环（hello-dshana-t7b）+ WebUI 200 + 免鉴权数据面全通；CI/Release 全绿。


## v1.0.0-alpha.3（2026-08-31）

① **contributes.settings → configuration**：宿主 0.810.0 插件运行时读取的是 `contributes.configuration`（properties 平铺），`contributes.settings`（v2 包裹层）声明不生效——manifest 设置项（webPort/defaultCwd/approvalTimeoutSec/defaultTimeoutSec/nodejsPath）一直没被宿主加载，设置页改配置存不进去。改回 `configuration` 后 5 项设置真正生效（对齐宿主运行时契约）。
② **撤回 dshTag 设置项**：dist-tag 由 registry 动态返回（`pnpm view dist-tags`），静态字符串手输不合理；撤回 configuration 声明，改由 @dsh-hanako/settings 页 DSH 版本卡片动态拉取列表做选择器（后续落地）。运行时支持保留：`config.json global.dshTag` + `resolveDshTag` 三阶回退（默认 latest），check/install 基线照常工作。
验证：configuration 键名实测生效（设置项加载 + 写入 config.json）；dshTag 不在宿主设置 UI 出现（等 settings 动态选择器）；commit GPG 签名。
升级注意：`dshTag` 不再出现在宿主设置 UI（config.json 手写仍有效，默认 latest）；manifest 设置项（webPort 等 5 项）自本版起真正生效。

## v1.0.0-alpha.2（2026-08-31）

① **工具合并**：`dsh_install` 扩展为 install/verify/check/update 四合一（`dsh_update` 移除，无兼容别名，skills/文档全量同步）；deferred wake meta.type 统一 "dsh-install"，卡片 kind 保留 install|update 区分标题；并发防护双独立 → 共享互斥（见 ④）。
② **指定版本 + dist-tag 基线**：`version`（具体版本号）优先于 `tag`（dist-tag），缺省回退配置基线 `dshTag`（config.json global + manifest settings，默认 latest）；`lib/check.js` 升级为 HTTP 直查 registry 根包 JSON 的 dist-tags 全量映射（官方源→npmmirror 兜底，15s 超时），check 返回 `{ localVersion, distTags, baselineTag, baselineVersion, updateAvailable, error? }`（latestVersion 保留兼容别名）；能力层 `installDepsFromPlugin` 缺省 spec 回退配置基线（webui 路由/设置页总线调用同遵循，单一事实源）。设置页「DSH 版本」卡片检查仍直查 latest，与宿主 dshTag 基线非 latest 时结果可能不同（文案/文档已澄清）。
③ **version.mjs 支持 npm semver**：完整 semver 解析（major.minor.patch[-pre][+build]），递增对齐 node-semver——patch 有 prerelease 毕业不递增、minor/major 在低段为 0 且有 prerelease 时毕业不递增（1.0.0-alpha.1 → 1.0.0）、新增 prerelease/pre 子命令（保留 preid 递增末段，无 pre 时 x.y.(z+1)-0）；严格 semver 校验（核心组件与数字 prerelease 标识符 0|[1-9]\d*，拒前导零）；dry-run 豁免工作区干净检查。
④ **CodeRabbit review 修复**：install/update 共享依赖操作互斥（`g.depBusy` 同步段预留、wait/异步双路径释放，能力层守卫保留覆盖 webui 路由）；spec 注入面校验（`isValidPkgSpec`：仅严格 SemVer 或含字母 dist-tag，拒 npm:alias/github:/file:/路径与前导零版本形状）；`compareSemver` prerelease 按 SemVer §11.4 逐标识符比较（数字数值/非数字字典序/数字<非数字/长短）；DESIGN/SKILL/client 基线差异澄清 + webui 路由标注兼容端点。
验证：build（rspack + terser + assert）通过；version.mjs 各档 dry-run 符合预期（1.0.0-alpha.1：patch/minor/major 均毕业 1.0.0、prerelease → 1.0.0-alpha.2；非法输入 01.0.0/1.0.0-alpha.01/npm:foo 拒绝）；isValidPkgSpec 22 用例全 PASS；commit GPG 签名（主上下文收口）。
升级注意：`dsh_update` 工具已移除，改用 `dsh_install`（action=check/update）；新增 `dshTag` 设置项（dist-tag 基线，默认 latest，version 参数优先于 tag 优先于基线）。

## v1.0.0-alpha.1（2026-08-31）

⑥ **manifestVersion 1 → 2（v2 应用体系）**：contributes.configuration → contributes.settings（properties 包进 schema，v2 settings 结构）；cards 删 type/icon（v2 卡片白名单 Kae 无此二字段，声明会 throw）+ 新增 siteNavEntry: true + fpFullPanel: true；network 字段全在 v2 白名单（Dae）；v2 顶层强制 manifestVersion===2、id 必须等于部署目录名（apps/<id>/）；v1 的 C3t builtin-only 拒绝不适用于 v2 白名单（siteNavEntry/fpFullPanel 社区应用可声明，liliMozi 官方探针 fp-full-probe 验证）。
⑦ **全占页样式 + 版本**：cardForm framed→flush / titlebar solid→translucent（fpFullPanel 全占风格，探针同款）；version 0.25.0 → 1.0.0-alpha.1（v2 时代）；.nvmrc Node 24 → 26。
验证：v2 声明按宿主 0.810.0 bundle 校验逻辑逐字段核对（YBt 顶层 / EBt settings / UBt cards 白名单 / GBt network 白名单）；实装验证 fpFullPanel 生效（独占页面，宿主侧栏被 Full FP 面板取代）。
升级注意：DSHana 由 v1 插件形态过渡到 v2 应用形态（apps/ 部署），功能（入口 cordis 化 / tools/routes 迁移 / embedUrl 嵌 DSH WebUI sidebar）后续落地；宿主侧栏将被 Full FP 面板取代，DSHana 页面切换为整页卡（system 活动条隐掉）。
