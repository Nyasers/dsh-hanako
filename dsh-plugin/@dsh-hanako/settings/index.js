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
//      不再依赖 pnpm。「更新到最新」经 **dshana.bus 消息总线**（@dsh-hanako/bridge 提供
//      dshanaBus 服务）发 update.request 直投宿主（进程内 WebSocket 双向总线，替代旧的
//      POST /child/post 单向 HTTP 反向信道）触发完整更新（停 web host →
//      pnpm add @deepseek-ai/dsh latest → 起 web host），结果经总线回投
//      update.progress / update.result（v0.22.1+ 事件化：本插件订阅缓存，update-status
//      一次性查询 + update-stream 事件推送，替代前端 2s 轮询；update-result.json 读回
//      保留作兜底）。
//
// 机制（v0.9.5 正规化升级沿用）：分页为**原生渲染**——不再用 tapIndex DOM 注入，而是按
// dsh client 插件规范声明前端 client 模块（package.json dsh.client 字段 + exports["./client"]
// 指向 client.js），client 侧注册 settings.section slot（id "dshana-settings"）。设置面板
// 导航 = settings.section slot ledger 的投影（ui-settings-general 的 useSections 直接
// 读 ctx.slots.entries("settings.section")），注册即自动出现 tab，点击切换/内容渲染
// 全走 dsh 原生 React 逻辑，无任何 DOM hack。本文件只保留后端半边：路由 +
// agentDefaultModel 服务调用；前端表单逻辑见同目录 client.js。
//   POST /api/hana-settings.read            → agentDefaultModel.currentSelection()
//   POST /api/hana-settings.save            → agentDefaultModel.saveSelection(...)
//   POST /api/hana-settings.check-version   → 本地版本直读 + 远端版本 dsh 侧 HTTP 直查（npm registry）
//   POST /api/hana-settings.request-update  → 经 dshana.bus 消息总线发 update.request（触发更新）
//   POST /api/hana-settings.update-status   → 事件缓存优先 + <dataDir>/update-result.json 兜底（一次性查询）
//   GET  /api/hana-settings.update-stream   → 事件推送（SSE 式流；前端订阅，终态后关闭）
// 路由经 webServer.register（kind: exact）注册——webserver 匹配 exact 优先于 apiproxy
// 的 /api 前缀，冲突只会发生在同 (kind, path) 重复注册（插件重载未清理场景），此时
// 降级记日志不阻断。错误统一返回 { ok:false, error } 结构。
//
// config 获取：v0.22.1+ 起 patch 静态化（dsh-hanako.patch.yml，零 config 注入）——
// dshPkgDir（dsh 包安装目录）/ dataDir（宿主插件数据目录）改经 dshanaBus.getConfig() 获取
// （宿主 bus ready 后经总线 config 帧下发，bridge 缓存；check-version 读 dsh-pkg
// package.json、update-status 读 update-result.json 的路径来源）。config 未下发时
// 相关路由返回 { ok:false, error:"总线配置未就绪" }。
// 历史：v0.18.1 曾注入 npmCliPath / electronNode 供版本检查 dsh 侧 spawn pnpm view；
// v0.18.2 起版本检查改 HTTP 直查 npm registry（全局 fetch），不再需要（patch 模板已删除
// 对应占位符）；v0.22.1 起删除 hostApi 注入（/child/post 反向信道退役）与 {{DSH_PKG_DIR}}/
// {{DATA_DIR}} 占位符（改总线 config 帧下发）。
//
// 服务依赖：export const inject = ['webServer', 'agentDefaultModel', 'hanaLogger', 'dshanaBus']
// 声明依赖（cordis 服务注入经 inject 声明生效，无声明则 apply 内 ctx.webServer /
// ctx.agentDefaultModel 抛 "cannot get property ... without inject"），apply 内再经
// ctx.inject 取作用域上下文。诊断日志经 @dsh-hanako/logger 统一日志服务写入本次会话日志
// （行格式 [settings]，src 前缀不变）。
// 容错纪律：apply 全程 try/catch 不抛出——依赖缺失/路由重复只记日志，插件降级为
// 空操作，不阻断 dsh 启动（边界要求）。注释风格同 @dsh-hanako/provider（中文/单引号/无分号）。

export const name = "@dsh-hanako/settings";
export const inject = ["webServer", "agentDefaultModel", "hanaLogger", "dshanaBus"];

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

