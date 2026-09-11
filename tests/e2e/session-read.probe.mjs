// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/e2e/session-read.probe.mjs — 官方会话读面真机探测（开发者本机用，非 node --test 默认集）
//
// 目的：验证 query subtool 走官方读面时**入参形状与取数策略**是否成立。已经证实的结论（本脚本
// 每次运行都会复核）：
//   ① session/list 走一元 HTTP 的 `_request` 信封；items[].projections.values 带 title /
//      tokenUsage / sessionStats，projections.asOfSeq 是投影折叠到的 seq；
//   ② session/page 是**一元**方法（envelope 同 session 家族），throughSeq 必填且不得超过
//      "当前 cursor"（超了报 gateway/bad-request "past cursor N"）；
//   ③ session/follow 是**流方法**，一元 POST 会被拒：
//      gateway/signature-invalid "stream Remote methods must be opened through the stream carrier"
//      —— 载体是 WS mux（@deepseek-ai/dsh-api-gateway 的 REMOTE_STREAM_MUX_PATH = /api/remote.mux）。
//      结论：不为一次读去接 mux，改用 list(asOfSeq) + page 的一元组合。
// 本脚本要回答的开放问题：**投影缓存的 asOfSeq 会不会落后于真实 cursor**（落后就意味着 page 读
// 不到最新一轮）。用 rename（会写一条持久事件并回传 seq）制造"日志前进"再量 asOfSeq，无需模型。
//
// 用法（仓库根，先 node src/build.js && node src-cordis/build.js）：
//   node tests/e2e/session-read.probe.mjs [--keep] [--prompt "说一句你好"]
//   --prompt 会真的跑一轮模型（耗时/耗 token；需要该 DSH_HOME 已配好 provider），随后核对
//   "page 到尾 + lastRoundOutput 取最后一轮输出"。
// 环境：DSH_REPO_ROOT、DSH_DATA_DIR、DSH_DEPS_ROOT、DSH_CORDIS_SRC、DSH_PROBE_TIMEOUT_MS
import { fork } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClientRequest, parseServerResponse } from "../../src/lib/rpc-envelope.js";
import { lastRoundOutput } from "../../src/tools/subtool/query.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(process.env.DSH_REPO_ROOT || join(here, "..", ".."));
const KEEP = process.argv.includes("--keep");
const promptArg = (() => {
  const i = process.argv.indexOf("--prompt");
  return i >= 0 ? String(process.argv[i + 1] || "").trim() : "";
})();
const dataDir = resolve(process.env.DSH_DATA_DIR || join(REPO, "_tmp", "probe-data"));
const depsRoot = resolve(process.env.DSH_DEPS_ROOT || join(REPO, "node_modules"));
const cordisSrc = resolve(process.env.DSH_CORDIS_SRC || join(REPO, "dist", "cordis"));
const entry = join(REPO, "dist", "runtime", "dsh-host.mjs");
const READY_TIMEOUT_MS = Number(process.env.DSH_PROBE_TIMEOUT_MS || 240000);
const RUN_TIMEOUT_MS = Number(process.env.DSH_PROBE_RUN_TIMEOUT_MS || 300000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opaque = (n = 24) => randomBytes(n).toString("base64url");
const say = (...a) => console.log("[probe]", ...a);
const short = (v, n = 260) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s === undefined ? "undefined" : (s.length > n ? s.slice(0, n) + "…" : s);
};
const keysOf = (v) => (v && typeof v === "object" ? Object.keys(v) : "(" + typeof v + ")");

async function probeOk(port) {
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/", { signal: AbortSignal.timeout(1500) });
    return res.status >= 200 && res.status < 600;
  } catch {
    return false;
  }
}

function writeConfig(payload) {
  const dir = join(dataDir, "integration");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `probe-${opaque(8)}.json`);
  writeFileSync(file, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return file;
}

