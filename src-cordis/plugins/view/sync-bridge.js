// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// sync-bridge.js —— @dsh-hanako/view fpFullPanel 选中态桥（「跨边联动协议」的落地载体）。
//
// 方向（V4 单向收敛定稿，refactor/sync-unidirectional）：**sidebar → main 单向下行**。
// 同一 dsh 运行时的两个同源 3080 iframe（?dshana-view=sidebar 的 fp 侧栏 与
// ?dshana-view=main 的主页）之间，只同步「当前选中会话」，且方向唯一：
//   · sidebar 实例 = 发射端（emitter）：本地选中变化 → 广播（含启动握手 boot 宣告）；
//     不接收远端消息（桥激活时不订阅频道，核心 receive() 亦为无操作——双保险）。
//   · main 实例 = 接收端（receiver）：收到远端 select/clear → 本地 open/clear 应用；
//     不广播（本地变化不外发，receiver 是跟随方——导航源唯一在 emitter）。
//   · full（无参，宿主外等价形态）不激活桥（client.js readView 判定已排除，保持）。
//
// ── V4 → 单向收敛（动因与裁决，勿重走弯路）──
// V4（PR #70）落地的是**双向通用广播桥**（两端都订阅本地变化广播 + 接收远端应用 + 启动
// 握手 max-wins 收敛），与 view-layouts.md「跨边联动协议」原定稿的「通用广播」一致。
// 实机暴露官方竞态噪音：AgentPresetSeatController（ui-agent-preset，在会话 scope 上订阅
// sessions.list）被会话切换窗口内的任意 list.set 触发 seat.apply() → 读 inactive scope
// 抛「cannot get required service in inactive context」（uncaught in promise，功能不
// 阻断）。V4 双向桥放大触发频率：main/sidebar 两端都可能因对端消息 open → 交叉/并发
// list.set（含回声静默失败时的冗余 set），落点翻倍。用户裁定收敛方向：**只留 sidebar →
// main 单向下行**——理由：① 切换的现实源只有 sidebar（会话列表 UI 所在；main 无切换
// UI、full 是宿主外形态）；② 砍掉 main 的广播源与 sidebar 的接收路径 → 消除交叉
// list.set 的竞态放大面。收敛后列表订阅源单侧化：同一会话切换只产生 sidebar 一次
// open 的落点，main 侧为纯应用。官方 scope 销毁窗口本身仍在（见「已知边界」），本桥
// 只能降频不能根除。
// 与 view-layouts.md「通用广播」定稿的偏差及理由：原定稿「状态归属原则」末句写双向
// （主页当前会话变化 → 广播 → fp 侧栏高亮跟随）。单向收敛后该交互不存在——main 无
// 会话切换入口，其选中变化只来自数据面事件或远端应用，无需回发；spec（specs/ 不入
// git）以本文件头 + client.js 头为收敛裁决的权威记录。
//
// ── 同步面与状态归属（调研定稿，勿重走弯路）──
// 会话数据（列表/增删/重命名/workspace 范围/running）是 dsh 运行时的事实源：两端都订阅
// SessionController 事件，天然一致，不桥。只有「选中态」是纯客户端本地态（ClientSessions
// selection store → localStorage 'dsh.sessions.current'，per-iframe 独立；服务端无选中
// 广播），所以桥只同步选中态（view-layouts「状态归属原则」）。「新建会话」= 数据面 host
// 建会话 + 创建方本地 sessions.open(新 id) → 走 select 桥下行（sidebar 新建 → main
// 跟随打开；只建一个，桥不复制创建动作）。
//
// ── 挂载点选型（记录）──
// 候选 A：包装 ClientSessions.open/clear（cordis 服务反射包装）。弃用：①需要拿到并改写
// 服务实例方法，消费方（ui-workspace 注入的 open 回调等）早已把方法引用绑走，包装不可
// 靠；②同 ctx 再 reflect.provide('sessions') 有 provider 冲突语义。
// 候选 B（采用）：订阅 sessions.list store 的 current 变化（list = ClientSessions 的
// SnapshotStore 投影，current 是事实源——useSessions 标准 hook 同一数据源；open()/clear()/
// 启动 restore/reconnect resurface 全部经 manager → projectList → list.set 落到同一条
// 变化流）。桥从 ctx.sessions.list 订阅（createSnapshotStore：subscribe(fn) 无参回调，
// 侦听器自读 getSnapshot() 比对 current）。状态变化单点、无服务改写。单向收敛后此挂载
// 点不变：emitter 从订阅流取「本地变化 → 广播」，receiver 的订阅流只用于 pending 补开
// 观察 + 簿记（远端应用在收到消息时直接调 open/clear，见下）。
//
// ── 通道与消息 ──
// BroadcastChannel（同源 3080，零依赖）：官方 web 前端不用 BroadcastChannel，dsh-hanako
// 现有桥（theme/clipboard）是宿主壳页 postMessage 族，均不占名。storage 事件弃用：写方
// 不触发（localStorage 同文档不事件）且官方不监听，不如 BroadcastChannel 直接。
// 协议（v:1 自校验，非本协议消息忽略；**生产消息只有 emitter → receiver 一个方向**）：
//   { v: 1, type: 'select', sessionId }        —— 选中某会话（emitter 本地 live 变化）
//   { v: 1, type: 'clear' }                    —— 清空选中（emitter 本地清空/数据面 mask）
//   select 可带 boot:true（仅 emitter 启动握手的一次性被动宣告，见下；live 不带）
//   boot 标志在 receiver 端不再参与决策（单向无竞争端，见「启动握手」）——保留字段只为
//   消息语义自描述/调试。
//
// ── 模式拆分（createSyncCore / createSessionSyncBridge 的 mode 参数）──
// 方向用 opts.mode: 'emit' | 'receive' 表达（常量 BRIDGE_MODE_EMIT/BRIDGE_MODE_RECEIVE；
// 缺省/非法即抛错——防接线漏传方向静默成错角色）。未拆 createEmitterCore/
// createReceiverCore 双工厂：两角色共享消息校验、去重簿记与 pending/超时骨架
// （applyRemote 为 receive 专有——emit 永不应用远端），单核心 + 角色分支（列表订阅
// 按角色注册对应 handler、receive() 在 emit 端为 no-op）比两份平行实现重复更少、逐
// 分支可读。角色专有面：
//   emit：list 订阅 → 本地变化 post（首 ready 投影值 boot:true 宣告一次）；不 open/
//   clear（本端永不应用远端——若误触发说明接线错角色）。
//   receive：远端消息 → applyRemote open/clear 应用到本地流；list 订阅只做 pending
//   补开观察 + 簿记刷新；无 post 面（本地变化——数据面 mask/恢复、未来 main 本地 UI
//   动作——一律不外发：receiver 是跟随方，其本地变化不回同步 emitter，导航源唯一 =
//   emitter，该边界如实记录）。
//
// ── 防回环/值去重（单向收敛后的简化分析，记录）──
// 协议层回环面已结构性归零：emitter 不收远端（不订阅频道 + receive() no-op）、receiver
// 不发消息（无 post 调用面）——「远端 open 引发的自身 list.set」无处可回声。残余的
// 噪声/重复面与对策：
//   ① emitter 同值去重：只在自己 current ≠ 上次已广播值（sentValue）时广播。本地 open/
//      clear 同步路径经 manager.notifyNow 同步 flush → list.set → 本订阅回调同步重入；
//      异步尾（refreshSubagents 等后续同值 list.set）与用户同 id 重放都命中 sentValue
//      去重终止——不重复广播（降官方竞态触发频）。
//   ② receiver 同值短路：远端 select 目标 === 本地 current 时不 open（不制造冗余
//      list.set，直接落簿记）；远端 clear 在已空态时同样短路。pending 补开前若恢复/数据
//      面已把目标落为 current → 清 pending 不重复 open。
//   ③ isRemote 静默（V4 的 suppressToken）**结构性退役**：原语义是「远端 open/clear 应用
//      链（同步重入 list.set）不被当作本地 live 变化而回声广播」——该回声面只在「本地
//      变化会广播」的端上存在，receiver 无 post 面后无处可回声（协议层回环归零），token
//      已无分支可驱动，故删除（不再保留写而不读的占位）。语义保留处：远端应用一律走
//      applyRemote（try/catch 兜底 open 抛错），receive 端簿记只随快照对齐；receiver 端
//      本地用户动作不广播本身即无回环（main 里未来新建会话 open 也只改本端 current）。
//
// ── 启动握手（单向收敛后，时序记录）──
// 两端加载时各自从 localStorage 恢复各自选中（互不知晓对方）。桥激活后等 list phase
// 'ready'（首个 host baseline 投影）：
//   · emitter 有选中 → 广播一次 boot:true 的 select（被动宣告，不算 live 用户动作）；
//     无选中 → 不广播（空态不强加给对端 clear——emitter 空态时 receiver 保留自身恢复，
//     首次 sidebar live 动作后自然收敛，如实记录）。
//   · receiver 无宣告，被动跟随：收到 boot/live select 即 open（无条件——单向下没有
//     竞争宣告面，故去掉 V4 双端「被动期字典序 max-wins + live 优先」整套裁决：本端
//     持久化选中与 emitter 宣告不同 → 被 emitter 覆盖属预期，导航源在 emitter）。
//   时序边界（如实记录）：BroadcastChannel 无持久队列，若 receiver 晚于 emitter 的 boot
//   广播才激活（页面后加载），会错过宣告并保持自身恢复，直到 emitter 下一次 live 变化
//   才收敛。fp 宿主流中 sidebar（fp 面板嵌）晚于 main 加载，主路径安全；对立时序的
//   首次分歧可自愈，不做重问机制（协议无 request/response，设计定稿）。
//
// ── 数据面瞬时态（masked gap / 删除）──
// 列表 current 变化也可能来自数据面（当前会话被删/重连重拉瞬断）：projectList 把缺失
// current mask 为 undefined。emitter 侧此变化照常广播 clear（live 语义，幂等无害——
// receiver 同源数据面同样走向空则同值短路，先到则清空），后续 select 再次收敛。远端
// select 目标在 receiver 本端列表暂缺（如新建会话广播先于本端列表增量到达）→ pending
// 暂存，列表就绪且 byId 出现后补开（仅 receive 端需要；emitter 不收远端无此路径），
// 超时丢弃（防止为永不落地的 id 悬挂）。
//
// ── 已知边界（如实记录）──
// · 子代理（subagent child）current：子会话地址（SubagentAddress）是 per-client catalog
//   态，对端无保留地址则无法 open（ClientSessions.open → manager.select 对未知 id 抛错，
//   本桥以 byId 成员检查 + try/catch 兜底并记录），该导航面不桥（延续 view-layouts：
//   catalog/树浏览属各端浏览态）。需要时扩展 select 消息带地址 + 对端 catalog 加载。
// · 【官方竞态，待上游】AgentPresetSeatController（ui-agent-preset，seat-store/apply）在
//   会话 scope（ctx.inject ['conversation','sessions',…]）上订阅 sessions.list，任何
//   list.set（含非 current 变化的投影）都触发 seat.apply() → currentSession() 读
//   scope.sessions。会话切换时旧 scope 的 dropScope（fiber.dispose）异步，若 list.set
//   通知落在 scope 销毁窗口内 → apply 在 inactive context 读 sessions 抛
//   「cannot get required service in inactive context」（uncaught in promise，功能不阻断，
//   console 噪音）。V4 双向桥交叉 open → list.set 风暴放大触发频率；单向收敛砍掉
//   main 广播源与 sidebar 接收路径后，list.set 触发源减半（同一切换只剩 sidebar 一次
//   open 落点），该噪音**预期降频但未根除**——官方窗口仍在（任何本端 list.set 都可能
//   撞上 scope 销毁窗口），如实记录。上游修法建议：seat.apply 前 guard scope active
//   （ctx.scope.active/等效），或 effect cleanup 先退订再 dispose。本仓库不 patch 官方
//   bundle。
// · 无参 full 实例不参与桥（client.js readView 结果判定）；full 与 main/sidebar 并存时：
//   sidebar → main 照常联动，full 的选中不向外发也不接受（full = 官方等价形态，官方
//   语义即 per-window 独立选中，行为如实记录）。
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

