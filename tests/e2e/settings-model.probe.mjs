// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/e2e/settings-model.probe.mjs — 默认模型读写面真机探测（开发者本机用，非 node --test 默认集）
//
// 目的：在真 DSH 上核实 App 侧实现所依赖的三条契约（全是我们不能靠猜的东西）：
//   ① settings/describe 的实际返回形状，以及 agent-default-model 段视图（value + revision）；
//   ② session/modelCatalog 的形状（default / routableProviders / groups / failures）；
//   ③ settings/replace 的参数名与冲突语义：带当前 revision 写回成功（revision 前进），
//      带过期 revision 被拒——拒绝的错误码/文案就是 App 侧映射 409 的依据。
// 写入一律**原值原样写回**（no-op），并在结束时恢复原值；不碰别的段。
//
// 用法（仓库根，先 pnpm run build && node src-cordis/build.js）：
//   node tests/e2e/settings-model.probe.mjs [--keep]
// 环境：DSH_REPO_ROOT、DSH_DATA_DIR、DSH_DEPS_ROOT、DSH_CORDIS_SRC、DSH_PROBE_TIMEOUT_MS
import { fork } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClientRequest, parseServerResponse } from "../../src/lib/rpc-envelope.js";
import {
  AGENT_DEFAULT_MODEL_NS,
  isSettingsConflict,
  rpcModelCatalog,
  rpcSettingsDescribe,
  rpcSettingsReplace,
  settingsViewOf,
} from "../../src/lib/dsh-rpc.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(process.env.DSH_REPO_ROOT || join(here, "..", ".."));
const KEEP = process.argv.includes("--keep");
const dataDir = resolve(process.env.DSH_DATA_DIR || join(REPO, "_tmp", "probe-model-data"));
const depsRoot = resolve(process.env.DSH_DEPS_ROOT || join(REPO, "node_modules"));
const cordisSrc = resolve(process.env.DSH_CORDIS_SRC || join(REPO, "dist", "cordis"));
const entry = join(REPO, "dist", "runtime", "dsh-host.mjs");
const READY_TIMEOUT_MS = Number(process.env.DSH_PROBE_TIMEOUT_MS || 240000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opaque = (n = 24) => randomBytes(n).toString("base64url");
const say = (...a) => console.log("[model-probe]", ...a);
const short = (v, n = 300) => {
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

/** 控制面客户端：把一元 rpc 经 /_control 打进 DSH（与本仓库既有 probe 同款）。 */
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
    async raw(method, payload, opts) {
      const { body } = buildClientRequest({ method, payload, ...(opts || {}) });
      const json = await call("rpc", { body });
      const value = parseServerResponse(json, body.rpcId);
      return { value, request: body };
    },
    /** 与生产同形：经 dsh-rpc 的封装（fetch 走控制面，避免再起一条 HTTP 通道）。 */
    fetchVia: (method, payload, opts) => {
      const fn = async (url, init) => {
        const parsed = JSON.parse(String(init && init.body ? init.body : "{}"));
        const res = await call("rpc", { body: parsed });
        return {
          ok: true,
          status: 200,
          async text() { return JSON.stringify(res); },
          async json() { return res; },
        };
      };
      return (method === "settings/describe" ? rpcSettingsDescribe : method === "settings/replace" ? rpcSettingsReplace : rpcModelCatalog)(
        fn,
        "",
        payload,
        opts,
      );
    },
  };
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
    // ① describe 形状 + 默认模型段
    const described = await ctl.fetchVia("settings/describe", {});
    say("① settings/describe → 顶层 keys=" + keysOf(described));
    const nsList = described && described.namespaces;
    say("   writable=" + (described && described.writable) + " hasDocument=" + (described && described.hasDocument)
      + " namespaces=" + (Array.isArray(nsList) ? "数组[" + nsList.length + "]" : "(" + typeof nsList + ")")
      + " → " + short(Array.isArray(nsList) ? nsList.map((v) => v && v.ns) : nsList));
    const view = settingsViewOf(described, AGENT_DEFAULT_MODEL_NS);
    if (!view) { say("   **找不到 " + AGENT_DEFAULT_MODEL_NS + " 段**"); pass = false; }
    else {
      say("   段视图 keys=" + keysOf(view) + " value=" + short(view.value) + " revision=" + view.revision + " applies=" + view.applies);
      if (typeof view.revision !== "number") { say("   **revision 不是数字**（409 判据依赖它）"); pass = false; }
    }
    const original = view && view.value && typeof view.value === "object" ? { ...view.value } : null;

    // ② 候选模型
    const catalog = await ctl.fetchVia("session/modelCatalog", {});
    say("② session/modelCatalog → keys=" + keysOf(catalog));
    say("   default=" + short(catalog && catalog.default) + " routableProviders=" + short(catalog && catalog.routableProviders));
    const groups = (catalog && catalog.groups) || [];
    say("   groups=" + groups.length + " → " + groups.map((g) => (g && g.id) + "(" + ((g && g.models) || []).length + ")").join(", "));
    const first = groups.find((g) => g && Array.isArray(g.models) && g.models.length);
    if (first) say("   首个模型样例：" + short(first.models[0]));
    say("   failures=" + short(catalog && catalog.failures));
    if (!Array.isArray(groups)) { say("   **groups 不是数组**"); pass = false; }
    if (!catalog || !catalog.default) { say("   **缺 default**（页面要拿它做兜底选中）"); pass = false; }

    // ③ 写回与冲突
    if (view && original && typeof view.revision === "number") {
      const same = await ctl.fetchVia("settings/replace", {
        ns: AGENT_DEFAULT_MODEL_NS,
        section: original,
        expectedRevision: view.revision,
      });
      say("③ settings/replace(原值, rev=" + view.revision + ") → value=" + short(same && same.value) + " revision=" + (same && same.revision));
      if (!same || typeof same.revision !== "number" || same.revision === view.revision) {
        say("   注：revision 未前进（同值写入可能不 bump，不据此判失败）");
      }
      try {
        await ctl.fetchVia("settings/replace", {
          ns: AGENT_DEFAULT_MODEL_NS,
          section: original,
          expectedRevision: Math.max(0, view.revision - 1),
        });
        say("   **过期 revision 竟被接受**——冲突闸不成立，409 映射没有依据");
        pass = false;
      } catch (e) {
        const conflict = isSettingsConflict(e);
        say("   过期 revision 被拒：" + short((e && e.message) || e) + " → isSettingsConflict=" + conflict);
        if (!conflict) { say("   **错误码/文案未被 isSettingsConflict 识别**，需要按上面文案收口"); pass = false; }
      }
      // 恢复原值（不带 revision：不校验，确保一定写回）
      const restored = await ctl.fetchVia("settings/replace", { ns: AGENT_DEFAULT_MODEL_NS, section: original });
      say("   恢复原值 → value=" + short(restored && restored.value));
    } else {
      say("③ 跳过写回（没有可用的段视图/原值）");
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

main().catch((e) => { console.error("[model-probe] error:", e); process.exit(2); });
