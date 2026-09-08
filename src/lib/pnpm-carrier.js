// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/pnpm-carrier.js — pnpm 12 载体引导 + 依赖安装（受管 runtime 内执行）
//
// 定型（T1 探针 2026-09-08，证据见 spec/current/dshana-v2-runtime-inproc + gap audit §1.2）：
//   载体 = **@pnpm/napi 12.3.4**（pnpm v12 Rust 引擎的 Node N-API 绑定，进程内调用）。
//   取舍依据：
//     ① 受管 native runtime 内 native addon 可加载（探针 6ms/26ms 两次实证，conpty/koffi 同证）；
//     ② 程序化 API 是官方文档化契约（index.d.ts 29KB：install(options,onLog,hook,onOutput) +
//        readConfig/readLockfile/rebuild/pack…），选项形状镜像 pnpm v11 程序化 API，非内部私有面；
//     ③ 无子进程：不 spawn、不需要 node 代理 + PATH 前缀、不受 App 进程 fs/child 限制影响；
//        进度经 onOutput/onLog 直读，InstallResult 直接给 stats/storeDir；
//     ④ 体积与 @pnpm/exe 相当（平台包 41MB vs 40.8MB），但少一层进程与 CLI 文本解析。
//   @pnpm/exe（单文件 MZ PE，40.8MB）保留为备选：若未来 napi 平台包缺失/ABI 不兼容，
//   同一 ensure/install 接口可换 spawn 实现（本模块已把「载体落位」与「安装调用」分开）。
//
// 落位（固定路径 + 覆盖，无版本目录；spec D2）：
//   dataDir/runtime/pnpm/
//   ├── package.json           @pnpm/napi 包体（loader，54KB）
//   ├── index.js               loader（优先 PNPM_NAPI_BINARY，其次平台包 require）
//   ├── node_modules/@pnpm/napi.<triple>/  平台包（pnpm-napi.node 41MB）
//   └── .pnpm-ok               完成标记 { version, platform, files:{sha256}, sources }
//
// 完整性（spec D2：npm integrity sha512）：每源先取 packument 的 dist.integrity（sha512-base64）
// 再下载 tarball 校验；校验失败自动换下一源（4 源：npmjs / npmmirror / 腾讯云 / 华为云）。
//
// 依赖安装通道（spec C4/D2）：本模块只在**受管 native runtime 进程**内被 dsh-host.mjs 调用
// （App 进程内 @pnpm/napi 会 ERR_DLOPEN_DISABLED——C3 实证）。App 侧不再有 processSpawn。

import { createRequire } from "node:module";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  renameSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { delimiter } from "node:path";
import { createHash } from "node:crypto";
import { fileSha256, PNPM_VERSION, readJsonFile, readTextFile } from "./runtime-layout.js";

const NAPI_PACKAGE = "@pnpm/napi";
const DOWNLOAD_TIMEOUT_MS = 120000;
// registry 类下载源（官方 → 官方国内镜像 → 第三方国内镜像）。tarball 与 packument 同源取用，
// sha512 校验兜底：内容不符的源在引导时被拦下自动换下一个，源列表可安全扩充。
const REGISTRY_SOURCES = [
  "https://registry.npmjs.org",
  "https://registry.npmmirror.com",
  "https://mirrors.cloud.tencent.com/npm",
  "https://mirrors.huaweicloud.com/repository/npm",
];

/** 平台三元组（@pnpm/napi.<triple> 包名后缀）。Linux 区分 glibc/musl。 */
export function platformTriple(platform = process.platform, arch = process.arch) {
  if (platform === "linux") {
    const musl = (() => {
      try {
        const report = process.report?.getReport?.();
        return !report?.header?.glibcVersionRuntime;
      } catch {
        return false;
      }
    })();
    return "linux-" + arch + (musl ? "-musl" : "");
  }
  return platform + "-" + arch;
}

