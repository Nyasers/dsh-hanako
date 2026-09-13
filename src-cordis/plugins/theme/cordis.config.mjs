// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dshana/theme 自持构建描述（学官方 dsh 组织：配置随源码走）。
// 消费方：src-cordis/build.ts（package.json build:cordis）扫描本文件 → src-cordis/build/* preset。
// 约定：本文件存在 = 该包有 service 半（index.js，rspack 打包，默认开）；client 半
// （浏览器端 client.js，tsdown closure-factory）按需声明。
//
// 本包 client 半（client.js）= 把用户主题偏好投影到 documentElement 的
// data-dsh-theme-preference 属性，供同文档的注入桥（assets/theme-bridge.js）做跟随门判断。
// 不额外声明 externals/defines：只用 cordis 服务（inject 'theme'），无 React、无环境常量。
export default { client: {} };
