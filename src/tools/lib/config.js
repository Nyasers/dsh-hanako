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

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
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

// approvalTimeoutMs 解析（唯一审批配置）：优先直读 dataDir/config.json 的
// global.approvalTimeoutMs（设置界面改动即时生效）：数字 > 0 采用；0 或负数 = 用户显式禁用
// 超时拒绝（返回 0，调用方判断不挂计时器）；非数字/缺失回退配置快照 cfg.approvalTimeoutMs
// （manifest 默认 30000），同样 0/负数 = 禁用。
export function resolveApprovalTimeoutMs(cfg) {
  try {
    const cf = join(cfg.dataDir, "config.json");
    if (existsSync(cf)) {
      const j = JSON.parse(readFileSync(cf, "utf8"));
      const v = j?.global?.approvalTimeoutMs;
      if (typeof v === "number" && Number.isFinite(v)) {
        return v > 0 ? v : 0; // 数字合法即采用（0/负数=禁用，不回退快照复活超时）
      }
    }
  } catch {
    /* 读配置失败忽略 */
  }
  const v = Number(cfg.approvalTimeoutMs);
  if (Number.isFinite(v) && v > 0) return v;
  return 0; // 快照缺失/非数字/0/负数：禁用超时拒绝（0，调用方判断）
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

// ---- 会话注册表（agent 会话所有权登记：config.json sessions 字段）----
// dsh 会话无 owner 概念（任何会话在 dsh 侧一律可读/可续），权限收敛到「agent 只管理
// 自己创建的会话」需要插件自建注册表：dsh_run session.create 成功后幂等登记
// config.json 的 sessions[sessionId] = { createdAt, cwd, title }。
// config.json 可能被宿主设置页管理——本函数读-改-写前重读最新内容，绝不覆盖
// schemaVersion/global/agents 字段；写入用临时文件 + rename 原子替换（对齐 lifecycle.js
// ensureConfigJson 的 .tmp + rename 惯例）。任一步失败静默返回 false，不阻断任务提交流程。
// 返回 true=登记成功（含已存在幂等），false=失败静默（读/写/解析异常）。
export function registerSession({ dataDir, sessionId, cwd, taskText }) {
  try {
    const sid = String(sessionId ?? "").trim();
    if (!sid || !dataDir) return false;
    const cf = join(dataDir, "config.json");
    if (!existsSync(cf)) return false; // 无配置文件（异常态）：不建新文件，交给 ensureConfigJson
    // 读-改-写前重读最新内容（宿主设置页/其他写入方可能刚改过，绝不覆盖 global/agents）
    const j = JSON.parse(readFileSync(cf, "utf8"));
    if (!j || typeof j !== "object") return false;
    const sessions = j.sessions && typeof j.sessions === "object" && !Array.isArray(j.sessions)
      ? j.sessions
      : (j.sessions = {});
    sessions[sid] = {
      createdAt: Date.now(),
      cwd: String(cwd ?? ""),
      title: String(taskText ?? "").slice(0, 80),
    };
    // 临时文件 + rename 原子替换（中断不留半成品）
    const tmp = join(dataDir, ".config.json.tmp");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(j, null, 2), "utf8");
    renameSync(tmp, cf);
    return true;
  } catch {
    return false; // 登记失败静默：不阻断任务提交流程（权限收敛为尽力而为）
  }
}

// 读 config.json sessions 注册表（agent 创建的会话所有权登记表）。返回对象 map
// { sessionId: { createdAt, cwd, title } }；文件缺失/JSON 损坏/结构不符返回 {}（按空表处理）。
export function readSessionRegistry(dataDir) {
  try {
    const cf = join(dataDir, "config.json");
    if (!existsSync(cf)) return {};
    const j = JSON.parse(readFileSync(cf, "utf8"));
    const s = j?.sessions;
    if (s && typeof s === "object" && !Array.isArray(s)) return s;
    return {};
  } catch {
    return {};
  }
}

