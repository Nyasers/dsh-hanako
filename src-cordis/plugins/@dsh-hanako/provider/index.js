// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/provider — 让 dsh 直接复用 Hana 宿主的 provider 配置并完全跟随（v0.9.3）。
// 0.1.2 重写（vX）：复用官方 @deepseek-ai/dsh-llm-pi-ai 的 PiAiAdapter（LlmAdapter 完整
// 实现：stream/resolveModel/listModels/prepareCall 全包），本插件只做两件事：
//   1. 消费宿主经 dshana.bus push 的 route 目录（provider.refresh，v0.22.1+ 总线版；
//      组装在宿主：models.json + provider-catalog.json → routes）
//   2. 把宿主 routes 组装成 0.1.2 的 providers dict（{ provider: { displayName, baseURL,
//      api, models } }），构造官方 PiAiAdapter 并注册 ctx.llm.registerAdapter(routes, adapter)
//
// 0.1.2 适配要点：
//   · LlmAdapter 基类接口重构（prepareCall/resolveModel/listModels 形状变了）——旧自写
//     adapter（消息转换/stream 委托 pi-ai 库）整体删除，官方 PiAiAdapter 全包
//   · 凭据不走 apiKeyEnv/credentials 服务（宿主 catalog 明文 apiKey）：resolveApiKey 闭包
//     直取宿主 route.apiKey，per-request override（options.apiKey 优先级最高）
//   · compat（thinkingFormat/supportsDeveloperRole 等）暂不传递（0.1.2 resolveModelCompat
//     走内置 catalog 校验，非 builtin route 直通有风险）——先跑通默认链路，sensenova 等
//     的 developer-role 适配后续按需补
//   · 依赖：llm（LlmAdapter/LlmError）+ piAiAdapter（PiAiAdapter）+ pi-ai（createProvider
//     与 api 工厂）。dsh-pkg 依赖解析沿用 resolvePkgEntry（profiles 全量视图优先）
//
// 注册：ctx.llm.registerAdapter(routes, adapter)（routes = 宿主 route id 列表）。
// 服务依赖（关键）：inject = ['llm', 'hanaLogger', 'dshanaBus']（cordis 服务注入经
// inject 声明生效）。dshanaBus 用于：① dshPkgDir 经 getConfig() 获取 ② provider.refresh
// 事件订阅。logger 为 @dsh-hanako/logger 统一日志服务。
// 容错纪律：apply 全程 try/catch 不抛出——依赖缺失/配置缺失/解析失败只记日志，
// 插件降级为空操作，不阻断 dsh 启动。

