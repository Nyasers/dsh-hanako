// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/dsh-install.js — dsh 依赖安装/验证 + 版本检查/更新四合一工具
// 宿主能力层（tools/lib/install.js installDepsFromPlugin / verifyDepsSmoke、lib/check.js
// checkDshUpdate，经单例 g.installDeps / g.verifyDeps / g.checkDshUpdate / g.updateDsh
// 调用）的 Agent 入口（vX 起合并原 dsh_update 工具）：
//   action=install（默认）：pnpm add @deepseek-ai/dsh（可指定 version/tag；registry
//     官方源失败自动重试 npmmirror + 自动运行级重验）→ 完成后 autoStart（默认 true：
//     web host 未起时经 g.startWebHost 拉起，失败不阻断结果上报；已起跳过）→
//     { installed: true, version, autoStart 结果 }。
//   action=verify：检测依赖完整性（g.verifyDeps：node cliBin --version 冒烟，能跑 =
//     依赖图完整）→ { verified, version, error? }。
//   action=check：版本检查（g.checkDshUpdate：本地版本 + 远端 dist-tags + 基线 tag →
//     { localVersion, distTags, baselineTag, baselineVersion, updateAvailable, error? }，
//     只读；可指定 version/tag 对比）。
//   action=update：完整更新（g.updateDsh：停 web host → pnpm add（可指定 version/tag）
//     → 起 web host → 读新版本）。
// 版本/tag 参数：version（具体版本号）优先于 tag（dist-tag），二者都不传时用配置基线
// （config.json global.dshTag，默认 "latest"，见 lib/config.js resolveDshTag）。
// 默认异步：立即返回 + 渲染「安装/升级卡片」（/card/dep，见 routes/card.js /ops/dep-stream，
// 数据源 = 宿主单例 g.depTasks + g.deps.log 实时日志），完成/失败经宿主 deferred
// 通道唤醒 Agent 带回结果；wait=true 同步等待直接返回。
// 并发防护：依赖安装中（g.deps.status === "installing"/"running"）重复 install 返回
// { ok:false, state:'installing' }；更新执行中（g.update.status === "running"）重复
// update 返回 { ok:false, state:'updating' }。install/update 另共享预留状态
// g.depBusy（null | { kind: "install"|"update" }，getSingleton 初始化兜底）：任一进行中
// 另一动作在同步段即拒绝（install 撞 update 返回更新中文案、update 撞 install 返回安装
// 中文案），操作完成/失败后释放——能力层守卫（g.deps.status / g.update.status）保留，
// 覆盖 webui 路由等其他调用路径（双保险）。verify/check 不占用互斥。
// 与 dsh-run.js 同一分发纪律：本工具经 globalThis 单例调用能力层；deferred 唤醒协议
// （register/resolve/fail）不再各自内联，统一 import 共享的 ./lib/wake.js（dsh-run /
// dsh-install 两入口共用一份；meta.type 统一用 "dsh-install"——原 dsh-update 标识废弃）。
// lib/wake.js 是纯协议零状态模块，rspack 入口静态 import 内联进 bundle，?t= 重载即刷新。
import {
  registerDeferredWake,
  resolveDeferredWake,
  failDeferredWake,
} from "./lib/wake.js";

// pnpm add 目标展示文本（版本/tag 描述）：spec = version || tag（显式参数），未显式传
// 时展示无 @ 后缀（能力层回退配置基线 dshTag，默认 latest）。
function pkgTargetText(spec) {
  return "pnpm add @deepseek-ai/dsh" + (spec ? "@" + spec : "");
}

function buildVerifyText(r) {
  if (r?.ok) {
    return "DSH 依赖检测：通过（能跑 = 依赖图完整），版本 v" + (r.version || "?") + "。";
  }
  return "DSH 依赖检测：失败" + (r?.error ? "（" + r.error + "）" : "") + "。可执行 dsh_install(action='install') 安装依赖，或查看 DSHana 标签页 deps 卡片。";
}

function buildInstallText(r, spec) {
  if (r && r.ok) {
    const start =
      r.autoStart === true
        ? "，web host 已自动启动"
        : r.autoStart === false
          ? "，web host 自动启动失败（可在 DSHana 标签页手动启动）"
          : "";
    return "DSH 依赖安装完成：v" + (r.version || "?") + start + "。";
  }
  if (r && r.state === "installing") {
    return "DSH 依赖安装已在执行中（" + pkgTargetText(spec) + "），请稍候查看安装卡片或 DSHana 标签页。";
  }
  return "DSH 依赖安装失败：" + ((r && r.error) || "未知错误");
}

