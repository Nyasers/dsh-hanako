// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dshana/clipboard 自持构建描述（学官方 dsh 组织：配置随源码走）。
// 消费方：src-cordis/build.ts（package.json build:cordis）扫描本文件 → src-cordis/build/* preset。
// 约定：本文件存在 = 该包有 service 半（index.js，rspack 打包，默认开）；client 半
// （浏览器端 client.js，tsdown closure-factory）按需声明。
//
// 本包 client 半（client.js）= shadow navigator.clipboard.writeText：先试原生，被权限策略
// 拒了改走壳页桥（__DSHANA__.clipboardWrite → 宿主 capability clipboard.writeText）。
// 不额外声明 externals/defines：只用浏览器原生 API 与全局桥，无 cordis 服务、无 React、
// 无环境常量。service 半留空（见 index.js 文件头）。
export default { client: {} };
