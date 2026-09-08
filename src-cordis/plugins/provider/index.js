// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/provider — DSH provider adapter（v2 重写：模型推理走受管 runtime 内 hana）
//
// v1（0.1.2）形态：消费宿主 provider 路由（models.json + apiKey）注册官方 PiAiAdapter 直连
// 各 provider 端点。v2（迁移指南 §8/决策 B）不再有 apiKey/baseURL/直连：**推理在受管
// runtime 内经 connectAppRuntime().models 发起**（受管子进程与 DSH 同进程，hana client
// 由 dsh-host.mjs 挂 globalThis.__dshanaHana，见 src/runtime/main.js 步骤 1 注释）：
//   · 目录：hana.models.list() → 显式 provider/model 选择（id 原样透传，不二次映射）；
//   · 推理：hana.models.stream({ requestId, taskId, provider, model, messages, systemPrompt,
//     tools, reasoningEffort?, maxTokens?, temperature? })——requestId 由本 adapter 自管
//     （cancel 按 requestId 定向）；taskId 从 task-map（会话→任务）解析（宿主 scope 校验）；
//   · NDJSON 逐行解析（lib/ndjson.js），done.assistant 完整保存回放（含 text/reasoning/
//     toolCall 续接签名，lib/stream.js buildDoneChunks + 回放信封）；error 事件=失败不算成功；
//   · 图片：DSH 消息含 ImageBlock 时经 attachment store 读字节 → base64+MIME（不传路径），
//     缺 store 时报 UNSUPPORTED_CONTENT（边界见 DESIGN）。
// DSH 侧工具循环不变：Hana 不替 DSH 执行传入工具 schema（tools 仅声明）；DSH 执行工具后把
// role:toolResult 消息放回 messages（lib/messages.js 转换）。
//
// 容错纪律（v1 同款）：apply 全程 try/catch 不抛——依赖缺失/目录空/错误只记日志，插件
// 降级为空操作（DSH 无 provider 可用），不阻断 dsh 启动。
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { readNdjsonEvents } from "./lib/ndjson.js";
import { providerRoutes, listModelsForProvider, resolveModelInfo, supportedEfforts } from "./lib/catalog.js";
import { toHanaMessages } from "./lib/messages.js";
import { buildDoneChunks } from "./lib/stream.js";
import { readTaskMap, taskMapDir } from "./lib/taskmap.js";

export const name = "@dsh-hanako/provider";
export const inject = ["llm"];

