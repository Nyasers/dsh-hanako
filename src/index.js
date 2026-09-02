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
//     不 await 端口就绪，避免拖住宿主启动；失败记 webLastError，工具调用时重试）
//  4. 插件卸载/重载时回收常驻 web host 子进程。
// 单例挂在 globalThis.__dshHanako（tools/dsh-run.js 的 rspack bundle 内联 app/lifecycle.js，
// mountLifecycle 挂 closeProcess/collectDiagnostics/updateDsh/startWebHost/installDeps/verifyDeps/
// checkDshUpdate）。本文件为 bundle 收敛入口：静态 import 全部插件模块（单 bundle 内无模块缓存问题）。
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
// 日志生命周期（vX 起独立于 migrate 体系）：旧日志归档压缩 + 时间戳日志文件命名
import { archiveOldLogs, logFileStamp, nextTimestampLogPath } from "./log-archive.js";

// ---- bundle 收敛 ----（单 bundle 形态）
// 生命周期能力：src/lifecycle.js 顶层 mountLifecycle() 在 import 时即挂单例
import "./lifecycle.js";
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
    this.register(() => {
      if (g && typeof g.closeProcess === "function") {
        Promise.resolve(g.closeProcess()).catch(() => {});
      }
    });

    // 拉起 dsh web host（随插件生命周期：加载即启动，卸载即回收）——异步 fire-and-forget：
    // onload 立即返回，不 await 端口就绪（ensureWebHost 有 60s 端口就绪等待，onload 不能被拖住）。
    // tools 模块由宿主在激活期间 import（注册工具），可能晚于本 onload；这里先做一次简短（<1s）
    // 轮询等单例方法挂上，再触发启动；触发后不 await 其结果（fire-and-forget，内部 try/catch
    // 记 g.webLastError / g.webLastLogPath，不抛到 onload）。启动失败不阻塞加载——首次工具调用
    // （dsh_run execute 内 ensureWebHost）或 /webui/start 手动启动时仍会可靠重试。
    //
    // 启动前依赖自动安装（onStartUp 自动装一次，类 pn i -P）：web host 进程内 boot 会动态
    // import 插件根 node_modules 的 dsh 依赖树（bootInproc → loadInprocDsh），依赖缺失/版本
    // 漂移/依赖图不完整时 boot 必失败——此前只能靠人工 dsh_install 或 DSHana 标签页自装。
    // 自动链把 installDepsFromPlugin（幂等：cliBin 在且已装版本 === 声明 + 运行级冒烟通过 →
    // skipped 快速返回；缺失/不一致/不完整才真跑 pnpm install --prod，官方源失败自动重试
    // npmmirror）提到 web host 启动（WebUI/总线就绪点）之前：装好再拉起，首次启动即装完即用。
    // 安装可能数分钟：在后台链执行，onload 早已返回，不阻塞宿主；安装失败不阻断启动尝试
    // （依赖缺失时 startWebHost 失败记 webLastError，工具调用/标签页仍可靠重试）。
    // 挂载探测失败（1s 内未挂上）不放弃自动链：转入后台延后等待（60s 兜底、1s 间隔），
    // 单例方法挂上后补跑同一启动链——不让短暂探测窗口丢失「启动自动安装 + web host 自启」
    // 承诺（否则延迟挂载的冷启动只能等工具调用才自愈）；仍未挂载才降级随工具调用启动。
    const waitMount = (async () => {
      for (let i = 0; i < 20; i++) {
        // 最多约 1s 等工具模块挂载（远小于旧的 5s 轮询与 60s 端口就绪等待）
        if (g && typeof g.startWebHost === "function") return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    })();
    // installDepsFromPlugin 的并发守卫在依赖操作进行中（g.deps.status 为 installing/
    // running，他人路径已触发）直接返回占位不等待其完成——自动链需要等它落终态再启动
    // web host，否则 boot 撞上未装完的依赖图白白失败一次。轮询 g.deps.status（2s 间隔，
    // 上限 300s 覆盖极端长安装）；超时返回 false 不抛（继续启动尝试，语义与失败一致）。
    const waitDepsSettled = async () => {
      const deadline = Date.now() + 300000;
      for (;;) {
        const st = g.deps && g.deps.status;
        if (st !== "installing" && st !== "running") return true;
        if (Date.now() > deadline) return false;
        await new Promise((r) => setTimeout(r, 2000));
      }
    };
    // 启动自动链：依赖安装（幂等，见上方注释）→ web host 启动。installDeps 与
    // startWebHost 在 lifecycle.js 顶层同批挂载（mountLifecycle），调用方已确认
    // startWebHost 挂载；installDeps 缺失时单独跳过自动安装降级为现状（web host
    // 随首次工具调用启动）。依赖安装段 catch 全部错误不抛出（记日志），web host
    // 启动段双参 .then 吞掉 reject，本函数不向外抛——waitMount 链永不因启动失败炸。
    const runStartupAutoChain = async () => {
      // 启动前依赖自动安装（与 startWebHost 同一后台链，先后执行）
      try {
        if (typeof g.installDeps !== "function") {
          g.appendLog?.(
            "hana",
            "installDeps 能力未挂载，跳过启动前依赖自动安装（随首次工具调用启动）",
          );
        } else {
          g.appendLog?.("hana", "启动前依赖自动安装：检查 dsh 依赖就绪…");
          const r = await g.installDeps(config, dataDir);
          if (r && r.ok) {
            g.appendLog?.(
              "hana",
              r.skipped
                ? "依赖已就绪（与声明一致，跳过安装）"
                : "依赖安装完成（pnpm install --prod，registry 兜底 + 运行级重验）",
            );
          } else if (r && r.state === "installing") {
            // 并发窗口：他人路径（dsh_install 工具/标签页）正在安装，等其落终态
            g.appendLog?.(
              "hana",
              "依赖安装已在其他路径进行中，等待完成后再启动 web host…",
            );
            const settled = await waitDepsSettled();
            const st = g.deps && g.deps.status;
            g.appendLog?.(
              "hana",
              settled
                ? "依赖安装已结束（" + (st || "?") + "）"
                : "依赖安装等待超时（300s），继续尝试启动 web host",
            );
          } else {
            g.appendLog?.(
              "hana",
              "依赖自动安装未成功：" +
                ((r && (r.error || r.state)) || "未知原因") +
                "，继续尝试启动 web host（失败将记入诊断，可工具/标签页重试）",
            );
          }
        }
      } catch (e) {
        g.appendLog?.(
          "hana",
          "启动前依赖自动安装异常：" + (e?.message || String(e)),
        );
      }
      // fire-and-forget：不 await 端口就绪（避免 ensureWebHost 60s 等拖住宿主启动）。
      // startWebHostFromPlugin 内部已 try/catch 记 webLastError 返回布尔，这里双兜底。
      await Promise.resolve(g.startWebHost(config, dataDir)).then(
        (ok) => {
          log.info(
            `[dsh-hanako] DSH web host ${ok ? "已随插件异步启动" : "启动未就绪（工具调用时将重试）"}`,
          );
          g.appendLog?.(
            "hana",
            `DSH web host 启动${ok ? "成功（已随插件异步启动）" : "未就绪（工具调用时将重试）"}`,
          );
        },
        (e) => {
          log.warn?.(
            "[dsh-hanako] web host 启动异常:",
            e?.message || String(e),
          );
          g.appendLog?.(
            "hana",
            `web host 启动异常：${e?.message || String(e)}`,
          );
        },
      );
    };
    // 挂载确认：initial=true（waitMount 已挂上）直接通过；否则后台延后等待（60s 兜底、
    // 1s 间隔）直到 startWebHost 挂载。超时返回 false（调用方降级随工具调用启动）。
    const ensureMounted = async (initial) => {
      if (initial) return true;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        if (g && typeof g.startWebHost === "function") return true;
      }
      return false;
    };
    waitMount
      .then(async (mounted) => {
        if (!mounted) {
          log.warn(
            "[dsh-hanako] 1s 内未等到工具模块加载，转入后台等待挂载后自动补跑启动链",
          );
          g.appendLog?.(
            "hana",
            "1s 内未等到工具模块加载，转入后台等待挂载（最长 60s），挂载后自动补跑依赖安装与 web host 启动",
          );
        }
        const ready = await ensureMounted(mounted);
        if (!ready) {
          log.warn(
            "[dsh-hanako] 60s 内工具模块仍未加载，DSH web host 将随首次工具调用启动",
          );
          g.appendLog?.(
            "hana",
            "60s 内工具模块仍未加载，DSH web host 将随首次工具调用启动",
          );
          return;
        }
        await runStartupAutoChain();
      })
      .catch((e) => {
        log.warn?.("[dsh-hanako] web host 启动异常:", e?.message || String(e));
        g.appendLog?.("hana", `web host 启动异常：${e?.message || String(e)}`);
      });

    log.info("[dsh-hanako] loaded");
    g.appendLog?.("hana", "plugin loaded");
  }
}
