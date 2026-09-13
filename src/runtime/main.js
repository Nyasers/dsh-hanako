// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/main.js — dsh-hanako App v2 受管 Node runtime 入口主体（迁移指南 §13 步骤 2）
//
// 打包产物：dist/runtime/dsh-host.mjs（rspack ESM bundle；宿主 ctx.runtime.start({ runtime:
// "node", entry: "runtime/dsh-host.mjs", ... }) 加载后自持生命周期，不再回宿主进程）。
// 职责（与 v1 进程内 boot 拆分对照）：
//   1. 解析 App 自有参数（--port/--data-dir/--hana-task-id/--deps-root/--cordis-src/
//      --ready-marker/--no-ensure，见 options.js）——参数名与 App 主进程
//      src/lib/managed-runtime.js buildRuntimeArgs() 对偶一致；
//   2. connectAppRuntime() 连宿主（tasks/models/network.fetch/close；无父 IPC fd 时给
//      可操作报错 + 退出码 3，绝不假装能跑）；
//   3. 设置本进程自有 env（DSH_HOME/DSHANA_*，不污染宿主进程环境——迁移指南 §4）；
//   4. 依赖 ensure（默认 <data-dir>/runtime 安装区，方案见 ensure-deps.js/DESIGN）；
//   5. profile 种子化（profiles/dshana → installDir cordis scope 链接，seed.js）；
//   6. 子进程内 boot DSH（locateDsh → appBoot.loadLayeredEnv → profileBoot.runProfile，
//      复用 v1 loadInprocDsh 思路；webserver 监听显式 --port）；
//   7. 真实监听成功（webServer 服务端口 === 期望端口 + HTTP 探测）才向 stdout 打印
//      约定 readyMarker（独占一行、无前缀）——任何失败路径绝不打印 READY（指南 §10）；
//   8. SIGTERM/SIGINT/父进程 disconnect → 优雅释放：关 DSH fiber（含 webserver）→ 再
//      hana.close()。顺序纪律（指南 §7）：拿到流式 Response 后不能立刻 close()——本步
//      尚未消费任何宿主流，hana.close() 只在退出前调用；步骤 3 接流后此处在关闭前须
//      先结束/取消活动流。
import { mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { parseArgs, UsageError, USAGE } from "./options.js";
import { info, warn, err } from "./log.js";
// @hana/app-sdk 为 devDependencies（file:./sdk/hana-app-sdk.tgz，版本随宿主 0.930.x 契约）；
// connectAppRuntime 运行时实现经 rspack 构建时静态内联进本 bundle（只依赖 node:crypto，
// 无运行时包解析——见 rspack.config.mjs 打包纪律注释）。升级 = 换 sdk tgz + pnpm install + 重建。
import { connectAppRuntime } from "@hana/app-sdk";
import { startTaskBridge } from "./task-bridge.js"; // 步骤 3：DSH 事件 → Hana task 回投
import { startApprovalBridge } from "./approval-bridge.js"; // 步骤 4a：DSH 审批 → Hana requestApproval/watch 对账
import { resolveInstallRoot, locateDsh } from "./locate.js";
import { ensureDeps } from "./ensure-deps.js";
import { seedDshanaProfile } from "./seed.js";

/** 退出码约定（App 主进程 managed-runtime.js classify 读 exitCode 归类；勿随意改）。 */
export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  IPC_UNAVAILABLE: 3,
  DEPS: 4,
  SEED: 5,
  BOOT: 6,
  PORT: 7,
  DISCONNECT: 8,
};

/** 就绪等待上限（v1 PORT_READY_TIMEOUT_MS 同量级；boot 已完成后的监听/探测窗口）。 */
export const READY_TIMEOUT_MS = 60000;
/** 优雅释放时 ctx.fiber.dispose 的最长等待（超时强退；dsh 自身 shutdown 5s 兜底）。 */
const DISPOSE_TIMEOUT_MS = 4000;
const PROFILE_NAME = "dshana";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** webServer service 的实际监听端口读回（listen 显式端口后 service.port = 实际端口）。 */
function resolveSvcPort(svc) {
  try {
    if (svc && typeof svc.port === "number" && svc.port > 0) return svc.port;
    const srv = svc && (svc._server || (svc.server && svc.server._server));
    if (srv && typeof srv.address === "function") {
      const a = srv.address();
      if (a && typeof a === "object" && a.port) return a.port;
    }
  } catch {
    /* 读端口失败 */
  }
  return 0;
}

