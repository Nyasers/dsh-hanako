// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// sync-bridge.js —— @dsh-hanako/view fpFullPanel V4「跨边联动协议」的选中态桥实现。
//
// 目标（view-layouts.md「跨边联动协议」定稿）：同一 dsh 运行时的两个同源 3080 iframe
// （?dshana-view=sidebar 的 fp 侧栏 与 ?dshana-view=main 的主页）跨边同步「当前选中
// 会话」。本模块是唯一联动载体，由 client.js 按视图实例化；无参 full 视图（官方等价/
// 宿主外调试形态）不激活桥。
//
// ── 同步面与状态归属（调研定稿，勿重走弯路）──
// 会话数据（列表/增删/重命名/workspace 范围/running）是 dsh 运行时的事实源：两端都订阅
// SessionController 事件，天然一致，不桥。只有「选中态」是纯客户端本地态（ClientSessions
// selection store → localStorage 'dsh.sessions.current'，per-iframe 独立；服务端无选中
// 广播），所以桥只同步选中态（view-layouts「状态归属原则」）。「新建会话」= 数据面 host
// 建会话 + 创建方本地 sessions.open(新 id) → 走 select 桥（只建一个，桥不复制创建动作）。
//
// ── 挂载点选型（记录）──
// 候选 A：包装 ClientSessions.open/clear（cordis 服务反射包装）。弃用：①需要拿到并改写
// 服务实例方法，消费方（ui-workspace 注入的 open 回调等）早已把方法引用绑走，包装不可
// 靠；②同 ctx 再 reflect.provide('sessions') 有 provider 冲突语义。
// 候选 B（采用）：订阅 sessions.list store 的 current 变化（list = ClientSessions 的
// SnapshotStore 投影，current 是事实源——useSessions 标准 hook 同一数据源；open()/clear()/
// 启动 restore/reconnect resurface 全部经 manager → projectList → list.set 落到同一条
// 变化流）。桥从 ctx.sessions.list 订阅（createSnapshotStore：subscribe(fn) 无参回调，
// 侦听器自读 getSnapshot() 比对 current），本地 current 变化即广播；远端消息到来调本地
// sessions.open(id)/sessions.clear() 应用到同一条流。状态变化单点、无服务改写。
//
// ── 通道与消息 ──
// BroadcastChannel（同源 3080，零依赖）：官方 web 前端不用 BroadcastChannel，dsh-hanako
// 现有桥（theme/clipboard）是宿主壳页 postMessage 族，均不占名。storage 事件弃用：写方
// 不触发（localStorage 同文档不事件）且官方不监听，不如 BroadcastChannel 直接双向。
// 协议（v:1 自校验，非本协议消息忽略）：
//   { v: 1, type: 'select', sessionId }        —— 选中某会话
//   { v: 1, type: 'clear' }                    —— 清空选中（无会话视图）
//   select 消息可带 boot:true（仅「启动握手」的被动宣告，见下；真实用户动作不带）
//
// ── 防回环（记录）──
// 双层：①值去重——本端只在自己 current ≠ 上次已广播值（sentValue）时广播；任何收到的
// 冗余回声在两端都命中去重而终止。②远端应用静默化——把「远端消息引发的 open/clear」包进
// suppressToken（isRemote 调用链标志），期间列表变化只采纳（adopt sentValue）不广播。
// open/clear 同步路径经 manager.notifyNow 同步 flush → projectList → list.set → 本订阅
// 回调**同步重入**（sessions/notifier.ts 已证实；list 订阅在 set 内同步回调），故 token 在
// 动作返回时**同步清掉**即可覆盖整个回环链；异步尾（refreshSubagents 等后续同值 list.set）
// 由值去重兜底。token 不拖到微任务——同步窗口外不应抑制独立本地动作。
//
// ── 启动握手（时序，记录）──
// 两端加载时各自 localStorage 恢复各自选中（互不知晓对方）。桥激活后等待 list phase
// 'ready'（首个 host baseline 投影），之后：
//   · 本端有选中 → 广播一次 boot:true 的 select（被动宣告，不算 live 用户动作）；
//   · 本端无选中 → 不广播（空态不强加给对端 clear）。
// 握手竞态（双方同时被动宣告不同选中）：boot:true 消息在接收端仍处于被动期（本端从未
// 做过 live 用户动作）时按「id 字典序 max-wins」采纳（两独立实例无全局时钟，字典序给一个
// 确定性收敛；空态端直接采纳对方宣告）；一旦任一端发生过真实用户动作（live=true），此后
// boot 宣告一律忽略（真实动作优先），一切真实消息无条件采纳——顺序真实动作 last-writer。
// 对端已被采纳的 boot 值引发的自身变化在 suppressToken 内静默，不回弹。收敛后两端一致。
//
// ── 数据面瞬时态（masked gap / 删除）──
// 列表 current 变化也可能来自数据面（当前会话被删/重连重拉瞬断）：projectList 把缺失
// current mask 为 undefined → 本端会广播 clear，对端 applyRemote(clear)。幂等无害
// （对端同源数据面同样走向空/回弹），后续 select 再次收敛。远端 select 目标在本端列表
// 暂缺（如新建会话广播先于本端列表增量到达）→ pending 暂存，列表就绪且 byId 出现后补开，
// 超时丢弃（防止为永不落地的 id 悬挂）。
//
// ── 已知边界（如实记录）──
// · 子代理（subagent child）current：子会话地址（SubagentAddress）是 per-client catalog
//   态，对端无保留地址则无法 open（ClientSessions.open → manager.select 对未知 id 抛错，
//   本桥以 byId 成员检查 + try/catch 兜底并记录），该导航面不桥（延续 view-layouts：
//   catalog/树浏览属各端浏览态）。需要时扩展 select 消息带地址 + 对端 catalog 加载。
// · 无参 full 实例不参与桥（client.js readView 结果判定）；full 与 main/sidebar 并存时：
//   main/sidebar 之间照常联动，full 的选中不向外发也不接受（full = 官方等价形态，
//   官方语义即 per-window 独立选中，行为如实记录）。
// · BroadcastChannel 按 origin+name 广播：127.0.0.1:3080 单 dsh 运行时内安全；同端口
//   不可并存第二运行时（绑定冲突），跨 profile/跨端口不同源不串扰。
//
// ── settings 跨边（V4 设计第 4 项）调研结论（记录，详见交付 2）──
// ui-settings-general（sidebar.settings occupant）的 trigger → modal（1080x700）打开是
// SettingsRoot 组件内 useState 本地态，无服务/事件/store 可编程打开；shell 仅存在于
// ui-sidebar occupant 子树内（main 视图 V3 无侧栏 → occupant 不挂载，无宿主）；槽规则
// （ui-slots：slot key 全局限单声明者；single occupant 同 priority 二次注册抛；shadow
// occupant 子槽声明与官方重复即抛）封死所有干净拦截面。→ V4 落地 settings 跨边不可行，
// 记为待上游支持。本模块预留 open-settings 消息形态常量，待官方提供 root 可挂 settings
// shell 槽位或可编程 open 服务后启用（见 OPEN_SETTINGS_MESSAGE）。
//
// ================== 纯核心（可 node 单测，见 tests/sync-bridge.test.mjs）==================