export const name = "@dsh-hanako/provider";
export const inject = ["llm", "hanaLogger", "dshanaBus"];

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const DEP_SPECS = {
  llm: "@deepseek-ai/dsh-llm",
  piAiAdapter: "@deepseek-ai/dsh-llm-pi-ai",
  piAi: "@earendil-works/pi-ai",
  piAiCompletions: "@earendil-works/pi-ai/api/openai-completions.lazy",
  piAiResponses: "@earendil-works/pi-ai/api/openai-responses.lazy",
  piAiAnthropic: "@earendil-works/pi-ai/api/anthropic-messages.lazy",
};

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
  // （@earendil-works/pi-ai 等）不在顶层——pnpm 下必须走 profiles 全量视图。
  if (home) bases.push(join(home, "profiles"));
  try {
    const busPkgDir =
      typeof getBusDshPkgDir === "function" ? getBusDshPkgDir() : null;
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

// ---- 0.1.2 providers dict 组装（照 dsh-llm-pi-ai resolveProfiles 的输入形状）----
// 宿主 route：{ id, displayName, baseURL, apiKey, api, models, compat }
// 0.1.2 dict：{ [route.id]: { displayName?, baseURL?, api?, models? } }
//   · models 直通（0.1.2 entry：id/name/contextWindow/maxTokens/input...）
//   · compat 暂不传（0.1.2 resolveModelCompat 校验风险，见头部注释）
const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_TOKENS = 32768;
const DEFAULT_INPUT = ["text"];
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// pi-ai 的 auth.apiKey 方法（copy 官方 harnessApiKeyAuth）：provider 必须声明
// apiKey 方法，请求级 apiKey override 才会被 honor（resolveProviderAuth 先查
// provider.auth.apiKey 再处理 override——缺失即 "Provider is not configured"）。
// 凭据不走 credentials 服务（宿主 catalog 明文 apiKey），resolve 返回空 auth，
// 真正的 key 经 PiAiAdapter 的 resolveApiKey → options.apiKey override 生效。
function harnessApiKeyAuth(name) {
  return {
    name,
    resolve: ({ credential }) =>
      Promise.resolve({
        auth: credential?.key === void 0 ? {} : { apiKey: credential.key },
        source: name,
      }),
  };
}

function buildProviderSimplified(spec, apiFactories) {
  // 去 catalog：宿主 routes 必带 api（openai-completions 等）+ baseURL + models。
  const factory = apiFactories[spec.api];
  if (factory === void 0)
    throw new Error(
      `[@dsh-hanako/provider] route "${spec.provider}" names api "${spec.api}", which this build cannot serve`,
    );
  const { createProvider } = spec.piAi;
  return createProvider({
    id: spec.provider,
    name: spec.displayName,
    ...(spec.baseURL === void 0 ? {} : { baseUrl: spec.baseURL }),
    auth: { apiKey: harnessApiKeyAuth(spec.displayName) },
    models: spec.models,
    api: factory(),
  });
}

function resolveRouteModelsSimplified(request, deps) {
  const { provider } = request;
  const configured = Array.isArray(request.models) ? request.models : [];
  if (configured.length === 0)
    throw new Error(
      `[@dsh-hanako/provider] route "${provider}" resolves no models; host push 未提供模型列表`,
    );
  const seen = new Set();
  const configuredMaxTokens = new Map();
  const models = configured.map((entry) => {
    if (typeof entry.id !== "string" || entry.id.length === 0)
      throw new Error(`[@dsh-hanako/provider] route "${provider}" has a model with an empty id`);
    if (seen.has(entry.id))
      throw new Error(`[@dsh-hanako/provider] route "${provider}" lists model "${entry.id}" more than once`);
    seen.add(entry.id);
    const contextWindow =
      entry.contextWindow ?? request.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW;
    if (!Number.isInteger(contextWindow) || contextWindow <= 0)
      throw new Error(`[@dsh-hanako/provider] model "${entry.id}" contextWindow must be a positive integer`);
    const maxTokens = entry.maxTokens ?? request.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    if (!Number.isInteger(maxTokens) || maxTokens <= 0)
      throw new Error(`[@dsh-hanako/provider] model "${entry.id}" maxTokens must be a positive integer`);
    if (entry.maxTokens !== void 0) configuredMaxTokens.set(entry.id, entry.maxTokens);
    // 推理元数据（模拟官方 resolveModelReasoning 的输出形状）：
    // reasoningEfforts（输入）→ reasoning: true + thinkingLevelMap（pi-ai 形状，
    // getSupportedThinkingLevels 消费；mapped === null 的级别被排除）。
    // 宿主 m.reasoning === true → 推理模型：声明 off/medium/high（agent loop 默认
    // reasoningEffort high 必被接受），xhigh（thinkingLevelMap.max==='max'）追加 max；
    // minimal/low/xhigh（无 max 时）→ null（列表裁剪，与宿主词汇口径一致）。
    const reasoningMeta =
      entry.reasoning === true
        ? {
            reasoning: true,
            thinkingLevelMap: {
              off: "off",
              minimal: null,
              low: null,
              medium: "medium",
              high: "high",
              xhigh: null,
              ...(entry.thinkingLevelMap && entry.thinkingLevelMap.max === "max"
                ? { max: "max" }
                : {}),
            },
          }
        : null;
    return {
      id: entry.id,
      name: entry.name ?? entry.id,
      api: request.api,
      provider,
      baseUrl: request.baseURL,
      input: [...(Array.isArray(entry.input) && entry.input.length ? entry.input : DEFAULT_INPUT)],
      cost: NO_COST,
      contextWindow,
      maxTokens,
      ...(reasoningMeta ? reasoningMeta : {}),
    };
  });
  return { models, configuredMaxTokens };
}

function resolveProfilesSimplified(providersDict, deps, apiFactories) {
  const resolved = new Map();
  for (const [provider, source] of Object.entries(providersDict ?? {})) {
    if (provider.length === 0)
      throw new Error(`[@dsh-hanako/provider] provider names must be non-empty`);
    const displayName = source.displayName ?? provider;
    const catalog = resolveRouteModelsSimplified(
      {
        provider,
        ...(source.api === void 0 ? {} : { api: source.api }),
        ...(source.baseURL === void 0 ? {} : { baseURL: source.baseURL }),
        ...(source.models === void 0 ? {} : { models: source.models }),
      },
      deps,
    );
    resolved.set(provider, {
      provider,
      displayName,
      // 官方默认：idleWatchdog 的 stream 空闲超时（PiAiAdapter.stream 必消费，缺失会拒）
      streamIdleTimeoutMs: 3e5,
      maxRequestImageBytes: 20971520,
      requestImagePixelBudget: 4194304,
      requestImageMaxBytes: 1048576,
      configuredMaxTokens: catalog.configuredMaxTokens,
      piProvider: buildProviderSimplified(
        {
          provider,
          displayName,
          api: source.api,
          baseURL: source.baseURL,
          models: catalog.models,
          piAi: deps.piAi,
        },
        apiFactories,
      ),
    });
  }
  return resolved;
}

export async function apply(ctx, config) {
  try {
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
    const { PiAiAdapter } = deps.piAiAdapter;
    if (typeof PiAiAdapter !== "function") {
      ctx.logger.error(
        "[@dsh-hanako/provider] dsh-llm-pi-ai 未导出 PiAiAdapter，插件停用",
      );
      return;
    }
    const apiFactories = {
      "openai-completions": () => deps.piAiCompletions.openAICompletionsApi(),
      "openai-responses": () => deps.piAiResponses.openAIResponsesApi(),
      "anthropic-messages": () => deps.piAiAnthropic.anthropicMessagesApi(),
    };
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

    // ---- 宿主 routes 快照 + 0.1.2 profiles（PiAiAdapter 消费形状）----
    let hostRoutes = new Map(); // route.id → route（宿主 push 的 route 目录）
    let adapter = null;
    let registration = null;
    let snapshotFacts = null; // 注册事实（route id 排序串），路由集变化才重建
    let profilesCache = null;

    const buildProfilesMap = () => {
      const providersDict = {};
      for (const route of hostRoutes.values()) {
        providersDict[route.id] = {
          ...(route.displayName ? { displayName: route.displayName } : {}),
          ...(route.baseURL ? { baseURL: route.baseURL } : {}),
          ...(route.api ? { api: route.api } : {}),
          ...(Array.isArray(route.models) && route.models.length
            ? { models: route.models }
            : {}),
        };
      }
      return providersDict;
    };
    const profiles = () => {
      const dict = buildProfilesMap();
      profilesCache = resolveProfilesSimplified(dict, deps, apiFactories);
      return profilesCache;
    };
    const resolveApiKey = async (provider, _profile) => {
      const route = hostRoutes.get(provider);
      return route && typeof route.apiKey === "string" && route.apiKey
        ? route.apiKey
        : void 0;
    };
    const ensureRegistration = () => {
      const routes = [...hostRoutes.keys()];
      const facts = routes.sort().join(",");
      if (facts === snapshotFacts && registration !== null) return;
      if (adapter === null)
        adapter = new PiAiAdapter({
          profiles,
          resolveApiKey,
          auth: {},
          onReplayDegrade: () => {},
        });
      if (registration === null) {
        // 首次注册：空 routes（初始无 provider）不注册 adapter（无 provider 可注册），
        // 只推进 snapshotFacts——后续 refresh 填入 routes 时再注册。
        if (routes.length === 0) {
          snapshotFacts = facts;
          return;
        }
        registration = ctx.llm.registerAdapter(routes, adapter);
      } else {
        // 已注册：一律 replace（空数组也是有效快照——provider 全移除时清空注册表，
        // resolveApiKey 经 hostRoutes.get 返回 undefined，凭据不再对外暴露）
        registration.replace(routes);
      }
      snapshotFacts = facts;
    };

    const applySnapshot = () => {
      ensureRegistration();
    };

    const refresh = (source, providerData) => {
      const t0 = Date.now();
      const routes =
        providerData && Array.isArray(providerData.routes)
          ? providerData.routes
          : null;
      if (!routes) {
        // routes 缺失（null/undefined，非空数组）：数据不可用，保留旧 snapshot
        ctx.logger.warn(
          "[@dsh-hanako/provider] 收到空 routes（宿主持有 provider 缺失或未 push），保留旧 snapshot",
        );
        providerLog(`refresh 收到空 routes（${source}），保留旧 snapshot`);
        return;
      }
      // 先构建候选快照再提交：不预先 mutate 活跃 hostRoutes——applySnapshot 失败时
      // 恢复旧值（hostRoutes/profilesCache/snapshotFacts），日志与行为一致。
      let candidate;
      try {
        candidate = new Map(routes.map((r) => [r.id, r]));
      } catch (e) {
        ctx.logger.error(
          `[@dsh-hanako/provider] routes 快照构建失败：${e?.message || e}`,
        );
        providerLog(`refresh 快照构建失败（${source}）：${e?.message || e}`);
        return;
      }
      const prevHostRoutes = hostRoutes;
      const prevProfilesCache = profilesCache;
      const prevSnapshotFacts = snapshotFacts;
      hostRoutes = candidate;
      profilesCache = null; // 强制重建 profiles
      snapshotFacts = null;
      try {
        applySnapshot();
        const modelCount = [...hostRoutes.values()].reduce(
          (n, r) => n + (Array.isArray(r.models) ? r.models.length : 0),
          0,
        );
        ctx.logger.info(
          `[@dsh-hanako/provider] 已同步 ${hostRoutes.size} 个 provider（routes ${routes.length} 条）`,
        );
        providerLog(
          `refresh 完成（${source}）：${hostRoutes.size} 个 provider / ${modelCount} 个模型，耗时 ${Date.now() - t0}ms`,
        );
      } catch (e) {
        // 应用失败：恢复旧 snapshot（hostRoutes/profilesCache/snapshotFacts 回到提交前值）
        hostRoutes = prevHostRoutes;
        profilesCache = prevProfilesCache;
        snapshotFacts = prevSnapshotFacts;
        ctx.logger.error(
          `[@dsh-hanako/provider] 应用配置失败，已恢复旧 snapshot：${e?.message || e}`,
        );
        providerLog(
          `refresh 应用失败（${source}），已恢复旧 snapshot：${e?.message || e}`,
        );
      }
    };

    // ---- 宿主 push 通知（dshana.bus 消息总线）----
    ctx.inject(["dshanaBus"], (busCtx) => {
      busCtx.effect(() => {
        const disposers = [];
        try {
          if (busCtx.dshanaBus && typeof busCtx.dshanaBus.on === "function") {
            disposers.push(
              busCtx.dshanaBus.on("provider.refresh", (payload) => {
                const p = payload && typeof payload === "object" ? payload : {};
                const routes = Array.isArray(p.routes) ? p.routes : null;
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
            try {
              if (typeof busCtx.dshanaBus.emit === "function") {
                busCtx.dshanaBus.emit("provider.refresh.request", {});
              }
            } catch {
              /* 请求失败不阻断（宿主补推兜底） */
            }
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

    // 启动 snapshot 置空：首个 provider 由宿主 web host 就绪后主动 push 填上。
    // 兼容旧版 config.routesJSON（旧 patch 注入残留）仍可作初始 snapshot。
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
