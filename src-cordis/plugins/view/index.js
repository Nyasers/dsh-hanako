// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/view — dsh Web UI 视图装配插件（host 半部）。
//
// fpFullPanel V1 装配者替换：官方 ui-layout 的「root 装配者」角色由本插件接管——
// 官方 AppFrame（完整三列视图）改为由本插件注册进 root 槽，layout 服务（ctx.layout）
// 改由本插件 provide，浏览器端装配全在 client 半（package.json exports["./client"] →
// client.js，cordis client 插件规范）。host 半无行为（同官方 ui-layout host apply：
// index.ts 即空 apply——装配是纯浏览器职责），保留空 apply 仅满足 cordis host 插件面。
//
// 本文件为 rspack service 半 entry（src-cordis/build.js → service-config.mjs）：node
// ESM bundle 保留 name/inject/apply 具名导出即被 cordis loader 无感加载。

export const name = "@dsh-hanako/view";

/** host 半零服务依赖（装配无宿主行为；client 半 inject 见 client.js） */
export const inject = [];

/** host 半空操作：V1 装配 = client 半职责（view 参数路由、layout 服务、root 注册）。 */
export function apply() {
  /* 无操作——浏览器端装配见 ./client.js */
}