/** 桥方向模式（createSyncCore / createSessionSyncBridge 的 opts.mode 取值）。 */
export const BRIDGE_MODE_EMIT = "emit"; // sidebar：发射端（本地变化 → 广播）
export const BRIDGE_MODE_RECEIVE = "receive"; // main：接收端（远端 → 本地 open/clear 应用）

/** 校验方向模式：缺省/非法一律抛错——防止接线漏传方向静默成错角色（方向即角色）。 */
function assertBridgeMode(mode) {
  if (mode !== BRIDGE_MODE_EMIT && mode !== BRIDGE_MODE_RECEIVE) {
    throw new Error('[dshana.sync] opts.mode must be "emit" or "receive", got: ' + String(mode));
  }
}

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
 * 选中态桥核心（单向模式状态机，与传输/存储解耦；模式拆分说明见文件头）。
 * 行为：
 *   · emit（sidebar）：本地 list.current 变化 → post select/clear（首 ready 投影值
 *     boot:true 宣告一次）；不应用远端（open/clear 回调不会被动用）。
 *   · receive（main）：远端 select/clear → applyRemote open/clear 应用并静默落簿记；
 *     不 post（本地变化不外发）；pending 补开仅此端需要。
 * @param {object} opts
 * @param {object} opts.list - SnapshotStore 面：{ subscribe(fn), getSnapshot() }。
 * @param {'emit'|'receive'} opts.mode - 方向/角色（见 assertBridgeMode）。
 * @param {(id: string) => void} [opts.open] - 本地选中（ClientSessions.open；仅 receive）。
 * @param {() => void} [opts.clear] - 本地清空（ClientSessions.clear；仅 receive）。
 * @param {(msg: object) => void} [opts.post] - 发送一条协议消息（仅 emit）。
 * @returns {{ dispose: () => void, receive: (msg: object) => void }} 销毁句柄 + 远端入口。
 */
