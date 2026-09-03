// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/pnpm.js — pnpm 运行时引导（tarball 渐进式方案）共用模块（lib 提取）
// 从插件安装包中摘除 pnpm（zip 不再携带 node_modules/pnpm，package.json 不再声明
// devDependencies pnpm），改为运行时按需引导：下载 pnpm npm 包 tarball（registry
// 官方源，gzip 压缩 ~4.9MB，一次下载含全部所需），以 packageManager 的 sha512 校验
// 后解压提取 dist/pnpm.mjs（自包含入口 CLI，静态 import 全为 node: 内置模块，宿主
// electron node 直接执行）+ dist/worker.js（package 导入 worker）到数据目录
// <dataDir>/pnpm-dist/pnpm-{version}/。版本与完整性单一事实源 = packageManager。
// 宿主 node v26.8.1 下：pnpm view 路径只依赖 pnpm.mjs；pnpm install/add 的导入
// 阶段经 new Worker(join(import.meta.dirname, "worker.js")) 加载 worker.js（pnpm.mjs
// 内联处 workerScriptPath），缺 worker.js 时导入 worker 静默退出 1（无错误信息）——
// 引导零静态校验字段：tarball sha512 来自 packageManager（corepack 维护），下载校验
// 后解压提取两文件，缺一即重下。升级 pnpm 仅改 packageManager（corepack use 刷 hash）。
//
// 为什么自给自足：宿主 electron node 不带 npm/corepack/npx（Electron 发行只有 node
// 运行时），引导是唯一自给自足路径；宿主侧未来可能开放 npm 调用（liliMozi 口头确认，
// 未开放）——ensurePnpm 内先调 tryHostChannel() 探测宿主通道（当前返回 null），
// 再走双文件引导（pnpm.mjs + worker.js）。
//
// 导出：PNPM_VERSION（版本常量）/ ensurePnpm（幂等引导，返回 pnpm 入口绝对路径）
// / tryHostChannel（宿主通道探测占位）/ runPnpm（spawn 宿主 node + pnpm 入口封装）
// / DSH_PACKAGE + buildPnpmInstallArgs（pnpm install 参数构造收敛入口：
// lib/install.js 唯一安装调用点只传 registry 兜底意图，包名/旗标同源本模块）
// / isValidPkgSpec（spec 注入面校验：仅接受严格 SemVer 或合法 dist-tag；校验职责在
// 调用方——installDepsFromPlugin 计算 effectiveSpec 后、传 buildPnpmInstallArgs 前负责）。
// 消费方：lib/install.js（installDepsFromPlugin 部署 dsh 依赖树 + verifyDepsSmoke 的
// pnpm 引导检查）。版本检查走 HTTP 直查 npm registry（pnpm view 语义等价）；
// settings 侧检查链路不经 pnpm 入口。
//
// 零运行时依赖：只用 node 内置模块（fs/path/crypto/https/child_process），不引入任何
// npm 依赖（rspack externalsPresets.node 下保持外部 import）。容错纪律：引导失败抛
// 可读错误（含两个 CDN 提示），由调用方按需降级。注释风格同 lib 侧（中文/双引号/分号）。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { get as httpsGet } from "node:https";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import {
  getSingleton,
  PLUGIN_ROOT,
  resolveNodeExec,
  resolveNodeExecEnv,
} from "./state.js";