// ---- HTTP GET（全局 fetch + AbortSignal 超时；受管 native runtime 带 external 网络）----
// 说明：受管 runtime 的 node v26 自带 fetch（undici），无需 node:https——后者在 rspack
// externalsPresets.node 下经命名空间导入时形态不稳（实测 undefined.get），fetch 更直接。
async function httpGet(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": "dsh-hanako-app" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("HTTP " + res.status + "：" + url);
  return res;
}

async function fetchText(url) {
  const res = await httpGet(url);
  return await res.text();
}

async function fetchBuffer(url) {
  const res = await httpGet(url);
  return Buffer.from(await res.arrayBuffer());
}

// ---- tar 提取（零依赖：npm tarball = gzip(tar)）----
// 支持常规文件（typeflag '0'/NUL）+ PAX 扩展头（'x'，path 覆盖）+ GNU longname（'L'）。
// strip = 去掉路径前 N 段（npm tarball 为 package/ 前缀）。目录条目按需 mkdir。
// 目标路径一律 join(dest, 安全相对路径)，逐段拒绝 ".." 与绝对路径（zip-slip 面关闭）。
export function extractTarball(tgzBuffer, destDir, { strip = 1, only = null } = {}) {
  const tarBuf = gunzipSync(tgzBuffer);
  const written = [];
  let off = 0;
  let pendingLong = null;
  let paxPath = null;
  const safeJoin = (name) => {
    const parts = String(name).split("/").filter((s) => s && s !== ".");
    const rel = parts.slice(strip);
    if (!rel.length) return null;
    for (const seg of rel) {
      if (seg === ".." || seg.includes("\\") || seg.includes(":")) return null;
    }
    return join(destDir, ...rel);
  };
  while (off + 512 <= tarBuf.length) {
    const head = tarBuf.subarray(off, off + 512);
    if (head.every((b) => b === 0)) break; // 归档结束（全零块）
    const typeflag = String.fromCharCode(head[156] || 0);
    const sizeStr = head.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    if (!Number.isFinite(size) || size < 0) throw new Error("tar 头解析失败 @" + off);
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    off = dataEnd + (Math.ceil(size / 512) * 512 - size);
    if (typeflag === "x") {
      const pax = tarBuf.subarray(dataStart, dataEnd).toString("utf8");
      for (const rec of pax.split("\n")) {
        const sp = rec.indexOf(" ");
        const eq = rec.indexOf("=", sp + 1);
        if (sp > 0 && eq > sp + 1 && rec.slice(sp + 1, eq) === "path") paxPath = rec.slice(eq + 1);
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
    if (typeflag === "5") {
      // 目录条目：仅确保存在（文件写入时也会 mkdir）
      const dir = safeJoin(name);
      if (dir) mkdirSync(dir, { recursive: true });
      continue;
    }
    if (typeflag !== "0" && typeflag !== "\0") continue; // 链接/设备等一律跳过
    if (only && !only.test(name)) continue;
    const target = safeJoin(name);
    if (!target) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, tarBuf.subarray(dataStart, dataEnd));
    written.push(target);
  }
  return written;
}

/** 单包下载 + integrity 校验（多源依次尝试）。返回 { buffer, source, integrity }。 */
async function downloadPackage(name, version, log) {
  const short = name.split("/").pop();
  const errors = [];
  for (const registry of REGISTRY_SOURCES) {
    const metaUrl = registry + "/" + name;
    const tgzUrl = registry + "/" + name + "/-/" + short + "-" + version + ".tgz";
    try {
      const meta = JSON.parse(await fetchText(metaUrl));
      const entry = meta && meta.versions && meta.versions[version];
      const integrity = entry && entry.dist && entry.dist.integrity;
      const expected = parseIntegrity(integrity);
      if (!expected) {
        errors.push(registry + "：packument 缺 dist.integrity（拒绝无校验下载）");
        continue;
      }
      const buffer = await fetchBuffer(tgzUrl);
      const actual = createHash("sha512").update(buffer).digest();
      if (!actual.equals(expected)) {
        errors.push(registry + "：sha512 校验失败");
        continue;
      }
      log("[pnpm] 载体下载 " + name + "@" + version + "（" + registry + "，" + buffer.length + " bytes，sha512 校验通过）");
      return { buffer, source: registry, integrity };
    } catch (e) {
      errors.push(registry + "：" + (e?.message || e));
    }
  }
  throw new Error(
    "pnpm 载体下载失败：" + name + "@" + version + " 全部源不可用（" + errors.join("；") + "）。请检查网络后重试。",
  );
}

function parseIntegrity(integrity) {
  if (typeof integrity !== "string") return null;
  const m = integrity.match(/sha512-([A-Za-z0-9+/=]+)/);
  return m ? Buffer.from(m[1], "base64") : null;
}

/**
 * 载体落位（幂等；标记不符即重下）。返回 { ok, dir, entry, version, triple, error }。
 * 标记 .pnpm-ok 记录 version + platform + 每文件 sha256（读侧重算比对，防篡改/截断/混合对）。
 */
export async function ensureCarrier(paths, { log = () => {}, force = false } = {}) {
  const triple = platformTriple();
  const carrierDir = paths.pnpmDir;
  const markerPath = paths.pnpmMarker;
  const marker = readJsonFile(markerPath);
  const entryFile = join(carrierDir, "index.js");
  if (
    !force &&
    marker &&
    marker.version === PNPM_VERSION &&
    marker.triple === triple &&
    existsSync(entryFile) &&
    carrierIntact(carrierDir, marker)
  ) {
    return { ok: true, dir: carrierDir, entry: entryFile, version: PNPM_VERSION, triple, cached: true };
  }
  const staging = carrierDir + ".tmp-" + process.pid;
  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    const sources = [];
    const loaderPkg = await downloadPackage(NAPI_PACKAGE, PNPM_VERSION, log);
    sources.push({ package: NAPI_PACKAGE, source: loaderPkg.source });
    extractTarball(loaderPkg.buffer, staging); // loader 包体（package.json + index.js + d.ts）
    const platformPkg = await downloadPackage(
      NAPI_PACKAGE + "." + triple,
      PNPM_VERSION,
      log,
    );
    sources.push({ package: NAPI_PACKAGE + "." + triple, source: platformPkg.source });
    const platformDest = join(staging, "node_modules", "@pnpm", NAPI_PACKAGE.split("/")[1] + "." + triple);
    mkdirSync(platformDest, { recursive: true });
    extractTarball(platformPkg.buffer, platformDest);
    // 完成标记（记录每文件 sha256；读侧重算比对）
    const files = {};
    for (const rel of ["package.json", "index.js"]) {
      const sha = fileSha256(join(staging, rel));
      if (sha) files[rel] = sha;
    }
    const nativeFile = join(platformDest, "pnpm-napi.node");
    if (!existsSync(nativeFile)) {
      throw new Error("载体落位失败：平台包缺少 pnpm-napi.node（" + platformDest + "）");
    }
    files["native"] = fileSha256(nativeFile);
    writeFileSync(
      join(staging, ".pnpm-ok"),
      JSON.stringify({ version: PNPM_VERSION, triple, files, sources, at: new Date().toISOString() }, null, 2) + "\n",
      "utf8",
    );
    // 原子发布：旧目录整体替换（staging 同父目录 rename）
    rmSync(carrierDir, { recursive: true, force: true });
    renameSync(staging, carrierDir);
    log("[pnpm] 载体就绪：" + carrierDir + "（" + NAPI_PACKAGE + "@" + PNPM_VERSION + " " + triple + "）");
    return { ok: true, dir: carrierDir, entry: join(carrierDir, "index.js"), version: PNPM_VERSION, triple, cached: false };
  } catch (e) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* 清理失败忽略 */
    }
    return { ok: false, error: String(e?.message || e), triple };
  }
}

