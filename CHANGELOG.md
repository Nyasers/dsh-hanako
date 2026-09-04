# Changelog

## [1.0.0-beta.4+dsh-0.1.2-rc.1](https://github.com/Nyasers/dsh-hanako/compare/v1.0.0-beta.3%2Bdsh-0.1.2-rc.1...v1.0.0-beta.4%2Bdsh-0.1.2-rc.1) (2026-09-03)

### Features

* **build:** cordis 子插件两条构建链——src-cordis 产出 bundle 化子插件包（学 dsh） ([f8a5cfa](https://github.com/Nyasers/dsh-hanako/commit/f8a5cfa758a4dbfe410df725e14ac922a7a0ca65))
* **build:** tsdown client 链开 minify——产物即时压缩（与 rspack 链 minimize 对齐） ([0399f63](https://github.com/Nyasers/dsh-hanako/commit/0399f634bfad87fcd70b4717787248ed8670df51))
* **profile:** manifest 随包归一 + profile-seed 归位 src/lib/ ([44a609d](https://github.com/Nyasers/dsh-hanako/commit/44a609dc09c1d4b1569a0be7c3d8ca0ed48873f0))
* **version:** cordis 包 version 与 manifest 同批同步——单一事实源 = 主 package.json ([1b8dab1](https://github.com/Nyasers/dsh-hanako/commit/1b8dab1e2ea7e450daca76837ee2a5976e6773ed))

### Bug Fixes

* CodeRabbit 二轮 4 条闭环 + SKILL 编码恢复 ([5ffad77](https://github.com/Nyasers/dsh-hanako/commit/5ffad770280a61e8e68e2e8ccf95c3a5dcab2e11))
* CodeRabbit review 八条闭环 ([d7d01ab](https://github.com/Nyasers/dsh-hanako/commit/d7d01ab57402be3e9e9d07faf62ba2be457ebeeb))
* **diag:** boot ENOENT 统一归 restart-needed——不区分 dsh 更新还是布局/缓存陈旧，重启宿主先验 ([32ef980](https://github.com/Nyasers/dsh-hanako/commit/32ef98041250f5ffa0a7bff06e9795531bd7c6cb))
* **scripts:** syncver 注册 + prepack 归 build + postbump HEAD 门禁；rspack.config 归 src 根 ([36b95a7](https://github.com/Nyasers/dsh-hanako/commit/36b95a7864ab6da1cc6ceac465751f17f4e00e56))
* **ui:** 自举页日志滚动区无滚动条 + 固定滚底；restart-needed 指引文案通用化 ([33cb0c2](https://github.com/Nyasers/dsh-hanako/commit/33cb0c292e926a18dd088bb1320dd220b6a16e3e))

## [1.0.0-beta.3+dsh-0.1.2-rc.1](https://github.com/Nyasers/dsh-hanako/compare/v1.0.0-beta.2-hotfix.2%2Bdsh-0.1.2-rc.1...v1.0.0-beta.3%2Bdsh-0.1.2-rc.1) (2026-09-03)

### Bug Fixes

* CodeRabbit 四轮意见闭环——严格 SemVer、单次读取、marker 原子缓存 ([e28986e](https://github.com/Nyasers/dsh-hanako/commit/e28986ee3914bedb693aa8f285a1605d2aa2843d))

## [1.0.0-beta.2-hotfix.2+dsh-0.1.2-alpha.5](https://github.com/Nyasers/dsh-hanako/compare/v1.0.0-beta.2-hotfix.1%2Bdsh-0.1.2-alpha.5...v1.0.0-beta.2-hotfix.2%2Bdsh-0.1.2-alpha.5) (2026-09-03)

### Bug Fixes

* /webui 刷新时侧栏误报未就绪——初始化 ready 路径补快照对齐 + 未知态不推面板 ([63fc445](https://github.com/Nyasers/dsh-hanako/commit/63fc445090cd688e9bed740f9c878c4fc4320c96))
* ready 状态机补回退与首次快照重试——非 ready 快照撤销 readyReceived + boot-state 失败 3 次有界重试 ([c316af1](https://github.com/Nyasers/dsh-hanako/commit/c316af19886c3256f739b74ab8b4d458ee7dbe48))

## [1.0.0-beta.2-hotfix.1+dsh-0.1.2-alpha.5](https://github.com/Nyasers/dsh-hanako/compare/v1.0.0-beta.2...v1.0.0-beta.2-hotfix.1%2Bdsh-0.1.2-alpha.5) (2026-09-02)

### Bug Fixes

* pnpmErrorTail 每流各限 ≤300（CodeRabbit PR [#57](https://github.com/Nyasers/dsh-hanako/issues/57)） ([19196d6](https://github.com/Nyasers/dsh-hanako/commit/19196d671a0d8517f9d572a317a5725f76ddc3e0))

## [1.0.0-beta.2](https://github.com/Nyasers/dsh-hanako/compare/v1.0.0-beta.1...v1.0.0-beta.2) (2026-09-02)

### Features

* T2 自动链状态机 + 退避重试调度器 ([d2ccc16](https://github.com/Nyasers/dsh-hanako/commit/d2ccc163c1dfcbbbfc9b64c784d50d8f5fedd5b3))
* T3 自举状态快照端点 ([e648cff](https://github.com/Nyasers/dsh-hanako/commit/e648cffc704de5cbbbf39597b037d9f154a22d6c))
* T4 Bootstrap 自举壳页重写 ([c8ad0ce](https://github.com/Nyasers/dsh-hanako/commit/c8ad0ce14f744f9ddf42de06c92017b5b8d1f065))
* T5 手动入口退役 + 路由清理 ([ad60f69](https://github.com/Nyasers/dsh-hanako/commit/ad60f69df9caeff45066259dae13e65cfbc7ab3a))

### Bug Fixes

* 壳页 hanaApiUrl 正则转义 + retry 时钟读 boot.boot.nextRetryAt（CodeRabbit PR [#56](https://github.com/Nyasers/dsh-hanako/issues/56)） ([8d9fff5](https://github.com/Nyasers/dsh-hanako/commit/8d9fff5a03b6b8ceaea2e0bfa150f053516fb34a))

## [1.0.0-beta.1](https://github.com/Nyasers/dsh-hanako/compare/v1.0.0-alpha.9...v1.0.0-beta.1) (2026-09-02)

### Features

* 错误分类器 errclass（T1） ([2920dc8](https://github.com/Nyasers/dsh-hanako/commit/2920dc836df51ad90501824752b9f40809881c19))

### Bug Fixes

* 错误分类只看最终 registry 尝试（CodeRabbit PR [#50](https://github.com/Nyasers/dsh-hanako/issues/50)） ([d49f3db](https://github.com/Nyasers/dsh-hanako/commit/d49f3dbf7fb23ff2dceddeae834c9e75bb061a81))
* 清理诊断/报错中已退役 dsh-pkg 手动安装引导文案 ([546d154](https://github.com/Nyasers/dsh-hanako/commit/546d1549c9e0abc645a7562d1329f0affffeb5b6))
* 升级残留门控改用 deps.ok，规避 verify running 瞬时态误落兜底 ([5286e99](https://github.com/Nyasers/dsh-hanako/commit/5286e995f614888d7837a7ed0bf7195b83efac40))
* 升级残留门控改用当前 deps 诊断 verified（含 installed 态），防包缺失误判（CodeRabbit PR [#51](https://github.com/Nyasers/dsh-hanako/issues/51)） ([50e0cd6](https://github.com/Nyasers/dsh-hanako/commit/50e0cd670aaa27e864e36a91e68c406123673b31))
* 升级残留提示加依赖验证门控，防安装不完整误引导（CodeRabbit PR [#51](https://github.com/Nyasers/dsh-hanako/issues/51)） ([71ce4fd](https://github.com/Nyasers/dsh-hanako/commit/71ce4fdef57ac734e82a87d4817cd4be8e56f671))
* 新启动尝试作废旧退出记录，防 lastExit 遮蔽当前启动失败（CodeRabbit PR [#53](https://github.com/Nyasers/dsh-hanako/issues/53)） ([a98f97e](https://github.com/Nyasers/dsh-hanako/commit/a98f97ef37809c9867b3706ce377a87e352ecc43))
* 诊断卡错误改日志尾部滚动区（errLog 按行渲染，匹配用完整错误） ([2f1c5c3](https://github.com/Nyasers/dsh-hanako/commit/2f1c5c35c0fa45ac690579862d29a5c656334d3e))
* boot 失败提示识别跨 dsh 版本升级需重启（pickProcessFix） ([6e95b15](https://github.com/Nyasers/dsh-hanako/commit/6e95b157e6e18500399294e18ff4414774409719))
* cliBin 核对应验 isFile + 清理运行级文案残留（CodeRabbit PR [#54](https://github.com/Nyasers/dsh-hanako/issues/54)） ([1be331c](https://github.com/Nyasers/dsh-hanako/commit/1be331cc5d4e52ba3bb418dae21eb59ca5d0bcf7))

## [1.0.0-alpha.9](https://github.com/Nyasers/dsh-hanako/compare/v1.0.0-alpha.8...v1.0.0-alpha.9) (2026-09-02)

### Bug Fixes

* node 代理改回插件根部署，与 PATH 前缀同源（修复 install script 找不到 node） ([7fb33a4](https://github.com/Nyasers/dsh-hanako/commit/7fb33a403119b8367d7de9903de0c82461bb292e))

## [1.0.0-alpha.8](https://github.com/Nyasers/dsh-hanako/compare/v1.0.0-alpha.7...v1.0.0-alpha.8) (2026-09-02)

### Features

* onStartUp 启动 web host 前自动安装一次依赖（加载即自愈） ([524e930](https://github.com/Nyasers/dsh-hanako/commit/524e930d5a651ab3b556a87b4081e8140d4aa7af))

### Bug Fixes

* 挂载延迟时不放弃启动自动链，后台延后等待补跑（CodeRabbit） ([d3848a8](https://github.com/Nyasers/dsh-hanako/commit/d3848a821235ed6735707d8203f00f577b3739d0))
* 启动自动链感知插件卸载/重载，卸载后不再拉起 web host（CodeRabbit） ([114e9c1](https://github.com/Nyasers/dsh-hanako/commit/114e9c1ad3ede0783267db6627e97e0c6aec9aeb))
* unload 守卫覆盖全部延迟启动 await 边界（CodeRabbit 第 3 轮） ([4095600](https://github.com/Nyasers/dsh-hanako/commit/4095600f8458566c48a8092ebc635a357fd497e7))

## [1.0.0-alpha.7](https://github.com/Nyasers/dsh-hanako/compare/v1.0.0-alpha.6...v1.0.0-alpha.7) (2026-09-02)

### Features

* 双轮询事件化——settings/describe 与 /webui/health 改事件驱动 ([51a3666](https://github.com/Nyasers/dsh-hanako/commit/51a3666687478d9556338b0d1f23170b4dab140c))

### Bug Fixes

* 按 CodeRabbit 意见补齐事件流生命周期与终态发布 ([8ed5787](https://github.com/Nyasers/dsh-hanako/commit/8ed57875def8cf1d8ff5d4406433a32f60eb3391))
* 恢复 installing 外层锁后补 notifyDepsChanged（CodeRabbit） ([58b9799](https://github.com/Nyasers/dsh-hanako/commit/58b979926321f2140be866017f01f13742a242ba))
* install 成功终态清空 verify 失败写入的 error（CodeRabbit） ([2024167](https://github.com/Nyasers/dsh-hanako/commit/2024167fa2798e4e1db42a65de8d47a513d85bf2))
* verify 嵌套于 install 时恢复 installing 外层锁（CodeRabbit） ([15ba3b1](https://github.com/Nyasers/dsh-hanako/commit/15ba3b1cac2c65c81190ced9ffc24e0285252602))
* verify 终态先写 error 再 notify（CodeRabbit） ([25d93cf](https://github.com/Nyasers/dsh-hanako/commit/25d93cfa976706c6681cc30f376c46a2b0d8b0bc))

## [1.0.0-alpha.6](https://github.com/Nyasers/dsh-hanako/compare/v1.0.0-alpha.5...v1.0.0-alpha.6) (2026-09-02)

### Features

* **approval:** 宿主审批链路接入 + 应答双 bug 修复 ([4b5ed9c](https://github.com/Nyasers/dsh-hanako/commit/4b5ed9c1c6c22c1f84888f5ed47df69f4b0eaefc))
* upgrade dsh to 0.1.2-alpha.4 ([5a57752](https://github.com/Nyasers/dsh-hanako/commit/5a5775225a297c52ae8bf7ce670c49347c7461ca))
* **wake:** registerDeferredWake 统一带 interlude 标记——预置宿主插话能力 ([2db190c](https://github.com/Nyasers/dsh-hanako/commit/2db190cd0aa6ef9a7e56af3a536bd6fa2c0c8d74))

### Bug Fixes

* 处理 CodeRabbit review 中的有效意见 ([b10b9f3](https://github.com/Nyasers/dsh-hanako/commit/b10b9f3406782b47a9accea42182ad1042629774))
* **bus:** session.list 参数名映射 _request——DSH 0.1.2 上游不一致 ([c4dcf9b](https://github.com/Nyasers/dsh-hanako/commit/c4dcf9b22c7e9659d0e8d8754852bbd78b521ef9))

## [1.0.0-alpha.5](https://github.com/Nyasers/dsh-hanako/compare/v1.0.0-alpha.4...v1.0.0-alpha.5) (2026-09-01)

### Features

* **bridge:** 新增 launchToken method（进程内 BrowserAuth 直读） ([10c879d](https://github.com/Nyasers/dsh-hanako/commit/10c879d8368048b571740190e7ce179bfd568a21))
* **cordis:** dshana profile 运行时挂载——dist/cordis 整体落位为 \/profiles/dshana，补 [@dsh-hanako](https://github.com/dsh-hanako) 子插件 insert 与 agent-presets default ([aead203](https://github.com/Nyasers/dsh-hanako/commit/aead203d5a27cc5ade83679820a0281ee3165bd1))
* **cordis:** dshana profile 运行时挂载——dist/cordis 整体落位为 \/profiles/dshana，补 [@dsh-hanako](https://github.com/dsh-hanako) 子插件 insert 与 agent-presets default ([44d2d89](https://github.com/Nyasers/dsh-hanako/commit/44d2d89b9b2bfea1c48c10fbc3a17a2e2d54d8c9))
* **dsh-run:** 事件流走总线闭环，dsh_run 在 0.1.2 下完整可用 ([b1e369d](https://github.com/Nyasers/dsh-hanako/commit/b1e369dd595b6d66e35c684aa9d0aa9623e09487))
* **dsh-run:** openMux 重写为 remote.mux + \（dsh 0.1.2 事件流） ([80a19d9](https://github.com/Nyasers/dsh-hanako/commit/80a19d90cd994cf37ad6297294da02f1311e5262))
* **lifecycle:** T7b 进程内 boot dsh + 免鉴权 api-bridge + WebUI 根路径 ([8923e0e](https://github.com/Nyasers/dsh-hanako/commit/8923e0e8185ce33f4958455d42788eecce0e1d8b))
* **provider:** 适配 dsh 0.1.2 LlmAdapter 契约，复用官方 PiAiAdapter ([ee166a0](https://github.com/Nyasers/dsh-hanako/commit/ee166a06f9226d30beae94b8b25b8d1536d651e8))
* **webui:** fork 官方 web-app 子插件架构（@dsh-hanako/web-app） ([40babc4](https://github.com/Nyasers/dsh-hanako/commit/40babc40ff446949b4329ddd60c2c1ebc9055bd0))

### Bug Fixes

* **ci:** pnpm-lock.yaml 同步 T7a dsh/cordis 声明（frozen-lockfile 校验修复） ([933a952](https://github.com/Nyasers/dsh-hanako/commit/933a952bb8a64f06dcae0ef77d2f2c48c5ed7083))
* **cordis:** CodeRabbit 审查意见落地——凭据保护/快照回滚/abort 清理/文档对齐 ([a35c980](https://github.com/Nyasers/dsh-hanako/commit/a35c980d9859528a4f00cae3392c2f3bd24b4947))
* **cordis:** dshana profile 改用 dsh-web-app bundle——补齐官方 client roster 修复 boot pending ([59d9dea](https://github.com/Nyasers/dsh-hanako/commit/59d9deaff713945763e8dddf8e8b3f05c431e303))
* **review:** CodeRabbit 二轮 3 条（evtDisposed 重查 / update-stream 状态回查 / BFF 注释） ([7dd463f](https://github.com/Nyasers/dsh-hanako/commit/7dd463fd6e147974dd85b0ac6e45b24fda76e62d))
* **review:** CodeRabbit PR[#39](https://github.com/Nyasers/dsh-hanako/issues/39) 全量落地（8 actionable + 1 nitpick） ([fd332a0](https://github.com/Nyasers/dsh-hanako/commit/fd332a0fcc395e0ff11e659e456c9e1ed5ddcb83))
* **webui:** client 侧 connection 载体 + settings/theme 适配 dsh 0.1.2 + iframe 根路径 ([c11833f](https://github.com/Nyasers/dsh-hanako/commit/c11833f165bc4887a40c93f15d6254f1cc644df5))

## [1.0.0-alpha.3](https://github.com/Nyasers/dsh-hanako/compare/v1.0.0-alpha.2...v1.0.0-alpha.3) (2026-08-31)

### Bug Fixes

* contributes.settings 改回 configuration（宿主 0.810.0 运行时读 configuration，settings 声明不生效，设置项含 dshTag 一直未加载） ([02c8f1e](https://github.com/Nyasers/dsh-hanako/commit/02c8f1e8b4303d2dca216924de99d6afeec58196))

## [1.0.0-alpha.2](https://github.com/Nyasers/dsh-hanako/compare/v1.0.0-alpha.1...v1.0.0-alpha.2) (2026-08-31)

### Features

* 合并 dsh_install/dsh_update 四合一 + 版本/tag 指定 + dist-tag 基线 + version.mjs semver ([5cdc1b1](https://github.com/Nyasers/dsh-hanako/commit/5cdc1b1efd8e64a43f6ba90b60ac0f064c45dbd2))
* 全占页声明样式 + 版本号 v1.0.0-alpha.1 ([562aed6](https://github.com/Nyasers/dsh-hanako/commit/562aed6329c62b43cd068d7c948fcbd00da4b3e5))
* DSHana 迁移 contributes.cards + functionPanel ([b02168a](https://github.com/Nyasers/dsh-hanako/commit/b02168af87adf1d87c344fa9bf654f423e462471))
* DSHana 声明迁移 v2（manifestVersion 2 + fpFullPanel/siteNavEntry） ([3b72bb8](https://github.com/Nyasers/dsh-hanako/commit/3b72bb82052fdfdc0058fab8de51734f9a0f171c))

### Bug Fixes

* CodeRabbit review 修复——install/update 互斥、spec 注入校验、SemVer prerelease 比较、version.mjs 严格化与毕业逻辑、文档同步 ([7eba3be](https://github.com/Nyasers/dsh-hanako/commit/7eba3bee448748c1959922092abcb49fee1e0d7b))
