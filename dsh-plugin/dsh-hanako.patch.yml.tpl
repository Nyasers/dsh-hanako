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
        npmCliPath: '{{NPM_CLI_PATH}}'
        electronNode: '{{ELECTRON_NODE}}'
        dataDir: '{{DATA_DIR}}'
