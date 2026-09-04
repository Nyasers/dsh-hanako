// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/sync-bridge.test.mjs —— fpFullPanel V4 跨边联动选中态桥（sync-bridge.js）核心
// 态机单测。零依赖：Node 内置 node:test + node:assert（同 errclass.test.mjs 纪律——
// 验收命令 node --test tests/ 自动发现）。
//
// 被测面 = createSyncCore（纯状态机，传输/存储解耦注入）：
//   · 双向实时 select/clear 传播 + 防回环（值去重 + isRemote 静默）不震荡；
//   · 启动握手：单端恢复宣告 / 双端分歧恢复字典序收敛（boot:true max-wins）；
//   · live 端忽略迟到 boot 宣告（真实动作优先）；
//   · 远端 select 目标本端暂缺 → pending 补开（列表就绪且 byId 出现后 open）；
//   · open 抛错（catalog 未知地址兜底）不炸桥；非协议消息忽略；
//   · 数据面删除当前会话（mask）两端一致回空后再次收敛；
//   · dispose 停摆；无 BroadcastChannel 环境（node）接线层静默降级 noop。
// 浏览器接线（BroadcastChannel 载体/ctx.sessions 注入）属宿主实机验证面，此处不 mock。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
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

/** 两参与者直连邮袋（同步排空 + bounded——防回环失败的震荡会被 max 拦下并断言失败）。 */
function makePair() {
  const bus = { a2b: [], b2a: [], posted: 0 };
  const aS = makeSessions();
  const bS = makeSessions();
  const sides = {};
  sides.a = {
    sessions: aS,
    posts: [],
    remoteOpens: [],
    remoteClears: [],
  };
  sides.b = {
    sessions: bS,
    posts: [],
    remoteOpens: [],
    remoteClears: [],
  };
  for (const name of ["a", "b"]) {
    const side = sides[name];
    const peer = name === "a" ? "b" : "a";
    side.core = createSyncCore({
      list: side.sessions.list,
      open: (id) => { side.remoteOpens.push(id); side.sessions.open(id); },
      clear: () => { side.remoteClears.push(1); side.sessions.clear(); },
      post: (msg) => {
        side.posts.push(msg);
        bus.posted += 1;
        bus[name + "2" + peer].push(msg);
      },
    });
    side._receive = (msg) => side.core.receive(msg);
    side.current = () => side.sessions.current();
  }
  /** 投递到邮袋清空（消息可级联；同步推演 + 轮次上限防震荡）。 */
  function deliver(max = 40) {
    let rounds = 0;
    while ((bus.a2b.length > 0 || bus.b2a.length > 0) && rounds < max) {
      rounds += 1;
      while (bus.a2b.length > 0) sides.b._receive(bus.a2b.shift());
      while (bus.b2a.length > 0) sides.a._receive(bus.b2a.shift());
    }
    assert.ok(bus.a2b.length === 0 && bus.b2a.length === 0,
      "bus did not quiesce within " + max + " rounds (echo loop?)");
  }
  return { aS, bS, a: sides.a, b: sides.b, deliver };
}

const flush = () => new Promise((resolve) => { queueMicrotask(resolve); });
const bootFlags = (posts) => posts.filter((m) => m.type === "select")
  .map((m) => ({ id: m.sessionId, boot: m.boot === true }));

test("实时双向：A 点会话 → B 跟随；B 切会话 → A 跟随；远端应用静默不回发", async () => {
  const { aS, bS, a, b, deliver } = makePair();
  aS.ready(["s1", "s2", "s3"]);
  bS.ready(["s1", "s2", "s3"]);
  deliver(); // 双端空态：无握手宣告

  aS.open("s1"); // 用户级动作直达 sessions（真实 ui 路径）
  deliver();
  assert.equal(b.current(), "s1", "B 跟随 A 的选中");
  assert.equal(a.current(), "s1", "A 保持自身选中");
  await flush();

  // B 反向切 s2：A 跟随。
  assert.equal(a.posts.length, 1, "前段 A 只发过 select s1");
  assert.equal(b.posts.length, 0, "前段 B 无广播（纯接收方）");
  bS.open("s2");
  deliver();
  assert.equal(a.current(), "s2");
  assert.equal(b.current(), "s2");
  // 只有广播方（B）多发一条 select s2；接收方（A）的远端应用链静默 → 不回发（isRemote + 值去重）。
  assert.equal(b.posts.length, 1, "B 恰好多发一条 select s2");
  assert.equal(a.posts.length, 1, "接收方远端应用链不回发消息");
});

test("清空双向：一端 clear → 另一端清空", () => {
  const { aS, bS, a, b, deliver } = makePair();
  aS.ready(["s1"], "s1");
  bS.ready(["s1"], "s1");
  deliver(); // 同值宣告收敛
  assert.equal(a.current(), "s1");
  assert.equal(b.current(), "s1");
  aS.clear();
  deliver();
  assert.equal(b.current(), undefined, "B 跟随 A 的 clear");
  assert.equal(a.current(), undefined);
});

test("启动握手：单端恢复选中 → 空态端采纳；空态端不宣告 clear", () => {
  const { aS, bS, a, b, deliver } = makePair();
  aS.ready(["restored"], "restored");
  assert.deepEqual(bootFlags(a.posts), [{ id: "restored", boot: true }], "A 发 boot:true 宣告");
  bS.ready(["restored"]); // 同一运行时：两端列表同（B 只是空态无恢复）
  assert.equal(b.posts.length, 0, "空态端不广播 clear");
  deliver();
  assert.equal(b.current(), "restored", "B 采纳 A 的恢复宣告");
  a.core.dispose(); b.core.dispose();
});

