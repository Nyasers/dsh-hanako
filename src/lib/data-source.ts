// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/data-source.ts — DSH 数据来源（private / shared）解析与自持设置存储
//
// 为什么自持一份设置文件而不是用宿主 contributes.settings / ctx.storage：
//   · 切换数据源是**生命周期动作**（要停旧 runtime、起新 runtime），不是"一组值"；
//   · DSH_HOME 必须在子进程启动**之前**定下，而子进程读不到 App ctx.storage（跨进程），
//     故两进程共享可读处只有 dataDir 下的文件；
//   · DSH 未运行时（设置页仍可达）也要能读写这份设置。
//   形态（对齐官方样例 runtime/data-source.mjs）：{version, revision, settings} +
//   lastShared；0600 + 原子写（.pending → rename）；revision 供乐观并发（T4 的 409 回路）。
//
// 源身份：private 恒为内置独立目录 <dataDir>/.dsh（命名与 DSH 自身默认 ~/.dsh 统一）；
// shared 指向外部 DSH 目录（DSH 默认 ~/.dsh，或用户经 picker 选定的目录）。
// 注：只读 <dataDir>/.dsh，不读 <dataDir>/dsh-home，**不做迁移**。
// sourceId 由 home+profile 决定：private 用常量便于人读，shared 用哈希区分同路径不同 profile。
//
// 本模块是叶子（只依赖 app-runtime 取值助手），不做 runtime 启停；切换编排在别的模块。
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { appDataDir, getAppRuntime } from "#/lib/app-runtime.ts";
import { APP_SETTING_DEFAULTS, resolveApprovalTimeoutSec, resolveDefaultTimeoutSec } from "#/lib/config.ts";

export const SETTINGS_VERSION = 1;
export const SOURCE_MODES = Object.freeze(["private", "shared"]);
/** 内置独立目录名：与 DSH 自身默认目录 ~/.dsh 命名统一（早期 v2 的 dsh-home 不再读取）。 */
export const PRIVATE_HOME_NAME = ".dsh";
/** 内置独立目录固定 profile：runtime 只 seed/启动这一个 profile。 */
export const PRIVATE_PROFILE = "dshana";
export const SETTINGS_KEYS = Object.freeze(["mode", "path", "profile", "approvalTimeoutSec", "defaultTimeoutSec"]);
export const DEFAULT_SETTINGS = Object.freeze({
  mode: "private",
  path: null,
  profile: PRIVATE_PROFILE,
  approvalTimeoutSec: APP_SETTING_DEFAULTS.approvalTimeoutSec,
  defaultTimeoutSec: APP_SETTING_DEFAULTS.defaultTimeoutSec,
});

/** DSH 自己的默认数据目录（shared 的「DSH 默认目录」候选）。 */
export const defaultDshHome = () => join(homedir(), ".dsh");
/** 内置独立目录（private）；dataDir 为 App ctx.dataDir。 */
export const privateHomeOf = (dataDir) => join(dataDir, PRIVATE_HOME_NAME);

/**
 * 归一化 home 用于身份比较：`\` → `/`、去尾斜杠；win32 再小写。
 * 目的：同一目录的不同字面写法（大小写/斜杠/尾斜杠）不得产生伪 source 变更。
 */
export function normalizeHomeForId(home, platform = process.platform) {
  const p = String(home).replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? p.toLowerCase() : p;
}

const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * 两个超时（秒）：整数 ≥ 0（0 = 显式禁用自动拒绝 / 交给调用方默认）；缺省填默认值。
 * 与数据模式同栈：一份设置、一个 revision（想改就带 expectedRevision，冲突就得 409）。
 */
function normalizeTimeouts(input) {
  const out = {};
  for (const key of ["approvalTimeoutSec", "defaultTimeoutSec"]) {
    const raw = input[key];
    if (raw === undefined || raw === null) {
      out[key] = APP_SETTING_DEFAULTS[key];
      continue;
    }
    // 只接受 number 类型：不当成字符串解析（Number([]) 是 0、Number("") 是 0，宽松转换会让脏值混进来）
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
      throw new Error(key + " 必须是不小于 0 的整数秒（收到 " + JSON.stringify(raw) + "）");
    }
    out[key] = raw;
  }
  return out;
}

/**
 * 设置校验（纯函数）：未知键拒绝、mode 限定、shared 必须是绝对路径、profile 简单名、
 * 两个超时必须是非负整数秒。
 * private 的 profile 被强制为 PRIVATE_PROFILE（内置目录只跑这一个 profile）。
 */
