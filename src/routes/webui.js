// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// routes/webui.js — dsh-hanako 插件页：contributes.cards（realization:page）内嵌 dsh Web UI
//   GET /webui            插件页：ready（总线已连接）直嵌 dsh Web UI iframe；未 ready 渲染
//                         Bootstrap 三态自举页（booting/action-needed/ready，见 webui-shell 头注释；
//                         数据源 = GET /webui/boot-state + /webui/events 事件流；
//                         功能面板 functionPanel 仅 status 常驻，无操作段）
//   GET /webui/boot-state  自举状态快照（T3 spec：dsh-deps-zero-intervention）——单一状态出口：
//                         g.boot 状态机 + g.deps（含 T1 errorClass/guidance）+ g.web 就绪收敛成
//                         { phase, ready, deps, boot, web } 三段 JSON，三态可渲染；Bootstrap
//                         壳页只消费它，不再各自拼装诊断（事件驱动刷新仍走 /webui/events）
//   GET /webui/events     就绪事件流（SSE 式 chunked，常驻）：bus ready → 推 ready；
//                         停机/重启 → 推 pending；web host 启动失败与 deps 状态翻转
//                         → 推 diag-changed（信号，壳页刷新 boot-state）；DSH 主题偏好
//                         变更 → 推 theme-pref。壳页订阅此流实现事件化（挂载/自举状态
//                         刷新/偏好跟随全事件驱动）。
//   GET  /webui/check-update 版本检查（经宿主能力层 g.checkDshUpdate；按钮已移除——版本
//                            管理归设置页「检查与更新 DSH」卡片 + dsh_install 工具，路由保留）
//   POST /webui/update-dsh   更新 DSH（经宿主能力层 g.updateDsh，异步触发，更新会重启
//                            web host、正在执行的任务中断；按钮已移除，入口归设置页
//                            dsh_install 工具，路由保留）
//   （T5 退役：/webui/health 与 /webui/start、/webui/install-deps、/webui/verify-deps
//   已删除——壳页无手动入口，install/verify/start 通道收敛为自动链 + dsh_install 工具）
//
// 机制：与 routes/card.js 同构——宿主把 app 挂在 /api/plugins/<pluginId> 命名空间下，
// 这里注册相对路径。渲染前按总线连接状态（g.dshanaBus.status().connected）判定 ready：已连接
// 直接渲染 iframe；未连接渲染 Bootstrap 三态自举页（T4 spec：dsh-deps-zero-intervention——
// 壳页数据源 = 首帧内嵌 /webui/boot-state 快照（readBootState）+ /webui/events 事件流：
// bus ready → ready 事件挂载 iframe；bus.disconnect → pending；web host 启动失败与
// deps 状态翻转 → diag-changed 信号（壳页刷新 boot-state），无其它载荷。
// 脚本首行 postMessage ready 是宿主原始握手（参照 PLUGINS.md；插件 bundle 不含
// @hana/plugin-sdk，不依赖它——壳页内置最小 hana 桥（hana.api.fetch / hana.panel.*，与
// SDK 同协议 hana.plugin.ui v1），浏览器侧 fetch 一律走 hana.api.fetch（自动带
// pluginSurfaceSession 头），面板内容经 hana.panel.set 推送）。
//
// 自举状态快照（T3）：服务端把启动自动链状态机 g.boot + 依赖状态 g.deps（含 errorClass/
// guidance）+ g.web 就绪收敛成单一状态出口（GET /webui/boot-state，见 readBootState），
// 壳页只消费它做三态渲染，不再各自拼装诊断。T5 起旧连接失败自检展示层
// （collectWebDiagnostics / buildDepsDiagCheck / buildProcessDiagCheck / pickProcessFix /
// readLogTail 及 readDiagnostics/probeHost 与 /webui/health）整体退役删除——日志诊断
// 保留会话日志文件，浏览器侧不再有 checks 结构消费方。

// 插件页 HTML 壳（构建期 template-loader 经 doT 编译为自包含渲染函数，运行时零依赖）
import { render as webuiShellHtml } from "../assets/webui-shell.jinja2";

