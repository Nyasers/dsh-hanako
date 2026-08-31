// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/check.js — DSH 版本检查共用模块（lib 提取）
// 从 tools/dsh-run.js 剥离：npmViewDistTags（HTTP 直查 npm registry 根包 JSON 取
// dist-tags）+ checkDshUpdate（本地版本 + 远端 dist-tags + 基线 tag → { localVersion,
// distTags, baselineTag, baselineVersion, updateAvailable, error? }）。
// 依赖 lib/install.js 的 verifyDepsSmoke 缓存（g.deps.result）+ 本地版本直读
// （readDshInstalledVersion）+ semver 比较（compareSemver）；状态经 lib/state.js
// getSingleton 访问分组 g.check = { status, result, error, time, log }（v0.24 状态
// 收敛：旧平铺 g.checking/g.checkResult/g.checkAt 全废）。
// 基线体系（vX 起）：远端不再只查 latest，改查根包 JSON 的 dist-tags 全量映射
// （{"latest":"0.1.1-rc.2","next":"0.1.1-rc.2","alpha":"0.1.2-alpha.2"}）——更新基线
// 由配置项 dshTag（config.json global.dshTag，默认 "latest"，lib/config.js
// resolveDshTag）决定，工具显式传 version/tag 时优先（version 优先于 tag）。
// 消费方：dsh-run.js（挂单例 g.checkDshUpdate）、tools/dsh-install.js、routes/webui.js
// （/webui/check-update）。dsh 设置页「DSH 版本」卡片 v0.18.1 起由 dsh 侧
// @dsh-hanako/settings 内嵌直查远端（同款 HTTP 直查 npm registry），不再经本函数桥接。
//
// 容错纪律：远端版本查询全败只置 error 字段不抛（调用方按需降级）；结果只缓存
// g.check.result（内存，不再写 check-result.json 桥接文件——v0.18.1 起设置页检查
// 改 dsh 侧直查，无跨进程读回需求）。注释风格保持宿主侧（中文/双引号/分号）。

import { getSingleton } from "./state.js";
import { readDshInstalledVersion, compareSemver } from "./install.js";
import { resolveDshTag } from "./config.js";

// HTTP 直查 npm registry（v0.18.2 起替代 spawn pnpm view；vX 起升级为根包 JSON）：
// fetch https://registry.npmjs.org/@deepseek-ai/dsh 的根包 JSON，取 dist-tags 字段
// （tag → version 全量映射）与 versions 字段（全部发布版本键，供指定版本存在性校验）；
// 官方源失败重试一次 https://registry.npmmirror.com/@deepseek-ai/dsh；15s 超时
// AbortSignal.timeout；仍失败 → { distTags:null, error }（调用方按需降级，不抛）。
// HTTP 能力：宿主 node v24 全局 fetch 可用，零运行时依赖。不再依赖 pnpm 引导
// （ensurePnpm/runPnpm 由 lib/install.js 的 installDepsFromPlugin 继续使用，此处退出）。
async function npmViewDistTags() {
  const fetchJson = async (url) => {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { "user-agent": "dsh-hanako-plugin" },
      });
      if (!res.ok) return { ok: false, error: "HTTP " + res.status + "：" + url };
      const data = await res.json();
      const distTags =
        data && typeof data["dist-tags"] === "object" && data["dist-tags"]
          ? data["dist-tags"]
          : null;
      if (!distTags) return { ok: false, error: "响应缺少 dist-tags 字段：" + url };
      const versions =
        data && typeof data.versions === "object" && data.versions
          ? Object.keys(data.versions)
          : null;
      return { ok: true, distTags, versions };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  };
  try {
    const first = await fetchJson("https://registry.npmjs.org/@deepseek-ai/dsh");
    if (first.ok) {
      return { distTags: first.distTags, versions: first.versions, error: null };
    }
    const second = await fetchJson(
      "https://registry.npmmirror.com/@deepseek-ai/dsh",
    );
    if (second.ok) {
      return { distTags: second.distTags, versions: second.versions, error: null };
    }
    return {
      distTags: null,
      versions: null,
      error: second.error || first.error || "查询失败",
    };
  } catch (e) {
    return { distTags: null, versions: null, error: e?.message || String(e) };
  }
}

