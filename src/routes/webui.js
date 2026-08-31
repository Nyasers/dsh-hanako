// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// routes/webui.js — dsh-hanako 插件页：contributes.cards（realization:page）内嵌 dsh Web UI
//   GET /webui            插件页（iframe 嵌 http://127.0.0.1:<port>/，含就绪事件化/主题注入/失败自检；
//                         壳页另接入功能面板 functionPanel（hana.panel 推送状态/操作，见 webui-shell））
//   GET /webui/events     就绪事件流（SSE 式 chunked）：bus ready → 推 ready 事件；web host
//                         启动失败 → 推 diagnostics 事件；web host 停机 → 推 pending 事件。
//                         壳页订阅此流实现「就绪事件化挂载」（替代旧 3s health 轮询）。
//   GET /webui/health     纯诊断 GET 端点：返回 readDiagnostics 自检结果 + web host 状态
//                         （probeHost 逻辑仅诊断路径使用；不再有「就绪轮询」语义）
//   POST /webui/start        手动启动 web host（process 卡片「手动启动」按钮；ready/starting/触发启动三态）
//   POST /webui/install-deps 自动安装 dsh 依赖（deps 卡片「安装依赖」按钮；installing/触发安装）
//   GET  /webui/verify-deps  运行级依赖检测（node cliBin --version；进标签页自动一次 + 手动「检测依赖」按钮）
//   GET  /webui/check-update 版本检查（经宿主能力层 g.checkDshUpdate；deps 卡片「检查更新」
//                            按钮已移除——版本管理归设置页「检查与更新 DSH」卡片 + dsh_install 工具，路由保留）
//   POST /webui/update-dsh   更新 DSH（经宿主能力层 g.updateDsh，异步触发，更新会重启
//                            web host、正在执行的任务中断；deps 卡片「更新 DSH」按钮已移除，
//                            入口归设置页 dsh_install 工具，路由保留）
//
// 机制：与 routes/card.js 同构——宿主把 app 挂在 /api/plugins/<pluginId> 命名空间下，
// 这里注册相对路径。渲染前按总线连接状态（g.dshanaBus.status().connected）判定 ready：已连接
// 直接渲染 iframe；未连接渲染加载态（壳页订阅 /webui/events 就绪事件流，bus ready 后宿主
// 推 ready 事件 → 壳页动态挂载 iframe——v0.22.1+ 就绪事件化，替代旧「服务端 probeHost +
// 浏览器 3s 轮询 /webui/health 挂载」链路）。脚本首行 postMessage ready 是宿主原始握手
// （参照 PLUGINS.md；插件 bundle 不含 @hana/plugin-sdk，不依赖它——壳页内置最小 hana 桥
// （hana.api.fetch / hana.panel.*，与 SDK 同协议 hana.plugin.ui v1），浏览器侧 fetch 一律
// 走 hana.api.fetch（自动带 pluginSurfaceSession 头），面板内容经 hana.panel.set 推送）。
//
// 连接失败自检：web host 未就绪时逐项检查 ① dsh 依赖（存在性 + 运行级验证）
// ② DSH 进程状态（t1/t2，见 lifecycle.js collectWebDiagnostics），明确指出哪一项坏了、
// 为什么、怎么修。诊断由服务端收集（Node 侧才能读 config.json、进程单例与 fs 状态；
// 浏览器 iframe 读不到插件进程）——收集函数挂在 globalThis 单例（tools/dsh-run.js 的
// collectDiagnostics，lifecycle.js 实现），这里经单例调用而非静态 import：Hana 以 ?t=
// 时间戳加载 tools 模块，静态 import 会命中 Node ESM 固定 URL 缓存读到旧模块（见
// tools/dsh-run.js 头部注释），与 index.js 经单例取 closeProcess 同一套纪律。工具模块
// 未加载（冷启动窗口）时单例函数缺失，返回 null 由壳页诊断渲染兜底。

// 插件页 HTML 壳（构建期 template-loader 经 doT 编译为自包含渲染函数，运行时零依赖）
import { render as webuiShellHtml } from "../assets/webui-shell.jinja2";

