// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/sync-bridge.test.mjs —— fpFullPanel V4 单向收敛后选中态桥（sync-bridge.js）核心
// 态机单测。零依赖：Node 内置 node:test + node:assert（同 errclass.test.mjs 纪律——
// 验收命令 node --test tests/ 自动发现）。
//
// 被测面 = createSyncCore（纯状态机，传输/存储解耦注入；mode: 'emit' | 'receive'）：
//   · 单向角色边界：sidebar(emit) 本地变化 → 广播 → main(receive) 应用 open/clear；
//     receiver 本地变化/数据面变化零外发；emitter 不接收远端（receive() no-op）；
//   · 启动握手（单源收敛）：emitter 恢复选中 boot:true 宣告 → receiver 空态采纳 /
//     持久化不同选中被覆盖（导航源在 emitter）；空态 emitter 不强加 clear；
//   · 值去重：emitter 同值尾通知/同 id 重放不重复广播；receiver 同值远端（live/boot）
//     不重复 open；
//   · pending 补开（仅 receive）：远端 select 目标本端暂缺 → ready + byId 出现后补开；
//     恢复先行落定（同值）→ 不重复 open；
//   · clear 下行与再收敛；数据面删除 current（mask）幂等回空；
//   · open 抛错（catalog 未知地址兜底）不炸桥；非协议消息忽略；dispose 停摆；
//   · mode 校验（缺省/非法抛错——防接线漏传角色）；接线层降级/真 channel（emit/receive）。
// 浏览器接线（BroadcastChannel 载体/ctx.sessions 注入）属宿主实机验证面，此处不 mock。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BRIDGE_MODE_EMIT,
  BRIDGE_MODE_RECEIVE,
  createSyncCore,
  createSessionSyncBridge,
  SYNC_CHANNEL,
} from "../src-cordis/plugins/view/sync-bridge.js";

