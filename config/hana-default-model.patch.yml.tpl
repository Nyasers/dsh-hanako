# dsh-hana-default-model cordis 插件注册（v0.9.5 正规化升级）：在 dsh Web UI 设置页
# 提供「默认模型」原生渲染分页（settings.section slot，provider/model/思考强度
# 三级联动，保存即生效）。
# 注册名 = 包名 dsh-hana-default-model（非 file:// URL）——dsh client 模块发现
# （dsh-client-modules）按 loader entry 的 name 做 require.resolve('<name>/package.json')
# 找 package.json 的 dsh.client 声明 + exports["./client"]；file:// 形式无法解析
# （require.resolve 不支持 file:// scheme），包名经 $DSH_HOME/profiles/node_modules 的
# junction 解析到插件安装目录（dsh-run.js 启动前创建）。
# 本插件无需 config 注入——列表（llm.models RPC）与保存（agentDefaultModel 服务）
# 都走 RPC 与服务，不需要 modelsPath/catalogPath。
# 与 hana-theme.patch.yml.tpl / hana-provider.patch.yml.tpl 同为 dsh 启动器 --patch
# overlay 机制（现役单一模板 config/dsh-hanako.patch.yml.tpl 含本段，此文件保留作
# 参考/回退）。
- insert:
    - id: dsh-hana-default-model
      name: 'dsh-hana-default-model'