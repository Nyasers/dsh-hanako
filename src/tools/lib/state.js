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
//
// 分组状态（v0.24 状态收敛：单例平铺字段重构为分组结构化）——旧平铺字段
// （g.updating / g.updateError / g.depsInstalling / g.depsInstallAt / g.depsInstallError /
// g.depsInstallLog / g.depsSmoke / g.checking / g.checkResult / g.checkAt）全部废弃，
// 只维护三个五维分组对象（单一事实源，不做平铺+分组双份同步）：
//   g.update = { status, result, error, time, log }   更新链路
//   g.deps   = { status, result, error, time, log }   依赖链路（log = 内存尾环字符串）
//   g.check  = { status, result, error, time, log }   版本检查链路（无日志流，log 恒 null）
//   g.depBusy = null | { kind: "install"|"update" }   共享依赖操作互斥（vX：install/
//     update 任一进行中另一动作拒绝；tools/dsh-install.js 同步段检查/置位、操作完成
//     释放；能力层守卫 g.deps.status / g.update.status 保留为 webui 路由等其他调用
//     路径双保险；verify/check 不占用）
// status 值域统一：idle / running(installing) / ok / error，由各链路定义模块在状态
// 变化点显式维护。g.update.log 定义为 getter 投影 g.deps.log（updateDsh 内部走
// installDepsFromPlugin 写同一日志尾环，同源实时可见，不复制字符串）。

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const IS_WIN = process.platform === "win32";

// ---- Node 运行时解析（v0.25：可选自定义 nodejs）----
// 背景：所有子进程（pnpm / dsh web host / wrapper）原先一律用 Electron 自带 node
// （process.execPath + ELECTRON_RUN_AS_NODE=1）。macOS 上 Electron 内嵌 node 跑 pnpm
// 会触发签名校验失败（Electron 的 node 二进制非标准 node 签名，pnpm 校验不通过）。
// 本次提供可选配置 nodejsPath（manifest 配置项）：配置了非空且 existsSync 校验通过的系统
// node 绝对路径 → 子进程改用自定义 node；否则回退 process.execPath（行为与旧静态常量一致）。
// 动态解析（取代静态常量 ELECTRON_NODE / ELECTRON_NODE_ENV）：每次 spawn 前解析，运行期改 config.json 的 global.nodejsPath 立即对
// 下一次子进程生效（设置界面改动无需重启）。
// opts 约定（与 lib/config.js resolve* 同款）：{ dataDir?, nodejsPath? }——dataDir 用于
// 直读 dataDir/config.json（优先，单一事实源）；nodejsPath 为配置快照兜底（manifest
// 默认 ""，dev invoke 等场景可用）。路径不存在/不可执行：warn 降级回退 Electron node，
// 不抛错崩流程。
// ELECTRON_RUN_AS_NODE=1 只对 Electron node 有意义（把 Electron 主进程当纯 node 跑）；
// 自定义系统 node 不需要该变量（系统 node 忽略它，保留无害但语义上不必要——统一只在
// Electron 分支注入，见 resolveNodeExecEnv）。
export function resolveNodeExec(opts) {
  let custom = "";
  // ① 优先直读 dataDir/config.json 的 global.nodejsPath（设置界面改动即时生效）
  const dataDir =
    (opts && typeof opts.dataDir === "string" && opts.dataDir) ||
    (getSingleton().dataDir) ||
    join(PLUGIN_ROOT, "data");
  try {
    const cf = join(dataDir, "config.json");
    if (existsSync(cf)) {
      const j = JSON.parse(readFileSync(cf, "utf8"));
      const v = j?.global?.nodejsPath;
      if (typeof v === "string" && v.trim()) custom = v.trim();
    }
  } catch {
    /* 读配置失败忽略（走快照兜底） */
  }
  // ② 配置快照兜底（manifest default ""）
  if (!custom) {
    const v = opts && typeof opts.nodejsPath === "string" ? opts.nodejsPath : "";
    if (v.trim()) custom = v.trim();
  }
  if (!custom) return process.execPath; // 未配置：Electron 自带 node
  if (custom === process.execPath) return custom; // 配置值即 Electron node
  // 必须是「常规可执行文件」才采用：目录 / 不可执行文件会在 spawn 时抛 EACCES/ENOEXEC
  // 炸流程，在此直接降级回退 Electron node（warn 说明）。非 Windows 平台检查执行位
  // （mode & 0o111）；Windows 无统一可执行位语义，isFile 即放行（.exe/.cmd/.bat 均
  // 为普通文件）。
  try {
    const st = statSync(custom);
    if (st.isFile() && (IS_WIN || (st.mode & 0o111) !== 0)) return custom;
  } catch {
    /* stat 失败（路径不存在等）：走降级 */
  }
  console.warn(
    "[dsh-hanako] nodejsPath 配置的路径不存在或不可执行（" +
      custom +
      "），降级使用 Electron 自带 node",
  );
  return process.execPath;
}

