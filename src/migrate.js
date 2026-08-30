// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/migrate.js — 源码层统一版本迁移入口（注册表式调度器）
// 背景：插件「版本迁移 / 历史遗留收敛」逻辑散落多处（index.js onload 的旧日志归档压缩、
// lifecycle.js 的 config.json 初始化、junction 旧名清理），各自在调用点隐式执行，未来新增
// 迁移没有统一落点。本模块把散落动作收敛为唯一入口：有序迁移注册表 + runMigrations(cfg)
// 调度器。新增迁移 = 注册表加一条（幂等 run + id），调用点按需选择步骤。
//
// 迁移清单（id → 来源动作 → 原调用点 → 现调度点）：
//   1. archive-old-logs   旧日志归档压缩（latest.log 残留归档 + 时间戳 .log → .log.zst）
//                         原在 index.js onload 内联；现经 index.js onload 调
//                         runMigrations({ dataDir }, { steps: ["archive-old-logs"] }) 执行。
//                         约束：须在建新会话文件之前执行（步骤内部先归档 latest.log 再压缩
//                         旧日志，避免把新会话文件也压缩）——故 onload 调调度器先于
//                         nextTimestampLogPath 建会话文件。
//   2. config-schema      config.json 初始化/升级（不存在时按 manifest 默认值生成
//                         { schemaVersion: 1, global: {...manifestDefaults}, agents: {},
//                         sessions: {} }；幂等不覆盖已有配置）。原在 lifecycle.js
//                         ensureConfigJson（startWebHostFromPlugin 与 dsh-run.js doExecute
//                         两处调用）；现统一经 runMigrations(cfg, { steps: ["config-schema"] })。
//                         未来 schemaVersion 升级迁移在此扩展。
//   3. junction-converge  cordis junction 旧名清理 + @dsh-hanako scope 无条件收敛（清理
//                         dsh-hana-* 旧名遗留 junction，重建 @dsh-hanako/* 六个包 junction，
//                         每次启动无条件收敛）。原在 lifecycle.js ensureWebHost 内闭包；
//                         现经 ensureWebHost 调 runMigrations(cfg, { steps: ["junction-converge"] })。
//   4. cleanup-update-result  update-result.json 遗留文件删除（v0.24 退役）：更新链路结果
//                         改走内存态分组 g.update（状态收敛），update-result.json 不再写
//                         不再读——删除历史版本遗留文件（不存在幂等跳过，失败静默）。
//                         调用点：startWebHostFromPlugin 经 runMigrations 调度
//                         （steps 含 config-schema + cleanup-update-result；archive-old-logs
//                         在 onload 单独调度，不得跑全量——会压缩当前会话文件）。
//   5. timeout-sec        超时配置毫秒 → 秒（v0.25 超时单位统一）：config.json global 里
//                         旧键 defaultTimeoutMs/approvalTimeoutMs 存在且新键缺失时换算
//                         （毫秒/1000，0=禁用保留，正数取整钳 ≥1s）写新键并删除旧键；
//                         新键已存在/旧键不存在 = 零动作（幂等）。调用点：
//                         startWebHostFromPlugin 与 dsh-run.js doExecute 的 runMigrations
//                         steps 追加 "timeout-sec"（config.json 初始化后即可换算旧键）。
//
// 未纳入本模块的（判断取舍，保持原地）：
//   - newWebLogPath（lifecycle.js 的兜底日志会话文件创建）：冷启动边缘的会话文件兜底，
//     不是历史遗留收敛，保留原地。
//   - provider 路由组装 / bus 连接等：运行期能力，不是迁移。
//
// 分发形态（遵守仓库分发纪律）：本模块只被 src/lifecycle.js（与 src/tools/dsh-run.js，
// 二者同属 index.js 单 bundle 收敛入口的静态 import 链）静态 import，会被 rspack 内联进
// dist/index.js bundle（build.mjs 的 staticUrlToMeta 递归收集 ROOT 下全部 .js 路径做
// import.meta.url 替换）。index.js 不静态 import 本模块（避免 Node ESM 固定 URL 缓存读到
// 旧模块），经 globalThis 单例调用：本文件顶层把 runMigrations 挂到 getSingleton() 单例
// （g.runMigrations），index.js onload 用 g.runMigrations?.(...) 调用（同 g.startWebHost /
// g.closeProcess 纪律）。
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { join, dirname } from "node:path";
import {
  getSingleton,
  PLUGIN_ROOT,
  manifestDefaults,
  IS_WIN,
} from "./tools/lib/state.js";

