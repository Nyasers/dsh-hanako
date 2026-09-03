// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/settings 自持构建描述（学官方 dsh 组织：配置随源码走）。
// 消费方：src-cordis/build.js（package.json build:cordis）扫描本文件 → src-cordis/build/* preset。
// 约定：本文件存在 = 有 service 半（index.js，rspack 打包，默认开）；client 半按需
// 声明——本包有浏览器端 client（ESM 源 client.js，tsdown 打 closure-factory 自注册
// bundle，见 src-cordis/build/client-config.mjs）。
export default {
  client: {
    // loader 模块表注入 require 解析清单（external 不进包，运行时经 factory require 拿）
    externals: ["react", "react/jsx-runtime"],
  },
};
