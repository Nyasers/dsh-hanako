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

- id: web-app
  config:
    openBrowser: false
    printUrl: true
    surfaceContext: true
    trustedHosts:
      - '{{DSH_TRUSTED_HOST}}'
- insert:
    - id: '@dsh-hanako/transport'
      name: '@dsh-hanako/transport'