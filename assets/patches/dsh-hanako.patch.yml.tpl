# dsh-hanako patch overlay（v0.9.5）：dsh 启动器 --patch 单一模板，四份 patch 合一。
# 由 dsh-run.js 启动前渲染占位符（机器绝对路径）写数据目录 dsh-hanako.patch.generated.yml，
# 渲染内容为顶层 patch 列表（顺序即应用顺序）。四段：
#   段1 session-query：会话全文搜索配置块（静态，无占位符，原样通过渲染）——dsh 上游默认
#     openAt: never 把全文搜索做成 opt-in，这里覆盖为 first-search（推迟 node:sqlite 导入
#     与句柄打开到首次搜索；索引 :memory: 进程内自会话日志重建）
#   段2 dsh-hana-theme：主题注入插件注册（包名 dsh-hana-theme）
#   段3 dsh-hana-provider：宿主 provider 跟随插件注册（包名 dsh-hana-provider；
#     config 依赖解析基座 {{MODELS_PATH}} / {{CATALOG_PATH}} / {{DSH_PKG_DIR}} → 宿主配置
#     绝对路径、dsh-pkg 部署目录）
#   段4 dsh-hana-default-model：设置页默认模型配置块插件注册（v0.9.5 正规化升级，
#     包名 dsh-hana-default-model）。
# 三段 cordis 插件均以包名注册（非 file:// URL）——dsh 的 client 模块发现
# （dsh-client-modules）按 loader entry 的 name 做 require.resolve('<name>/package.json')
# 找 package.json 的 dsh.client 声明 + exports["./client"]，file:// 形式无法解析（Node
# require.resolve 不支持 file:// scheme，实测 MODULE_NOT_FOUND），必须以可解析的包名
# 注册。包名解析锚点是 profile 目录（$DSH_HOME/profiles/web，baseUrl），dsh-run.js 启动
# 前在 $DSH_HOME/profiles/node_modules 统一建 junction（dsh-hana-theme / dsh-hana-provider
# / dsh-hana-default-model → 插件安装目录 assets/dsh-cordis/<同名包>）——与 dsh 自维护的
# junction farm 同机制，healProfilesModuleFallback 只管理自身依赖闭包，不碰外来 junction。
# 前端 client 模块注册 settings.section slot（id "default-model"）原生渲染分页；无需 config
# 注入——列表/保存走 llm.models RPC 与 agentDefaultModel 服务。
# v0.9.5：段3 恒渲染（hostProvider 恒开跟随宿主，无关闭选项），模板无条件标记。
# 与同目录 session-query.patch.yml 为同一 --patch overlay 机制：本模板渲染失败/缺失时
# dsh-run.js 回退挂静态 session-query.patch.yml（保底搜索）；旧 hana-theme /
# hana-provider / hana-default-model 三个分文件模板（v0.9.5 归一前的历史文件）
# 已删除，不再保留。
- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: first-search
- insert:
    - id: dsh-hana-theme
      name: 'dsh-hana-theme'
- insert:
    - id: dsh-hana-provider
      name: 'dsh-hana-provider'
      config:
        modelsPath: '{{MODELS_PATH}}'
        catalogPath: '{{CATALOG_PATH}}'
        dshPkgDir: '{{DSH_PKG_DIR}}'
- insert:
    - id: dsh-hana-default-model
      name: 'dsh-hana-default-model'
