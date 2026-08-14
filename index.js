// index.js — dsh-hanako 生命周期
// 三件事：
//  1. onload 时把插件实例 ctx 的 bus 存进 globalThis 单例（deferred 唤醒兜底来源：
//     工具执行 ctx 的 bus 宿主按调用注入，但 dev invoke / 特殊路径可能缺失，双兜底）
//  2. onload 时拉起 dsh web host（随插件加载即启动，不等首次工具调用；
//     tools 文件可能晚于 onload 被宿主加载，先轮询等单例方法就绪）
//  3. 插件卸载/重载时回收常驻 web host 子进程。
// 单例挂在 globalThis.__dshHanako（tools/dsh-run.js 写入），这里不 import 插件文件，
// 避免 Hana 的模块缓存导致清理逻辑读取到旧模块。
export default class DshHanakoPlugin {
  async onload() {
    const { log, config, dataDir } = this.ctx;
    // 单例可能尚未被 tools 创建（工具从未调用过）：先建占位再写 bus
    if (!globalThis.__dshHanako || typeof globalThis.__dshHanako !== "object") {
      globalThis.__dshHanako = {};
    }
    if (this.ctx?.bus && !globalThis.__dshHanako.bus) {
      globalThis.__dshHanako.bus = this.ctx.bus;
    }
    this.register(() => {
      const g = globalThis.__dshHanako;
      if (g && typeof g.closeProcess === "function") {
        Promise.resolve(g.closeProcess()).catch(() => {});
      }
    });

    // 拉起 dsh web host（随插件生命周期：加载即启动，卸载即回收）
    // tools 模块由宿主在激活期间 import（注册工具），可能晚于本 onload；
    // 轮询最多 5s 等单例方法挂上，再触发启动。启动失败不阻塞加载（工具调用时重试）。
    const deadline = Date.now() + 5000;
    const tryStart = async () => {
      while (Date.now() < deadline) {
        const g = globalThis.__dshHanako;
        if (g && typeof g.startWebHost === "function") {
          const ok = await g.startWebHost(config, dataDir);
          log.info(`[dsh-hanako] dsh web host ${ok ? "已随插件启动" : "启动未就绪（工具调用时将重试）"}`);
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      log.warn("[dsh-hanako] 5s 内未等到工具模块加载，dsh web host 将随首次工具调用启动");
    };
    tryStart().catch((e) => log.warn?.("[dsh-hanako] web host 启动异常:", e?.message || String(e)));

    log.info("[dsh-hanako] loaded");
  }
}