const PENDING_TIMEOUT_MS = 10000;

/**
 * 校验并规范化当前列表快照的选中值：current 有效（在 byId 中）才有选中。
 * @param {object} snap - sessions.list.getSnapshot() 的返回。
 * @returns {string | undefined} 当前会话 id（masked/空 = undefined）。
 */
function currentOf(snap) {
  const current = snap.current;
  if (current === undefined || snap.byId === undefined || snap.byId[current] === undefined) return undefined;
  return current;
}

/**
 * 选中态桥核心：与传输/存储解耦的状态机（挂载点选型 B，见文件头）。
 * 行为：本地 list.current 变化广播；远端 select/clear 应用到本地并静默；
 * 启动握手（boot:true 被动宣告 + 被动期字典序 max-wins）；pending 补开。
 * @param {object} opts
 * @param {object} opts.list - SnapshotStore 面：{ subscribe(fn), getSnapshot() }。
 * @param {(id: string) => void} opts.open - 本地选中（ClientSessions.open）。
 * @param {() => void} opts.clear - 本地清空（ClientSessions.clear）。
 * @param {(msg: object) => void} opts.post - 发送一条协议消息。
 * @returns {{ dispose: () => void }} 销毁句柄。
 */
export function createSyncCore(opts) {
  const { list, open, clear, post } = opts;
  /** list 就绪（首个 host baseline 投影）标志。 */
  let booted = false;
  /** 是否发生过真实本地用户动作（此后 boot 宣告作废、真实消息无条件采纳）。 */
  let live = false;
  /** 是否已同步过任何值（区分「从未同步」与「同步为空」）。 */
  let sentAnything = false;
  /** 本端已广播/已采纳的值（undefined 也是合法值；配合 sentAnything 判「从未同步」）。 */
  let sentValue = undefined;
  /** isRemote 防回环 token：远端 open/clear 应用链上非空，期间列表变化只采纳不广播。 */
  let suppressToken = null;
  /** 远端 select 目标在本端暂缺 → pending 补开（id + 超时）。 */
  let pendingId = undefined;
  let pendingTimer = undefined;
  let disposed = false;

  function clearPending() {
    if (pendingTimer !== undefined) {
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
    }
    pendingId = undefined;
  }

  /** 记下本端当前事实（同步完成值），供去重与后续变化比较。 */
  function adopt(value) {
    sentAnything = true;
    sentValue = value;
  }

  function postValue(value, extra) {
    if (value === undefined) post({ v: 1, type: 'clear', ...extra });
    else post({ v: 1, type: 'select', sessionId: value, ...extra });
  }

  /**
   * 应用一个远端动作（isRemote 调用链）。open/clear 同步路径触发 manager
   * notifyNow → projectList → list.set → 本订阅回调**同步重入**，在 token 下静默采纳。
   * token 在动作返回时**同步清掉**（链是同步的；异步尾由值去重兜底——远端 open 触发的
   * refreshSubagents 等后续 list.set 携带同一 current，命中 sentValue 去重不再广播）。
   * 不能拖到微任务再清：会把抑制窗口延伸到同 tick 的独立本地动作（实机跨任务天然隔开，
   * 但同步窗口内应精确限定在本次远端应用）。
   * @param {() => void} action
   */
  function applyRemote(action) {
    suppressToken = {};
    try {
      action();
    } catch (error) {
      // ClientSessions.open 对未知/未保留地址会话抛错（manager.select 校验）；桥已按
      // byId 预检，仍可能撞 catalog 保留地址边界——忽略并如实留痕（不打断联动主链）。
      if (typeof console !== 'undefined') {
        console.warn('[dshana.sync] remote apply failed:', error && error.message ? error.message : error);
      }
    } finally {
      suppressToken = null;
    }
  }

  /** pending 补开：目标 id 已就绪（ready + byId 命中）才真正 open。 */
  function maybeApplyPending() {
    if (pendingId === undefined || disposed) return;
    const snap = list.getSnapshot();
    if (snap.phase !== 'ready') return;
    if (snap.byId === undefined || snap.byId[pendingId] === undefined) return;
    const id = pendingId;
    clearPending();
    applyRemote(() => open(id));
    adopt(currentOf(list.getSnapshot())); // 以实际落定为准（open 抛错/mask 时保持真值）
  }

  /** 列表订阅回调（createSnapshotStore subscribe 无参回调，侦听器自读快照）。 */
  function onListChanged() {
    if (disposed) return;
    const snap = list.getSnapshot();
    maybeApplyPending();
    const firstReady = !booted;
    if (!booted) {
      if (snap.phase !== 'ready') return;
      booted = true;
    }
    const value = currentOf(snap);
    // 值去重：与上次已同步值一致 → 不广播（含对端冗余回声终止点）。
    if (sentAnything && value === sentValue) return;
    if (suppressToken !== null) {
      // isRemote 链上变化：静默采纳（对端会自行广播，本端不回弹）。
      adopt(value);
      return;
    }
    if (firstReady) {
      // 首个 ready 投影上的值 = 持久化恢复（非用户动作），分类看 tick 而非 sentAnything：
      // 即便此前 adopt(undefined)/pending 已置 sentAnything，也不把恢复误标成真实动作。
      if (pendingId !== undefined) { adopt(value); return; } // 有远端 pending 待补开：不宣告
      if (value === undefined) { adopt(value); return; } // 空态：不强加 clear
      postValue(value, { boot: true }); // 启动握手：boot:true 被动宣告一次
      adopt(value);
      return;
    }
    // 真实本地变化（用户点击/新建进入/清空）→ live + 无条件广播。
    live = true;
    postValue(value);
    adopt(value);
  }

  /** 远端消息入口（BroadcastChannel message 载荷已过 v 校验）。 */
  function onRemoteMessage(msg) {
    if (disposed || msg === null || typeof msg !== 'object' || msg.v !== 1) return;
    if (msg.type === 'select') {
      if (typeof msg.sessionId !== 'string' || msg.sessionId === '') return;
      handleRemoteSelect(msg.sessionId, msg.boot === true);
      return;
    }
    if (msg.type === 'clear') handleRemoteClear(msg.boot === true);
  }

  function handleRemoteSelect(id, boot) {
    const snap = list.getSnapshot();
    const ours = currentOf(snap);
    if (boot) {
      // 启动握手宣告：真实动作优先——本端已 live 则旧宣告作废；
      // 被动期双宣告 → id 字典序 max-wins 确定性收敛。
      if (live) return;
      if (ours !== undefined && !(id > ours)) return;
    } else if (ours === id) {
      adopt(ours);
      return;
    }
    if (snap.phase !== 'ready' || snap.byId === undefined || snap.byId[id] === undefined) {
      // 目标暂缺（新建会话广播先于本端列表增量）：pending 补开。
      clearPending();
      pendingId = id;
      pendingTimer = setTimeout(() => { clearPending(); }, PENDING_TIMEOUT_MS);
      if (boot && ours !== undefined) adopt(ours); // 未采纳，保留本端事实
      else if (!sentAnything) adopt(undefined); // 无既有值：pending 落定前按空态对齐
      return;
    }
    applyRemote(() => open(id));
    adopt(currentOf(list.getSnapshot())); // open 成功 = id；抛错/mask = 真值
  }

  function handleRemoteClear(boot) {
    if (boot) return; // 握手从不发 clear（空态不强加）；防御性忽略。
    const snap = list.getSnapshot();
    if (currentOf(snap) === undefined) {
      adopt(undefined);
      return;
    }
    applyRemote(() => clear());
    adopt(currentOf(list.getSnapshot()));
  }

  const off = list.subscribe(onListChanged);
  // 启动立即评估一次：list 已 ready（本插件晚激活/热载）时不等下一次通知即握手。
  onListChanged();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      off();
      clearPending();
      suppressToken = null;
    },
    /** 远端消息入口（浏览器载体/测试邮袋共用）。 */
    receive: onRemoteMessage,
    // 测试/诊断内省面（非公开 API；生产不依赖）。
    _debug() {
      return { booted, live, sentAnything, sentValue, pendingId };
    },
  };
}