function forkEntry(configPath) {
  const child = fork(entry, [configPath], { stdio: ["ignore", "inherit", "inherit", "ipc"], env: { ...process.env } });
  let exit = null;
  child.once("exit", (code, signal) => { exit = { code, signal }; say("child exit code=" + code + " signal=" + (signal || "")); });
  return { child, exit: () => exit };
}

async function stopChild(child, exitOf) {
  try { if (exitOf() === null) child.kill("SIGTERM"); } catch { /* 已退出 */ }
  for (let i = 0; i < 40 && exitOf() === null; i++) await sleep(250);
  if (exitOf() === null) { try { child.kill("SIGKILL"); } catch { /* ignore */ } await sleep(300); }
}

/** 控制面客户端（一元 rpc；流方法在 0.1.5 走 WS mux，本脚本不走）。 */
function controlClient(port, controlKey) {
  const call = async (action, args) => {
    const res = await fetch("http://127.0.0.1:" + port + "/_control", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hana-dsh-control": controlKey },
      body: JSON.stringify({ action, args }),
      signal: AbortSignal.timeout(Math.max(30000, READY_TIMEOUT_MS)),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`控制面 ${action} HTTP ${res.status}：${short(text, 300)}`);
    return text ? JSON.parse(text) : {};
  };
  return {
    call,
    async rpc(method, payload) {
      const { body } = buildClientRequest({ method, payload });
      return parseServerResponse(await call("rpc", { body }), body.rpcId);
    },
  };
}

const address = (sessionId) => ({ kind: "session", sessionId });
const recTypes = (records) => (Array.isArray(records) ? records : []).map((rec) => {
  if (rec && rec.type === "event" && rec.event) return String(rec.event.type);
  return String((rec && rec.type) || "?");
});

function showRecords(records, label) {
  const list = Array.isArray(records) ? records : [];
  say(label + " → records=" + list.length + " 类型序列: " + (recTypes(list).join(" | ") || "(空)"));
  for (const rec of list) {
    const ev = rec && rec.event ? rec.event : rec;
    say("   seq=" + (ev && ev.seq) + " type=" + (ev && ev.type) + " data=" + short(ev && ev.data, 320));
  }
}

