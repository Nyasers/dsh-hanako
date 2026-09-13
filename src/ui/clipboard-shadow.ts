// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// src/ui/clipboard-shadow.ts — 壳级全局剪贴板影子（浏览器面）
//
// 为什么必须在**壳级**、且必须在**注入 DSH 之前**装：
//   · 嵌入场景里 navigator.clipboard 被宿主的 Permissions-Policy 关死（真机实测：
//     navigator.permissions.query({name:'clipboard-write'}) → 'denied'），原生 writeText 一调
//     就是一条 [Violation] Permissions policy violation，随后 reject。
//   · DSH 侧的写法（dsh-web-frontend 主 bundle 里的 writeClipboard，实读）是：
//       if (navigator.clipboard?.writeText) { try { await navigator.clipboard.writeText(t); return true }
//                                              catch { return false } }
//       …document.execCommand('copy') 兜底**只在 writeText 不存在时**才走
//     也就是「原生一失败就直接 false，没有第二条路」——所以影子必须在属性被读到之前就位。
//   · DSH 的 client 插件（@dshana/clipboard 的 client 半）是 boot manifest 里按需激活的
//     （dsh-client-modules 把每条声明成 { id, inject, immediately }，只有 immediately 才在启动
//     时就激活），装得晚且不保证被激活；壳页在注入 DSH 之前装，才是真正的「全局 + 最早」。
//
// 顺序：**桥优先**（__DSHANA__.clipboardWrite → 宿主能力 app/ui/clipboard-write）。旧实现是
// 「先试原生、失败再走桥」——原生必然先失败，于是每次复制都先撞一次已经关死的门（控制台刷
// violation）再回落。现在原生只作为「桥缺席 / 桥拒绝」时的回落。
//
// 覆盖范围：
//   · writeText(text)  —— 主路径，走宿主桥（DSH 的复制按钮都是它）。
//   · write(items)     —— 也盖。宿主能力只有 **writeText** 一个词（清单里是
//     app/ui/clipboard-write），所以这里只能把 ClipboardItem 的 text/plain 取出来走桥；
//     只有图像/富文本的 item 无路可走（原生那条被策略关死）→ 明确失败，不假装成功。
//   · readText/read    —— **不盖**。宿主没有对应的读能力词，盖了也只能假装/报错，不如让它
//     按原样失败（真机上会看到那条 violation，那是真实边界，不是我们该藏的）。
//
// 语义：不静默假装成功。显式失败值（false / { written:false }）与异常都当失败抛出去——
// DSH 那个 helper 只要不抛就报成功，所以「看得见的失败」比「假的成功」有价值。

/** 已安装标记（幂等：重复安装只返回一个空 disposer，不重建、不接管别人的清理）。 */
const MARK = "__DSHANA_CLIPBOARD_SHADOW__";

/** 上报口：影子写失败/降级时上报（stage 供定位）。 */
export type ClipboardReport = (stage: string, error: unknown) => void;

/** createClipboardShadow / installClipboardShadow 的依赖（缺省取全局）。 */
export interface ClipboardShadowDeps {
  /** 要接管剪贴板写的对象（默认 navigator.clipboard）。 */
  clipboard?: any;
  /** 壳页桥（读它的 clipboardWrite）。 */
  bridge?: any;
  report?: ClipboardReport;
}

/** 剪贴板影子：被替掉的原始实现 + 影子写入口。 */
export interface ClipboardShadow {
  /** 安装/卸载影子对象。 */
  shadow: any;
  writeShadow: (text: string) => unknown;
  original: any;
  originalWrite: any;
  extractText: (data: unknown) => string;
}

/**
 * 造剪贴板影子（导出以便单测）。
 * @param deps
 *   clipboard 为 navigator.clipboard；bridge 为 window.__DSHANA__（读它的 clipboardWrite）
 * @returns 影子与写入口
 */
