// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// @dsh-hanako/acp-assist — dsh-acp 插件的插件（DSH 进程内 cordis 插件）。
//
// 目标（规格见 specs/current/dshana-host-task-registry/spec.md 关联记录）：
// dsh-acp（@deepseek-ai/dsh-acp）的 AcpSession.create 在 agent 工厂 setup 里只装
// modelControl + MCP，不做 preset 组合（"No preset composition——reads from global
// layer"）——ACP 会话因此拿不到 agentPresets 默认 preset（用户配的
// settings.yaml agent-presets.default: ptc 只服务 Web 会话）。本插件在 agent 工厂层
// wrap agents.create/resume 的 setup 链，给 ACP 会话补装配后置段：
//   ① preset：mountPreset(agentCtx, agentPresets.config.default)——把 ACP 会话接回
//      DSH 自己的默认 preset 系统（DSH 配置直读，零宿主通讯）
//   ② effort 校准：经 installModelSelection 挂的 selection 补默认 reasoningEffort
//      （宿主 set model 后保持用户配的 effort——时序在宿主侧 acpSelect 处理，
//       setup 期补会被随后的 selectModel 冲掉——见 protocol.js）
// 边界：超时宿主面（run.js timer），本插件不管；工具显式覆盖（宿主传 preset/effort）
// 是宿主→DSH 透传面（ACP 协议无 preset 字段，暂不实现——需要时经 set_config 扩展）。
//
// 本文件 = 探测版（patch 面验证）：只 wrap setup 后置 + 日志（agentCtx 特征 /
// agentPresets.default 可达性 / create·resume 双路），不真 mountPreset。验证通过后
// 第二步填 assist 的 preset 挂载与 effort 校准。
//
// 纪律：apply 全程 try/catch 不抛（插件降级为空操作，不阻断 dsh 启动）——cordis
// 装配失败/服务缺失时静默跳过，宿主日志留痕。

export const name = "@dsh-hanako/acp-assist";
export const inject = ["agents", "hanaLogger"];

export function apply(ctx) {
  try {
    let loggerSvc = null;
    try {
      ctx.inject(["hanaLogger"], (logCtx) => {
        loggerSvc = logCtx && logCtx.hanaLogger;
      });
    } catch {
      /* 日志服务缺失：静默 */
    }
    const log = (msg) => {
      try {
        loggerSvc?.log("acp-assist", msg);
      } catch {
        /* 日志失败不阻断 */
      }
    };

    // patch 目标：agent 工厂（dsh-acp 经 ctx.agents.create/resume 建 ACP 会话；
    // web 会话同走此工厂——assist 需区分/查重防双挂）
    const factory = ctx && ctx.agents;
    if (!factory || typeof factory.create !== "function") {
      log("agents 工厂不可用（无 create）——跳过 patch");
      return;
    }
    const origCreate = factory.create;
    const origResume =
      typeof factory.resume === "function" ? factory.resume : null;

    /** setup 后置段：原装配（modelControl+MCP）跑完后追加 assist。 */
    const hostLog = (msg) => {
      // 同进程宿主单例直写（loggerSvc 经 dshanaBus 总线——总线已退役（ACP 时代），
      // 日志到不了宿主；globalThis.__dshHanako 同进程可达——直写宿主日志文件）
      try {
        const g = globalThis && globalThis.__dshHanako;
        g && typeof g.appendLog === "function" && g.appendLog("hana", msg);
      } catch { /* 日志失败不阻断 */ }
    };
    const assist = async (agentCtx, options, mode) => {
      try {
        const sid =
          (options && (options.sessionId || options.resumeSessionId)) || "?";
        hostLog(
          "[dsh acp-assist] " + mode + " setup 后置触发 session=" +
            String(sid).slice(0, 16),
        );
        // agentPresets 默认 preset 挂载（settings agent-presets.default——ACP 会话
        // 接回 DSH 默认 preset 系统——mount id 缺省用 config.default）
        try {
          ctx.inject(["agentPresets"], async (apCtx) => {
            try {
              const ap = apCtx && apCtx.agentPresets;
              if (!ap || typeof ap.mount !== "function") {
                hostLog("[dsh acp-assist] agentPresets 服务不可用（无 mount）——跳过 preset");
                return;
              }
              const presetDefault =
                typeof ap.defaultId === "string" && ap.defaultId
                  ? ap.defaultId
                  : ap.config && ap.config.default
                    ? ap.config.default
                    : undefined;
              hostLog(
                "[dsh acp-assist] 挂载默认 preset：" +
                  String(presetDefault ?? "（config.default 缺省）") +
                  " 到 session=" + String(sid).slice(0, 12),
              );
              await ap.mount(agentCtx, presetDefault);
              hostLog(
                "[dsh acp-assist] preset 已挂载完成 session=" +
                  String(sid).slice(0, 12) +
                  " preset=" + String(presetDefault ?? "default"),
              );
            } catch (e) {
              hostLog(
                "[dsh acp-assist] preset 挂载失败（session 继续，无 preset 组合）：" +
                  ((e && e.message) || e),
              );
            }
          });
        } catch (e) {
          hostLog(
            "[dsh acp-assist] agentPresets 注入失败：" +
              ((e && e.message) || e),
          );
        }
      } catch (e) {
        hostLog("[dsh acp-assist] assist 失败：" + ((e && e.message) || e));
      }
    };

    // wrap create：原 setup（ACP 的 modelControl+MCP 装配）后追加 assist
    factory.create = async function createPatched(options) {
      try {
        const opt = options || {};
        const origSetup =
          typeof opt.setup === "function" ? opt.setup : null;
        opt.setup = async (agentCtx) => {
          if (origSetup) await origSetup(agentCtx);
          await assist(agentCtx, opt, "create");
        };
        return await origCreate.call(this, opt);
      } catch (e) {
        // CodeRabbit 第二轮 #5：不再二次调 origCreate 重试。首试失败时原装配可能已部分
        // 生效/agent 已创建（重试会双创建/重复装配），且重试掩盖 setup 抛出的真因
        //（assist 自带 try/catch 不抛，能走到这里是原 setup/工厂装配失败）。log + rethrow，
        // 保留原工厂的错误语义。
        log("create wrap 失败（透传原错误）：" + ((e && e.message) || e));
        throw e;
      }
    };

    // wrap resume（同款：恢复会话的装配也走 setup——preset 同样要补）
    if (origResume) {
      factory.resume = async function resumePatched(options) {
        try {
          const opt = options || {};
          const origSetup =
            typeof opt.setup === "function" ? opt.setup : null;
          opt.setup = async (agentCtx) => {
            if (origSetup) await origSetup(agentCtx);
            await assist(agentCtx, opt, "resume");
          };
          return await origResume.call(this, opt);
        } catch (e) {
          // CodeRabbit 第二轮 #5（与 create 同款）：不再二次调 origResume 重试——恢复
          // 会话的装配同样可能已部分生效（重试双创建/双装配），log + rethrow 透传真因。
          log("resume wrap 失败（透传原错误）：" + ((e && e.message) || e));
          throw e;
        }
      };
    }

    log("agent 工厂已 patch（create" + (origResume ? "/resume" : "") + " setup 后置）");
    hostLog(
      "[dsh acp-assist] agent 工厂已 patch（create" +
        (origResume ? "/resume" : "") + " setup 后置）——默认 preset 挂载就位",
    );
  } catch (e) {
    try {
      console.warn("[@dsh-hanako/acp-assist] " + ((e && e.message) || e));
    } catch {
      /* 无日志通道静默 */
    }
  }
}
