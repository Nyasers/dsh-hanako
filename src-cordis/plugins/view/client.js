// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/view 前端 client 模块（装配核心）。
//
// 角色（fpFullPanel V1→V2）：替代官方 ui-layout 的「root 装配者」。官方 ui-layout 从
// cordis.patch.yml roster 移除（其 AppFrame 不再抢 root），本插件接管同一套装配：
//   inject = ['slots', 'theme', 'locale']（与官方 ui-layout client/index.ts 完全一致——
//   slots=内置槽注册、theme=ui-theme 服务（ThemePresenter 数据源）、locale=ui-locale 服务）
//   apply(ctx)：
//     ① ctx.reflect.provide('layout', <LayoutController>)——ui-sidebar 等 inject
//        'layout' 服务（ctx.get('layout').toggleSidebar 等面板动作契约），roster 去掉
//        ui-layout 后必须由本插件 provide 等价服务。
//     ② ctx.slots.register(root 条目, <视图组件>)——root 槽 single 语义先注册 wins，
//        ui-layout 移除后本插件是唯一 root 注册方；register 同携四/单子槽声明 +
//        store（createLayoutStore）+ inject 钩子 attachPanels（开放问题 2 结论）。
//     ③ ctx.effect(ThemePresenter)——主题快照投影 document（同官方第二 effect）。
//   视图矩阵（frameForView 选型；URL 参数 ?dshana-view=<view>，无参 = full）：
//     full    = 官方 AppFrame（四子槽，官方等价；无参主页面默认）
//     sidebar = SidebarOnlyFrame（V2：fp 面板 embedUrl 纯侧栏——单列容器 + 仅 sidebar
//               子槽；SidebarRoot/workspaces/settings 子槽 occupant 走 roster 官方
//               bundle，详见 SidebarOnlyFrame.tsx 文件头）
//     main    = V3 未实现，回退 full（warn）
//   V2 边界如实记录（不做 V4 预实现，见 SidebarOnlyFrame.tsx「已知限制」）：
//     sidebar.settings modal（1080x700）在本 iframe 内溢出 → 跨边联动属 V4；
//     SidebarRoot rail toggle 只翻转 layout store 偏好（本帧不读 store 几何），无视觉效果；
//     sidebar 无 rail 折叠语义（collapsed 恒 false）。
//
// 官方源码复用通道（重要——构建期 vendor，见 vendor/README.md）：
//   官方 npm 副本无 src 物理文件（发布 files 只含 lib/，exports "./src/*" 解析失败），
//   browser module table 只有整包 row（子路径不可 require）——故 ui-layout 的 client
//   src（AppFrame.tsx/stores.ts/service.ts/theme-presenter.ts/DocumentTitle.tsx/
//   columns.ts/AppFrame.module.css）以逐字副本 vendor 进本包（src-cordis/plugins/view/
//   vendor/，rc.1 钉版），tsdown 构建期编译内联进本包 closure-factory bundle。运行时
//   外部依赖仅 react / react/jsx-runtime / @deepseek-ai/dsh-client-store（平台 seed，
//   官方 ui-layout bundle 同款 externals 集，见 cordis.config.mjs）。
//
// 开放问题 2 结论（V1 spike，装配副作用接线）：需要，且必须逐项等效——
//   ① provide('layout')：ui-sidebar.apply 经 ctx.get('layout').toggleSidebar() 发面板
//      动作；无 provider 该依赖永不就绪。
//   ② register 的 store 席位 + inject 钩子 layout.attachPanels(actions)：LayoutController
//      本身是哑门面（service.ts），toggleSidebar/openDetails/closeDetails 全转发到 root
//      条目 layout store 实例的 bound actions；attachPanels 未接线时 #require() 抛
//      "layout: panel actions not wired (root entry not mounted)"——接线点在 register 的
//      inject 钩子（条目首渲染时框架调起），必须随 root 注册同传。
//   ③ children 四子槽声明（sidebar/conversation/details/shell.overlay）：register 同调
//      声明 = AppFrame 对这些槽的排他渲染权威；不声明则占位者条目无渲染者（declaring is
//      claiming）。
//   ④ AppFrame 内部（viewport/panels 动作）零自接线：三框架 share（runtime/store/
//      render-slots/locale props）全由 slots 框架经注册注入，几何状态（ResizeObserver +
//      store）组件自持——官方 apply 除了 ①②③ 与 theme presenter 无其他副作用。
//   ⑤ theme presenter effect：ui-layout 第二 effect（ThemePresenter）是把 ctx.theme
//      快照写到 document（color-scheme / data-ds-dark-theme / token 变量 / 字号 / theme-
//      color meta）的唯一者；roster 移除 ui-layout 后此投影职责随本插件保留，否则无参
//      视图缺主题 DOM 投影（非官方等价）。
//
// 产物形态：tsdown client 链（src-cordis/build/client-config.mjs）构建 package.json
// exports["./client"] 指向的 client bundle（学官方 dsh clientBundle 预设：intro/banner/
// footer 包 window.__ModuleLoader__.load({ id, factory })，react/jsx-runtime/
// @deepseek-ai/dsh-client-store external 走 loader seed 表 require）。

import { AppFrame } from "./vendor/AppFrame.tsx";
import { SidebarOnlyFrame } from "./SidebarOnlyFrame.tsx";
import { createLayoutStore } from "./vendor/stores.ts";
import { LayoutController } from "./vendor/service.ts";
import { ThemePresenter } from "./vendor/theme-presenter.ts";

