// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/clipboard-shadow.test.mjs — 壳级剪贴板影子
//
// 锁死两条不变量：
//   ① 桥可用时**一次原生都不碰**（旧实现"先试原生"会在嵌入场景每次复制都撞一次被
//      Permissions-Policy 关死的门，控制台刷 [Violation]）；
//   ② 安装是幂等的、可逆的，且覆盖实例方法 + 原型方法；
// 另加：桥拒绝才回落原生；两边都失败不静默成功（抛／reject）。

import test from "node:test";
import assert from "node:assert/strict";

import { createClipboardShadow, installClipboardShadow } from "../src/ui/clipboard-shadow.js";

/** 造一个假的宿主窗：navigator.clipboard + Clipboard 原型 + 记录。 */
function fakeWindow({ withClipboard = true } = {}) {
  const calls = [];
  class Clipboard {
    writeText(text) {
      calls.push({ kind: "native", text });
      return Promise.resolve();
    }
  }
  const clipboard = withClipboard ? new Clipboard() : null;
  const target = {
    navigator: withClipboard ? { clipboard } : {},
    Clipboard,
    __DSHANA__: undefined,
  };
  target.calls = calls;
  return { target, clipboard, calls };
}

test("桥可用：只走桥，原生零调用（不触发 Permissions-Policy violation）", async () => {
  const { target, clipboard, calls } = fakeWindow();
  const bridged = [];
  target.__DSHANA__ = { clipboardWrite: (text) => { bridged.push(text); return Promise.resolve(true); } };
  installClipboardShadow({ target });
  await clipboard.writeText("hello");
  assert.deepEqual(bridged, ["hello"]);
  assert.equal(calls.length, 0);
});

test("桥拒绝：回落原生；两边都失败则抛出（不静默假装成功）", async () => {
  const { target, clipboard, calls } = fakeWindow();
  target.__DSHANA__ = { clipboardWrite: () => Promise.reject(new Error("denied")) };
  installClipboardShadow({ target, report: () => {} });
  await clipboard.writeText("a");                 // 桥拒绝 → 原生成功
  assert.deepEqual(calls.map((c) => c.kind), ["native"]);

  const { target: t2, clipboard: c2 } = fakeWindow();
  t2.__DSHANA__ = { clipboardWrite: () => Promise.reject(new Error("denied")) };
  c2.writeText = () => Promise.reject(new Error("policy blocked"));
  Object.defineProperty(t2, "Clipboard", { value: undefined });
  installClipboardShadow({ target: t2, report: () => {} });
  await assert.rejects(() => c2.writeText("b"));
});

test("桥返回显式失败值（false / {written:false}）不当成功：回落原生，两边都失败则抛", async () => {
  // 线上旧壳页把宿主失败折成 false（而 DSH 的 helper 只要不抛就报成功）——
  // 所以显式失败值必须再判一次，不能当成功。
  for (const value of [false, { written: false }]) {
    const { target, clipboard, calls } = fakeWindow();
    target.__DSHANA__ = { clipboardWrite: () => Promise.resolve(value) };
    installClipboardShadow({ target, report: () => {} });
    await clipboard.writeText("a");
    assert.deepEqual(calls.map((c) => c.kind), ["native"], `bridge=${JSON.stringify(value)} 应回落原生`);
  }

  const { target, clipboard } = fakeWindow();
  target.__DSHANA__ = { clipboardWrite: () => Promise.resolve({ written: false }) };
  clipboard.writeText = () => Promise.reject(new Error("policy blocked"));
  Object.defineProperty(target, "Clipboard", { value: undefined });
  installClipboardShadow({ target, report: () => {} });
  await assert.rejects(() => clipboard.writeText("b"), /clipboard bridge reported failure/);
});

test("write(items)：text/plain 走桥且不碰原生", async () => {
  const { target, clipboard, calls } = fakeWindow();
  const bridged = [];
  target.__DSHANA__ = { clipboardWrite: (text) => { bridged.push(text); return Promise.resolve({ written: true }); } };
  clipboard.write = (items) => { calls.push({ kind: "native-write", items }); return Promise.resolve(); };
  installClipboardShadow({ target });
  const item = { types: ["text/plain"], getType: () => Promise.resolve({ text: () => Promise.resolve("hi") }) };
  await clipboard.write([item]);
  assert.deepEqual(bridged, ["hi"]);
  assert.equal(calls.length, 0, "走桥时不该碰原生");
});

