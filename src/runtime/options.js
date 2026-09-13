// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/options.js — 受管 runtime 子进程自有参数解析（dsh-host 专用）
//
// 参数名由 App 主进程侧 lib/managed-runtime.js buildRuntimeArgs() 构造并保持一致
//（本文件与 managed-runtime.js 是对偶契约；增删参数须两处同步 + tests/ 用例同步）。
// 宿主（ctx.runtime.start）不解析这些参数——它们是 App 自有 args，子进程自己认。
//
// 支持形态：--flag value 与 --flag=value；值含空格时必须整体作为单个 argv 传入
//（宿主 start.args 是数组，天然支持）；未知参数/缺失必选 → usageError（exit code 2）。
// 端口显式契约（迁移指南 §10）：必须 1..65535 的显式端口，禁 0（禁随机 + 回读——宿主
// 不认「子进程自报端口」，service.port 声明即契约）。
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 2;
  }
}

/** 本进程接受的 App 自有参数（与 managed-runtime.js buildRuntimeArgs 对偶）。 */
export const FLAGS = [
  "port",
  "data-dir",
  "hana-task-id",
  "deps-root",
  "cordis-src",
  "ready-marker",
  "no-ensure",
  "help",
];

export const USAGE = `用法：dsh-host.mjs（dsh-hanako App v2 受管 Node runtime 入口，由 ctx.runtime.start 启动）
必选参数：
  --port <port>        DSH webserver 显式监听端口（1..65535；须与启动端 service.port 一致，禁 0）
  --data-dir <dir>     App ctx.dataDir 绝对路径（dsh-home / runtime 依赖区 / logs 均在 dataDir 下）
可选参数：
  --hana-task-id <id>  发起本次启动的 Hana taskId（信息性；任务/会话映射在迁移步骤 3 接入）
  --deps-root <dir>    依赖 node_modules 根（默认 <data-dir>/runtime/node_modules；调试/预置覆盖）
  --cordis-src <dir>   @dsh-hanako cordis 产物 scope 根（默认 <App 安装目录>/cordis）
  --ready-marker <s>   服务就绪标记（默认 DSH_READY；必须与 start.service.readyMarker 完全一致）
  --no-ensure          跳过依赖 ensure（deps 已预置场景；缺失时给出清晰错误并退出）
  --help               显示本帮助
`;

function takeValue(argv, i, flag, inline) {
  if (inline !== undefined) return { value: inline, next: i + 1 };
  const v = argv[i + 1];
  if (v === undefined || v === "") {
    throw new UsageError(`缺少参数值：--${flag} <value>`);
  }
  return { value: v, next: i + 2 };
}

/** 带值参数集（--flag <value> / --flag=<value>）；no-ensure/help 是无值开关。 */
const VALUE_FLAGS = new Set(["port", "data-dir", "hana-task-id", "deps-root", "cordis-src", "ready-marker"]);
const BOOL_FLAGS = new Set(["no-ensure", "help"]);

/**
 * 解析 argv（不含 node/script 前缀的纯参数数组）。
 * @returns 规范化选项对象（parse 纯函数，便于 node:test 单测）
 */
export function parseArgs(argv) {
  const raw = Array.isArray(argv) ? argv : [];
  const opts = {
    taskId: null,
    port: null,
    dataDir: null,
    depsRoot: null,
    cordisSrc: null,
    readyMarker: "DSH_READY",
    noEnsure: false,
    help: false,
  };
  for (let i = 0; i < raw.length; ) {
    const token = raw[i];
    if (!token.startsWith("--")) {
      throw new UsageError(`未知参数：${token}（只接受 --flag 形态；详见 --help）`);
    }
    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    const inline = eq >= 0 ? token.slice(eq + 1) : undefined;
    if (BOOL_FLAGS.has(name)) {
      if (inline !== undefined) {
        throw new UsageError(`--${name} 是无值开关，不接受 =value`);
      }
      if (name === "no-ensure") opts.noEnsure = true;
      else if (name === "help") opts.help = true;
      i += 1;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new UsageError(`未知参数：--${name}`);
    }
    const { value, next } = takeValue(raw, i, name, inline);
    i = next;
    switch (name) {
      case "port": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          throw new UsageError(`--port 必须是 1..65535 的整数（收到 ${JSON.stringify(value)}；显式端口契约禁 0）`);
        }
        opts.port = n;
        break;
      }
      case "data-dir":
        opts.dataDir = value;
        break;
      case "hana-task-id":
        opts.taskId = value;
        break;
      case "deps-root":
        opts.depsRoot = value;
        break;
      case "cordis-src":
        opts.cordisSrc = value;
        break;
      case "ready-marker": {
        const s = String(value);
        if (!s || /\n|\r/.test(s)) {
          throw new UsageError("--ready-marker 不能为空且不得含换行（宿主按整行匹配）");
        }
        opts.readyMarker = s;
        break;
      }
      default:
        throw new UsageError(`未知参数：--${name}`);
    }
  }
  if (!opts.help) {
    if (opts.port === null) throw new UsageError("缺少必选参数 --port <port>");
    if (!opts.dataDir || typeof opts.dataDir !== "string") {
      throw new UsageError("缺少必选参数 --data-dir <dir>（App ctx.dataDir）");
    }
  }
  return opts;
}
