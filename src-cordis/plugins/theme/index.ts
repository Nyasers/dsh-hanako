// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dshana/theme — 把 Hana 宿主主题「全量配色」注入 dsh Web UI（v0.8.1）。
//
// 语义：嵌入场景（DSHana 标签页）下 dsh 始终使用 Hana 配色——
//   明暗：经壳页面 color-scheme 传导（dsh preference=system 时解析宿主明暗）
//   配色：注入脚本接收壳桥回传的「宿主声明」——壳页面 html[data-theme] 使
//     theme.css 变量生效，getComputedStyle 读到当前主题 16 个变量的渲染值。
//     随宿主更新：宿主切主题 → dataset.theme 变 → 插件 iframe 重载 → 壳桥
//     回传新值；宿主新增/修改主题无需插件更新（无静态主题表）。
// 边界：dsh preference 有**两段来源**，都在 DSH 侧语义之内——
//   ① 启动段：壳页从 DSH index 的 boot-theme 行取 `const preference = "..."`（见
//      src/ui/app-shell.ts readIndexThemePreference），随主题载荷 postMessage 给桥，桥拿它
//      当自举值。官方注释把这行定位成 "the browser's pre-plugin interval"（每个 index 渲染
//      都嵌入当前持久偏好，插件树激活后 ThemePresenter 接管同一批 DOM 字段）——不借它，
//      注入完成到插件就位之间 DSH 会一直穿内置配色（空窗）。
//   ② 稳态段：我们的 client 半（client.js）把 ctx.theme 的偏好投影成
//      html[data-dsh-theme-preference]，属性出现即接管权威（桥的 readPreference 优先属性）。
//   门：system → 覆盖 Hana 配色；light/dark → 完全原生；未知 → 不动手。
//   不走 settings/describe RPC 自读，也不走宿主 bus 事件链（前者信封在 0.1.5 未验，
//   读不到就永远停在 system 把 UI 钉住）。
//
// 机制：经 dsh-host-webserver 的 tapIndex 扩展点，向每个 index 响应注入动态桥脚本：
//   桥向壳页索取主题变量（preference 为 system 时），写 body 层 !important 覆盖
//   （压 dsh presenter 的 body inline）。**不再注入任何静态兜底样式**：拿不到宿主主题时
//   就保持 dsh 内置 token（官方明暗），不从宿主搬一套固定值来充数。
//
// 注入脚本内容文件化 + 打包内联（review 修订）：桥脚本正文存独立文件
// assets/theme-bridge.js（纯浏览器 JS），经 rspack asset/source 内联进本包
// bundle（preset 见 src-cordis/build/service-config.mts）。桥脚本唯一动态点是数据表注入占位符
// __DSH_THEME_TOKENS__（TOKEN_MAP 序列化），模块初始化时一次 replace 替换——
// 与主 bundle src/assets 内联同架构，无运行时文件 IO。
//
// 覆盖范围：dsh --dsw-alias-* + --dsw-specific-* 中「视觉主表面」全映射
// （bg 层次/遮罩/文字三阶/brand/button/border/interactive/markdown/state/
// specific 组件/滚动条），功能性颜色保留原生（mask-photo 黑底、danger/warn
// 语义色、toast/tooltip 深色浮层、工具栏半透明、反白文字/边框、骨架屏）。
//
// 依赖注入：webServer 服务（host 半部），与 dsh-client-ui-theme 同姿势。日志直接写 cordis
// 内建 LoggerService（runtime stdout，行首带 [theme] 前缀）——@dshana/logger 已于
// 

import bridgeBody from "./assets/theme-bridge.js";

export const name = "@dshana/theme";

// 映射表在 ./token-map.js（纯数据零依赖，可被 node --test 直接 import；本文件顶部那句
// assets/theme-bridge.js 的默认导出由打包器注入，普通 node import 会直接 SyntaxError）。
import { TOKEN_MAP } from "./token-map.ts";
import { errText } from "./err-text.ts";

// 动态脚本：宿主声明（壳桥 vars + preference）直接应用。正文在
// assets/theme-bridge.js（自包含浏览器 JS），唯一动态点 = TOKEN_MAP 数据表注入
// （占位符 __DSH_THEME_TOKENS__ 模块初始化时替换为序列化常量）。
const BRIDGE = `<script id="@dshana/theme-bridge">
${bridgeBody.replace("__DSH_THEME_TOKENS__", JSON.stringify(TOKEN_MAP))}
</script>`;

export function apply(ctx, config) {
  ctx.inject(["webServer"], (httpCtx) => {
    httpCtx.effect(() => {
      try {
        httpCtx.webServer.tapIndex((html) => {
          if (html.includes('id="@dshana/theme-bridge"')) return html;
          return html.replace("</head>", BRIDGE + "</head>");
        });
        try { ctx.logger?.info?.("[theme] 主题注入 tapIndex 已注册"); } catch { /* 忽略 */ }
      } catch (e) {
        try { ctx.logger?.warn?.("[theme] 主题注入注册失败：" + errText(e)); } catch { /* 忽略 */ }
      }
    });
  });
}
