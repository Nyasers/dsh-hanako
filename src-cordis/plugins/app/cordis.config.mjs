// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/<pkg> 自持构建描述（学官方 dsh 组织：配置随源码走）。
// 消费方：scripts/build.mjs 编排扫描本文件 → src-cordis/build/* preset 生成配置。
// 约定：本文件存在 = 该包有 service 半（index.js，rspack 打包，默认开）；client 半
// （浏览器端 client.js，tsdown closure-factory）按需声明——本包无 client 半。
// service 半输出 dist/cordis/node_modules/@dsh-hanako/<pkg>/index.js（cordis loader
// 按 package.json main=index.js 加载，具名导出保留无感知）。
export default {};
