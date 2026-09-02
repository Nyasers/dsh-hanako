// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/dsh-install.js — dsh 依赖安装/验证两合一工具（T7d：版本检查/更新整链退役——
// dsh 版本严格锁插件声明，更新 dsh = 更新插件发版）
// 宿主能力层（tools/lib/install.js installDepsFromPlugin / verifyDepsSmoke，经单例
// g.installDeps / g.verifyDeps 调用）的 Agent 入口：
//   action=install（默认）：按插件根 package.json 声明版本 pnpm install --prod（
//     dsh-pkg 退役——依赖装进插件根 node_modules；registry 官方源失败自动重试
//     npmmirror + 自动运行级重验）→ 完成后 autoStart（默认 true：
//     web host 未起时经 g.startWebHost 拉起，失败不阻断结果上报；已起跳过）→
//     { installed: true, version, autoStart 结果 }。
//   action=verify：检测依赖完整性（g.verifyDeps 静态核对：cliBin 存在 + 磁盘版本 === 插件
//     声明，秒回无子进程——去 spawn 2026-09-02，运行级裁决由 boot 进程内承担）→ { verified,
//     version, error? }。
// 默认异步：立即返回 + 渲染「安装卡片」（/card/dep，见 routes/card.js /ops/dep-stream，
// 数据源 = 宿主单例 g.depTasks + g.deps.log 实时日志），完成/失败经宿主 deferred
// 通道唤醒 Agent 带回结果；wait=true 同步等待直接返回。
// 并发防护：依赖安装中（g.deps.status === "installing"/"running"）重复 install 返回
// { ok:false, state:'installing' }；install 占 g.depBusy（{ kind: "install" }，
// getSingleton 初始化兜底）防跨动作竞态，操作完成/失败后释放——能力层守卫
// （g.deps.status）保留，覆盖 webui 路由等其他调用路径（双保险）。verify 不占用互斥。
// 与 dsh-run.js 同一分发纪律：本工具经 globalThis 单例调用能力层；deferred 唤醒协议
// （register/resolve/fail）不再各自内联，统一 import 共享的 ./lib/wake.js（dsh-run /
// dsh-install 两入口共用一份；meta.type 统一用 "dsh-install"——原 dsh-update 标识废弃）。
// lib/wake.js 是纯协议零状态模块，rspack 入口静态 import 内联进 bundle，?t= 重载即刷新。
import {
  registerDeferredWake,
  resolveDeferredWake,
  failDeferredWake,
} from "./lib/wake.js";

// 安装目标展示文本（T7a 起，按声明版本安装）：T7d 起无 spec 逃生门——恒按插件根
// package.json 的 dependencies 声明安装（pnpm install --prod）。
function pkgTargetText() {
  return "pnpm install 按插件声明";
}

function buildVerifyText(r) {
  if (r?.ok) {
    return "DSH 依赖检测：通过（磁盘版本与插件声明一致），版本 v" + (r.version || "?") + "。";
  }
  return "DSH 依赖检测：失败" + (r?.error ? "（" + r.error + "）" : "") + "。可执行 dsh_install(action='install') 安装依赖，或查看 DSHana 标签页 deps 卡片。";
}

function buildInstallText(r) {
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
    return "DSH 依赖安装已在执行中（" + pkgTargetText() + "），请稍候查看安装卡片或 DSHana 标签页。";
  }
  return "DSH 依赖安装失败：" + ((r && r.error) || "未知错误");
}

export const name = "dsh_install";

export const description =
  "安装/验证 DeepSeek Harness（DSH）依赖两合一：action=install（默认）按插件声明版本 pnpm install --prod（dsh-pkg 退役——依赖装进插件根 node_modules，无 version/tag 逃生门；registry 兜底 + 自动运行级重验 + autoStart 拉起 web host，渲染安装卡片）；" +
  "action=verify 只做静态完整性核对（cliBin 存在 + 磁盘版本与声明一致，只读秒回）。" +
  "版本严格锁插件 package.json 声明（更新 dsh = 更新插件发版，无独立升级通道）。" +
  "适用场景：dsh_session create 报「DSH 包未就绪」、DSHana 标签页依赖缺失。" +
  "默认异步：后台执行 + 完成回调，wait=true 同步；安装进行中重复调用返回状态不重复执行。" +
  "完整调用手册见 SKILL: skills/dsh-install/SKILL.md";

export const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["install", "verify"],
      description:
        "install=安装依赖（默认，按插件声明版本 pnpm install --prod 到插件 node_modules，registry 兜底 + 自动核对 + autoStart）；verify=只做静态完整性核对（cliBin + 版本 vs 声明，只读）",
    },
    wait: {
      type: "boolean",
      description:
        "false（默认）= 异步：install 立即返回，后台执行 + 卡片实时日志，完成后宿主唤醒带回结果；true = 同步：等安装跑完直接返回最终结果（pnpm install 可能耗时数分钟，会阻塞当前回合）",
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
      "安装/验证 DeepSeek Harness（DSH）依赖：按插件声明版本 pnpm install --prod（消耗网络，写入插件根 node_modules），可选自动启动 DSH web host；update 会停止并重启 DSH web host，正在执行的 DSH 任务会中断",
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
  if (["install", "verify"].indexOf(action) === -1) {
    throw new Error("action 只能是 install/verify（收到：" + action + "）");
  }
  const g = globalThis.__dshHanako;
  if (
    !g ||
    typeof g.installDeps !== "function" ||
    typeof g.verifyDeps !== "function"
  ) {
    throw new Error("插件工具模块未加载（DSH 能力层不可用），稍后重试");
  }
  const cfg = {
    dataDir: ctx.dataDir || g.dataDir,
    webPort: Number(ctx.config?.webPort) || 3080,
  };
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
          text: "DSH 依赖安装已在执行中（" + pkgTargetText() + "），请稍候查看安装卡片或 DSHana 标签页",
        },
      ],
      details: { dsh: { action: "install", state: "installing" } },
    };
  }
  // 共享依赖操作互斥（vX）：install 占 g.depBusy 防跨动作竞态（能力层守卫见上，
  // 同步段检查——第一个 await 之前；同 kind 竞态窗口内 status 尚未置位时返回安装中文案）
  if (g.depBusy) {
    return {
      content: [{ type: "text", text: "DSH 依赖安装已在执行中（" + pkgTargetText() + "），请稍候查看安装卡片或 DSHana 标签页" }],
      details: {
        dsh: { action: "install", state: "installing", blockedBy: g.depBusy.kind },
      },
    };
  }
  g.depBusy = { kind: "install" };
  const autoStart = input.autoStart !== false; // 默认 true

  const doInstall = async () => {
    const r = await g.installDeps(cfg);
    if (r && r.ok && autoStart) {
      r.autoStart = await maybeAutoStart(g, ctx, cfg);
    }
    return r;
  };

  if (wait) {
    try {
      const r = await doInstall();
      return {
        content: [{ type: "text", text: buildInstallText(r) }],
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
    label: "DSH 依赖安装（" + pkgTargetText() + "）",
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
        text: "DSH 依赖安装已在后台执行（" + pkgTargetText() + "，registry 兜底 + 自动运行级重验），完成后后台消息带回结果；进度与实时日志见上方安装卡片",
      },
    ],
    details: {
      dsh: { action: "install", state: "installing", taskId },
      card: {
        route: "/card/dep?taskId=" + encodeURIComponent(taskId),
        title: "DSH 安装",
        description: pkgTargetText(),
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
