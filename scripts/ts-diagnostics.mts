// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/ts-diagnostics.mts — 类型诊断的解析与分类（覆盖层检查与逐域检查共用一份）
//
// 为什么共用：两处检查（覆盖层在暂存树里、源码域在仓库树里）要的是同一个口径——
// "什么算我们自己的错"必须只有一处定义，否则迟早分叉。
//
// 分类四桶：
//   · mine     = 我们的文件 + FAIL_CODES ⇒ 判失败；
//   · other    = 我们的文件 + 其它码 ⇒ 只计数（码与条数进日志）；
//   · upstream = 其它源码文件（上游源、被解析到的包源）⇒ 只计数；
//   · config   = 不是源码文件的诊断（tsconfig/编译器报错）⇒ 判失败：那意味着检查器没真跑。
export const TS_FILE = /\.(ts|tsx|mts|cts)$/i;

/**
 * 失败清单：这些码表示"我们自己的文件自相矛盾"，不依赖外部类型就能判定。
 * 其余码（TS2339 成员、TS2344 约束、TS2322 赋值…）依赖跨包类型来源的正确性，
 * 在本仓的解析环境里会误伤，先进日志；全量 TS 化后再纳入。
 */
export const FAIL_CODES = new Set([
  "TS2304", // Cannot find name —— 自由变量（清注释连带删了一行代码就是它）
  "TS2552", // Cannot find name（带拼写建议）
  "TS2305", // Module has no exported member —— 导入写错名
  "TS2551", // Property does not exist（带拼写建议）
  "TS2554", // Expected N arguments, but got M
  "TS2451", // Cannot redeclare block-scoped variable —— 同名声明两次
  "TS2393", // Duplicate function implementation —— 函数定义两份
  "TS1005", // 语法错：期望某种记号
  "TS1109", // 语法错：表达式缺失
  "TS1128", // 语法错：声明或语句缺失
  "TS1160", // 语法错：模板字符串未闭合
]);

/** tsc 输出 → 诊断条目数组（纯函数；tsc 打印的路径相对其 cwd）。 */
export function parseTsDiagnostics(stdout) {
  const out = [];
  for (const raw of String(stdout || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.*?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/);
    if (!m) continue;
    out.push({
      file: m[1].replace(/\\/g, "/").replace(/^\.\//, ""),
      line: Number(m[2]),
      col: Number(m[3]),
      severity: m[4],
      code: m[5],
      message: m[6],
    });
  }
  return out;
}

/** 诊断条目 + "这是不是我们的文件" → 四桶（纯函数）。 */
export function classifyDiagnostics(entries, isOurs) {
  const mine = [];
  const other = [];
  const upstream = [];
  const config = [];
  for (const e of entries) {
    if (isOurs(e.file)) (FAIL_CODES.has(e.code) ? mine : other).push(e);
    else if (TS_FILE.test(e.file)) upstream.push(e);
    else config.push(e);
  }
  return { mine, other, upstream, config };
}

/** 诊断列表 → 多行文本（日志/报错用）。 */
export function formatDiagnostics(list) {
  return (Array.isArray(list) ? list : [])
    .map((d) => `  - ${d.file}:${d.line}:${d.col} ${d.code} ${d.message}`)
    .join("\n");
}
