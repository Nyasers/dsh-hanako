// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/service-base.js — 受管 runtime 服务访问面（叶子模块，供 App 侧多模块共用）
//
// 从 session-run.js 拆出（cancel-chain 与 session-run 都要用、互为消费者时避免环依赖）。
//
// 形态（2026-09-11 向官方样例 hana-dsh 看齐后）：App 主进程不再直连 DSH 端口（DSH 鉴权面
// 已交回官方 connection，宿主代理剥 cookie，直连必 401），而是访问 runtime 内的中继——
// base = http://127.0.0.1:<bridgePort>，请求带 header `x-hana-dsh-bridge: <bridgeKey>`
// （中继转发时注入 DSH cookie）。中继就绪前（bridgeAccess() 为空）回落设置端口，仅供
// 启动窗口内的错误路径使用（该窗口内 RPC 本就不会被调用）。
import { appConfig } from "./app-runtime.js";
import { parseServicePort, bridgeAccess } from "./managed-runtime.js";

/** 受管 runtime 服务 base（中继就绪取中继端口，否则回落设置端口）。 */
export function serviceBase(port) {
  const access = bridgeAccess();
  if (access) return access.base;
  return "http://127.0.0.1:" + parseServicePort(port !== undefined && port !== null ? port : appConfig("servicePort"));
}

/** 包装 fetch：补中继鉴权头（bridgeKey）；中继未就绪时原样透传。 */
export function serviceFetch(fetchFn) {
  const access = bridgeAccess();
  const headers = access ? access.headers : {};
  return (url, init) => {
    const merged = { ...(init || {}) };
    merged.headers = { ...((init && init.headers) || {}), ...headers };
    return fetchFn(url, merged);
  };
}