// ---- 版本与完整性单一事实源：package.json packageManager（pnpm@<version>+sha512.<hex>）----
// corepack 语义：版本 + tarball sha512 由 packageManager 单一承载（corepack use 生成）。
// 升级 pnpm = 改 packageManager + `corepack use pnpm@<ver>` 刷新 hash（corepack 作 devDep
// 引入——Node 25+ 官方不再捆绑 corepack，hash 维护工具需固定来源；devDep 不进运行时）。
// 运行时引导零静态校验字段：从插件根 package.json（PLUGIN_ROOT 定位，源码/bundle 两
// 形态均成立）解析出版本与 sha512，下载 tarball 后即以此 sha512 校验——完整性链
// packageManager（corepack 维护）→ tarball → 解压文件，无人工重算环节。
// 要求 pm 段带 sha512 hash：旧裸版本形态（pnpm@11.25.0 无 hash）无法校验 tarball，
// 引导时报可读错误提示 corepack use 刷新（历史发布包不含本代码，兼容非问题）。
// ⚠️ 版本兼容：pnpm 11.25.0 的 engines 要求 node >=22.13；宿主 electron node 当前为
// v26.8.1（满足）。升级 pnpm 时须核对新版本 engines 不超过宿主 node 版本
// （宿主 node 版本固定，不做运行时探测；该约束靠此处注释人工把关）。
// tarball 内所需两文件：package/dist/pnpm.mjs（入口 CLI）+ package/dist/worker.js
// （package 导入 worker）——pnpm add 的导入阶段经 new Worker(join(import.meta.dirname,
// "worker.js")) 加载 worker.js（pnpm.mjs 内联处 workerScriptPath），只提取 pnpm.mjs
// 会让 add 的导入 worker 崩溃（exit 1，无错误信息）；pnpm view 路径不触发 worker。

// 从插件根 package.json 的 packageManager 解析 { version, sha512 }：
// pnpm@<semver>+sha512.<hex>（corepack use 生成形态；sha512 为 tarball 完整性的 128 hex）。
// 旧裸版本形态（无 +sha512 段）/ 畸形格式 → null（引导路径给可读错误，不静默回退）。
function parsePnpmManager() {
  try {
    const pkg = JSON.parse(readFileSync(join(PLUGIN_ROOT, "package.json"), "utf8"));
    const pm = pkg && typeof pkg === "object" ? pkg.packageManager : null;
    if (typeof pm !== "string") return null;
    const m = pm.match(
      /^pnpm@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\+sha512\.([0-9a-fA-F]{128})$/,
    );
    if (!m) return null;
    return { version: m[1], sha512: m[2].toLowerCase() };
  } catch {
    return null; // 文件缺失 / JSON 畸形 → 引导路径统一给可读错误
  }
}

// 模块加载解析一次（packageManager 是插件包静态内容，运行期不变）；null = 解析失败
const PNPM_MANAGER = parsePnpmManager();

// 兼容导出（外部取版本号用；install.js smoke 报告等；值 = pm 段解析 version）
export const PNPM_VERSION = PNPM_MANAGER ? PNPM_MANAGER.version : null;

// tarball 下载源（registry 类；unpkg/jsdelivr 等文件 CDN 无 tarball 端点，不入列）：
// 官方 registry.npmjs.org → 官方国内镜像 npmmirror（302 到 cdn.npmmirror.com，已跟随）
// → 第三方国内镜像（腾讯云 / 华为云，实测与官方 tarball 逐字节同源）。sha512 校验
// 兜底：内容不符的源在引导时被拦下自动换下一个，源列表可安全扩充。
const PNPM_TARBALL_SOURCES = [
  (version) => `https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`,
  (version) => `https://registry.npmmirror.com/pnpm/-/pnpm-${version}.tgz`,
  (version) => `https://mirrors.cloud.tencent.com/npm/pnpm/-/pnpm-${version}.tgz`,
  (version) => `https://mirrors.huaweicloud.com/repository/npm/pnpm/-/pnpm-${version}.tgz`,
];
const DOWNLOAD_TIMEOUT_MS = 60000; // 单次下载请求超时（重定向跟随共享）
const STDOUT_CAP = 65536; // runPnpm 内存累积上限（调用方只需尾部/错误提取）

// ---- 宿主通道探测（未来接入点）----
// 宿主（Hana）侧未来可能开放 npm/包管理调用通道（liliMozi 口头确认，未开放）。
// 开放后在这里探测宿主是否提供包管理 API（globalThis 注入 / IPC / 环境变量等），
// 命中即返回 pnpm 入口路径（或执行能力），否则返回 null 走单文件引导。
// 当前恒返回 null —— 单文件引导是唯一自给自足路径（宿主 electron node 不带
// npm/corepack/npx）。
export async function tryHostChannel() {
  // TODO(宿主 npm 通道)：宿主开放 npm/包管理调用后在此接入——
  //   探测示例：globalThis.__hostNpm?.pnpmCliPath（宿主注入）、process.env 探测、
  //   IPC 探测等；命中返回 pnpm 入口绝对路径（string）供 ensurePnpm 直接采用，
  //   不命中返回 null 走下方单文件引导。
  return null;
}

