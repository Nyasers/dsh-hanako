# dsh-hanako patch overlay（v0.9.5）：dsh 启动器 --patch 单一模板，四份 patch 合一。
# 由 dsh-run.js 启动前渲染占位符（机器绝对路径）写数据目录 dsh-hanako.patch.generated.yml，
# 渲染内容为顶层 patch 列表（顺序即应用顺序）。四段：
#   段1 session-query：会话全文搜索配置块（静态，无占位符，原样通过渲染）——dsh 上游默认
#     openAt: never 把全文搜索做成 opt-in，这里覆盖为 first-search（推迟 node:sqlite 导入
#     与句柄打开到首次搜索；索引 :memory: 进程内自会话日志重建）
#   段2 dsh-hana-theme：主题注入插件注册（{{THEME_PLUGIN_FILE}} → 插件安装目录 file:// URL）
#   段3 dsh-hana-provider：宿主 provider 跟随插件注册（{{HANA_PROVIDER_PLUGIN_FILE}} /
#     {{MODELS_PATH}} / {{CATALOG_PATH}} / {{DSH_PKG_DIR}} → 插件 file:// URL、宿主配置
#     绝对路径、dsh-pkg 部署目录——依赖解析基座）
#   段4 dsh-hana-default-model：设置页默认模型配置块插件注册（{{DEFAULT_MODEL_PLUGIN_FILE}}
#     → 插件 file:// URL；无需 config 注入——列表/保存走 llm.models RPC 与
#     agentDefaultModel 服务）
# v0.9.5：段3 恒渲染（hostProvider 恒开跟随宿主，无关闭选项），模板无条件标记。
# 与旧文件 session-query.patch.yml / hana-theme.patch.yml.tpl / hana-provider.patch.yml.tpl
# / hana-default-model.patch.yml.tpl 为同一 --patch overlay 机制；旧文件保留作渲染失败
# 回退与参考，dsh-run.js 不再引用。
- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: first-search
- insert:
    - id: dsh-hana-theme
      name: '{{THEME_PLUGIN_FILE}}'
- insert:
    - id: dsh-hana-provider
      name: '{{HANA_PROVIDER_PLUGIN_FILE}}'
      config:
        modelsPath: '{{MODELS_PATH}}'
        catalogPath: '{{CATALOG_PATH}}'
        dshPkgDir: '{{DSH_PKG_DIR}}'
- insert:
    - id: dsh-hana-default-model
      name: '{{DEFAULT_MODEL_PLUGIN_FILE}}'