// ---- 就绪事件流订阅者（web host 启动失败通知；lifecycle.js 调 g.notifyWebStartFailed）----
// 多个壳页 tab 可同时订阅；Set 保存，流关闭时移除。notifyWebStartFailed 每次模块加载
// 都重新赋值（闭包指向当前模块的 Set，见下方挂钩处），不设一次性守卫。
const webStartFailedListeners = new Set();

// ---- deps 状态翻转通知订阅者（tools/lib/install.js 调 g.notifyDepsChanged）----
// 与 webStartFailedListeners 同模式：安装/检测进入与终态时通知壳页一次性刷新诊断
// （事件驱动替代面板 5s 周期 tick；安装中进度滚动由壳页 installing 态 tick 承担）。
const depsChangedListeners = new Set();

function esc(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

/** 自举状态快照（T3 spec：dsh-deps-zero-intervention，见文件头「GET /webui/boot-state」）。
 * 单一状态出口：把启动自动链状态机 g.boot + 依赖部署/核对状态 g.deps（含 T1 失败分类
 * errorClass/guidance）+ web host 就绪态（g.web / g.webLastError / 总线）收敛成确定性
 * JSON，T4 Bootstrap 壳页只消费它（不再各自拼装诊断）。纯只读聚合：不 spawn、不探测、
 * 不 import 能力模块；单例缺失（冷启动窗口）/ 字段缺省逐层兜底为显式空值（null/""），
 * 本函数永不以异常终结（读单例缺字段即空值，页面不猜）。
 *
 * 返回结构（值域与缺省语义）：
 *   phase     状态机阶段 ensure-deps|waiting|booting|ready（g.boot.phase；未跑过 = ensure-deps）
 *   ready     web host 就绪 = g.web.ready（boot 收敛）或总线已连接（busReady，与 /webui
 *             渲染同源判定）；停机/重启窗口由 /webui/events pending/ready 事件驱动页面翻转
 *   deps      { status, errorClass, guidance, error, version, logTail }
 *               status     g.deps.status：idle|installing|running|ok|error
 *               errorClass install 失败分类（g.deps.errorClass.errorClass；成功/从未失败 = null）
 *               guidance   errorClass 随附人话（g.deps.errorClass.guidance；仅分类非空时非空）
 *               error      最近失败可读文本（g.deps.error，前缀 ≤800；成功/从未失败 = null）
 *               version    已装 dsh 版本（g.deps.result.version；未验证 = null）
 *               logTail    依赖日志尾（g.deps.log 尾部 ≤800，复用现有诊断截断约定；空 = null）
 *   boot      { attempt, nextRetryAt, errorClass, guidance, lastError }
 *               attempt     连续失败尝试计数（g.boot.attempt；收敛归零，未失败 = 0）
 *               nextRetryAt 下次自动重试时刻（epoch ms；不可恢复停等 = null = 不自动重试）
 *               errorClass  最近失败分类（g.boot.errorClass；成功收敛/从未失败 = null）
 *               guidance    最近失败指引文案（index.js handleFailure 随失败落 g.boot.guidance；
 *                           六类 + restart-needed 均有文案；成功收敛/从未失败 = null）
 *               lastError   最近失败可读文本（g.boot.lastError；成功收敛/从未失败 = null）
 *   web       { ready, lastError }
 *               ready      web host boot 收敛标志（g.web.ready === true）
 *               lastError  web host 最近失败文本（g.webLastError 展示尾部 ≤800，与诊断同约定；
 *                           从未失败 = null；恢复就绪后可能残留上次失败，页面以顶层 ready 为准）
 *
 * 三态渲染语义（字段组合即定态，无歧义；T4 壳页按此分支）：
 *   ready         顶层 ready = true（web host 就绪 → iframe 直嵌）
 *   action-needed boot.phase === "waiting" && boot.errorClass 非空 &&（deps.guidance 或
 *                 boot.guidance）非空——失败已分类且指引齐备（用户有可读操作/自动续跑说明）
 *   booting       其余（phase ensure-deps/booting、deps.status installing/running 进行中、
 *                 waiting 但失败信息不全等过渡/未知态 → 阶段时间线 + 重试信息） */
function readBootState() {
  // 兜底快照（字段齐、全显式空值）：单例整体缺失或聚合异常时接口仍回完整结构，页面不猜
  const fallback = () => ({
    phase: null,
    ready: false,
    timestamp: Date.now(),
    deps: {
      status: null,
      errorClass: null,
      guidance: null,
      error: null,
      version: null,
      logTail: null,
    },
    boot: {
      attempt: null,
      nextRetryAt: null,
      errorClass: null,
      guidance: null,
      lastError: null,
    },
    web: { ready: false, lastError: null },
  });
  try {
    const g = globalThis.__dshHanako;
    if (!g || typeof g !== "object") return fallback();
    const boot = (g.boot && typeof g.boot === "object" && g.boot) || {};
    const deps = (g.deps && typeof g.deps === "object" && g.deps) || {};
    // T1 分类记录形态 { errorClass, guidance }（install.js 失败路径落；缺省 null）
    const ec =
      deps.errorClass && typeof deps.errorClass === "object" ? deps.errorClass : null;
    // 依赖核对缓存（verifyDepsSmoke 落 g.deps.result = { ok, version, error, at, ... }）
    const smoke =
      deps.result && typeof deps.result === "object" ? deps.result : null;
    const s = (v) => (typeof v === "string" && v ? v : null); // 可读字符串安全取值
    const tail = (v, n) => {
      // 截断约定：展示用文本一律取尾 ≤800（沿旧诊断壳同款约定）
      const t = s(v);
      return t ? t.slice(-(n || 800)) : null;
    };
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const webReady = !!(g.web && g.web.ready === true);
    const depsError = s(deps.error);
    return {
      phase: s(boot.phase),
      ready: webReady || busReady(),
      timestamp: Date.now(),
      deps: {
        status: s(deps.status),
        errorClass: s(ec && ec.errorClass),
        guidance: s(ec && ec.guidance),
        error: depsError ? depsError.slice(0, 800) : null,
        version: s(smoke && smoke.version),
        logTail: tail(deps.log, 800),
      },
      boot: {
        attempt: num(boot.attempt) ?? 0,
        nextRetryAt: num(boot.nextRetryAt),
        errorClass: s(boot.errorClass),
        guidance: s(boot.guidance),
        lastError: s(boot.lastError),
      },
      web: {
        ready: webReady,
        lastError: tail(g.webLastError, 800),
      },
    };
  } catch {
    // 聚合兜底（防御；正常路径各字段已逐层空值化，理论不可达）
    return fallback();
  }
}

/** 插件页 HTML 壳：ready=true 直接内联 iframe；否则渲染自举页（三态 Bootstrap 壳，
 * 见 assets/webui-shell.jinja2 头注释；T4 spec：dsh-deps-zero-intervention）。
 * colorScheme：按宿主 hana-theme 映射的 color-scheme（dark/light）。dsh 主题为
 * system 时通过 prefers-color-scheme 解析，Chromium 会让跨源 iframe 继承父页面
 * 的 color-scheme，因此 dsh 会跟随宿主主题；dsh 内显式选了 light/dark 则不受影响。
 * boot：未就绪时服务端取一次自举状态快照（readBootState，T3 单一状态出口）作首帧
 * 渲染数据（JSON 对象或 null）；壳页随后以 /webui/events 事件驱动刷新本快照。 */
function buildShell({
  ready,
  hcLink,
  theme,
  api,
  port,
  colorScheme,
  boot,
}) {
  // dsh-frame 保持裸嵌（曾尝试显式声明 sandbox/allow 绕过宿主沙箱，实测跨源继承链
  // 下内层声明无法生效，属无效方案已回滚，见 CHANGELOG）。
  // 剪贴板问题的正规解法是 @dsh-hanako/clipboard 插件（tapIndex 注入桥 → 宿主 capability）
  // + 下方壳页面桥（hostRequest + __dshCopy 监听）。
  // iframe src 由壳页 JS 统一设置（attach）：直嵌 @dsh-hanako/app 子插件
  // （dsh 3080 fork SPA）——同源 iframe，无需 BFF 代理/凭据透传。
  const iframe = `<iframe id="dsh-frame"></iframe>`;
  // 嵌入首帧自举状态快照 JSON：把 </ 转义成 <\/，防快照文本（路径/错误）里的 </script> 提前闭合脚本
  const initBoot = boot
    ? JSON.stringify(boot).replace(/<\//g, "<\\/")
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
    initBoot,
    port,
  });
}

