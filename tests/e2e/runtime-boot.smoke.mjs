// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/e2e/runtime-boot.smoke.mjs — dsh-host 离线 boot smoke（开发者本机验证用，不属
// node --test 默认集——文件名不匹配 *.test.*）
//
// 目的：在没有真实 Hana 宿主的情况下尽量验证受管 runtime 子进程能完成「定位 DSH →
// profile 种子化 → runProfile → webserver 真实监听」。用本仓库 node_modules 作 depsRoot
// 的预置替代（--no-ensure），dataDir 指向临时目录；经 child_process.fork 建立 IPC 通道
// （满足 connectAppRuntime 的 process.send 前置；boot 阶段不调用宿主流，父进程保持静默）。
// 就绪判据 = 子进程 webServer 对 http://127.0.0.1:<port>/ 的真实 HTTP 应答（等价于宿主的
// readyMarker 就绪门；真机验收仍须装包后由主上下文做，见 DESIGN「已测/未测边界」）。
//
// 用法（仓库根，已先 node src/build.js && node src-cordis/build.js）：
//   node tests/e2e/runtime-boot.smoke.mjs [--keep]
// 环境（缺省已指向本仓库）：DSH_REPO_ROOT、DSH_DATA_DIR、DSH_DEPS_ROOT、DSH_CORDIS_SRC、
//   DSH_SMOKE_PORT、DSH_SMOKE_TIMEOUT_MS
import { fork } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(process.env.DSH_REPO_ROOT || join(here, "..", ".."));
const PORT = Number(process.env.DSH_SMOKE_PORT || 43987);
const KEEP = process.argv.includes("--keep");
const dataDir = resolve(process.env.DSH_DATA_DIR || join(REPO, "_tmp", "smoke-data"));
const depsRoot = resolve(process.env.DSH_DEPS_ROOT || join(REPO, "node_modules"));
const cordisSrc = resolve(process.env.DSH_CORDIS_SRC || join(REPO, "dist", "cordis"));
const entry = join(REPO, "dist", "runtime", "dsh-host.mjs");
const READY_TIMEOUT_MS = Number(process.env.DSH_SMOKE_TIMEOUT_MS || 180000);

async function probeOk(port) {
  try {
    const res = await fetch("http://127.0.0.1:" + port + "/", { signal: AbortSignal.timeout(1500) });
    return res.status >= 200 && res.status < 600;
  } catch {
    return false;
  }
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const args = [
    "--port", String(PORT),
    "--data-dir", dataDir,
    "--deps-root", depsRoot,
    "--cordis-src", cordisSrc,
    "--ready-marker", "DSH_READY",
    "--no-ensure",
    "--hana-task-id", "smoke-1",
  ];
  console.log("[smoke] fork " + entry);
  console.log("[smoke]   dataDir=" + dataDir + "\n  depsRoot=" + depsRoot + "\n  cordisSrc=" + cordisSrc);
  const child = fork(entry, args, {
    stdio: ["ignore", "inherit", "inherit", "ipc"], // 子进程日志直接进本进程 stdout/stderr
    env: { ...process.env },
  });
  let exit = null;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
    console.log("[smoke] child exit code=" + code + " signal=" + (signal || ""));
  });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let ok = false;
  while (Date.now() < deadline) {
    if (exit !== null) break;
    if (await probeOk(PORT)) {
      ok = true;
      break;
    }
    await sleep(500);
  }
  if (ok) {
    console.log("[smoke] BOOT_OK：http://127.0.0.1:" + PORT + "/ 有 HTTP 应答（DSH webserver 真实监听）");
  } else {
    console.log("[smoke] BOOT_FAIL：" + (exit ? "子进程提前退出" : "等待超时（" + Math.round(READY_TIMEOUT_MS / 1000) + "s）"));
  }
  try {
    if (exit === null) child.kill("SIGTERM");
  } catch {
    /* 已退出 */
  }
  for (let i = 0; i < 40 && exit === null; i++) await sleep(250);
  if (exit === null) {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    await sleep(300);
  }
  if (!KEEP) rmSync(dataDir, { recursive: true, force: true });
  console.log("[smoke] exit=" + (ok ? "ok" : "fail"));
  process.exit(ok && (!exit || exit.code === 0) ? 0 : 1);
}

main().catch((e) => {
  console.error("[smoke] error:", e);
  process.exit(2);
});
