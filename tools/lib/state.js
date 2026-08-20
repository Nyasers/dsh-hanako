// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/state.js — dsh-hanako 宿主侧共用状态与环境常量（lib 提取）
// 从 tools/dsh-run.js 剥离：globalThis 单例初始化（getSingleton）+ 环境事实（IS_WIN /
// ELECTRON_NODE / ELECTRON_NODE_ENV / PLUGIN_ROOT / manifestDefaults）。
//
// 为什么抽 lib：安装/检查/更新能力层（install.js / check.js）与 dsh_run
// web host 管理（dsh-run.js）共用同一批状态与常量；tools 分发形态 = rspack bundle
// （build.mjs 入口内联 import），lib 代码被内联进 dist/tools/*.js，?t= 重载即整体刷新，
// 无「静态 import 固定 URL 缓存」问题（该约束只影响源码形态，且与旧「单文件」纪律
// 等效——改 lib 代码需重启 Hana 加载）。非 bundle 侧（routes/webui.js、index.js）
// 仍经 globalThis 单例调用，不 import 本模块。
//
// 单例纪律（与旧 dsh-run.js getSingleton 完全一致）：globalThis.__dshHanako 跨模块
// 共享，index.js 卸载清理时读取；旧对象可能缺新字段（热更新后旧 globalThis 对象仍在）
// 逐字段兜底。函数挂载（g.closeProcess / g.installDeps / g.verifyDeps /
// g.checkDshUpdate / g.updateDsh / g.startWebHost / g.collectDiagnostics）由各定义模块
// 在自己文件内显式赋值（本模块是叶子，避免与 dsh-run.js 循环依赖）。

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const IS_WIN = process.platform === "win32";

export const ELECTRON_NODE = process.execPath;
export const ELECTRON_NODE_ENV = { ...process.env, ELECTRON_RUN_AS_NODE: 1 };

const __here = dirname(fileURLToPath(import.meta.url));
// PLUGIN_ROOT 向上查找含 manifest.json 的目录——源码形态（tools/lib/ 下）与
// rspack bundle 形态（dist/tools/ 下内联）都能正确定位插件根。
export let PLUGIN_ROOT = __here;
while (!existsSync(join(PLUGIN_ROOT, "manifest.json"))) {
  const parent = dirname(PLUGIN_ROOT);
  if (parent === PLUGIN_ROOT)
    throw new Error("无法定位插件根：向上未找到 manifest.json");
  PLUGIN_ROOT = parent;
}

// ---- manifest configuration 默认值（单一事实源：manifest.json）----
// dev invoke 等场景 ctx.config 可能未注入默认值或带 undefined 键，这里静态读取保证配置可用。
export const manifestDefaults = (() => {
  try {
    const m = JSON.parse(
      readFileSync(join(PLUGIN_ROOT, "manifest.json"), "utf8"),
    );
    const props = m?.contributes?.configuration?.properties || {};
    const out = {};
    for (const [k, v] of Object.entries(props))
      if (v && "default" in v) out[k] = v.default;
    return out;
  } catch {
    return {};
  }
})();

// ---- 常驻 web host 单例（globalThis 跨模块共享，index.js 卸载清理时读取）----
// g.ops 不再是任务状态注册表（jsonl 唯一事实源），仅存审批/取消运行期协调状态。
// g.depTasks = 安装/升级卡片任务登记表（Map：taskId → { taskId, kind:
// install|update, state: running|ok|error, log, at, result }），tools/dsh-install.js 与
// tools/dsh-update.js 异步流程登记，routes/card.js /ops/dep-stream 读取。
// 函数挂载由各定义模块负责（见文件头注释），本函数只做初始化 + 字段兜底。
export function getSingleton() {
  if (!globalThis.__dshHanako || typeof globalThis.__dshHanako !== "object") {
    globalThis.__dshHanako = { web: null };
  }
  const g = globalThis.__dshHanako;
  if (!g.ops) g.ops = new Map();
  if (!g.depTasks) g.depTasks = new Map();
  return g;
}
