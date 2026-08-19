// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/dsh-install.js — dsh 依赖安装/验证工具（v0.13.0）
// 宿主能力层（tools/lib/install.js installDepsFromPlugin / verifyDepsSmoke，经单例
// g.installDeps / g.verifyDeps 调用）的 Agent 入口，辅助依赖缺失场景（dsh_run 报
// 「dsh 包未就绪」、DSHana 标签页不可用等）：
//   action=install（默认）：npm i @deepseek-ai/dsh 到数据目录 dsh-pkg（含 registry
//     官方源失败自动重试 npmmirror + 自动运行级重验）→ 完成后 autoStart（默认 true：
//     web host 未起时经 g.startWebHost 拉起，失败不阻断结果上报；已起跳过）→
//     { installed: true, version, autoStart 结果 }。
//   action=verify：检测依赖完整性（g.verifyDeps：node cliBin --version 冒烟，能跑 =
//     依赖图完整）→ { verified, version, error? }。
// 默认异步：立即返回 + 渲染「安装卡片」（/card/dep，见 routes/card.js /ops/dep-stream，
// 数据源 = 宿主单例 g.depTasks + g.depsInstallLog 实时日志），完成/失败经宿主 deferred
// 通道唤醒 Agent 带回结果；wait=true 同步等待直接返回。
// 并发防护：依赖安装中（g.depsInstalling）重复 install 返回 { ok:false, state:'installing' }。
// 与 dsh-run.js 同一纪律：本工具不静态 import dsh-run.js/lib（Hana 以 ?t= 时间戳加载
// tools，静态 import 会命中 Node ESM 固定 URL 缓存读到旧模块），经 globalThis 单例
// （g.installDeps / g.verifyDeps / g.startWebHost / g.depTasks / g.depsInstallLog）调用；
// deferred 唤醒协议（register/resolve/fail）同 dsh-run.js 内联实现，不跨模块 import。

// ---- deferred 唤醒（宿主原生后台任务通道，协议同 dsh-run.js）----
// 工具发起时 deferred:register（登记 + 投递策略）→ 终态 resolve/fail → 宿主投递
// <hana-background-result> 给 Agent 会话（默认唤醒回合，结果结构化直达）。
// 容错纪律：唤醒是终态的旁路通知，任何失败都不抛回调用方（能力层结果不受影响）。
async function registerDeferredWake({ bus, sessionPath, taskId, label }) {
  if (!bus?.request || !sessionPath || !taskId) return false;
  try {
    await bus.request("deferred:register", {
      taskId,
      sessionPath,
      meta: {
        type: "dsh-install",
        label: String(label || ""),
        deliveryIntent: "trigger_parent_turn",
        notifyAgentOnFailure: true,
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveDeferredWake({ bus, taskId, result }) {
  if (!bus?.request || !taskId) return false;
  try {
    await bus.request("deferred:resolve", { taskId, result });
    return true;
  } catch {
    return false;
  }
}

async function failDeferredWake({ bus, taskId, error }) {
  if (!bus?.request || !taskId) return false;
  try {
    await bus.request("deferred:fail", { taskId, error });
    return true;
  } catch {
    return false;
  }
}

function buildVerifyText(r) {
  if (r?.ok) {
    return `DSH 依赖检测：通过（能跑 = 依赖图完整），版本 v${r.version || "?"}。`;
  }
  return `DSH 依赖检测：失败${r?.error ? "（" + r.error + "）" : ""}。可执行 dsh_install(action="install") 安装依赖，或查看 DSHana 标签页 deps 卡片。`;
}

function buildInstallText(r) {
  if (r && r.ok) {
    const start =
      r.autoStart === true
        ? "，web host 已自动启动"
        : r.autoStart === false
          ? "，web host 自动启动失败（可在 DSHana 标签页手动启动）"
          : "";
    return `DSH 依赖安装完成：v${r.version || "?"}${start}。`;
  }
  if (r && r.state === "installing") {
    return "DSH 依赖安装已在执行中（npm i @deepseek-ai/dsh），请稍候查看安装卡片或 DSHana 标签页。";
  }
  return `DSH 依赖安装失败：${(r && r.error) || "未知错误"}`;
}

export const name = "dsh_install";

export const description =
  "安装或验证 DeepSeek Harness（dsh）依赖：action=install（默认）npm i @deepseek-ai/dsh 到数据目录 dsh-pkg（registry 兜底 + 自动运行级重验 + autoStart 拉起 web host，渲染安装卡片）；" +
  "action=verify 只检测依赖完整性（运行级冒烟，只读）。" +
  "适用场景：dsh_run 报「dsh 包未就绪」、DSHana 标签页依赖缺失。" +
  "默认异步：后台执行 + 完成回调，wait=true 同步；安装中重复调用返回状态不重复执行。" +
  "完整调用手册见 SKILL: skills/dsh-install/SKILL.md";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["install", "verify"],
      description:
        "install=安装依赖（默认，npm i @deepseek-ai/dsh 到 dsh-pkg，registry 兜底 + 自动重验 + autoStart）；verify=只检测依赖完整性（运行级冒烟，只读）",
    },
    wait: {
      type: "boolean",
      description:
        "false（默认）= 异步：install 立即返回，后台执行 + 安装卡片实时日志，完成后宿主唤醒带回结果；true = 同步：等安装跑完直接返回最终结果（npm i 可能耗时数分钟，会阻塞当前回合）",
    },
    autoStart: {
      type: "boolean",
      description:
        "install 完成后是否自动启动 web host（默认 true：web host 未运行时经 startWebHost 拉起；失败不阻断结果上报）。verify 忽略",
    },
  },
  required: [],
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "external_api",
    summary:
      "安装或验证 DeepSeek Harness（dsh）依赖：npm i @deepseek-ai/dsh（消耗网络，写入插件数据目录 dsh-pkg），可选自动启动 dsh web host",
    ruleId: "dsh-hanako-dsh-install",
  }),
};

