// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/errclass.js — 依赖安装失败错误分类器（spec：dsh-deps-zero-intervention，T1 纯函数）
//
// 背景（spec「错误只看 exit 1 无法引导」）：install/boot 失败时只看到退出码无法决定
// 策略——分类才决定退避重试 / 停+引导 / 等条件续跑与用户指引。本模块把结构化失败
// 信号（pnpm 退出码、stdout/stderr 尾、里程碑日志）归类为六类 errorClass，每类带
// 一句面向用户的中文引导（guidance）。分类结果 = 退避重试调度器（T2）与 Bootstrap
// 诊断页（T3/T4）的输入，落 g.deps.errorClass（见 install.js 失败路径接入）。
//
// 纯函数纪律：无 I/O、不读单例状态、不抛异常；input 非对象 / 字段缺省一律按空串
// 兜底（exitCode 仅作上下文参考，不参与归类——这些失败路径退出码恒非零，本身无法
// 区分故障类），内部不可能失败，最坏落 unknown（保守可重试 + 标记需诊断）。
//
// 特征表（与 spec.md「1. 错误分类器」逐行对应）：
//   network            ENOTFOUND / EAI_AGAIN / ECONNRESET / ECONNREFUSED / ETIMEDOUT /
//                      socket hang up / 下载连接超时（registry/CDN 不可达）
//   macos-signature    codesign / code signature invalid（内置 Electron Node 执行 install
//                      script 触发签名校验失败）
//   native-toolchain   ELIFECYCLE（或 command failed）× koffi/node-pty/cnoke/node-gyp
//   declaration        ERR_PNPM_*（404 / peer 冲突 / invalid spec / 版本不存在 / 声明非法）
//   environment        EACCES / EPERM / EBUSY / ENOSPC（锁重试 / 权限与空间引导清理）
//   unknown            兜底（保守可重试 + 标记需诊断）
//
// 匹配优先级（从具体到一般，防止错误引导）：
//   ① network 最高——回归样本①「koffi ELIFECYCLE 且含网络特征时归 network」：install
//      script 内嵌的网络下载失败根因是网络而非工具链；
//   ② macos-signature——与 native 同是 ELIFECYCLE 场景，但签名问题指引「配置
//      nodejsPath」而非装工具链，须先于 native 命中；
//   ③ environment——OS 层具体错误（权限/空间/锁）优先于猜测性的工具链/声明问题
//      （如 koffi 编译撞 EACCES 是权限问题，指引装工具链无意义）；
//   ④ native-toolchain——ELIFECYCLE × 原生包名（「非网络段」由 ① 前置保证）；
//   ⑤ declaration——ERR_PNPM_* / 404 / peer 冲突 / 非法 spec / 版本不存在；
//   ⑥ unknown——兜底（含 ENOENT，理由见下）。
//
// ENOENT 归属说明（回归样本②③）：ENOENT（文件/目录不存在）不在特征表内，本模块落
// unknown 而非 environment——environment 三特征是权限/空间/锁（用户可操作的本地状态），
// 而样本②「升级后旧 .pnpm 路径 ENOENT 缓存残留」、样本③「dsh 树内部 require.resolve
// 命中旧 .pnpm（typert 133 contributor ENOENT）」是进程内缓存指向已删 .pnpm 路径的
// 残留（自愈靠清理缓存/重装，用户无操作面），归 unknown 走保守重试 + 诊断标记最贴切。
//
// 回归样本 → errorClass（tests/errclass.test.mjs 覆盖）：
//   ① koffi ELIFECYCLE（install script 失败）       → native-toolchain（含网络特征 → network）
//   ② 升级后旧 .pnpm 路径 ENOENT 缓存残留            → unknown
//   ③ typert 133 contributor ENOENT                  → unknown
//   ④ 网络断（registry 不可达）                       → network
//
// 注释风格保持宿主侧（中文/双引号/分号），与 lib 侧其它模块一致。

// ---- 单类中文引导文案 ----
// 要求（tasks.md T1）：每类一句面向用户的人话 + 必要操作步骤；network/declaration/
// unknown 不做操作指引（自动重试或上报）。文案导出供 install.js 预判失败路径（声明
// 非法提前返回等）直取复用，避免同文案散落两处。
export const ERROR_CLASS_GUIDANCE = Object.freeze({
  network:
    "网络不可达（registry/CDN 连接失败）：插件会自动退避重试，网络恢复后自动继续，无需手动操作。",
  "macos-signature":
    "macOS 代码签名校验失败（内置 Electron Node 无法执行依赖安装脚本）：请在「设置 → DSHana 设置 → 自定义 NodeJS 路径」（nodejsPath 配置项）填入系统 Node 绝对路径（如 /opt/homebrew/bin/node），保存后插件会自动续跑。",
  "native-toolchain":
    "原生模块编译失败（install 脚本退出，多为 koffi / node-pty / cnoke 等）：请安装系统编译工具链——macOS 执行「xcode-select --install」安装 Command Line Tools，Windows 安装 Visual Studio Build Tools；完成后插件会自动重试。",
  declaration:
    "依赖声明解析失败（ERR_PNPM_*：包或版本不存在 / peer 冲突 / 非法 spec）：属插件声明或上游 registry 问题，请等待插件更新或将诊断详情上报插件作者，无需手动操作。",
  environment:
    "系统环境问题（文件占用 / 权限不足 / 磁盘空间不足）：插件会自动重试，权限与空间问题请按需清理后等待自动恢复。",
  unknown:
    "未能识别本次安装失败的原因：插件会保守自动重试并记录诊断日志，若持续失败请将诊断详情上报插件作者。",
});

