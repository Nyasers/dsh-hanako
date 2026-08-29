// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/settings — 在 dsh Web UI 设置页提供「DSHana 设置」分页（v0.13.0 由
// default-model 插件改名升级；v0.18.1 统一收敛 @dsh-hanako scope，版本检查改 dsh 侧直查）。
//
// 语义：dsh 的 agent-default-model（settings.yaml）是任务默认模型的事实源，dsh_run
// 不显式指定时用它。dsh 设置页没有该段的配置 UI（settings.mutate 对 agent-default-model
// 段不可用——"not exposed to configuration clients"；saveDefaultModelSelection 也不是
// 独立 RPC，只在 dsh 的 session.selectModel 内部自动写回默认）。本插件补一个显式入口：
// 设置页新增「DSHana 设置」分页，面板内容 = 设置中心式布局（v0.13.0 UI 重排：
// 页头 DSHana 品牌区 + 两个并列分组卡片，不再是「默认模型表单 + 版本块」硬堆叠）：
//   ① 默认模型卡片：三级联动表单，选项 = dsh 全部可用 provider（llm.models RPC，含宿主
//      注入的 sensenova/agnes/deepseek 与 dsh 单独配置的 deepseek-official 等），
//      provider → model → 思考强度（reasoning.efforts，无 reasoning 的模型不显示思考
//      下拉），保存即经 agentDefaultModel 服务写 settings.yaml + 更新内存态。
//   ② DSH 版本卡片：@deepseek-ai/dsh 版本检查与更新。本地版本 dsh 侧直读 dsh-pkg
//      package.json（零延迟，挂载即显示）；远端版本 **dsh 侧直查**（v0.18.1 起不再走
//      宿主桥接——宿主 resources.watch 链路不可靠，曾致检查请求写入后无人消费、前端
//      永久 pending）：HTTP 直查 npm registry
//      `https://registry.npmjs.org/@deepseek-ai/dsh/latest`（JSON 的 version 字段，
//      pnpm view 语义等价；官方源失败重试一次 npmmirror，15s 超时），结果即最新版本，
//      不再依赖 pnpm。「更新到最新」仍写 { state:'requested' } 到
//      <dataDir> 经宿主反向信道直投（/child/post，loopbackToken 凭据）触发完整更新（停 web host →
//      pnpm add @deepseek-ai/dsh latest → 起 web host），结果写
//      <dataDir>/update-result.json，本插件 update-status 路由读它供前端轮询。
//
// 机制（v0.9.5 正规化升级沿用）：分页为**原生渲染**——不再用 tapIndex DOM 注入，而是按
// dsh client 插件规范声明前端 client 模块（package.json dsh.client 字段 + exports["./client"]
// 指向 client.js），client 侧注册 settings.section slot（id "dshana-settings"）。设置面板
// 导航 = settings.section slot ledger 的投影（ui-settings-general 的 useSections 直接
// 读 ctx.slots.entries("settings.section")），注册即自动出现 tab，点击切换/内容渲染
// 全走 dsh 原生 React 逻辑，无任何 DOM hack。本文件只保留后端半边：五条路由 +
// agentDefaultModel 服务调用；前端表单逻辑见同目录 client.js。
//   POST /api/hana-settings.read            → agentDefaultModel.currentSelection()
//   POST /api/hana-settings.save            → agentDefaultModel.saveSelection(...)
//   POST /api/hana-settings.check-version   → 本地版本直读 + 远端版本 dsh 侧 HTTP 直查（npm registry）
//   POST /api/hana-settings.request-update  → 直投宿主反向信道（/child/post，触发更新）
//   POST /api/hana-settings.update-status   → 读 <dataDir>/update-result.json（更新进度/结果）
// 路由经 webServer.register（kind: exact）注册——webserver 匹配 exact 优先于 apiproxy
// 的 /api 前缀，冲突只会发生在同 (kind, path) 重复注册（插件重载未清理场景），此时
// 降级记日志不阻断。错误统一返回 { ok:false, error } 结构。
//
// config 注入：dshPkgDir（dsh 包安装目录）、dataDir（宿主插件数据目录）——由宿主 patch
// 模板渲染（{{DSH_PKG_DIR}}/{{DATA_DIR}}，见 dsh-hanako.patch.yml.tpl / src/lifecycle.js）。
// v0.18.1 曾注入 npmCliPath / electronNode 供版本检查 dsh 侧 spawn pnpm view；v0.18.2 起
// 版本检查改 HTTP 直查 npm registry（全局 fetch），不再需要（patch 模板已删除对应占位符）。
//
// 服务依赖：export const inject = ['webServer', 'agentDefaultModel', 'hanaLogger'] 声明依赖
// （cordis 服务注入经 inject 声明生效，无声明则 apply 内 ctx.webServer /
// ctx.agentDefaultModel 抛 "cannot get property ... without inject"），apply 内再经
// ctx.inject 取作用域上下文。诊断日志经 @dsh-hanako/logger 统一日志服务写入本次会话日志
// （行格式 [settings]，src 前缀不变）。
// 容错纪律：apply 全程 try/catch 不抛出——依赖缺失/路由重复只记日志，插件降级为
// 空操作，不阻断 dsh 启动（边界要求）。注释风格同 @dsh-hanako/provider（中文/单引号/无分号）。

