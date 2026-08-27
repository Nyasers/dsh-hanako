// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// routes/webui.js — dsh-hanako 插件页：Hana 顶部 tab 内嵌 dsh Web UI
//   GET /webui            插件页（iframe 嵌 http://127.0.0.1:<port>/，含就绪探测/主题注入/失败自检）
//   GET /webui/health     轻量就绪探测（浏览器端 3s 重试轮询源；Node fetch 无 CORS 问题；
//                         未就绪时附带 diagnostics 字段供页面渲染自检）
//   POST /webui/start        手动启动 web host（process 卡片「手动启动」按钮；ready/starting/触发启动三态）
//   POST /webui/install-deps 自动安装 dsh 依赖（deps 卡片「安装依赖」按钮；installing/触发安装）
//   GET  /webui/verify-deps  运行级依赖检测（node cliBin --version；进标签页自动一次 + 手动「检测依赖」按钮）
//   GET  /webui/check-update 版本检查（经宿主能力层 g.checkDshUpdate；deps 卡片「检查更新」
//                            按钮已移除——版本管理归设置页「检查与更新 DSH」卡片 + dsh_update 工具，路由保留）
//   POST /webui/update-dsh   更新 DSH（经宿主能力层 g.updateDsh，异步触发，更新会重启
//                            web host、正在执行的任务中断；deps 卡片「更新 DSH」按钮已移除，
//                            入口归设置页 dsh_update 工具，路由保留）
//
// 机制：与 routes/card.js 同构——宿主把 app 挂在 /api/plugins/<pluginId> 命名空间下，
// 这里注册相对路径。渲染前服务端用 Node fetch 探测 dsh web host 的 /api/host.describe
// （1.5s 超时，低延迟不拖慢页面）；就绪则直接渲染 iframe，未就绪渲染提示区并让浏览器
// 每 3s 轮询本插件的 /webui/health，就绪后动态挂载 iframe。脚本首行 postMessage ready
// 是宿主原始握手（参照 PLUGINS.md；插件 bundle 不含 @hana/plugin-sdk，不依赖它）。
//
// 连接失败自检：web host 未就绪时逐项检查 ① nodejs 配置 ② dsh 依赖
// ③ DSH 进程状态，明确指出哪一项坏了、为什么、怎么修。诊断由服务端收集（Node 侧
// 才能读 config.json、进程单例与 fs 状态；浏览器 iframe 读不到插件进程）——收集函数
// 挂在 globalThis 单例（tools/dsh-run.js 的 collectDiagnostics），这里经单例调用而
// 非静态 import：Hana 以 ?t= 时间戳加载 tools 模块，静态 import 会命中 Node ESM 固定
// URL 缓存读到旧模块（见 tools/dsh-run.js 头部注释），与 index.js 经单例取 closeProcess
// 同一套纪律。工具模块未加载（冷启动窗口）时单例函数缺失，返回 null 由轮询补上。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
// 插件页 HTML 壳（构建期 template-loader 经 doT 编译为自包含渲染函数，运行时零依赖）
import { render as webuiShellHtml } from "../assets/webui-shell.jinja2";


function esc(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 探测 dsh web host 是否就绪（host.describe RPC，1.5s 超时；任何失败视为未就绪） */
async function probeHost(port, log) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/host.describe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: "probe",
        method: "host.describe",
        payload: {},
      }),
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch (e) {
    log?.warn?.(
      `[dsh-hanako] probeHost 失败（port ${port}）：${e?.message || e}`,
    );
    return false;
  }
}

/** 读连接失败自检（服务端收集：config.json + 单例 + fs；经单例调用 tools 的收集函数）。
 * 工具模块未加载（冷启动窗口）时返回 null，页面先渲染占位，轮询刷新后填充。
 * 只回布尔与截断文本（不返回凭据）；stderr 尾部在收集端已截断 ≤800。 */
function readDiagnostics(ctx, cfg, port) {
  const g = globalThis.__dshHanako;
  if (g && typeof g.collectDiagnostics === "function") {
    try {
      return g.collectDiagnostics({ dataDir: ctx?.dataDir, webPort: port });
    } catch (e) {
      ctx.log?.warn?.(
        "[dsh-hanako] 收集连接自检失败:",
        e?.message || String(e),
      );
      return null;
    }
  }
  return null;
}

/** 插件页 HTML 壳：ready=true 直接内联 iframe；否则提示区（标题 + 自检列表 + 重试）+ 轮询 health 后动态挂载
 * colorScheme：按宿主 hana-theme 映射的 color-scheme（dark/light）。dsh 主题为
 * system 时通过 prefers-color-scheme 解析，Chromium 会让跨源 iframe 继承父页面
 * 的 color-scheme，因此 dsh 会跟随宿主主题；dsh 内显式选了 light/dark 则不受影响。
 * diagnostics：未就绪时服务端收集的首帧自检数据（JSON 对象或 null）；浏览器端
 * 渲染进提示区，并在每次 health 轮询未就绪时用新 diagnostics 刷新。 */
