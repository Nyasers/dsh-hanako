// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/index.js — dsh-hanako v2 App 入口（迁移规格：specs/dshana-v2-migration-archived.md，第 1 步）
//
// 形态：v2 App 契约。本模块只做“注册面”，不启动任何 DSH/Cordis/ACP 运行时：
//   - 模块导出 apply(ctx)，只用公开 App context 成员：
//       ctx.logger（debug/info/warn/error） / ctx.dataDir（= {HANA_HOME}/app-data/{appId}） /
//       ctx.id（应用 id；v2 约束 id === 应用目录名） / ctx.tools.register / ctx.routes.register；
//   - 不再导出旧插件 default class（new DshHanakoPlugin + onload() + this.ctx），也不再导出
//     pluginRoutes（旧宿主 routes/ 扫描转发面；v2 的页面/路由全部在 apply 内经 ctx.routes
//     .register 注册，路由壳 dist/routes/index.js 不再生成）。
//   - 工具注册改 ctx.tools.register({ name, description, parameters, execute,
//     sessionPermission? })：v2 工具名不加前缀、必须在全局 registry 唯一——本 App 已是
//     单工具 dsh_session（parameters.action enum = list/get/create/send/cancel/approve）。
//
// 与旧 onload 对照（迁移原则：不包兼容 adapter 继续读旧宿主对象）：
//   this.ctx.config       → ctx.config（get/getAll/set/setMany）——第 1 步注册面不读配置，
//                           仅在 apply 里保留引用占位；真正消费方（subtool run 的默认超时/
//                           nodejsPath 解析）随第 2/3 步迁移。
//   this.ctx.dataDir      → ctx.dataDir（{HANA_HOME}/app-data/dsh-hanako）。
//   this.ctx.log          → ctx.logger（本文件全部改走 ctx.logger）。
//   this.ctx.registerTool → ctx.tools.register；register 返回 disposer 的登记/清理语义按
//                           v2（disposer 供卸载/重载逆序清理；本步不依赖 onload this.register）。
//   pluginRoutes(app,ctx) → ctx.routes.register(registrar)：route app 一次注册全部 handler
//                           （routes/webui.js + routes/card.js 收进同一个 registrar）。
//
// 明确不在第 1 步迁移（旧宿主依赖，见文末注释块；各步编号取规格「建议迁移顺序」）：
//   - globalThis.__dshHanako：旧形态在此单例存放宿主 ctx.bus/resources/network/logPath 等。
//     v2 形态只保留 App 自身最小状态（dataDir/appId），不再放宿主对象；execute 调用链
//     在 2/3 步按 ctx.tasks/ctx.models/ctx.runtime 重建后，此单例可整体移除。
//   - task:register-handler 等宿主私有 bus verb（宿主 task:abort 取消链路）→ 第 3 步
//     （cancel 接 ctx.tasks）。
//   - 依赖自动安装 + DSH 进程内 boot（lib/lifecycle.js 的 mountLifecycle/startWebHost 等，
//     旧 onload 的自动链状态机）→ 第 2 步随 ctx.runtime 迁移。
//   - Web UI base prefix / 卡片 SSE / 剪贴板 capability 接线 → 第 4 步。
//   - activation（按需激活 + 空闲回收）→ 第 5 步；本步不声明 activation（不声明 = startup
//     启动，注册面即刻成立）。

import * as dshSession from "./tools/session.js";
import registerWebuiRoutes from "./routes/webui.js";
import registerCardRoutes from "./routes/card.js";

// 应用 id：manifest.id === 应用目录名（v2 硬性约束，见 0.928 宿主 manifest 读取器
// “id … does not match its directory name”）。ctx.id 是 v2 公开成员；双兜底保证
// dev/直接 import 形态也能拿到稳定值。
const APP_ID = "dsh-hanako";

const HANAKO_TOOLS = [dshSession];

function appIdOf(ctx) {
  return typeof ctx?.id === "string" && ctx.id ? ctx.id : APP_ID;
}

// v2 App 路由对外 base：ctx.routes.register 的 registrar 收到的是**相对** route app
// （host 只要求往里面挂相对路径 handler），页面 HTML/浏览器 API 的绝对 URL 需要 base。
// 0.928 宿主未以文档公开该前缀，本步暂按规格 §受管 DSH 运行时与浏览器服务的
// /api/apps/<appId>/routes/… 前缀形态取占位值并集中在单点 —— 待宿主文档确认后改这里即可
// （问题清单 #R1；页面完整可达属第 4 步 Web UI base prefix 验收内容，本步只保证注册面）。
function routeBaseOf(appId) {
  return "/api/apps/" + appId + "/routes";
}