// ---- view 参数读取（URL 三态路由；V2 已实现 full/sidebar，main 回退 full）----
// 官方 boot 不管 query，本插件直接读 location.search 的 ?dshana-view=<view>；
// 无参 = 完整三列视图（主页面默认，等价官方 ui-layout 激活态）；
// sidebar = 纯侧栏视图（V2，manifest functionPanel.embedUrl 指向本页带该参数）。
const FULL = "full";
const MAIN = "main"; // V3（无侧栏主视图，本期回退 full）
const SIDEBAR = "sidebar"; // V2（fp 面板 embedUrl 纯侧栏）

function readView() {
  if (typeof location === "undefined") return FULL;
  const m = /[?&]dshana-view=([^&#]+)/.exec(location.search);
  if (!m) return FULL;
  let v;
  try {
    v = decodeURIComponent(m[1]);
  } catch {
    // malformed percent-encoding（如 ?dshana-view=%）：按无参处理回退完整视图——
    // 不能抛：readView 抛错会让 apply() 来不及注册 root/layout 服务（页面白屏）
    return FULL;
  }
  return v === MAIN || v === SIDEBAR ? v : FULL;
}

// root 条目的子槽声明。FULL = 官方 ui-layout client/index.ts 逐字四子槽（frame 的
// 排他渲染权威）；SIDEBAR 只声明 sidebar——declaring is claiming：conversation/details/
// shell.overlay 不声明则其 ui-* occupant（ui-conversation/ui-chat 等，经 slots.inject
// 等待声明生命周期）子树不注册不挂载；数据/服务面（sessions/workspaces 等）是 service
// 不依赖槽，照常激活。sidebar 槽内部子槽（brand/workspaces/settings/footer.action）由
// occupant（ui-sidebar）自身的 register 声明，不受本表收窄影响。
const FULL_CHILDREN = {
  sidebar: { kind: "single", scope: "root" },
  conversation: { kind: "single", scope: "session-maybe" },
  details: { kind: "single", scope: "session" },
  "shell.overlay": { kind: "list", scope: "root" },
};
const SIDEBAR_CHILDREN = {
  sidebar: { kind: "single", scope: "root" },
};

// 视图 → root 组件装配选择。
//   - full：官方 AppFrame（等价官方 ui-layout 激活）
//   - sidebar（V2）：SidebarOnlyFrame（单列容器 + 官方 SidebarRoot 经 sidebar 槽渲染）
//   - main：V3 未实现 → 回退 AppFrame 完整视图（warn，行为安全）
function frameForView(view) {
  if (view === FULL) return { component: AppFrame, children: FULL_CHILDREN };
  if (view === SIDEBAR) return { component: SidebarOnlyFrame, children: SIDEBAR_CHILDREN };
  return { component: AppFrame, children: FULL_CHILDREN }; // V3 main 回退：完整视图兜底
}

// ---- 客户端服务注入：slots（root 注册）+ theme（ThemePresenter 快照）+ locale（t）----
// 与官方 ui-layout client/index.ts 相同；package.json dsh.client.inject 依官方 ui-layout
// 的依赖方声明（locale/ui-renderer/ui-session/ui-theme，行到达序见 module graph edges）。
const inject = ["slots", "theme", "locale"];

/**
 * 客户端插件主体：provide layout 服务 + 注册 root（按视图选型帧：full=AppFrame、
 * sidebar=SidebarOnlyFrame）+ theme DOM 投影。
 * @param ctx - 客户端根 context。
 */
function apply(ctx) {
  const view = readView();
  const layout = new LayoutController();
  const { component: RootView, children } = frameForView(view);
  if (view === MAIN) {
    // V3 未实现 main 视图：回退完整视图（行为 = 官方等价），实机无感。
    try {
      console.warn(
        "[@dsh-hanako/view] dshana-view=main 尚未实现（V2 含 full/sidebar），本次回退官方完整视图",
      );
    } catch {
      /* 日志失败不阻断 */
    }
  }

  // effect 1：layout 服务 + root 注册（open question 2 结论的 ①②③ 一个 register 全给：
  // provide 用 ctx.reflect（官方同款），register 携 children/store/inject-钩子 attachPanels）。
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide("layout", layout);
    const disposeRegistration = ctx.slots.register(
      {
        name: "root",
        locale: "common",
        children,
        // 排他 store 席位：工厂本身（框架按条目实例化，AppFrame 经 useStore/actions 标准
        // props 拿实例）——与官方 register 同语义（stores.ts 工厂）。
        store: createLayoutStore,
        // 钩子唯一副作用 = 把 root store 的 bound actions 接给 ctx.layout 门面（官方
        // attachPanels 语义；会话/业务动作属各占位者，不在此接）。
        inject: (actions) => {
          layout.attachPanels(actions);
          return {};
        },
      },
      RootView,
    );
    return () => {
      disposeRegistration();
      // provide() 的 disposer 异步落定；teardown 同步 fire-and-forget（官方同款）。
      void disposeService();
    };
  }, "@dsh-hanako/view: layout 服务 + root 注册（按 dshana-view 选型 frame 装配）");

  // effect 2：theme DOM 投影（官方 ui-layout 第二 effect 逐字——getter 初始一次 + 事件
  // 驱动；无 React 路径，纯 DOM 写）。
  ctx.effect(() => {
    const presenter = new ThemePresenter();
    presenter.apply(ctx.theme.getTheme());
    const off = ctx.on("theme/change", (snapshot) => {
      presenter.apply(snapshot);
    });
    return () => {
      off();
      presenter.dispose();
    };
  }, "@dsh-hanako/view: theme presenter");
}

export { apply, inject };
