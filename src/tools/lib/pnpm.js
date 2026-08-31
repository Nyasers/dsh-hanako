// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/pnpm.js — pnpm 运行时引导（tarball 渐进式方案）共用模块（lib 提取）
// 从插件安装包中摘除 pnpm（zip 不再携带 node_modules/pnpm，package.json 不再声明
// devDependencies pnpm），改为运行时按需引导：下载 pnpm npm 包的 dist/pnpm.mjs
// （自包含入口 CLI，静态 import 全为 node: 内置模块，宿主 electron node 直接执行）
// + dist/worker.js（package 导入 worker）到数据目录
// <dataDir>/pnpm-dist/pnpm-{version}/，固定版本 + sha256 校验。
// 实测确认（宿主 node v24.15.0）：pnpm view 路径只依赖 pnpm.mjs；pnpm add 的导入
// 阶段经 new Worker(join(import.meta.dirname, "worker.js")) 加载 worker.js（pnpm.mjs
// 内联处 workerScriptPath），缺 worker.js 时导入 worker 静默退出 1（无错误信息）——
// 故引导下载两个文件，缺一即重下。版本与校验同源静态配置（见下方 PNPM_BOOTSTRAP），
// 与构建期 packageManager 解耦（运行时引导只需 view/add 两条路径，锁版本足够）。
//
// 为什么自给自足：宿主 electron node 不带 npm/corepack/npx（Electron 发行只有 node
// 运行时），引导是唯一自给自足路径；宿主侧未来可能开放 npm 调用（liliMozi 口头确认，
// 未开放）——ensurePnpm 内先调 tryHostChannel() 探测宿主通道（当前返回 null），
// 再走双文件引导（pnpm.mjs + worker.js）。
//
// 导出：PNPM_VERSION（版本常量）/ ensurePnpm（幂等引导，返回 pnpm 入口绝对路径）
// / tryHostChannel（宿主通道探测占位）/ runPnpm（spawn 宿主 node + pnpm 入口封装）
// / DSH_PACKAGE + buildPnpmAddArgs（pnpm add 参数构造收敛入口：v0.20.x 起
// lib/install.js 唯一 pnpm add 调用点只传 registry 兜底意图，包名/旗标同源本模块）
// / isValidPkgSpec（spec 注入面校验：仅接受严格 SemVer 或合法 dist-tag；校验职责在
// 调用方——installDepsFromPlugin 计算 effectiveSpec 后、传 buildPnpmAddArgs 前负责）。
// 消费方（v0.18.2 收敛）：lib/install.js（installDepsFromPlugin 部署 dsh 依赖树 +
// verifyDepsSmoke 的 pnpm 引导检查）。lib/check.js（npmViewDistTags）与 src/lifecycle.js
// （patch 模板 {{NPM_CLI_PATH}} 占位符）v0.18.2 起退出——版本检查改 HTTP 直查 npm
// registry（pnpm view 语义等价），patch 模板不再注入 pnpm 入口（settings 侧检查链路同改）。
//
// 零运行时依赖：只用 node 内置模块（fs/path/crypto/https/child_process），不引入任何
// npm 依赖（rspack externalsPresets.node 下保持外部 import）。容错纪律：引导失败抛
// 可读错误（含两个 CDN 提示），由调用方按需降级。注释风格同 lib 侧（中文/双引号/分号）。

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  renameSync,
} from "node:fs";
import { get as httpsGet } from "node:https";
import { join } from "node:path";
import {
  getSingleton,
  PLUGIN_ROOT,
  resolveNodeExec,
  resolveNodeExecEnv,
} from "./state.js";

