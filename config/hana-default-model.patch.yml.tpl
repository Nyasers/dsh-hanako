# dsh-hana-default-model cordis 插件注册（v0.9.5）：在 dsh Web UI 设置页提供
# agent-default-model 配置块（provider/model/思考强度 三级联动，保存即生效）。
# {{DEFAULT_MODEL_PLUGIN_FILE}} 占位符由 dsh-run.js 启动前渲染为实际 file:// URL
# （插件安装目录 assets/dsh-cordis/dsh-hana-default-model/index.js，随插件升级更新）。
# 本插件无需 config 注入——列表（llm.models RPC）与保存（agentDefaultModel 服务）
# 都走 RPC 与服务，不需要 modelsPath/catalogPath。
# 与 hana-theme.patch.yml.tpl / hana-provider.patch.yml.tpl 同为 dsh 启动器 --patch
# overlay 机制（现役单一模板 config/dsh-hanako.patch.yml.tpl 含本段，此文件保留作
# 参考/回退）。
- insert:
    - id: dsh-hana-default-model
      name: '{{DEFAULT_MODEL_PLUGIN_FILE}}'