function carrierIntact(carrierDir, marker) {
  try {
    const files = marker.files || {};
    for (const rel of ["package.json", "index.js"]) {
      const expected = files[rel];
      if (typeof expected !== "string") return false;
      if (fileSha256(join(carrierDir, rel)) !== expected) return false;
    }
    const nativeFile = join(
      carrierDir,
      "node_modules",
      "@pnpm",
      "napi." + marker.triple,
      "pnpm-napi.node",
    );
    if (typeof files.native !== "string") return false;
    return fileSha256(nativeFile) === files.native;
  } catch {
    return false;
  }
}

/**
 * 载入载体（进程内 require；native addon 只在受管 runtime 内可加载）。
 * 注意用**目录相对路径**而非裸包名：载体包体直接解到 runtime/pnpm/（不是
 * node_modules/@pnpm/napi），裸名会沿 node_modules 上溯而找不到；其内部对
 * @pnpm/napi.<triple> 的解析走同目录 node_modules（见 ensureCarrier 落位），仍然成立。
 */
export function loadCarrier(carrierDir) {
  const req = createRequire(join(carrierDir, "package.json"));
  return req(carrierDir);
}

/** 解析 pnpm-workspace.yaml 的 allowBuilds 白名单（极简 YAML 子集，够用即可）。 */
export function parseAllowBuilds(yamlText) {
  const out = {};
  if (typeof yamlText !== "string") return out;
  const lines = yamlText.split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    if (/^allowBuilds\s*:/.test(line)) {
      inBlock = true;
      const inline = line.slice(line.indexOf(":") + 1).trim();
      if (inline === "{}") return out;
      continue;
    }
    if (!inBlock) continue;
    if (!/^\s/.test(line)) {
      inBlock = false;
      continue;
    }
    const m = line.match(/^\s+["']?([^"':]+)["']?\s*:\s*(\S+)\s*$/);
    if (!m) continue;
    out[m[1].trim()] = !/^(false|no|0)$/i.test(m[2]);
  }
  return out;
}

