# dsh-hana-theme cordis 插件注册（v0.8.1）：把 Hana 宿主主题注入 dsh Web UI。
# {{THEME_PLUGIN_FILE}} 占位符由 dsh-run.js 启动前渲染为实际 file:// URL
# （插件安装目录 assets/dsh-cordis/dsh-hana-theme/index.js，随插件升级更新）。
# 与 session-query.patch.yml 同为 dsh 启动器 --patch overlay 机制。
- insert:
    - id: dsh-hana-theme
      name: '{{THEME_PLUGIN_FILE}}'
