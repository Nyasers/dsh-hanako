// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/provider-adapter.test.mjs — provider adapter（buildHanaAdapter）stream() 接线单测。
//
// 为什么要有这一层：adapter 的方法只在 DSH 运行期被调用，先前单测只覆盖 lib/* 纯函数，
// 于是"在 adapter 里引用了不存在的 ctx"这类错，构建与单测都看不见，只有真机第一次推理才炸。
// 这里用假 LlmAdapter/LlmError + 假 hana client + 真 Response
// 走完整条路径：身份判定（App / taskId）、NDJSON → DSH 块、宿主参数校验适配（maxTokens /
// temperature）、非 2xx 与空消息报错。
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHanaAdapter } from "../src-cordis/plugins/provider/index.ts";

const SID = "session-11111111-2222-3333-4444-555555555555";
const ENV_KEY = "DSHANA_HOME";
// big = 现实里那种“1M 上下文 / 384k 输出”的模型（published 上限远大于宿主的请求闸 65536）
const MODELS = [
  { provider: "hana", id: "m1", name: "m1" }, // 未声明 maxTokens
  { provider: "hana", id: "big", name: "big", maxTokens: 393216 },
  { provider: "hana", id: "small", name: "small", maxTokens: 4096 },
];

class FakeLlmError extends Error {
  constructor(message, code, opts) {
    super(message);
    this.name = "LlmError";
    this.code = code;
    if (opts && opts.requestId) this.requestId = opts.requestId;
  }
}
class FakeLlmAdapter {}

let dir;
let savedEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dshana-adapter-"));
  savedEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = dir;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const ACTIVE_BINDING = { taskId: "task-1", timeoutSec: 60, approvalTimeoutMs: 30000, ended: null, at: 3 };

