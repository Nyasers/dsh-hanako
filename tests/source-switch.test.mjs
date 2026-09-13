// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/source-switch.test.mjs — 数据源切换链的顺序与回滚语义（spec D-m）。
//
// 编排者依赖全注入，所以这里用假件把六步逐步走到，钉住三件事：
//   1. 顺序：preflight → freeze → 停旧 → 起新 → 落盘（起新成功之后才写设置）；
//   2. 早停：preflight/freeze 失败时一个东西都不许动（不 stop、不 start、不写）；
//   3. 回滚：停过就按旧源重起，只冻过就解冻；落盘失败要把半成品停掉。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSourceSwitcher, controlAccepted } from "../src/lib/source-switch.ts";

const PRIVATE = { mode: "private", path: null, profile: "dshana", approvalTimeoutSec: 30, defaultTimeoutSec: 1800 };
const SHARED = { mode: "shared", path: "D:/dsh", profile: "web", approvalTimeoutSec: 30, defaultTimeoutSec: 1800 };

function makeDeps(over = {}) {
  const calls = [];
  const deps = {
    store: {
      read: async () => ({ version: 1, revision: 3, settings: { ...PRIVATE } }),
      write: async (settings) => {
        calls.push("write");
        return { version: 1, revision: 4, settings };
      },
      validate: async (settings) => settings,
    },
    preflight: async () => {
      calls.push("preflight");
      return { ok: true };
    },
    prepareSwitch: async () => {
      calls.push("freeze");
      return { ok: true };
    },
    resume: async () => {
      calls.push("resume");
      return { ok: true };
    },
    stopRuntime: async () => {
      calls.push("stop");
    },
    startRuntime: async (settings) => {
      calls.push("start:" + settings.mode);
    },
    log: () => {},
    ...over,
  };
  return { deps, calls };
}

/** 等链跑完（编排是后台跑的，测试里轮询终态）。 */
async function settle(switcher, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const op = switcher.state();
    if (op && (op.state === "succeeded" || op.state === "failed")) return op;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("切换链未在超时内结束：" + JSON.stringify(switcher.state()));
}

test("成功路径：顺序固定，起新成功之后才落盘", async () => {
  const { deps, calls } = makeDeps();
  const switcher = createSourceSwitcher(deps);
  const started = await switcher.start(SHARED, 3);
  assert.equal(started.ok, true);
  assert.equal(started.operation.step, "preflight");
  const op = await settle(switcher);
  assert.equal(op.state, "succeeded");
  assert.equal(op.revision, 4);
  assert.deepEqual(calls, ["preflight", "freeze", "stop", "start:shared", "write"]);
  assert.equal(op.from.mode, "private");
  assert.equal(op.to.mode, "shared");
});

test("preflight 失败：什么都不动（不冻结、不停、不起、不写）", async () => {
  const { deps, calls } = makeDeps({ preflight: async () => { calls.push("preflight"); return { ok: false, error: "目录不可写" }; } });
  const switcher = createSourceSwitcher(deps);
  await switcher.start(SHARED, 3);
  const op = await settle(switcher);
  assert.equal(op.state, "failed");
  assert.match(op.error, /目录不可写/);
  assert.deepEqual(calls, ["preflight"], "preflight 失败不得进入后续步骤");
  assert.equal(op.error.includes("回滚"), false, "没动过东西就不该有回滚动作");
});

test("冻结被拒：已进链但未停任何东西，且不解冻（本来没冻上）", async () => {
  const { deps, calls } = makeDeps({ prepareSwitch: async () => { calls.push("freeze"); return { ok: false, error: "有在途调用" }; } });
  const switcher = createSourceSwitcher(deps);
  await switcher.start(SHARED, 3);
  const op = await settle(switcher);
  assert.equal(op.state, "failed");
  assert.match(op.error, /有在途调用/);
  assert.deepEqual(calls, ["preflight", "freeze"], "未停旧、未起新、未写盘，也不该解冻");
});

