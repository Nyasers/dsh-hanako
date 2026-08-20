// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/strip-js-comments.mjs — JS 注释剥离（ASCII 级词法，模板加载前置步骤）
// 目的：doT 压行（strip:true）前把 JS 注释安全移除，避免 `//` 行注释在单行中吞掉
// 后续代码（v0.15.3 壳页主题桥/剪贴板桥/轮询被吞的回归根因）。
// 词法边界：字符串（'\" 与反引号模板）内部跳过（支持 \\ 转义）；`//` 与 `/* */` 才删；
// 行注释保留换行（维持行结构，配合 strip 语义）；块注释内换行保留（内容以空格替换）。
// 不做正则判定：壳页脚本中正则字面量（如 /<\\//g）不包含连续 // 或 /*，安全。
//
export function stripJsComments(code) {
  const n = code.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const c = code[i];
    // 字符串字面量：直接拷贝到闭合引号（处理转义）
    if (c === '\"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        const cc = code[i];
        if (cc === "\\") {
          out += cc + (code[i + 1] || "");
          i += 2;
          continue;
        }
        out += cc;
        i++;
        if (cc === q) break;
      }
      continue;
    }
    // 行注释 //
    if (c === "/" && code[i + 1] === "/") {
      while (i < n && code[i] !== "\n") {
        out += " ";
        i++;
      }
      if (i < n && code[i] === "\n") {
        out += "\n";
        i++;
      }
      continue;
    }
    // 块注释 /* */
    if (c === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) {
        out += code[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        i += 2;
        out += " ";
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