// ---- 版本单一事实源：package.json packageManager 字段（"pnpm@11.24.0" → "11.24.0"）----
// 读取定位复用 state.js 的 PLUGIN_ROOT（向上找含 manifest.json 的目录，源码/bundle 两形态均成立）；
// 解析失败回退硬编码（与 packageManager 同步的兜底值；升级 pnpm 版本时两处都要改）。
// ---- 运行时引导配置（静态，版本与文件 sha256 同源）----
// 版本单一事实源 = 本对象；与 package.json 的 packageManager 字段（构建期 pnpm）解耦：
// 运行时引导的 pnpm 只服务 pnpm add（依赖部署）路径——v0.18.2 起 pnpm view（版本检查）
// 改 HTTP 直查 npm registry（pnpm view 语义等价），锁 11.24.0 足够；升级 pnpm
// 时需同时改 version 与对应文件 sha256（实测本地 node_modules/pnpm/dist/* 后更新）。
// 版本与校验放同一对象，从结构上杜绝「动态版本 × 静态校验」不同步导致的
// 误导性失败（改 packageManager 只影响构建，不会静默让运行时引导对不上 hash）。
// ⚠️ 版本兼容：pnpm 11.24.0 的 engines 要求 node >=22.13；宿主 electron node 当前为
// v24.15.0（满足）。升级 pnpm 时须核对新版本 engines 不超过宿主 node 版本
// （宿主 node 版本固定，不做运行时探测；该约束靠此处注释人工把关）。
// 两个文件：pnpm.mjs（入口 CLI）+ worker.js（package 导入 worker）——pnpm add 的
// 导入阶段经 new Worker(import.meta.dirname/worker.js) 加载 worker.js（pnpm.mjs
// 内联处：workerScriptPath = join(import.meta.dirname, "worker.js")），只下载
// pnpm.mjs 会让 add 的导入 worker 崩溃（exit 1，无错误信息）；pnpm view 路径不触
// 发 worker，单文件即可。实测（2026-09，宿主 node v24.15.0）确认两个文件均必需。
const PNPM_BOOTSTRAP = {
  version: "11.24.0",
  files: [
    {
      name: "pnpm.mjs",
      sha256: "ad23cef73b049f61e2450b1ba0c0cf2259114b8ec70f5e09b241b85a0cf0841d",
    },
    {
      name: "worker.js",
      sha256: "7847564f84d0f9fd088539f679b88fb8dec7195e145b4bbf25b712442b6d99c8",
    },
  ],
};

// 兼容导出（外部取版本号用；值 = 静态配置 version，与文件 sha256 同源）
export const PNPM_VERSION = PNPM_BOOTSTRAP.version;

// 下载源：unpkg 直链优先，jsdelivr 兜底（同一文件；两者均可能 302 到边缘 CDN）
const PNPM_CDNS = [
  (name) => `https://unpkg.com/pnpm@${PNPM_BOOTSTRAP.version}/dist/${name}`,
  (name) => `https://cdn.jsdelivr.net/npm/pnpm@${PNPM_BOOTSTRAP.version}/dist/${name}`,
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

// ---- sha256（node:crypto 流式计算，零依赖）----
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const rs = createReadStream(file);
    rs.on("error", reject);
    rs.on("data", (d) => hash.update(d));
    rs.on("end", () => resolve(hash.digest("hex")));
  });
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
  // 并发触发只下载一次。settle 后重置为 null：下次调用重新走「缓存存在 + sha256 一致」
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
  // ② 缓存路径 <dataDir>/pnpm-dist/pnpm-{version}/{pnpm.mjs,worker.js}（独立于 dsh-pkg）
  const dataDir = resolveDataDir(opts);
  const cacheDir = join(dataDir, "pnpm-dist", "pnpm-" + PNPM_BOOTSTRAP.version);
  const entry = join(cacheDir, "pnpm.mjs");
  // ③ 缓存命中且全部文件 sha256 与预期一致 → 直接返回（幂等快速路径）
  const cached = await cacheIntact(cacheDir);
  if (cached) {
    console.log("[pnpm] 命中缓存：" + entry);
    return entry;
  }
  // ④ 下载：unpkg 优先 → jsdelivr 兜底；逐文件临时文件 → 校验 sha256 → 原子落位
  // （mkdir + rename）。任一文件两源全败 → 抛可读错误（含两源提示）。
  mkdirSync(cacheDir, { recursive: true });
  for (const file of PNPM_BOOTSTRAP.files) {
    const target = join(cacheDir, file.name);
    const tmp = join(
      cacheDir,
      ".pnpm." + file.name + "." + process.pid + "." + Date.now() + ".tmp",
    );
    let lastError = null;
    for (const cdn of PNPM_CDNS) {
      const url = cdn(file.name);
      try {
        console.log("[pnpm] 引导下载 " + url + " …");
        await downloadToFile(url, tmp);
        const actual = await sha256File(tmp);
        if (actual !== file.sha256) {
          try {
            rmSync(tmp, { force: true });
          } catch {
            /* 清理失败忽略 */
          }
          throw new Error(
            "pnpm 引导 sha256 校验失败（" +
              file.name +
              "：期望 " +
              file.sha256 +
              "，实际 " +
              actual +
              "）",
          );
        }
        rmSync(target, { force: true }); // 旧缓存（哈希不符场景）先清，再原子落位
        renameSync(tmp, target); // 同目录 rename，原子替换
        console.log("[pnpm] 引导完成：" + target);
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        try {
          rmSync(tmp, { force: true });
        } catch {
          /* 清理失败忽略 */
        }
        console.warn("[pnpm] " + url + " 下载失败：" + (e?.message || e));
      }
    }
    if (lastError) {
      throw new Error(
        "pnpm 引导失败（" +
          file.name +
          "）：两个源均不可用（" +
          PNPM_CDNS.map((f) => f(file.name)).join("、") +
          "），最后错误：" +
          (lastError?.message || lastError) +
          "。请检查网络后重试。",
      );
    }
  }
  return entry;
}

