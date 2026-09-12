// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/lib/source-switch.ts — 数据源切换链（spec D-m）。
//
// 顺序（每一步都按"能不改动就不改动"排）：
//   ① 互斥：单飞；进行中再触发给冲突（路由映 409）
//   ② preflight：另一个子进程只验新源可用（不 boot DSH、不动现有 runtime）
//   ③ 冻结：中继控制面 prepare-switch（有在途调用则拒）——拒了就中止，此时还没停任何东西
//   ④ 停旧 → 起新
//   ⑤ 起新成功之后才落盘（revision +1）：文件里记的源永远是实际跑着的源
//
// 失败回滚：已停旧就按旧源重起；还没停旧只需解冻。停不下 / 起不回来如实报，不假装成功。
// 切换不复制、不删除任何目录内容（新源若为空，由 DSH 自己初始化）。
//
// 依赖全部注入：编排只讲顺序与回滚，具体怎么起停、怎么读写、怎么冻结由调用方给。
import { randomBytes } from "node:crypto";
import { appDataDir, appLogger, getAppRuntime } from "./app-runtime.ts";
import { dataSources, sourceOf } from "./data-source.ts";
import { ensureManagedRuntime, preflightSource, stopManagedRuntime } from "./managed-runtime.ts";
import { invokeControl } from "./controller.ts";

/** 步骤名（页面可直接显示；rolling-back 只在失败时出现）。 */
export const SWITCH_STEPS = ["preflight", "freeze", "stopping", "starting", "saving", "rolling-back"];

/** 控制面命令的回执形状不统一（ok / accepted），统一成 { ok, error }。 */
export function controlAccepted(reply) {
  if (!reply || typeof reply !== "object") return { ok: false, error: "控制面无回执" };
  const inner = reply.result && typeof reply.result === "object" ? reply.result : reply;
  if (inner.ok === true || inner.accepted === true) return { ok: true };
  return { ok: false, error: (inner.error && String(inner.error)) || "控制面拒绝" };
}

function stepError(step, message) {
  const e = new Error(message);
  e.step = step;
  return e;
}

const sameSource = (a, b) =>
  String(a.mode) === String(b.mode) &&
  String(a.profile) === String(b.profile) &&
  String(a.path === null || a.path === undefined ? "" : a.path) ===
    String(b.path === null || b.path === undefined ? "" : b.path);

/**
 * 切换编排器。deps:
 *   store        { read(), write(settings), validate(settings) }
 *   preflight    (settings) => Promise<{ok, error?}>
 *   prepareSwitch() => Promise<{ok, error?}>
 *   resume()     => Promise<{ok, error?}>
 *   stopRuntime()=> Promise<void>
 *   startRuntime(settings) => Promise<void>
 *   log(level, message)
 */