/** node 代理（install script 经 cmd 起 node 时命中）：win32 写 node.cmd，其余写 node。 */
function ensureNodeProxy(root, log) {
  const exec = process.execPath;
  try {
    if (process.platform === "win32") {
      const script = join(root, "node.cmd");
      const content = '@"' + exec + '" %*\n';
      let prev = null;
      try {
        prev = readFileSync(script, "utf8");
      } catch {
        /* 缺失 */
      }
      if (prev !== content) writeFileSync(script, content);
    } else {
      const script = join(root, "node");
      const content = '#!/bin/sh\nexec "' + exec + '" "$@"\n';
      let prev = null;
      try {
        prev = readFileSync(script, "utf8");
      } catch {
        /* 缺失 */
      }
      if (prev !== content) writeFileSync(script, content, { mode: 0o755 });
    }
    return true;
  } catch (e) {
    log("[pnpm] node 代理写入失败（install script 可能找不到 node）：" + (e?.message || e));
    return false;
  }
}

/**
 * 依赖安装（受管 runtime 内进程内调用；无子进程）。
 * opts: { paths, declaration, frozenLockfile?, log?, onOutput? }
 * 返回 { ok, result?, error?, errorCode? }（不抛——调用方按容错纪律决定是否降级）。
 */
export async function installRuntimeDeps(opts) {
  const { paths, declaration, log = () => {}, frozenLockfile = false } = opts || {};
  if (!declaration || !declaration.manifest) {
    return { ok: false, error: "运行时声明缺失（installDir/runtime/package.json）" };
  }
  const carrier = await ensureCarrier(paths, { log });
  if (!carrier.ok) return { ok: false, error: carrier.error, stage: "carrier" };
  let napi;
  try {
    napi = loadCarrier(carrier.dir);
  } catch (e) {
    return {
      ok: false,
      stage: "load",
      error:
        "pnpm 载体加载失败（受管 runtime 内 native addon 应可用；若在 App 进程内调用会 ERR_DLOPEN_DISABLED）：" +
        (e?.message || e),
    };
  }
  let config = null;
  try {
    config = napi.readConfig({ dir: paths.root });
  } catch (e) {
    log("[pnpm] readConfig 失败（走引擎默认）：" + (e?.message || e));
  }
  const allowBuilds = parseAllowBuilds(readTextFile(paths.workspace));
  // overrides：声明 package.json 的 pnpm.overrides（T1 实证：koffi 必须钉 3.1.6——3.2.1 的
  // install script 在无 CMake 环境回退源码构建并失败，而 3.1.6 的 @koromix 预编译产物可直接加载）
  const overrides =
    (declaration.manifest.pnpm && declaration.manifest.pnpm.overrides) || undefined;
  const projects = [{ rootDir: paths.root, manifest: declaration.manifest }];
  const options = {
    dir: paths.root,
    projects,
    frozenLockfile: !!frozenLockfile,
    preferFrozenLockfile: !!frozenLockfile,
    allowBuilds,
    ...(overrides ? { overrides } : {}),
    nodeVersion: process.versions.node,
    reporter: { appendOnly: true, logLevel: "info" },
    // lockfileOnly：只解析依赖图并写 pnpm-lock.yaml（发版前生成随包锁用）。注意不要同时传
    // enableModulesDir:false——实测那样连锁文件也不写（引擎把「不物化」当成整体空操作）。
    ...(opts.lockfileOnly ? { lockfileOnly: true } : {}),
  };
  // store 位置（T1 探针 2026-09-08 定案）：**必须显式指向可写区**。受管 native runtime 的
  // 写授权 = dataDir + 宿主授权工作区；pnpm 12 默认全局 store（E:\.pnpm-store\v11）在受管
  // runtime 内写入被拒（实测 GenericFailure：Failed to write cafs ... 拒绝访问 os error 5），
  // 因此固定用 runtime/.pnpm-store（内容寻址，同 runtime 内共享；跨 App 共享让位于正确性）。
  options.storeDir = opts.storeDir || paths.storeDir;
  log("[pnpm] storeDir=" + options.storeDir + "（受管 runtime 可写区）");
  if (config) {
    if (Array.isArray(config.registries)) {
      const registries = {};
      for (const r of config.registries) registries[r.name] = r.url;
      options.registries = registries;
    }
    if (config.authHeaderByUri) options.authHeaderByUri = config.authHeaderByUri;
    if (config.effectiveVirtualStoreDir) {
      options.virtualStoreDirMaxLength = config.virtualStoreDirMaxLength;
    }
  }
  // install script 的 node 解析：PATH 首部指向 runtime 根（node.cmd/node 代理与安装区同目录）
  const proxyOk = ensureNodeProxy(paths.root, log);
  const prevPath = process.env.PATH || "";
  if (proxyOk) process.env.PATH = paths.root + delimiter + prevPath;
  const onOutput = typeof opts.onOutput === "function" ? opts.onOutput : () => {};
  const onLog = (ev) => {
    // pnpm 事件流（bunyan 形状）：只挑可读字段，避免整对象刷屏
    try {
      const name = ev && ev.name ? String(ev.name) : "pnpm";
      const level = ev && ev.level ? String(ev.level) : "info";
      if (level === "debug") return;
      log("[" + name + "] " + JSON.stringify(ev).slice(0, 400));
    } catch {
      /* 事件不可序列化：忽略 */
    }
  };
  try {
    const t0 = Date.now();
    const result = await napi.install(options, onLog, undefined, (chunk) => {
      const text = String(chunk);
      onOutput(text);
      log("[pnpm] " + text.replace(/\s+$/, "").slice(0, 400));
    });
    log(
      "[pnpm] install 完成（" +
        Math.round((Date.now() - t0) / 1000) +
        "s，added=" +
        (result?.stats?.added ?? "?") +
        "，storeDir=" +
        (result?.storeDir || "?") +
        "）",
    );
    return { ok: true, result, carrier };
  } catch (e) {
    return {
      ok: false,
      stage: "install",
      errorCode: e?.code,
      error: String(e?.message || e),
      hint: e?.hint,
      carrier,
    };
  } finally {
    if (proxyOk) process.env.PATH = prevPath;
  }
}
