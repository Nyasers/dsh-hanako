- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: first-search
- insert:
    - id: '@dsh-hanako/logger'
      name: '@dsh-hanako/logger'
      config:
        logPath: '{{LOG_PATH}}'
- insert:
    - id: '@dsh-hanako/clipboard'
      name: '@dsh-hanako/clipboard'
- insert:
    - id: '@dsh-hanako/theme'
      name: '@dsh-hanako/theme'
- insert:
    - id: '@dsh-hanako/provider'
      name: '@dsh-hanako/provider'
      config:
        dshPkgDir: '{{DSH_PKG_DIR}}'
- insert:
    - id: '@dsh-hanako/settings'
      name: '@dsh-hanako/settings'
      config:
        dshPkgDir: '{{DSH_PKG_DIR}}'
        dataDir: '{{DATA_DIR}}'
- insert:
    - id: '@dsh-hanako/bridge'
      name: '@dsh-hanako/bridge'
      # 统一通道 WS #2 客户端：URL/TOKEN 由宿主 spawn env 注入（DSH_BRIDGE_URL /
      # DSH_BRIDGE_TOKEN，lifecycle.js ensureWebHost 启动 WS #2 后注入），无需 config。
      # 挂载即连接：http.request 帧进程内执行 dsh webServer 路由 + event 帧分发
      # （update.request / update.result 自定义消息流，替代 update-request.json 文件桥接）。
