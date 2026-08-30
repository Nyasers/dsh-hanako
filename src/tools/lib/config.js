// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// tools/lib/config.js — dsh-hanako 配置解析共用模块（lib 提取）
// 从 tools/dsh-run.js 剥离的纯解析/零状态函数：默认模型/预设（settings.yaml 行级）、
// reasoningEffort、审批超时、defaultCwd（config.json / 配置快照）。全部零宿主状态
// （不碰 globalThis 单例，只读文件/参数），dsh-run.js 静态 import。
//
// 归类说明：新建独立 config.js 而非并入 lib/state.js——state.js 已承载"单例 + 环境
// 常量"一条职责，本模块是"运行期配置文件解析"另一条职责（全只读、无状态）；若并进
// state.js 会让单例状态与只读解析混在一个文件，职责分歧。消费方只有 dsh-run.js
// （submitTask 提交前补齐 preset/effort/model 与 doExecute 的 cwd/timeout 解析）。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 读 dsh-home/settings.yaml 的 agent-default-model（行级解析，零依赖）——
// dsh 默认模型：dsh models 页设置后写回 settings.yaml（selectModel 同源）。
// 返回 { provider, model } 或 null。
export function readDshDefaultModel(dshHome) {
  try {
    const f = join(dshHome, "settings.yaml");
    if (!existsSync(f)) return null;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    let inBlock = false;
    const out = {};
    for (const line of lines) {
      if (/^agent-default-model\s*:/.test(line)) {
        inBlock = true;
        continue;
      }
      if (!inBlock) continue;
      const m = line.match(/^(\s+)([A-Za-z]+)\s*:\s*(.*)$/);
      if (!m) break; // 无缩进或非键行 = 出块（子项缩进 ≥1 空格均视为块内，2 空格标准缩进正常解析）
      const k = m[2];
      const v = m[3].trim();
      if (v) out[k] = v.replace(/^['"]|['"]$/g, "");
    }
    return out.provider ? out : null;
  } catch {
    return null;
  }
}

// 读 dsh-home/settings.yaml 的 agent-presets.default（行级解析，零依赖）——
// dsh 默认 agent 预设：Web UI 设置后写回 settings.yaml。返回预设字符串或 null。
export function readDshDefaultPreset(dshHome) {
  try {
    const f = join(dshHome, "settings.yaml");
    if (!existsSync(f)) return null;
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    let inBlock = false;
    for (const line of lines) {
      if (/^agent-presets\s*:/.test(line)) {
        inBlock = true;
        continue;
      }
      if (!inBlock) continue;
      const m = line.match(/^(\s+)default\s*:\s*(.*)$/);
      if (!m) {
        if (!/^\s/.test(line)) break; // 无缩进 = 出块（顶层键）
        continue; // 块内其他键，继续找 default
      }
      const v = m[2].trim().replace(/^['"]|['"]$/g, "");
      if (v) return v;
    }
    return null;
  } catch {
    return null;
  }
}

// reasoningEffort 解析（全局配置已移除，只接受工具显式参数，无配置回退；
// 不传时由 dsh 默认处理）。返回显式值或 null。
export function resolveReasoningEffort(explicit) {
  const v = String(explicit ?? "").trim();
  return v || null;
}

// 毫秒 → 秒 换算（旧键兜底共用）：0=禁用语义保留（0 → 0）；正数取整到秒
// （Math.round；极端 <500ms 的正数钳到 1s，保留「正数 = 启用」语义，避免 0 被误判禁用）。
function msToSec(ms) {
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return 0;
  return Math.max(1, Math.round(ms / 1000));
}

// approvalTimeoutSec 解析（唯一审批配置，单位：秒）：优先直读 dataDir/config.json 的
// global.approvalTimeoutSec（设置界面改动即时生效）：数字 > 0 采用；0 或负数 = 用户显式禁用
// 超时拒绝（返回 0，调用方判断不挂计时器）；非数字/缺失回退配置快照 cfg.approvalTimeoutSec
// （manifest 默认 30），同样 0/负数 = 禁用。旧键兼容：新键缺失且旧毫秒键
// global.approvalTimeoutMs / cfg.approvalTimeoutMs 存在时按毫秒换算（迁移尚未跑时的兜底，
// 保证升级不丢用户配置、不产生单位误解；迁移跑完后旧键已删除，此分支不再命中）。
export function resolveApprovalTimeoutSec(cfg) {
  try {
    const cf = join(cfg.dataDir, "config.json");
    if (existsSync(cf)) {
      const j = JSON.parse(readFileSync(cf, "utf8"));
      const v = j?.global?.approvalTimeoutSec;
      if (typeof v === "number" && Number.isFinite(v)) {
        return v > 0 ? v : 0; // 数字合法即采用（0/负数=禁用，不回退快照复活超时）
      }
      // 旧键兜底（迁移未跑）：毫秒换算为秒
      const old = msToSec(j?.global?.approvalTimeoutMs);
      if (old !== null) return old;
    }
  } catch {
    /* 读配置失败忽略 */
  }
  const v = Number(cfg.approvalTimeoutSec);
  if (Number.isFinite(v) && v > 0) return v;
  const old = msToSec(Number(cfg.approvalTimeoutMs));
  if (old !== null && old > 0) return old;
  return 0; // 快照缺失/非数字/0/负数：禁用超时拒绝（0，调用方判断）
}

// defaultTimeoutSec 解析（单次任务默认超时，单位：秒）：优先直读 dataDir/config.json 的
// global.defaultTimeoutSec（设置界面改动即时生效）：数字 > 0 采用；非数字/缺失回退配置快照
// cfg.defaultTimeoutSec（manifest 默认 1800）。旧键兼容：新键缺失且旧毫秒键存在时按毫秒
// 换算（迁移尚未跑时的兜底；0 语义与旧实现一致——旧代码 `|| 600000` 把 0 视为
// 未设置，此处同样回落 600s 硬编码兜底，不产生「0=禁用」歧义）。
export function resolveDefaultTimeoutSec(cfg) {
  try {
    const cf = join(cfg.dataDir, "config.json");
    if (existsSync(cf)) {
      const j = JSON.parse(readFileSync(cf, "utf8"));
      const v = j?.global?.defaultTimeoutSec;
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
      const old = msToSec(j?.global?.defaultTimeoutMs);
      if (old !== null && old > 0) return old;
    }
  } catch {
    /* 读配置失败忽略 */
  }
  const v = Number(cfg.defaultTimeoutSec);
  if (Number.isFinite(v) && v > 0) return v;
  const old = msToSec(Number(cfg.defaultTimeoutMs));
  if (old !== null && old > 0) return old;
  return 600; // 快照缺失/非数字/0：600s（10 分钟，与旧 `|| 600000` 兜底语义一致）
}

// defaultCwd 解析（「配置单一事实源」哲学，补齐直读兜底）：优先直读
// dataDir/config.json 的 global.defaultCwd（设置界面改动即时生效；Agent 直改文件同样生效），
// 无则回退配置快照/空。工具显式传 cwd 时在 doExecute 内优先，不受影响。
export function resolveDefaultCwd(cfg) {
  try {
    const cf = join(cfg.dataDir, "config.json");
    if (existsSync(cf)) {
      const j = JSON.parse(readFileSync(cf, "utf8"));
      const d = j?.global?.defaultCwd;
      if (typeof d === "string" && d.trim()) return d.trim();
    }
  } catch {
    /* 读配置失败忽略 */
  }
  return String(cfg.defaultCwd || "");
}

