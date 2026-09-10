// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/options.js — 受管 runtime 子进程的私有配置读取（dsh-host 专用）
//
// 形态（对齐官方样例 hana-dsh）：**不再用命令行明文传参**，改为单个私有配置文件路径
// （argv[1]）——配置由 App 主进程（lib/managed-runtime.js）以 0600 写入 dataDir/integration/，
// 子进程读后立即 unlink。bridgeKey 这类「不能让回环端口变成第二个无鉴权面」的凭据绝不出现在
// argv（进程列表可见）、环境变量或日志里。
//
// 配置文件 schema（JSON）：
//   { dataDir, dshPort, bridgePort, bridgeKey, readyMarker, cordisSrc?, depsRoot? }
//   · dataDir       App ctx.dataDir 绝对路径（dsh-home / runtime / logs 均在其下）
//   · dshPort       DSH webserver 内部监听端口（1..65535，runtime 自用，不由宿主暴露）
//   · bridgePort    中继端口 = 注册给宿主的 service.port（宿主代理目标；1..65535）
//   · bridgeKey     中继鉴权 key（header x-hana-dsh-bridge / 路径 /_hana/<key>/）
//   · readyMarker   就绪标记（须与 start.service.readyMarker 完全一致，整行匹配）
//
// 仍接受 --help（无配置文件时打印用法）。
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 2;
  }
}

export const USAGE = `用法：dsh-host.mjs <runtime-config.json>（dsh-hanako App v2 受管 Node runtime 入口）
  <runtime-config.json>  私有运行时配置文件绝对路径（App 主进程写入，0600，启动即删）；
                         内容见 options.js 头注释 schema。
  --help                 显示本帮助

说明：本入口只能由 Hana ctx.runtime.start({ runtime:"node" }) 启动（宿主注入父进程 IPC）。
端口/凭据一律走私有配置文件，不经 argv／环境变量／日志传递。`;

const LOOPBACK_PORT = (value, field) => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new UsageError(`配置项 ${field} 必须是 1..65535 的整数（收到 ${JSON.stringify(value)}）`);
  }
  return n;
};

/** 配置归一 + 校验（纯函数，便于单测）。 */
export function normalizeRuntimeConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new UsageError("运行时配置必须是 JSON 对象");
  }
  const dataDir = typeof input.dataDir === "string" && input.dataDir ? input.dataDir : null;
  if (!dataDir) throw new UsageError("配置项 dataDir 必填（App ctx.dataDir 绝对路径）");
  const dshPort = LOOPBACK_PORT(input.dshPort, "dshPort");
  const bridgePort = LOOPBACK_PORT(input.bridgePort, "bridgePort");
  if (dshPort === bridgePort) throw new UsageError("配置项 dshPort 与 bridgePort 不能相同");
  const bridgeKey = typeof input.bridgeKey === "string" ? input.bridgeKey : "";
  if (bridgeKey.length < 16) throw new UsageError("配置项 bridgeKey 必填且不短于 16 字符");
  const controlKey = typeof input.controlKey === "string" ? input.controlKey : "";
  if (controlKey.length < 16) throw new UsageError("配置项 controlKey 必填且不短于 16 字符");
  const readyMarker = typeof input.readyMarker === "string" && input.readyMarker ? input.readyMarker : "DSH_READY";
  if (/\n|\r/.test(readyMarker)) throw new UsageError("配置项 readyMarker 不得含换行（宿主按整行匹配）");
  return {
    dataDir,
    dshPort,
    bridgePort,
    bridgeKey,
    controlKey,
    readyMarker,
    cordisSrc: typeof input.cordisSrc === "string" && input.cordisSrc ? input.cordisSrc : null,
    depsRoot: typeof input.depsRoot === "string" && input.depsRoot ? input.depsRoot : null,
  };
}

/**
 * 解析入口参数：argv[0] === "--help" 返回 { help:true }；否则视 argv[0] 为配置文件路径。
 * @param {string[]} argv 纯参数数组（不含 node/script）
 * @param {(path:string)=>string} readFile 读取注入（默认 node 同步读；便于单测）
 */
export function parseRuntimeConfig(argv, readFile) {
  const raw = Array.isArray(argv) ? argv : [];
  if (raw[0] === "--help" || raw[0] === "-h") return { help: true };
  const configPath = raw[0];
  if (typeof configPath !== "string" || !configPath || configPath.startsWith("--")) {
    throw new UsageError("缺少私有运行时配置文件路径（用法：dsh-host.mjs <runtime-config.json>；--help 查看说明）");
  }
  if (raw.length > 1) throw new UsageError(`未知参数：${raw[1]}（只接受一个配置文件路径）`);
  let text;
  try {
    text = readFile(configPath);
  } catch (e) {
    throw new UsageError("读取私有运行时配置失败：" + ((e && e.message) || e));
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new UsageError("私有运行时配置不是合法 JSON：" + ((e && e.message) || e));
  }
  return normalizeRuntimeConfig(parsed);
}
