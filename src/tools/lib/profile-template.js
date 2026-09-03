// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/profile-template.js — dshana profile 根文件模板单一事实源（T1 迁出）
// 从 scripts/build.mjs buildCordis 迁出：profile 根四件套不再于构建期生成——构建产物
// 只出 scope 树（dist/cordis/node_modules/@dsh-hanako/**，见 build.mjs buildCordis），
// profile 目录（$DSH_HOME/profiles/dshana）改为运行时种子化的用户自有真实目录
// （src/lifecycle.js ensureDshanaProfile → tools/lib/profile-seed.js 写入本模块常量；
// 设计见 specs/current/dshana-profile-bundle/spec.md D1/D2/D4）。模板文本跨构建/运行
// 时共享：种子幂等按「写缺失不覆盖」语义落盘，故文案即用户首次见到的文件内容。
//
// 归类说明：纯常量模块（零状态零 import，build 脚本与 lifecycle bundle 两侧均可静态
// import；无 file:// 字面量，build.mjs collectSource 静态化收集不受影响）。

// cordis.yml：空 entry 根（dsh profile 组合语义：空根上依次叠加各 bundle patch /
// profile 用户层 / home 层 / --patch overlays 组成整树）。头注释文案沿用迁出前原文
// （"Edit cordis.patch.yml" 指引仍适用于种子化后的 profile 用户层文件）。
export const PROFILE_CORDIS_YML = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`;

// pnpm-workspace.yaml：hoisted（与官方 dsh-app-boot initProfile 写入同构；用户在
// profile 目录 pnpm add 自装插件即落位 hoisted node_modules 根）。
export const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

// ---- 种子化 profile manifest（package.json，T2 种子写入）----
// 与官方 initProfile 生成的 profile manifest 同构（上游 @deepseek-ai/dsh-app-boot
// initProfile：{ name: dsh-profile-<dir>, private, dependencies: {}, dsh.profile.{
// bundles, patchReload } }，参考 packages/boot/app-boot/src/profile.ts）：name 固定
// dsh-profile-dshana，bundles = 官方 dsh-base + 本插件 bundle（@dsh-hanako/dshana）。
// patchReload: live 与官方自定义 profile 默认一致（profile 用户层与 home 层热载）。
export const PROFILE_MANIFEST_NAME = "dsh-profile-dshana";
export const PROFILE_MANIFEST_JSON = `{
  "name": "dsh-profile-dshana",
  "private": true,
  "version": "1.0.0",
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@dsh-hanako/dshana"
      ],
      "patchReload": "live"
    }
  }
}
`;

// cordis.patch.yml 用户层种子（空用户层 + 引导注释）：本文件归 profile 用户所有，
// 种子只补缺失不覆盖。layer 语义：在全部 bundle 层（dsh-base → @dsh-hanako/dshana）
// 之后按 id 逐行覆盖（后写胜出）；用户自装插件在此 insert 行，插件包落位 profile
// node_modules（pnpm add 或手工）。
export const PROFILE_USER_PATCH_YML = `# dshana profile 的用户 patch 层（$DSH_HOME/profiles/dshana/cordis.patch.yml，
# 由插件首次 boot 种子化；此后归用户所有，插件升级不覆盖）。
# 层序：本文件在全部 bundle 层（@deepseek-ai/dsh-base、@dsh-hanako/dshana）之后应用，
# 按 id 逐行覆盖，后写胜出（$DSH_HOME/cordis.patch.yml home 层对所有 profile 生效）。
# 用法：要扩展 dshana 的 cordis 插件，在下方数组中 insert 插件行；插件包需落位本
# profile 的 node_modules（pnpm add 或手工放置——pnpm-workspace.yaml 为 hoisted 形态）。
# 注意：@dsh-hanako scope 为内置插件保留区（目录链接指向插件产物 cordis 的 scope，
# 升级即更新），勿向该 scope 安装第三方包。patchReload: live 下本文件变更热载；
# 进程内 HMR 可能静默降级，稳妥生效方式 = 重启 web host。
[]
`;
