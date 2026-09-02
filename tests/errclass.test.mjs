// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tests/errclass.test.mjs — T1 错误分类器单测（spec：dsh-deps-zero-intervention）
// 零依赖测试：Node 内置 node:test + node:assert（无新 devDeps，无 test script——
// 验收命令 node --test tests/ 由测试运行器按 tests/**/*.test.mjs 发现本文件）。
// 覆盖：六类 errorClass 特征 + unknown 兜底 + 字段缺省容错 + 回归样本（spec「未决」：
// koffi ELIFECYCLE / ENOENT 缓存残留 / typert 133 / 网络断）作特征用例。
//
// 分类器契约（与 errclass.js 模块头一致）：classifyInstallError(input) 纯函数永不抛，
// 返回 { errorClass, guidance }，两字段恒为字符串；input 非对象/字段缺省按空串兜底。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyInstallError,
  ERROR_CLASS_GUIDANCE,
} from "../src/tools/lib/errclass.js";

// 便捷构造：字段缺省时补全为常见失败形态（exit 1），单测只覆盖关心的字段
function sig(overrides) {
  return {
    exitCode: 1,
    stdoutTail: "",
    stderrTail: "",
    milestoneLog: "",
    ...overrides,
  };
}

// 回归样本① koffi ELIFECYCLE（install script 失败，无网络/签名/环境特征）
const KOFFI_ELIFECYCLE_TEXT = [
  "> koffi@2.9.1 install",
  "> node scripts/build.js",
  "",
  "ELIFECYCLE koffi@2.9.1 install: node scripts/build.js (via node)",
  "",
].join("\n");

// 回归样本② 升级后旧 .pnpm 路径 ENOENT 缓存残留（boot/加载读已删路径）
const STALE_PNPM_ENOENT_TEXT = [
  "[错误] 读旧 .pnpm 路径失败：Error: ENOENT: no such file or directory, open",
  "'C:\\...\\node_modules\\.pnpm\\@deepseek-ai+dsh@0.1.2-alpha.4\\node_modules\\",
  "@deepseek-ai\\dsh\\lib\\entry.js'（升级后旧路径残留）",
].join(" ");

// 回归样本③ typert 133 contributor ENOENT（dsh 树内部 require.resolve 命中旧 .pnpm）
const TYPERT_133_ENOENT_TEXT = [
  "Error: Cannot find module",
  "'C:\\...\\node_modules\\.pnpm\\typert@133.0.0\\node_modules\\typert\\",
  "dist\\contributors.json'（require.resolve 命中旧 .pnpm 缓存路径）",
  "code: 'MODULE_NOT_FOUND', cause: { errno: -2, code: 'ENOENT' }",
].join(" ");

// 回归样本④ 网络断（registry 不可达）
const REGISTRY_DOWN_TEXT =
  "pnpm install 失败 @deepseek-ai/dsh（exit 1）：[pnpm] 错误：getaddrinfo ENOTFOUND registry.npmjs.org";

test("返回值结构：errorClass 与 guidance 恒为字符串", () => {
  const cases = [
    sig({ stderrTail: REGISTRY_DOWN_TEXT }),
    sig({ stderrTail: KOFFI_ELIFECYCLE_TEXT }),
    sig(),
    null,
    undefined,
    42,
    "字符串非法输入",
  ];
  for (const input of cases) {
    const r = classifyInstallError(input);
    assert.equal(typeof r, "object", "返回必须是对象");
    assert.equal(typeof r.errorClass, "string", "errorClass 恒为字符串");
    assert.equal(typeof r.guidance, "string", "guidance 恒为字符串");
    assert.ok(r.guidance.length > 0, "guidance 非空");
  }
});