async function runProbe() {
  const bridgePort = randomInt(38000, 52000);
  let dshPort = randomInt(38000, 52000);
  while (dshPort === bridgePort) dshPort = randomInt(38000, 52000);
  const controlKey = opaque();
  const configPath = writeConfig({
    dataDir, dshHome: join(dataDir, ".dsh"), dshPort, bridgePort,
    bridgeKey: opaque(), controlKey, readyMarker: "PROBE_READY:" + opaque(12), cordisSrc, depsRoot,
  });
  say("dataDir=" + dataDir);
  const { child, exit } = forkEntry(configPath);
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    if (exit() !== null) break;
    if (await probeOk(bridgePort)) { ready = true; break; }
    await sleep(500);
  }
  if (!ready) { say("BOOT_FAIL：" + (exit() ? "子进程提前退出" : "等待超时")); await stopChild(child, exit); return false; }

  const ctl = controlClient(bridgePort, controlKey);
  let pass = true;
  try {
    const before = await ctl.rpc("session/list", {});
    say("① session/list → items=" + ((before.items || []).length) + " value keys=" + keysOf(before));

    const created = await ctl.rpc("session/create", { cwd: dataDir });
    const sessionId = created && created.sessionId;
    say("② session/create → keys=" + keysOf(created) + " sessionId=" + sessionId);
    if (!sessionId) throw new Error("create 未返回 sessionId");

    const item0 = ((await ctl.rpc("session/list", {})).items || []).find((x) => x && x.sessionId === sessionId);
    say("③ 建后 list 项：asOfSeq=" + (item0 && item0.projections && item0.projections.asOfSeq)
      + " title=" + short(item0 && item0.projections && item0.projections.values && item0.projections.values.title)
      + " updatedAt=" + (item0 && item0.updatedAt));
    const page0 = await ctl.rpc("session/page", { address: address(sessionId), throughSeq: item0.projections.asOfSeq, maxMessages: 40 });
    showRecords(page0.records, "   建后 page(asOfSeq)");

    // ④ 写一条持久事件（rename），看日志前进后 asOfSeq 是否跟上——投影缓存新鲜度的关键证据
    const renamed = await ctl.rpc("session/rename", { sessionId, title: "probe 标题 " + opaque(3) });
    say("④ session/rename → " + short(renamed) + "（seq 即新事件的持久位置）");
    const item1 = ((await ctl.rpc("session/list", {})).items || []).find((x) => x && x.sessionId === sessionId);
    const asOf1 = item1 && item1.projections && item1.projections.asOfSeq;
    const title1 = item1 && item1.projections && item1.projections.values && item1.projections.values.title;
    say("   改名后 list 项：asOfSeq=" + asOf1 + "（rename.seq=" + (renamed && renamed.seq) + "）title=" + short(title1));
    const cursorKnown = renamed && Number.isFinite(renamed.seq) ? renamed.seq : null;
    if (cursorKnown !== null) {
      const aligned = asOf1 === cursorKnown;
      say("   投影 asOfSeq vs 真实末事件 seq：" + asOf1 + " / " + cursorKnown + " → " + (aligned ? "一致（缓存即 tip）" : "**落后或超前（需要上探 cut）**"));
      if (!aligned) pass = false;
      // page(asOfSeq+1) 是否被接受 = 上探探测法是否可靠
      try {
        await ctl.rpc("session/page", { address: address(sessionId), throughSeq: asOf1 + 1, maxMessages: 40 });
        say("   page(asOfSeq+1) 被接受 → 说明 asOfSeq 落后（上探法可用）");
      } catch (e) {
        say("   page(asOfSeq+1) 被拒 → asOfSeq 已在 tip：" + short(((e && e.message) || e), 160));
      }
    }
    const page1 = await ctl.rpc("session/page", { address: address(sessionId), throughSeq: asOf1, maxMessages: 40 });
    showRecords(page1.records, "   改名后 page(asOfSeq)");

    // ⑤ 可选：真跑一轮模型，核对最后一轮输出的提取
    if (promptArg) {
      say("⑤ prompt:", promptArg);
      await ctl.rpc("session/prompt", { sessionId, mode: "queue", content: [{ type: "text", text: promptArg }] });
      const runDeadline = Date.now() + RUN_TIMEOUT_MS;
      let running = true;
      while (Date.now() < runDeadline) {
        await sleep(2000);
        const it = ((await ctl.rpc("session/list", {})).items || []).find((x) => x && x.sessionId === sessionId);
        running = !!(it && it.running);
        if (!running) { say("   本轮结束：asOfSeq=" + (it && it.projections && it.projections.asOfSeq) + " stats=" + short(it && it.projections && it.projections.values && it.projections.values.sessionStats)); break; }
      }
      if (running) { say("   **轮询超时，本轮仍未结束**"); pass = false; }
      const it = ((await ctl.rpc("session/list", {})).items || []).find((x) => x && x.sessionId === sessionId);
      const cut = it && it.projections && it.projections.asOfSeq;
      const page = await ctl.rpc("session/page", { address: address(sessionId), throughSeq: cut, maxMessages: 40 });
      showRecords(page.records, "   本轮后 page(asOfSeq)");
      const out = lastRoundOutput(page.records);
      say("   lastRoundOutput: scope=" + out.scope + " turn=" + out.turn + " interrupted=" + out.interrupted);
      say("   结论文本: " + short(out.text, 500));
      if (out.scope !== "round" || !out.text) pass = false;
    }
  } catch (e) {
    say("PROBE_FAIL：" + ((e && e.message) || e));
    pass = false;
  } finally {
    await stopChild(child, exit);
  }
  return pass;
}

async function main() {
  mkdirSync(dataDir, { recursive: true });
  const ok = await runProbe();
  if (!KEEP) rmSync(dataDir, { recursive: true, force: true });
  say("exit=" + (ok ? "ok" : "fail"));
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("[probe] error:", e); process.exit(2); });