// ---- 数据目录解析（与 lib/install.js / lifecycle.js 同一约定：显式 → 单例 → 插件根 data）----
// 缓存独立于 dsh-pkg（dsh 依赖树部署目录），只放 pnpm 引导文件（pnpm.mjs + worker.js）。
function resolveDataDir(opts) {
  if (opts && typeof opts.dataDir === "string" && opts.dataDir) {
    return opts.dataDir;
  }
  const g = getSingleton();
  if (g && typeof g.dataDir === "string" && g.dataDir) return g.dataDir;
  return join(PLUGIN_ROOT, "data");
}

// ---- tar 提取（零依赖：node 无内置 tar；npm tarball = gzip(tar) 字节流）----
// 遍历 512B 头块：常规文件（typeflag '0'/NUL）+ PAX 扩展头（'x'，path 覆盖）+
// GNU longname（'L'）。目标条目命中才取数据 Buffer——只读不按路径写盘，无 zip-slip
// 面。size 按 8 进制解析（>8GiB 文件的 base-256 size 不处理，npm 包无此量级）。
// pnpm tarball 条目带 package/ 前缀，dist 下两文件为所需。
const TAR_TARGETS = {
  "package/dist/pnpm.mjs": "pnpm.mjs",
  "package/dist/worker.js": "worker.js",
};

function extractPnpmFiles(tgzBuf) {
  const tarBuf = gunzipSync(tgzBuf);
  const out = new Map(); // 短名（pnpm.mjs/worker.js）→ Buffer
  let off = 0;
  let pendingLong = null; // GNU longname 待应用到下一实体头
  let paxPath = null; // PAX path 覆盖（同样只对下一实体头生效）
  while (off + 512 <= tarBuf.length) {
    const head = tarBuf.subarray(off, off + 512);
    if (head.every((b) => b === 0)) break; // 全零块 = 归档结束
    const typeflag = String.fromCharCode(head[156] || 0);
    const sizeStr = head.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new Error("tar 头解析失败 @ " + off);
    }
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    off = dataEnd + (Math.ceil(size / 512) * 512 - size);
    if (typeflag === "x") {
      // PAX 扩展头记录：格式 "<len> key=value\n"；只取 path
      const pax = tarBuf.subarray(dataStart, dataEnd).toString("utf8");
      for (const rec of pax.split("\n")) {
        const sp = rec.indexOf(" ");
        const eq = rec.indexOf("=", sp + 1);
        if (sp > 0 && eq > sp + 1 && rec.slice(sp + 1, eq) === "path") {
          paxPath = rec.slice(eq + 1);
        }
      }
      continue;
    }
    if (typeflag === "L") {
      pendingLong = tarBuf.subarray(dataStart, dataEnd).toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    let name;
    if (pendingLong) {
      name = pendingLong;
      pendingLong = null;
    } else if (paxPath) {
      name = paxPath;
      paxPath = null;
    } else {
      const raw = head.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
      const prefix = head.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
      name = prefix ? prefix + "/" + raw : raw;
    }
    if ((typeflag === "0" || typeflag === "\0") && Object.hasOwn(TAR_TARGETS, name)) {
      out.set(TAR_TARGETS[name], tarBuf.subarray(dataStart, dataEnd));
    }
  }
  const missing = Object.keys(TAR_TARGETS).filter((n) => !out.has(TAR_TARGETS[n]));
  if (missing.length) {
    throw new Error("tarball 缺少目标文件: " + missing.join(", "));
  }
  return out;
}