export function createSyncCore(opts) {
  const { list, open, clear, post, mode } = opts;
  assertBridgeMode(mode);
  const RECEIVE = mode === BRIDGE_MODE_RECEIVE;
  /** list 就绪（首个 host baseline 投影）标志。 */
  let booted = false;
  /** 是否已同步过任何值（区分「从未同步」与「同步为空」）。 */
  let sentAnything = false;
  /** 已广播/已采纳的值（undefined 也是合法值；配合 sentAnything 判「从未同步」）。 */
  let sentValue = undefined;
  /** 远端 select 目标在 receive 端暂缺 → pending 补开（id + 超时；仅 receive 端）。 */
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

  /** 记下本端当前事实（簿记值），供去重与簿记对齐。 */
  function adopt(value) {
    sentAnything = true;
    sentValue = value;
  }

  function postValue(value, extra) {
    if (value === undefined) post({ v: 1, type: "clear", ...extra });
    else post({ v: 1, type: "select", sessionId: value, ...extra });
  }

  /**
   * 应用一个远端动作（receive 端；isRemote 调用链）。open/clear 同步路径触发 manager
   * notifyNow → projectList → list.set → 本订阅回调**同步重入**——V4 的 isRemote 静默
   * token 在此已结构性退役（receive 无 post 面，回声无处可发，见文件头「防回环」③），
   * 本函数保留 try/catch 兜底（open 对未知/未保留地址抛错时不打断联动主链）并负责在
   * 动作后对齐簿记。异常由调用方以动作后快照 adopt 兜底。
   * @param {() => void} action
   */
  function applyRemote(action) {
    try {
      action();
    } catch (error) {
      // ClientSessions.open 对未知/未保留地址会话抛错（manager.select 校验）；桥已按
      // byId 预检，仍可能撞 catalog 保留地址边界——忽略并如实留痕（不打断联动主链）。
      if (typeof console !== "undefined") {
        console.warn("[dshana.sync] remote apply failed:", error && error.message ? error.message : error);
      }
    }
  }

  /** pending 补开（receive 端）：目标 id 已就绪（ready + byId 命中）才真正 open。 */
  function maybeApplyPending() {
    if (pendingId === undefined || disposed) return;
    const snap = list.getSnapshot();
    if (snap.phase !== "ready") return;
    if (snap.byId === undefined || snap.byId[pendingId] === undefined) return;
    const id = pendingId;
    // 同值短路：pending 目标已被恢复/数据面先行落为 current（list.set 到达顺序竞态）→
    // 只清 pending 落簿记，不重复 open（降噪——见文件头官方竞态降频面）。
    if (currentOf(snap) === id) {
      clearPending();
      adopt(id);
      return;
    }
    clearPending();
    applyRemote(() => open(id));
    adopt(currentOf(list.getSnapshot())); // 以实际落定为准（open 抛错/mask 时保持真值）
  }

  /** 列表订阅回调——emit 端：本地变化 → 广播（含启动握手 boot 宣告）。 */
  function onListChangedEmit() {
    if (disposed) return;
    if (!booted) {
      if (list.getSnapshot().phase !== "ready") return;
      booted = true;
      // 首个 ready 投影上的值 = 持久化恢复（非用户动作）：有值 → boot:true 宣告一次；
      // 空态 → 不强加 clear（对端保留自身恢复，见文件头「启动握手」时序边界）。
      const restored = currentOf(list.getSnapshot());
      if (restored === undefined) {
        adopt(undefined);
        return;
      }
      postValue(restored, { boot: true });
      adopt(restored);
      return;
    }
    const snap = list.getSnapshot();
    const value = currentOf(snap);
    // 值去重：与上次已广播值一致 → 不广播（本地同值尾通知/用户同 id 重放终止点）。
    if (sentAnything && value === sentValue) return;
    // 本地变化（live 用户动作/新建进入/数据面 mask/清空）→ 无条件广播。
    postValue(value);
    adopt(value);
  }

  /** 列表订阅回调——receive 端：pending 补开观察 + 簿记刷新（不外发，见文件头）。 */
  function onListChangedReceive() {
    if (disposed) return;
    if (!booted) {
      if (list.getSnapshot().phase !== "ready") return;
      booted = true;
    }
    maybeApplyPending();
    // receive 端本地列表变化（远端应用链的同步重入、数据面 mask/恢复、未来本地 UI
    // 动作）一律不外发——无 post 面，回环结构性归零（V4 isRemote 静默 token 因无处
    // 回声而退役，见文件头「防回环」③）。这里只刷新簿记（远端决策均读 live 快照，
    // 簿记不参与判断，仅 _debug/对齐）。
    adopt(currentOf(list.getSnapshot()));
  }

  /**
   * 远端消息入口（BroadcastChannel message 载荷已过 v 校验）。emit 端为无操作
   * （设计：发射端不订阅频道；核心层收到也忽略——双保险，见文件头）。
   */
  function onRemoteMessage(msg) {
    if (mode === BRIDGE_MODE_EMIT) return;
    if (disposed || msg === null || typeof msg !== "object" || msg.v !== 1) return;
    if (msg.type === "select") {
      if (typeof msg.sessionId !== "string" || msg.sessionId === "") return;
      handleRemoteSelect(msg.sessionId);
      return;
    }
    if (msg.type === "clear") handleRemoteClear();
  }

  function handleRemoteSelect(id) {
    const snap = list.getSnapshot();
    const ours = currentOf(snap);
    // 单向接收：emitter 是唯一导航源，boot/live 一视同仁采纳（无 V4 双端的字典序
    // max-wins / live 优先裁决——本端没有竞争宣告面；本端持久化选中被 emitter 覆盖属
    // 预期，见文件头「启动握手」）。同值短路防冗余 open（降噪）。
    if (ours === id) {
      adopt(ours);
      return;
    }
    if (snap.phase !== "ready" || snap.byId === undefined || snap.byId[id] === undefined) {
      // 目标暂缺（新建会话广播先于本端列表增量/phase 未 ready）：pending 补开。
      clearPending();
      pendingId = id;
      pendingTimer = setTimeout(() => { clearPending(); }, PENDING_TIMEOUT_MS);
      adopt(currentOf(snap)); // current 未变：簿记随快照（pending 落定前的对齐值）
      return;
    }
    applyRemote(() => open(id));
    adopt(currentOf(list.getSnapshot())); // open 成功 = id；抛错/mask = 真值
  }

  function handleRemoteClear() {
    const snap = list.getSnapshot();
    if (currentOf(snap) === undefined) {
      // 已空态同值短路（对端数据面 mask 下行幂等无害）。
      adopt(undefined);
      return;
    }
    applyRemote(() => clear());
    adopt(currentOf(list.getSnapshot()));
  }

  // 列表订阅按角色注册对应 handler；创建后立即评估一次（list 已 ready/本插件晚激活/
  // 热载时不等下一次通知即走启动逻辑）。
  const onChange = RECEIVE ? onListChangedReceive : onListChangedEmit;
  const off = list.subscribe(onChange);
  onChange();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      off();
      clearPending();
    },
    /** 远端消息入口（浏览器载体/测试邮袋共用；emit 端 no-op）。 */
    receive: onRemoteMessage,
    // 测试/诊断内省面（非公开 API；生产不依赖）。
    _debug() {
      return { mode, booted, sentAnything, sentValue, pendingId };
    },
  };
}

