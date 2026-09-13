// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/model-requests.js — 受管 runtime 内活动模型 requestId 注册表（App v2 步骤 4a）
//
// 角色：DSH session.cancel 中止回合时，provider adapter 已随流 signal abort 调
// hana.models.cancel(requestId)（步骤 3 决策 B）；但取消链（指南 §8/§9）要求显式
// models.cancel 兜底——宿主任务 canceled/aborted 反向触发 DSH cancel 时，task-bridge
// 需要知道「该会话此刻在跑哪些模型流」，才能只停本工作、不误停他人（单例 runtime 多
// 会话）。requestId 由受管 runtime 内 @dsh-hanako/provider adapter 创建/自管，task-bridge
// 与 provider 是两个 bundle（cordis 插件 vs dsh-host 入口），不能互相 import——
// 经 globalThis 同进程共享（与 __dshanaHana 同款约定）：
//
//   globalThis.__dshanaActiveModelRequests = Map<dshSessionId, Set<requestId>>
//
// provider（src-cordis/plugins/provider/index.js）流开始 add、流收尾 delete；本模块是
// 消费侧读取/定向取消助手（task-bridge 用）。键名在两侧字面一致（见 provider 注释；
// 若未来双 bundle 共用源码再抽共享模块）。
export const MODEL_REQUEST_GLOBAL_KEY = "__dshanaActiveModelRequests";

/** 读活动请求注册表（同进程 Map；缺失/异形返回 null——取消尽力而为）。 */
export function activeModelRequestMap() {
  try {
    const g = globalThis;
    const m = g && g[MODEL_REQUEST_GLOBAL_KEY];
    return m instanceof Map ? m : null;
  } catch {
    return null;
  }
}

/** 定向取消一个会话的全部活动模型流（只停该会话的 requestId；幂等）。 */
export async function cancelSessionModelRequests(hana, sessionId) {
  const map = activeModelRequestMap();
  const set = map && typeof map.get === "function" ? map.get(sessionId) : null;
  if (!set || !hana || !hana.models || typeof hana.models.cancel !== "function") return;
  for (const requestId of [...set]) {
    try {
      await hana.models.cancel(requestId);
    } catch {
      /* 单请求取消失败继续（宿主流已断等场景） */
    }
  }
}
