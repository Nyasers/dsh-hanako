// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// lib/acp-mount.js — ACP（Agent Client Protocol）进程内内部通讯通道挂载
// （feat/acp-channel，2026-09-06 用户裁定方向）
//
// 形态：宿主与 DSH 同进程（进程内 boot），在 DSH cordis ctx 上挂 @deepseek-ai/dsh-acp
// 插件，transport 用内存双工 Web Streams（TransformStream + ndJsonStream）——零端口
// 零 stdio。宿主侧用 @agentclientprotocol/sdk 的 client 连同一双工对，得到 agent 面
// 客户端（session.new/prompt/cancel 等）——指令通道内部化，HTTP /api 只服务 WebUI。
//
// 事件面不经过 ACP：继续 ctx.on 直订（dsh-events.js）——ACP 只管指令。
//
// 依赖定位（安装副本 pnpm 严格布局）：@deepseek-ai/dsh-acp 与 @agentclientprotocol/sdk
// 都不是 @deepseek-ai/dsh 的直接依赖（dsh 依赖 @deepseek-ai/dsh-acp-app，后者依赖
// dsh-acp；SDK 是 dsh-acp 的依赖）——从 dsh-acp-app 的 .pnpm 真实位置 createRequire
// 沿同层 node_modules 解析（不硬编码 hash：枚举 .pnpm/@deepseek-ai+dsh-acp-app@*，
// 取唯一匹配/首个）。
import { readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// ACP 运行时依赖定位：@deepseek-ai/dsh-acp（插件本体）与 @agentclientprotocol/sdk
// 随 DSH 依赖树存在（@deepseek-ai/dsh → @deepseek-ai/dsh-acp-app → dsh-acp，SDK 是
// dsh-acp 的依赖）——宿主不新增声明（bootstrap pnpm i -P 只装 cordis/dsh，避免 pnpm
// 全局解析重排）。从 @deepseek-ai/dsh（宿主 dependencies，顶层链接）realpath 到
// .pnpm 真实位置后 createRequire 沿依赖链解析（链接路径解析不到间接依赖）。
// 宿主**不静态 import**（静态 import 在模块加载期解析，依赖未装时崩 → onload 自动装
// 不跑 = 无法闭环）：解析与动态 import 全在 mountAcp 内（惰性，boot 时执行）。
const hostRequire = createRequire(import.meta.url);

/** 读 DSH 默认模型（dsh-home/settings.yaml agent-default-model，与 tools run.js 同源），
 * 供 ACP 插件的 provider/model 配置（ACP 创建的 agent 的 initialSelection）。读失败
 * 返回 null（调用方回退 undefined——Schema 必填失败时抛错由调用方降级）。 */
function readDefaultModel(dshHome) {
  try {
    const p = join(dshHome, "settings.yaml");
    const txt = String(readFileSync(p, "utf8"));
    const mm = txt.match(
      /agent-default-model:[\s\S]*?\n\s+model:\s*["']?([^"'\n]+)/,
    );
    const mp = txt.match(/agent-default-model:\s*\n\s+provider:\s*["']?([^"'\n]+)/);
    if (!mm || !mp) return null;
    return { provider: mp[1].trim(), model: mm[1].trim() };
  } catch {
    return null;
  }
}

/** 挂载 ACP 内部通讯通道。
 * @param ctx DSH cordis ctx（进程内 boot 的 r.ctx）
 * @param opts { pkgDir, dshHome, emitLog }
 * @returns { client, close }——client = ACP agent 面客户端（request/notify）；close =
 *   卸载（ctx.fiber.dispose 由 lifecycle 统一管，本处仅释放 client 连接）。
 * 挂载/握手失败抛错（调用方降级——WebUI 主链不依赖 ACP）。
 */
export async function mountAcp(ctx, { dshHome, emitLog }) {
  const log = (msg) => {
    try { emitLog?.("hana", "[dsh acp] " + msg); } catch { /* noop */ }
  };
  // 依赖沿 DSH 树解析（dsh realpath → dsh-acp-app → dsh-acp + SDK——见文件头注释），
  // 与 DSH 运行时同物理包实例（非 bundle 内联）；动态加载不阻塞模块加载（闭环）。
  const dshReal = realpathSync(
    dirname(hostRequire.resolve("@deepseek-ai/dsh/package.json")),
  );
  const dshRequire = createRequire(join(dshReal, "package.json"));
  const acpAppRequire = createRequire(dshRequire.resolve("@deepseek-ai/dsh-acp-app"));
  const acpPath = acpAppRequire.resolve("@deepseek-ai/dsh-acp");
  // SDK 是 dsh-acp 的依赖（不在 dsh-acp-app 层）——从 dsh-acp 解析
  const acpRequire = createRequire(acpPath);
  const acpMod = await import(/* webpackIgnore: true */ pathToFileURL(acpPath).href);
  const sdkMod = await import(/* webpackIgnore: true */ pathToFileURL(
    acpRequire.resolve("@agentclientprotocol/sdk"),
  ).href);
  const acp = acpMod.default ?? acpMod;
  const sdk = sdkMod.default ?? sdkMod;
  const ndJsonStream = sdk.ndJsonStream;
  const createAcpClientApp = sdk.client ?? sdk.ClientApp?.create;
  const methods = sdk.methods;
  if (typeof ndJsonStream !== "function" || typeof createAcpClientApp !== "function") {
    throw new Error("ACP SDK 缺 ndJsonStream/client（版本不兼容）");
  }
  // 模型配置：优先显式 provider/model 缺省读 dsh 默认（ACP agent initialSelection）
  const dm = readDefaultModel(dshHome);
  const acpConfig = {
    provider: dm?.provider,
    model: dm?.model,
  };
  // 内存双工对（零端口零 stdio）：server 侧写 a2c / 读 c2a；client 侧相反
  const a2c = new TransformStream();
  const c2a = new TransformStream();
  const agentStream = ndJsonStream(a2c.writable, c2a.readable);
  const clientStream = ndJsonStream(c2a.writable, a2c.readable);
  // 挂 ACP 插件（注入面与 web bundle 共享 services：agents/llm/sessionPersistence/sessions）
  await ctx.plugin({
    name: "dshana-acp",
    inject: [...(acp.inject || [])],
    apply: (inner) => acp.apply(inner, { ...acpConfig, stream: agentStream }),
  });
  log("插件已挂载（provider=" + (acpConfig.provider || "?") + " model=" + (acpConfig.model || "?") + "）");
  // 宿主侧 client：注册 session/update 通知缓冲（指令进展事件；L2 指令通道接入后消费）
  const updateQueue = [];
  const updateWaiters = [];
  const clientApp = createAcpClientApp({ name: "dsh-hanako-host" })
    .onNotification(methods.client.session.update, ({ params }) => {
      if (updateWaiters.length) updateWaiters.shift()(params);
      else updateQueue.push(params);
      return Promise.resolve();
    });
  const connection = clientApp.connect(clientStream);
  const client = connection.agent;
  // initialize 握手验证（协议面通 = 挂载成功门槛；失败抛错由调用方降级）。
  // 参数需 protocolVersion + clientCapabilities（SDK 方法校验，缺则 Invalid params）
  const init = await client.request(methods.agent.initialize, {
    protocolVersion: sdk.PROTOCOL_VERSION ?? 1,
    clientCapabilities: {},
  });
  log(
    "握手成功（agent=" + ((init && init.agentInfo && init.agentInfo.name) || "?") +
    " v" + ((init && init.agentInfo && init.agentInfo.version) || "?") +
    " proto=" + ((init && init.protocolVersion) || "?") + "）",
  );
  return {
    client,
    sdk,
    methods,
    takeUpdate: () =>
      updateQueue.length
        ? Promise.resolve(updateQueue.shift())
        : new Promise((r) => updateWaiters.push(r)),
    close: () => {
      try { connection.close?.(); } catch { /* noop */ }
    },
  };
}