// ================== 浏览器接线（@dsh-hanako/view client.js 调用）==================

/** BroadcastChannel 频道名（v:1 协议内）；单 dsh 运行时同源 3080 内广播。 */
export const SYNC_CHANNEL = "dshana.sync";

/**
 * 实例化跨边联动桥（浏览器面接线）：订阅 ctx.sessions.list + BroadcastChannel 载体。
 * 按视图角色传 mode：sidebar=BRIDGE_MODE_EMIT、main=BRIDGE_MODE_RECEIVE（client.js
 * effect 3 按 readView 结果分派）；full 不建桥。emit 端只发不收（不注册频道监听）；
 * receive 端只收不发（频道消息 → 核心应用）。
 * @param {object} ctx - 客户端 root context（已 inject 'sessions'）。
 * @param {'emit'|'receive'} mode - 方向/角色（见 assertBridgeMode）。
 * @returns {() => void} disposer。
 */
export function createSessionSyncBridge(ctx, mode) {
  assertBridgeMode(mode);
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
    mode,
    list: sessions.list,
    open: (id) => sessions.open(id),
    clear: () => sessions.clear(),
    post: (msg) => channel.post(msg),
  });
  if (mode === BRIDGE_MODE_RECEIVE) {
    // receive：频道消息 → 核心应用。emit：不订阅（发射端不收远端，见文件头）。
    channel.onMessage((msg) => core.receive(msg));
  }
  return () => {
    channel.close();
    core.dispose();
  };
}