test("起新失败：停旧之后必须按旧源重起", async () => {
  const { deps, calls } = makeDeps({
    startRuntime: async (settings) => {
      calls.push("start:" + settings.mode);
      if (settings.mode === "shared") throw new Error("起新源超时");
    },
  });
  const switcher = createSourceSwitcher(deps);
  await switcher.start(SHARED, 3);
  const op = await settle(switcher);
  assert.equal(op.state, "failed");
  assert.match(op.error, /起新源超时/);
  assert.match(op.error, /已按旧源重起/, "回滚结果要写在错误里，如实报");
  assert.deepEqual(calls, ["preflight", "freeze", "stop", "start:shared", "start:private"]);
});

test("落盘失败：停掉半成品并按旧源重起（文件里不留新源）", async () => {
  const { deps, calls } = makeDeps({
    store: {
      read: async () => ({ version: 1, revision: 3, settings: { ...PRIVATE } }),
      write: async () => { calls.push("write"); throw new Error("磁盘只读"); },
      validate: async (settings) => settings,
    },
  });
  const switcher = createSourceSwitcher(deps);
  await switcher.start(SHARED, 3);
  const op = await settle(switcher);
  assert.equal(op.state, "failed");
  assert.match(op.error, /磁盘只读/);
  assert.deepEqual(calls, ["preflight", "freeze", "stop", "start:shared", "write", "stop", "start:private"]);
  assert.match(op.error, /已停半成品/);
});

test("停旧那步报错：按旧源重起（可能已停掉一半，不解冻了事）", async () => {
  const { deps, calls } = makeDeps({
    stopRuntime: async () => { calls.push("stop"); throw new Error("停不下来"); },
  });
  const switcher = createSourceSwitcher(deps);
  await switcher.start(SHARED, 3);
  const op = await settle(switcher);
  assert.equal(op.state, "failed");
  assert.match(op.error, /停不下来/);
  assert.deepEqual(calls, ["preflight", "freeze", "stop", "start:private"], "进了停旧这步，就要按旧源重起");
  assert.match(op.error, /已按旧源重起/);
});

test("进行中再触发：busy，不排队也不重入", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { deps } = makeDeps({ preflight: async () => { await gate; return { ok: true }; } });
  const switcher = createSourceSwitcher(deps);
  const first = await switcher.start(SHARED, 3);
  assert.equal(first.ok, true);
  const second = await switcher.start({ ...SHARED, profile: "other" }, 3);
  assert.equal(second.ok, false);
  assert.equal(second.busy, true);
  release();
  const op = await settle(switcher);
  assert.equal(op.state, "succeeded");
});

test("revision 落后：conflict，一个步骤都不跑", async () => {
  const { deps, calls } = makeDeps();
  const switcher = createSourceSwitcher(deps);
  const r = await switcher.start(SHARED, 2);
  assert.equal(r.ok, false);
  assert.equal(r.conflict, true);
  assert.equal(r.revision, 3);
  assert.deepEqual(calls, []);
});

test("目标与当前同源：noop，不跑链", async () => {
  const { deps, calls } = makeDeps();
  const switcher = createSourceSwitcher(deps);
  const r = await switcher.start({ ...PRIVATE }, 3);
  assert.equal(r.ok, false);
  assert.equal(r.noop, true);
  assert.deepEqual(calls, []);
});

test("控制面回执归一：ok / accepted / 无回执", () => {
  assert.deepEqual(controlAccepted({ ok: true }), { ok: true });
  assert.deepEqual(controlAccepted({ accepted: true }), { ok: true });
  assert.deepEqual(controlAccepted({ result: { ok: true } }), { ok: true });
  assert.equal(controlAccepted({ result: { error: "有在途调用" } }).ok, false);
  assert.match(controlAccepted(null).error, /无回执/);
});