test("network：ENOTFOUND / ETIMEDOUT / ECONNRESET / ECONNREFUSED / socket hang up / 超时", () => {
  const samples = [
    // 回归样本④ 网络断（registry 不可达）：官方源失败重试 npmmirror 仍断网
    REGISTRY_DOWN_TEXT,
    "ETIMEDOUT 请求 https://registry.npmmirror.com/@deepseek-ai/dsh 超时",
    "fetch failed: request to https://registry.npmjs.org/... failed, reason: connect ECONNREFUSED 10.0.0.1:443",
    "Error: read ECONNRESET",
    "socket hang up 下载 @deepseek-ai/cordis tarball 中断",
    "pnpm 引导下载超时（60000ms）：https://unpkg.com/pnpm@11.24.0/dist/pnpm.mjs",
  ];
  for (const t of samples) {
    const r = classifyInstallError(sig({ stderrTail: t }));
    assert.equal(r.errorClass, "network", "应为 network：" + t.slice(0, 60));
  }
});

test("network 优先于 native-toolchain：koffi ELIFECYCLE 含网络特征归 network（回归样本①）", () => {
  const text =
    KOFFI_ELIFECYCLE_TEXT +
    "\n> node scripts/build.js\nError: getaddrinfo ENOTFOUND registry.npmjs.org\n";
  const r = classifyInstallError(sig({ stderrTail: text }));
  assert.equal(r.errorClass, "network");
});

test("network：特征信号落在 stdoutTail / milestoneLog 也能命中（字段容缺）", () => {
  const viaStdout = classifyInstallError(
    sig({ stderrTail: "无特征", stdoutTail: "connect ECONNREFUSED 127.0.0.1:443" }),
  );
  assert.equal(viaStdout.errorClass, "network");
  const viaMilestone = classifyInstallError(
    sig({ milestoneLog: "[官方源失败] … 重试 npmmirror… 下载超时（60000ms）" }),
  );
  assert.equal(viaMilestone.errorClass, "network");
});

test("分层判定：决定性 tail 决定分类，milestoneLog 历史特征不覆盖（CodeRabbit PR #50）", () => {
  // 回归 CodeRabbit PR #50：官方源先 ENOTFOUND（network）→ npmmirror 最终
  // ERR_PNPM_NO_MATCHING_VERSION（declaration）。决定性 tail = 最后一次尝试输出 →
  // 必须归 declaration；milestoneLog 携带的历史 network 特征（模拟旧实现拼 g.deps.log
  // 全文的跨尝试污染）不得抢先覆盖（network 优先级最高，旧实现会误判 network）。
  const decisiveDecl = classifyInstallError({
    exitCode: 1,
    stderrTail:
      "[pnpm] 错误：ERR_PNPM_NO_MATCHING_VERSION No matching version found for @deepseek-ai/dsh@0.1.2-alpha.9",
    stdoutTail: "",
    milestoneLog:
      "[官方源失败] pnpm install 失败 … getaddrinfo ENOTFOUND registry.npmjs.org，重试 npmmirror…（前次尝试残留，不应参与最终分类）",
  });
  assert.equal(decisiveDecl.errorClass, "declaration");
  assert.equal(decisiveDecl.guidance, ERROR_CLASS_GUIDANCE.declaration);
  // 反向对照：决定性 tail 是 network、milestoneLog 残留 declaration → 仍归 network
  const decisiveNet = classifyInstallError({
    exitCode: 1,
    stderrTail:
      "pnpm install 失败 @deepseek-ai/dsh（exit 1）：getaddrinfo ENOTFOUND registry.npmjs.org",
    stdoutTail: "",
    milestoneLog:
      "ERR_PNPM_NO_MATCHING_VERSION 残留（历史尝试，不应参与分类）",
  });
  assert.equal(decisiveNet.errorClass, "network");
});

test("分层兜底：决定性无命中时 milestoneLog 并入仍可命中（milestoneLog 兜底语义不破坏）", () => {
  // 非 run() 的其它 throw 点（pnpm 引导失败等）只有 message → 决定性 tail 为空、
  // message 经 milestoneLog 传入：兜底层必须仍能归出类（既有 milestone-only 用例语义）
  const r = classifyInstallError({
    exitCode: 1,
    stdoutTail: "",
    stderrTail: "",
    milestoneLog:
      "pnpm 引导失败（pnpm.mjs）：下载超时（60000ms）：https://unpkg.com/pnpm@11.24.0/dist/pnpm.mjs",
  });
  assert.equal(r.errorClass, "network");
});

