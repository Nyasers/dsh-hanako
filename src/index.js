// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/index.js — dsh-hanako 生命周期 + bundle 收敛入口（单 bundle 形态）
// 四件事：
//  1. onload 最前初始化统一日志（插件会话边界：时间戳会话文件；旧日志 zstd 压缩保留经
//     src/migrate.js 统一迁移入口（g.runMigrations，archive-old-logs 步骤）执行——须在建新
//     会话文件之前；挂单例 logPath/appendLog，dsh-run.js 与 @dsh-hanako/provider 复用同一日志文件）
//  2. onload 时把插件实例 ctx 的 bus / resources / network 存进 globalThis 单例
//     （bus：deferred 唤醒兜底来源，工具执行 ctx 的 bus 宿主按调用注入，但 dev
//     invoke / 特殊路径可能缺失，双兜底；resources/network：dsh-run.js 宿主侧
//     provider 跟随 push 链路使用——ctx.resources.watch 感知配置变化 + ctx.network.fetch
//     回环调用 dsh web host，存在才存，与 bus 同模式）
//  3. onload 时异步拉起 dsh web host（fire-and-forget：随插件加载即后台启动，不等首次工具调用；
//     tools 文件可能晚于 onload 被宿主加载，做一次 <1s 简短轮询等单例方法就绪后触发启动，
//     不 await 端口就绪，避免拖住宿主启动；失败记 webLastError，工具调用时重试）。
//     T2 起启动链为持久状态机（spec：dsh-deps-zero-intervention）：依赖检查/安装 →
//     web host boot → ready，失败按 errorClass 退避重试或停等待条件，见 onload 内自动链注释）
//  4. 插件卸载/重载时回收常驻 web host 子进程。
// 单例挂在 globalThis.__dshHanako（tools/dsh-run.js 的 rspack bundle 内联 app/lifecycle.js，
// mountLifecycle 挂 closeProcess/collectDiagnostics/updateDsh/startWebHost/installDeps/verifyDeps/
// checkDshUpdate）。本文件为 bundle 收敛入口：静态 import 全部插件模块（单 bundle 内无模块缓存问题）。
import { existsSync, mkdirSync, appendFileSync, watch } from "node:fs";
import { join, dirname } from "node:path";
// 日志生命周期（vX 起独立于 migrate 体系）：旧日志归档压缩 + 时间戳日志文件命名
import { archiveOldLogs, logFileStamp, nextTimestampLogPath } from "./log-archive.js";

// ---- bundle 收敛 ----（单 bundle 形态）
// 生命周期能力：src/lifecycle.js 顶层 mountLifecycle() 在 import 时即挂单例
import "./lifecycle.js";
// T1 错误分类器（spec：dsh-deps-zero-intervention）——T2 自动链状态机（本文件 onload）对
// install/boot 失败归类决策（可恢复退避重试 / 不可恢复停等待条件）与指引文案，纯函数复用
import {
  classifyInstallError,
  ERROR_CLASS_GUIDANCE,
} from "./tools/lib/errclass.js";
// 5 个工具模块（ESM 导出 name/description/parameters/execute(+sessionPermission)；
// dsh_update 已并入 dsh_install 四合一，见 tools/dsh-install.js）
import * as dshInstall from "./tools/dsh-install.js";
import * as dshApprove from "./tools/dsh-approve.js";
// T7e 工具收敛：dsh-run / dsh-cancel 并入 dsh-session（create/send/cancel 分支），
// 不再作为独立工具注册；dsh-session.js 内部 import 复用它们的 execute 实现。
import * as dshSession from "./tools/dsh-session.js";
// 宿主 task 体系接入（handler.abort → dsh session.cancel）：取消链路收归宿主 task
// 协议（task:abort → handler.abort → session.cancel），dsh_cancel 不再直连取消
import { callUnaryBus } from "./tools/lib/protocol.js";
// 路由工厂（默认导出）
import registerWebuiRoutes from "./routes/webui.js";
import registerCardRoutes from "./routes/card.js";

// 工具清单（registerTool 消费普通契约；宿主自动加 pluginId_ 前缀）
// T7e：dsh-run/dsh-cancel 并入 dsh-session（create/send/cancel）；approve 独立保留
// （权限应答语义正交，非会话操作）；install 独立（依赖管理）。
const HANAKO_TOOLS = [dshSession, dshInstall, dshApprove];