// ================== 浏览器接线（@dsh-hanako/view client.js 调用）==================

/** BroadcastChannel 频道名（v:1 协议内）；单 dsh 运行时同源 3080 内广播。 */
export const SYNC_CHANNEL = 'dshana.sync';

/**
 * 实例化跨边联动桥（浏览器面接线）：订阅 ctx.sessions.list + BroadcastChannel 载体。
 * 仅 main/sidebar 视图激活（client.js 按 readView 结果调用）；full 不建桥。
 * @param {object} ctx - 客户端 root context（已 inject 'sessions'）。
 * @returns {() => void} disposer。
 */
export function createSessionSyncBridge(ctx) {
  const sessions = ctx.sessions;
  if (sessions === undefined || sessions.list === undefined) {
    // sessions 服务未就绪理论上不发生（inject 'sessions' 已等 provider）；
    // 防御性降级 = 无联动（等同 full 视图语义），不抛。
    return () => {};
  }
  const channel = createChannel();
  if (channel === null) {
    // 无 BroadcastChannel 环境（node e2e 等）：桥不激活。
    return () => {};
  }
  const core = createSyncCore({
    list: sessions.list,
    open: (id) => sessions.open(id),
    clear: () => sessions.clear(),
    post: (msg) => channel.post(msg),
  });
  channel.onMessage((msg) => core.receive(msg));
  return () => {
    channel.close();
    core.dispose();
  };
}

