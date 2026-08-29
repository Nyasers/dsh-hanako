// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/provider — 让 dsh 直接复用 Hana 宿主的 provider 配置并完全跟随（v0.9.3）。
//
// 语义：dsh 启动器 --patch 只负责加载本插件本体（v0.22.1+ 静态 patch，config 恒空）；
// provider 数据绝不经 patch 注入，一律由宿主侧组装后经 dshana.bus 消息总线下发：
//   · 组装在宿主：宿主读 models.json + provider-catalog.json，mapModel/readHostConfig 对
//     每个 provider 校验 apiKey/baseURL/api 支持/models 非空 → 组装 route 目录，经
//     总线 emit("provider.refresh", { routes }) 传给本插件（v0.22.1+ 替代 POST 
//     /api/hana-provider.refresh HTTP push——HTTP push 链路已退役）
//   · 本插件只接受：applySnapshot(routes) 消费宿主 push 的 route 目录（不读文件，不
//     mapModel/readHostConfig/readJsonFile——这些已上移宿主侧）。启动时 snapshot 为空
//     （不读文件、不依赖 patch data），首个 routes 由宿主 web host 就绪后主动 push 填上
//   · 跟随：宿主侧 ctx.resources.watch 感知两文件变化（bus 派发 resource.changed）→ 防抖
//     push 最新 routes → handle.replace() 原子更新；routes 缺失/为空保留旧 snapshot 记日志
//   · 诊断日志：经 @dsh-hanako/logger 统一日志服务（inject ['hanaLogger']）→ dshanaBus
//     log 帧转发写宿主会话文件（v0.22.1+ 不再写 logPath 文件，行格式
//     [<HH:mm:ss.SSS>] [provider] <内容> 由宿主侧统一），refresh 成功/失败/收到刷新请求
//     写入同一文件；服务未就绪/写失败时静默跳过（日志失败不阻断）
//
// compat 映射（定稿）：
//   · Hana compat.thinkingFormat → pi-ai compat.thinkingFormat 直通
//   · Hana compat.supportsDeveloperRole → pi-ai compat.supportsDeveloperRole 直通
//     （boolean 时；pi-ai 在 reasoning && supportsDeveloperRole 时用 developer role，
//     未传回退检测值默认 true——sensenova 等 API 只认 system，此值必须显式传下去）
//   · reasoningProfile / reasoningReplay / hanaVideoInput / hanaAudioInput → 丢弃
//     （pi-ai openai-completions 原生处理 deepseek reasoning_content 解析与回放）
//   · 模型 xhigh: true → compat.supportsReasoningEffort: true
//   · 模型 defaultThinkingLevel → pi-ai thinking 级别（off/minimal/low/medium/high/xhigh/max）
//   · 模型 reasoning → pi-ai model reasoning；id/name/contextWindow/maxTokens/input 直通
//
// 依赖解析：插件文件位于 dsh 安装树之外（插件安装目录 dsh-plugin），Node ESM
// 裸导入无法解析 pi-ai/dsh-llm（实测 ERR_MODULE_NOT_FOUND，node_modules 沿插件文件
// 向上找、够不到数据目录 dsh-pkg）——因此经总线配置 dshanaBus.getConfig().dshPkgDir
// （v0.22.1+；宿主 bus ready 后 config 帧下发，替代 patch config 注入）指向的 dsh-pkg 按
// import 语义解析包入口（package.json 的 exports/main，见 resolvePkgEntry）+ file://
// 动态导入；回退 DSH_HOME 反推（dirname(DSH_HOME)/dsh-pkg）与裸导入兜底。任何依赖
// 不可用 → 插件降级为空操作并记日志，不阻断 dsh 启动。
//
// 注册：ctx.llm.registerAdapter(routes, adapter) + registerConfigurableProviders(entries)
// （settingsNs 用本插件专用名，dsh 侧无对应 settings 分节 → models 页显示为「未配置」
// 行，配置只读跟随 Hana，编辑仍发生在宿主）。stream 委托 pi-ai provider。
//
// 服务依赖（关键）：必须 export const inject = ['llm', 'hanaLogger', 'dshanaBus'] 声明依赖
// （同 dsh-llm-pi-ai 姿势）——cordis 服务注入经 inject 声明生效，无声明则 apply 内
// ctx.llm 抛 "cannot get property llm without inject"（被下方 try/catch 吞掉 → 插件
// 静默停用）。dshanaBus 用于：① dshPkgDir 经 getConfig() 获取（替代 patch config 注入）
// ② 订阅 provider.refresh 事件（宿主 push 通知入口，v0.22.1+ 替代 /api/hana-provider.refresh
// HTTP 路由——webServer 已不再注入）；logger 为 @dsh-hanako/logger 统一日志服务。
// 另注意：勿给模块加 default 导出——Entry 加载器提取 default 会丢具名导出（inject 失效）。
//
// 容错纪律：apply 全程 try/catch 不抛出——依赖缺失/配置缺失/解析失败只记日志，
// 插件降级为空操作，不阻断 dsh 启动（边界要求）。