// ---- 统一日志（时间戳会话文件；旧日志 zstd 压缩保留经 migrate.js 统一迁移入口）----
// DSHana 插件全量运行日志：每次插件会话创建 <YYYYMMDD-HHmmss-SSS>.log 真实文件（文件名
// = 应用层生成的创建时刻，毫秒级唯一，不受 NTFS CreationTime 怪癖影响）；诊断面板/
// 错误信息直接引用该会话文件路径（g.logPath）。
// 旧日志策略（同 dsh session 持久化：全部保留，体积靠压缩）：上一会话及更早的时间戳
// .log 用 Node 内置 node:zlib zstd 压缩为 .log.zst（标准 zstd 格式，magic 28b52ffd，任何
// zstd 工具/库可解），删除原 .log——全部保留不删除。该动作（含历史版本遗留的 latest.log
// 残留归档/清理）已收敛进 src/migrate.js 的 archive-old-logs 迁移步骤，经 g.runMigrations
// 单例调度（须在建新会话文件之前执行——见 onload）。
// 会话边界 = 插件 onload：经统一迁移入口归档/压缩旧日志 → 建新会话文件（空文件，无首行；
// 会话开始以 onload 日志行为标识）。行格式 [<HH:mm:ss.SSS>] [<src>] <内容>，
// src ∈ out/err/provider/theme/settings/hana/npm（npm = 依赖安装/升级的 npm i 原始输出
// 实时流，install.js emitLog 写入）；写失败静默。
function logTs() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
// 追加日志（行规范化）：\r\n / 裸 \r（npm 进度帧、TTY 重绘）统一折行，逐行加
// [ts] [src] 前缀、空行丢弃——保证会话日志每行都带时间戳/来源（旧实现整块只加一次
// 前缀，多行块后续行无前缀，不合规范）；chunk 内所有行共用同一时间戳（单次 append，
// 性能与旧实现一致）。副作用：跨 chunk 的半行按 chunk 边界拆成两行（诊断可接受）。
function appendLogLine(logPath, src, chunk) {
  try {
    if (!logPath) return;
    mkdirSync(dirname(logPath), { recursive: true });
    const lines = String(chunk ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
    if (!lines.length) return;
    const ts = logTs();
    appendFileSync(
      logPath,
      lines.map((l) => `[${ts}] [${src}] ${l}`).join("\n") + "\n",
      "utf8",
    );
  } catch {
    /* 日志失败不阻断 */
  }
}
// routes 具名导出：dist/routes/index.js 壳 import { pluginRoutes } 转发（组合工厂，一次挂全部路由）
export const pluginRoutes = (app, ctx) => {
  registerWebuiRoutes(app, ctx);
  registerCardRoutes(app, ctx);
};

export default class DshHanakoPlugin {
  async onload() {
    const { log, config, dataDir } = this.ctx;
    // 单例可能尚未被 tools 创建（工具从未调用过）：先建占位再写日志/服务
    if (!globalThis.__dshHanako || typeof globalThis.__dshHanako !== "object") {
      globalThis.__dshHanako = {};
    }
    const g = globalThis.__dshHanako;

    const logsDir = join(dataDir, "logs");
    mkdirSync(logsDir, { recursive: true });
    // 旧日志归档压缩（生命周期，每次运行执行——非版本迁移；vX 起独立于 migrate 体系）：
    // latest.log 残留归档 + 时间戳 .log → .log.zst（全部保留不删除）——须在建新会话文件
    // 之前执行（先归档 latest.log 再压缩旧日志，避免把新会话文件也压缩）；返回
    // { archivedName, compressed } 供下方记日志。
    const { archivedName, compressed } = archiveOldLogs({ dataDir });
    const sessionFile = nextTimestampLogPath(logsDir);
    const logPath = sessionFile;
    // 挂单例：dsh-run.js 的 logPath 优先取 g.logPath；appendLog 供 dsh-run 复用（行格式一致）
    g.logPath = logPath;
    g.appendLog = (src, chunk) => appendLogLine(logPath, src, chunk);
    if (archivedName)
      g.appendLog("hana", `日志归档：${archivedName}（上一插件会话）`);
    if (compressed > 0) g.appendLog("hana", `旧日志压缩：${compressed} 个`);
    g.appendLog("hana", "plugin onload（日志会话开始）");

    if (this.ctx?.bus && !g.bus) {
      g.bus = this.ctx.bus;
    }

    // ---- 宿主 task 体系接入（vX）：注册 dsh 任务 handler，取消链路收归宿主 task 协议 ----
    // dsh_session 提交的任务注册宿主 task（type: 'dsh' / 'dsh-approval'，taskId = dsh
    // sessionId）；宿主 task:abort / task:cancel 触发本 handler.abort → 转 dsh
    // session.cancel（Unary RPC 经总线 rpc.request 投递）。abort 回调运行时 web host
    // 必已就绪（任务运行中才可能被取消），callUnaryBus 取单例端口；取消失败静默，
    // 由任务终态兜底。宿主 Agent 侧开放 task 工具后，dsh_cancel 工具退役（当前保留，
    // 内部改走 task:abort）。
    const cancelByTask = (taskId) => {
      const sid = String(taskId || "").trim();
      if (!sid) return;
      Promise.resolve(callUnaryBus("session.cancel", { sessionId: sid })).catch(
        () => {
          /* 取消失败静默（任务终态兜底） */
        },
      );
    };
    if (this.ctx?.bus && typeof this.ctx.bus.request === "function") {
      for (const type of ["dsh", "dsh-approval"]) {
        this.ctx.bus
          .request("task:register-handler", { type, abort: cancelByTask })
          .then(
            (r) => {
              g.appendLog?.(
                "hana",
                `task handler 注册:${type}（${r && r.ok ? "ok" : "failed"}）`,
              );
            },
            (e) => {
              g.appendLog?.(
                "hana",
                `task handler 注册失败:${type}（${(e && e.message) || e}）`,
              );
            },
          );
      }
    }
    // resources/network 供 dsh-run.js 宿主侧 provider 跟随 push 链路使用（存在才存，
    // 与 bus 同模式；旧宿主版本可能无此服务，缺失时 dsh-run.js 降级不阻断）
    if (this.ctx?.resources && !g.resources) {
      g.resources = this.ctx.resources;
    }
    if (this.ctx?.network && !g.network) {
      g.network = this.ctx.network;
    }

    // ---- 工具注册（registerTool）----
    // 单 bundle：宿主不再扫描 tools/ 目录，onload 里逐工具 ctx.registerTool 注册。
    // registerTool 返回清理函数时交 this.register（卸载逆序自动清理）。
    for (const tool of HANAKO_TOOLS) {
      try {
        const unregisterTool = this.ctx.registerTool?.(tool);
        if (typeof unregisterTool === "function") this.register(unregisterTool);
        g.appendLog?.(
          "hana",
          `工具注册:${tool?.name || "?"}（ctx.registerTool）`,
        );
      } catch (e) {
        this.ctx.log?.warn?.(
          "[dsh-hanako] registerTool failed:",
          tool?.name || "",
          e?.message || e,
        );
        g.appendLog?.(
          "hana",
          `工具注册失败:${tool?.name || "?"}（${e?.message || e}）`,
        );
      }
    }
    // 卸载/重载标记：自动链状态机（见下）可能挂起数十秒至数分钟（等待挂载/等并发安装/
    // 安装本身/退避定时等待），期间插件可能被卸载/重载。卸载清理（closeProcess）执行后
    // 自动链若继续会重新拉起 web host，残留悬挂服务；此标记在清理回调置位，自动链在每个
    // 异步边界前检查（依赖安装前、startWebHost 前、退避定时回调、config 续跑），卸载即
    // 放弃：同时清掉挂起的退避定时器（g.boot.timer）与 config 续跑 watch（定时句柄/watch
    // 不跨会话有效，新 onload 会重新评估/调度）。
    let unloaded = false;
    this.register(() => {
      unloaded = true;
      // 防御：辅助函数在下方声明（同作用域 const），清理可能在极早期被宿主触发时未初始化
      if (typeof clearBootTimer === "function") clearBootTimer();
      if (typeof stopConfigWatch === "function") stopConfigWatch();
      if (g && typeof g.closeProcess === "function") {
        Promise.resolve(g.closeProcess()).catch(() => {});
      }
    });

    // ---- 启动自动链状态机（T2 spec：dsh-deps-zero-intervention 新增设计 2）----
    // 旧一次性启动链（runStartupAutoChain：依赖幂等装 → startWebHost，失败静默降级）升级为
    // 持久状态机，phase 流转：ensure-deps（依赖幂等检查/安装，install 失败按 g.deps.errorClass
    // 决策）→ waiting（失败停等：不可恢复类等条件变化 / 可恢复类退避等下一尝试）→ booting
    // （startWebHost）→ ready（收敛）。状态存单例 g.boot（state.js 兜底初始化，字段说明见
    // state.js；跨热更新保留，旧对象缺字段逐个兜底）。
    // 触发点（无常驻轮询）：① onload 挂载后首跑一次；② 可恢复失败 → 后台 setTimeout 退避
    // 链（30s→2m→10m→30m cap，插件生命周期内持续）到点自动重新评估；③ 停等类中配置引导
    // 类（macos-signature：nodejsPath 配置）→ fs.watch config.json 变化即重新评估（设置保存
    // 后自动续跑）；④ 宿主重启/插件重载 → 新 onload 重新评估（g.web?.ready 快速路径收敛）。
    // 手动/工具路径（dsh_install autoStart、/webui/start、诊断卡按钮）与状态机并存：
    // installDepsFromPlugin 的 installing/running 守卫 + ensureWebHost 的 readyPromise 幂等
    // ——他人路径先装/先起时状态机让路（等落终态或直接收敛），互不冲突。
    //
    // 失败决策（errorClass → 策略；install 分类由 T1 产出存 g.deps.errorClass，boot 失败在
    // 本文件经 classifyBootFailure 归类）：
    //   可恢复（自动退避重试）：network / environment / unknown / native-toolchain——前两者
    //     的 T1 guidance 明示「插件会自动重试」、unknown 保守可重试（spec 表）；native-toolchain
    //     等用户装好编译工具链后由退避链自动续跑（T1 guidance「完成后插件会自动重试」即此语义）。
    //   不可自动恢复（停 + 通知一次，不设退避定时器，等条件变化）：macos-signature（配置引导
    //     类 → config.json 变化续跑）/ declaration（声明或上游问题，等插件更新）/ restart-needed
    //     （boot 升级缓存残留，等重启宿主）——重载/重启后 onload 重新评估自动续跑。
    // 通知纪律：同一失败原因（阶段+errorClass+错误首行）只主动通知一次（会话日志一行 + 状态
    // 呈现 g.boot/g.deps/g.web，供 T3 快照端点消费）；后续重试只打「第 N 次 / 下次时间」进度
    // 日志，重试继续挂后台不打扰。
    const BACKOFF_MS = [30000, 120000, 600000, 1800000]; // 30s → 2m → 10m → 30m（cap）
    const IRRECOVERABLE_CLASSES = new Set([
      "macos-signature",
      "declaration",
      "restart-needed",
    ]);
    // 停等类中「配置变化即可续跑」的子集（挂 config.json watch；其余停等类只等重载/重启）
    const CONFIG_CONTINUE_CLASSES = new Set(["macos-signature"]);
    // boot 升级缓存残留特征（与 lifecycle.js pickProcessFix 判定同源）：跨 dsh 版本升级后
    // 宿主进程仍持旧模块缓存，boot 读已删 .pnpm 路径必败——重启宿主前重试无意义，归
    // restart-needed 停等
    const ENOENT_TEXT_RE = /(?:ENOENT|no such file|cannot find)/i;
    const STALE_PNPM_RE = /\.pnpm[\\/]@deepseek-ai\+dsh@/i;
    // 时刻/间隔可读化（会话日志展示下次重试时间）
    const pad2 = (n) => String(n).padStart(2, "0");
    const fmtClock = (t) => {
      const d = new Date(t);
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    };
    const fmtDelay = (ms) =>
      ms < 60000
        ? Math.round(ms / 1000) + " 秒"
        : ms < 3600000
          ? Math.round(ms / 60000) + " 分钟"
          : Math.round(ms / 3600000) + " 小时";
    // 状态机互斥：一次只跑一个评估（含长安装/等 settle 期间不响应新触发，避免重入打架）
    let machineBusy = false;
    // 主动通知去重键（同一失败原因只通知一次，见上面「通知纪律」；每次 onload 重置）
    let lastNotifiedKey = "";
    // config 续跑 watch（仅 CONFIG_CONTINUE_CLASSES 停等时挂载；卸载/离开停等时清理）
    let configWatch = null;
    let configWatchTimer = null;

    const clearBootTimer = () => {
      if (g.boot && g.boot.timer) {
        try {
          clearTimeout(g.boot.timer);
        } catch {
          /* 已触发/已清 */
        }
        g.boot.timer = null;
      }
    };
    const stopConfigWatch = () => {
      if (configWatchTimer) {
        try {
          clearTimeout(configWatchTimer);
        } catch {
          /* 已触发/已清 */
        }
        configWatchTimer = null;
      }
      if (configWatch) {
        try {
          configWatch.close();
        } catch {
          /* 已关闭 */
        }
        configWatch = null;
      }
    };
    // 退避定时：到点自动重新评估状态机（回调先查 unloaded；卸载清理已清 timer）
    const scheduleRetry = (delayMs) => {
      clearBootTimer();
      if (unloaded) return;
      g.boot.timer = setTimeout(() => {
        g.boot.timer = null;
        if (unloaded) return;
        g.appendLog?.("hana", "[自动链] 退避到点，自动重新评估…");
        kickAutoChain();
      }, delayMs);
    };
    // 状态机入口：串行化 + 兜底错误日志（不抛到 onload；内部各阶段另有决策）
    const kickAutoChain = () => {
      if (unloaded) return;
      if (machineBusy) return; // 已有评估在跑（含长安装/等待），让路
      machineBusy = true;
      Promise.resolve(runMachineEval())
        .catch((e) => {
          try {
            g.appendLog?.(
              "hana",
              "自动链状态机异常：" + (e?.message || String(e)),
            );
          } catch {
            /* 日志失败不阻断 */
          }
        })
        .finally(() => {
          machineBusy = false;
        });
    };
    // 收敛（ready）：清退避定时/config watch、重置尝试计数与失败记录
    const convergeReady = () => {
      clearBootTimer();
      stopConfigWatch();
      g.boot.phase = "ready";
      g.boot.attempt = 0;
      g.boot.nextRetryAt = null;
      g.boot.errorClass = null;
      g.boot.guidance = null;
      g.boot.lastError = null;
    };
    // 读最近 install 失败分类（T1 落 g.deps.errorClass = { errorClass, guidance }；
    // 缺失/未分类 → 保守 unknown：宁可退避重试不可误停）
    const readDepsErrorClass = () => {
      const ec = g.deps && g.deps.errorClass;
      if (ec && typeof ec === "object" && typeof ec.errorClass === "string") {
        return { errorClass: ec.errorClass, guidance: ec.guidance || null };
      }
      return { errorClass: "unknown", guidance: null };
    };
    // boot 失败分类：升级缓存残留 → restart-needed（需重启宿主，停等）；其余文本经错误
    // 分类器归类（多为 unknown → 保守退避；含网络/环境/声明特征时正确归类）
    const classifyBootFailure = (text) => {
      const t = String(text || "");
      if (ENOENT_TEXT_RE.test(t) && STALE_PNPM_RE.test(t)) {
        return {
          errorClass: "restart-needed",
          guidance:
            "检测到 dsh 跨版本升级缓存残留：请重启 Hana 加载新版本（重启后插件会自动续跑，无需其它操作）",
        };
      }
      return classifyInstallError({ milestoneLog: t });
    };
    // 失败处理（状态记录 + 决策 + 通知/日志；见机器头注释「失败决策」「通知纪律」）。
    // stage: "deps" | "boot"；返回 false = 本次评估到此为止（已退避定时或停等）
    const handleFailure = (stage, cls, errText, guidance) => {
      const klass = cls || "unknown";
      const text = String(errText || "未知原因").slice(0, 600);
      const stageLabel = stage === "deps" ? "依赖安装" : "web host 启动";
      g.boot.attempt += 1;
      g.boot.phase = "waiting";
      g.boot.errorClass = klass;
      g.boot.lastError = text;
      const head = text.split("\n")[0].slice(0, 160);
      // 通知纪律：同一失败原因（阶段+类别+错误首行）只主动通知一次；后续重试只打进度日志
      const notifyKey = stage + ":" + klass + ":" + head;
      const guide = guidance || ERROR_CLASS_GUIDANCE[klass] || "";
      // T3：失败决策的指引文案随失败状态落 g.boot.guidance（快照端点/壳页 action-needed
      // 渲染数据源——六类 + restart-needed 均有文案，页面不猜；成功收敛时随失败记录一并
      // 清空，见 convergeReady；重试期间保留最近一次失败文案，与 errorClass/lastError 同生命周期）
      g.boot.guidance = guide || null;
      if (notifyKey !== lastNotifiedKey) {
        lastNotifiedKey = notifyKey;
        g.appendLog?.(
          "hana",
          `[自动链] ${stageLabel}失败（第 ${g.boot.attempt} 次尝试）：${head}（errorClass=${klass}）`,
        );
        if (guide) g.appendLog?.("hana", "[自动链] 指引：" + guide);
      }
      if (IRRECOVERABLE_CLASSES.has(klass)) {
        // 不可自动恢复：停 + 等条件变化（不设退避定时器；重载/重启/配置变化后自动续跑）
        stopConfigWatch();
        g.boot.nextRetryAt = null;
        g.appendLog?.(
          "hana",
          `[自动链] ${stageLabel}失败属不可自动恢复类（${klass}）：自动链停等，${
            CONFIG_CONTINUE_CLASSES.has(klass)
              ? "配置（nodejsPath 等）保存后自动续跑"
              : "插件更新或重启宿主后自动续跑"
          }，无需手动操作`,
        );
        if (CONFIG_CONTINUE_CLASSES.has(klass)) watchConfigForContinue();
        return false;
      }
      // 可恢复：退避重试（后台 setTimeout 链；attempt 递增取档，超出取 30m cap）
      const idx = Math.min(g.boot.attempt - 1, BACKOFF_MS.length - 1);
      const delayMs = BACKOFF_MS[idx];
      stopConfigWatch();
      g.boot.nextRetryAt = Date.now() + delayMs;
      g.appendLog?.(
        "hana",
        `[自动链] ${stageLabel}失败（第 ${g.boot.attempt} 次，${klass}）：将于 ${fmtClock(g.boot.nextRetryAt)}（${fmtDelay(delayMs)} 后，第 ${g.boot.attempt + 1} 次）自动重试`,
      );
      scheduleRetry(delayMs);
      return false;
    };
    // 停等续跑：监听 dataDir/config.json 变化（fs.watch 目录 + 防抖）→ 变化即重新评估。
    // 目录级 watch 对「直接改写 / 原子替换落盘」两种形态都报文件名，过滤 config.json 即可
    // （日志写子目录不命中）；watch 建立失败降级（退化为等重载/重启续跑，不阻断）。
    const watchConfigForContinue = () => {
      stopConfigWatch();
      try {
        configWatch = watch(dataDir, (eventType, filename) => {
          const base = String(filename || "")
            .replace(/\\/g, "/")
            .split("/")
            .pop();
          if (base !== "config.json") return;
          if (unloaded) return;
          if (configWatchTimer) clearTimeout(configWatchTimer);
          configWatchTimer = setTimeout(() => {
            configWatchTimer = null;
            if (unloaded) return;
            g.appendLog?.("hana", "[自动链] config.json 变化，重新评估自动链…");
            kickAutoChain();
          }, 500);
        });
      } catch (e) {
        configWatch = null;
        g.appendLog?.(
          "hana",
          "[自动链] config 续跑 watch 建立失败（等重载/重启续跑）：" +
            (e?.message || e),
        );
      }
    };
    // installDepsFromPlugin 的并发守卫在依赖操作进行中（g.deps.status 为 installing/
    // running，他人路径已触发）直接返回占位不等待其完成——自动链需要等它落终态再启动
    // web host，否则 boot 撞上未装完的依赖图白白失败一次。轮询 g.deps.status（2s 间隔，
    // 上限 300s 覆盖极端长安装）——仅在此等待窗口轮询（机器常态无轮询）；超时返回 false
    // 不抛（调用方按未知可恢复退避，等安装真正结束后下一轮续跑）。
    const waitDepsSettled = async () => {
      const deadline = Date.now() + 300000;
      for (;;) {
        const st = g.deps && g.deps.status;
        if (st !== "installing" && st !== "running") return true;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 2000));
        // 等待期间卸载/重载：提前退出免空转（调用方同样在日志前拦截，见下）
        if (unloaded) return false;
      }
    };
    // ---- phase ensure-deps：依赖幂等检查/安装（g.installDeps 现状语义保留：cliBin 在且
    // 版本===声明 → skipped 秒回；缺失/漂移/不完整才 pnpm install --prod）----
    // 返回 true = 依赖就绪可进 booting；false = 失败已决策（退避定时/停等）或已卸载
    const ensureDepsStage = async () => {
      g.boot.phase = "ensure-deps";
      if (unloaded) return false;
      try {
        if (typeof g.installDeps !== "function") {
          // 能力缺失（installDeps 与 startWebHost 同在 lifecycle 顶层挂载，正常挂载后不
          // 可能；防御分支）：跳过自动安装直接尝试 boot（旧链同语义，boot 失败按分类决策）
          g.appendLog?.(
            "hana",
            "installDeps 能力未挂载，跳过启动前依赖自动安装（随首次工具调用启动）",
          );
          return true;
        }
        g.appendLog?.("hana", "启动前依赖自动安装：检查 dsh 依赖就绪…");
        const r = await g.installDeps(config, dataDir);
        if (unloaded) return false;
        if (r && r.ok) {
          g.appendLog?.(
            "hana",
            r.skipped
              ? "依赖已就绪（与声明一致，跳过安装）"
              : "依赖安装完成（pnpm install --prod，registry 兜底 + 自动核对）",
          );
          return true;
        }
        if (r && r.state === "installing") {
          // 并发窗口：他人路径（dsh_install 工具/标签页）正在安装，等其落终态再续
          g.appendLog?.(
            "hana",
            "依赖安装已在其他路径进行中，等待完成后再启动 web host…",
          );
          const settled = await waitDepsSettled();
          // 等待期间卸载/重载：静默退出，不打「超时/继续」误导日志
          if (unloaded) return false;
          const st = g.deps && g.deps.status;
          if (!settled) {
            // 300s 仍未落终态（极端长安装/他人路径挂起）：不盲目 boot 撞未装完依赖图——
            // 按未知可恢复退避，等安装真正结束后下一轮自动续跑
            g.appendLog?.(
              "hana",
              "依赖安装等待超时（300s，当前未就绪），自动链稍后重新检查",
            );
            return handleFailure(
              "deps",
              "unknown",
              "依赖安装等待超时（300s）未落终态",
              null,
            );
          }
          if (st === "error") {
            // 他人路径安装失败：errorClass 已由 install 失败路径落 g.deps.errorClass
            const ec = readDepsErrorClass();
            g.appendLog?.("hana", "依赖安装已结束（error），按失败分类决策");
            return handleFailure(
              "deps",
              ec.errorClass,
              g.deps?.error || "依赖安装失败（其他路径）",
              ec.guidance,
            );
          }
          g.appendLog?.(
            "hana",
            "依赖安装已结束（" + (st || "?") + "），继续启动 web host",
          );
          return true;
        }
        // 本次调用失败（ok:false state:error 或未知返回形态）：errorClass 决策
        const ec = readDepsErrorClass();
        return handleFailure(
          "deps",
          ec.errorClass,
          (r && (r.error || r.state)) || "依赖自动安装未成功（未知原因）",
          ec.guidance,
        );
      } catch (e) {
        // installDeps 内部异常（契约上不抛；防御）：无分类依据 → 未知保守退避
        g.appendLog?.(
          "hana",
          "启动前依赖自动安装异常：" + (e?.message || String(e)),
        );
        return handleFailure("deps", "unknown", String(e?.message || e), null);
      }
    };
    // ---- phase booting：startWebHost（进程内 boot dsh；fire-and-forget 语义保留——不
    // await 端口就绪拖住宿主启动，startWebHostFromPlugin 内部已 try/catch 记 webLastError
    // 返回布尔）---- 返回 true = 就绪收敛；false = 失败已决策（退避定时/停等）
    const bootStage = async () => {
      g.boot.phase = "booting";
      if (unloaded) return false;
      try {
        const ok = await Promise.resolve(g.startWebHost(config, dataDir)).then(
          (v) => v === true,
          (e) => {
            // startWebHost 内部 catch 不应 reject；双兜底（旧链同款）
            log.warn?.(
              "[dsh-hanako] web host 启动异常:",
              e?.message || String(e),
            );
            g.appendLog?.(
              "hana",
              `web host 启动异常：${e?.message || String(e)}`,
            );
            return false;
          },
        );
        if (unloaded) return false;
        if (ok) {
          log.info("[dsh-hanako] DSH web host 已随插件异步启动");
          g.appendLog?.("hana", "DSH web host 启动成功，自动链收敛（ready）");
          convergeReady();
          return true;
        }
        // 启动失败：g.webLastError 已由 startWebHostFromPlugin 记录（message + stderr 尾 +
        // 日志路径，boot 诊断就位）；按失败文本归类决策
        const cls = classifyBootFailure(
          String(g.webLastError || "web host 启动未就绪"),
        );
        g.appendLog?.("hana", "DSH web host 启动未就绪，按失败分类决策");
        return handleFailure(
          "boot",
          cls.errorClass,
          String(g.webLastError || "web host 启动未就绪"),
          cls.guidance,
        );
      } catch (e) {
        // 防御兜底（startWebHost 不应抛）
        g.appendLog?.(
          "hana",
          "web host 启动异常：" + (e?.message || String(e)),
        );
        return handleFailure("boot", "unknown", String(e?.message || e), null);
      }
    };
    // ---- 状态机一次推进：ensure-deps → booting → ready；失败由 handleFailure 决策并停止
    // 本次评估（退避定时/停等）。由 kickAutoChain 串行调用（machineBusy 互斥）。
    const runMachineEval = async () => {
      if (unloaded) return;
      // 快速路径：web host 已就绪（前次成功 / 手动·工具路径已拉起）→ 直接收敛（重入安全）
      if (g.web && g.web.ready) {
        g.appendLog?.("hana", "[自动链] web host 已就绪，自动链收敛");
        convergeReady();
        return;
      }
      const depsReady = await ensureDepsStage();
      if (!depsReady || unloaded) return; // ensureDepsStage 已决策或卸载中止
      // 依赖段（含并发等待）期间他人路径可能已拉起 web host：再查一次快速路径
      if (g.web && g.web.ready) {
        convergeReady();
        return;
      }
      await bootStage();
    };
    // 挂载探测：<1s 等工具模块挂上（tools 模块由宿主在激活期间 import，可能晚于本 onload；
    // 单例方法挂上后才触发自动链）。挂载探测失败（1s 内未挂上）不放弃自动链：转入后台延后
    // 等待（60s 兜底、1s 间隔），单例方法挂上后补跑同一自动链——不让短暂探测窗口丢失
    // 「自动安装 + web host 自启」承诺（否则延迟挂载的冷启动只能等工具调用才自愈）；
    // 仍未挂载才降级随工具调用启动。
    const waitMount = (async () => {
      for (let i = 0; i < 20; i++) {
        // 最多约 1s 等工具模块挂载（远小于旧的 5s 轮询与 60s 端口就绪等待）
        if (g && typeof g.startWebHost === "function") return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    })();
    // 挂载确认：initial=true（waitMount 已挂上）直接通过；否则后台延后等待（60s 兜底、
    // 1s 间隔）直到 startWebHost 挂载。超时返回 false（调用方降级随工具调用启动）。
    const ensureMounted = async (initial) => {
      if (initial) return true;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        // 卸载/重载：放弃等待（自动链入口同样拦截，这里提前退出免空转）
        if (unloaded) return false;
        await new Promise((r) => setTimeout(r, 1000));
        if (g && typeof g.startWebHost === "function") return true;
      }
      return false;
    };
    waitMount
      .then(async (mounted) => {
        // 入口守卫：waitMount 探测期间已卸载/重载（含探测返回 false 的卸载场景），
        // 静默放弃整个启动链——不打日志、不延后等待、不启动（CodeRabbit）
        if (unloaded) return;
        if (!mounted) {
          log.warn(
            "[dsh-hanako] 1s 内未等到工具模块加载，转入后台等待挂载后自动补跑启动链",
          );
          g.appendLog?.(
            "hana",
            "1s 内未等到工具模块加载，转入后台等待挂载（最长 60s），挂载后自动补跑自动链",
          );
        }
        const ready = await ensureMounted(mounted);
        if (!ready) {
          if (unloaded) return; // 卸载/重载：静默放弃（不误报"未加载"）
          log.warn(
            "[dsh-hanako] 60s 内工具模块仍未加载，DSH web host 将随首次工具调用启动",
          );
          g.appendLog?.(
            "hana",
            "60s 内工具模块仍未加载，DSH web host 将随首次工具调用启动",
          );
          return;
        }
        // 挂载就绪：启动自动链状态机首跑（fire-and-forget，onload 不等待其落终态；后续由
        // 退避定时/条件变化续跑，无常驻轮询——详见上面自动链注释）
        kickAutoChain();
      })
      .catch((e) => {
        log.warn?.("[dsh-hanako] web host 启动异常:", e?.message || String(e));
        g.appendLog?.("hana", `web host 启动异常：${e?.message || String(e)}`);
      });

    log.info("[dsh-hanako] loaded");
    g.appendLog?.("hana", "plugin loaded");
  }
}