// App 内部状态（v2 语义下不再携带宿主对象）：给尚未迁移的 tools execute 内部链
// （subtool/* 读 g.dataDir 定位 dsh-home 等）保留最小可用字段；execute 链 2/3 步重接后
// 可整体删除（含 globalThis.__dshHanako）。
function ensureInternalState(ctx) {
  let g = globalThis.__dshHanako;
  if (!g || typeof g !== "object") {
    g = globalThis.__dshHanako = {};
  }
  if (typeof ctx?.dataDir === "string") g.dataDir = ctx.dataDir;
  if (typeof g.appId !== "string") g.appId = appIdOf(ctx);
  return g;
}

function safeLog(logger, level, msg) {
  try {
    if (typeof logger?.[level] === "function") logger[level](msg);
  } catch {
    /* 日志失败不阻断注册 */
  }
}

// ---- v2 App 入口：apply(ctx) ----
// 第 1 步注册面：① routes（ctx.routes.register 单 registrar，webui+card 全部 handler）；
// ② tools（ctx.tools.register 逐工具注册，六 action 的注册面成立）。execute 内部对 DSH
// 运行时的调用链本次不动（第 2/3 步迁移）。apply 同步返回，不启动任何后台链。
export function apply(ctx) {
  const appId = appIdOf(ctx);
  const logger = ctx?.logger;
  const log = (level, msg) => safeLog(logger, level, msg);

  ensureInternalState(ctx);
  log("info", "[dsh-hanako] v2 App apply() 注册开始（appId=" + appId + "）");

  let toolsRegistered = 0;
  if (typeof ctx?.tools?.register === "function") {
    for (const tool of HANAKO_TOOLS) {
      try {
        ctx.tools.register({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          execute: tool.execute,
          ...(tool.sessionPermission ? { sessionPermission: tool.sessionPermission } : {}),
        });
        toolsRegistered += 1;
        log("info", "[dsh-hanako] 工具注册:" + tool.name + "（ctx.tools.register）");
      } catch (e) {
        log("error", "[dsh-hanako] 工具注册失败:" + (tool?.name || "?") + "（" + (e?.message || String(e)) + "）");
      }
    }
  } else {
    // 工具注册面未成立：不会阻断 apply（页面/设置仍可注册），但 dsh_session 不会出现在
    // 模型可调用工具集合。宿主侧登记入口名需随 0.928 宿主文档核对（问题清单 #T1）。
    log("warn", "[dsh-hanako] ctx.tools.register 不可用，工具注册面未成立");
  }

  if (typeof ctx?.routes?.register === "function") {
    try {
      const base = routeBaseOf(appId);
      ctx.routes.register((routeApp) => {
        registerWebuiRoutes(routeApp, base);
        registerCardRoutes(routeApp, base);
      });
      log("info", "[dsh-hanako] 路由注册：ctx.routes.register（webui + card 全部 handler）");
    } catch (e) {
      log("error", "[dsh-hanako] 路由注册失败（" + (e?.message || String(e)) + "）");
    }
  } else {
    log("warn", "[dsh-hanako] ctx.routes.register 不可用，页面路由注册面未成立");
  }

  log("info", "[dsh-hanako] v2 App 注册面完成（tools=" + toolsRegistered + "）；DSH 运行链路自第 2 步起接线");
}

export default apply;

// ---------------------------------------------------------------------------
// 旧宿主依赖清单（第 1 步不迁移；迁移到哪一步见规格「建议迁移顺序」）：
//   2. DSH/Cordis/ACP 与依赖打入受管 runtime（ctx.runtime.start）：迁移点 = 旧 onload
//      自动链状态机（ensureDepsStage/bootStage/handleFailure/waitMount/退避重试）、
//      lib/lifecycle.js（mountLifecycle/startWebHost/installDeps）、lib/bootstrap.js、
//      lib/pnpm.js、lib/profile-seed.js、lib/acp-mount.js、lib/wake.js；
//      数据目录随 ctx.dataDir（app-data）重建 profile/session/log 布局。
//   3. send→task→inference/tool-loop→complete/fail：迁移点 = 宿主 task:register-handler
//      私有 bus verb、dsh_session create/send/cancel/approve 的 execute（subtool/run、
//      subtool/cancel、subtool/approve）里的 ctx.bus/ctx.signal/ctx.sessionPath 与
//      callUnaryBus 总线投递、approval 通知——改接 ctx.tasks（create/update/complete/
//      fail/cancel/requestApproval/respondApproval/watch）+ ctx.models；
//      dsh-events/protocol/lib 的进程内 ctx 直订（g.web.ctx）改为 App 自身事件源。
//   4. Web UI base prefix：/main、/sidebar、/webui/*、/card/*、/ops/* 的浏览器绝对 URL
//      （routeBaseOf 占位值）+ iframe/src 端口 + card SSE + clipboard capability
//      （旧 ui.hostCapabilities clipboard.writeText → v2 授权方案待确认）。
//   5. activation（on-demand + idleTimeoutMs + 声明工具）与空闲回收验收。
// 旧数据迁移（备份/复制/校验/profile 重建）按规格「迁移旧用户数据」在 4/5 步之间做。
// ---------------------------------------------------------------------------