export const name = "@dsh-hanako/settings";
export const inject = ["webServer", "agentDefaultModel", "hanaLogger"];

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---- 读请求 body（JSON）----
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        req.destroy(new Error("body 过大"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("body 不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

// ---- 写 JSON 响应 ----
function json(res, body) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

// ---- 零依赖 semver 比较（major.minor.patch 三段数字逐个比；预发布 -rc.x 视为低于同版本正式版）----
// pre 字段：null 表示正式版（无预发布后缀）；对象 { kind, num } 表示预发布。
//   kind="rc" 且 num 为 rc 序号（如 "0.1.0-rc.6" → { kind:"rc", num:6 }）；
//   其余非数字预发布后缀（如 "-beta"、"-alpha"）kind="pre"、num=0（视为更旧）。
function parseVersion(v) {
  const s = String(v || "").trim();
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)([\s\S]*)$/);
  if (!m) return null;
  const tail = m[4];
  let pre = null;
  if (tail) {
    const rc = tail.match(/^-rc\.(\d+)/i);
    pre = rc ? { kind: "rc", num: Number(rc[1]) } : { kind: "pre", num: 0 };
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre,
  };
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  // 三段相同
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  if (pa.pre.num !== pb.pre.num) return pa.pre.num < pb.pre.num ? -1 : 1;
  return 0;
}

// ---- 远端版本直查（HTTP 直查 npm registry；语义与宿主 lib/check.js npmViewLatest 一致）----
// pnpm view @deepseek-ai/dsh version 的本质就是查 npm registry 的 latest dist-tag——
// 直接 fetch https://registry.npmjs.org/@deepseek-ai/dsh/latest 的 JSON version 字段
// （官方源失败重试一次 https://registry.npmmirror.com/@deepseek-ai/dsh/latest），15s
// 超时（AbortSignal.timeout）。仍失败返回 { version:null, error }（调用方按需降级，不抛）。
// HTTP 能力：dsh web host 运行在宿主 node v24（全局 fetch 可用），零运行时依赖；
// 不再 spawn 宿主 electron node + pnpm 入口（config 注入字段 electronNode / npmCliPath
// 已随 patch 模板占位符删除）。
async function npmViewLatest(cfg) {
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

// ---- 插件 apply：路由注册（全程容错，降级不阻断 dsh 启动；前端分页见 client.js）----
export function apply(ctx, config) {
  const cfg = config && typeof config === "object" ? config : {};
  try {
    ctx.inject(["webServer", "agentDefaultModel", "hanaLogger"], (httpCtx) => {
      httpCtx.effect(() => {
        const disposers = [];
        const settingsLog = (msg) => {
          try {
            httpCtx.hanaLogger.log("settings", msg);
          } catch {
            /* 日志失败不阻断 */
          }
        };
        const registerRoute = (path, handler) => {
          try {
            disposers.push(
              httpCtx.webServer.register({ kind: "exact", path, handler }),
            );
          } catch (e) {
            // 重复注册（插件重载未清理）：降级记日志，不阻断
            settingsLog(`路由 ${path} 注册失败：${e?.message || e}`);
            try {
              ctx.logger?.warn?.(
                `[@dsh-hanako/settings] 路由 ${path} 注册失败：${e?.message || e}`,
              );
            } catch {
              /* 日志失败不阻断 */
            }
          }
        };

        // 本地版本：dsh-pkg 下 @deepseek-ai/dsh 的 package.json（文件不存在 → null；
        // 零延迟直读，不经桥接）
        const readLocalVersion = () => {
          try {
            const pkgPath = join(
              cfg.dshPkgDir || "",
              "node_modules",
              "@deepseek-ai",
              "dsh",
              "package.json",
            );
            if (!existsSync(pkgPath)) return null;
            const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
            return pkg && typeof pkg.version === "string" && pkg.version
              ? pkg.version
              : null;
          } catch (e) {
            settingsLog(`本地版本读取失败：${e?.message || e}`);
            return null;
          }
        };

        // POST /api/hana-settings.read：返回当前默认（{ provider, model, reasoningEffort? }）
        registerRoute("/api/hana-settings.read", async (req, res) => {
          try {
            await readJsonBody(req);
            const value = httpCtx.agentDefaultModel.currentSelection();
            json(res, { ok: true, value });
          } catch (e) {
            json(res, { ok: false, error: e?.message || String(e) });
          }
        });

        // POST /api/hana-settings.save：保存默认（reasoningEffort 空/缺省 = 不传）
        registerRoute("/api/hana-settings.save", async (req, res) => {
          try {
            const body = await readJsonBody(req);
            const provider =
              typeof body?.provider === "string" ? body.provider : "";
            const model = typeof body?.model === "string" ? body.model : "";
            const reasoningEffort =
              typeof body?.reasoningEffort === "string" && body.reasoningEffort
                ? body.reasoningEffort
                : "";
            if (!provider || !model) {
              json(res, { ok: false, error: "provider 与 model 不能为空" });
              return;
            }
            await httpCtx.agentDefaultModel.saveSelection({
              provider,
              model,
              ...(reasoningEffort ? { reasoningEffort } : {}),
            });
            settingsLog(
              `默认模型已保存：${provider} / ${model}${reasoningEffort ? " / " + reasoningEffort : ""}`,
            );
            json(res, { ok: true });
          } catch (e) {
            try {
              settingsLog(`默认模型保存失败：${e?.message || e}`);
            } catch {
              /* 日志失败不阻断（防二次抛错挂起响应） */
            }
            json(res, { ok: false, error: e?.message || String(e) });
          }
        });

        // POST /api/hana-settings.check-version：本地版本直读（零延迟）+ 远端版本
        // dsh 侧 HTTP 直查——fetch https://registry.npmjs.org/@deepseek-ai/dsh/latest
        // 的 JSON version 字段（pnpm view 语义等价；官方源失败重试 npmmirror，15s 超时），
        // 响应 { ok:true, value:{ localVersion, latestVersion, updateAvailable, error? } }。
        // 不再写 update-request.json / 读 check-result.json（v0.18.1 起废弃宿主桥接：
        // resources.watch 链路不可靠导致检查永不完成）。
        registerRoute("/api/hana-settings.check-version", async (req, res) => {
          try {
            await readJsonBody(req);
            const localVersion = readLocalVersion();
            const remote = await npmViewLatest(cfg);
            const latestVersion = remote.version;
            const updateAvailable = !!(
              localVersion &&
              latestVersion &&
              compareVersions(localVersion, latestVersion) < 0
            );
            const value = { localVersion, latestVersion, updateAvailable };
            if (remote.error) value.error = remote.error;
            settingsLog(
              `版本检查完成（本地=${localVersion || "未安装"}，远端=${latestVersion || "查询失败"}${remote.error ? "，" + remote.error : ""}${updateAvailable ? "，可更新" : ""}）`,
            );
            json(res, { ok: true, value });
          } catch (e) {
            json(res, { ok: false, error: e?.message || String(e) });
          }
        });

        // POST /api/hana-settings.request-update：经子插件反向信道直投宿主
        // （v0.21.2 起替代 update-request.json 文件桥——宿主侧无轮询、无文件）。
        // 宿主 POST /child/post 受理后执行 npm i latest + 重启 web host，结果写
        // update-result.json（本插件 update-status 路由读）。hostApi 由宿主 patch
        // 注入（server-info.json 的 loopbackToken + 端口，过宿主鉴权墙）。
        registerRoute("/api/hana-settings.request-update", async (req, res) => {
          try {
            await readJsonBody(req);
            const hostApi = cfg.hostApi;
            if (
              !hostApi ||
              typeof hostApi.url !== "string" ||
              typeof hostApi.token !== "string"
            ) {
              throw new Error("宿主反向信道未配置（hostApi 缺失）");
            }
            const url =
              hostApi.url +
              (hostApi.url.includes("?") ? "&" : "?") +
              "token=" +
              encodeURIComponent(hostApi.token);
            const r = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                channel: "dsh.update-request",
                payload: {
                  at: new Date().toISOString(),
                  fromVersion: readLocalVersion(),
                },
              }),
              signal: AbortSignal.timeout(5000),
            });
            let data = null;
            try {
              data = await r.json();
            } catch {
              throw new Error(`宿主响应非 JSON（HTTP ${r.status}）`);
            }
            if (!r.ok) {
              throw new Error(
                (data && typeof data === "object" && data.error) ||
                  `宿主投递失败（HTTP ${r.status}）`,
              );
            }
            if (!data || typeof data !== "object" || data.ok !== true) {
              throw new Error(
                (data && typeof data === "object" && data.error) ||
                  `宿主响应缺少 ok:true（HTTP ${r.status}）`,
              );
            }
            settingsLog("更新请求已直投宿主（/child/post），将自动执行更新");
            json(res, { ok: true, ...data });
          } catch (e) {
            try {
              settingsLog(`更新请求失败：${e?.message || e}`);
            } catch {
              /* 日志失败不阻断 */
            }
            json(res, { ok: false, error: e?.message || String(e) });
          }
        });

        // POST /api/hana-settings.update-status：读更新结果文件（不存在 → idle；解析失败 → idle）
        registerRoute("/api/hana-settings.update-status", async (req, res) => {
          try {
            await readJsonBody(req);
            const f = join(cfg.dataDir || "", "update-result.json");
            if (!existsSync(f)) {
              json(res, { ok: true, value: { state: "idle" } });
              return;
            }
            let value = null;
            try {
              value = JSON.parse(readFileSync(f, "utf8"));
            } catch (e) {
              // 解析失败（写入中/损坏）：视为 idle，不阻断
              settingsLog(`update-result.json 解析失败：${e?.message || e}`);
              json(res, { ok: true, value: { state: "idle" } });
              return;
            }
            json(res, { ok: true, value });
          } catch (e) {
            json(res, { ok: false, error: e?.message || String(e) });
          }
        });

        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* 清理失败不阻断 */
            }
          }
        };
      });
    });
  } catch (e) {
    try {
      ctx.logger?.warn?.(`[@dsh-hanako/settings] 插件停用：${e?.message || e}`);
    } catch {
      /* 日志失败不阻断 */
    }
  }
}
