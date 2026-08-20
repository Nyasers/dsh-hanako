// SPDX-License-Identifier: MPL-2.0
// Copyright (c) 2026 Nyasers
//
// scripts/template-loader.mjs — rspack loader：HTML 模板构建期编译（doT）
// 目标：构建期把 src/assets/*.jinja2（模板文件，避开 HTML 静态检查）编译成「自包含渲染函数」JS 模块，运行时零依赖
// （bundle 不含 doT），dependencies 恒空；产物只是普通函数，每请求直接调用。
//
// 成熟库选型：doT（产物天然自包含；把 escape 内联进函数体，脱离 doT 环境可执行）。
// eta / ejs(6.x) 的预编译产物都要外部运行时/闭包 helper，不满足零依赖约束。
//
// 模板语法（doT）：
//   {{= expr }}  原样插值（HTML 注入；不转义）
//   {{! expr }}  转义插值（doT 内建 HTML 转义）
//   {{ }}        逻辑块（doT 原生）
// 变量经 it 访问（it = render 传入的 scope 对象）。
import dot from "dot";

export default async function templateLoader(content) {
  const callback = this.async();
  try {
    const p = this.resourcePath;
    if (!p.endsWith(".jinja2")) { callback(null, content); return; }
    // doT 编译：返回自包含函数源码字符串（内部含 encodeHTML 定义，不依赖 doT 运行时）
    let fn;
    try {
      fn = dot.template(String(content));
    } catch (err) {
      throw new Error("doT 模板编译失败（" + p + "）：" + err.message);
    }
    const body = fn.toString();
    // 同时输出默认导出与具名导出 render：大模板未被内联时走模块引用，具名导出可避免 default interop 歧义
    const out = "function render" + body.slice(body.indexOf("(")) + "\n" + "export { render };" + "\n";
    callback(null, out);
  } catch (err) {
    callback(err);
  }
}
