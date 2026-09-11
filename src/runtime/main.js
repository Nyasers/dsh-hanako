// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/main.js — dsh-hanako App v2 受管 Node runtime 入口主体（迁移指南 §13 步骤 2）
//
// 打包产物：dist/runtime/dsh-host.mjs（rspack ESM bundle；宿主 ctx.runtime.start({ runtime:
// "node", entry: "runtime/dsh-host.mjs", ... }) 加载后自持生命周期，不再回宿主进程）。
// 职责（与 v1 进程内 boot 拆分对照）：
//   1. 解析 App 自有配置（唯一 argv = 私有运行时配置文件路径，0600，启动即删；schema 见
//      options.js）——字段与 App 主进程 src/lib/managed-runtime.js buildRuntimeConfig()
//      对偶一致（凭据/端口不经 argv/环境变量/日志）；
//   2. connectAppRuntime() 连宿主（tasks/models/network.fetch/close；无父 IPC fd 时给
//      可操作报错 + 退出码 3，绝不假装能跑）；
//   3. 设置本进程自有 env（DSH_HOME/DSHANA_*，不污染宿主进程环境——迁移指南 §4）；
//   4. 依赖就位（随包物化在 <installRoot>/node_modules，无运行时安装）；
//   5. profile 种子化（profiles/dshana → installDir cordis scope 链接，seed.js）；
//   6. 子进程内 boot DSH（locateDsh → appBoot.loadLayeredEnv → profileBoot.runProfile，
//      复用 v1 loadInprocDsh 思路；webserver 监听配置中的 dshPort）；
//   7. 真实监听成功（webServer 服务端口 === 期望端口 + HTTP 探测）才向 stdout 打印
//      约定 readyMarker（独占一行、无前缀）——任何失败路径绝不打印 READY（指南 §10）；
//   8. SIGTERM/SIGINT/父进程 disconnect → 优雅释放：关 DSH fiber（含 webserver）→ 再
//      hana.close()。顺序纪律（指南 §7）：拿到流式 Response 后不能立刻 close()——本步
//      尚未消费任何宿主流，hana.close() 只在退出前调用；步骤 3 接流后此处在关闭前须
//      先结束/取消活动流。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { parseRuntimeConfig, UsageError, USAGE } from "./options.js";
import { startDshBridge } from "./bridge.js";
import { readFirstFrames } from "./stream-frames.js";
import { info, warn, err } from "./log.js";
// @hana/app-sdk 为 devDependencies（file:vendor/hana-app-sdk/hana-app-sdk.tgz，版本随宿主
// 0.946.2 App 契约）；connectAppRuntime 运行时实现经 rspack 构建时静态内联进本 bundle（只
// 依赖 node:crypto，无运行时包解析——见 rspack.config.mjs 打包纪律注释）。升级 = 换 vendor
// 里的 sdk tgz + pnpm install + 重建。
import { connectAppRuntime } from "@hana/app-sdk";
import { startTaskBridge } from "./task-bridge.js"; // 步骤 3：DSH 事件 → Hana task 回投
import { startApprovalBridge } from "./approval-bridge.js"; // 步骤 4a：DSH 审批 → Hana requestApproval/watch 对账
import { resolveInstallRoot, locateDsh } from "./locate.js";
// 依赖 ensure 已退役（2026-09-10）：依赖随包物化在安装目录 node_modules。
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
    // 中继关闭（异步；释放监听与在途连接）
    if (state.bridge && typeof state.bridge.close === "function") {
      try {
        await state.bridge.close();
      } catch (e) {
        warn("中继关闭异常（继续退出）：" + ((e && e.message) || e));
      }
      state.bridge = null;
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
 * 预检模式（数据源切换探针）：只验证「依赖就位 → 定位 DSH → profile 种子化」能否在
 * 目标 DSH_HOME 上成立，不连宿主 IPC、不 boot DSH、不起中继。
 * 结果写 resultPath（{ok:true} 或 {ok:false,error}，0600）后立即退出——父侧等终态读结果。
 * 退出码对齐 classify：0 = 预检通过；4 = deps/locate；5 = profile 种子化未完成。
 */
async function runPreflight({ opts, dataDir, dshHome, runtimeDir, depsRoot, cordisSrc }) {
  const write = (payload) => writeFileSync(opts.resultPath, JSON.stringify(payload), { mode: 0o600 });
  try {
    process.env.DSH_HOME = dshHome;
    process.env.DSHANA_HOME = dataDir;
    process.env.DSHANA_ROOT = runtimeDir;
    mkdirSync(dshHome, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    info(`预检开始：dshHome=${dshHome} depsRoot=${depsRoot}`);
    const located = await locateDsh({ depsRoot, log: (s) => info("locate", s) });
    const outcome = await seedDshanaProfile({
      dshHome,
      cordisSrc,
      appBoot: located.appBoot,
      log: (s) => info("seed", s),
    });
    if (outcome === "missing-source" || outcome === "refused" || outcome === "failed" || outcome === "init-failed") {
      err("preflight", `profile 种子化未完成（outcome=${outcome}）：cordisSrc=${cordisSrc}`);
      write({ ok: false, error: `目标数据目录不可用：profile 种子化 ${outcome}（详情见 runtime 日志）` });
      process.exit(EXIT.SEED);
    }
    info(`预检通过（seed=${outcome}）`);
    write({ ok: true, dshHome });
    process.exit(EXIT.OK);
  } catch (e) {
    const text = (e && e.message) || String(e);
    err("preflight", "预检失败：" + text);
    try {
      write({ ok: false, error: text });
    } catch (writeErr) {
      err("preflight", "结果文件写入失败（由父侧超时兜底）：" + ((writeErr && writeErr.message) || writeErr));
    }
    process.exit(EXIT.DEPS);
  }
}

/**
 * 主流程（导出便于宿主/测试以不同 argv 调用；正常由 bundle 顶部执行）。
 * @returns 退出码（成功就绪后由信号/断连驱动退出，本函数返回 EXIT.OK）
 */
export async function main(argv) {
  let opts;
  try {
    opts = parseRuntimeConfig(argv, (p) => readFileSync(p, "utf8"));
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
  info(opts.preflight
    ? `dsh-host 启动（preflight 预检）：dshHome=${opts.dshHome} dataDir=${opts.dataDir}`
    : `dsh-host 启动（managed node runtime entry）：dshPort=${opts.dshPort} bridgePort=${opts.bridgePort} dataDir=${opts.dataDir}`);

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
  // 依赖根默认指向 App 安装目录（随包物化的 node_modules）；--deps-root 可覆盖（调试）。
  const depsRoot = resolve(opts.depsRoot || join(installRoot, "node_modules"));
  const cordisSrc = resolve(opts.cordisSrc || join(installRoot, "cordis"));
  const dshHome = opts.dshHome ? resolve(opts.dshHome) : join(dataDir, ".dsh");
  // ---- 0) 预检模式（数据源切换探针）：不连宿主 IPC、不起服务，只验证目标 home 可用性 ----
  if (opts.preflight) {
    return await runPreflight({ opts, dataDir, dshHome, runtimeDir, depsRoot, cordisSrc });
  }
  const state = { hana: null, ctx: null, stopBridge: null, stopApproval: null, bridge: null };
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
  // DSH_HOME 已在上方定下（当前数据源 / 旧行为回落）。
  mkdirSync(dshHome, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  process.env.DSH_HOME = dshHome;
  process.env.DSHANA_HOME = dataDir;
  process.env.DSHANA_ROOT = runtimeDir; // loadDeps 基座（v1 = 插件根；v2 = dataDir 依赖区）
  if (!process.env.DSHANA_BUS_SECRET) process.env.DSHANA_BUS_SECRET = randomUUID();
  info(`env：DSH_HOME=${dshHome} DSHANA_ROOT=${runtimeDir} DSHANA_HOME=${dataDir}`);

  // ---- 3) 依赖就位（自包含打包：依赖随包在 <installRoot>/node_modules，无运行时安装）----
  info(`依赖区：${depsRoot}（随包物化，无 ensure）`);

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
  info(`runProfile({ profile: ${PROFILE_NAME}, port: ${opts.dshPort} }) …`);
  let boot;
  try {
    boot = await located.profileBoot.runProfile({
      environment,
      profile: PROFILE_NAME,
      patchFiles: [],
      args: ["--port", String(opts.dshPort), "--no-open"],
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
    await waitWebReady({ ctx: boot.ctx, expectedPort: opts.dshPort, log: info });
  } catch (e) {
    const text = (e && e.message) || String(e);
    const kind = /未在期望端口/.test(text) ? "port-unreachable" : "boot-failed";
    err("ready", `就绪等待失败（${kind}）：${text}`);
    err("exit", "exit=" + EXIT.PORT + " kind=" + kind);
    await shutdown("ready-failed", EXIT.PORT);
    return EXIT.PORT;
  }
  info(`webserver 已在 127.0.0.1:${opts.dshPort} 真实监听——准备凭据交换与中继`);
  // ---- 7) 桥挂载（步骤 3 + 步骤 4a）：订阅 DSH 事件 → Hana task/审批。
  // 先于 readyMarker（App 等到 ready 后才提交 session.create/prompt，事件在 prompt 之后
  // 才发生——先挂订阅无遗漏窗口）。失败不阻断就绪（桥不可用时任务将无终态/审批回投，
  // 由 App 侧日志与超时暴露——见 DESIGN「已测/未测边界」）。----
  // ---- 6.5) DSH 凭据交换 + 中继（本 App 唯一服务面）----
  // 官方 connection（BrowserAuth）生效后，宿主 runtime 代理会剥 cookie，App 页/App 主进程都
  // 无法直接携带 DSH 凭据。交换得到 DSH cookie 后由中继统一注入——注册给宿主的 service.port
  // 是中继端口，DSH 真实端口只在中继上游出现（对齐官方样例 hana-dsh 的 bootstrap.mjs）。
  const upstreamOrigin = "http://127.0.0.1:" + opts.dshPort;
  let dshCookie = "";
  try {
    const connection = typeof boot.ctx.get === "function" ? boot.ctx.get("connection") : null;
    if (!connection || typeof connection.authenticatedUrl !== "function") {
      throw new Error("dshana profile 未提供官方 connection（BrowserAuth 凭据面）——检查 bundle 层序：需含 @deepseek-ai/dsh-web-app");
    }
    const launch = connection.authenticatedUrl(upstreamOrigin);
    const exchange = await fetch(launch, { redirect: "manual" });
    const setCookie = typeof exchange.headers.getSetCookie === "function"
      ? exchange.headers.getSetCookie()[0]
      : exchange.headers.get("set-cookie");
    await exchange.body?.cancel().catch(() => {});
    if (!setCookie) throw new Error("DSH 浏览器凭据交换失败（未返回 Set-Cookie）");
    dshCookie = String(setCookie).split(";", 1)[0];
    info("DSH 凭据已交换（BrowserAuth cookie 就绪）");
  } catch (e) {
    err("auth", "DSH 凭据交换失败（中继无法通过 DSH 鉴权）：" + ((e && e.message) || e));
    err("exit", "exit=" + EXIT.PORT + " kind=auth-exchange");
    await shutdown("auth-failed", EXIT.PORT);
    return EXIT.PORT;
  }
  try {
    state.bridge = await startDshBridge({
      port: opts.bridgePort,
      bridgeKey: opts.bridgeKey,
      controlKey: opts.controlKey,
      upstreamOrigin,
      upstreamCookie: dshCookie,
      // 控制面：App 工具（controller.invoke）经宿主 ctx.runtime.fetch(runtimeId, "/_control") 到达
      // 这里，由本进程带 cookie 转发到 DSH /api（App 侧不直接摸 DSH HTTP，也不需 network 到中继）。
      // 参数 = 客户端信封本身（buildClientRequest 产物，含 rpcId/method/payload）。
      onControl: async (action, args) => {
        // prepare-switch：数据源切换前的忙判定守门（冻结标志由中继置位/解除）。0.1.2 下 DSH
        // 无稳定对外「忙」服务口，故按可用性尽力判定：agents 服务在则查运行中/排队中的
        // agent；不在则放行（会话忙判定的正式接入见数据源切换刀 T3）。
        if (action === "prepare-switch") {
          let busy = false;
          try {
            const agents = typeof boot.ctx.get === "function" ? boot.ctx.get("agents") : null;
            const list = agents && typeof agents.list === "function" ? agents.list() : null;
            busy = Array.isArray(list) && list.some((agent) => agent && (
              agent.status === "running"
              || (agent.inbox && (
                (Array.isArray(agent.inbox.nextTurn) && agent.inbox.nextTurn.length > 0)
                || (Array.isArray(agent.inbox.nextStep) && agent.inbox.nextStep.length > 0)
              ))
            ));
          } catch (e) {
            err("switch-gate", "agents 忙判定不可用（放行）：" + ((e && e.message) || e));
          }
          if (busy) throw new Error("DSH 仍有运行中/排队中的任务，先结束或停止它们再切换数据源。");
          info("switch-gate：无在途工作，允许切换数据源（prepare-switch）");
          return { ready: true };
        }
        // 控制动作分两类：
        //   rpc          一元方法：转发客户端信封到 DSH /api/<method>，回 JSON。
        //   stream-first 流式方法（session/follow 等）：只取前 maxFrames 帧就取消订阅——
        //                读路径需要开场 snapshot（throughSeq + records）但不持续跟流时用。
        if (action !== "rpc" && action !== "stream-first") {
          throw new Error("未知控制动作：" + String(action));
        }
        const body = args && args.body;
        if (!body || typeof body !== "object" || typeof body.method !== "string") {
          throw new Error(action + " 控制动作需要客户端信封 body（{ type, rpcId, method, payload }）");
        }
        const res = await fetch(upstreamOrigin + "/api/" + body.method, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: dshCookie },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error("DSH /api/" + body.method + " HTTP " + res.status + (text ? "：" + text.slice(0, 300) : ""));
        }
        if (action === "stream-first") {
          return { frames: await readFirstFrames(res, args && args.maxFrames) };
        }
        return await res.json();
      },
      log: (s) => info("dshbridge", s),
    });
  } catch (e) {
    err("dshbridge", "中继启动失败：" + ((e && e.message) || e));
    err("exit", "exit=" + EXIT.PORT + " kind=bridge-bind");
    await shutdown("bridge-failed", EXIT.PORT);
    return EXIT.PORT;
  }
  // 反向 session.cancel 经中继（带 bridgeKey）；不再直连免鉴权 DSH 端口。
  const serviceBaseUrl = "http://127.0.0.1:" + opts.bridgePort;
  try {
    state.stopBridge = startTaskBridge({
      ctx: boot.ctx,
      hana,
      dataDir,
      serviceBaseUrl, // 宿主任务取消反向触发 → 本进程 DSH session.cancel（只本会话，经中继）
      bridgeKey: opts.bridgeKey,
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