// 缓存完整性：全部引导文件存在且 sha256 与预期一致（任一缺失/不符 → 重新下载）
async function cacheIntact(cacheDir) {
  for (const file of PNPM_BOOTSTRAP.files) {
    const p = join(cacheDir, file.name);
    if (!existsSync(p)) return false;
    try {
      if ((await sha256File(p)) !== file.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
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

// ---- pnpm add 参数构造（lib/install.js 唯一 pnpm add 调用点的收敛入口）----
// v0.20.x 起：install.js 不再手拼 pnpm add 参数，改调 buildPnpmAddArgs——只传意图
// （registry 兜底 URL + spec），包名/旗标同源本模块：DSH_PACKAGE（依赖包名）+ 本函数静态旗标。
// spec 支持（vX 起）：可传具体版本号或 dist-tag（如 "1.0.0-alpha.1" / "next"），拼成
// @deepseek-ai/dsh@<spec>（npm/pnpm 原生支持 tag spec）；缺省（undefined/空串）装默认
// 最新（buildPnpmAddArgs 不拼 @ 后缀）。registry 兜底与 spec 相互独立、互不影响。
// ⚠️ 本函数保持纯拼接不做校验——spec 合法性（严格 SemVer 或合法 dist-tag，见
// isValidPkgSpec）由调用方负责：installDepsFromPlugin 计算 effectiveSpec 后、传入
// 前校验（注入面收口，防 "npm:evil@1.0.0" / "github:user/repo" / "file:../x" /
// "/abs/path" 等安装非预期包）。
// --reporter=ndjson 取代旧 --loglevel=http：pnpm 11.24.0 的 ndjson reporter 每行一个
// JSON 对象（bole 序列化到 stdout，level 为 debug/info/warn/error 字符串，name 标识
// 事件类型），输出结构化安装进度事件流（pnpm:fetching-progress / pnpm:stage /
// pnpm:root / pnpm:stats / pnpm:lifecycle …），供 install.js 逐行解析转可读进度行。
export const DSH_PACKAGE = "@deepseek-ai/dsh";

export function buildPnpmAddArgs({ registry, spec } = {}) {
  const target =
    DSH_PACKAGE + (typeof spec === "string" && spec.trim() ? "@" + spec.trim() : "");
  const args = ["add", target, "--reporter=ndjson"];
  if (typeof registry === "string" && registry) {
    args.push("--registry=" + registry);
  }
  return args;
}

// ---- spec 注入面校验（vX：installDepsFromPlugin 调用前收口）----
// effectiveSpec 会拼成 DSH_PACKAGE + "@" + spec 传给 pnpm add；spec 来自工具参数
// （version/tag）或配置基线 dshTag。不校验时 "npm:evil@1.0.0"（npm alias）、
// "github:user/repo"、"file:../x"、"/abs/path" 等会让 pnpm add 安装非预期包。
// 只接受两类：
//   ① 合法 SemVer（严格：核心组件与数字 prerelease 标识符必须 0|[1-9]\d*，无前导零；
//      prerelease/build 允许；build 标识符不受前导零限制——SemVer §10 无此约束）
//   ② 合法 dist-tag：/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ 且不是合法 SemVer，且不是
//      「版本形状」字符串（宽松 \d+.\d+.\d+ 形状——01.0.0 / 1.0.0-alpha.01 之类
//      严格校验不过的版本号不应被 dist-tag 规则放行）；tag 正则本身已排除
//      @ / : / 空格等协议与 alias 字符（规则冗余防御）。
// 校验失败返回 false，由调用方按容错纪律提前返回 { ok:false, error }（不 throw）。
// 校验职责在调用方（lib/install.js installDepsFromPlugin 计算 effectiveSpec 后、
// 传给 buildPnpmAddArgs 前调用）；buildPnpmAddArgs 保持纯拼接（目标恒为已校验 spec）。
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