// environment 细类引导（同 errorClass=environment，按具体原因给不同指引；spec：
// EBUSY 锁 → 重试；空间/权限 → 引导清理）
const ENVIRONMENT_GUIDANCE_EBUSY =
  "安装目标文件被占用（EBUSY，多为杀软实时扫描或并发依赖操作锁定）：插件会自动重试，无需手动操作。";
const ENVIRONMENT_GUIDANCE_ENOSPC =
  "磁盘空间不足（ENOSPC）：请清理磁盘释放空间，插件会自动重试。";
const ENVIRONMENT_GUIDANCE_PERM =
  "文件或目录权限不足（EACCES/EPERM）：请以有写权限的用户运行，或将插件目录与数据目录加入杀软/安全软件白名单，插件会自动重试。";

// ---- 特征正则表 ----
// 全部非 /g 修饰（/g 的 lastIndex 会跨调用残留导致误判）；命中任一即算该类。
// network：Node 网络错误码 + socket hang up + 引导下载/连接超时（中文形态）。
const NETWORK_PATTERNS = [
  /\bENOTFOUND\b/i,
  /\bEAI_AGAIN\b/i,
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bETIMEDOUT\b/i,
  /socket\s*hang\s*up?/i,
  /(?:下载|连接|请求)\s*超时/,
];

// macos-signature：codesign / code signature invalid（含中文「签名校验失败」形态）。
const MACOS_SIGNATURE_PATTERNS = [
  /\bcodesign\b/i,
  /code\s+signature/i,
  /signature\s+invalid/i,
  /(?:代码)?签名(?:校验|检查|验证)?\s*(?:失败|错误|不通过)/,
];

// environment：EACCES / EPERM / EBUSY / ENOSPC（细类判定在 environmentKind 内按序）。
const ENVIRONMENT_KIND_EBUSY = /\bEBUSY\b/i;
const ENVIRONMENT_KIND_ENOSPC = /\bENOSPC\b/i;
const ENVIRONMENT_KIND_PERM = /\b(?:EACCES|EPERM)\b/i;

// native-toolchain 两半：生命周期脚本失败信号 × 原生模块名（两者都命中才算）。
const LIFECYCLE_FAIL_PATTERNS = [/\bELIFECYCLE\b/i, /\bCommand\s+failed\b/i];
const NATIVE_MODULE_PATTERNS = [
  /\b(?:koffi|node-pty|cnoke)\b/i,
  /node-gyp/i,
  /gyp\s+ERR/i,
];

// declaration：pnpm 规范错误码（ERR_PNPM_*）+ 404 + peer 冲突 + invalid spec +
// 版本不存在 + 「声明缺少/非法」中文形态（install.js 声明校验提前返回路径共用）。
const DECLARATION_PATTERNS = [
  /ERR_PNPM_[A-Z0-9_]+/i,
  /\b404\b/,
  /peer\s+(?:dependencies?|conflicts?|issues?)/i,
  /no\s+matching\s+version/i,
  /invalid\s+(?:spec|version|range|semver|package\s*name)/i,
  /版本(?:不存在|未找到|找不到)|找不到\s*.*版本/,
  /(?:插件)?声明(?:缺少|缺失|非法|不合法|无效)/,
];

// 任一正则命中（正则表都是非 /g 的简单匹配，test 无状态）
function anyMatch(patterns, text) {
  for (const re of patterns) if (re.test(text)) return true;
  return false;
}

// 组装返回结构 { errorClass, guidance }
function result(errorClass, guidance) {
  return { errorClass, guidance };
}

// environment 细类（EBUSY → ENOSPC → 权限；均非空文本才判定，空输入走 unknown）
function environmentKind(text) {
  if (!text) return null;
  if (ENVIRONMENT_KIND_EBUSY.test(text))
    return result("environment", ENVIRONMENT_GUIDANCE_EBUSY);
  if (ENVIRONMENT_KIND_ENOSPC.test(text))
    return result("environment", ENVIRONMENT_GUIDANCE_ENOSPC);
  if (ENVIRONMENT_KIND_PERM.test(text))
    return result("environment", ENVIRONMENT_GUIDANCE_PERM);
  return null;
}

// 分类入口：结构化信号 → { errorClass, guidance }（纯函数，永不抛，见模块头）
export function classifyInstallError(input) {
  // 容错：input 非对象 / 字段缺省按空串处理（不抛异常）
  const s = input && typeof input === "object" ? input : {};
  const text = [
    typeof s.stderrTail === "string" ? s.stderrTail : "",
    typeof s.stdoutTail === "string" ? s.stdoutTail : "",
    typeof s.milestoneLog === "string" ? s.milestoneLog : "",
  ]
    .filter((x) => x !== "")
    .join("\n");
  if (anyMatch(NETWORK_PATTERNS, text))
    return result("network", ERROR_CLASS_GUIDANCE.network);
  if (anyMatch(MACOS_SIGNATURE_PATTERNS, text))
    return result("macos-signature", ERROR_CLASS_GUIDANCE["macos-signature"]);
  const env = environmentKind(text);
  if (env) return env;
  if (
    anyMatch(LIFECYCLE_FAIL_PATTERNS, text) &&
    anyMatch(NATIVE_MODULE_PATTERNS, text)
  )
    return result("native-toolchain", ERROR_CLASS_GUIDANCE["native-toolchain"]);
  if (anyMatch(DECLARATION_PATTERNS, text))
    return result("declaration", ERROR_CLASS_GUIDANCE.declaration);
  return result("unknown", ERROR_CLASS_GUIDANCE.unknown);
}
