// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/view 前端 client 模块（装配核心）。
//
// 角色（fpFullPanel V1）：替代官方 ui-layout 的「root 装配者」。官方 ui-layout 从
// cordis.patch.yml roster 移除（其 AppFrame 不再抢 root），本插件接管同一套装配：
//   inject = ['slots', 'theme', 'locale']（与官方 ui-layout client/index.ts 完全一致——
//   slots=内置槽注册、theme=ui-theme 服务（ThemePresenter 数据源）、locale=ui-locale 服务）
//   apply(ctx)：
//     ① ctx.reflect.provide('layout', <LayoutController>)——ui-sidebar 等 inject
//        'layout' 服务（ctx.get('layout').toggleSidebar 等面板动作契约），roster 去掉
//        ui-layout 后必须由本插件 provide 等价服务。
//     ② ctx.slots.register(root 条目, <视图组件>)——root 槽 single 语义先注册 wins，
//        ui-layout 移除后本插件是唯一 root 注册方。
//     ③ ctx.effect(ThemePresenter)——主题快照投影 document（同官方第二 effect）。
//   V1 只做「无参完整视图」= 注册官方 AppFrame（渲染组件与官方 ui-layout 激活时同一
//   组件），URL 三态（无参/main/sidebar）路由留骨架——main/sidebar 为 V2/V3，不在
//   本版范围（出现时 V1 回退完整视图并 warn，行为安全）。
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
import { createLayoutStore } from "./vendor/stores.ts";
import { LayoutController } from "./vendor/service.ts";
import { ThemePresenter } from "./vendor/theme-presenter.ts";

// ---- view 参数读取（URL 三态路由；V1 只实现 full，main/sidebar 回退 full）----
// 官方 boot 不管 query，本插件直接读 location.search 的 ?dshana-view=<view>；
// 无参 = 完整三列视图（主页面默认，等价官方 ui-layout 激活态）。
const FULL = "full";
const MAIN = "main"; // V3（无侧栏主视图）
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

// root 条目的子槽声明（官方 ui-layout client/index.ts 逐字：frame 的四子槽排他渲染权威；
// 子槽占位者（sidebar/conversation/details/shell.overlay 的 ui-* 插件）条目 roster 照留）。
const FULL_CHILDREN = {
  sidebar: { kind: "single", scope: "root" },
  conversation: { kind: "single", scope: "session-maybe" },
  details: { kind: "single", scope: "session" },
  "shell.overlay": { kind: "list", scope: "root" },
};

// 视图 → root 组件装配选择。V1 全部回退官方 AppFrame（无参完整视图）：
//   - full：官方 AppFrame（等价官方 ui-layout 激活）
//   - main：TODO V3（AppFrame + 初始 panels.sidebar=0 隐藏态；子槽收窄不声明 sidebar）
//   - sidebar：TODO V2（SidebarOnlyFrame 单列容器 + 官方 SidebarRoot + 仅 sidebar 子槽）
// 选型函数骨架保留——V2/V3 在 <视图组件> 与 <children> 两处替换即可。
function frameForView(view) {
  if (view === FULL) return { component: AppFrame, children: FULL_CHILDREN };
  return { component: AppFrame, children: FULL_CHILDREN }; // V1 回退：完整视图兜底
}

// ---- 客户端服务注入：slots（root 注册）+ theme（ThemePresenter 快照）+ locale（t）----
// 与官方 ui-layout client/index.ts 相同；package.json dsh.client.inject 依官方 ui-layout
// 的依赖方声明（locale/ui-renderer/ui-session/ui-theme，行到达序见 module graph edges）。
const inject = ["slots", "theme", "locale"];

/**
 * 客户端插件主体：provide layout 服务 + 注册 root（官方 AppFrame）+ theme DOM 投影。
 * @param ctx - 客户端根 context。
 */
function apply(ctx) {
  const view = readView();
  const layout = new LayoutController();
  const { component: RootView, children } = frameForView(view);
  if (view !== FULL) {
    // V1 未实现 main/sidebar：回退完整视图（行为 = 官方等价），实机无感；V2/V3 落地后
    // 此分支替换为对应 frame（见 frameForView TODO）。
    try {
      console.warn(
        "[@dsh-hanako/view] dshana-view=" +
        view +
        " 尚未实现（V1 只含无参完整视图），本次回退官方完整视图",
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
  }, "@dsh-hanako/view: layout 服务 + root 注册（官方 AppFrame 装配）");

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
