- id: session-query-sqlite
  config:
    path: ':memory:'
    openAt: first-search
- insert:
    - id: dsh-hana-logger
      name: 'dsh-hana-logger'
      config:
        logPath: '{{LOG_PATH}}'
- insert:
    - id: dsh-hana-clipboard
      name: 'dsh-hana-clipboard'
- insert:
    - id: dsh-hana-theme
      name: 'dsh-hana-theme'
- insert:
    - id: dsh-hana-provider
      name: 'dsh-hana-provider'
      config:
        dshPkgDir: '{{DSH_PKG_DIR}}'
- insert:
    - id: dsh-hana-settings
      name: 'dsh-hana-settings'
      config:
        dshPkgDir: '{{DSH_PKG_DIR}}'
        npmCliPath: '{{NPM_CLI_PATH}}'
        electronNode: '{{ELECTRON_NODE}}'
        dataDir: '{{DATA_DIR}}'