/** BroadcastChannel 载体封装（channel 缺失/null 时静默降级）。 */
function createChannel() {
  if (typeof BroadcastChannel === "undefined") return null;
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
        if (typeof console !== "undefined") {
          console.error("[dshana.sync] message listener failed:", error);
        }
      }
    }
  };
  try {
    channel.addEventListener("message", onMessage);
  } catch (error) {
    try { channel.onmessage = onMessage; } catch { /* 双保险失败则降级 */ }
  }
  return {
    post(msg) {
      try {
        channel.postMessage(msg);
      } catch (error) {
        // 发送失败（极端环境）只记录——联动退化为单端本地语义。
        if (typeof console !== "undefined") {
          console.warn("[dshana.sync] post failed:", error && error.message ? error.message : error);
        }
      }
    },
    onMessage(listener) {
      listeners.add(listener);
    },
    close() {
      listeners.clear();
      try {
        channel.removeEventListener("message", onMessage);
      } catch { /* ignore */ }
      try { channel.close(); } catch { /* ignore */ }
    },
  };
}

// ---- settings 跨边协议预留（V4 交付 2 结论：上游不可行，见模块头）----
// 待官方提供 root 可挂 settings shell 槽位或可编程 open/close 服务后，sidebar 视图经
// 本频道发 { v:1, type:'open-settings' }，main 视图据此打开官方 settings modal。
export const OPEN_SETTINGS_MESSAGE = { v: 1, type: "open-settings" };