function buildShell({
  ready,
  hcLink,
  theme,
  api,
  port,
  colorScheme,
  diagnostics,
}) {
  // dsh-frame 保持裸嵌（曾尝试显式声明 sandbox/allow 绕过宿主沙箱，实测跨源继承链
  // 下内层声明无法生效，属无效方案已回滚，见 CHANGELOG）。
  // 剪贴板问题的正规解法是 @dsh-hanako/clipboard 插件（tapIndex 注入桥 → 宿主 capability）
  // + 下方壳页面桥（hostRequest + __dshCopy 监听）。
  const iframe = ready
    ? `<iframe id="dsh-frame" src="http://127.0.0.1:${port}/"></iframe>`
    : `<iframe id="dsh-frame"></iframe>`;
  // 嵌入首帧自检 JSON：把 </ 转义成 <\/，防诊断文本（路径/stderr）里的 </script> 提前闭合脚本
  const initDiag = diagnostics
    ? JSON.stringify(diagnostics).replace(/<\//g, "<\\/")
    : "null";
  // HTML 模板来自 src/assets/webui-shell.jinja2（asset/source 内联，占位符保留）；
  // 渲染函数由 template-loader 在构建期生成（doT），scope 直接作 it 传入。
  return webuiShellHtml({
    colorScheme,
    hcLink,
    esc,
    theme,
    ready,
    iframe,
    api,
    initDiag,
    port,
  });
}

export default function registerWebuiRoutes(app, ctx) {
  const base = "/api/plugins/" + ctx.pluginId;
  // 端口：manifest 默认 + 用户配置合并后的 ctx.config；非对象容错回退 3080
  const cfg =
    ctx && typeof ctx.config === "object" && ctx.config ? ctx.config : {};
  const port = Number(cfg.webPort) || 3080;

  // 插件页：服务端先探测 host，就绪直接渲染 iframe；未就绪给提示（含自检诊断）+ 浏览器端轮询
  app.get("/webui", async (c) => {
    const ready = await probeHost(port, ctx.log);
    const hc = c.req.query("hana-css") || "";
    const th = c.req.query("hana-theme") || "inherit";
    const hcLink = hc ? `<link rel="stylesheet" href="${esc(hc)}">` : "";
    // 宿主深色主题（midnight/dark 等）→ iframe 内 prefers-color-scheme dark，dsh 的 system 跟随宿主
    const colorScheme = /midnight|dark/i.test(th) ? "dark" : "light";
    // 未就绪时服务端同步收集一次自检（首屏即渲染，轮询再刷新）；就绪不收集保持轻量
    const diagnostics = ready ? null : readDiagnostics(ctx, cfg, port);
    return c.html(
      buildShell({
        ready,
        hcLink,
        theme: th,
        api: base,
        port,
        colorScheme,
        diagnostics,
      }),
    );
  });

  // 轻量就绪探测端点（浏览器端重试轮询复用同一探测逻辑；恒附带自检诊断字段——
  // 就绪时也带：前端就绪态低频兜底探测需感知 deps 的更新/安装进行中状态（避免
  // 更新/安装触发瞬间的页面跳变），未就绪时供排障。diagnostics 为 null 时下一轮补上）
  app.get("/webui/health", async (c) => {
    const ready = await probeHost(port, ctx.log);
    const body = { ok: ready, port, timestamp: Date.now() };
    body.diagnostics = readDiagnostics(ctx, cfg, port);
    return c.json(body);
  });

  // 手动启动 web host（process 卡片「手动启动」按钮调用）：读单例按当前状态返回——
  // 已就绪 → ready；启动中（readyPromise 挂起）→ starting；否则异步触发
  // g.startWebHost(ctx.config, dataDir)（不 await 其就绪，页面靠轮询检测）→ starting。
  // 单例缺失/无函数/异常一律容错回 {ok:false}，本路由不抛异常。
  app.post("/webui/start", (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.startWebHost !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.web?.ready) return c.json({ ok: true, state: "ready" });
      if (g.web?.readyPromise) return c.json({ ok: true, state: "starting" });
      // 异步触发（startWebHostFromPlugin 内部已 try/catch 记 webLastError 返回布尔；
      // 这里再 .catch 兜底——路由不等待就绪、不抛异常）。dataDir 缺省用单例记录值，
      // 避免路由 ctx 无 dataDir 时误落 PLUGIN_ROOT/data。
      Promise.resolve(
        g.startWebHost(ctx.config, ctx.dataDir || g.dataDir),
      ).catch(() => {});
      return c.json({ ok: true, state: "starting" });
    } catch (e) {
      ctx.log?.warn?.(
        "[dsh-hanako] 手动启动 web host 失败:",
        e?.message || String(e),
      );
      return c.json({ ok: false, error: "启动请求失败，请稍后重试" });
    }
  });

  // 自动安装 dsh 依赖（deps 卡片「安装依赖」按钮调用）：读单例按状态返回——
  // 部署中（g.depsInstalling）→ {ok:true,state:"installing"}；否则异步触发
  // g.installDeps(ctx.config, dataDir)（不 await 其完成，页面靠轮询诊断刷新）→ installing。
  // 单例缺失/无函数/异常一律容错回 {ok:false}，本路由不抛异常。
  app.post("/webui/install-deps", (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.installDeps !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.depsInstalling) return c.json({ ok: true, state: "installing" });
      // 异步触发（installDepsFromPlugin 内部已 try/catch 记 depsInstallError 返回结果；
      // 这里再 .catch 兜底——路由不等待完成、不抛异常）。dataDir 缺省用单例记录值。
      Promise.resolve(
        g.installDeps(ctx.config, ctx.dataDir || g.dataDir),
      ).catch(() => {});
      return c.json({ ok: true, state: "installing" });
    } catch (e) {
      ctx.log?.warn?.(
        "[dsh-hanako] 自动安装依赖失败:",
        e?.message || String(e),
      );
      return c.json({ ok: false, error: "安装请求失败，请稍后重试" });
    }
  });

  // 运行级依赖检测（deps 卡片「检测依赖」按钮 + 进标签页自动一次；GET 只读）：
  // 检测中（g.depsSmoke.running）→ {ok:true,running:true}；否则 await verifyDepsSmoke(cfg)
  // （dsh 冒烟 ≤10s + pnpm 引导检查并行；自愈下载可能更久）→
  // {ok:true, verified, version, error, running:false, pnpmReady, pnpmVersion, pnpmError}。
  // pnpm 引导状态为独立子项（不进 verified 判定）：未就绪时 pnpmError 为原因，自愈
  // 路径（缺缓存自动重下）恢复就绪。结果写入 g.depsSmoke，前端随后经 health 读取
  // 诊断刷新 deps 卡片。单例缺失/无函数/异常一律容错回 {ok:false}。
  app.get("/webui/verify-deps", async (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.verifyDeps !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.depsSmoke?.running) return c.json({ ok: true, running: true });
      const smoke = await g.verifyDeps({
        dataDir: ctx.dataDir || g.dataDir,
        webPort: port,
      });
      return c.json({
        ok: true,
        running: false,
        verified: smoke.ok,
        version: smoke.version,
        error: smoke.error || null,
        pnpmReady: smoke.pnpmReady === true,
        pnpmVersion: smoke.pnpmVersion || null,
        pnpmError: smoke.pnpmError || null,
      });
    } catch (e) {
      ctx.log?.warn?.(
        "[dsh-hanako] 运行级依赖检测失败:",
        e?.message || String(e),
      );
      return c.json({ ok: false, error: "检测请求失败，请稍后重试" });
    }
  });

  // 版本检查（deps 卡片「检查更新」按钮 + Agent 工具 dsh_update 共用能力层；
  // GET 只读）：检查中（g.checking）→ {ok:true,running:true}；否则 await
  // g.checkDshUpdate(cfg)（HTTP 直查 npm registry ≤~15s，官方源失败重试 npmmirror）→
  // {ok:true, localVersion, latestVersion, updateAvailable, error?}。结果缓存进
  // g.checkResult（内存，不再写 check-result.json——v0.18.1 起设置页检查改 dsh 侧
  // 直查），前端随后经 health 读取诊断刷新 deps 卡片。
  // 单例缺失/无函数/异常一律容错回 {ok:false}，本路由不抛异常。
  app.get("/webui/check-update", async (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.checkDshUpdate !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.checking) return c.json({ ok: true, running: true });
      const r = await g.checkDshUpdate({
        dataDir: ctx.dataDir || g.dataDir,
        webPort: port,
      });
      return c.json({
        ok: true,
        running: false,
        localVersion: r.localVersion,
        latestVersion: r.latestVersion,
        updateAvailable: r.updateAvailable,
        error: r.error || null,
      });
    } catch (e) {
      ctx.log?.warn?.("[dsh-hanako] 版本检查失败:", e?.message || String(e));
      return c.json({ ok: false, error: "版本检查失败，请稍后重试" });
    }
  });

  // 更新 DSH（deps 卡片「更新 DSH」按钮 + Agent 工具 dsh_update 共用能力层）：
  // 更新中（g.updating）→ {ok:true,state:"updating"}；否则异步触发 g.updateDsh(cfg)
  // （不 await 其完成——npm i 可能耗时数分钟，前端轮询 health 诊断/设置页
  // update-result.json 看进度）→ {ok:true,state:"updating"}。更新会重启 web host，
  // 正在执行的 dsh 任务会中断（前端按钮已有确认文案）。单例缺失/无函数/异常一律容错
  // 回 {ok:false}，本路由不抛异常。
  app.post("/webui/update-dsh", (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.updateDsh !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.updating) return c.json({ ok: true, state: "updating" });
      // 异步触发（updateDsh 内部已 try/catch 写 update-result.json 返回结果；
      // 这里再 .catch 兜底——路由不等待完成、不抛异常）。dataDir 缺省用单例记录值。
      Promise.resolve(
        g.updateDsh({ dataDir: ctx.dataDir || g.dataDir, webPort: port }),
      ).catch(() => {});
      return c.json({ ok: true, state: "updating" });
    } catch (e) {
      ctx.log?.warn?.("[dsh-hanako] 更新 DSH 失败:", e?.message || String(e));
      return c.json({ ok: false, error: "更新请求失败，请稍后重试" });
    }
  });
}