test("macos-signature：codesign / code signature invalid → 引导配置 nodejsPath", () => {
  const samples = [
    [
      "> koffi@2.9.1 install",
      "> node scripts/build.js",
      "Error: The binary ... is not a valid code signature (Electron node)",
      "ELIFECYCLE ...",
    ].join("\n"),
    "codesign --verify 失败：code object is not signed at all（electron node 执行 install script）",
    "Error: 签名校验失败：Electron 内置 node 无法作为系统 node 执行",
  ];
  for (const t of samples) {
    const r = classifyInstallError(sig({ stderrTail: t }));
    assert.equal(r.errorClass, "macos-signature", "应为 macos-signature：" + t.slice(0, 50));
    // 必须指向「设置 → DSHana 设置 → 自定义 NodeJS 路径」（nodejsPath 配置项）
    assert.match(r.guidance, /自定义 NodeJS 路径/);
    assert.match(r.guidance, /nodejsPath/);
  }
});

test("native-toolchain：koffi / node-pty / node-gyp ELIFECYCLE（非网络段）", () => {
  const samples = [
    // 回归样本① koffi ELIFECYCLE（install script 失败，无网络/签名特征）
    KOFFI_ELIFECYCLE_TEXT,
    [
      "node-pty@1.0.0 install: node scripts/install.js",
      "Command failed with exit code 1",
      "ELIFECYCLE ...",
    ].join("\n"),
    "gyp ERR! node-gyp rebuild 失败：缺少编译器\nELIFECYCLE cnoke@2.0.0 install",
    "node-gyp configure 失败（ELIFECYCLE）",
  ];
  for (const t of samples) {
    const r = classifyInstallError(sig({ stderrTail: t }));
    assert.equal(r.errorClass, "native-toolchain", "应为 native-toolchain：" + t.slice(0, 50));
    assert.match(r.guidance, /编译工具链/);
  }
});

test("native-toolchain：特征信号落在 milestoneLog 也能命中", () => {
  const r = classifyInstallError(
    sig({
      milestoneLog: "[依赖安装] pnpm:lifecycle exit=1\nELIFECYCLE koffi@2.9.1 install: node scripts/build.js",
    }),
  );
  assert.equal(r.errorClass, "native-toolchain");
});

test("declaration：ERR_PNPM_* 404 / peer 冲突 / invalid spec / 版本不存在 / 声明非法", () => {
  const samples = [
    "[pnpm] 错误：ERR_PNPM_FETCH_404 GET https://registry.npmjs.org/@deepseek-ai/dsh - 404 Not Found",
    "[pnpm] 错误：ERR_PNPM_PEER_DEP_ISSUES … Peer dependencies that are not met: @deepseek-ai/cordis@4.0.2",
    "ERR_PNPM_NO_MATCHING_VERSION No matching version found for @deepseek-ai/dsh@^0.1.3",
    "[pnpm] 错误：Invalid spec: \"@deepseek-ai/dsh@npm:evil@1.0.0\" is not a valid dependency",
    "[pnpm] 错误：找不到 @deepseek-ai/dsh@0.1.2-alpha.9 版本（registry 无此版本）",
    "插件声明缺少合法 @deepseek-ai/dsh 版本（dependencies 未声明或非法）",
  ];
  for (const t of samples) {
    const r = classifyInstallError(sig({ stderrTail: t }));
    assert.equal(r.errorClass, "declaration", "应为 declaration：" + t.slice(0, 50));
    assert.match(r.guidance, /上报|插件声明|上游/);
  }
});