function ndjsonResponse(events) {
  const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  return new Response(text, { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

function makeHana(events) {
  const seen = [];
  return {
    seen,
    models: {
      list: async () => ({ models: MODELS }),
      stream: async (request) => {
        seen.push(request);
        return ndjsonResponse(events);
      },
      cancel: async () => { /* 无操作 */ },
    },
  };
}

// 绑定状态由宿主投影提供（provider 侧只读 deps.readBinding）——测试直接给状态，
// 缺省 = 无绑定（App 身份）；传 undefined 才是「读不到」那条路径（由 identity 单测覆盖）。
function makeAdapter(hana, log, warn, binding) {
  return buildHanaAdapter(FakeLlmAdapter, FakeLlmError, {
    models: MODELS,
    hana,
    log,
    warn,
    readBinding: () => (binding === undefined ? { taskId: null, ended: null } : binding),
  });
}

async function collect(adapter, options) {
  const out = [];
  for await (const chunk of adapter.stream(options)) out.push(chunk);
  return out;
}

function streamOnce(options, hana) {
  const adapter = makeAdapter(hana, () => {}, () => {});
  return collect(adapter, options).then(() => hana.seen[0]);
}

const userMessages = [{ role: "user", content: [{ type: "text", text: "你好" }] }];
const okEvents = [
  { type: "start", requestId: "r1" },
  { type: "text-delta", requestId: "r1", delta: "你好" },
  {
    type: "done",
    requestId: "r1",
    stopReason: "stop",
    assistant: { role: "assistant", content: [{ type: "text", text: "你好", textSignature: "sig-1" }] },
  },
];

test("App 身份（无绑定）：两个身份参数都不传，且日志说明原因", async () => {
  const hana = makeHana(okEvents);
  const lines = [];
  const adapter = makeAdapter(hana, (m) => lines.push(m), undefined, { taskId: null, ended: null });
  const out = await collect(adapter, { provider: "hana", model: "m1", sessionId: SID, messages: userMessages });

  const req = hana.seen[0];
  assert.equal(req.taskId, undefined);
  assert.equal(req.callToken, undefined);
  assert.equal("scope" in req, false);
  assert.equal(typeof req.requestId, "string");
  assert.equal(req.requestId.length > 0, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /无绑定/);
  assert.equal(out.length > 0, true);
  assert.match(JSON.stringify(out), /你好/);
});

test("委派身份（有绑定且未收尾）：带 taskId、不带 callToken、不写身份日志", async () => {
  const hana = makeHana(okEvents);
  const lines = [];
  const adapter = makeAdapter(hana, (m) => lines.push(m), undefined, ACTIVE_BINDING);
  await collect(adapter, { provider: "hana", model: "m1", sessionId: SID, messages: userMessages });

  assert.equal(hana.seen[0].taskId, "task-1");
  assert.equal(hana.seen[0].callToken, undefined);
  assert.equal("scope" in hana.seen[0], false);
  assert.deepEqual(lines, []);
});

test("HTTP 非 2xx：以 MODEL_HTTP_ERROR 上抛（带状态与响应体）", async () => {
  const hana = {
    seen: [],
    models: {
      list: async () => ({ models: MODELS }),
      stream: async () => new Response('{"error":"forbidden"}', { status: 403 }),
      cancel: async () => { /* 无操作 */ },
    },
  };
  const adapter = makeAdapter(hana, () => {});
  await assert.rejects(
    () => collect(adapter, { provider: "hana", model: "m1", sessionId: SID, messages: userMessages }),
    (e) => e instanceof FakeLlmError && e.code === "MODEL_HTTP_ERROR" && /HTTP 403/.test(e.message),
  );
});

test("空消息：EMPTY_MESSAGES，且不发起模型请求", async () => {
  const hana = makeHana(okEvents);
  const adapter = makeAdapter(hana, () => {});
  await assert.rejects(
    () => collect(adapter, { provider: "hana", model: "m1", sessionId: SID, messages: [] }),
    (e) => e.code === "EMPTY_MESSAGES",
  );
  assert.equal(hana.seen.length, 0);
});

test("log 缺失也不崩（deps.log 缺省为空函数）", async () => {
  const hana = makeHana(okEvents);
  const adapter = makeAdapter(hana, undefined);
  const out = await collect(adapter, { provider: "hana", model: "m1", sessionId: SID, messages: userMessages });
  assert.equal(out.length > 0, true);
});

// ---- 宿主参数校验适配（APP_MODEL_INVALID_REQUEST）----
// 宿主 bundle 校验器原文："maxTokens must be a positive integer no larger than 65536."
// （写死的默认 limits.maxTokens，构造 App 模型服务时没有 limits 入口），另有一条
// "maxTokens exceeds the selected model's published limit."；温度必须 [0,2]。
// 关键取舍：DSH 的输出预算来自模型真实上限（384k），超过宿主请求闸时**不传字段**——
// 收敛到 65536 等于把输出悄悄砍到 64k。

test("maxTokens：超过宿主请求闸 → 不传字段（而非压到 65536）", async () => {
  const hana = makeHana(okEvents);
  const warns = [];
  const adapter = makeAdapter(hana, () => {}, (m) => warns.push(m));
  await collect(adapter, { provider: "hana", model: "big", sessionId: SID, messages: userMessages, maxTokens: 393216 });
  assert.equal("maxTokens" in hana.seen[0], false);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /改为不传/);
});

test("maxTokens：未声明 published 上限时，超闸同样不传", async () => {
  const hana = makeHana(okEvents);
  const req = await streamOnce(
    { provider: "hana", model: "m1", sessionId: SID, messages: userMessages, maxTokens: 100000 },
    hana,
  );
  assert.equal("maxTokens" in req, false);
});

test("maxTokens：未超宿主闸 → 原样透传，不写提示", async () => {
  const hana = makeHana(okEvents);
  const warns = [];
  const adapter = makeAdapter(hana, () => {}, (m) => warns.push(m));
  await collect(adapter, { provider: "hana", model: "big", sessionId: SID, messages: userMessages, maxTokens: 60000 });
  assert.equal(hana.seen[0].maxTokens, 60000);
  assert.deepEqual(warns, []);
});

test("maxTokens：未超宿主闸但超过该模型 published 上限 → 按模型上限收敛", async () => {
  const hana = makeHana(okEvents);
  const warns = [];
  const adapter = makeAdapter(hana, () => {}, (m) => warns.push(m));
  await collect(adapter, { provider: "hana", model: "small", sessionId: SID, messages: userMessages, maxTokens: 8192 });
  assert.equal(hana.seen[0].maxTokens, 4096);
  assert.match(warns[0], /published 上限/);
});

test("maxTokens：非正整数不发字段（交给宿主默认）", async () => {
  const hana = makeHana(okEvents);
  const req = await streamOnce(
    { provider: "hana", model: "m1", sessionId: SID, messages: userMessages, maxTokens: 0 },
    hana,
  );
  assert.equal("maxTokens" in req, false);
});

test("temperature：越界收敛到 [0,2]", async () => {
  const hana = makeHana(okEvents);
  const req = await streamOnce(
    { provider: "hana", model: "m1", sessionId: SID, messages: userMessages, temperature: 3 },
    hana,
  );
  assert.equal(req.temperature, 2);
});

test("目录投影（resolveModel）：声明模型真实上限，不夹宿主请求闸", async () => {
  const adapter = makeAdapter(makeHana(okEvents), () => {}, () => {});
  const big = await adapter.resolveModel("hana", "big");
  const m1 = await adapter.resolveModel("hana", "m1");
  assert.equal(big.defaultMaxTokens, 393216);
  assert.equal(m1.defaultMaxTokens, undefined); // 模型未声明就不猜
});