export const name = "@dsh-hanako/provider";
export const inject = ["llm", "hanaLogger", "dshanaBus"];

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300000;

const NS = "@dsh-hanako/provider";
const DEP_SPECS = {
  piAi: "@earendil-works/pi-ai",
  piAiCompletions: "@earendil-works/pi-ai/api/openai-completions.lazy",
  piAiResponses: "@earendil-works/pi-ai/api/openai-responses.lazy",
  piAiAnthropic: "@earendil-works/pi-ai/api/anthropic-messages.lazy",
  llm: "@deepseek-ai/dsh-llm",
  timeout: "@deepseek-ai/dsh-timeout",
};

// ---- 依赖加载（见文件头「依赖解析」）----
// 解析 dsh-pkg/node_modules 内的包入口：尊重 package.json 的 exports/main。
// 不用 createRequire().resolve——pi-ai 的 exports 只有 "import" 条件，CJS resolve 会以
// "No exports main defined" 拒绝；这里按 import 语义手工解析（含 "./api/*" 通配模式）。
function resolvePkgEntry(nmDir, spec) {
  const parts = spec.split("/");
  const scoped = spec.startsWith("@");
  const name = scoped ? parts.slice(0, 2).join("/") : parts[0];
  const sub = scoped ? parts.slice(2).join("/") : parts.slice(1).join("/");
  const pkgDir = join(nmDir, ...name.split("/"));
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  const exportsMap = pkg.exports;
  if (exportsMap && typeof exportsMap === "object") {
    const key = sub ? `./${sub}` : ".";
    // 先精确键，再通配模式键（如 "./api/*"）
    let entry = resolveCondition(exportsMap[key], pkgDir);
    if (!entry && sub) {
      for (const [pattern, target] of Object.entries(exportsMap)) {
        if (!pattern.includes("*")) continue;
        const [prefix, suffix] = pattern.split("*");
        if (key.startsWith(prefix) && key.endsWith(suffix)) {
          const star = key.slice(prefix.length, key.length - suffix.length);
          entry = resolveCondition(target, pkgDir, star);
          if (entry) break;
        }
      }
    }
    if (entry) return pathToFileURL(entry).href;
  }
  return pathToFileURL(join(pkgDir, pkg.main || "index.js")).href;
}

function resolveCondition(cond, pkgDir, star) {
  if (typeof cond === "string")
    return join(pkgDir, cond.replaceAll("*", star ?? ""));
  if (cond && typeof cond === "object") {
    if (typeof cond.import === "string")
      return join(pkgDir, cond.import.replaceAll("*", star ?? ""));
    if (typeof cond.default === "string")
      return join(pkgDir, cond.default.replaceAll("*", star ?? ""));
    for (const value of Object.values(cond)) {
      const resolved = resolveCondition(value, pkgDir, star);
      if (resolved) return resolved;
    }
  }
  return null;
}

async function loadDeps(config, getBusDshPkgDir) {
  const bases = [];
  const home = process.env.DSH_HOME;
  // profiles/node_modules 优先：dsh 的 junction farm 全量依赖视图（与 dsh 运行时
  // 一致）。pnpm 严格结构下 dsh-pkg/node_modules 只链接直接声明的依赖，间接依赖
  // （@earendil-works/pi-ai 等）不在顶层——npm 扁平时代是幽灵依赖碰巧可用，
  // pnpm 下必须走 profiles 全量视图，否则依赖解析失败、插件降级空转（已挂载但
  // 供应商不注册、宿主 push 未送达/总线未连接）。
  if (home) bases.push(join(home, "profiles"));
  // v0.22.1+：dshPkgDir 来自总线配置（dshanaBus.getConfig()，宿主 config 帧下发）；
  // apply 阶段可能尚未到达（hello 前），届时为 null → 走 DSH_HOME 反推兜底（同路径）
  try {
    const busPkgDir = typeof getBusDshPkgDir === "function" ? getBusDshPkgDir() : null;
    if (typeof busPkgDir === "string" && busPkgDir) bases.push(busPkgDir);
  } catch {
    /* 总线配置读取失败：走 DSH_HOME 反推 */
  }
  if (config && typeof config.dshPkgDir === "string" && config.dshPkgDir)
    bases.push(config.dshPkgDir);
  if (home) bases.push(join(dirname(home), "dsh-pkg"));
  const out = {};
  for (const [key, spec] of Object.entries(DEP_SPECS)) {
    let mod = null;
    for (const base of bases) {
      try {
        mod = await import(resolvePkgEntry(join(base, "node_modules"), spec));
        break;
      } catch {
        /* 该基座不可解析，试下一个 */
      }
    }
    if (mod === null) {
      // 裸导入兜底：插件若未来被置于 dsh 安装树内（node_modules 可达）仍可用
      try {
        mod = await import(spec);
      } catch {
        /* 依赖不可用 */
      }
    }
    if (mod === null)
      return {
        error: new Error(
          `无法解析依赖 ${spec}（已尝试 config.dshPkgDir / DSH_HOME 基座与裸导入）`,
        ),
      };
    out[key] = mod;
  }
  return out;
}

