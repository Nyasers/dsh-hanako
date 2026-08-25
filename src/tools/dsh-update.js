// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/dsh-update.js — dsh 安装/检查/更新工具
// 宿主能力层（tools/dsh-run.js checkDshUpdate / updateDsh）的 Agent 入口，三个消费面
// （Agent 工具 / DSHana 标签页 webui 路由 / dsh 设置页桥接）共用同一能力层：
//   action=check（默认）：查本地版本（运行级验证缓存优先，无则直读 dsh-pkg
//     package.json）+ 远端版本（npm view，官方源失败重试 npmmirror，15s 超时）
//     → { localVersion, latestVersion, updateAvailable, error? }；zero-dep semver
//     比较（major.minor.patch 三段数字逐个比，预发布 -rc.x 视为低于同版本正式版）。
//   action=update：完整更新——停 web host（closeProcess，Windows 文件锁前提）→
//     npm i @deepseek-ai/dsh（latest，installDepsFromPlugin）→ 起 web host
//     （ensureWebHost）→ 读新版本；写 <dataDir>/update-result.json
//     { state: done|error, version?, error?, at }（设置页/标签页轮询读）。
//     默认异步：立即返回 + 渲染「升级卡片」（/card/dep，数据源 = 宿主单例 g.depTasks +
//     g.depsInstallLog + update-result.json，见 routes/card.js /ops/dep-stream），
//     完成/失败经宿主 deferred 通道唤醒 Agent 带回结果；wait=true 同步等待直接返回。
// 并发防护：更新执行中（g.updating）重复调用返回状态不重复执行（能力层内防护）。
// 与 dsh-run.js 同一分发纪律：本工具不静态 import dsh-run.js（Hana 以 ?t= 时间戳加载
// tools，静态 import 会命中 Node ESM 固定 URL 缓存读到旧模块，见 dsh-run.js 头部注释），
// 经 globalThis 单例（g.checkDshUpdate / g.updateDsh / g.bus）调用；
// deferred 唤醒协议（register/resolve/fail）不再各自内联，统一 import 共享的 ./lib/wake.js
// （三入口 dsh-run/dsh-install/dsh-update 共用一份，消除三重复；meta.type 由调用方
// 传入保留本工具标识 dsh-update）。lib/wake.js 是纯协议零状态模块，rspack 入口静态 import
// 内联进 bundle，?t= 重载即刷新，无"静态 import 固定 URL 缓存"问题。
import {
  registerDeferredWake,
  resolveDeferredWake,
  failDeferredWake,
} from "./lib/wake.js";

function buildCheckText(r) {
  const local = r?.localVersion || "未安装";
  if (r?.latestVersion === null && r?.error) {
    return `DSH 版本检查：本地 ${local}，远端版本查询失败（${r.error}）。可稍后重试或检查网络/registry。`;
  }
  if (r?.localVersion === null) {
    return `DSH 版本检查：本地未安装 dsh，最新版本 v${r?.latestVersion || "?"}。请先安装依赖（DSHana 标签页「安装依赖」或 npm i @deepseek-ai/dsh）。`;
  }
  if (r?.updateAvailable) {
    return `DSH 版本检查：本地 v${local}，最新 v${r.latestVersion}，可更新。`;
  }
  return `DSH 版本检查：本地 v${local}，已是最新版本${r?.latestVersion ? "（v" + r.latestVersion + "）" : ""}。`;
}

function buildUpdateText(r) {
  if (r && r.ok && r.state === "done") {
    return `DSH 更新完成：v${r.version || "?"}${r.error ? "（web host 重启失败：" + r.error + "）" : ""}。新任务将使用新版本，请重启 DSHana 使完全生效。`;
  }
  if (r && r.state === "updating") {
    return "DSH 更新已在执行中（将重启 web host，正在执行的任务会中断），请稍候查看 update-status 或 DSHana 标签页。";
  }
  return `DSH 更新失败：${(r && r.error) || "未知错误"}`;
}

export const name = "dsh_update";