// ---- 插件 apply：路由注册（全程容错，降级不阻断 dsh 启动；前端分页见 client.js）----
export function apply(ctx, config) {
  const cfg = config && typeof config === "object" ? config : {};
  try {
    ctx.inject(
      ["webServer", "agentDefaultModel", "hanaLogger", "dshanaBus"],
      (httpCtx) => {
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

          // ---- 总线配置（v0.22.1+）：dshPkgDir/dataDir 经 dshanaBus.getConfig() 获取
          // （宿主 bus ready 后 config 帧下发，bridge 缓存）——替代旧 patch config 注入。
          // 未下发返回 null（check-version/update-status 等依赖路径的路由报
          // 「总线配置未就绪」）----
          const busConfig = () => {
            try {
              if (httpCtx.dshanaBus && typeof httpCtx.dshanaBus.getConfig === "function")
                return httpCtx.dshanaBus.getConfig();
            } catch {
              /* 配置读取失败按未下发处理 */
            }
            return null;
          };
          // 本地版本：dsh-pkg 下 @deepseek-ai/dsh 的 package.json（文件不存在 → null；
          // 零延迟直读，不经桥接；dshPkgDir 来自总线配置）
          const readLocalVersion = () => {
            try {
              const bc = busConfig();
              if (!bc || typeof bc.dshPkgDir !== "string" || !bc.dshPkgDir) return null;
              const pkgPath = join(
                bc.dshPkgDir,
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

          // ---- 更新事件缓存（v0.22.1+ 事件化）：订阅总线 update.progress / update.result
          // （宿主 updateDsh 执行期间回投），缓存最新状态供 update-status 一次性查询与
          // update-stream 事件推送——替代前端 2s 轮询 update-status。update-result.json
          // 读回保留作兜底（事件丢失/重启后文件仍在）。----
          let updateEventCache = null; // { state, version?, error?, at } | null
          const updateStreams = new Set(); // 挂起的 update-stream 响应
          const broadcastUpdateEvent = (value) => {
            const line = "data: " + JSON.stringify({ ok: true, value }) + "\n\n";
            for (const stream of updateStreams) {
              try {
                stream.res.write(line);
              } catch {
                /* 流已关闭 */
              }
            }
            if (
              value &&
              (value.state === "done" || value.state === "error")
            ) {
              // 终态：关闭所有挂起的流
              for (const stream of [...updateStreams]) {
                try {
                  stream.res.end();
                } catch {
                  /* 已结束 */
                }
              }
              updateStreams.clear();
            }
          };
          try {
            if (httpCtx.dshanaBus && typeof httpCtx.dshanaBus.on === "function") {
              disposers.push(
                httpCtx.dshanaBus.on("update.progress", (payload) => {
                  const p = payload && typeof payload === "object" ? payload : {};
                  updateEventCache = {
                    state: "updating",
                    at: p.at || new Date().toISOString(),
                  };
                  broadcastUpdateEvent(updateEventCache);
                }),
              );
              disposers.push(
                httpCtx.dshanaBus.on("update.result", (payload) => {
                  const p = payload && typeof payload === "object" ? payload : {};
                  updateEventCache = {
                    state: p.state || "error",
                    ...(typeof p.version === "string" && p.version
                      ? { version: p.version }
                      : {}),
                    ...(typeof p.error === "string" && p.error
                      ? { error: p.error }
                      : {}),
                    at: new Date().toISOString(),
                  };
                  broadcastUpdateEvent(updateEventCache);
                }),
              );
            }
          } catch {
            /* 事件订阅失败降级：update-status 走文件兜底 */
          }

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
          // dshPkgDir 来自总线配置（dshanaBus.getConfig()）；config 未下发（bus 未就绪/
          // hello 未完成）时返回 { ok:false, error:"总线配置未就绪" }。
          // 不再写 update-request.json / 读 check-result.json（v0.18.1 起废弃宿主桥接：
          // resources.watch 链路不可靠导致检查永不完成）。
          registerRoute("/api/hana-settings.check-version", async (req, res) => {
            try {
              await readJsonBody(req);
              const bc = busConfig();
              if (!bc || typeof bc.dshPkgDir !== "string" || !bc.dshPkgDir) {
                json(res, { ok: false, error: "总线配置未就绪" });
                return;
              }
              const localVersion = readLocalVersion();
              const remote = await npmViewLatest();
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

          // POST /api/hana-settings.request-update：经 dshana.bus 消息总线发
          // update.request 直投宿主（v0.22.1 起替代 POST /child/post 单向 HTTP 反向
          // 信道——/child/post 已退役）。@dsh-hanako/bridge 提供 dshanaBus 服务：
          // 握手成功（hello 通过）后 emit 即送达宿主，宿主受理后执行 npm i latest +
          // 重启 web host，执行期间/完成后经总线回投 update.progress / update.result
          // （本插件事件缓存 + update-status 一次性查询 + update-stream 事件推送）。
          // bus 未就绪（无已连接客户端）时返回 { ok:false, error:"消息总线未连接" }。
          registerRoute("/api/hana-settings.request-update", async (req, res) => {
            try {
              await readJsonBody(req);
              const bus = httpCtx.dshanaBus;
              if (!bus || typeof bus.emit !== "function") {
                throw new Error("消息总线未连接（dshanaBus 不可用）");
              }
              const st = typeof bus.status === "function" ? bus.status() : null;
              if (!st || st.connected !== true) {
                throw new Error("消息总线未连接");
              }
              // 受理确认：带 reqId 发 update.request，等宿主 update.ack（5s 超时）——
              // 避免 fire-and-forget 导致宿主未受理时前端仍误报已在更新。
              const reqId =
                "ur_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
              const acked = await new Promise((resolve) => {
                let settled = false;
                const timer = setTimeout(() => {
                  if (settled) return;
                  settled = true;
                  off();
                  resolve(false);
                }, 5000);
                const off = bus.on("update.ack", (ack) => {
                  if (settled || !ack || ack.reqId !== reqId) return;
                  settled = true;
                  clearTimeout(timer);
                  off();
                  resolve(true);
                });
                bus.emit("update.request", {
                  reqId,
                  at: new Date().toISOString(),
                  fromVersion: readLocalVersion(),
                });
              });
              if (!acked) throw new Error("宿主未受理更新请求（总线确认超时）");
              // 新轮次受理：清空事件缓存，防 update-status/update-stream 回放上一轮
              // done/error 终态（新轮次由 update.progress/result 重新填充；更新未开始
              // 前缓存为 null，update-status 走 update-result.json 文件兜底）
              updateEventCache = null;
              settingsLog("更新请求已受理，将自动执行更新");
              json(res, { ok: true, state: "updating" });
            } catch (e) {
              try {
                settingsLog(`更新请求失败：${e?.message || e}`);
              } catch {
                /* 日志失败不阻断 */
              }
              json(res, { ok: false, error: e?.message || String(e) });
            }
          });

          // POST /api/hana-settings.update-status：一次性查询——事件缓存优先（事件化主信道，
          // v0.22.1+ 替代前端 2s 轮询），无缓存读 update-result.json 兜底（文件不存在 → idle；
          // 解析失败 → idle）。dataDir 来自总线配置；config 未下发时报「总线配置未就绪」。
          registerRoute("/api/hana-settings.update-status", async (req, res) => {
            try {
              await readJsonBody(req);
              const bc = busConfig();
              if (!bc || typeof bc.dataDir !== "string" || !bc.dataDir) {
                json(res, { ok: false, error: "总线配置未就绪" });
                return;
              }
              if (updateEventCache) {
                json(res, { ok: true, value: updateEventCache });
                return;
              }
              const f = join(bc.dataDir, "update-result.json");
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

          // GET /api/hana-settings.update-stream：事件推送（SSE 式流）——更新期间前端订阅
          // （fetch 流式读取），收到 update.progress/result 事件即推，终态（done/error）后
          // 关闭。首帧回放当前缓存（若已有事件）；事件缺失时前端可手动刷新（update-status
          // 兜底）。路由挂起期间前端关闭/断连时自动清理。
          registerRoute("/api/hana-settings.update-stream", (req, res) => {
            try {
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              });
              // 首帧回放当前缓存（若已有事件）
              if (updateEventCache) {
                res.write(
                  "data: " + JSON.stringify({ ok: true, value: updateEventCache }) + "\n\n",
                );
                if (
                  updateEventCache.state === "done" ||
                  updateEventCache.state === "error"
                ) {
                  res.end();
                  return;
                }
              }
              const stream = { res };
              updateStreams.add(stream);
              const onClose = () => {
                updateStreams.delete(stream);
              };
              res.on("close", onClose);
              res.on("error", onClose);
            } catch (e) {
              try {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: false, error: e?.message || String(e) }));
              } catch {
                /* 响应已不可写 */
              }
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