test("environment：EBUSY 锁 → 自动重试引导（无操作指引）；ENOSPC/EACCES/EPERM → 引导清理", () => {
  const busy = classifyInstallError(
    sig({ stderrTail: "EBUSY: resource busy or locked, rmdir '...node_modules\\.pnpm'" }),
  );
  assert.equal(busy.errorClass, "environment");
  assert.match(busy.guidance, /自动重试/);
  assert.doesNotMatch(busy.guidance, /清理磁盘/); // EBUSY 是锁，非空间

  const noSpace = classifyInstallError(
    sig({ stderrTail: "ENOSPC: no space left on device, write '...node_modules...'" }),
  );
  assert.equal(noSpace.errorClass, "environment");
  assert.match(noSpace.guidance, /清理磁盘/);

  const permDenied = classifyInstallError(
    sig({ stderrTail: "EACCES: permission denied, mkdir 'C:\\...\\node_modules'" }),
  );
  assert.equal(permDenied.errorClass, "environment");
  assert.match(permDenied.guidance, /权限/);

  const eperm = classifyInstallError(
    sig({ stderrTail: "EPERM: operation not permitted, unlink '...node.cmd'" }),
  );
  assert.equal(eperm.errorClass, "environment");
});

test("unknown 兜底：ENOENT 缓存残留 / 无特征文本 / 仅退出码", () => {
  // 回归样本②③：ENOENT（文件/目录不存在）不在特征表内——非 environment 的权限/空间/
  // 锁三特征（旧 .pnpm 路径残留是缓存/中断遗留，用户无操作面），落 unknown 保守重试 +
  // 标记需诊断（理由见 errclass.js 模块头 ENOENT 归属说明）
  for (const t of [STALE_PNPM_ENOENT_TEXT, TYPERT_133_ENOENT_TEXT]) {
    const r = classifyInstallError(sig({ stderrTail: t }));
    assert.equal(r.errorClass, "unknown", "ENOENT 缓存残留应归 unknown：" + t.slice(0, 50));
  }
  // ELIFECYCLE 但无原生包名（非 native 模块的脚本失败）：无特征 → unknown
  const lifecycleOnly = classifyInstallError(
    sig({ stderrTail: "ELIFECYCLE some-pure-js-pkg@1.0.0 install: node scripts/x.js" }),
  );
  assert.equal(lifecycleOnly.errorClass, "unknown");
  // 完全无特征文本
  const gibberish = classifyInstallError(
    sig({ stderrTail: "frobnicate widget 崩溃（0xDEADBEEF）" }),
  );
  assert.equal(gibberish.errorClass, "unknown");
});

test("容错：input 缺字段 / 非对象 / 空信号 → unknown 不抛异常", () => {
  const cases = [
    undefined, // 无参数
    null,
    {},
    { exitCode: 1 }, // 只有退出码（文本全空，退出码不参与归类）
    { exitCode: 1, stderrTail: "", stdoutTail: undefined, milestoneLog: null },
    42,
    "ENOTFOUND registry.npmjs.org", // 非对象输入整体按空串兜底（结构化信号约定）
    [],
  ];
  for (const input of cases) {
    const r = classifyInstallError(input);
    assert.equal(r.errorClass, "unknown");
    assert.equal(r.guidance, ERROR_CLASS_GUIDANCE.unknown);
  }
});

test("大小写与换行形态：特征文本大小写不敏感、跨 CRLF/多行可命中", () => {
  // install.js pnpmErrorTail 产出的文本经行规范化后为 \n 分隔；真实错误码恒大写，
  // 但外部工具链输出可能小写——分类器统一 /i 匹配
  const mixed = classifyInstallError(
    sig({
      stderrTail:
        "> koffi@2.9.1 install\r\n> node scripts/build.js\r\nelifecycle: command failed\r\n",
    }),
  );
  assert.equal(mixed.errorClass, "native-toolchain");
  const lowerNetwork = classifyInstallError(
    sig({ stderrTail: "getaddrinfo enotfound registry.npmjs.org" }),
  );
  assert.equal(lowerNetwork.errorClass, "network");
});