export default function registerWebuiRoutes(app, ctx) {
  const base = "/api/plugins/" + ctx.pluginId;
  // 端口：manifest 默认 + 用户配置合并后的 ctx.config；非对象容错回退 3080
  const cfg =
    ctx && typeof ctx.config === "object" && ctx.config ? ctx.config : {};
  const port = Number(cfg.webPort) || 3080;

  // 插件页：按总线连接状态判定就绪——已连接直接渲染 iframe；未连接渲染 Bootstrap
  // 自举页（三态：booting/action-needed/ready，壳页订阅 /webui/events 事件流 + 刷新
  // /webui/boot-state 驱动）。不再服务端 probeHost（就绪事件化，probeHost 仅诊断路径
  // 使用）。未就绪时服务端同步取一次自举状态快照（readBootState，首屏即渲染三态）；
  // 就绪不取保持轻量。
  // 壳页不再注入任何脚本/横幅：自举状态与事件由壳页 JS 订阅 /webui/events + 读
  // /webui/boot-state（T3 单一状态出口），SPA 全部资源由 @dsh-hanako/app 子插件
  // （dsh 3080）iframe 同源直嵌提供，无浏览器端劫持/改写。

  app.get("/webui", async (c) => {
    // 壳页：iframe 直嵌 @dsh-hanako/app 子插件（dsh 3080）serve 的 fork SPA——
    // iframe 内同源（资源/API/SSE/WS 全由子插件提供，免鉴权，无劫持无 token/PSS）；
    // 宿主只做页面壳：就绪事件化 / 自举状态 / 主题与剪贴板桥（全部在壳页 JS 里）。
    const ready = busReady();
    const hc = c.req.query("hana-css") || "";
    const th = c.req.query("hana-theme") || "inherit";
    const hcLink = hc ? `<link rel="stylesheet" href="${esc(hc)}">` : "";
    // 宿主深色主题（midnight/dark 等）→ iframe 内 prefers-color-scheme dark，dsh 的 system 跟随宿主
    const colorScheme = /midnight|dark/i.test(th) ? "dark" : "light";
    // 未就绪时服务端同步取一次自举状态快照（首屏即渲染三态；随后事件流/30s 兜底再刷新）；
    // 就绪不取保持轻量（壳页直接挂载 iframe，快照只在 pending/diag-changed 时按需拉取）
    const boot = ready ? null : readBootState();
    return c.html(
      buildShell({
        ready,
        hcLink,
        theme: th,
        api: base,
        port,
        colorScheme,
        boot,
      }),
    );
  });

  // 就绪事件流（GET /webui/events，SSE 式 chunked）——壳页事件化的宿主推送通道
  // （就绪/停机/自举状态变化/主题偏好，全部事件驱动；壳页收到后刷新 /webui/boot-state
  // 或转推 iframe，见 webui-shell.jinja2 事件处理）：
  //   · 打开时已 ready（bus 已连接）→ 立即推 ready 事件（流保持常驻）；
  //   · 未 ready → 先推 pending 事件（壳页保持自举页），挂起等待：
  //       - bus.ready（本机事件，hello-ok 到达）→ 推 ready 事件（壳页挂载 iframe）；
  //       - bus.disconnect（web host 停机/重启窗口）→ 推 pending 事件（壳页退回自举页）；
  //       - web host 启动失败（lifecycle notifyWebStartFailed）→ 推 diag-changed 信号
  //         （壳页刷新 boot-state 呈现 waiting——不再携带旧 diagnostics checks 载荷）；
  //       - deps 状态翻转（install.js notifyDepsChanged）→ 推 diag-changed 信号；
  //       - DSH 设置变更（bridge $events 转发 settings/document-updated 的 ui-theme）
  //         → 推 theme-pref 事件（壳页转告注入脚本重读偏好，替代 3s 轮询 describe）。
  // ready 后流保持常驻：重启窗口的 pending → ready 周期、主题偏好与自举状态变化继续推送。
  // 事件格式：SSE data: JSON，{ type: "ready" | "pending" | "diag-changed" | "theme-pref" }。
  // 实现与 routes/card.js 的 /ops/dep-stream 同构（ReadableStream + c.body）；客户端
  // 断开（ReadableStream cancel）时清理订阅与挂钩，不泄漏。
  app.get("/webui/events", (c) => {
    let unsubs = [];
    let onStartFailed = null;
    let onDepsChanged = null;
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
          if (onDepsChanged) depsChangedListeners.delete(onDepsChanged);
          try {
            controller.close();
          } catch {
            /* 已关 */
          }
        };
        // web host 启动失败 → 推 diag-changed 信号（不携带载荷；壳页收到后刷新
        // /webui/boot-state 呈现 waiting——T5 起不再收集旧 diagnostics checks）。
        // 不关闭流——自动链续跑成功后 bus.ready 仍可推 ready 事件挂载
        onStartFailed = () => {
          if (closed) return;
          send({ type: "diag-changed" });
        };
        // deps 状态翻转（安装/检测进入与终态）→ 推 diag-changed 信号：壳页收到后
        // 刷新 /webui/boot-state（进度/终态/errorClass；install.js 状态翻转点调用
        // g.notifyDepsChanged）。
        onDepsChanged = () => {
          if (closed) return;
          send({ type: "diag-changed" });
        };
        // 订阅总线本机事件（bus.ready / bus.disconnect / events 转发）
        const g = globalThis.__dshHanako;
        if (g && g.dshanaBus && typeof g.dshanaBus.on === "function") {
          unsubs.push(
            g.dshanaBus.on("bus.ready", () => {
              if (closed) return;
              // 流常驻：ready 后不关流——后续事件（theme-pref / diag-changed /
              // 重启窗口的 pending → ready）继续推送，壳页事件驱动刷新
              send({ type: "ready" });
            }),
          );
          unsubs.push(
            g.dshanaBus.on("bus.disconnect", () => {
              if (closed) return;
              send({ type: "pending" });
            }),
          );
          // DSH 设置变更转发（bridge $events 订阅 → 总线 events 频道 → 这里过滤）：
          // settings/document-updated 的 ui-theme 命名空间 = 主题偏好变更，推给壳页
          // 转告注入脚本重读偏好（事件驱动替代 3s 轮询 settings/describe）。
          unsubs.push(
            g.dshanaBus.on("events", (frame) => {
              if (closed) return;
              if (!frame || frame.type !== "emit") return;
              if (
                frame.event === "settings/document-updated" &&
                Array.isArray(frame.args) &&
                frame.args[0] === "ui-theme"
              ) {
                send({
                  type: "theme-pref",
                  ns: "ui-theme",
                  revision: frame.args[1] ?? null,
                });
              }
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
        depsChangedListeners.add(onDepsChanged);
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
        hookG.notifyDepsChanged = () => {
          for (const fn of [...depsChangedListeners]) {
            try {
              fn();
            } catch {
              /* 通知失败不阻断 */
            }
          }
        };
        if (busReady()) {
          // 流保持常驻：壳页就绪态也订阅（theme-pref / diag-changed / 重启窗口的
          // pending → ready 周期全依赖它）；ready 事件作首帧信号（就绪态壳页已
          // readyReceived，收到即忽略，随后流挂起等后续事件）。
          send({ type: "ready" });
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
        if (onDepsChanged) depsChangedListeners.delete(onDepsChanged);
      },
    });
    return c.body(stream, 200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
  });

  // 自举状态快照（T3 spec：dsh-deps-zero-intervention）——Bootstrap 壳页唯一数据源：
  // 返回 readBootState() 聚合的单一状态出口（phase/deps/boot/web 三段 + ready），页面只
  // 消费它、不各自拼装诊断。纯只读同步聚合（无 spawn/探测），永不抛（见 readBootState）；
  // 三态渲染语义（ready → action-needed → booting）见 readBootState 注释，字段齐备无歧义。
  // T5 起 /webui/start、/webui/install-deps、/webui/verify-deps、/webui/health 已退役
  // （壳页无手动入口；install/verify 通道收敛为 dsh_install 工具 + 自动链能力层）。
  app.get("/webui/boot-state", (c) => {
    return c.json(readBootState());
  });
}