/** BroadcastChannel 载体封装（channel 缺失/null 时静默降级）。 */
function createChannel() {
  if (typeof BroadcastChannel === 'undefined') return null;
  let channel;
  try {
    channel = new BroadcastChannel(SYNC_CHANNEL);
  } catch (error) {
    return null;
  }
  const listeners = new Set();
  const onMessage = (event) => {
    for (const listener of [...listeners]) {
      try {
        listener(event && event.data);
      } catch (error) {
        // 单个侦听器失败不影响其余（官方 notifySubscribers 同款纪律）。
        if (typeof console !== 'undefined') {
          console.error('[dshana.sync] message listener failed:', error);
        }
      }
    }
  };
  try {
    channel.addEventListener('message', onMessage);
  } catch (error) {
    try { channel.onmessage = onMessage; } catch { /* 双保险失败则降级 */ }
  }
  return {
    post(msg) {
      try {
        channel.postMessage(msg);
      } catch (error) {
        // 发送失败（极端环境）只记录——联动退化为单端本地语义。
        if (typeof console !== 'undefined') {
          console.warn('[dshana.sync] post failed:', error && error.message ? error.message : error);
        }
      }
    },
    onMessage(listener) {
      listeners.add(listener);
    },
    close() {
      listeners.clear();
      try {
        channel.removeEventListener('message', onMessage);
      } catch { /* ignore */ }
      try { channel.close(); } catch { /* ignore */ }
    },
  };
}

// ---- settings 跨边协议预留（V4 交付 2 结论：上游不可行，见模块头）----
// 待官方提供 root 可挂 settings shell 槽位或可编程 open/close 服务后，sidebar 视图经
// 本频道发 { v:1, type:'open-settings' }，main 视图据此打开官方 settings modal。
export const OPEN_SETTINGS_MESSAGE = { v: 1, type: 'open-settings' };
