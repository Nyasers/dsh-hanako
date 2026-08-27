// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/check.js — DSH 版本检查共用模块（lib 提取）
// 从 tools/dsh-run.js 剥离：npmViewLatest（HTTP 直查 npm registry 查远端版本）+ checkDshUpdate
// （本地版本 + 远端版本 → { localVersion, latestVersion, updateAvailable, error? }）。
// 依赖 lib/install.js 的 verifyDepsSmoke 缓存（g.depsSmoke）+ 本地版本直读
// （readDshInstalledVersion）+ semver 比较（compareSemver）；状态经 lib/state.js
// getSingleton 访问（g.checking / g.checkResult / g.checkAt）。
// 消费方：dsh-run.js（挂单例 g.checkDshUpdate）、tools/dsh-update.js、routes/webui.js
// （/webui/check-update）。dsh 设置页「DSH 版本」卡片 v0.18.1 起由 dsh 侧
// @dsh-hanako/settings 内嵌直查远端（同款 HTTP 直查 npm registry），不再经本函数桥接。
//
// 容错纪律：远端版本查询全败只置 error 字段不抛（调用方按需降级）；结果只缓存
// g.checkResult（内存，不再写 check-result.json 桥接文件——v0.18.1 起设置页检查
// 改 dsh 侧直查，无跨进程读回需求）。注释风格保持宿主侧（中文/双引号/分号）。

import { getSingleton } from "./state.js";
import { readDshInstalledVersion, compareSemver } from "./install.js";

// HTTP 直查 npm registry（v0.18.2 起替代 spawn pnpm view——pnpm view 的本质就是查
// registry 的 latest dist-tag：fetch https://registry.npmjs.org/@deepseek-ai/dsh/latest
// 的 JSON version 字段；官方源失败重试一次 https://registry.npmmirror.com/@deepseek-ai/dsh/latest；
// 15s 超时 AbortSignal.timeout；仍失败 → { version:null, error }（调用方按需降级，不抛）。
// HTTP 能力：宿主 node v24 全局 fetch 可用，零运行时依赖。不再依赖 pnpm 引导
// （ensurePnpm/runPnpm 由 lib/install.js 的 installDepsFromPlugin 继续使用，此处退出）。
async function npmViewLatest() {
  const fetchJson = async (url) => {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { "user-agent": "dsh-hanako-plugin" },
      });
      if (!res.ok) return { ok: false, error: "HTTP " + res.status + "：" + url };
      const data = await res.json();
      const version =
        data && typeof data.version === "string" ? data.version.trim() : "";
      if (!version) return { ok: false, error: "响应缺少 version 字段：" + url };
      return { ok: true, version };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  };
  try {
    const first = await fetchJson(
      "https://registry.npmjs.org/@deepseek-ai/dsh/latest",
    );
    if (first.ok) return { version: first.version, error: null };
    const second = await fetchJson(
      "https://registry.npmmirror.com/@deepseek-ai/dsh/latest",
    );
    if (second.ok) return { version: second.version, error: null };
    return { version: null, error: second.error || first.error || "查询失败" };
  } catch (e) {
    return { version: null, error: e?.message || String(e) };
  }
}

// ---- 检查 DSH 更新（能力层）：本地版本 + 远端版本 → { localVersion, latestVersion,
// updateAvailable, error? }。并发防护：g.checking 进行中返回上次结果 + running 标志。
// 结果缓存 g.checkResult / g.checkAt（内存，供 dsh_update 工具与 /webui/check-update
// 直读返回值；不再写 check-result.json——v0.18.1 起设置页检查改 dsh 侧直查）。
// 失败（远端查询全败）只置 error 字段不抛。----
export async function checkDshUpdate(cfg) {
  const g = getSingleton();
  if (g.checking) {
    return {
      ...(g.checkResult || {
        localVersion: null,
        latestVersion: null,
        updateAvailable: false,
      }),
      running: true,
    };
  }
  g.checking = true;
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
    const smoke = g.depsSmoke;
    const fromSmoke = !!(smoke && !smoke.running && smoke.ok);
    let localVersion = fromSmoke ? smoke.version : null;
    if (!localVersion) localVersion = readDshInstalledVersion(diagCfg);
    slog(
      `开始（本地=${localVersion || "未安装"}，来源=${fromSmoke ? "运行级验证缓存" : "直读 dsh-pkg package.json"}）`,
    );
    const remote = await npmViewLatest();
    const latestVersion = remote.version;
    const updateAvailable = !!(
      localVersion &&
      latestVersion &&
      compareSemver(localVersion, latestVersion) < 0
    );
    const result = { localVersion, latestVersion, updateAvailable };
    if (remote.error) result.error = remote.error;
    slog(
      `完成（本地=${localVersion || "未安装"}，远端=${latestVersion || "查询失败"}${remote.error ? "，" + remote.error : ""}${updateAvailable ? "，可更新" : ""}）`,
    );
    g.checkResult = result;
    g.checkAt = Date.now();
    console.log(
      `[dsh-run] 版本检查：本地 ${localVersion || "未安装"} / 远端 ${latestVersion || "查询失败"}${updateAvailable ? "（可更新）" : ""}`,
    );
    return result;
  } finally {
    g.checking = false;
  }
}