// 子进程环境：ELECTRON_RUN_AS_NODE=1 仅对 Electron node 有意义——自定义系统 node
// 不需要（系统 node 忽略该变量），不注入。调用点统一用 resolveNodeExec 同款 opts。
export function resolveNodeExecEnv(opts) {
  const exec = resolveNodeExec(opts);
  if (exec === process.execPath)
    return { ...process.env, ELECTRON_RUN_AS_NODE: 1 };
  return { ...process.env };
}

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
// install|update, state: running|ok|error, log, at, result }），tools/dsh-install.js
// 异步流程（action=install/update）登记，routes/card.js /ops/dep-stream 读取。
// 函数挂载由各定义模块负责（见文件头注释），本函数只做初始化 + 字段兜底。
export function getSingleton() {
  if (!globalThis.__dshHanako || typeof globalThis.__dshHanako !== "object") {
    globalThis.__dshHanako = { web: null };
  }
  const g = globalThis.__dshHanako;
  if (!g.ops) g.ops = new Map();
  if (!g.depTasks) g.depTasks = new Map();
  // ---- 分组状态兜底初始化（v0.24 状态收敛；见文件头「分组状态」）----
  // 热更新兼容：旧 globalThis 对象缺 g.update/g.deps/g.check 或字段时逐个兜底；
  // 已存在的分组对象保留其运行期值（不重置——终态跨热更新可见，下次入口才覆盖）。
  if (!g.update || typeof g.update !== "object") g.update = {};
  if (g.update.status === undefined) g.update.status = "idle";
  if (g.update.result === undefined) g.update.result = null;
  if (g.update.error === undefined) g.update.error = null;
  if (g.update.time === undefined) g.update.time = null;
  // g.update.log = getter 投影 g.deps.log（同源日志尾环；updateDsh 内部走
  // installDepsFromPlugin 写同一尾环，只读投影不复制字符串——注释说明同源语义）
  if (!Object.getOwnPropertyDescriptor(g.update, "log")) {
    Object.defineProperty(g.update, "log", {
      enumerable: true,
      configurable: true,
      get() {
        const deps = g.deps;
        return deps && typeof deps.log === "string" ? deps.log : null;
      },
    });
  }
  if (!g.deps || typeof g.deps !== "object") g.deps = {};
  if (g.deps.status === undefined) g.deps.status = "idle";
  if (g.deps.result === undefined) g.deps.result = null;
  if (g.deps.error === undefined) g.deps.error = null;
  // T1 错误分类（spec：dsh-deps-zero-intervention）：install 失败后存 { errorClass,
  // guidance } 对象（见 lib/errclass.js 模块头）；默认 null = 无失败分类（成功/从未
  // 失败/新一次安装尝试中）。热更新兼容：旧 globalThis 对象缺该字段时兜底。
  if (g.deps.errorClass === undefined) g.deps.errorClass = null;
  if (g.deps.time === undefined) g.deps.time = null;
  if (g.deps.log === undefined) g.deps.log = "";
  // 共享依赖操作互斥（vX）：tools/dsh-install.js 的 install/update 动作共用——任一
  // 进行中另一动作拒绝（install ↔ update 互斥）；null = 无进行中依赖操作。热更新
  // 兼容：旧 globalThis 对象可能缺该字段，逐字段兜底为 null。
  if (g.depBusy === undefined) g.depBusy = null;
  if (!g.check || typeof g.check !== "object") g.check = {};
  if (g.check.status === undefined) g.check.status = "idle";
  if (g.check.result === undefined) g.check.result = null;
  if (g.check.error === undefined) g.check.error = null;
  if (g.check.time === undefined) g.check.time = null;
  if (g.check.log === undefined) g.check.log = null; // 无日志流，恒 null
  return g;
}
