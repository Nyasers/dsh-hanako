// index.js — dsh-hanako 生命周期
// 四件事：
//  1. onload 最前初始化统一日志（插件会话边界：时间戳会话文件，旧日志 zstd 压缩保留；挂单例 logPath/appendLog，
//     dsh-run.js 与 dsh-hana-provider 复用同一日志文件）
//  2. onload 时把插件实例 ctx 的 bus / resources / network 存进 globalThis 单例
//     （bus：deferred 唤醒兜底来源，工具执行 ctx 的 bus 宿主按调用注入，但 dev
//     invoke / 特殊路径可能缺失，双兜底；resources/network：dsh-run.js 宿主侧
//     provider 跟随 push 链路使用——ctx.resources.watch 感知配置变化 + ctx.network.fetch
//     回环调用 dsh web host，存在才存，与 bus 同模式）
//  3. onload 时拉起 dsh web host（随插件加载即启动，不等首次工具调用；
//     tools 文件可能晚于 onload 被宿主加载，先轮询等单例方法就绪）
//  4. 插件卸载/重载时回收常驻 web host 子进程。
// 单例挂在 globalThis.__dshHanako（tools/dsh-run.js 写入），这里不 import 插件文件，
// 避免 Hana 的模块缓存导致清理逻辑读取到旧模块。
import { existsSync, mkdirSync, renameSync, readdirSync, unlinkSync, appendFileSync, lstatSync, writeFileSync, readFileSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { join, dirname } from "node:path";

// ---- 统一日志（v0.10.8 定稿：时间戳会话文件 + 旧日志 zstd 压缩保留）----
// DSHana 插件全量运行日志：每次插件会话创建 <YYYYMMDD-HHmmss-SSS>.log 真实文件（文件名
// = 应用层生成的创建时刻，毫秒级唯一，不受 NTFS CreationTime 怪癖影响）；诊断面板/
// 错误信息直接引用该会话文件路径（g.logPath）。
// 旧日志策略（同 dsh session 持久化：全部保留，体积靠压缩）：onload 时把上一会话及
// 更早的时间戳 .log 用 Node 内置 node:zlib zstd 压缩为 .log.zst（标准 zstd 格式，
// magic 28b52ffd，任何 zstd 工具/库可解），删除原 .log——全部保留不删除。
// 会话边界 = 插件 onload：旧 latest.log 残留（历史版本遗留）归档/清理 → 压缩旧日志
// → 建新会话文件（空文件，无首行；会话开始以 onload 日志行为标识）。行格式
// [<HH:mm:ss.SSS>] [<src>] <内容>，src ∈ out/err/provider/theme/default-model/hana；写失败静默。
const LOG_NAME_RE = /^\d{8}-\d{6}(?:-\d+)?\.log$/;
function logTs() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function logFileStamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  const p3 = (n) => String(n).padStart(3, "0");
  // 毫秒级精度：同一秒内多次会话（快速重启）天然不撞名，无需后缀消歧
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p3(d.getMilliseconds())}`;
}
function appendLogLine(logPath, src, chunk) {
  try {
    if (!logPath) return;
    mkdirSync(dirname(logPath), { recursive: true });
    const text = String(chunk ?? "").replace(/\r\n/g, "\n").replace(/\n+$/, "");
    appendFileSync(logPath, `[${logTs()}] [${src}] ${text}\n`, "utf8");
  } catch { /* 日志失败不阻断 */ }
}
// 下一个时间戳日志文件路径（now 毫秒级命名；极端同毫秒冲突加 -i 后缀），用于新会话
// 文件与旧 latest 归档——文件名即应用层创建时刻，不依赖文件系统元数据
function nextTimestampLogPath(logsDir) {
  const stamp = logFileStamp(new Date());
  let target = join(logsDir, stamp + ".log");
  let i = 1;
  while (existsSync(target)) {
    i += 1;
    target = join(logsDir, stamp + "-" + i + ".log");
  }
  return target;
}
// 旧日志 zstd 压缩（全部保留，不删除；同 dsh session 持久化哲学）：扫描时间戳 .log
// （未压缩；.log.zst 不匹配正则自然跳过），zstd 压缩为 .log.zst 后删原文件；单个失败
// 保留原文件下次再试
function compressArchivedLogs(logsDir) {
  let count = 0;
  try {
    if (!existsSync(logsDir)) return 0;
    for (const f of readdirSync(logsDir)) {
      if (!LOG_NAME_RE.test(f)) continue;
      const src = join(logsDir, f);
      try {
        const raw = readFileSync(src);
        writeFileSync(src + ".zst", zstdCompressSync(raw));
        unlinkSync(src);
        count += 1;
      } catch { /* 单个压缩失败跳过（保留原文件） */ }
    }
  } catch { /* 扫描失败不阻断 */ }
  return count;
}

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
    // 旧 latest.log 残留（历史版本遗留）：归档避免残留（内容保留，会被 zstd 压缩）；
    // 旧链接直接删（内容在真实文件里）
    const latest = join(logsDir, "latest.log");
    let archivedName = null;
    if (existsSync(latest)) {
      try {
        const st = lstatSync(latest);
        if (st.isSymbolicLink()) unlinkSync(latest);
        else {
          archivedName = nextTimestampLogPath(logsDir);
          renameSync(latest, archivedName);
        }
      } catch { /* 旧文件处理失败不阻断 */ }
    }
    // 压缩旧日志（上一会话及更早的时间戳 .log → .log.zst，全部保留不删除；须在建新
    // 会话文件之前执行，避免把新会话文件也压缩）
    const compressed = compressArchivedLogs(logsDir);
    const sessionFile = nextTimestampLogPath(logsDir);
    const logPath = sessionFile;
    // 挂单例：dsh-run.js 的 logPath 优先取 g.logPath；appendLog 供 dsh-run 复用（行格式一致）
    g.logPath = logPath;
    g.appendLog = (src, chunk) => appendLogLine(logPath, src, chunk);
    if (archivedName) g.appendLog("hana", `日志归档：${archivedName}（上一插件会话）`);
    if (compressed > 0) g.appendLog("hana", `旧日志压缩：${compressed} 个`);
    g.appendLog("hana", "plugin onload（日志会话开始）");

    if (this.ctx?.bus && !g.bus) {
      g.bus = this.ctx.bus;
    }
    // resources/network 供 dsh-run.js 宿主侧 provider 跟随 push 链路使用（存在才存，
    // 与 bus 同模式；旧宿主版本可能无此服务，缺失时 dsh-run.js 降级不阻断）
    if (this.ctx?.resources && !g.resources) {
      g.resources = this.ctx.resources;
    }
    if (this.ctx?.network && !g.network) {
      g.network = this.ctx.network;
    }
    this.register(() => {
      if (g && typeof g.closeProcess === "function") {
        Promise.resolve(g.closeProcess()).catch(() => {});
      }
    });

    // 拉起 dsh web host（随插件生命周期：加载即启动，卸载即回收）
    // tools 模块由宿主在激活期间 import（注册工具），可能晚于本 onload；
    // 轮询最多 5s 等单例方法挂上，再触发启动。启动失败不阻塞加载（工具调用时重试）。
    const deadline = Date.now() + 5000;
    const tryStart = async () => {
      while (Date.now() < deadline) {
        if (g && typeof g.startWebHost === "function") {
          const ok = await g.startWebHost(config, dataDir);
          log.info(`[dsh-hanako] dsh web host ${ok ? "已随插件启动" : "启动未就绪（工具调用时将重试）"}`);
          g.appendLog?.("hana", `dsh web host 启动${ok ? "成功（已随插件启动）" : "未就绪（工具调用时将重试）"}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      log.warn("[dsh-hanako] 5s 内未等到工具模块加载，dsh web host 将随首次工具调用启动");
      g.appendLog?.("hana", "5s 内未等到工具模块加载，dsh web host 将随首次工具调用启动");
    };
    tryStart().catch((e) => {
      log.warn?.("[dsh-hanako] web host 启动异常:", e?.message || String(e));
      g.appendLog?.("hana", `web host 启动异常：${e?.message || String(e)}`);
    });

    log.info("[dsh-hanako] loaded");
    g.appendLog?.("hana", "plugin loaded");
  }
}