/** 最小 SnapshotStore 面（模拟 createSnapshotStore 默认 sync flush：set 同步通知）。 */
function makeSessions(initialIds = []) {
  const byId = {};
  for (const id of initialIds) byId[id] = { id };
  let phase = "pending";
  let current;
  const listeners = new Set();
  const list = {
    getSnapshot: () => ({ phase, byId, current }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
  const notify = () => { for (const fn of [...listeners]) fn(); };
  return {
    list,
    /** 模拟首个 host baseline 落库（pending → ready，可携持久化恢复 current）。 */
    ready(ids, restored) {
      for (const id of ids) byId[id] = { id };
      phase = "ready";
      if (restored !== undefined && byId[restored] !== undefined) current = restored;
      notify();
    },
    /** 数据面增量：会话在 host 出现（新建/恢复），与选择无关。 */
    arrive(id) {
      byId[id] = { id };
      notify();
    },
    /** 数据面删除：行移除；若为当前会话则 current mask 回 undefined（projectList 语义）。 */
    remove(id) {
      delete byId[id];
      if (current === id) { current = undefined; notify(); }
      else notify();
    },
    /** 用户动作入口（真实链路 = ui 经 sessions.open 直达服务，桥只旁听 list）。 */
    open(id) {
      if (byId[id] === undefined) throw new Error("sessions.select: unknown session " + id);
      current = id;
      notify();
    },
    clear() {
      current = undefined;
      notify();
    },
    current() { return current; },
    has(id) { return byId[id] !== undefined; },
  };
}

/**
 * sidebar(emit) → main(receive) 单向直连邮袋。角色边界用 throw stub 硬断言：
 *   · emit 核心的 open/clear 若被调用（= emit 误应用远端）→ 抛错；
 *   · receive 核心的 post 若被调用（= receive 误广播本地变化）→ 抛错。
 * 用户级动作直达 sessions store（真实 ui 路径，桥只旁听 list），不经核心回调。
 */
function makeOneWay() {
  const bus = { posts: [], queued: [] };
  const eS = makeSessions(); // sidebar（发射端）sessions
  const rS = makeSessions(); // main（接收端）sessions
  const remoteOpens = [];
  const remoteClears = [];
  const emit = {
    sessions: eS,
    core: createSyncCore({
      mode: BRIDGE_MODE_EMIT,
      list: eS.list,
      open: () => { throw new Error("emit core must not apply remote open"); },
      clear: () => { throw new Error("emit core must not apply remote clear"); },
      post: (msg) => { bus.posts.push(msg); bus.queued.push(msg); },
    }),
    _receive: (msg) => { /* 经核心 receive()（no-op 断言面） */ },
  };
  const receive = {
    sessions: rS,
    core: createSyncCore({
      mode: BRIDGE_MODE_RECEIVE,
      list: rS.list,
      open: (id) => { remoteOpens.push(id); rS.open(id); },
      clear: () => { remoteClears.push(1); rS.clear(); },
      post: () => { throw new Error("receive core must not broadcast local changes"); },
    }),
    _receive: (msg) => receive.core.receive(msg),
  };
  emit._receive = (msg) => emit.core.receive(msg);
  function deliver(max = 40) {
    let rounds = 0;
    while (bus.queued.length > 0 && rounds < max) {
      rounds += 1;
      while (bus.queued.length > 0) receive._receive(bus.queued.shift());
    }
    assert.ok(bus.queued.length === 0, "bus did not quiesce within " + max + " rounds (echo loop?)");
  }
  return {
    eS, rS, emit, receive, remoteOpens, remoteClears,
    posts: bus.posts,
    currentE: () => eS.current(),
    currentR: () => rS.current(),
    deliver,
  };
}

const flush = () => new Promise((resolve) => { queueMicrotask(resolve); });
const bootFlags = (posts) => posts.filter((m) => m.type === "select")
  .map((m) => ({ id: m.sessionId, boot: m.boot === true }));

test("单向角色：sidebar(emit) 本地选会话 → main(receive) open 跟随；receiver 本地变化不外发", async () => {
  const h = makeOneWay();
  h.eS.ready(["s1", "s2", "s3"]);
  h.rS.ready(["s1", "s2", "s3"]);
  h.deliver();
  assert.equal(h.posts.length, 0, "双端空态：emitter 无 boot 宣告");
  assert.deepEqual(h.remoteOpens, []);

  h.eS.open("s1"); // sidebar 用户点击（真实 ui 路径直达 sessions）
  h.deliver();
  assert.equal(h.currentR(), "s1", "main 跟随 sidebar 选中");
  assert.equal(h.currentE(), "s1");
  assert.deepEqual(h.remoteOpens, ["s1"], "main 恰好应用一次 open");
  assert.equal(h.posts.length, 1, "emitter 广播一次 select s1（boot:false live）");
  assert.deepEqual(bootFlags(h.posts), [{ id: "s1", boot: false }]);
  await flush();

  // main 本地选中变化（如未来 main 本地 UI 动作）：自身生效、不外发、不影响 sidebar。
  h.rS.open("s2");
  h.deliver();
  assert.equal(h.currentR(), "s2", "main 本地变化自身生效（跟随方本地态）");
  assert.equal(h.currentE(), "s1", "sidebar 不受 main 本地变化影响");
  assert.equal(h.posts.length, 1, "receive 零外发：sidebar 侧无新消息");
});

test("main(receive) 零外发边界：本地 open/clear/mask 均不触发 post（throw stub 断言）", () => {
  const h = makeOneWay();
  h.eS.ready(["s1", "s2"], "s1"); // boot select s1 已入邮袋
  h.rS.ready(["s1", "s2"], "s1");
  h.deliver(); // main 恢复同值 → boot select 同值短路，不重复 open
  assert.equal(h.currentR(), "s1");
  assert.deepEqual(h.remoteOpens, []);
  // receive 端本地路径：open/clear/mask——任何一次误 post 都会让核心抛错。
  h.rS.clear();
  h.rS.open("s2");
  h.rS.remove("s2");
  h.deliver();
  assert.equal(h.currentR(), undefined, "main 本地数据面 mask 落空");
  assert.equal(h.currentE(), "s1");
  assert.equal(h.posts.length, 1, "sidebar 侧只有自己的 boot 宣告，无任何回声");
});

test("sidebar(emit) 不接收远端：live/boot select/clear/脏消息一律忽略且不回显", () => {
  const h = makeOneWay();
  // 本测试不投递 boot 到 receiver（其未 ready，投递只会给对端 arm 一个永不落定的
  // pending 计时器）；只验 emitter 端 ignore 语义——boot 留在邮袋里不影响断言。
  h.eS.ready(["s1", "s2"], "s1"); // boot select s1
  const postsBefore = h.posts.length;
  h.emit._receive({ v: 1, type: "select", sessionId: "s2" });
  h.emit._receive({ v: 1, type: "select", sessionId: "s2", boot: true });
  h.emit._receive({ v: 1, type: "clear" });
  h.emit._receive({ v: 1, type: "mystery" });
  h.emit._receive("garbage");
  assert.equal(h.currentE(), "s1", "emitter 选中不受远端消息影响");
  assert.equal(h.posts.length, postsBefore, "emitter 不因远端消息回显广播");
});

test("启动握手：sidebar 恢复选中 boot 宣告 → main 空态采纳并 open", async () => {
  const h = makeOneWay();
  h.eS.ready(["restored"], "restored");
  assert.deepEqual(bootFlags(h.posts), [{ id: "restored", boot: true }], "emitter 发 boot:true 宣告");
  h.rS.ready(["restored"]); // 同一运行时两端列表同；main 空态
  assert.equal(h.posts.length, 1, "receiver 无宣告（被动跟随）");
  h.deliver();
  await flush();
  assert.equal(h.currentR(), "restored", "main 采纳 emitter 恢复宣告");
  assert.deepEqual(h.remoteOpens, ["restored"]);
});

test("握手收敛：receiver 持久化选中被 emitter 宣告覆盖（导航源唯一）；空态 emitter 不强加 clear", () => {
  // main 自身恢复 beta ≠ sidebar 恢复 alpha → 收敛到 emitter(导航源) 的 alpha。
  const h1 = makeOneWay();
  h1.eS.ready(["alpha", "beta"], "alpha");
  h1.rS.ready(["alpha", "beta"], "beta");
  h1.deliver();
  assert.equal(h1.currentR(), "alpha", "receiver 持久化选中被 emitter 宣告覆盖（预期）");
  assert.equal(h1.currentE(), "alpha");
  assert.deepEqual(h1.remoteOpens, ["alpha"]);
  h1.emit.core.dispose(); h1.receive.core.dispose();

  // 反向 edge：emitter 空态启动 → 不宣告（空态不强加 clear），main 保留自身恢复。
  const h2 = makeOneWay();
  h2.eS.ready(["s1"]);
  h2.rS.ready(["s1"], "s1");
  h2.deliver();
  assert.equal(h2.currentR(), "s1", "emitter 空态不强加 clear，main 保留自身选中");
  assert.equal(h2.posts.length, 0);
});

test("clear 下行与再收敛；数据面删除 current（mask）幂等回空", () => {
  const h = makeOneWay();
  h.eS.ready(["gone", "alive"], "gone");
  h.rS.ready(["gone", "alive"], "gone");
  h.deliver(); // boot select gone；main 恢复同值 → 同值短路不重复 open
  assert.equal(h.currentR(), "gone");
  assert.deepEqual(h.remoteOpens, [], "main 恢复同值：boot select 同值短路不重复 open");

  // sidebar 清空选中 → clear 下行 → main 清空。
  h.eS.clear();
  h.deliver();
  assert.equal(h.currentR(), undefined, "main 跟随 clear");
  assert.equal(h.currentE(), undefined);

  // 再选 → 再收敛。
  h.eS.open("alive");
  h.deliver();
  assert.equal(h.currentR(), "alive");
  assert.deepEqual(h.remoteOpens, ["alive"]);

  // host 删除当前会话：两端数据面同步 remove → current mask undefined。
  // emitter 侧下行 clear（live），receiver 侧同源 mask 已空 → 远端 clear 同值短路幂等。
  h.eS.remove("alive");
  h.rS.remove("alive");
  h.deliver();
  assert.equal(h.currentE(), undefined);
  assert.equal(h.currentR(), undefined);

  // mask 后重新选择继续收敛（不悬挂）。
  h.eS.open("gone");
  h.deliver();
  assert.equal(h.currentR(), "gone");
  assert.deepEqual(h.remoteOpens, ["alive", "gone"]);
});

test("pending 补开（receive 端）：远端 select 先于本端 baseline → ready 后补 open", async () => {
  const h = makeOneWay();
  h.eS.ready(["late"], "late"); // boot select late 已入邮袋
  h.rS.arrive("late");          // main 数据面已有行但 phase 仍 pending
  h.deliver();                  // boot → main 走 pending（phase 非 ready）
  assert.equal(h.currentR(), undefined, "pending 未落定前不选中");
  assert.equal(h.receive.core._debug().pendingId, "late");
  h.rS.ready(["late"]);         // main baseline 落库
  h.deliver();
  await flush();
  assert.equal(h.currentR(), "late", "main 在 baseline 后补开 emitter 宣告的会话");
  // 补开落定后簿记必须与真实 current 对齐（沿用 V4 CodeRabbit #70 纪律：snap 若取自
  // maybeApplyPending 之前会脱节）。
  assert.equal(h.receive.core._debug().sentValue, "late", "pending 补开后簿记与 current 对齐");
  assert.deepEqual(h.remoteOpens, ["late"]);
});

test("pending 目标被恢复先行落定（同值）→ 不重复 open（降噪）", async () => {
  const h = makeOneWay();
  h.eS.ready(["s1"], "s1"); // boot select s1 已入邮袋
  h.rS.arrive("s1");        // main 数据面行先到（phase 仍 pending）
  h.deliver();
  assert.equal(h.receive.core._debug().pendingId, "s1", "未 ready → pending 暂存");
  assert.deepEqual(h.remoteOpens, [], "pending 未落定不 open");
  h.rS.ready(["s1"], "s1"); // baseline + main 自身恢复 s1 同 tick 落定
  h.deliver();
  await flush();
  assert.equal(h.currentR(), "s1");
  assert.deepEqual(h.remoteOpens, [], "恢复先行落定（同值）→ 清 pending 不重复 open");
  assert.equal(h.receive.core._debug().pendingId, undefined);
});

test("值去重（emit 端）：同值尾通知/同 id 重放不重复广播", () => {
  const h = makeOneWay();
  h.eS.ready(["s1"]); // 空态启动
  assert.equal(h.posts.length, 0, "空态不广播 clear");
  h.eS.open("s1");
  assert.equal(h.posts.length, 1, "首个 live select 广播一次");
  h.eS.arrive("s2"); // 数据面行增量、current 不变 → 同值去重
  h.eS.open("s1");   // 同 id 重放（同值 list.set 尾）→ 去重
  assert.equal(h.posts.length, 1, "同值后续通知不重复广播");
  h.eS.open("s2");
  assert.equal(h.posts.length, 2, "真变化才广播下一条");
});

test("receive 端同值短路：远端重复 select（live/boot）不重复 open（降噪）", () => {
  const h = makeOneWay();
  h.eS.ready(["s1", "s2"], "s1");
  h.rS.ready(["s1", "s2"]);
  h.deliver(); // boot → main open s1 一次
  assert.deepEqual(h.remoteOpens, ["s1"]);
  // 同值远端消息（live/boot 皆然）：同值短路 → 不重复 open、不制造冗余 list.set。
  h.receive._receive({ v: 1, type: "select", sessionId: "s1" });
  h.receive._receive({ v: 1, type: "select", sessionId: "s1", boot: true });
  assert.deepEqual(h.remoteOpens, ["s1"], "同值远端 select（live/boot）不重复 open");
  assert.equal(h.currentR(), "s1");
  // 真变化（切到 s2）才 open——同值短路不吞真变化。
  h.receive._receive({ v: 1, type: "select", sessionId: "s2" });
  assert.deepEqual(h.remoteOpens, ["s1", "s2"]);
  assert.equal(h.currentR(), "s2");
});

test("receive 端远端 open 抛错（未知/未保留地址兜底）不炸桥；脏消息忽略", () => {
  const h = makeOneWay();
  h.eS.ready(["ok", "weird"], "ok");
  h.rS.ready(["ok", "weird"], "ok");
  h.deliver(); // boot select ok：main 恢复同值 → 同值短路
  const realOpen = h.rS.open.bind(h.rS);
  h.rS.open = (id) => {
    if (id === "weird") throw new Error("sessions.select: unknown session weird");
    realOpen(id);
  };
  h.receive._receive({ v: 1, type: "select", sessionId: "weird" }); // open 抛 → 核心 catch
  assert.equal(h.currentR(), "ok", "抛错不改变 main 选中、桥不炸");
  h.receive._receive({ v: 1, type: "select", sessionId: "ok" }); // 同值 → 不 open
  h.receive._receive({ v: 1, type: "select", sessionId: "ok" });
  assert.equal(h.currentR(), "ok");
  // 脏消息（非本协议/坏载荷）忽略不抛。
  h.receive._receive({ v: 2, type: "select", sessionId: "ok" });
  h.receive._receive({ type: "select", sessionId: "ok" });
  h.receive._receive(null);
  h.receive._receive("garbage");
  h.receive._receive({ v: 1, type: "mystery" });
  h.receive._receive({ v: 1, type: "select", sessionId: "" });
  assert.equal(h.currentR(), "ok");
});

test("dispose 停摆：emit 不再广播、receive 不再订阅/应用", () => {
  const h = makeOneWay();
  h.eS.ready(["s1"]);
  h.rS.ready(["s1"]);
  h.emit.core.dispose();
  h.receive.core.dispose();
  h.eS.open("s1"); // dispose 后本地变化不再广播
  h.deliver();
  assert.equal(h.posts.length, 0, "dispose 后不再广播");
  h.receive._receive({ v: 1, type: "select", sessionId: "s1" }); // disposed receive 忽略
  assert.equal(h.currentR(), undefined, "dispose 后不再应用远端");
});

test("mode 校验（缺省/非法抛错）+ 接线层（降级 noop / 真 channel 可建可 dispose）", () => {
  assert.equal(SYNC_CHANNEL, "dshana.sync");
  assert.equal(BRIDGE_MODE_EMIT, "emit");
  assert.equal(BRIDGE_MODE_RECEIVE, "receive");
  const stubList = {
    subscribe: () => () => {},
    getSnapshot: () => ({ phase: "ready", byId: {}, current: undefined }),
  };
  // 非法/缺省 mode 一律抛错——防止接线漏传方向静默成错角色（旧双向 API 语义已删）。
  assert.throws(() => createSyncCore({ mode: "both", list: stubList, open() {}, clear() {}, post() {} }), /mode/);
  assert.throws(() => createSyncCore({ list: stubList, open() {}, clear() {}, post() {} }), /mode/);
  assert.throws(() => createSessionSyncBridge({}, undefined), /mode/);
  // 接线层：sessions 缺失 → 静默降级 noop（不抛）；有 sessions → 建桥（emit/receive）可 dispose。
  for (const mode of [BRIDGE_MODE_EMIT, BRIDGE_MODE_RECEIVE]) {
    const disposeMissing = createSessionSyncBridge({}, mode);
    assert.equal(typeof disposeMissing, "function");
    disposeMissing();
    const stubCtx = {
      sessions: {
        list: stubList,
        open: () => {},
        clear: () => {},
      },
    };
    const dispose = createSessionSyncBridge(stubCtx, mode);
    assert.equal(typeof dispose, "function");
    dispose();
  }
});
