// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// dsh-hana-logger — DSHana 统一日志服务（v0.10.8）。
//
// 语义：theme / provider / settings 三个内嵌 cordis 插件原本各自内联一份几乎相同的
// 日志辅助函数（appendFileSync + 时间戳 + [src] 前缀），本插件收敛为单一实现——经 cordis
// 服务注入提供 log 接口（provide ['hanaLogger']，驼峰与属性访问一致、与内置服务
// （webServer/agentDefaultModel）同风格；注意不能用 'logger'：那是 cordis 内置
// LoggerService 的服务名，已被占用，provide 同名会抛“service has been registered”；
// 也不能用连字符名——注入后属性按服务名原样挂载（ctx['hana-logger']），
// 驼峰才能 ctx.hanaLogger 直接访问），消费方声明 inject ['hanaLogger'] 后经
// ctx.inject(['hanaLogger'], (logCtx) => logCtx.hanaLogger.log(src, msg)) 统一调用。
//
// logPath 由宿主 patch config 注入（dsh-hanako.patch.yml.tpl 渲染 {{LOG_PATH}} → 本次
// 插件会话日志文件 <dataDir>/logs/<timestamp>.log）；行格式与宿主侧 appendLog 一致
// [<HH:mm:ss.SSS>] [<src>] <内容>，src 前缀不变（theme/provider/settings）。
// 服务不自己记日志（无 [logger] 行），仅提供 log 接口；无 logPath/msg 或写失败静默返回
// （日志失败不阻断）。

import { appendFileSync } from "node:fs";

export const name = "dsh-hana-logger";
export const provide = ["hanaLogger"];

export function apply(ctx, config) {
  const logPath = config?.logPath;
  const service = {
    logPath,
    log(src, msg) {
      try {
        if (!logPath || !msg) return;
        const d = new Date();
        const p = (n, w) => String(n).padStart(w || 2, "0");
        const ts = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
        appendFileSync(logPath, `[${ts}] [${src}] ${msg}\n`, "utf8");
      } catch {
        /* 日志失败不阻断 */
      }
    },
  };
  ctx.provide("hanaLogger", service);
}