// ---- 迁移步骤 1：旧日志归档压缩（archive-old-logs）----
// 旧日志策略（同 dsh session 持久化：全部保留，体积靠压缩）：把上一会话及更早的时间戳
// .log 用 Node 内置 node:zlib zstd 压缩为 .log.zst（标准 zstd 格式，magic 28b52ffd，任何
// zstd 工具/库可解），删除原 .log——全部保留不删除。另处理历史版本遗留的 latest.log 残留：
// 真实文件 rename 成时间戳日志名（随后走压缩），旧链接直接删（内容在真实文件里）。
// 幂等：已压缩的 .log.zst 不匹配正则自然跳过；latest.log 不存在时零动作；单个失败保留
// 原文件下次再试。须在建新会话文件之前执行（onload 调度本步骤先于 nextTimestampLogPath）。
const LOG_NAME_RE = /^\d{8}-\d{6}(?:-\d+)?\.log$/;
function logFileStamp(d) {
  const p = (n) => String(n).padStart(2, "0");
  const p3 = (n) => String(n).padStart(3, "0");
  // 毫秒级精度：同一秒内多次会话（快速重启）天然不撞名，无需后缀消歧
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p3(d.getMilliseconds())}`;
}
// 下一个时间戳日志文件路径（now 毫秒级命名；极端同毫秒冲突加 -i 后缀），用于旧 latest
// 归档命名——文件名即应用层创建时刻，不依赖文件系统元数据
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
      } catch {
        /* 单个压缩失败跳过（保留原文件） */
      }
    }
  } catch {
    /* 扫描失败不阻断 */
  }
  return count;
}
// 迁移步骤 run 实现：返回 { archivedName, compressed } 供 onload 记日志（归档文件名 +
// 压缩个数）。失败不抛出（内部逐项 try/catch，与旧实现一致——调度器兜底再包一层）。
function archiveOldLogs(cfg) {
  const logsDir = join(cfg.dataDir, "logs");
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
    } catch {
      /* 旧文件处理失败不阻断 */
    }
  }
  // 压缩旧日志（上一会话及更早的时间戳 .log → .log.zst，全部保留不删除）
  const compressed = compressArchivedLogs(logsDir);
  return { archivedName, compressed };
}

// ---- 迁移步骤 2：config.json schema 初始化/升级（config-schema）----
// config.json 不随包分发（宿主设置界面生成，路径 <插件数据目录>/config.json），全新安装
// 时不存在。插件初始化（拉起 web host / 首次工具调用）时按 manifest 默认值自动生成
// { schemaVersion: 1, global: { ...manifestDefaults }, agents: {}, sessions: {} }，用户装完
// 即可在设置界面看到默认值，无需先手动保存一次。
// 幂等：文件已存在直接返回，绝不覆盖用户配置/宿主生成内容。失败静默：resolve* 有配置
// 快照兜底，不阻塞主流程（生成的只是初始默认值，被覆盖/缺失都不影响功能）。
// schemaVersion 升级：未来版本结构变更时在此读旧 schemaVersion 逐级升级（本步是唯一
// 落点，配合注册表版本号注释说明）。
function ensureConfigJson(cfg) {
  try {
    const dataDir =
      cfg.dataDir || getSingleton().dataDir || join(PLUGIN_ROOT, "data");
    const cf = join(dataDir, "config.json");
    if (existsSync(cf)) return; // 已存在（宿主生成/用户修改）：幂等跳过
    mkdirSync(dataDir, { recursive: true });
    const tmp = join(dataDir, ".config.json.tmp");
    // 先写临时文件再 rename 原子落位（中断不留半成品），对齐 scripts/pack.mjs 惯例
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          schemaVersion: 1,
          global: { ...manifestDefaults },
          agents: {},
          sessions: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    renameSync(tmp, cf);
  } catch {
    /* 生成失败静默：resolve* 有配置快照兜底 */
  }
}

// ---- 迁移步骤 3：cordis junction 旧名清理 + @dsh-hanako scope 收敛（junction-converge）----
// cordis 插件加载：六段均以包名注册（dsh client 模块发现按 loader entry 的 name 做
// require.resolve('<name>/package.json')，file:// 无法解析），故启动前须在
// $DSH_HOME/profiles/node_modules 统一建 junction（包名 → 插件安装目录 dsh-plugin/<pkg>），
// 与 dsh 自维护的 junction farm 同机制。@dsh-hanako scope 收敛（v0.18.1）：六个插件包统一
// 命名空间（v0.22.1 +bridge），junction 名与包名一致（profiles/node_modules/@dsh-hanako/<pkg>
// → 插件安装目录 dsh-plugin/@dsh-hanako/<pkg>）。顺带清理旧名遗留 junction（dsh-hana-*
// 前缀，含 v0.13.0 改名前的 dsh-hana-default-model / dsh-hana-proxy 等历史残留），无条件
// 收敛到当前命名，杜绝混装。
// 无条件重建：每次启动删旧建新（不比较 readlink）——junction 状态无条件收敛到当前代码
// 期望，杜绝一切残留（悬空 junction / 指向旧路径）导致的解析失败；与 patch 每次渲染覆盖
// 同一哲学。存在性用 lstatSync（不跟随目标）判断——existsSync 沿目标解析，悬空 junction
// 会误判不存在，导致 symlinkSync EEXIST。非 junction 同名实体报错不静默覆盖。
function convergeCordisJunctions(cfg) {
  const dshHome = join(cfg.dataDir, "dsh-home");
  const packages = [
    {
      link: "@dsh-hanako/theme",
      target: join(PLUGIN_ROOT, "dsh-plugin", "@dsh-hanako", "theme"),
    },
    {
      link: "@dsh-hanako/provider",
      target: join(PLUGIN_ROOT, "dsh-plugin", "@dsh-hanako", "provider"),
    },
    {
      link: "@dsh-hanako/settings",
      target: join(PLUGIN_ROOT, "dsh-plugin", "@dsh-hanako", "settings"),
    },
    {
      link: "@dsh-hanako/logger",
      target: join(PLUGIN_ROOT, "dsh-plugin", "@dsh-hanako", "logger"),
    },
    {
      link: "@dsh-hanako/clipboard",
      target: join(PLUGIN_ROOT, "dsh-plugin", "@dsh-hanako", "clipboard"),
    },
    {
      link: "@dsh-hanako/bridge",
      target: join(PLUGIN_ROOT, "dsh-plugin", "@dsh-hanako", "bridge"),
    },
  ];
  const nmDir = join(dshHome, "profiles", "node_modules");
  // 清理旧名 junction：profiles/node_modules 下 dsh-hana-*（非 @dsh-hanako scope）
  // 的符号链接一律删（旧插件实例遗留，如 dsh-hana-default-model / dsh-hana-proxy）
  try {
    const legacy = readdirSync(nmDir).filter(
      (n) => n.startsWith("dsh-hana-") && !n.startsWith("@"),
    );
    for (const name of legacy) {
      const p = join(nmDir, name);
      try {
        if (lstatSync(p).isSymbolicLink()) {
          unlinkSync(p);
          console.log(`[dsh-run] 清理旧插件 junction：${name}`);
        }
      } catch {
        /* 非链接或已删：忽略 */
      }
    }
  } catch {
    /* nmDir 不存在/读失败：忽略（下方 mkdir 兜底） */
  }
  for (const pkg of packages) {
    const link = join(nmDir, ...pkg.link.split("/"));
    // 预检碰撞：目标路径「已存在且不是符号链接」的同名实体 = 确定性冲突（junction
    // 路径被普通目录/文件占用）。不静默覆盖、不 warn 降级——直接抛出（runMigrations
    // 记录 error，调用方 ensureWebHost 据此拒绝启动；带病启动会导致对应插件模块
    // 解析失败且诊断困难）。与下方 symlinkSync 环境性失败（权限/只读等）区分：
    // 后者仍 warn 降级继续，不影响其余插件。
    let existed = false;
    let isLink = false;
    try {
      isLink = lstatSync(link).isSymbolicLink();
      existed = true;
    } catch {
      /* 不存在（含 lstat 失败） */
    }
    if (existed && !isLink)
      throw new Error(link + " 已存在且不是符号链接请移除后重试");
  }
  for (const pkg of packages) {
    const link = join(nmDir, ...pkg.link.split("/"));
    try {
      let existed = false;
      try {
        lstatSync(link);
        existed = true;
      } catch {
        /* 不存在（含 lstat 失败） */
      }
      if (existed) unlinkSync(link);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(pkg.target, link, IS_WIN ? "junction" : null);
    } catch (e) {
      // 符号链接创建失败降级：仅记 warn，不阻断 dsh 启动——对应插件会退化为
      // 不可用（client 模块未发现），后端路由与其余插件不受影响
      console.warn(
        `[dsh-run] ${pkg.link} junction 创建失败（${e?.message || e}），该插件将不可用`,
      );
    }
  }
}
// ---- 迁移步骤 4：update-result.json 退役清理（cleanup-update-result）----
// v0.24 状态收敛（单例分组结构化）：更新链路结果改走内存态分组 g.update，update-result.json
// 不再写不再读（总线事件化已打通 update.progress/result + 断线排队补发；设置页是 dsh web
// host 页面依赖总线，Agent 工具 dsh_update 结果全走内存态且从不读该文件——文件兜底场景
// 在现役链路中不存在）。删除历史版本遗留的 <dataDir>/update-result.json 文件。
// 幂等：文件不存在零动作；删除失败静默（残留不影响功能，只是占位文件）。
function cleanupUpdateResult(cfg) {
  try {
    const dataDir =
      cfg.dataDir || getSingleton().dataDir || join(PLUGIN_ROOT, "data");
    const f = join(dataDir, "update-result.json");
    if (existsSync(f)) {
      unlinkSync(f);
      console.log(
        "[dsh-hanako] 已删除遗留 update-result.json（v0.24 起退役，更新结果走内存态 g.update）",
      );
    }
  } catch {
    /* 删除失败静默：文件已无消费方，残留不影响功能 */
  }
}

// ---- 迁移步骤 5：超时配置毫秒 → 秒（timeout-sec）----
// v0.25 超时单位统一为秒：用户可见配置键 approvalTimeoutMs/defaultTimeoutMs 改名为
// approvalTimeoutSec/defaultTimeoutSec（manifest 默认 30000ms→30s / 1800000ms→1800s）。
// 历史 config.json（宿主设置界面生成）global 里可能残留旧毫秒键——本次迁移：若旧键存在
// 且对应新键缺失 → 毫秒/1000 换算（0=禁用语义保留：0 → 0；正数取整到秒，<500ms 钳到
// 1s 保留「正数 = 启用」）写新键、删除旧键；新键已存在/旧键不存在 = 零动作（幂等）。
// 换算策略与 lib/config.js 的 msToSec 保持一致（同源同规则，避免迁移后读取语义漂移）。
// 调用点：startWebHostFromPlugin 与 dsh-run.js doExecute 的 runMigrations steps 追加
// "timeout-sec"（与 config-schema 同批调度；config.json 初始化后即可换算旧键）。
function migrateTimeoutSec(cfg) {
  try {
    const dataDir =
      cfg.dataDir || getSingleton().dataDir || join(PLUGIN_ROOT, "data");
    const cf = join(dataDir, "config.json");
    if (!existsSync(cf)) return null; // 无 config.json：零动作
    const j = JSON.parse(readFileSync(cf, "utf8"));
    const g = j && typeof j.global === "object" && j.global ? j.global : null;
    if (!g) return null;
    // 毫秒 → 秒（与 config.js msToSec 同规则：0=禁用保留，正数取整钳 ≥1）
    const msToSec = (ms) => {
      if (!Number.isFinite(ms)) return null;
      if (ms <= 0) return 0;
      return Math.max(1, Math.round(ms / 1000));
    };
    const converted = [];
    // 单键换算：旧键存在时——新键已存在且为合法数值 → 新键权威，删除残留旧键（清理
    // 避免单位歧义；新键为 number 类型，宿主写入必为 number）；新键缺失/非数值 → 换算
    // 写新键删旧键（旧值非数字则不动，读取侧快照兑底）；旧键不存在 → 零动作
    const convert = (oldKey, newKey) => {
      if (!(oldKey in g)) return; // 旧键不存在：零动作
      const nv = g[newKey];
      if (typeof nv === "number" && Number.isFinite(nv)) {
        // 新键已存在且为合法数值：权威新键，删残留旧键（读取侧新键优先，旧键不再 consult）
        delete g[oldKey];
        converted.push({ oldKey, newKey, removed: true, value: nv });
        return;
      }
      const s = msToSec(Number(g[oldKey]));
      if (s === null) return; // 旧值非数字：不动（读取侧快照兜底）
      g[newKey] = s;
      delete g[oldKey];
      converted.push({ oldKey, newKey, value: s });
    };
    convert("defaultTimeoutMs", "defaultTimeoutSec");
    convert("approvalTimeoutMs", "approvalTimeoutSec");
    if (converted.length === 0) return null; // 零动作
    // 原子写回（tmp + rename，对齐 ensureConfigJson 惯例）；失败静默——读取侧有旧键
    // 兜底（resolveApprovalTimeoutSec / resolveDefaultTimeoutSec 优先新键、旧键换算），
    // 迁移未落盘不影响功能，下次调用重试。
    const tmp = cf + ".timeout-sec.tmp";
    writeFileSync(tmp, JSON.stringify(j, null, 2), "utf8");
    renameSync(tmp, cf);
    console.log(
      "[dsh-hanako] 超时配置迁移（毫秒→秒）：" +
        converted.map((c) => c.oldKey + "→" + c.newKey + "=" + c.value).join("，"),
    );
    return converted;
  } catch {
    return null; // 读/写失败静默：读取侧有旧键兜底
  }
}

// ---- 迁移注册表（有序：执行顺序 = 数组顺序；新增迁移在此加一条）----
// 每条：{ id（稳定标识，调用点 steps 选择用）, version（引入/最后调整版本，文档用）,
//        run(cfg)（幂等步骤实现；失败由 runMigrations 捕获记录，不阻断后续） }
const MIGRATIONS = [
  {
    id: "archive-old-logs",
    version: "0.10.8+",
    describe: "旧日志归档压缩（latest.log 残留归档 + 时间戳 .log → .log.zst，全部保留）",
    run: archiveOldLogs,
  },
  {
    id: "config-schema",
    version: "0.1.0+",
    describe: "config.json schema 初始化/升级（不存在时按 manifest 默认值生成，幂等不覆盖）",
    run: ensureConfigJson,
  },
  {
    id: "junction-converge",
    version: "0.18.1+",
    describe: "cordis junction 旧名清理 + @dsh-hanako scope 无条件收敛",
    run: convergeCordisJunctions,
  },
  {
    id: "cleanup-update-result",
    version: "0.24+",
    describe: "退役 update-result.json 遗留文件（v0.24 起更新结果走内存态 g.update，文件不再写不再读）",
    run: cleanupUpdateResult,
  },
  {
    id: "timeout-sec",
    version: "0.25+",
    describe: "超时配置毫秒 → 秒（approvalTimeoutMs/defaultTimeoutMs → approvalTimeoutSec/defaultTimeoutSec，0=禁用保留，新键已存在零动作）",
    run: migrateTimeoutSec,
  },
];

// ---- 统一入口：runMigrations(cfg, opts) ----
// 按注册表顺序执行迁移步骤；每步幂等、失败不阻断后续（try/catch 记录 error 继续）。
// opts.steps?: string[] —— 只执行指定步骤（按注册表顺序）；缺省 = 全部。
// 返回结果数组 [{ id, ok, detail|error }]：detail = 步骤返回值（如 archive-old-logs 的
// { archivedName, compressed }），error = 捕获的异常消息。本函数永不抛异常。
export function runMigrations(cfg, opts = {}) {
  const want = Array.isArray(opts.steps) ? opts.steps : MIGRATIONS.map((m) => m.id);
  // 未识别 step ID 告警（拼写错误/调用点与注册表不同步的早期信号；已识别步骤行为不变）
  const known = new Set(MIGRATIONS.map((m) => m.id));
  for (const id of want) {
    if (!known.has(id))
      console.warn(`[dsh-hanako] runMigrations: 未识别的迁移步骤 "${id}"，已忽略`);
  }
  const results = [];
  for (const m of MIGRATIONS) {
    if (!want.includes(m.id)) continue;
    try {
      results.push({ id: m.id, ok: true, detail: m.run(cfg) ?? null });
    } catch (e) {
      results.push({ id: m.id, ok: false, error: String(e?.message || e) });
    }
  }
  return results;
}

// ---- 单例挂载（globalThis.__dshHanako，与 lifecycle.js mountLifecycle 同纪律）----
// index.js onload 不静态 import 本模块（分发纪律见文件头），经 g.runMigrations 调用。
// 顶层执行：lifecycle.js / dsh-run.js 静态 import 本模块时即挂好（bundle 内联无缓存问题）。
getSingleton().runMigrations = runMigrations;
