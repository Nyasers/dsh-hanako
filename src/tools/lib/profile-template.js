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