/** 动态依赖解析基座（profiles 全量视图优先——pnpm 严格结构下 dsh-pkg 顶层只有直接声明）。 */
function resolveLlmEntry() {
  const home = process.env.DSH_HOME;
  const bases = [];
  if (home) bases.push(join(home, "profiles", "node_modules"));
  const candidates = [];
  for (const base of bases) {
    try {
      const p = join(base, "@deepseek-ai", "dsh-llm", "package.json");
      if (!existsSync(p)) continue;
      const pkg = JSON.parse(readFileSync(p, "utf8"));
      const entry = (pkg.exports && pkg.exports["."] && pkg.exports["."].default) || pkg.main || "index.js";
      candidates.push(pathToFileURL(join(base, "@deepseek-ai", "dsh-llm", entry)).href);
    } catch {
      /* 该基座不可解析，试下一个 */
    }
  }
  return candidates;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- 任务映射（stream scope）----
function dataDirOf() {
  const v = process.env.DSHANA_HOME;
  return typeof v === "string" && v ? v : null;
}
function taskIdForSession(dataDir, sessionId) {
  if (!dataDir || !sessionId) return null;
  const m = readTaskMap(dataDir, sessionId);
  return m ? m.taskId : null;
}

function log(ctx, msg) {
  try {
    ctx.logger?.info?.("[" + name + "] " + msg);
  } catch {
    /* 日志失败不阻断 */
  }
}
function warn(ctx, msg) {
  try {
    ctx.logger?.warn?.("[" + name + "] " + msg);
  } catch {
    /* 日志失败不阻断 */
  }
}

function toLlmError(LlmError, e, requestId) {
  const message = (e && e.message) || String(e || "模型调用失败");
  const code = (e && e.code) || "MODEL_ERROR";
  const opts = requestId ? { requestId } : undefined;
  try {
    return new LlmError(message, code, opts);
  } catch {
    return new Error(message);
  }
}

/** 归一 attachment mediaType → MIME（ref.mediaType 可能不带 image/ 前缀）。 */
function mimeOf(mediaType) {
  const s = String(mediaType || "").toLowerCase();
  if (!s) return "image/png";
  return /^image\//.test(s) ? s : "image/" + s;
}

/**
 * 预解析消息里的全部图片块（DSH ImageBlock.attachment → base64 + mime）。
 * @returns Promise<Map<string,{data:string,mimeType:string}>>（attId → 编码）
 */
async function prepareImages(store, messages, signal) {
  const out = new Map();
  if (!store) return out;
  const seen = new Set();
  const walk = (blocks) => {
    for (const b of blocks || []) {
      if (!b) continue;
      if (b.type === "image") {
        const ref = b.attachment;
        if (ref && typeof ref.attachmentId === "string" && !seen.has(ref.attachmentId)) {
          seen.add(ref.attachmentId);
          out.set(ref.attachmentId, ref);
        }
      } else if (b.type === "tool-result" && Array.isArray(b.content)) {
        walk(b.content);
      }
    }
  };
  for (const m of messages || []) walk(m && m.content);
  const loaded = new Map();
  for (const [attId, ref] of out) {
    try {
      const img = await store.readImageRequest(ref, { maxPixels: 4194304, maxBytes: 4000000 }, signal);
      const data = img && img.data ? img.data : null;
      if (!data) throw new Error("readImageRequest 未返回字节");
      loaded.set(attId, { data: Buffer.from(data).toString("base64"), mimeType: mimeOf(ref.mediaType) });
    } catch (e) {
      const err = new Error(
        "DSH 图片附件解析失败（attachmentId=" + attId + "）：" + ((e && e.message) || e),
      );
      err.code = "UNSUPPORTED_CONTENT";
      throw err;
    }
  }
  return loaded;
}

/**
 * 运行时构建 HanaAdapter（extends 需要运行时 import 的 LlmAdapter）。
 * @param {Function} LlmAdapter LlmAdapter 基类（dsh-llm）
 * @param {Function} LlmError LlmError（dsh-llm）
 * @param {object} deps { models: 目录投影数组, hana: AppRuntimeClient, getImages: () => store|null }
 */
function buildHanaAdapter(LlmAdapter, LlmError, deps) {
  const models = Array.isArray(deps.models) ? deps.models : [];
  const adapter = new (class HanaAdapter extends LlmAdapter {
    providerInfo(provider) {
      return { id: provider, name: provider };
    }

    listModels(provider) {
      return Promise.resolve(listModelsForProvider(provider, models));
    }

    resolveModel(provider, model, _signal) {
      const item = models.find((m) => m && m.provider === provider && m.id === model) || null;
      const info = resolveModelInfo(item);
      if (!info) {
        const err = new Error(
          "hana provider \"" + provider + "\" 无模型 \"" + model + "\"（宿主目录快照 " +
            (models.filter((m) => m && m.provider === provider).length || 0) + " 条）",
        );
        err.code = "UNKNOWN_MODEL";
        throw err;
      }
      return Promise.resolve(info);
    }

    async *stream(options) {
      const dataDir = dataDirOf();
      const taskId = taskIdForSession(dataDir, options && options.sessionId);
      if (!taskId) {
        throw new LlmError(
          "DSH 会话 " + String((options && options.sessionId) || "?") +
            " 没有 Hana task 绑定（task-map 缺失）：模型推理需要宿主 task scope（app/models.infer）；" +
            "非 dsh_session 发起的会话（如 Web UI 直开）暂不可推理。",
          "NO_TASK_SCOPE",
        );
      }
      const requestId = randomUUID();
      const ac = new AbortController();
      const onAbort = () => {
        ac.abort();
        try {
          deps.hana && deps.hana.models && deps.hana.models.cancel(requestId).catch(() => {});
        } catch {
          /* 忽略 */
        }
      };
      const signal = options && options.signal;
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      // 图片解析（store 缺失/失败 → UNSUPPORTED_CONTENT 明确报错）
      let images = null;
      try {
        const store = typeof deps.getImages === "function" ? deps.getImages() : null;
        images = store ? await prepareImages(store, options && options.messages, ac.signal) : null;
      } catch (e) {
        if (signal) signal.removeEventListener("abort", onAbort);
        throw toLlmError(LlmError, e, requestId);
      }
      // 消息转换（assistant 历史回放签名/tool-result 拆分/图片编码）
      let hanaMessages;
      let systemPrompt;
      try {
        const conv = toHanaMessages({ messages: options && options.messages, images });
        hanaMessages = conv.messages;
        systemPrompt = conv.systemPrompt;
      } catch (e) {
        if (signal) signal.removeEventListener("abort", onAbort);
        throw toLlmError(LlmError, e, requestId);
      }
      if (hanaMessages.length === 0) {
        if (signal) signal.removeEventListener("abort", onAbort);
        throw new LlmError("请求消息为空（无 user/assistant/toolResult 消息）", "EMPTY_MESSAGES", { requestId });
      }
      const request = {
        requestId,
        taskId,
        provider: options.provider,
        model: options.model,
        messages: hanaMessages,
      };
      if (systemPrompt) request.systemPrompt = systemPrompt;
      if (Array.isArray(options.tools) && options.tools.length) request.tools = options.tools;
      if (options.reasoningEffort) request.reasoningEffort = String(options.reasoningEffort);
      if (Number.isInteger(options.maxTokens) && options.maxTokens > 0) request.maxTokens = options.maxTokens;
      if (typeof options.temperature === "number" && Number.isFinite(options.temperature)) {
        request.temperature = options.temperature;
      }
      try {
        const response = await deps.hana.models.stream(request);
        let done = false;
        try {
          for await (const ev of readNdjsonEvents(response)) {
            if (!ev || typeof ev.type !== "string") continue;
            if (ev.type === "done") {
              const chunks = buildDoneChunks({ doneEvent: ev, provider: options.provider, model: options.model, requestId });
              for (const c of chunks) yield c;
              done = true;
              break;
            }
            if (ev.type === "error") {
              throw new LlmError(
                String(ev.message || "模型错误"),
                String(ev.code || "MODEL_ERROR"),
                { requestId },
              );
            }
            // start/text-delta/reasoning-delta/tool-call：done.assistant 为权威内容（见 lib/stream.js 头注释）
          }
        } finally {
          if (signal) signal.removeEventListener("abort", onAbort);
          try {
            ac.abort();
          } catch { /* 忽略 */ }
        }
        if (!done) {
          if (options && options.signal && options.signal.aborted) {
            throw new LlmError("模型流已中止", "ABORTED", { requestId });
          }
          throw new LlmError("模型流未以 done 事件结束（宿主连接中断）", "STREAM_CLOSED", { requestId });
        }
      } catch (e) {
        if (e instanceof LlmError) throw e;
        throw toLlmError(LlmError, e, requestId);
      }
    }
  })();
  return adapter;
}

export async function apply(ctx, config) {
  try {
    // 1. hana client 句柄（dsh-host.mjs 在 connectAppRuntime 后、runProfile 前设置；
    // 插件加载晚于该点；仍给窗口兜底轮询）
    let hana = null;
    try {
      hana = globalThis.__dshanaHana || null;
    } catch {
      hana = null;
    }
    if (!hana || !hana.models || typeof hana.models.list !== "function") {
      warn(ctx, "hana client（globalThis.__dshanaHana）不可用——provider 停用（受管 runtime 未正确注入宿主 IPC）");
      return;
    }
    // 2. 附件 store（图片 base64 解析；缺失时图片内容报 UNSUPPORTED_CONTENT）
    let attachmentStore = null;
    try {
      ctx.inject(["attachments"], (aCtx) => {
        try {
          const s = aCtx && aCtx.attachments;
          if (s && typeof s.readImageRequest === "function") attachmentStore = s;
        } catch { /* 忽略 */ }
      });
    } catch {
      /* attachments 服务不可用：图片内容报 UNSUPPORTED_CONTENT */
    }
    // 3. 目录快照（models.list；引擎未就绪窗口内重试 ≤20s）
    let models = [];
    const deadline = Date.now() + 20000;
    for (;;) {
      try {
        const res = await (hana.models.list());
        const list = res && Array.isArray(res.models) ? res.models : [];
        if (list.length > 0) {
          models = list;
          break;
        }
      } catch (e) {
        warn(ctx, "hana.models.list 暂不可用：" + ((e && e.message) || e));
      }
      if (Date.now() >= deadline) break;
      await sleep(500);
    }
    if (models.length === 0) {
      warn(ctx, "hana 模型目录为空——provider 无路由可注册（宿主无可用模型/目录未就绪）");
      return;
    }
    // 4. dsh-llm 动态依赖 + adapter
    let llmMod = null;
    for (const href of resolveLlmEntry()) {
      try {
        // webpackIgnore：运行时原生 import（变量基座，cordis 子插件打包保留原生语义）
        llmMod = await import(/* webpackIgnore: true */ href);
        break;
      } catch { /* 试下一个基座 */ }
    }
    if (!llmMod) {
      try {
        llmMod = await import(/* webpackIgnore: true */ "@deepseek-ai/dsh-llm");
      } catch { /* 不可用 */ }
    }
    const LlmAdapter = llmMod && llmMod.LlmAdapter;
    const LlmError = llmMod && llmMod.LlmError;
    if (typeof LlmAdapter !== "function" || typeof LlmError !== "function") {
      warn(ctx, "dsh-llm 未导出 LlmAdapter/LlmError——provider 停用");
      return;
    }
    const routes = providerRoutes(models);
    const adapter = buildHanaAdapter(LlmAdapter, LlmError, {
      models,
      hana,
      getImages: () => attachmentStore,
    });
    // 5. 注册（空 routes 不注册——llm 注册表要求非空；目录空已在上方 return）。
    // 宿主目录是启动快照：受管进程存活期不变化（改宿主模型配置需 runtime 重启生效——
    // 与受管 runtime 生命周期一致的取舍，见 DESIGN「已测/未测边界」）。
    ctx.llm.registerAdapter(routes, adapter);
    log(ctx, "已注册 " + routes.length + " 个 provider 路由（" + models.length + " 个模型，源=hana.models.list）");
  } catch (e) {
    // 顶层兜底：apply 永不抛出
    try {
      ctx.logger?.error?.("[" + name + "] 插件初始化失败，已降级为空操作：" + ((e && e.message) || e));
    } catch { /* 忽略 */ }
  }
}
