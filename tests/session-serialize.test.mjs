// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/session-serialize.test.mjs — src/lib/session-serialize.js 同会话串行化单测
// 覆盖：同 session 后到任务等前任务退出、不同 session 并行、create 槽位先占后放。
import { test } from "node:test";
import assert from "node:assert/strict";
import { withSessionTurn, enterSessionTurn } from "../src/lib/session-serialize.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test("同 session：任务严格串行（后到不重叠）", async () => {
  const order = [];
  const p1 = withSessionTurn("s1", async () => {
    order.push("a-start");
    await sleep(30);
    order.push("a-end");
    return "a";
  });
  const p2 = withSessionTurn("s1", async () => {
    order.push("b-start");
    return "b";
  });
  const results = await Promise.all([p1, p2]);
  assert.deepEqual(results, ["a", "b"]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start"]); // b 必须等 a 完全退出
});

test("不同 session：互不阻塞（并发执行）", async () => {
  let done = 0;
  const mk = (sid, label) => withSessionTurn(sid, async () => {
    await sleep(20);
    done += 1;
    return label;
  });
  const ps = [mk("x1", "1"), mk("x2", "2"), mk("x3", "3")];
  await Promise.all(ps);
  assert.equal(done, 3);
});

test("enterSessionTurn：create 槽位先占，run 内并发 send 等待", async () => {
  const order = [];
  const release = enterSessionTurn("new1");
  const send = withSessionTurn("new1", async () => {
    order.push("send");
    return "ok";
  });
  await sleep(10);
  assert.deepEqual(order, []); // create 槽位未放，send 未启动
  release();
  assert.equal(await send, "ok");
  assert.deepEqual(order, ["send"]);
});

test("enterSessionTurn：重复占位抛错（防 create/send 重叠）", () => {
  const release = enterSessionTurn("dup");
  assert.throws(() => enterSessionTurn("dup"), /已有排队提交/);
  // 释放后可再占
  release();
  const release2 = enterSessionTurn("dup");
  assert.equal(typeof release2, "function");
});
