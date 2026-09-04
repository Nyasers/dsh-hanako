// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/view 自持构建描述（学官方 dsh 组织：配置随源码走）。
// 消费方：src-cordis/build.js（package.json build:cordis）扫描本文件 → src-cordis/build/* preset。
// 约定：本文件存在 = 有 service 半（index.js，rspack 打包）；client 半（browser，tsdown
// closure-factory 自注册 bundle，src-cordis/build/client-config.mjs）按需声明——
// 本包 client 半 = 装配核心（client.js 引用 vendor/ 官方 ui-layout 源码逐字副本，见 vendor/README）。
//
// externals（loader module table require 解析清单）：react 系为平台 seed；外加
// @deepseek-ai/dsh-client-store——布局 store 引擎（defineStore），官方平台模块表
// （web/src/platform.ts PLATFORM_MODULES）seed 词，与官方 ui-layout bundle 同款外部依赖。
// defines：浏览器产物无 process 全局——process.env 编译期替换（client-config.mjs 默认
// process.env={} + NODE_ENV=production）；DSH_CLIENT_TITLE 对齐官方产物（官方 client 构建
// profile 内嵌 'DeepSeek Harness'，AppFrame productTitle 以此为 product title）。
export default {
  client: {
    externals: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-store"],
    defines: {
      "process.env.DSH_CLIENT_TITLE": JSON.stringify("DeepSeek Harness"),
    },
  },
};
