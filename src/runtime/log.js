// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/runtime/log.js — 受管 runtime 子进程行式日志（dsh-host 专用）
//
// 宿主受管 runtime 捕获 stdout/stderr 作为有界运行日志（runtime.logBytes/logTruncated，
// 运行期只保留最近 64 条终态记录，watch() 可取实时行）。本模块统一行式输出：
//   stdout = 运行里程碑（info）
//   stderr = 错误/诊断（warn/err）
// readyMarker 必须独占一行打印且不带任何前缀（宿主按整行精确匹配，见迁移指南 §6/§10）——
// 因此 marker 打印不经过本模块的 info()，由 main.js 直接 process.stdout.write(marker+"\n")，
// 且日志行统一加 "[dsh-host]" 前缀，杜绝日志内容误触 readyMarker。
// 本模块零依赖 node 内置（只 process），可安全被 rspack 打进 dist/runtime/dsh-host.mjs。
function ts() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function write(stream, tag, ...args) {
  const text = args
    .map((a) => (a instanceof Error ? (a.stack || a.message) : String(a)))
    .join(" ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    stream.write(`[dsh-host] [${ts()}] [${tag}] ${line.trimEnd()}\n`);
  }
}
/** 运行里程碑（stdout，进入宿主运行日志 stdout 流）。 */
export function info(...args) {
  write(process.stdout, "info", ...args);
}
/** 诊断警告（stderr）。 */
export function warn(...args) {
  write(process.stderr, "warn", ...args);
}
/** 错误（stderr；boot 失败分类诊断输出均经此）。 */
export function err(...args) {
  write(process.stderr, "error", ...args);
}