export function validateSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("DSH 数据来源设置必须是对象");
  }
  const unknown = Object.keys(input).filter((k) => !SETTINGS_KEYS.includes(k));
  if (unknown.length) throw new Error("DSH 数据来源设置含未知键：" + unknown.join("、"));
  if (!SOURCE_MODES.includes(input.mode)) {
    throw new Error("数据来源模式只能是 private 或 shared（收到 " + JSON.stringify(input.mode) + "）");
  }
  const profile = input.mode === "private" ? PRIVATE_PROFILE : input.profile;
  if (typeof profile !== "string" || !PROFILE_RE.test(profile) || profile.includes("..")) {
    throw new Error("profile 必须是简单名（字母或数字开头，只含字母/数字/._-，≤64 字符）；收到 " + JSON.stringify(profile));
  }
  if (input.mode === "shared") {
    if (typeof input.path !== "string" || !input.path || input.path.includes("\0")) {
      throw new Error("shared 模式必须给出 DSH 数据目录（非空字符串，不含 NUL）");
    }
    if (!isAbsolute(input.path)) throw new Error("shared 目录必须是绝对路径（收到 " + input.path + "）");
    return { mode: "shared", path: normalize(input.path), profile, ...normalizeTimeouts(input) };
  }
  return { mode: "private", path: null, profile, ...normalizeTimeouts(input) };
}

/**
 * 由设置推出数据源身份（纯函数）：
 *   home          该源的 DSH_HOME（子进程 env 用）
 *   profileName   该源的 profile 名
 *   shared        是否外部目录
 *   sourceId      private 恒 "private"；shared = sha256(归一化 home + "\0" + profile) 前 24 hex
 */
export function sourceOf(settings, dataDir) {
  const s = validateSettings(settings);
  const home = s.mode === "private" ? privateHomeOf(dataDir) : s.path;
  const sourceId = s.mode === "private"
    ? "private"
    : createHash("sha256").update(normalizeHomeForId(home) + "\0" + s.profile).digest("hex").slice(0, 24);
  return { sourceId, home, profileName: s.profile, shared: s.mode === "shared", mode: s.mode };
}

/**
 * 存量兼容：两个超时原先写在 <dataDir>/config.json 的 global.*（自持存储之前的栈）。
 * settings.json 里没有这两个键时，从旧位置读一次当初始值（只在读路径生效，不当场落盘）；
 * 下次经 POST /settings 写设置时，它们就自然迁进自持存储，旧位置不再被写入。
 */
function withLegacyTimeouts(raw, dataDir) {
  const out = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  if (!("approvalTimeoutSec" in out)) out.approvalTimeoutSec = resolveApprovalTimeoutSec({ dataDir });
  if (!("defaultTimeoutSec" in out)) out.defaultTimeoutSec = resolveDefaultTimeoutSec({ dataDir });
  // 其余键（mode/path/profile）缺省落位；顺序要紧：先补旧位置的超时，缺哪个补哪个，
  // 然后才铺默认，否则默认会先把键占住、旧位置的值就永远读不到了。
  return { ...DEFAULT_SETTINGS, ...out };
}

function clone(v) {
  return structuredClone(v);
}

/** lastShared 只留 {path, profile}（切回 shared 时预填，不自动生效）。 */
function readLastShared(raw) {
  if (!raw || typeof raw !== "object") return null;
  try {
    const s = validateSettings({ mode: "shared", path: raw.path, profile: raw.profile });
    return { path: s.path, profile: s.profile };
  } catch {
    return null; // 存量非法值按无处理，不阻断读
  }
}

/**
 * 自持设置存储（ctx.dataDir/integration/settings.json，0600，原子写）。
 * 读失败（文件损坏/版本不符）抛错——设置是切换数据源的依据，静默回退会切错源；
 * 文件不存在 = 未设置过，回落 private 默认。
 */