export const description =
  "检查或更新 DeepSeek Harness（dsh）版本（宿主能力层单一事实源）：action=check（默认）查本地/远端版本与可更新状态，只读；" +
  "action=update 执行完整更新（停 web host → npm i @deepseek-ai/dsh latest → 起 web host，正在执行的任务会中断）。" +
  "默认异步：后台执行 + 完成回调，wait=true 同步；更新中重复调用返回状态不重复执行。" +
  "完整调用手册见 SKILL: skills/dsh-update/SKILL.md";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["check", "update"],
      description:
        "check=只查版本（默认，本地 + 远端 + 可更新判断，不修改任何东西）；update=执行完整更新（停 web host → npm i @deepseek-ai/dsh latest → 起 web host，正在执行的 dsh 任务会中断）",
    },
    wait: {
      type: "boolean",
      description:
        "false（默认）= 异步：update 立即返回，更新在后台执行，完成后宿主唤醒带回结果；true = 同步：等更新跑完直接返回最终结果（npm i 可能耗时数分钟，会阻塞当前回合）",
    },
  },
  required: [],
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "external_api",
    summary:
      "检查或更新 DeepSeek Harness（dsh）版本：更新会停止并重启 dsh web host（npm i @deepseek-ai/dsh，消耗网络），正在执行的 dsh 任务会中断",
    ruleId: "dsh-hanako-dsh-update",
  }),
};

async function doExecute(input, ctx) {
  const action = String(input.action ?? "check").trim() || "check";
  if (action !== "check" && action !== "update") {
    throw new Error(`action 只能是 check 或 update（收到：${action}）`);
  }
  const g = globalThis.__dshHanako;
  if (
    !g ||
    typeof g.checkDshUpdate !== "function" ||
    typeof g.updateDsh !== "function"
  ) {
    throw new Error("插件工具模块未加载（dsh 能力层不可用），稍后重试");
  }
  const cfg = {
    dataDir: ctx.dataDir || g.dataDir,
    webPort: Number(ctx.config?.webPort) || 3080,
  };

  if (action === "check") {
    const r = await g.checkDshUpdate(cfg);
    return {
      content: [{ type: "text", text: buildCheckText(r) }],
      details: { dsh: { action: "check", ...r } },
    };
  }

  // action === "update"
  if (g.updating) {
    return {
      content: [
        {
          type: "text",
          text: "DSH 更新已在执行中（将重启 web host，正在执行的任务会中断），请稍候查看 update-status 或 DSHana 标签页",
        },
      ],
      details: { dsh: { action: "update", status: "updating" } },
    };
  }
  const wait = input.wait === true;
  if (wait) {
    const r = await g.updateDsh(cfg);
    return {
      content: [{ type: "text", text: buildUpdateText(r) }],
      details: { dsh: { action: "update", ...r } },
    };
  }
  // 异步模式：登记升级卡片（g.depTasks，/card/dep）+ 注册 deferred 唤醒（完成后宿主
  // 唤醒，结果后台送达），后台执行不 await。卡片数据源 = g.depTasks + g.depsInstallLog
  // （updateDsh 内部 npm i 输出实时写入）+ update-result.json（routes/card.js 快照合并）。
  const taskId = `dsh_update_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const entry = {
    taskId,
    kind: "update",
    state: "running",
    log: null, // 终态定格日志（运行期由 /ops/dep-stream 读 g.depsInstallLog）
    at: new Date().toISOString(),
    result: null,
  };
  g.depTasks.set(taskId, entry);
  const bus = ctx.bus ?? g.bus;
  const sessionPath = ctx.sessionPath;
  await registerDeferredWake({
    bus,
    sessionPath,
    taskId,
    label: "DSH 更新（npm i @deepseek-ai/dsh latest，重启 web host）",
    type: "dsh-update",
  });
  g.updateDsh(cfg)
    .then((r) => {
      entry.state = r && r.ok ? "ok" : "error";
      entry.result = r || { ok: false, error: "更新无结果" };
      entry.log = (g.depsInstallLog || "").slice(-2000); // 终态定格日志
      if (r && r.ok) {
        resolveDeferredWake({
          bus,
          taskId,
          result: {
            tool: "dsh_update",
            action: "update",
            status: "done",
            version: r.version || null,
            ...(r.error ? { error: r.error } : {}),
          },
        });
      } else {
        failDeferredWake({
          bus,
          taskId,
          error: { message: (r && r.error) || "更新失败（无详情）" },
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
        text: "DSH 更新已在后台执行（将重启 web host，正在执行的任务会中断），完成后后台消息带回结果（新版本号）；进度与实时日志见上方升级卡片，也可在 DSHana 标签页或 dsh 设置页「DSH 版本」块查看",
      },
    ],
    details: {
      dsh: { action: "update", status: "updating", taskId },
      card: {
        route: "/card/dep?taskId=" + encodeURIComponent(taskId),
        title: "DSH 升级",
        description: "npm i @deepseek-ai/dsh",
      },
    },
  };
}

export async function execute(input, ctx) {
  try {
    return await doExecute(input, ctx);
  } catch (e) {
    ctx.log?.error?.(
      "[dsh-hanako] dsh_update failed:",
      e?.stack || e?.message || String(e),
    );
    throw e;
  }
}