// ---- https GET（跟随 3xx 重定向；unpkg/jsdelivr 均可能 302 到边缘 CDN）----
function httpsGetFollow(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = httpsGet(
        url,
        {
          timeout: DOWNLOAD_TIMEOUT_MS,
          headers: { "user-agent": "dsh-hanako-plugin" },
        },
        (res) => {
          const status = res.statusCode || 0;
          const loc = res.headers.location;
          if (status >= 300 && status < 400 && loc) {
            res.resume(); // 丢弃重定向响应体
            if (redirectsLeft <= 0) {
              reject(new Error("重定向次数过多：" + url));
              return;
            }
            httpsGetFollow(new URL(loc, url).href, redirectsLeft - 1).then(
              resolve,
              reject,
            );
            return;
          }
          resolve(res);
        },
      );
    } catch (e) {
      reject(e);
      return;
    }
    req.on("timeout", () => {
      req.destroy(new Error("下载超时（" + DOWNLOAD_TIMEOUT_MS + "ms）：" + url));
    });
    req.on("error", reject);
  });
}

// 下载 URL → 临时文件（响应非 200 或流错误抛错；不手动解压——未发 Accept-Encoding，
// CDN 不会 gzip 响应体，Node https 默认不发该头）
async function downloadToFile(url, dest) {
  const res = await httpsGetFollow(url);
  if ((res.statusCode || 0) !== 200) {
    res.resume();
    throw new Error("HTTP " + res.statusCode + "：" + url);
  }
  await new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const fail = (e) => {
      try {
        file.destroy();
      } catch {
        /* 已关闭 */
      }
      reject(e);
    };
    res.on("error", fail);
    file.on("error", fail);
    file.on("finish", () => file.close(() => resolve()));
    res.pipe(file);
  });
}

// ---- 引导主流程（模块级 promise 单例防并发；settle 后重置，下次调用重新走缓存校验）----
let ensurePromise = null;

export function ensurePnpm(opts) {
  // 并发防护：引导进行中（下载/校验）的调用共享同一 promise——install/check/lifecycle
  // 并发触发只下载一次。settle 后重置为 null：下次调用重新走「缓存存在（两文件）」
  // 快速路径（幂等，不重复下载；文件被外部删除时也能自愈重下）。
  if (ensurePromise) return ensurePromise;
  ensurePromise = doEnsurePnpm(opts).finally(() => {
    ensurePromise = null;
  });
  return ensurePromise;
}

async function doEnsurePnpm(opts) {
  // ① 宿主通道探测（未来接入点；当前恒 null → 走单文件引导）
  const host = await tryHostChannel();
  if (host && typeof host === "string" && host) return host;
  // 版本解析失败（pm 段缺失/畸形/无 sha512）→ 可读错误，不静默回退
  if (!PNPM_MANAGER) {
    throw new Error(
      "pnpm 引导配置解析失败：package.json packageManager 缺失或格式异常（期望 pnpm@<semver>+sha512.<hex>，用 corepack use 维护）",
    );
  }
  const { version, sha512 } = PNPM_MANAGER;
  // ② 缓存路径 <dataDir>/pnpm-dist/pnpm-{version}/{pnpm.mjs,worker.js}（独立于 dsh-pkg）
  const dataDir = resolveDataDir(opts);
  const cacheDir = join(dataDir, "pnpm-dist", "pnpm-" + version);
  const entry = join(cacheDir, "pnpm.mjs");
  // ③ 缓存命中（两文件存在；tarball 校验 + 原子落位保证无部分写入形态）→ 幂等快速路径
  const cached = await cacheIntact(cacheDir);
  if (cached) {
    console.log("[pnpm] 命中缓存：" + entry);
    return entry;
  }
  // ④ 下载 tarball → sha512 校验（packageManager hash）→ gunzip + tar 提取两文件 →
  // 逐文件原子落位。完整性链：sha512 覆盖下载全量，解压产物随之可信，无文件级二次校验。
  mkdirSync(cacheDir, { recursive: true });
  let lastError = null;
  for (const makeUrl of PNPM_TARBALL_SOURCES) {
    const url = makeUrl(version);
    const tmpTgz = join(
      cacheDir,
      ".pnpm." + version + ".tgz." + process.pid + "." + Date.now() + ".tmp",
    );
    try {
      console.log("[pnpm] 引导下载 " + url + " …");
      await downloadToFile(url, tmpTgz);
      const actual = createHash("sha512").update(readFileSync(tmpTgz)).digest("hex");
      if (actual !== sha512) {
        throw new Error(
          "tarball sha512 校验失败（期望 " + sha512 + "，实际 " + actual + "）",
        );
      }
      console.log("[pnpm] sha512 校验通过，解压提取 …");
      const files = extractPnpmFiles(readFileSync(tmpTgz)); // Map<短名, Buffer>
      for (const [shortName, buf] of files) {
        const target = join(cacheDir, shortName);
        const tmp = join(
          cacheDir,
          ".pnpm." + shortName + "." + process.pid + "." + Date.now() + ".tmp",
        );
        writeFileSync(tmp, buf);
        rmSync(target, { force: true }); // 旧缓存（缺失/损坏场景）先清，再原子落位
        renameSync(tmp, target); // 同目录 rename，原子替换
        console.log("[pnpm] 引导完成：" + target);
      }
      rmSync(tmpTgz, { force: true }); // 下载产物用完即清（缓存只留解压出的两文件）
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      try {
        rmSync(tmpTgz, { force: true });
      } catch {
        /* 清理失败忽略 */
      }
      console.warn("[pnpm] " + url + " 失败：" + (e?.message || e));
    }
  }
  if (lastError) {
    throw new Error(
      "pnpm 引导失败：全部 tarball 源均不可用（" +
        PNPM_TARBALL_SOURCES.map((f) => f(version)).join("、") +
        "），最后错误：" +
        (lastError?.message || lastError) +
        "。请检查网络后重试。",
    );
  }
  return entry;
}