export function createSourceSwitcher(deps) {
  let current = null; // 最近一次 operation（终态保留，供页面轮询看结果）
  let running = false;

  const state = () => (current ? { ...current } : null);
  const setOp = (patch) => {
    current = { ...current, ...patch, at: Date.now() };
  };

  async function rollback(prevSettings, stopAttempted, startedNew, froze, notes) {
    if (startedNew) {
      try {
        await deps.stopRuntime();
        notes.push("已停半成品");
      } catch (e) {
        notes.push("停半成品失败：" + ((e && e.message) || e));
      }
    }
    if (stopAttempted) {
      try {
        await deps.startRuntime(prevSettings);
        notes.push("已按旧源重起");
      } catch (e) {
        notes.push("按旧源重起失败：" + ((e && e.message) || e));
      }
    } else if (froze) {
      // 只冻过、没停过：解冻即可（preflight 就失败的情形根本没冻，不需要也无从解冻）
      try {
        const r = await deps.resume();
        notes.push(r && r.ok === true ? "已解冻（未停旧）" : "解冻未确认：" + ((r && r.error) || "无回执"));
      } catch (e) {
        notes.push("解冻失败：" + ((e && e.message) || e));
      }
    }
  }

  async function run(next, prevSnapshot, id) {
    const prevSettings = prevSnapshot.settings;
    let stopAttempted = false;
    let startedNew = false;
    let froze = false;
    const notes = [];
    try {
      setOp({ step: "preflight" });
      const pf = await deps.preflight(next);
      if (!pf || pf.ok !== true) throw stepError("preflight", (pf && pf.error) || "新数据源预检未通过");

      setOp({ step: "freeze" });
      const fz = await deps.prepareSwitch();
      if (!fz || fz.ok !== true) throw stepError("freeze", (fz && fz.error) || "冻结被拒（可能有在途调用）");
      froze = true;

      setOp({ step: "stopping" });
      // 先记“进过停旧”：这一步报错也可能已经把旧 runtime 停掉一半，
      // 回滚就该按旧源重起（多起一次比让用户手里什么都没有好）。
      stopAttempted = true;
      await deps.stopRuntime();

      setOp({ step: "starting" });
      await deps.startRuntime(next);
      startedNew = true;

      setOp({ step: "saving" });
      const saved = await deps.store.write(next);
      deps.log("info", "数据源切换成功：" + next.mode + " revision=" + saved.revision);
      setOp({ state: "succeeded", step: "done", error: null, revision: saved.revision });
    } catch (e) {
      const text = (e && e.message) || String(e);
      setOp({ step: "rolling-back" });
      await rollback(prevSettings, stopAttempted, startedNew, froze, notes);
      const detail = text + (notes.length ? "（回滚：" + notes.join("；") + "）" : "");
      deps.log("warn", "数据源切换失败并回滚：" + detail);
      setOp({ state: "failed", step: "done", error: detail });
    } finally {
      running = false;
    }
  }

  return {
    /**
     * 触发切换。三种"不进入链"的答复：进行中（busy）、revision 落后（conflict）、
     * 目标与当前一致（noop）——都不改动任何东西。
     */
    async start(next, expectedRevision) {
      if (running) return { ok: false, busy: true, operation: state() };
      const prevSnapshot = await deps.store.read();
      if (typeof expectedRevision === "number" && expectedRevision !== prevSnapshot.revision) {
        return { ok: false, conflict: true, revision: prevSnapshot.revision };
      }
      const validated = await deps.store.validate(next);
      if (sameSource(validated, prevSnapshot.settings)) {
        return { ok: false, noop: true, revision: prevSnapshot.revision, operation: state() };
      }
      const id = "switch-" + Date.now().toString(36) + "-" + randomBytes(3).toString("hex");
      running = true;
      current = {
        id,
        state: "running",
        step: "preflight",
        error: null,
        at: Date.now(),
        from: { mode: prevSnapshot.settings.mode, path: prevSnapshot.settings.path, profile: prevSnapshot.settings.profile },
        to: { mode: validated.mode, path: validated.path, profile: validated.profile },
      };
      void run(validated, prevSnapshot, id);
      return { ok: true, operation: state() };
    },
    state,
  };
}

let singleton = null;

/** 默认接线：自持存储 + 受管 runtime 启停 + 中继控制面冻结 + preflight 子进程。 */
export function sourceSwitcher() {
  if (singleton) return singleton;
  const store = {
    read: () => dataSources().read(),
    write: (settings) => dataSources().write(settings),
    validate: (settings) => dataSources().validate(settings),
  };
  singleton = createSourceSwitcher({
    store,
    preflight: (settings) => {
      const dataDir = appDataDir();
      return preflightSource({ dataDir, dshHome: sourceOf(settings, dataDir).home, profile: settings.profile });
    },
    prepareSwitch: async () => {
      const ctx = getAppRuntime()?.ctx;
      return controlAccepted(await invokeControl(ctx, "prepare-switch", {}));
    },
    resume: async () => {
      const ctx = getAppRuntime()?.ctx;
      return controlAccepted(await invokeControl(ctx, "resume", {}));
    },
    stopRuntime: () => stopManagedRuntime(),
    startRuntime: async (settings) => {
      const dataDir = appDataDir();
      await ensureManagedRuntime({ dshHome: sourceOf(settings, dataDir).home });
    },
    log: (level, message) => {
      try {
        const logger = appLogger();
        if (level === "warn" && logger && typeof logger.warn === "function") logger.warn(message);
        else if (logger && typeof logger.info === "function") logger.info(message);
      } catch {
        /* 日志失败不影响切换结果 */
      }
    },
  });
  return singleton;
}

/** 单测用：清掉单例（避免测试间串状态）。 */
export function resetSourceSwitcher() {
  singleton = null;
}