export function createClipboardShadow({ clipboard, bridge, report }: ClipboardShadowDeps = {}): ClipboardShadow {
  const original = clipboard && typeof clipboard.writeText === "function" ? clipboard.writeText.bind(clipboard) : null;
  const originalWrite = clipboard && typeof clipboard.write === "function" ? clipboard.write.bind(clipboard) : null;
  const note = typeof report === "function" ? report : () => {};

  const callBridge = (text) => {
    const fn = bridge && typeof bridge.clipboardWrite === "function" ? bridge.clipboardWrite : null;
    if (fn === null) return Promise.reject(new Error("clipboard bridge unavailable"));
    try {
      return Promise.resolve(fn(text));
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const callNative = (fn, payload) => {
    if (fn === null) return Promise.reject(new Error("native clipboard unavailable"));
    let result;
    try {
      result = fn(payload);
    } catch (error) {
      return Promise.reject(error);
    }
    return result && typeof result.then === "function" ? result.then(() => undefined) : Promise.resolve();
  };
  /** 显式失败值也算失败：线上旧壳页会把宿主失败折成 false，而 DSH 只看「抛不抛」。 */
  const isFailureValue = (result) => result === false || !!(result && result.written === false);

  /** 桥优先的统一路由：桥可用就只走桥（原生一次都不碰），桥缺席/失败才回落原生。 */
  const route = (text, nativeCall, stage) => {
    const bridged = bridge && typeof bridge.clipboardWrite === "function";
    if (!bridged) return nativeCall();
    const fallback = (error) => {
      note(stage, error);
      if (nativeCall === null) throw error;
      return nativeCall().catch((nativeError) => {
        note("native", nativeError);
        throw error;
      });
    };
    return callBridge(text).then(
      (result) => (isFailureValue(result) ? fallback(new Error("clipboard bridge reported failure")) : undefined),
      (error) => fallback(error),
    );
  };

  /** 从 ClipboardItem 列表里取第一个可路由的 text/plain；取不到返回 null。 */
  const extractText = async (items) => {
    const list = Array.isArray(items) ? items : (items ? [items] : []);
    for (const item of list) {
      const types = item && item.types ? Array.from(item.types) : [];
      const type = types.find((candidate) => String(candidate).toLowerCase().startsWith("text/plain"));
      if (!type) continue;
      const blob = await item.getType(type);
      return await blob.text();
    }
    return null;
  };

  const shadow = (text) => route(text, original === null ? null : () => callNative(original, text), "bridge");

  const writeShadow = (items) => {
    const nativeCall = originalWrite === null ? null : () => callNative(originalWrite, items);
    const bridged = bridge && typeof bridge.clipboardWrite === "function";
    if (!bridged) {
      if (nativeCall) return nativeCall();
      return Promise.reject(new Error("native clipboard unavailable"));
    }
    return extractText(items).then(
      (text) => {
        if (text !== null) return route(text, nativeCall, "write");
        const unsupported = new Error("clipboard write(): 只有 text/plain 能走宿主桥（宿主无图/富文本能力）");
        note("write", unsupported);
        if (nativeCall === null) throw unsupported;
        return nativeCall().catch((nativeError) => {
          note("native", nativeError);
          throw unsupported;
        });
      },
      (error) => {
        note("write", error);
        throw error;
      },
    );
  };

  return { shadow, writeShadow, original, originalWrite, extractText };
}

/**
 * 全局安装：实例方法与原型方法都换成影子（幂等）。
 * @param [options] 形如 { target, bridge, report }
 * @returns disposer（重复安装返回空函数，不会拆掉先装的那次）
 */
export function installClipboardShadow(
  options: ClipboardShadowDeps & { target?: any } = {},
): () => void {
  const target = options.target || (typeof globalThis === "undefined" ? null : globalThis);
  if (!target || target[MARK]) return () => {};
  const nav = target.navigator;
  if (!nav) return () => {};
  const clipboard = nav.clipboard;
  if (clipboard === undefined || clipboard === null) return () => {};

  const report = options.report || ((stage, error) => {
    // 默认报告：**每次都说**。宿主在 card slot 里明确不允许这个能力（真机：Plugin UI
    // capability "clipboard.writeText" is not allowed in card slots），原生又被
    // Permissions-Policy 挡住——两条路都在宿主手里，方向暂停；转发逻辑保留，
    // 宿主哪天放开，这套代码不用改就能活。报错要即时、可归因，不做“只说一次”的静音。
    try {
      console.warn(`[dshana/clipboard] ${stage} failed:`, error);
    } catch { /* 忽略 */ }
  });
  const bridge = options.bridge !== undefined ? options.bridge : target.__DSHANA__;
  const { shadow, writeShadow } = createClipboardShadow({ clipboard, bridge, report });
  // 还原用「原值」，不是 createClipboardShadow 里那份 bound（bound 是给调用用的，写回去等于换属性）。
  const nativeInstance = { writeText: clipboard.writeText, write: clipboard.write };
  const undo: Array<() => void> = [];

  /** 换实例方法 + 原型方法（只为传进来的这两个名字，read 一概不碰）。 */
  const patch = (name, replacement) => {
    const proto = target.Clipboard && target.Clipboard.prototype;
    try {
      clipboard[name] = replacement;
    } catch (error) {
      report(`${name} instance patch`, error);
    }
    if (clipboard[name] === replacement) {
      undo.push(() => { try { if (clipboard[name] === replacement) clipboard[name] = nativeInstance[name]; } catch { /* 忽略 */ } });
    } else if (typeof nativeInstance[name] === "function") {
      report(`${name} instance patch`, new Error(`navigator.clipboard.${name} 不可写`));
    }
    if (proto && typeof nativeInstance[name] === "function" && typeof proto[name] === "function") {
      const nativeProto = proto[name];
      try {
        proto[name] = replacement;
        if (proto[name] === replacement) undo.push(() => { try { if (proto[name] === replacement) proto[name] = nativeProto; } catch { /* 忽略 */ } });
      } catch (error) {
        report(`${name} prototype patch`, error);
      }
    }
  };

  patch("writeText", shadow);
  patch("write", writeShadow);

  const entry = {
    dispose: () => {
      for (const restore of undo.reverse()) restore();
      try { delete target[MARK]; } catch { /* 忽略 */ }
    },
  };
  try {
    Object.defineProperty(target, MARK, { value: entry, configurable: true });
  } catch {
    target[MARK] = entry;
  }
  return entry.dispose;
}