// 缓存完整性：两引导文件存在即视为完整——下载经 tarball sha512 校验 + 逐文件原子
// 落位（tmp + rename），不存在部分写入形态；文件缺失/被外部删除 → 重新走下载自愈。
function cacheIntact(cacheDir) {
  return existsSync(join(cacheDir, "pnpm.mjs")) && existsSync(join(cacheDir, "worker.js"));
}

// ---- runPnpm：spawn node（Electron 自带 node 或自定义 nodejsPath，每次 spawn 前解析）+ pnpm 入口 ----
// opts：{ pnpmCli（已引导的入口，缺省内部 ensurePnpm）, cwd, env（缺省
// resolveNodeExecEnv(opts)——ELECTRON_RUN_AS_NODE=1 仅 Electron node 注入，自定义
// node 不注入）, timeoutMs（超时 kill）, onStdout/onStderr（逐 chunk 回调，
// 供 install.js 实时流式日志）}。返回 { code, stdout, stderr }；spawn/运行错误 reject。
export async function runPnpm(args, opts = {}) {
  const pnpmCli = opts.pnpmCli || (await ensurePnpm(opts));
  const argv = Array.isArray(args) ? args : [];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(resolveNodeExec(opts), [pnpmCli, ...argv], {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: opts.env || resolveNodeExecEnv(opts),
        windowsHide: true,
      });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = "";
    let stderr = "";
    const onOut = typeof opts.onStdout === "function" ? opts.onStdout : () => {};
    const onErr = typeof opts.onStderr === "function" ? opts.onStderr : () => {};
    child.stdout.on("data", (d) => {
      stdout = (stdout + String(d)).slice(-STDOUT_CAP);
      onOut(d);
    });
    child.stderr.on("data", (d) => {
      stderr = (stderr + String(d)).slice(-STDOUT_CAP);
      onErr(d);
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* 已退出 */
          }
        }, opts.timeoutMs)
      : null;
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.once("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
  });
}

// ---- pnpm install 参数构造（lib/install.js 唯一安装调用点的收敛入口）----
// dsh 固定版本声明进插件根 package.json 的 dependencies——安装语义 = pnpm install
// （按声明拉取，版本随插件发版），dsh 是插件不可分割组成。本函数不拼包名/spec，只
// 声明 install，输出为 pnpm 原生文本（由 lib/install.js 逐行直通日志通道）；
// registry 兜底意图由调用方只传 URL。
// ⚠️ 本函数保持纯拼接不做校验——声明版本合法性（严格 SemVer 或合法 dist-tag，见
// isValidPkgSpec）由调用方负责：installDepsFromPlugin 读取插件根 package.json 的
// dependencies 后校验（注入面收口，防 "npm:evil@1.0.0" / "github:user/repo" /
// "file:../x" / "/abs/path" 等安装非预期包）。
export const DSH_PACKAGE = "@deepseek-ai/dsh";

