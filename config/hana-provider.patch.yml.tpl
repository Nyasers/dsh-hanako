# dsh-hana-provider cordis 插件注册（v0.9.3）：dsh 直读 Hana 宿主 provider 配置并完全跟随。
# {{HANA_PROVIDER_PLUGIN_FILE}} / {{MODELS_PATH}} / {{CATALOG_PATH}} / {{DSH_PKG_DIR}}
# 占位符由 dsh-run.js 启动前渲染为实际值（插件安装目录 file:// URL、宿主配置绝对路径、
# dsh-pkg 部署目录——依赖解析基座），渲染结果写数据目录 hana-provider.patch.generated.yml。
# 与 hana-theme.patch.yml.tpl / session-query.patch.yml 同为 dsh 启动器 --patch overlay 机制。
- insert:
    - id: dsh-hana-provider
      name: '{{HANA_PROVIDER_PLUGIN_FILE}}'
      config:
        modelsPath: '{{MODELS_PATH}}'
        catalogPath: '{{CATALOG_PATH}}'
        dshPkgDir: '{{DSH_PKG_DIR}}'
