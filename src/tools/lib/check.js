// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/check.js — DSH 版本检查共用模块（lib 提取）
// 从 tools/dsh-run.js 剥离：npmViewLatest（spawn npm view 查远端版本）+ checkDshUpdate
// （本地版本 + 远端版本 → { localVersion, latestVersion, updateAvailable, error? }）。
// 依赖 lib/install.js 的 verifyDepsSmoke 缓存（g.depsSmoke）+ 本地版本直读
// （readDshInstalledVersion）+ semver 比较（compareSemver）；状态经 lib/state.js
// getSingleton 访问（g.checking / g.checkResult / g.checkAt）。
// 消费方：dsh-run.js（挂单例 g.checkDshUpdate）、tools/dsh-update.js、routes/webui.js
// （/webui/check-update）、dsh 设置页桥接（ensureUpdateWatch → 本函数）。
//
// 容错纪律：npm view 全败只置 error 字段不抛（调用方按需降级）；写 check-result.json
// 失败只 warn 不阻断。注释风格保持宿主侧（中文/双引号/分号）。

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSingleton, PLUGIN_ROOT, ELECTRON_NODE } from "./state.js";
import { readDshInstalledVersion, compareSemver } from "./install.js";

// spawn npm view @deepseek-ai/dsh version（15s 超时 kill；官方源失败重试一次 npmmirror；
// 仍失败 → { version:null, error }）。npm-cli.js 来自插件安装目录 node_modules/npm
// （与 installDepsFromPlugin 同一来源）；spawn 目标 = 宿主 electron node。
function npmViewLatest() {
  const npmCli = join(PLUGIN_ROOT, "node_modules", "npm", "bin", "npm-cli.js");
  const run = (registryArgs) => {
    return new Promise((resolve) => {
      let child = null;
      try {
        child = spawn(
          ELECTRON_NODE,
          [npmCli, "view", "@deepseek-ai/dsh", "version", ...registryArgs],
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
      } catch (e) {
        resolve({ ok: false, error: e?.message || String(e) });
        return;
      }
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => {
        out = (out + String(d)).slice(-800);
      });
      child.stderr.on("data", (d) => {
        err = (err + String(d)).slice(-800);
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
      }, 15000);
      child.once("close", (code) => {
        clearTimeout(timer);
        const version = out.trim();
        if (code === 0 && version) resolve({ ok: true, version });
        else
          resolve({
            ok: false,
            error: (err || out || `退出码 ${code}`).trim().slice(0, 300),
          });
      });
    });
  };
  return (async () => {
    try {
      const first = await run([]);
      if (first.ok) return { version: first.version, error: null };
      const second = await run(["--registry=https://registry.npmmirror.com"]);
      if (second.ok) return { version: second.version, error: null };
      return {
        version: null,
        error: second.error || first.error || "查询失败",
      };
    } catch (e) {
      return { version: null, error: e?.message || String(e) };
    }
  })();
}

// ---- 检查 DSH 更新（能力层）：本地版本 + 远端版本 → { localVersion, latestVersion,
// updateAvailable, error? }。并发防护：g.checking 进行中返回上次结果 + running 标志。
// 结果写 <dataDir>/check-result.json（桥接文件，dsh 设置页 check-version 路由读它；
// 附带 at 时间戳供新鲜度比较）。失败（npm view 全败）只置 error 字段不抛。----
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
  // 会话日志（src=hana）：开始/完成 里程碑——故障诊断（npm view 失败、版本比较异常、
  // 设置页/标签页/Agent 三路触发）在会话日志里有完整上下文（本地版本来源 + 远端查询
  // 结果 + 错误）。失败不抛（容错纪律：npm view 全败只置 error 字段）。
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
    // 写桥接结果文件（dsh 设置页 check-version 路由读；at = 结果时间戳供新鲜度比较）
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        join(dataDir, "check-result.json"),
        JSON.stringify({ ...result, at: new Date().toISOString() }),
        "utf8",
      );
    } catch (e) {
      console.warn(
        `[dsh-run] check-result.json 写入失败（${e?.message || e}）`,
      );
    }
    console.log(
      `[dsh-run] 版本检查：本地 ${localVersion || "未安装"} / 远端 ${latestVersion || "查询失败"}${updateAvailable ? "（可更新）" : ""}`,
    );
    return result;
  } finally {
    g.checking = false;
  }
}