export function buildPnpmInstallArgs({ registry } = {}) {
  // --prod：只装运行时 dependencies（插件根 package.json 有 rspack 等 devDeps 构建树，
  // 运行时不需要；dsh + cordis 在 dependencies，部署目标 = 插件根）。
  const args = ["install", "--prod"]; // 原生文本输出
  if (typeof registry === "string" && registry) {
    args.push("--registry=" + registry);
  }
  return args;
}

// ---- spec 注入面校验（vX：installDepsFromPlugin 调用前收口）----
// effectiveSpec 会拼成 DSH_PACKAGE + "@" + spec（仅 opts.spec 显式覆盖的逃生门路径）；
// spec 来自工具参数（version/tag）、插件声明或配置基线 dshTag。不校验时
// "npm:evil@1.0.0"（npm alias）、“github:user/repo”、“file:../x”、“/abs/path” 等会
// 让 pnpm 安装非预期包。
// 只接受两类：
//   ① 合法 SemVer（严格：核心组件与数字 prerelease 标识符必须 0|[1-9]\d*，无前导零；
//      prerelease/build 允许；build 标识符不受前导零限制——SemVer §10 无此约束）
//   ② 合法 dist-tag：/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ 且不是合法 SemVer，且不是
//      「版本形状」字符串（宽松 \d+.\d+.\d+ 形状——01.0.0 / 1.0.0-alpha.01 之类
//      严格校验不过的版本号不应被 dist-tag 规则放行）；tag 正则本身已排除
//      @ / : / 空格等协议与 alias 字符（规则冗余防御）。
// 校验失败返回 false，由调用方按容错纪律提前返回 { ok:false, error }（不 throw）。
// 校验职责在调用方（lib/install.js installDepsFromPlugin 计算 effectiveSpec 后调用）；
// buildPnpmInstallArgs 保持纯拼接（声明已由调用方校验）。
export function isValidPkgSpec(spec) {
  const s = String(spec || "").trim();
  if (!s) return false;
  if (isValidSemverSpec(s)) return true;
  // dist-tag 须含字母：排除纯数字/数字点串（123 / 1.0.0.1 / 1.0.0- 等形似版本但非
  // 严格 semver 的输入——这类输入作为安装目标只会得到 pnpm 的模糊解析失败，应在此
  // 清晰拒绝）；npm 现实 dist-tag（latest/next/alpha/beta/rc…）全部含字母，不受影响
  if (!/[a-zA-Z]/.test(s)) return false;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s)) return false;
  return !SEMVER_LOOSE_SHAPE_RE.test(s);
}

// 宽松版本形状（核心组件 \d+，前导零不限；prerelease/build 可选）——用于排除
// 「版本形状」的非法输入：01.0.0 / 1.0.0-alpha.01 不是合法 SemVer（严格），
// 但也不能被 dist-tag 规则放行（会装到非预期包）。
const SEMVER_LOOSE_SHAPE_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// 严格 SemVer 判定（与 scripts/version.mjs 同款规则：核心组件与数字 prerelease
// 标识符必须 0|[1-9]\d*，无前导零；非数字标识符须含至少一个字母或连字符）
const SEMVER_STRICT_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isValidSemverSpec(s) {
  const m = String(s).match(SEMVER_STRICT_RE);
  if (!m) return false;
  const pre = m[4];
  if (!pre) return true;
  for (const id of pre.split(".")) {
    if (/^\d+$/.test(id)) {
      if (id.length > 1 && id[0] === "0") return false; // 数字标识符前导零非法
    } else if (!/[A-Za-z-]/.test(id)) {
      return false; // 非数字标识符须含字母或连字符
    }
  }
  return true;
}
