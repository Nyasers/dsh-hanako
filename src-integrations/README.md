# integrations/ — hana 对官方 DSH 包的集成层（样例路线）

本目录承载「hana 对 DSH 的改动」，形态与官方样例 hana-dsh 一致：**薄集成贴上游版本**，
不是自研插件接管上游角色。背景与验收见 `specs/current/hana-integrations/spec.md`。

## 为什么要有这一层

我们曾在 `@dshana/view` 里 **vendor 了一份 0.1.2 的官方 ui-layout 源码**再改。
拷贝那一刻它就冻结了：0.1.5 把 root 子槽从 `conversation/details` 改成 `sidebar + main(keyed)`，
我们那份 frame 没跟上 → 官方 occupant 挂不上、根钩子无人提供 → **真机全页黑屏**。

结论：hana 的改动必须**贴着上游当前版本的源码**，并且**有版本戳、有构建期闸**。

## 形态

```
integrations/<短名>/
  integration.json          # 清单：对应官方包、上游目录、overlay 文件与其「基于的上游哈希」
  files/<上游相对路径>       # overlay：整文件拷贝 = 上游该文件 + 我们的 delta
```

`integration.json`：

```json
{
  "package": "@deepseek-ai/dsh-client-ui-layout",
  "upstreamVersion": "0.1.5-rc.2",
  "upstreamDir": "packages/client/ui-layout",
  "files": [
    { "path": "src/client/index.ts", "upstreamSha256": "<写入时上游同名文件的 sha256>" }
  ]
}
```

## 闸怎么响

`node scripts/integrations.mts verify`（已接进 `pnpm run build`，在 build:src 之前）：

1. **镜像版本一致**：`vendor/deepseek-harness` 必须含 tag `dsh-v<dependencies.@deepseek-ai/dsh>`；
2. **overlay 未过期**：对每个 `files[].path`，重算**当前镜像该 tag 下同名文件**的 sha256，
   与清单里记录的比对。不一致 = 上游动过 → **构建失败**，并指出该 rebase 哪个文件、更新哪个哈希。

于是"拷贝即冻结"在流程上不可能：上游一变，构建就停，rebase 是显式动作。
若上游新增了符号而我们用不上，不会报错；**我们引用了不存在的符号**则由该包的编译/类型检查拦下（第二道闸）。

## 加一个集成

1. `integrations/<短名>/integration.json` 写好包名、上游目录；
2. 把「上游该文件 + 我们的 delta」整文件拷进 `files/<相对路径>`；
3. 记录上游同名文件的 sha256（`node scripts/integrations.mts hash packages/client/ui-layout/src/client/index.ts` 打印）；
4. `pnpm run build` —— 闸会替你验证镜像与哈希。

## 边界

- **只写 delta**：overlay 文件里除必要改动外不留私货，便于上游升级时人工比对。
- **不改上游未涉及的包**。
- 产物版本号带 `<上游版本>+dshana-<我们的干净版本>`（例 `0.1.5-rc.2+dshana-1.0.0-beta.5`）：
  安装树里一眼可见“这包被改过”、被哪个 dshana 版本改的。版本段只有一个来源——主
  `package.json`（合成在 `scripts/version-common.mts`，与 syncver/version-hook 同一份）；
  清单里不写任何手写版本字段。
- 不做运行时 shim：与"贴上游 + 构建期有闸"的路线相悖。