// ---- 就绪事件流订阅者（web host 启动失败通知；lifecycle.js 调 g.notifyWebStartFailed）----
// 多个壳页 tab 可同时订阅；Set 保存，流关闭时移除。notifyWebStartFailed 每次模块加载
// 都重新赋值（闭包指向当前模块的 Set，见下方挂钩处），不设一次性守卫。
const webStartFailedListeners = new Set();

function esc(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 探测 dsh web host 是否就绪（host.describe RPC，1.5s 超时；任何失败视为未就绪）。
 * 仅诊断路径使用（/webui/health 与 /webui/events 的初始判定）；/webui 渲染不再探测——
 * 就绪判定改总线连接状态（g.dshanaBus.status().connected，就绪事件化）。 */
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
 * 工具模块未加载（冷启动窗口）时返回 null，页面先渲染占位，诊断路径刷新后填充。
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

/** 总线连接状态（就绪事件化的 ready 判定）：bus 已连接（hello 完成）= web host 就绪。 */
function busReady() {
  try {
    const g = globalThis.__dshHanako;
    return !!(
      g &&
      g.dshanaBus &&
      typeof g.dshanaBus.status === "function" &&
      g.dshanaBus.status().connected
    );
  } catch {
    return false;
  }
}

/** 插件页 HTML 壳：ready=true 直接内联 iframe；否则加载态（壳页订阅就绪事件流后挂载）。
 * colorScheme：按宿主 hana-theme 映射的 color-scheme（dark/light）。dsh 主题为
 * system 时通过 prefers-color-scheme 解析，Chromium 会让跨源 iframe 继承父页面
 * 的 color-scheme，因此 dsh 会跟随宿主主题；dsh 内显式选了 light/dark 则不受影响。
 * diagnostics：未就绪时服务端收集的首帧自检数据（JSON 对象或 null）；浏览器端
 * 渲染进诊断区（30s 超时兜底 / 宿主推诊断事件时展示）。 */
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

  // 插件页：按总线连接状态判定就绪——已连接直接渲染 iframe；未连接渲染加载态（壳页
  // 订阅 /webui/events 就绪事件流，bus ready 后宿主推 ready 事件动态挂载）。不再服务端
  // probeHost（就绪事件化，probeHost 仅诊断路径使用）。未就绪时服务端同步收集一次自检
  // （首屏即渲染，诊断路径刷新）；就绪不收集保持轻量。
  app.get("/webui", async (c) => {
    const ready = busReady();
    const hc = c.req.query("hana-css") || "";
    const th = c.req.query("hana-theme") || "inherit";
    const hcLink = hc ? `<link rel="stylesheet" href="${esc(hc)}">` : "";
    // 宿主深色主题（midnight/dark 等）→ iframe 内 prefers-color-scheme dark，dsh 的 system 跟随宿主
    const colorScheme = /midnight|dark/i.test(th) ? "dark" : "light";
    // 未就绪时服务端同步收集一次自检（首屏即渲染，诊断/超时兜底再刷新）；就绪不收集保持轻量
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

  // 就绪事件流（GET /webui/events，SSE 式 chunked）——壳页就绪事件化的宿主推送通道：
  //   · 打开时已 ready（bus 已连接）→ 立即推 ready 事件并关闭；
  //   · 未 ready → 先推 pending 事件（壳页保持加载态），挂起等待：
  //       - bus.ready（本机事件，hello-ok 到达）→ 推 ready 事件并关闭；
  //       - bus.disconnect（web host 停机/重启窗口）→ 推 pending 事件（壳页退回加载态）；
  //       - web host 启动失败（lifecycle notifyWebStartFailed）→ 推 diagnostics 事件
  //         （诊断对象由 readDiagnostics 收集；壳页直接显示自检），随后关闭。
  // 事件格式：SSE data: JSON，{ type: "ready" | "pending" | "diagnostics", diagnostics? }。
  // 实现与 routes/card.js 的 /ops/dep-stream 同构（ReadableStream + c.body）；客户端
  // 断开（ReadableStream cancel）时清理订阅与挂钩，不泄漏。
  app.get("/webui/events", (c) => {
    let unsubs = [];
    let onStartFailed = null;
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const send = (obj) => {
          if (closed) return;
          try {
            controller.enqueue(
              enc.encode("data: " + JSON.stringify(obj) + "\n\n"),
            );
          } catch {
            /* 连接已断 */
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          for (const u of unsubs) {
            try {
              u();
            } catch {
              /* 退订失败忽略 */
            }
          }
          unsubs.length = 0;
          if (onStartFailed) webStartFailedListeners.delete(onStartFailed);
          try {
            controller.close();
          } catch {
            /* 已关 */
          }
        };
        // web host 启动失败 → 推诊断事件（诊断对象由 readDiagnostics 收集）；
        // 不关闭流——用户修复（手动启动/装依赖）后 bus.ready 仍可推 ready 事件挂载
        onStartFailed = () => {
          if (closed) return;
          send({
            type: "diagnostics",
            diagnostics: readDiagnostics(ctx, cfg, port),
          });
        };
        // 订阅总线本机事件（bus.ready / bus.disconnect）
        const g = globalThis.__dshHanako;
        if (g && g.dshanaBus && typeof g.dshanaBus.on === "function") {
          unsubs.push(
            g.dshanaBus.on("bus.ready", () => {
              if (closed) return;
              send({ type: "ready" });
              close();
            }),
          );
          unsubs.push(
            g.dshanaBus.on("bus.disconnect", () => {
              if (closed) return;
              send({ type: "pending" });
            }),
          );
        }
        // 挂钩 web host 启动失败通知（lifecycle startWebHostFromPlugin catch 调用）。
        // 每次模块加载都重新赋值 notifyWebStartFailed（不设 __webStartFailedHooked 守卫）：
        // 回调闭包始终指向**当前模块**的 webStartFailedListeners Set——宿主以 ?t= 时间戳
        // 加载 routes/webui.js 模块（见头部注释，避免 Node ESM URL 缓存读到旧模块），若
        // 只装一次，重载后旧闭包仍指向旧模块的 Set，新模块 add 的监听器永远不会被通知。
        // 每次赋值覆盖为新模块的 Set，与新加载的模块实例保持一致（lifecycle 经单例调用，
        // 幂等无害）。
        webStartFailedListeners.add(onStartFailed);
        const hookG = globalThis.__dshHanako || (globalThis.__dshHanako = {});
        hookG.notifyWebStartFailed = () => {
          for (const fn of [...webStartFailedListeners]) {
            try {
              fn();
            } catch {
              /* 通知失败不阻断 */
            }
          }
        };
        if (busReady()) {
          send({ type: "ready" });
          close();
          return;
        }
        send({ type: "pending" });
      },
      cancel() {
        // 客户端断开（页面卸载/导航）：清理订阅与挂钩
        for (const u of unsubs) {
          try {
            u();
          } catch {
            /* 退订失败忽略 */
          }
        }
        unsubs.length = 0;
        if (onStartFailed) webStartFailedListeners.delete(onStartFailed);
      },
    });
    return c.body(stream, 200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
  });

  // 纯诊断 GET 端点（v0.22.1+ 收缩）：返回 readDiagnostics 自检结果 + web host 状态
  // （probeHost 探测 ok + 总线连接状态）。壳页不再轮询此端点做挂载（就绪事件化——
  // 挂载由 /webui/events ready 事件/父窗口 postMessage ready 驱动）；此处仅作
  // 30s 超时兜底「查看诊断」与手动刷新的诊断数据源。就绪时也带 diagnostics（低频
  // 兜底探测需感知 deps 更新/安装进行中状态）。diagnostics 为 null 时下一轮补上。
  app.get("/webui/health", async (c) => {
    const ready = busReady() || (await probeHost(port, ctx.log));
    const body = {
      ok: ready,
      port,
      timestamp: Date.now(),
      busConnected: busReady(),
    };
    body.diagnostics = readDiagnostics(ctx, cfg, port);
    return c.json(body);
  });

  // 手动启动 web host（process 卡片「手动启动」按钮调用）：读单例按当前状态返回——
  // 已就绪 → ready；启动中（readyPromise 挂起）→ starting；否则异步触发
  // g.startWebHost(ctx.config, dataDir)（不 await 其就绪，页面靠就绪事件流检测）→ starting。
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
  // 部署中（g.deps.status === "installing"）→ {ok:true,state:"installing"}；否则异步触发
  // g.installDeps(ctx.config, dataDir)（不 await 其完成，页面靠诊断刷新）→ installing。
  // 单例缺失/无函数/异常一律容错回 {ok:false}，本路由不抛异常。
  app.post("/webui/install-deps", (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.installDeps !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      // installing+running 都是「依赖操作进行中」（install 内部重验期间 status 短暂为
      // running），此时重复 install 直接返回状态不重复触发（与能力层内部守卫一致）
      if (
        g.deps.status === "installing" ||
        g.deps.status === "running"
      )
        return c.json({ ok: true, state: "installing" });
      // 异步触发（installDepsFromPlugin 内部已 try/catch 记 g.deps.error 返回结果；
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
  // 检测中（g.deps.status === "running"）→ {ok:true,running:true}；否则 await
  // verifyDepsSmoke(cfg)（dsh 冒烟 ≤10s + pnpm 引导检查并行；自愈下载可能更久）→
  // {ok:true, verified, version, error, running:false, pnpmReady, pnpmVersion, pnpmError}。
  // pnpm 引导状态为独立子项（不进 verified 判定）：未就绪时 pnpmError 为原因，自愈
  // 路径（缺缓存自动重下）恢复就绪。结果写入 g.deps.result，前端随后经 health 读取
  // 诊断刷新 deps 卡片。单例缺失/无函数/异常一律容错回 {ok:false}。
  app.get("/webui/verify-deps", async (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.verifyDeps !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.deps.status === "running" || g.deps.status === "installing")
        return c.json({ ok: true, running: true });
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

  // 版本检查（deps 卡片「检查更新」按钮 + Agent 工具 dsh_install 共用能力层；
  // GET 只读）：检查中（g.check.status === "running"）→ {ok:true,running:true}；否则
  // await g.checkDshUpdate(cfg)（HTTP 直查 npm registry 根包 JSON dist-tags ≤~15s，
  // 官方源失败重试 npmmirror）→ {ok:true, localVersion, distTags, baselineTag,
  // baselineVersion, updateAvailable, error?}（latestVersion 保留为 baselineVersion
  // 别名）。基线 tag = 显式 tag / 配置 dshTag（config.json global.dshTag，默认
  // "latest"）。结果缓存进 g.check.result（内存，不再写 check-result.json——v0.18.1
  // 起设置页检查改 dsh 侧直查），前端随后经 health 读取诊断刷新 deps 卡片。
  // 单例缺失/无函数/异常一律容错回 {ok:false}，本路由不抛异常。
  app.get("/webui/check-update", async (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.checkDshUpdate !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.check.status === "running") return c.json({ ok: true, running: true });
      const r = await g.checkDshUpdate({
        dataDir: ctx.dataDir || g.dataDir,
        webPort: port,
      });
      return c.json({
        ok: true,
        running: false,
        localVersion: r.localVersion,
        distTags: r.distTags || null,
        baselineTag: r.baselineTag || null,
        baselineVersion: r.baselineVersion,
        latestVersion: r.latestVersion ?? r.baselineVersion,
        updateAvailable: r.updateAvailable,
        error: r.error || null,
      });
    } catch (e) {
      ctx.log?.warn?.("[dsh-hanako] 版本检查失败:", e?.message || String(e));
      return c.json({ ok: false, error: "版本检查失败，请稍后重试" });
    }
  });

  // 更新 DSH（deps 卡片「更新 DSH」按钮 + Agent 工具 dsh_install 共用能力层）：
  // 更新中（g.update.status === "running"）→ {ok:true,state:"updating"}；否则异步触发
  // g.updateDsh(cfg)（不 await 其完成——pnpm add 可能耗时数分钟，前端经诊断/设置页
  // update 事件看进度）→ {ok:true,state:"updating"}。未传版本/tag 时按配置基线
  // （config.json global.dshTag，默认 latest）安装。更新会重启 web host，正在执行的
  // dsh 任务会中断（前端按钮已有确认文案）。单例缺失/无函数/异常一律容错回
  // {ok:false}，本路由不抛异常。
  app.post("/webui/update-dsh", (c) => {
    const g = globalThis.__dshHanako;
    try {
      if (!g || typeof g.updateDsh !== "function") {
        return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
      }
      if (g.update.status === "running") return c.json({ ok: true, state: "updating" });
      // 异步触发（updateDsh 内部已 try/catch 置 g.update 状态 + 总线回投事件；
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
