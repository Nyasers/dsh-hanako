// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/tool-ctx.test.mjs — 工具执行上下文必须继承宿主 ctx 的宿主能力。
//
// 真机踩到：工具 ctx 曾经是「手挑几项」（只有 dataDir/config/log），于是
//   · ctx.runtime 缺 → list/get 直接报「宿主不支持 ctx.runtime.fetch（受管服务请求）」；
//   · ctx.tasks 缺 → resolveTarget 里的 ctx.tasks.get 恒为 null，句柄路径的归属校验
//     恒定判「查不到」（fail-closed 变成恒 fail）。
// 本测试钉住口径：工具 ctx = 宿主 ctx 的浅拷贝 + 换名后的 log。
import test from "node:test";
import assert from "node:assert/strict";
import { toolCtxFrom } from "../src/lib/app-runtime.ts";

const host = {
  dataDir: "D:/app-data/dshana",
  runtime: { fetch: async () => {} },
  tasks: { get: async () => ({}) },
  storage: { global: {} },
  config: { get: () => undefined },
  logger: { info() {} },
};

test("工具 ctx 继承宿主能力（runtime/tasks/storage 原样带过）", () => {
  const log = { info() {} };
  const ctx = toolCtxFrom(host, log);
  assert.equal(ctx.runtime, host.runtime, "控制面请求靠它，缺了 list/get 直接失败");
  assert.equal(ctx.tasks, host.tasks, "句柄归属校验靠它，缺了恒判查不到");
  assert.equal(ctx.storage, host.storage);
  assert.equal(ctx.dataDir, host.dataDir);
  assert.equal(ctx.config, host.config);
});

test("log 换成工具日志出口，宿主 ctx 本身不被改动", () => {
  const log = { warn() {} };
  const ctx = toolCtxFrom(host, log);
  assert.equal(ctx.log, log, "工具代码读 ctx.log，宿主给的是 ctx.logger");
  assert.equal(ctx.logger, host.logger, "宿主成员原样保留");
  assert.equal(host.log, undefined, "不得往宿主 ctx 上写 log");
});