/** HTTP 探测：任意 HTTP 应答（2xx/3xx/4xx/5xx）即视为「有服务在监听」；连接错误返回 false。 */
function probeHttp(port, timeoutMs) {
  return new Promise((resolveProbe) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", timeout: timeoutMs, headers: { connection: "close" } },
      (res) => {
        res.resume();
        resolveProbe(true);
      },
    );
    req.on("timeout", () => {
      try { req.destroy(); } catch { /* 已断 */ }
      resolveProbe(false);
    });
    req.on("error", () => resolveProbe(false));
  });
}

/**
 * 等 webServer 真实就绪：① DSH 侧 webServer 服务声称绑定了期望端口（防「别的进程占
 * 端口、探测撞到别人」的虚假 READY——若 DSH bind 失败，其服务端口不会等于期望值）；
 * ② 对 127.0.0.1:<expectedPort>/ 的 HTTP 探测成功。任一不满足即继续等至超时抛错。
 */
async function waitWebReady({ ctx, expectedPort, log }) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastPort = 0;
  for (;;) {
    let port = 0;
    try {
      const svc = typeof ctx.get === "function" ? ctx.get("webServer") : null;
      if (svc) port = resolveSvcPort(svc);
    } catch {
      /* 服务未暴露：继续等 */
    }
    lastPort = port;
    if (port === expectedPort && (await probeHttp(expectedPort, 1200))) return port;
    if (Date.now() >= deadline) {
      throw new Error(
        `DSH webserver 未在期望端口 ${expectedPort} 就绪（webServer 服务端口=${lastPort || "未暴露"}，HTTP 探测失败）。完整运行日志见宿主 runtime 日志。`,
      );
    }
    await sleep(250);
  }
}

/**
 * 有序释放：ctx.fiber.dispose（关 webserver/loader/插件树）→ hana.close()。幂等。
 * 不 await 超过 DISPOSE_TIMEOUT_MS（dsh profile-boot 的 shutdown 控制器还有 5s force
 * exit 兜底，见 locate/profile-boot 注释）。
 */
function makeShutdown(state, exitCodeLog) {
  let done = false;
  return async function shutdown(reason, code) {
    if (done) return;
    done = true;
    info(`shutdown：${reason}（exit ${code}）`);
    const ctx = state.ctx;
    const hana = state.hana;
    // 步骤 3/4a：先停任务桥与审批桥（退订 ctx 事件，防关闭中再触发回投/流消费）再 dispose
    for (const key of ["stopBridge", "stopApproval"]) {
      const fn = state[key];
      if (typeof fn === "function") {
        try {
          fn();
        } catch (e) {
          warn(key + " 退订异常（继续退出）：" + ((e && e.message) || e));
        }
        state[key] = null;
      }
    }
    try {
      // @dsh-hanako/provider 等子插件经该句柄取 hana client（见 main.js 步骤 1 注释）
      if (globalThis.__dshanaHana === hana) globalThis.__dshanaHana = null;
    } catch { /* 忽略 */ }
    try {
      if (ctx && ctx.fiber && typeof ctx.fiber.dispose === "function") {
        await Promise.race([
          Promise.resolve().then(() => ctx.fiber.dispose()),
          sleep(DISPOSE_TIMEOUT_MS),
        ]);
      }
    } catch (e) {
      warn("ctx dispose 异常（继续退出）：" + ((e && e.message) || e));
    }
    // 流纪律（指南 §7）：拿到流式 Response 后不能立刻 close。本步不消费宿主流；步骤 3
    // 接入模型/任务流后，此处必须先结束/取消活动流再 close（TODO 步骤 3）。
    try {
      if (hana && typeof hana.close === "function") hana.close();
    } catch {
      /* close 幂等 */
    }
    state.hana = null;
    state.ctx = null;
    process.exit(code);
  };
}

/**
 * 主流程（导出便于宿主/测试以不同 argv 调用；正常由 bundle 顶部执行）。
 * @returns 退出码（成功就绪后由信号/断连驱动退出，本函数返回 EXIT.OK）
 */