function buildCheckText(r) {
  const local = r?.localVersion || "未安装";
  const baselineLabel = r?.baselineTag ? "基线 " + r.baselineTag : "指定版本";
  if (r?.baselineVersion === null && r?.error) {
    return "DSH 版本检查：本地 " + local + "，远端版本查询失败（" + r.error + "）。可稍后重试或检查网络/registry。";
  }
  if (r?.localVersion === null) {
    return "DSH 版本检查：本地未安装 DSH，" + baselineLabel + " v" + (r?.baselineVersion || "?") + "。请先安装依赖（DSHana 标签页「安装依赖」或 dsh_install(action='install')）。";
  }
  if (r?.updateAvailable) {
    return "DSH 版本检查：本地 v" + local + "，" + baselineLabel + " v" + (r?.baselineVersion || "?") + "，可更新。";
  }
  return "DSH 版本检查：本地 v" + local + "，已是最新版本" + (r?.baselineVersion ? "（" + baselineLabel + " v" + r.baselineVersion + "）" : "") + "。";
}

function buildUpdateText(r) {
  if (r && r.ok && r.state === "done") {
    return "DSH 更新完成：v" + (r.version || "?") + (r.error ? "（web host 重启失败：" + r.error + "）" : "") + "。新任务将使用新版本，请重启 DSHana 使完全生效。";
  }
  if (r && r.state === "updating") {
    return "DSH 更新已在执行中（将重启 web host，正在执行的任务会中断），请稍候查看 update-status 或 DSHana 标签页。";
  }
  return "DSH 更新失败：" + ((r && r.error) || "未知错误");
}

export const name = "dsh_install";

export const description =
  "安装/验证 DeepSeek Harness（DSH）依赖与检查/更新 DSH 版本四合一：action=install（默认）pnpm add @deepseek-ai/dsh（可指定 version/tag）到数据目录 dsh-pkg（registry 兜底 + 自动运行级重验 + autoStart 拉起 web host，渲染安装卡片）；" +
  "action=verify 只检测依赖完整性（运行级冒烟，只读）；" +
  "action=check 版本检查（本地 + 远端 dist-tags + 基线 tag，只读）；" +
  "action=update 完整更新（停 web host → pnpm add → 起 web host，渲染升级卡片，正在执行的任务会中断）。" +
  "version 参数优先于 tag 参数，都不传用配置基线（config.json global.dshTag，默认 latest）。" +
  "适用场景：dsh_run 报「DSH 包未就绪」、DSHana 标签页依赖缺失、需要检查/更新 dsh 版本。" +
  "默认异步：后台执行 + 完成回调，wait=true 同步；安装/更新进行中重复调用返回状态不重复执行。" +
  "完整调用手册见 SKILL: skills/dsh-install/SKILL.md";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["install", "verify", "check", "update"],
      description:
        "install=安装依赖（默认，pnpm add @deepseek-ai/dsh 到 dsh-pkg，可指定 version/tag，registry 兜底 + 自动重验 + autoStart）；verify=只检测依赖完整性（运行级冒烟，只读）；check=版本检查（本地 + 远端 dist-tags + 基线 tag，只读）；update=完整更新（停 web host → pnpm add → 起 web host，正在执行的 dsh 任务会中断）",
    },
    wait: {
      type: "boolean",
      description:
        "false（默认）= 异步：install/update 立即返回，后台执行 + 卡片实时日志，完成后宿主唤醒带回结果；true = 同步：等安装/更新跑完直接返回最终结果（pnpm add 可能耗时数分钟，会阻塞当前回合）",
    },
    autoStart: {
      type: "boolean",
      description:
        "install 完成后是否自动启动 web host（默认 true：web host 未运行时经 startWebHost 拉起；失败不阻断结果上报）。verify/check/update 忽略",
    },
    version: {
      type: "string",
      description:
        "具体版本号（如「1.0.0-alpha.1」）：install/update 时 pnpm add @deepseek-ai/dsh@<version>；check 时对比该版本（远端查询指定版本是否存在）。优先于 tag 与配置基线",
    },
    tag: {
      type: "string",
      description:
        "dist-tag（如「latest」/「next」/「alpha」）：install/update 时 pnpm add @deepseek-ai/dsh@<tag>；check 时作为对比基线。显式传优先于配置基线（config.json global.dshTag，默认 latest）；version 参数优先于 tag",
    },
  },
  required: [],
};