test("启动握手竞态：双端不同恢复 → id 字典序 max-wins 收敛一致", () => {
  const { aS, bS, a, b, deliver } = makePair();
  // 同一运行时：两端列表同（都含两会话），仅持久化恢复 current 不同（交叉握手）。
  aS.ready(["restored-a", "restored-b"], "restored-a");
  bS.ready(["restored-a", "restored-b"], "restored-b"); // 'restored-b' > 'restored-a'
  deliver();
  assert.equal(a.current(), "restored-b", "双方收敛到较大 id");
  assert.equal(b.current(), "restored-b");
  a.core.dispose(); b.core.dispose();
});

test("真实动作优先：A live 广播覆盖被动收敛；A 忽略迟到 boot 宣告不回退", () => {
  const { aS, bS, a, b, deliver } = makePair();
  // 字典序 zeta > alpha：双 passive 恢复 → 收敛 zeta。
  aS.ready(["alpha", "zeta"], "alpha");
  bS.ready(["alpha", "zeta"], "zeta");
  deliver();
  assert.equal(a.current(), "zeta");
  assert.equal(b.current(), "zeta");
  // A 用户真实点 alpha（小于 zeta）→ 无条件传播到 B。
  aS.open("alpha");
  deliver();
  assert.equal(b.current(), "alpha", "live 动作覆盖被动收敛值");
  // A 此后忽略任何迟到 boot（含旧宣告 zeta 的回放）。
  a._receive({ v: 1, type: "select", sessionId: "zeta", boot: true });
  assert.equal(a.current(), "alpha", "live 端忽略迟到 boot 宣告");
  assert.equal(b.current(), "alpha");
  a.core.dispose(); b.core.dispose();
});

test("pending 补开：远端 select 先于本端 baseline 到达 → baseline 后补 open", async () => {
  const { aS, bS, a, b, deliver } = makePair();
  aS.ready(["late"], "late"); // A ready + 选中 late（宣告 boot:true 已入邮袋）
  bS.arrive("late");          // B 数据面已有 late 行，但 phase 仍 pending
  deliver();                  // A 的 boot 宣告到 B → B 走 pending（phase 非 ready）
  assert.equal(b.current(), undefined, "pending 未落定前不选中");
  bS.ready(["late"]);         // B baseline 落库
  deliver();
  await flush();
  assert.equal(b.current(), "late", "B 在 baseline 后补开 A 宣告的会话");
  a.core.dispose(); b.core.dispose();
});

test("远端 open 抛错（未知/未保留 catalog 地址兜底）不炸桥、不影响后续", () => {
  const { aS, bS, a, b, deliver } = makePair();
  aS.ready(["ok", "weird"], "ok");
  bS.ready(["ok", "weird"], "ok");
  deliver();
  const realOpen = bS.open.bind(bS);
  bS.open = (id) => {
    if (id === "weird") throw new Error("sessions.select: unknown session weird");
    realOpen(id);
  };
  b._receive({ v: 1, type: "select", sessionId: "weird" }); // 抛 → 核心 catch
  b._receive({ v: 1, type: "select", sessionId: "ok" });
  assert.equal(b.current(), "ok");
  assert.equal(a.current(), "ok");
});

test("非协议/脏消息忽略不抛", () => {
  const { bS, b } = makePair();
  bS.ready(["s1"], "s1");
  b._receive({ v: 2, type: "select", sessionId: "s1" });
  b._receive({ type: "select", sessionId: "s1" });
  b._receive(null);
  b._receive("garbage");
  b._receive({ v: 1, type: "mystery" });
  b._receive({ v: 1, type: "select", sessionId: "" });
  assert.equal(b.current(), "s1");
});

test("数据面删除当前会话（mask）→ 两端回空；再选 → 再次收敛", () => {
  const { aS, bS, a, b, deliver } = makePair();
  aS.ready(["gone", "alive"], "gone");
  bS.ready(["gone", "alive"], "gone");
  deliver();
  assert.equal(a.current(), "gone");
  assert.equal(b.current(), "gone");
  // host 删除当前会话：两端数据面同步 remove → current mask undefined。
  aS.remove("gone");
  bS.remove("gone");
  deliver();
  assert.equal(a.current(), undefined);
  assert.equal(b.current(), undefined);
  aS.open("alive");
  deliver();
  assert.equal(b.current(), "alive");
  assert.equal(a.current(), "alive");
});

test("dispose 停止订阅与广播", () => {
  const { aS, bS, a, b, deliver } = makePair();
  aS.ready(["s1"]);
  bS.ready(["s1"]);
  a.core.dispose();
  const before = a.posts.length + b.posts.length;
  aS.open("s1");
  deliver();
  assert.equal(a.posts.length + b.posts.length, before, "dispose 后不再广播");
});

test("接线层：ctx.sessions 缺失 → 静默降级 noop；有 sessions → 建桥并可 dispose", () => {
  assert.equal(SYNC_CHANNEL, "dshana.sync");
  // sessions 服务缺失：不抛、noop。
  const disposeMissing = createSessionSyncBridge({});
  assert.equal(typeof disposeMissing, "function");
  disposeMissing();
  // 有 sessions（Node 18+ 自带 BroadcastChannel 全局，真开一个 channel 验证闭环）。
  const stubCtx = {
    sessions: {
      list: { subscribe: () => () => {}, getSnapshot: () => ({ phase: "ready", byId: {}, current: undefined }) },
      open: () => {},
      clear: () => {},
    },
  };
  const dispose = createSessionSyncBridge(stubCtx);
  assert.equal(typeof dispose, "function");
  dispose();
});