// ---- 组装：pi-ai provider + LlmAdapter（参考 dsh-llm-pi-ai 的 buildProvider/routeAuth/apply 段）----
// 凭据由本插件直读 catalog，走 pi-ai 的 apiKey override 通道（options.apiKey 优先级最高，
// provider.auth 的 resolve 只在无 override 时被问询），因此 auth 提供最简 api-key 形状即可
function harnessApiKeyAuth(name) {
  return {
    name,
    resolve: ({ credential }) =>
      Promise.resolve({
        auth:
          credential && credential.key !== undefined
            ? { apiKey: credential.key }
            : {},
        source: name,
      }),
  };
}

export async function apply(ctx, config) {
  // 全程容错：任何失败只记日志，插件降级为空操作，不阻断 dsh 启动
  try {
    // ---- 总线配置持有者（v0.22.1+）：dshPkgDir 经 dshanaBus.getConfig() 获取（宿主
    // bus ready 后 config 帧下发，替代 patch config 注入）。inject 回调在服务提供后
    // 异步执行（apply 同步段可能先跑），loadDeps 经 getter 惰性读取——配置未到达时
    // 返回 null，loadDeps 走 DSH_HOME 反推兜底（同路径）。----
    let busConfigHolder = null;
    try {
      ctx.inject(["dshanaBus"], (busCtx) => {
        try {
          busConfigHolder = busCtx.dshanaBus?.getConfig?.() ?? null;
        } catch {
          /* 配置读取失败按未下发处理 */
        }
      });
    } catch {
      /* 注入失败降级：loadDeps 走 DSH_HOME 反推 */
    }
    const getBusDshPkgDir = () => {
      try {
        const bc = busConfigHolder;
        return bc && typeof bc.dshPkgDir === "string" && bc.dshPkgDir
          ? bc.dshPkgDir
          : null;
      } catch {
        return null;
      }
    };
    const deps = await loadDeps(config, getBusDshPkgDir);
    if (!deps || deps.error) {
      ctx.logger.error(
        `[@dsh-hanako/provider] 依赖加载失败，插件停用：${deps?.error?.message || deps?.error || "未知错误"}`,
      );
      return;
    }
    const {
      LlmAdapter,
      LlmError,
      CallId,
      ReasoningEffortId,
      attributionHeaders,
      contentHasImage,
      isContextWindowExceededError,
      isQuotaExceededError,
      CONTEXT_WINDOW_EXCEEDED_CODE,
      EMPTY_RESPONSE_CODE,
      QUOTA_EXCEEDED_CODE,
    } = deps.llm;
    const { createProvider, getSupportedThinkingLevels, isContextOverflow } =
      deps.piAi;
    const { idleWatchdog, timeoutOf } = deps.timeout;
    const apiFactories = {
      "openai-completions": () => deps.piAiCompletions.openAICompletionsApi(),
      "openai-responses": () => deps.piAiResponses.openAIResponsesApi(),
      "anthropic-messages": () => deps.piAiAnthropic.anthropicMessagesApi(),
    };
    // 诊断日志：经 @dsh-hanako/logger 统一日志服务（inject ['hanaLogger']）写入本次会话日志，
    // 行格式 [<HH:mm:ss.SSS>] [provider] <内容>（与宿主侧 appendLog 一致）；
    // 服务未就绪/写失败静默（日志失败不阻断）
    let loggerSvc = null;
    ctx.inject(["hanaLogger"], (logCtx) => {
      loggerSvc = logCtx.hanaLogger;
    });
    const providerLog = (msg) => {
      try {
        loggerSvc?.log("provider", msg);
      } catch {
        /* 日志失败不阻断 */
      }
    };

    // ---- 消息转换：harness message → pi-ai Context（复刻 dsh-llm-pi-ai 的
    // textOnlyContext / toPiContextWithImages / foreignAssistant 语义）----
    const flattenText = (message) =>
      message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    const toolResultText = (blocks) =>
      blocks
        .map((b) =>
          b.type === "text"
            ? b.text
            : b.type === "tool-result"
              ? toolResultText(b.content)
              : "",
        )
        .join("");
    const parseArguments = (raw) => {
      try {
        const parsed = JSON.parse(raw);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed)
        )
          return parsed;
      } catch {
        /* 容忍模型畸形参数 */
      }
      return {};
    };
    const emptyPiUsage = () => ({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    // 历史 assistant 一律按「外来消息」转换（replay 按定稿表丢弃——pi-ai 的
    // openai-completions 实现原生处理 deepseek reasoning_content 解析与回放）
    const foreignAssistant = (message) => {
      const source =
        message.source && message.source.kind === "model"
          ? message.source
          : undefined;
      const content = [];
      for (const block of message.content) {
        if (block.type === "text")
          content.push({ type: "text", text: block.text });
        else if (block.type === "reasoning")
          content.push({ type: "thinking", thinking: block.text });
        else if (block.type === "tool-call")
          content.push({
            type: "toolCall",
            id: block.id,
            name: block.name,
            arguments: parseArguments(block.arguments),
          });
        else if (block.type === "image")
          throw new LlmError(
            "pi-ai 历史无法表达结构化图像输出",
            "UNSUPPORTED_CONTENT",
          );
      }
      return {
        role: "assistant",
        content,
        api: "dsh-foreign",
        provider: source && source.provider ? source.provider : "dsh-foreign",
        model: source && source.model ? source.model : "dsh-foreign",
        usage: emptyPiUsage(),
        stopReason: content.some((piece) => piece.type === "toolCall")
          ? "toolUse"
          : "stop",
        timestamp: 0,
      };
    };
    const userContent = async (blocks, attachments) => {
      const content = [];
      for (const block of blocks) {
        if (block.type === "text") {
          if (block.text.length > 0)
            content.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          const stored = await attachments.readImage(block.attachment);
          content.push({
            type: "image",
            data: Buffer.from(stored.data).toString("base64"),
            mimeType: stored.ref.mediaType,
          });
        } else if (block.type === "tool-result") {
          const nested = await userContent(block.content, attachments);
          if (typeof nested === "string") {
            if (nested.length > 0) content.push({ type: "text", text: nested });
          } else content.push(...nested);
        }
      }
      if (content.every((b) => b.type === "text"))
        return content.map((b) => b.text).join("");
      return content;
    };
    const piContext = (options, messages) => ({
      ...(options.system !== undefined ? { systemPrompt: options.system } : {}),
      messages,
      ...(Array.isArray(options.tools) && options.tools.length > 0
        ? {
            tools: options.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          }
        : {}),
    });
    const textOnlyContext = (options) => {
      const toolNames = new Map();
      const messages = [];
      for (const message of options.messages) {
        if (contentHasImage(message.content))
          throw new LlmError(
            "图像输入需要 durable attachment 服务",
            "UNSUPPORTED_CONTENT",
          );
        if (message.role === "system") {
          messages.push({
            role: "user",
            content: flattenText(message),
            timestamp: 0,
          });
          continue;
        }
        if (message.role === "assistant") {
          const assistant = foreignAssistant(message);
          for (const block of assistant.content)
            if (block.type === "toolCall")
              toolNames.set(CallId(block.id), block.name);
          messages.push(assistant);
          continue;
        }
        const text = flattenText(message);
        const results = message.content.filter((b) => b.type === "tool-result");
        if (text.length > 0 || results.length === 0)
          messages.push({ role: "user", content: text, timestamp: 0 });
        for (const result of results) {
          messages.push({
            role: "toolResult",
            toolCallId: result.toolCallId,
            toolName: toolNames.get(result.toolCallId) ?? "unknown",
            content: [
              {
                type: "text",
                text: toolResultText(result.content) || "(no output)",
              },
            ],
            isError: result.isError ?? false,
            timestamp: 0,
          });
        }
      }
      return piContext(options, messages);
    };
    const toPiContextWithImages = async (options, attachments) => {
      const toolNames = new Map();
      const messages = [];
      for (const message of options.messages) {
        if (message.role === "system") {
          if (contentHasImage(message.content))
            throw new LlmError(
              "pi-ai 无法在历史 system 消息中表达图像",
              "UNSUPPORTED_CONTENT",
            );
          messages.push({
            role: "user",
            content: flattenText(message),
            timestamp: 0,
          });
          continue;
        }
        if (message.role === "assistant") {
          const assistant = foreignAssistant(message);
          for (const block of assistant.content)
            if (block.type === "toolCall")
              toolNames.set(CallId(block.id), block.name);
          messages.push(assistant);
          continue;
        }
        const content = await userContent(
          message.content.filter((b) => b.type !== "tool-result"),
          attachments,
        );
        const results = message.content.filter((b) => b.type === "tool-result");
        if (content.length > 0 || results.length === 0)
          messages.push({ role: "user", content, timestamp: 0 });
        for (const result of results) {
          const resultContent = await userContent(result.content, attachments);
          messages.push({
            role: "toolResult",
            toolCallId: result.toolCallId,
            toolName: toolNames.get(result.toolCallId) ?? "unknown",
            content:
              typeof resultContent === "string"
                ? [{ type: "text", text: resultContent || "(no output)" }]
                : resultContent,
            isError: result.isError ?? false,
            timestamp: 0,
          });
        }
      }
      return piContext(options, messages);
    };
    const toPiContext = (options, attachments) =>
      attachments === undefined
        ? textOnlyContext(options)
        : toPiContextWithImages(options, attachments);

    // ---- 流转换：pi-ai 事件 → harness StreamChunks（复刻 dsh-llm-pi-ai 的
    // toStreamChunks / mapUsage / mapStopReason / classifyPiAiError 语义）----
    const mapUsage = (usage) => ({
      inputTokens: usage.input,
      outputTokens: usage.output,
      ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
      ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
    });
    const classifyPiAiError = (message) => {
      if (/\b(?:401|403)\b/.test(message)) return "AUTH";
      if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
      if (/\b429\b|rate.?limit/i.test(message)) return "RATE_LIMIT";
      if (/\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";
      if (/\b5\d\d\b/.test(message)) return "SERVER";
      if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return "TIMEOUT";
      if (/stream ended (?:before|without)\b/i.test(message))
        return "TRANSPORT";
      if (
        /\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(
          message,
        ) ||
        /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(
          message,
        ) ||
        /\bterminated\b|premature close/i.test(message)
      )
        return "TRANSPORT";
      return "PI_AI_ERROR";
    };
    const mapStopReason = (message, contextWindow) => {
      const piAiOverflow = isContextOverflow(message, contextWindow);
      const harnessOverflow =
        message.stopReason === "error" &&
        message.errorMessage !== undefined &&
        isContextWindowExceededError(message.errorMessage);
      if (piAiOverflow || harnessOverflow) {
        return {
          kind: "error",
          failure: {
            message:
              message.errorMessage ??
              `pi-ai 检测到模型 "${message.model}" 上下文溢出`,
            code: CONTEXT_WINDOW_EXCEEDED_CODE,
          },
        };
      }
      switch (message.stopReason) {
        case "stop":
          if (message.content.length === 0)
            return {
              kind: "error",
              failure: {
                message: `模型 "${message.model}" 返回了无内容的完成响应`,
                code: EMPTY_RESPONSE_CODE,
              },
            };
          return { kind: "stop" };
        case "length":
          return { kind: "max-tokens" };
        case "toolUse":
          return { kind: "tool-calls" };
        case "aborted":
          return {
            kind: "aborted",
            failure: {
              message: message.errorMessage ?? "pi-ai 流被中止",
              code: "ABORTED",
            },
          };
        case "error": {
          const text = message.errorMessage ?? "pi-ai 流错误";
          return {
            kind: "error",
            failure: { message: text, code: classifyPiAiError(text) },
          };
        }
      }
    };
    const toStreamChunks = async function* (events, contextWindow) {
      const toolIds = new Map();
      for await (const event of events) {
        switch (event.type) {
          case "start":
            break;
          case "text_start":
            yield {
              type: "block-start",
              index: event.contentIndex,
              blockType: "text",
            };
            break;
          case "text_delta":
            yield {
              type: "text-delta",
              index: event.contentIndex,
              text: event.delta,
            };
            break;
          case "text_end":
            yield {
              type: "block-end",
              index: event.contentIndex,
              block: { type: "text", text: event.content },
            };
            break;
          case "thinking_start":
            yield {
              type: "block-start",
              index: event.contentIndex,
              blockType: "reasoning",
            };
            break;
          case "thinking_delta":
            yield {
              type: "reasoning-delta",
              index: event.contentIndex,
              text: event.delta,
            };
            break;
          case "thinking_end":
            yield {
              type: "block-end",
              index: event.contentIndex,
              block: { type: "reasoning", text: event.content },
            };
            break;
          case "toolcall_start": {
            const partial =
              event.partial && event.partial.content
                ? event.partial.content[event.contentIndex]
                : undefined;
            const id = partial && partial.type === "toolCall" ? partial.id : "";
            const toolName =
              partial && partial.type === "toolCall" ? partial.name : "";
            toolIds.set(event.contentIndex, { id, name: toolName });
            yield {
              type: "block-start",
              index: event.contentIndex,
              blockType: "tool-call",
            };
            break;
          }
          case "toolcall_delta": {
            const known = toolIds.get(event.contentIndex);
            yield {
              type: "tool-call-delta",
              index: event.contentIndex,
              id: CallId(known ? known.id : ""),
              ...(known && known.name && known.name.length > 0
                ? { name: known.name }
                : {}),
              argumentsDelta: event.delta,
            };
            break;
          }
          case "toolcall_end":
            yield {
              type: "block-end",
              index: event.contentIndex,
              block: {
                type: "tool-call",
                id: CallId(event.toolCall.id),
                name: event.toolCall.name,
                arguments: JSON.stringify(event.toolCall.arguments),
              },
            };
            break;
          case "done":
            yield { type: "usage", usage: mapUsage(event.message.usage) };
            yield {
              type: "finish",
              reason: mapStopReason(event.message, contextWindow),
            };
            return;
          case "error":
            yield { type: "usage", usage: mapUsage(event.error.usage) };
            yield {
              type: "finish",
              reason: mapStopReason(event.error, contextWindow),
            };
            return;
        }
      }
      throw new LlmError("pi-ai 事件流在 done/error 前结束", "STREAM_CLOSED");
    };

    // ---- 推理级别校验（与 dsh-llm-pi-ai 同语义：不支持的级别在请求路径拒绝）----
    const resolveReasoningLevel = (model, effort) => {
      if (effort === undefined || effort === "off") return undefined;
      if (getSupportedThinkingLevels(model).includes(effort)) return effort;
      throw new LlmError(
        `pi-ai provider "${model.provider}" 模型 "${model.id}" 不支持推理级别 "${effort}"`,
        "UNSUPPORTED_REASONING_EFFORT",
      );
    };
    const reasoningInfo = (model, defaultLevel) => {
      if (!model.reasoning) return {};
      return {
        reasoning: {
          efforts: getSupportedThinkingLevels(model).map((level) => ({
            id: ReasoningEffortId(level),
            name: level.charAt(0).toUpperCase() + level.slice(1),
          })),
          ...(defaultLevel === undefined
            ? {}
            : { defaultEffort: ReasoningEffortId(defaultLevel) }),
        },
      };
    };

    // ---- LlmAdapter 实现（一次 snapshot 一次操作，replace 原子换快照：
    // 在飞的 stream 已捕获旧快照，配置变化只影响下一个请求）----
    class HanaProviderAdapter extends LlmAdapter {
      constructor({ snapshot, resolveAttachments }) {
        super();
        this.snapshot = snapshot;
        this.resolveAttachments = resolveAttachments;
      }
      replaceSnapshot(next) {
        this.snapshot = next;
      }
      current() {
        return this.snapshot;
      }
      routeOf(provider) {
        const route = this.current().byId.get(provider);
        if (route === undefined)
          throw new LlmError(
            `@dsh-hanako/provider 不持有 provider "${provider}"`,
            "NO_ADAPTER",
          );
        return route;
      }
      modelOf(provider, model) {
        const route = this.routeOf(provider);
        const found = route.models.find((m) => m.id === model);
        if (found === undefined)
          throw new LlmError(
            `@dsh-hanako/provider: provider "${provider}" 无模型 "${model}"`,
            "UNKNOWN_MODEL",
          );
        return found;
      }
      providerInfo(provider) {
        return { id: provider, name: this.routeOf(provider).displayName };
      }
      listModels(provider) {
        const route = this.routeOf(provider);
        return Promise.resolve(
          route.models.map((m) => ({
            provider,
            id: m.id,
            name: m.name,
            inputModalities: [...m.input],
          })),
        );
      }
      resolveModel(provider, model, _signal) {
        const m = this.modelOf(provider, model);
        const levels = getSupportedThinkingLevels(m);
        const defaultLevel =
          m.defaultThinkingLevel !== undefined &&
          levels.includes(m.defaultThinkingLevel)
            ? m.defaultThinkingLevel
            : undefined;
        return Promise.resolve({
          provider,
          id: model,
          name: m.name,
          inputModalities: [...m.input],
          context: { contextWindow: m.contextWindow },
          ...(m.maxTokens ? { defaultMaxTokens: m.maxTokens } : {}),
          ...reasoningInfo(m, defaultLevel),
        });
      }
      async *stream(options) {
        const snapshot = this.current();
        const route = snapshot.byId.get(options.provider);
        if (route === undefined)
          throw new LlmError(
            `@dsh-hanako/provider 不持有 provider "${options.provider}"`,
            "NO_ADAPTER",
          );
        const model = route.models.find((m) => m.id === options.model);
        if (model === undefined)
          throw new LlmError(
            `@dsh-hanako/provider: provider "${options.provider}" 无模型 "${options.model}"`,
            "UNKNOWN_MODEL",
          );
        if (options.stop !== undefined)
          throw new LlmError(
            "@dsh-hanako/provider 不支持 GenerateOptions.stop",
            "UNSUPPORTED_OPTION",
          );
        const requested =
          options.reasoningEffort !== undefined
            ? options.reasoningEffort
            : model.defaultThinkingLevel;
        const reasoning = resolveReasoningLevel(model, requested);
        const containsImage = options.messages.some((message) =>
          contentHasImage(message.content),
        );
        if (containsImage && !model.input.includes("image"))
          throw new LlmError(
            `模型 "${model.id}" 不支持图像输入`,
            "UNSUPPORTED_CONTENT",
          );
        const attachments = containsImage
          ? this.resolveAttachments()
          : undefined;
        if (containsImage && attachments === undefined)
          throw new LlmError(
            "pi-ai 图像输入需要 durable attachment 服务",
            "UNSUPPORTED_CONTENT",
          );
        const context =
          attachments === undefined
            ? toPiContext(options)
            : await toPiContext(options, attachments);
        const consumer = new AbortController();
        const upstream =
          options.signal === undefined
            ? consumer.signal
            : AbortSignal.any([options.signal, consumer.signal]);
        const watchdog = idleWatchdog(
          upstream,
          DEFAULT_STREAM_IDLE_TIMEOUT_MS,
          "LLM_STREAM_IDLE_TIMEOUT",
        );
        try {
          const provider = snapshot.providers.get(options.provider);
          const events = provider.streamSimple(model, context, {
            apiKey: route.apiKey,
            ...(reasoning === undefined ? {} : { reasoning }),
            ...(options.temperature === undefined
              ? {}
              : { temperature: options.temperature }),
            ...(options.maxTokens === undefined
              ? {}
              : { maxTokens: options.maxTokens }),
            ...(options.sessionId === undefined
              ? {}
              : { sessionId: String(options.sessionId) }),
            maxRetries: 0,
            signal: watchdog.signal,
            headers: attributionHeaders(),
          });
          const iterator = toStreamChunks(events, model.contextWindow)[
            Symbol.asyncIterator
          ]();
          let exhausted = false;
          try {
            while (true) {
              const result = await watchdog.next(iterator);
              const timeout = timeoutOf(
                watchdog.signal,
                "LLM_STREAM_IDLE_TIMEOUT",
              );
              if (timeout !== undefined)
                throw new LlmError(
                  `pi-ai 流空闲超时（${DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms）`,
                  "TIMEOUT",
                  { cause: timeout },
                );
              if (result.done) {
                exhausted = true;
                return;
              }
              yield result.value;
            }
          } finally {
            if (!exhausted) {
              consumer.abort("@dsh-hanako/provider 流消费停止");
              try {
                await iterator.return(undefined);
              } catch {
                /* pi-ai SDK 拆卸失败忽略 */
              }
            }
          }
        } catch (error) {
          if (
            timeoutOf(watchdog.signal, "LLM_STREAM_IDLE_TIMEOUT") !== undefined
          )
            throw new LlmError(
              `pi-ai 流空闲超时（${DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms）`,
              "TIMEOUT",
              { cause: error },
            );
          if (options.signal && options.signal.aborted)
            throw new LlmError("pi-ai 请求被调用方中止", "ABORTED", {
              cause: error,
            });
          throw error;
        } finally {
          consumer.abort("@dsh-hanako/provider 流消费停止");
          try {
            watchdog[Symbol.dispose]();
          } catch {
            /* 双保险 */
          }
        }
      }
    }

    // ---- 快照构建：读配置 → 建 provider 实例（失败仅该 route 丢弃，不拖垮整体）----
    const buildSnapshot = (host) => {
      const byId = new Map();
      const providers = new Map();
      for (const route of host.routes) {
        try {
          providers.set(
            route.id,
            createProvider({
              id: route.id,
              name: route.displayName,
              baseUrl: route.baseURL,
              auth: { apiKey: harnessApiKeyAuth(route.displayName) },
              models: route.models,
              api: apiFactories[route.api](),
            }),
          );
          byId.set(route.id, route);
        } catch (e) {
          host.errors.push(
            `provider "${route.id}" 构造失败：${e?.message || e}`,
          );
        }
      }
      return { byId, providers };
    };

    // ---- 注册状态机：首次注册，之后 replace() 原子更新（同 dsh-llm-pi-ai 姿势）----
    let adapter = null;
    let registration = null;
    let directory = null;
    let snapshot = null;

    const applySnapshot = (host) => {
      const built = buildSnapshot(host);
      const routes = [...built.byId.keys()];
      const entries = [...built.byId.values()].map((route) => ({
        provider: route.id,
        displayName: route.displayName,
        settingsNs: NS,
        settingsPath: ["providers", route.id],
      }));
      // 先注册后换快照：任一步抛错（如 DUPLICATE_ADAPTER）时旧注册与旧快照原样保留
      if (registration === null) {
        // 空目录不注册（registerAdapter/registerConfigurableProviders 都拒绝空列表）
        if (routes.length > 0) {
          if (adapter === null)
            adapter = new HanaProviderAdapter({
              snapshot: built,
              resolveAttachments: () => ctx.get("attachments"),
            });
          registration = ctx.llm.registerAdapter(routes, adapter);
        }
      } else {
        registration.replace(routes);
      }
      // directory 注册前过滤与 dsh 已有 configurable provider 撞名的条目（如宿主 deepseek 与
      // dsh-llm-pi-ai 内置 configurable deepseek 同名）。registerConfigurableProviders 是
      // all-or-nothing：一个撞名整体抛错，曾导致 refresh 每次都失败、snapshot 永不更新、
      // 热跟随失效（refresh 链路本身正常）。adapter 注册不受影响（deepseek 照常可用）。
      const declared = new Set(
        (ctx.llm.listConfigurableProviders?.() || []).map((e) => e.provider),
      );
      const filteredEntries = entries.filter((e) => !declared.has(e.provider));
      if (directory === null) {
        if (filteredEntries.length > 0)
          directory = ctx.llm.registerConfigurableProviders(filteredEntries);
      } else {
        directory.replace(filteredEntries);
      }
      // 注册全部成功才原子换快照（在飞的 stream 已捕获旧快照，新请求用新快照）
      snapshot = built;
      if (adapter !== null) adapter.replaceSnapshot(built);
    };

    const refresh = (source, providerData) => {
      const t0 = Date.now();
      // providerData = { routes: 组装好的 route 目录 }（宿主 push 下发；B方案下
      // 子进程不再读文件/不做组装，只接受宿主组装好的 routes）。routes 缺失 / 非数组 /
      // 为空时：保留旧 snapshot 并记日志（维持「解析失败保留旧配置」语义）
      const routes =
        providerData && Array.isArray(providerData.routes)
          ? providerData.routes
          : null;
      if (!routes || routes.length === 0) {
        ctx.logger.warn(
          "[@dsh-hanako/provider] 收到空 routes（宿主持有 provider 缺失或未 push），保留旧 snapshot",
        );
        providerLog(`refresh 收到空 routes（${source}），保留旧 snapshot`);
        return;
      }
      const host = { routes, skipped: [], errors: [] };
      try {
        applySnapshot(host);
        const modelCount = [...snapshot.byId.values()].reduce(
          (n, r) => n + (r.models ? r.models.length : 0),
          0,
        );
        const elapsed = Date.now() - t0;
        ctx.logger.info(
          `[@dsh-hanako/provider] 已同步 ${snapshot.byId.size} 个 provider（routes ${routes.length} 条）`,
        );
        providerLog(
          `refresh 完成（${source}）：${snapshot.byId.size} 个 provider / ${modelCount} 个模型，耗时 ${elapsed}ms`,
        );
      } catch (e) {
        // replace 抛错（如 DUPLICATE_ADAPTER：与用户已有 provider 同名）：保留旧注册
        ctx.logger.error(
          `[@dsh-hanako/provider] 应用配置失败，保留旧 snapshot：${e?.message || e}`,
        );
        providerLog(
          `refresh 应用失败（${source}），保留旧 snapshot：${e?.message || e}`,
        );
      }
    };
    // ---- 宿主 push 通知（v0.10.7 起宿主侧 ctx.resources.watch 感知配置变化后通知刷新；
    // v0.22.1+ 改经 dshana.bus 消息总线：宿主 emit("provider.refresh", { routes }) 事件，
    // 本插件订阅执行 refresh()——替代 POST /api/hana-provider.refresh HTTP 路由（已退役，
    // webServer 不再注入）。本插件不再自建 fs.watch。）----
    // 订阅经 dshanaBus.on（返回退订函数挂 disposers，卸载时清理）；事件缺失（bus 未连接/
    // 宿主未推）时保留旧 snapshot，宿主 web host 就绪点会主动推首批 routes。
    ctx.inject(["dshanaBus"], (busCtx) => {
      busCtx.effect(() => {
        const disposers = [];
        try {
          if (busCtx.dshanaBus && typeof busCtx.dshanaBus.on === "function") {
            disposers.push(
              busCtx.dshanaBus.on("provider.refresh", (payload) => {
                const p = payload && typeof payload === "object" ? payload : {};
                const routes = Array.isArray(p.routes) ? p.routes : null;
                // 总线版：payload.routes = 宿主组装好的 route 目录；缺失/非数组时 refresh
                // 保留旧 snapshot
                refresh("宿主 push（总线）", { routes });
                providerLog(
                  "收到 provider.refresh 事件（宿主 push" +
                    (Array.isArray(p.routes)
                      ? "，" + p.routes.length + " 条 routes"
                      : "，路由缺失") +
                    "）",
                );
              }),
            );
          }
        } catch (e) {
          try {
            ctx.logger?.warn?.(
              "[@dsh-hanako/provider] provider.refresh 订阅失败：" + (e?.message || e),
            );
          } catch {
            /* 日志失败不阻断 */
          }
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* 清理失败不阻断 */
            }
          }
        };
      });
    });
    // 启动时 snapshot 置空：B方案下不在启动读文件/不依赖 patch data，
    // 首个 provider 由宿主 web host 就绪后主动 push 填上（startWebHostFromPlugin /
    // updateDsh 重启路径都主动推一次）。apply 阶段 adapter 保持 null，首个 routes 到达才注册。
    // 兼容旧版：config.routesJSON（旧 patch 注入的 route 目录残留）仍可作初始 snapshot
    // （optional 向后兼容，新代码不再写入）
    if (config && Array.isArray(config.routesJSON)) {
      ctx.logger.info(
        `[@dsh-hanako/provider] 检测到旧版 config.routesJSON（${config.routesJSON.length} 条），用作初始 route 目录`,
      );
      refresh("旧版 routesJSON", { routes: config.routesJSON });
    } else {
      ctx.logger.info(
        "[@dsh-hanako/provider] 启动 snapshot 为空，等待宿主 push 首批 route 目录",
      );
      providerLog("启动 snapshot 为空，等待宿主 push 首批 route 目录");
    }
  } catch (e) {
    // 顶层兜底：apply 永不抛出（边界要求——不阻断 dsh 启动）
    ctx.logger.error(
      `[@dsh-hanako/provider] 插件初始化失败，已降级为空操作：${e?.message || e}`,
    );
  }
}