test("write(items)：只有图像时回落原生，原生也被拒则抛（并把边界写进消息）", async () => {
  const { target, clipboard, calls } = fakeWindow();
  target.__DSHANA__ = { clipboardWrite: () => Promise.resolve({ written: true }) };
  clipboard.write = (items) => { calls.push({ kind: "native-write", items }); return Promise.reject(new Error("policy blocked")); };
  installClipboardShadow({ target, report: () => {} });
  const image = { types: ["image/png"], getType: () => Promise.resolve({ text: () => Promise.resolve("ignored") }) };
  await assert.rejects(() => clipboard.write([image]), /text\/plain/);
  assert.deepEqual(calls.map((c) => c.kind), ["native-write"], "应回落原生一次");
});

test("write(items)：桥回显式失败值 → 回落原生", async () => {
  const { target, clipboard, calls } = fakeWindow();
  target.__DSHANA__ = { clipboardWrite: () => Promise.resolve({ written: false }) };
  clipboard.write = (items) => { calls.push({ kind: "native-write", items }); return Promise.resolve(); };
  installClipboardShadow({ target, report: () => {} });
  await clipboard.write([{ types: ["text/plain"], getType: () => Promise.resolve({ text: () => Promise.resolve("x") }) }]);
  assert.deepEqual(calls.map((c) => c.kind), ["native-write"]);
});

test("extractText：取第一个 text/plain；只认 types 里的文本项", async () => {
  const { extractText } = createClipboardShadow({ clipboard: {}, bridge: null });
  const items = [
    { types: ["image/png"], getType: () => Promise.resolve({ text: () => Promise.resolve("no") }) },
    { types: ["text/plain;charset=utf-8"], getType: () => Promise.resolve({ text: () => Promise.resolve("yes") }) },
  ];
  assert.equal(await extractText(items), "yes");
  assert.equal(await extractText([{ types: ["image/png"], getType: () => Promise.resolve({ text: () => Promise.resolve("no") }) }]), null);
  assert.equal(await extractText([]), null);
});

test("桥缺席：用原生（非嵌入/宿主旧版不倒退）", async () => {
  const { target, clipboard, calls } = fakeWindow();
  installClipboardShadow({ target });
  await clipboard.writeText("plain");
  assert.deepEqual(calls, [{ kind: "native", text: "plain" }]);
});

test("实例 + 原型都换掉，disposer 还原到原值，二次安装是空操作", async () => {
  const { target, clipboard } = fakeWindow();
  const nativeProto = target.Clipboard.prototype.writeText;
  target.__DSHANA__ = { clipboardWrite: () => Promise.resolve(true) };

  const dispose = installClipboardShadow({ target });
  assert.notEqual(clipboard.writeText, nativeProto, "实例方法应被换成影子");
  assert.notEqual(target.Clipboard.prototype.writeText, nativeProto, "原型方法应被换成影子");
  assert.equal(clipboard.writeText, target.Clipboard.prototype.writeText, "两层是同一个影子");

  const second = installClipboardShadow({ target });
  assert.equal(typeof second, "function");
  dispose();
  assert.equal(clipboard.writeText, nativeProto);
  assert.equal(target.Clipboard.prototype.writeText, nativeProto);
  // 先装的那次已撤销；此时"二次安装"返回的空 disposer 不应报错
  second();

  const again = installClipboardShadow({ target });
  assert.notEqual(clipboard.writeText, nativeProto, "撤销后可以重新安装");
  again();
});

test("没有 clipboard API 时静默跳过（不阻断页面）", () => {
  const { target } = fakeWindow({ withClipboard: false });
  const dispose = installClipboardShadow({ target });
  assert.equal(typeof dispose, "function");
  dispose();
});

test("createClipboardShadow：桥存在时原生的同步抛错不会被碰到", async () => {
  const clipboard = {
    writeText() { throw new Error("should not be called"); },
  };
  const bridge = { clipboardWrite: () => Promise.resolve(undefined) };
  const { shadow } = createClipboardShadow({ clipboard, bridge });
  await shadow("x");
});