// 生成安装/升级卡片任务登记（g.depTasks，routes/card.js /ops/dep-stream 读）；
// log 在运行期由路由直接读 g.depsInstallLog 实时值，终态定格为 entry.log。
function registerDepTask(g, taskId, kind) {
  const entry = {
    taskId,
    kind, // install | update
    state: "running", // running | ok | error
    log: null, // 终态定格日志（运行期由路由读 g.depsInstallLog）
    at: new Date().toISOString(),
    result: null,
  };
  g.depTasks.set(taskId, entry);
  return entry;
}

// install 完成后 autoStart：web host 未起时经 g.startWebHost 拉起（失败不阻断）。
// 返回 null（web host 已就绪跳过）/ true（拉起成功）/ false（拉起失败）。
async function maybeAutoStart(g, ctx, cfg) {
  if (g?.web?.ready) return null; // 已起：跳过
  if (typeof g?.startWebHost !== "function") return null; // 能力缺失：跳过
  try {
    return (
      (await g.startWebHost(ctx.config, ctx.dataDir || g.dataDir)) === true
    );
  } catch {
    return false;
  }
}

async function doExecute(input, ctx) {
  const action = String(input.action ?? "install").trim() || "install";
  if (action !== "install" && action !== "verify") {
    throw new Error(`action 只能是 install 或 verify（收到：${action}）`);
  }
  const g = globalThis.__dshHanako;
  if (
    !g ||
    typeof g.installDeps !== "function" ||
    typeof g.verifyDeps !== "function"
  ) {
    throw new Error("插件工具模块未加载（dsh 能力层不可用），稍后重试");
  }
  const cfg = {
    dataDir: ctx.dataDir || g.dataDir,
    webPort: Number(ctx.config?.webPort) || 3080,
  };

  if (action === "verify") {
    const r = await g.verifyDeps(cfg);
    return {
      content: [{ type: "text", text: buildVerifyText(r) }],
      details: {
        dsh: {
          action: "verify",
          verified: r.ok,
          version: r.version,
          error: r.error || null,
        },
      },
    };
  }

  // action === "install"
  if (g.depsInstalling) {
    return {
      content: [
        {
          type: "text",
          text: "DSH 依赖安装已在执行中（npm i @deepseek-ai/dsh），请稍候查看安装卡片或 DSHana 标签页",
        },
      ],
      details: { dsh: { action: "install", state: "installing" } },
    };
  }
  const wait = input.wait === true;
  const autoStart = input.autoStart !== false; // 默认 true

  const doInstall = async () => {
    const r = await g.installDeps(cfg);
    if (r && r.ok && autoStart) {
      r.autoStart = await maybeAutoStart(g, ctx, cfg);
    }
    return r;
  };

  if (wait) {
    const r = await doInstall();
    return {
      content: [{ type: "text", text: buildInstallText(r) }],
      details: { dsh: { action: "install", ...r } },
    };
  }

  // 异步模式：登记安装卡片（g.depTasks）+ 注册 deferred 唤醒，后台执行不 await
  const taskId = `dsh_install_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const entry = registerDepTask(g, taskId, "install");
  const bus = ctx.bus ?? g.bus;
  const sessionPath = ctx.sessionPath;
  await registerDeferredWake({
    bus,
    sessionPath,
    taskId,
    label: "DSH 依赖安装（npm i @deepseek-ai/dsh）",
  });
  doInstall()
    .then((r) => {
      entry.state = r && r.ok ? "ok" : "error";
      entry.result = r || { ok: false, error: "安装无结果" };
      entry.log = (g.depsInstallLog || "").slice(-2000); // 终态定格日志
      if (r && r.ok) {
        resolveDeferredWake({
          bus,
          taskId,
          result: {
            tool: "dsh_install",
            action: "install",
            status: "done",
            installed: true,
            version: r.version || null,
            autoStart: r.autoStart ?? null,
          },
        });
      } else {
        failDeferredWake({
          bus,
          taskId,
          error: { message: (r && r.error) || "安装失败（无详情）" },
        });
      }
    })
    .catch((e) => {
      entry.state = "error";
      entry.result = { ok: false, error: String(e?.message || e) };
      entry.log = (g.depsInstallLog || "").slice(-2000);
      failDeferredWake({
        bus,
        taskId,
        error: { message: String(e?.message || e).slice(0, 300) },
      });
    });
  return {
    content: [
      {
        type: "text",
        text: "DSH 依赖安装已在后台执行（npm i @deepseek-ai/dsh，registry 兜底 + 自动运行级重验），完成后后台消息带回结果；进度与实时日志见上方安装卡片",
      },
    ],
    details: {
      dsh: { action: "install", state: "installing", taskId },
      card: {
        route: "/card/dep?taskId=" + encodeURIComponent(taskId),
        title: "DSH 安装",
        description: "npm i @deepseek-ai/dsh",
        aspectRatio: "16:1",
      },
    },
  };
}

export async function execute(input, ctx) {
  try {
    return await doExecute(input, ctx);
  } catch (e) {
    ctx.log?.error?.(
      "[dsh-hanako] dsh_install failed:",
      e?.stack || e?.message || String(e),
    );
    throw e;
  }
}
