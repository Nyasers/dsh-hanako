# vendor/dsh-client-ui-layout（@dsh-hanako/view 构建期官方源码副本）

本目录是 @deepseek-ai/dsh-client-ui-layout 的 **client 半源码逐字副本**（构建期 vendor，
不随包发布——只作为本插件 client 半（tsdown）的编译输入被内联进 @dsh-hanako/view 的
closure-factory bundle；dist/cordis/view 下不出现这些文件）。

## 为什么 vendor（不用运行时依赖）

- 官方 npm 包（dsh-client-ui-layout）发布 files 只含 lib/（closure-factory 浏览器 bundle），
  无 src 物理文件——exports 虽声明 "./src/*": "./src/*" 但解析失败，浏览器 module table 也
  只有包级 row（id = 包名，exports = 整包 client 模块），子路径模块无法 require。
- 官方 ui-layout 从 roster 移除后其 row 不再存在；即便保留，其 client 模块导出的是
  apply/inject（cordis 插件面），AppFrame/store/service 等内部符号不对外导出，无法按组件复用。
- 因此本插件自持官方装配核心的逐字源码：AppFrame/createLayoutStore/LayoutController/
  ThemePresenter/DocumentTitle/columns 全部在构建期编译进本包 bundle，运行时零官方依赖
  （仅 react / react/jsx-runtime / @deepseek-ai/dsh-client-store 平台 seed 走 module table，
  与官方 ui-layout bundle 的 externals 集一致）。

## 来源与版本钉

- 上游仓库：deepseek-ai/deepseek-harness（remote = official），以 **git submodule** 钉在
  仓库 `vendor/deepseek-harness`（gitlink 记录钉版 commit；`git submodule update --init` 即得）
- 来源文件：packages/client/ui-layout/src/client/**（7 个文件：AppFrame.tsx、
  AppFrame.module.css、columns.ts、DocumentTitle.tsx、service.ts、stores.ts、
  theme-presenter.ts）
- 版本钉：submodule HEAD = **dsh-v0.1.2-rc.1**（dsh-hanako 锁 @deepseek-ai/dsh 0.1.2-rc.1；
  当前 HEAD commit a66e470204）。升 dsh 版本 = submodule 内 checkout 新 tag → 主仓库
  `git add vendor/deepseek-harness` → 重跑 sync 脚本 → 审 diff → 提交（sync 脚本从
  submodule HEAD 读钉版，无第二事实源）。
- 复制方式：scripts/sync-vendor-layout.mjs（幂等，从 submodule 钉版 commit 复制 + 逐文件
  字节校验；复制后 git status 应无 vendor 副本改动）。

## 改动纪律

vendor 文件**保持上游逐字**（唯一例外=无：import 路径、css 引用、编译期 env 访问均原样；
构建链负责 css-modules 语义与 process.env 替换）。同步脚本整目录覆盖，任何本地手改会被冲掉。

## 许可

上游为 MIT（packages/client/ui-layout/package.json "license": "MIT"；store 引擎
@deepseek-ai/dsh-client-store 仅以平台 seed 方式运行时消费，未 vendor 其源码）。
副本保留 MIT 归属（deepseek-ai/deepseek-harness, Copyright 见上游 LICENSE），
@dsh-hanako/view 插件本体（client.js/index.js/package.json/cordis.config.mjs）为 MPL-2.0。