export async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(e.message + "\n\n" + USAGE);
      return EXIT.USAGE;
    }
    throw e;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return EXIT.OK;
  }
  info(`dsh-host 启动（managed node runtime entry）：port=${opts.port} dataDir=${opts.dataDir}`);

  const entryFile = fileURLToPath(import.meta.url);
  let installRoot;
  try {
    installRoot = resolveInstallRoot(entryFile);
  } catch (e) {
    err("install-root", (e && e.message) || e);
    return EXIT.INTERNAL;
  }
  const dataDir = resolve(opts.dataDir);
  const runtimeDir = join(dataDir, "runtime");
  const depsRoot = resolve(opts.depsRoot || join(runtimeDir, "node_modules"));
  const cordisSrc = resolve(opts.cordisSrc || join(installRoot, "cordis"));
  const state = { hana: null, ctx: null, stopBridge: null, stopApproval: null };
  const shutdown = makeShutdown(state, info);

  // ---- 1) 宿主 IPC（先于一切：非受管运行时立刻给出可操作报错，不输出 READY）----
  let hana = null;
  try {
    hana = connectAppRuntime();
  } catch (e) {
    err(
      "ipc",
      "connectAppRuntime() 失败：" + ((e && e.message) || e) +
      "。本入口只能由 Hana ctx.runtime.start({ runtime: \"node\" }) 启动——宿主在启动该" +
      " Node 进程时经父进程 IPC fd 注入受管通道（迁移指南 §7）。直接 node 运行无父 IPC，无法" +
      " 连接宿主 tasks/models/network，退出。",
    );
    return EXIT.IPC_UNAVAILABLE;
  }
  state.hana = hana;
  // 步骤 3 契约：@dsh-hanako/provider 等受管子进程内子插件经该句柄调用宿主
  // tasks/models/network（connectAppRuntime 的 client 对象；与插件同进程，globalThis
  // 共享——provider adapter 重建见 src-cordis/plugins/provider/index.js v2）。关闭顺序：
  // 先停 task-bridge/流，再 ctx dispose，最后 hana.close()（指南 §7 流纪律）。
  try {
    globalThis.__dshanaHana = hana;
  } catch { /* 忽略 */ }
  // 父进程退出（宿主 stop/卸载）：有序释放后退出
  process.on("disconnect", () => {
    void shutdown("parent-disconnect", EXIT.DISCONNECT);
  });
  // 信号（宿主 stop 语义）：SIGTERM 正常停（0）、SIGINT 用户中断（130）
  process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
  process.on("SIGINT", () => void shutdown("SIGINT", 130));
  info("宿主 IPC 已连接（connectAppRuntime；tasks/models/network 待步骤 3 消费）");

  // ---- 2) 进程级 env（自有受管进程内设置，不改宿主进程环境——指南 §4）----
  const dshHome = join(dataDir, "dsh-home");
  mkdirSync(dshHome, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  process.env.DSH_HOME = dshHome;
  process.env.DSHANA_HOME = dataDir;
  process.env.DSHANA_ROOT = runtimeDir; // loadDeps 基座（v1 = 插件根；v2 = dataDir 依赖区）
  if (!process.env.DSHANA_BUS_SECRET) process.env.DSHANA_BUS_SECRET = randomUUID();
  info(`env：DSH_HOME=${dshHome} DSHANA_ROOT=${runtimeDir} DSHANA_HOME=${dataDir}`);

  // ---- 3) 依赖 ensure（默认 <data-dir>/runtime 安装区；noEnsure/预置场景跳过）----
  const ensured = await ensureDeps({
    dataDir,
    installRoot,
    runtimeDir,
    depsRoot,
    noEnsure: opts.noEnsure,
    log: (s) => info("deps", s),
  });
  if (ensured.status === "error") {
    err("deps", `[${ensured.kind}] ${ensured.message}`);
    err("exit", "exit=" + EXIT.DEPS + " kind=deps-" + ensured.kind);
    return EXIT.DEPS;
  }
  info(`依赖状态：${ensured.status}（dsh@${ensured.dsh} cordis@${ensured.cordis}）`);

  // ---- 4) 定位 DSH + 种子化 profile（runProfile 前必须就位，否则 loadProfile 抛）----
  let located;
  try {
    located = await locateDsh({ depsRoot, log: (s) => info("locate", s) });
  } catch (e) {
    err("locate", (e && e.message) || e);
    err("exit", "exit=" + EXIT.DEPS + " kind=locate");
    return EXIT.DEPS;
  }
  let seedOutcome;
  try {
    seedOutcome = await seedDshanaProfile({
      dshHome,
      cordisSrc,
      appBoot: located.appBoot,
      log: (s) => info("seed", s),
    });
    info(`profile 种子化结果：${seedOutcome}（${cordisSrc}）`);
  } catch (e) {
    err("seed", "profile 种子化异常：" + ((e && e.message) || e));
    err("exit", "exit=" + EXIT.SEED + " kind=seed-error");
    return EXIT.SEED;
  }
  if (seedOutcome === "missing-source" || seedOutcome === "refused" || seedOutcome === "failed" || seedOutcome === "init-failed") {
    err("seed", `profile 种子化未完成（outcome=${seedOutcome}）：cordisSrc=${cordisSrc} 缺失或迁移被拒（见日志）`);
    err("exit", "exit=" + EXIT.SEED + " kind=seed-" + seedOutcome);
    return EXIT.SEED;
  }

  // ---- 5) 子进程内 boot DSH（profile dshana；显式端口；--no-open）----
  const environment = located.appBoot.loadLayeredEnv("dsh");
  info(`runProfile({ profile: ${PROFILE_NAME}, port: ${opts.port} }) …`);
  let boot;
  try {
    boot = await located.profileBoot.runProfile({
      environment,
      profile: PROFILE_NAME,
      patchFiles: [],
      args: ["--port", String(opts.port), "--no-open"],
    });
  } catch (e) {
    const text = (e && e.message) || String(e);
    const kind = /EADDRINUSE|address already in use/i.test(text) ? "port-busy" : "boot-failed";
    err("boot", `runProfile 失败（${kind}）：${text}`);
    err("exit", "exit=" + EXIT.PORT + " kind=" + kind);
    return EXIT.PORT;
  }
  state.ctx = boot.ctx;
  info(`DSH boot 完成（ctx=${!!boot.ctx}，shutdown=${typeof boot.shutdown}）——等待 webserver 真实监听`);

  // ---- 6) 就绪门：webServer 服务端口 === 期望端口 且 HTTP 探测成功，才打 readyMarker ----
  try {
    await waitWebReady({ ctx: boot.ctx, expectedPort: opts.port, log: info });
  } catch (e) {
    const text = (e && e.message) || String(e);
    const kind = /未在期望端口/.test(text) ? "port-unreachable" : "boot-failed";
    err("ready", `就绪等待失败（${kind}）：${text}`);
    err("exit", "exit=" + EXIT.PORT + " kind=" + kind);
    await shutdown("ready-failed", EXIT.PORT);
    return EXIT.PORT;
  }
  info(`webserver 已在 127.0.0.1:${opts.port} 真实监听——打印 readyMarker`);
  // ---- 7) 桥挂载（步骤 3 + 步骤 4a）：订阅 DSH 事件 → Hana task/审批。
  // 先于 readyMarker（App 等到 ready 后才提交 session.create/prompt，事件在 prompt 之后
  // 才发生——先挂订阅无遗漏窗口）。失败不阻断就绪（桥不可用时任务将无终态/审批回投，
  // 由 App 侧日志与超时暴露——见 DESIGN「已测/未测边界」）。----
  const serviceBaseUrl = "http://127.0.0.1:" + opts.port;
  try {
    state.stopBridge = startTaskBridge({
      ctx: boot.ctx,
      hana,
      dataDir,
      serviceBaseUrl, // 宿主任务取消反向触发 → 本进程 DSH session.cancel（只本会话）
      log: (s) => info("bridge", s),
    });
  } catch (e) {
    err("bridge", "task-bridge 挂载失败（任务终态将无回投）：" + ((e && e.message) || e));
  }
  try {
    state.stopApproval = startApprovalBridge({
      ctx: boot.ctx,
      hana,
      dataDir,
      log: (s) => info("approval", s),
    });
  } catch (e) {
    err("approval", "approval-bridge 挂载失败（DSH 越界审批将 fail-closed）：" + ((e && e.message) || e));
  }
  process.stdout.write(opts.readyMarker + "\n");
  return EXIT.OK;
}

// ---- bundle 自执行：受管 runtime 进程加载即跑（宿主只等 stdout readyMarker / 进程退出）----
const rawArgv = process.argv.slice(2);
main(rawArgv).then((code) => {
  // main 正常返回只发生在：usage/help/失败退出（已 return code）或成功就绪后（OK）。
  // 成功就绪后进程由信号/断连驱动 shutdown()（其内部 process.exit），此处不退出。
  if (code !== EXIT.OK) {
    try {
      process.exitCode = code;
    } catch {
      process.exit(code);
    }
  }
});