// ---- 检查 DSH 更新（能力层）：本地版本 + 远端 dist-tags + 基线 tag → { localVersion,
// distTags, baselineTag, baselineVersion, updateAvailable, error? }。基线解析：
//   · 显式 version（opts.version，工具参数）→ 对比该版本（校验远端存在性），
//     baselineTag = null（无 tag 基线）、baselineVersion = 该版本；
//   · 否则 tag（opts.tag 显式优先 → 配置基线 resolveDshTag(cfg)）→ baselineTag = tag、
//     baselineVersion = distTags[tag]。
// updateAvailable = 本地版本 < baselineVersion。latestVersion 字段保留为
// baselineVersion 别名（旧消费方兼容）。
// 并发防护：g.check.status === "running" 进行中返回上次结果 + running 标志。
// 结果缓存 g.check.result / g.check.time（内存，供 dsh_install 工具与
// /webui/check-update 直读返回值；不再写 check-result.json——v0.18.1 起设置页检查改
// dsh 侧直查）。失败（远端查询全败）只置 error 字段不抛。----
export async function checkDshUpdate(cfg, opts = {}) {
  const g = getSingleton();
  const versionParam = String(opts?.version || "").trim();
  const tagParam = String(opts?.tag || "").trim();
  if (g.check.status === "running") {
    return {
      ...(g.check.result || {
        localVersion: null,
        distTags: null,
        baselineTag: null,
        baselineVersion: null,
        updateAvailable: false,
      }),
      running: true,
    };
  }
  g.check.status = "running";
  g.check.error = null;
  g.check.time = Date.now();
  const dataDir = cfg.dataDir || g.dataDir;
  const diagCfg = { ...cfg, dataDir };
  // 会话日志（src=hana）：开始/完成 里程碑——故障诊断（远端查询失败、版本比较异常、
  // 设置页/标签页/Agent 三路触发）在会话日志里有完整上下文（本地版本来源 + 远端查询
  // 结果 + 错误）。失败不抛（容错纪律：远端查询全败只置 error 字段）。
  const slog = (s) => {
    if (typeof g.appendLog === "function") {
      try {
        g.appendLog("hana", "[版本检查] " + s);
      } catch {
        /* 日志失败不阻断 */
      }
    }
  };
  try {
    // 本地版本：verifyDepsSmoke 缓存优先（能跑 = 依赖图完整，版本号即真值）；无则直读 package.json
    const smoke = g.deps.result;
    const fromSmoke = !!(smoke && !smoke.running && smoke.ok);
    let localVersion = fromSmoke ? smoke.version : null;
    if (!localVersion) localVersion = readDshInstalledVersion(diagCfg);
    slog(
      "开始（本地=" + (localVersion || "未安装") + "，来源=" + (fromSmoke ? "运行级验证缓存" : "直读 dsh-pkg package.json") + (versionParam ? "，指定版本=" + versionParam : "") + "）",
    );
    const remote = await npmViewDistTags();
    const distTags = remote.distTags;
    // 基线解析：version 参数优先（对比指定版本）→ tag（显式优先配置基线）
    const baselineTag = versionParam ? null : tagParam || resolveDshTag(diagCfg);
    let baselineVersion = null;
    let err = null;
    if (versionParam) {
      // 指定版本：远端存在性校验（dist-tags 值或 versions 键命中；查询失败时无法
      // 确认存在 → 置 error 不臆断）
      if (remote.error) {
        err = remote.error;
      } else if (
        (distTags && Object.values(distTags).indexOf(versionParam) !== -1) ||
        (remote.versions && remote.versions.indexOf(versionParam) !== -1)
      ) {
        baselineVersion = versionParam;
      } else {
        err = "远端不存在版本 v" + versionParam;
      }
    } else if (distTags) {
      baselineVersion = distTags[baselineTag] || null;
      if (!baselineVersion) err = "远端不存在 dist-tag " + baselineTag;
    } else {
      err = remote.error || "查询失败";
    }
    const updateAvailable = !!(
      localVersion &&
      baselineVersion &&
      compareSemver(localVersion, baselineVersion) < 0
    );
    const result = {
      localVersion,
      distTags,
      baselineTag,
      baselineVersion,
      updateAvailable,
      // 旧字段兼容别名（webui 路由 / 旧消费方）：= 基线版本
      latestVersion: baselineVersion,
    };
    if (err) result.error = err;
    slog(
      "完成（本地=" + (localVersion || "未安装") + "，基线=" + (baselineTag ? "tag " + baselineTag : "version " + (baselineVersion || "?")) + "，远端版本=" + (baselineVersion || "查询失败") + (err ? "，" + err : "") + (updateAvailable ? "，可更新" : "") + "）",
    );
    g.check.result = result;
    g.check.time = Date.now();
    g.check.error = result.error || null;
    console.log(
      "[dsh-run] 版本检查：本地 " + (localVersion || "未安装") + " / 基线 " + (baselineTag ? baselineTag : "version") + " " + (baselineVersion || "查询失败") + (updateAvailable ? "（可更新）" : ""),
    );
    return result;
  } finally {
    // 检查链路终态（ok/error 保留；下次入口才回到 running）
    g.check.status = g.check.error ? "error" : "ok";
  }
}