export const sessionPermission = {
  kind: "external_side_effect",
  describeSideEffect: () => ({
    kind: "external_api",
    summary:
      "安装/验证/检查/更新 DeepSeek Harness（DSH）依赖与版本：pnpm add @deepseek-ai/dsh（消耗网络，写入插件数据目录 dsh-pkg），可选自动启动 DSH web host；update 会停止并重启 DSH web host，正在执行的 DSH 任务会中断",
    ruleId: "dsh-hanako-dsh-install",
  }),
};

// 生成安装/升级卡片任务登记（g.depTasks，routes/card.js /ops/dep-stream 读）；
// log 在运行期由路由直接读 g.deps.log 实时值，终态定格为 entry.log。
function registerDepTask(g, taskId, kind) {
  const entry = {
    taskId,
    kind, // install | update（卡片标题「DSH 安装/DSH 升级」按 kind 区分）
    state: "running", // running | ok | error
    log: null, // 终态定格日志（运行期由路由读 g.deps.log）
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
  if (["install", "verify", "check", "update"].indexOf(action) === -1) {
    throw new Error("action 只能是 install/verify/check/update（收到：" + action + "）");
  }
  const g = globalThis.__dshHanako;
  if (
    !g ||
    typeof g.installDeps !== "function" ||
    typeof g.verifyDeps !== "function" ||
    typeof g.checkDshUpdate !== "function" ||
    typeof g.updateDsh !== "function"
  ) {
    throw new Error("插件工具模块未加载（DSH 能力层不可用），稍后重试");
  }
  const cfg = {
    dataDir: ctx.dataDir || g.dataDir,
    webPort: Number(ctx.config?.webPort) || 3080,
  };
  // 版本/tag 解析：version 优先于 tag（显式参数）；都不传时由能力层回退配置基线
  // （resolveDshTag：config.json global.dshTag，默认 latest）
  const version = String(input.version || "").trim();
  const tag = String(input.tag || "").trim();
  const spec = version || tag || "";
  const wait = input.wait === true;

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

  if (action === "check") {
    const r = await g.checkDshUpdate(cfg, { version, tag });
    return {
      content: [{ type: "text", text: buildCheckText(r) }],
      details: { dsh: { action: "check", ...r } },
    };
  }

  if (action === "update") {
    // 更新进行中（g.update.status === "running"）：重复 update 返回状态不重复执行
    if (g.update.status === "running") {
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
    // 共享依赖操作互斥（vX）：install/update 任一进行中另一动作拒绝。能力层守卫
    // （g.update.status / g.deps.status）覆盖 webui 路由等其他调用路径，这里是工具
    // 自身跨动作竞态的同步段检查（第一个 await 之前）。update 撞 install：返回安装
    // 中文案；同 kind（竞态窗口内 status 尚未置位）返回更新中文案。
    if (g.depBusy) {
      const busyText =
        g.depBusy.kind === "install"
          ? "DSH 依赖安装已在执行中（" + pkgTargetText(spec) + "），请稍候查看安装卡片或 DSHana 标签页"
          : "DSH 更新已在执行中（将重启 web host，正在执行的任务会中断），请稍候查看 update-status 或 DSHana 标签页";
      return {
        content: [{ type: "text", text: busyText }],
        details: {
          dsh: { action: "update", status: "updating", blockedBy: g.depBusy.kind },
        },
      };
    }
    g.depBusy = { kind: "update" };
    if (wait) {
      try {
        const r = await g.updateDsh(cfg, spec);
        return {
          content: [{ type: "text", text: buildUpdateText(r) }],
          details: { dsh: { action: "update", ...r } },
        };
      } finally {
        g.depBusy = null; // 释放互斥（wait 同步路径：await 后，含失败）
      }
    }
    // 异步模式：登记升级卡片（g.depTasks，/card/dep）+ 注册 deferred 唤醒
    // （meta.type 统一 "dsh-install"——原 dsh-update 标识废弃；卡片 kind=update
    // 保留「DSH 升级」标题区分，routes/card.js + src/assets/card.js 按 kind 消费）
    const taskId = "dsh_install_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
    const entry = registerDepTask(g, taskId, "update");
    const bus = ctx.bus ?? g.bus;
    const sessionPath = ctx.sessionPath;
    await registerDeferredWake({
      bus,
      sessionPath,
      taskId,
      label: "DSH 更新（" + pkgTargetText(spec) + "，重启 web host）",
      type: "dsh-install",
    });
    g.updateDsh(cfg, spec)
      .then((r) => {
        g.depBusy = null; // 释放互斥（异步路径 then 内，操作完成）
        entry.state = r && r.ok ? "ok" : "error";
        entry.result = r || { ok: false, error: "更新无结果" };
        entry.log = (g.deps.log || "").slice(-2000); // 终态定格日志
        if (r && r.ok) {
          resolveDeferredWake({
            bus,
            taskId,
            result: {
              tool: "dsh_install",
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
        g.depBusy = null; // 释放互斥（异步路径 catch 内，操作失败）
        entry.state = "error";
        entry.result = { ok: false, error: String(e?.message || e) };
        entry.log = (g.deps.log || "").slice(-2000);
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
          text: "DSH 更新已在后台执行（" + pkgTargetText(spec) + "，将重启 web host，正在执行的任务会中断），完成后后台消息带回结果（新版本号）；进度与实时日志见上方升级卡片，也可在 DSHana 标签页或 DSH 设置页「DSH 版本」块查看",
        },
      ],
      details: {
        dsh: { action: "update", status: "updating", taskId },
        card: {
          route: "/card/dep?taskId=" + encodeURIComponent(taskId),
          title: "DSH 升级",
          description: pkgTargetText(spec) + "（更新）",
          aspectRatio: "16:1",
        },
      },
    };
  }

  // action === "install"
  // installing+running 都是「依赖操作进行中」（install 内部重验期间 status 短暂为
  // running），此时重复 install 直接返回状态不重复执行（与能力层内部守卫一致）
  if (
    g.deps.status === "installing" ||
    g.deps.status === "running"
  ) {
    return {
      content: [
        {
          type: "text",
          text: "DSH 依赖安装已在执行中（" + pkgTargetText(spec) + "），请稍候查看安装卡片或 DSHana 标签页",
        },
      ],
      details: { dsh: { action: "install", state: "installing" } },
    };
  }
  // 共享依赖操作互斥（vX）：install 撞 update 返回更新中文案（能力层守卫见上，
  // g.depBusy 是跨动作竞态的同步段检查——第一个 await 之前；同 kind 竞态窗口内
  // status 尚未置位时返回安装中文案）
  if (g.depBusy) {
    const busyText =
      g.depBusy.kind === "update"
        ? "DSH 更新已在执行中（将重启 web host，正在执行的任务会中断），请稍候查看 update-status 或 DSHana 标签页"
        : "DSH 依赖安装已在执行中（" + pkgTargetText(spec) + "），请稍候查看安装卡片或 DSHana 标签页";
    return {
      content: [{ type: "text", text: busyText }],
      details: {
        dsh: { action: "install", state: "installing", blockedBy: g.depBusy.kind },
      },
    };
  }
  g.depBusy = { kind: "install" };
  const autoStart = input.autoStart !== false; // 默认 true

  const doInstall = async () => {
    const r = await g.installDeps(cfg, { spec });
    if (r && r.ok && autoStart) {
      r.autoStart = await maybeAutoStart(g, ctx, cfg);
    }
    return r;
  };

  if (wait) {
    try {
      const r = await doInstall();
      return {
        content: [{ type: "text", text: buildInstallText(r, spec) }],
        details: { dsh: { action: "install", ...r } },
      };
    } finally {
      g.depBusy = null; // 释放互斥（wait 同步路径：await 后，含失败）
    }
  }

  // 异步模式：登记安装卡片（g.depTasks）+ 注册 deferred 唤醒，后台执行不 await
  const taskId = "dsh_install_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  const entry = registerDepTask(g, taskId, "install");
  const bus = ctx.bus ?? g.bus;
  const sessionPath = ctx.sessionPath;
  await registerDeferredWake({
    bus,
    sessionPath,
    taskId,
    label: "DSH 依赖安装（" + pkgTargetText(spec) + "）",
    type: "dsh-install",
  });
  doInstall()
    .then((r) => {
      g.depBusy = null; // 释放互斥（异步路径 then 内，操作完成）
      entry.state = r && r.ok ? "ok" : "error";
      entry.result = r || { ok: false, error: "安装无结果" };
      entry.log = (g.deps.log || "").slice(-2000); // 终态定格日志
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
      g.depBusy = null; // 释放互斥（异步路径 catch 内，操作失败）
      entry.state = "error";
      entry.result = { ok: false, error: String(e?.message || e) };
      entry.log = (g.deps.log || "").slice(-2000);
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
        text: "DSH 依赖安装已在后台执行（" + pkgTargetText(spec) + "，registry 兜底 + 自动运行级重验），完成后后台消息带回结果；进度与实时日志见上方安装卡片",
      },
    ],
    details: {
      dsh: { action: "install", state: "installing", taskId },
      card: {
        route: "/card/dep?taskId=" + encodeURIComponent(taskId),
        title: "DSH 安装",
        description: pkgTargetText(spec),
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