export function createDataSourceStore(ctx) {
  if (!ctx || typeof ctx.dataDir !== "string" || !ctx.dataDir) {
    throw new Error("data-source: 需要 App ctx（ctx.dataDir）");
  }
  const directory = join(ctx.dataDir, "integration");
  const filename = join(directory, "settings.json");
  let cached = null;

  const store = {
    async read() {
      if (cached) return clone(cached);
      let stored;
      try {
        stored = JSON.parse(await readFile(filename, "utf8"));
      } catch (e) {
        if (e && e.code === "ENOENT") {
          cached = {
            version: SETTINGS_VERSION,
            revision: 0,
            settings: validateSettings(withLegacyTimeouts({}, ctx.dataDir)),
          };
          return clone(cached);
        }
        if (e instanceof SyntaxError) throw new Error("DSH 数据来源设置文件不是合法 JSON：" + e.message);
        throw e;
      }
      if (!stored || typeof stored !== "object" || stored.version !== SETTINGS_VERSION) {
        throw new Error("DSH 数据来源设置文件版本不受支持（version=" + JSON.stringify(stored && stored.version) + "，本版 " + SETTINGS_VERSION + "）");
      }
      if (!Number.isSafeInteger(stored.revision) || stored.revision < 0) {
        throw new Error("DSH 数据来源设置文件 revision 非法（" + JSON.stringify(stored.revision) + "）");
      }
      const lastShared = readLastShared(stored.lastShared);
      cached = {
        version: SETTINGS_VERSION,
        revision: stored.revision,
        settings: validateSettings(withLegacyTimeouts(stored.settings, ctx.dataDir)),
        ...(lastShared ? { lastShared } : {}),
      };
      return clone(cached);
    },

    /** 落盘前校验：shared 目录须存在且是目录；以宿主返回的 canonical 路径为准。 */
    async validate(input) {
      const settings = validateSettings(input);
      if (settings.mode === "shared") {
        if (!ctx.resources || typeof ctx.resources.stat !== "function") {
          throw new Error("宿主不支持 ctx.resources.stat（需要 app/resources.read 能力与对应 Hana 版本）——无法校验 shared 目录");
        }
        let info;
        try {
          info = await ctx.resources.stat({ kind: "local-file", path: settings.path });
        } catch (e) {
          throw new Error("无法读取该目录（" + ((e && e.message) || e) + "）：" + settings.path);
        }
        if (!info || !info.exists) throw new Error("目录不存在：" + settings.path);
        if (!info.isDirectory) throw new Error("不是目录：" + settings.path);
        if (typeof info.filePath === "string" && info.filePath) settings.path = info.filePath; // 宿主 canonicalize 回写
      }
      return settings;
    },

    /** 写入（原子）：revision +1；只写设置，不触碰 any 数据目录内容。 */
    async write(input) {
      const previous = await store.read();
      const settings = validateSettings(input);
      const next = {
        version: SETTINGS_VERSION,
        revision: previous.revision + 1,
        settings,
        ...(settings.mode === "shared"
          ? { lastShared: { path: settings.path, profile: settings.profile } }
          : (previous.lastShared ? { lastShared: previous.lastShared } : {})),
      };
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const pending = filename + ".pending";
      await writeFile(pending, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
      await rename(pending, filename);
      cached = next;
      return clone(next);
    },
  };
  return store;
}

let storeRef = null;

/** 单例存储（同一 App 进程一份）。测试可用 resetDataSourceStore 复位。 */
export function dataSources(ctx = null) {
  if (storeRef) return storeRef;
  const c = ctx || (getAppRuntime() || {}).ctx;
  storeRef = createDataSourceStore(c);
  return storeRef;
}

export function resetDataSourceStore() {
  storeRef = null;
}

/**
 * 同步读设置：只给同步调用面用（cancel-chain 的超时解析是同步的，异步化会往外扩散）。
 * 不走 store 的内存缓存：这份文件只有几行，"改完即时生效"比省一次读更重要。
 * 读失败（损坏/版本不符）抛错，与 store 同口径；文件不存在则回落 private 默认。
 */
export function readSettingsSync(dataDir) {
  const filename = join(dataDir, "integration", "settings.json");
  let stored;
  try {
    stored = JSON.parse(readFileSync(filename, "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return validateSettings(withLegacyTimeouts({}, dataDir));
    if (e instanceof SyntaxError) throw new Error("DSH 数据来源设置文件不是合法 JSON：" + e.message);
    throw e;
  }
  if (!stored || typeof stored !== "object" || stored.version !== SETTINGS_VERSION) {
    throw new Error(
      "DSH 数据来源设置文件版本不受支持（version=" + JSON.stringify(stored && stored.version) + "，本版 " + SETTINGS_VERSION + "）",
    );
  }
  return validateSettings(withLegacyTimeouts(stored.settings, dataDir));
}

/** 当前数据源身份（读设置文件；文件损坏时抛错——不得静默切错源）。 */
export async function currentSource() {
  const dataDir = appDataDir();
  const st = await dataSources().read();
  return sourceOf(st.settings, dataDir);
}

/**
 * 容错取当前源的 DSH_HOME（只读查询路径用：list/get 不应因设置文件问题完全不可用）。
 * 无 App 运行包（离线/单测）或设置读取失败时回落内置独立目录——与旧行为一致。
 */
export async function currentDshHome(dataDir) {
  const dir = dataDir || appDataDir();
  const app = getAppRuntime();
  if (!dir || !app || !app.ctx) return privateHomeOf(dir || "");
  try {
    const st = await dataSources().read();
    return sourceOf(st.settings, dir).home;
  } catch {
    return privateHomeOf(dir);
  }
}
