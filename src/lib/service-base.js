// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/service-base.js — 受管 runtime 服务访问面（叶子模块，供 App 侧多模块共用）
//
// 从 session-run.js 拆出（cancel-chain 与 session-run 都要用、互为消费者时避免环依赖）。
//
// 形态：App 主进程不直连 DSH 端口（DSH 鉴权面
// 已交回官方 connection，宿主代理剥 cookie，直连必 401），而是访问 runtime 内的中继——
// base = http://127.0.0.1:<bridgePort>（中继端口由父进程随机选取、随启动注册给宿主，
// 无 servicePort 设置项），请求带 header `x-hana-dsh-bridge: <bridgeKey>`
// （中继转发时注入 DSH cookie）。
import { bridgeAccess } from "./managed-runtime.js";

/**
 * 受管 runtime 服务 base = 中继地址（http://127.0.0.1:<随机中继端口>）。
 * 端口不可预设（随机），因此**没有**“就绪前回落某个端口”的分支：调用方应在
 * ensureManagedRuntime 之后取用，未就绪直接抛错，不允许拿猜出来的端口发 RPC。
 */
export function serviceBase() {
  const access = bridgeAccess();
  if (!access) {
    throw new Error("DSH 受管 runtime 中继尚未就绪（端口随启动随机分配，无预设值）——请先完成 ensureManagedRuntime。");
  }
  return access.base;
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
