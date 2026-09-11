// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/boot-state.js — dsh-hanako App v2 壳页/诊断面的 boot 状态快照与提示文案（纯函数）
//
// 消费方：ctx.routes.register 的壳页诊断面（src/routes/dshana-routes.js）与 ui/ 壳页
// （GET /api/apps/<appId>/routes/dshana/boot-state）。本模块只做「状态归一化 + 文案」，
// 不直接触达受管 runtime（由调用方注入 managedRuntimeDetails() 快照），便于单测。
//
// 受管 runtime 服务代理前缀（宿主契约实证，server 0.930.1 bundle）：
//   const Uee = "hana_app_runtime";
//   function u1e(t, e) { return `/api/apps/${encodeURIComponent(t)}/routes/_runtime/${encodeURIComponent(e)}/`; }
//   ─ 宿主在服务 readyMarker 出现后自动把受管服务暴露到该前缀（HTTP/SSE/WS 全代理 +
//     重定向 Location 重写 + hana_app_runtime HttpOnly cookie），App 的 ctx.routes 不需要
//     转发受管服务——浏览器只需把页面/API/WS 指向该前缀（迁移指南 §10）。见
//     DESIGN「步骤 4b/5 收口」的宿主实证记录。代理前缀为「路径」形态（相对同源），
//     壳页在同源下拼 `origin + proxyPrefix` 使用。
//
// 阶段（phase，来自 src/lib/managed-runtime.js 单例）：
//   idle（未启动）/ starting（启动中：runtime 拉起 + profile 种子化 + 服务监听）/ ready（就绪）/
//   error（上次启动失败，含 code+userText 供重试指引）/ stopped（已停止）
export const APP_ID = "dsh-hanako";

/** 宿主受管服务代理前缀（u1e 同形；appId/runtimeId 空值返回 null）。
 * 2026-09-11 起支持 bridgeKey：中继作为唯一服务面后，路径需带 `_hana/<key>/` 段（浏览器
 * iframe 无法自定 header，只能走路径票据）——中继据此注入 DSH cookie。 */
export function runtimeProxyPrefix({ appId = APP_ID, runtimeId, bridgeKey } = {}) {
  if (!appId || !runtimeId) return null;
  const base = `/api/apps/${encodeURIComponent(appId)}/routes/_runtime/${encodeURIComponent(runtimeId)}/`;
  return bridgeKey ? `${base}_hana/${encodeURIComponent(bridgeKey)}/` : base;
}

/** 反解析代理前缀（校验用/单测）：返回 { appId, runtimeId } 或 null。 */
export function parseRuntimeProxyPrefix(path) {
  if (typeof path !== "string") return null;
  const m = /^\/api\/apps\/([^/]+)\/routes\/_runtime\/([^/]+)\/?$/.exec(path);
  if (!m) return null;
  try {
    return { appId: decodeURIComponent(m[1]), runtimeId: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

/**
 * phase 人话文案（壳页展示 + 诊断）。reason/errText 为调用方传入的补充。
 * errText 已含用户可读指引（managed-runtime 的 START_ERROR_HINTS 经 Error.message 携带）。
 */
export function phaseCopy(phase, { ready = false, errText = null } = {}) {
  switch (phase) {
    case "ready":
      return ready
        ? "DSH 已就绪：Web 服务可访问（可通过本页 iframe 或直接在会话中使用 dshana_session）。"
        : "DSH runtime 进程已存在，但服务尚未报告就绪，正在确认监听状态……";
    case "starting":
      return "DSH 正在启动（受管 runtime 拉起、profile 种子化、服务监听）……";
    case "idle":
      return "DSH 尚未启动。App 加载后会自动拉起受管 runtime；也可点下方「启动 DSH」手动触发。";
    case "error":
      return errText
        ? "DSH 启动失败：" + errText
        : "DSH 启动失败（无详细错误）。可点「启动 DSH」重试；持续失败请看日志。";
    case "stopped":
      return "DSH 已停止（用户或卸载流程触发）。再次 create/send 或点「启动 DSH」可重新启动。";
    default:
      return "未知状态：" + String(phase);
  }
}

/**
 * 归一化 boot 状态快照（壳页 JSON 契约单一出口）。details 形如 managedRuntimeDetails()
 * 的返回值：{ phase, runtimeId, info?, lastError? }（info = runtime.get 最近轮询记录，
 * lastError = Error 实例或 { code, message }）。返回纯数据对象：
 * {
 *   phase, ready, runtimeId, proxyPrefix, service, error:{code,userText}|null,
 *   note, updatedAt
 * }
 * 注（spec §8 j）：App 侧文件日志已退役，快照不再携带 logPath/logTail（诊断看宿主日志 +
 * 受管 runtime 状态：phase/error/userText）。
 */
export function buildBootSnapshot(details, { bridgeKey = null } = {}) {
  const d = details && typeof details === "object" ? details : {};
  const phase = typeof d.phase === "string" ? d.phase : "idle";
  const runtimeId = typeof d.runtimeId === "string" && d.runtimeId ? d.runtimeId : null;
  const info = d.info && typeof d.info === "object" ? d.info : null;
  const service = info && info.service && typeof info.service === "object" ? info.service : null;
  const serviceReady = Boolean(service && service.state === "ready");
  const ready = phase === "ready" && Boolean(runtimeId) && serviceReady;
  let error = null;
  const rawErr = d.lastError;
  if (rawErr) {
    const errObj = rawErr instanceof Error ? rawErr : rawErr && typeof rawErr === "object" ? rawErr : null;
    if (errObj) {
      const message = (errObj.message || String(errObj)).trim();
      error = {
        code: typeof errObj.code === "string" && errObj.code ? errObj.code : "unknown",
        userText: message || "启动失败（无详细错误）",
      };
    }
  }
  // 代理前缀只在「服务真正就绪」后给出：phase/runtimeId 本身不代表宿主已暴露代理
  // （宿主在 readyMarker 出现后才发布服务），UI 绝不提前指向死端点。
  const proxyPrefix = ready ? runtimeProxyPrefix({ runtimeId, bridgeKey }) : null;
  return {
    phase,
    ready,
    runtimeId,
    proxyPrefix,
    service: service ? { state: service.state, port: typeof service.port === "number" ? service.port : null } : null,
    error,
    note: phaseCopy(phase, { ready, errText: error ? error.userText : null }),
    updatedAt: new Date().toISOString(),
  };
}

/** 快照深度等价（单测/断言用，忽略时间戳）。 */
export function stripSnapshotMeta(snapshot) {
  const s = { ...snapshot };
  delete s.updatedAt;
  return s;
}
