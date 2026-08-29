// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// routes/child.js — 子插件反向投递信道（dsh 进程内 @dsh-hanako/* → 宿主插件）
//   POST /child/post  接收子插件主动投递 { channel, payload }，按 channel 分发。
//   当前通道：channel "dsh.update-request" → 触发 g.updateDsh（设置页「更新到最新」
//   直投，替代 update-request.json 文件桥——文件桥已退役：无轮询、无残留）。
//
// 鉴权：宿主鉴权墙已校验——子插件投递带 server-info.json 的 loopbackToken 作 query
// token（宿主官方本机进程凭据，Vit 校验 p.token === loopbackToken 且 connectionKind
// local 放行，实测受保护端点 200）。能到达本路由即已过墙，路由内不再二次校验。
// 返回 { ok:true, state:"updating" }（受理即回，结果走 update-result.json 供前端
// update-status 轮询）；g.updating 时回同形（不重复触发）。异常一律容错不抛。
export default function registerChildRoutes(app, ctx) {
  app.post("/child/post", async (c) => {
    const g = globalThis.__dshHanako;
    try {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        /* 空 body / 非 JSON：按无 channel 处理 */
      }
      const channel = typeof body?.channel === "string" ? body.channel : "";
      if (channel === "dsh.update-request") {
        if (!g || typeof g.updateDsh !== "function") {
          return c.json({ ok: false, error: "插件工具模块未加载，稍后重试" });
        }
        if (g.updating) return c.json({ ok: true, state: "updating" });
        // 异步触发（updateDsh 内部 try/catch 写 update-result.json；这里 .catch 兜底，
        // 路由不等待完成）。cfg 与 webui/update-dsh 同构（dataDir 缺省用单例记录值）
        Promise.resolve(
          g.updateDsh({ dataDir: ctx.dataDir || g.dataDir, webPort: Number(g.webServerPort) || 3080 }),
        ).catch(() => {});
        return c.json({ ok: true, state: "updating" });
      }
      return c.json({ ok: false, error: `未知 channel: ${channel || "(空)"}` });
    } catch (e) {
      ctx.log?.warn?.("[dsh-hanako] child/post 处理失败:", e?.message || String(e));
      return c.json({ ok: false, error: "投递处理失败" });
    }
  });
}
