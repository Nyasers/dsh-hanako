# Changelog

## [1.0.0-beta.5+dsh-0.1.2-rc.1](https://github.com/Nyasers/dsh-hanako/compare/v1.0.0-beta.4%2Bdsh-0.1.2-rc.1...v1.0.0-beta.5%2Bdsh-0.1.2-rc.1) (2026-09-06)

### Features

* 审批反向应答接入（L4）——request_permission 宿主应答闭环 ([4fbb311](https://github.com/Nyasers/dsh-hanako/commit/4fbb3112d88e87aa40d8bd59874bb96918350d1a))
* 审批应答改造（L4 第二版）——ctx approval/request global waterfall 认领 ([3159b3e](https://github.com/Nyasers/dsh-hanako/commit/3159b3e78df39e064d304930412e728cf99e62c0))
* 审批应答链打通（L4 完成）——global+prepend listener 收 waterfall ([82d5f89](https://github.com/Nyasers/dsh-hanako/commit/82d5f893c151708bbca1ce3085426f2fadf27ce6))
* 指令面全 ACP 化（L2 补全）——list/selectModel/cancel 切 ACP 内部通道 ([252f370](https://github.com/Nyasers/dsh-hanako/commit/252f3700d0391669b144ddf72f12eb9378236dae))
* 指令切 ACP（L2 第一刀）——session.create/prompt 走 ACP 内部通道 ([18153ee](https://github.com/Nyasers/dsh-hanako/commit/18153ee9c71af16c10775088cdff85987bbfed92))
* ACP 会话默认 preset 挂载（@dsh-hanako/acp-assist 插件） ([5238f35](https://github.com/Nyasers/dsh-hanako/commit/5238f3503766d32cf07c871fe61e398afee8fe4f))
* ACP 进程内内部通讯通道挂载（L1）——boot 挂 dsh-acp + client 单例 ([43eefa6](https://github.com/Nyasers/dsh-hanako/commit/43eefa605e3b336f4f3534f1ac16b2b9cf382991))
* **ui:** 父子双卡——manifest 拆主卡 /main + 子卡 /sidebar（pageOf），壳页按 view 参数化 ([a1ebcdf](https://github.com/Nyasers/dsh-hanako/commit/a1ebcdf42ea4c766bc8e821cb000272f17af484d))
* **ui:** 子卡 dshana-sidebar 加 cardForm flush（宿主呈现形态，WIP 并入） ([589a07c](https://github.com/Nyasers/dsh-hanako/commit/589a07ca3014f5c99ce70093381a21eb4d88dc49))
* **view:** 白屏自愈——root 装配错误自动 reload（产物热覆盖防御） ([49fa8fa](https://github.com/Nyasers/dsh-hanako/commit/49fa8fa353e0f26d6f134db46a0d63927c431539))
* **view:** fpFullPanel V1 装配者替换——@dsh-hanako/view 接管官方 ui-layout root 装配 ([91c7813](https://github.com/Nyasers/dsh-hanako/commit/91c7813083250bce0ac6a35cb08fa76303fecd70))
* **view:** fpFullPanel V2 sidebar 视图 + fp 嵌入——SidebarOnlyFrame + manifest embedUrl ([2d87141](https://github.com/Nyasers/dsh-hanako/commit/2d87141d3068208b093c03c37771675d0f1c4479))
* **view:** fpFullPanel V3 main 真无侧栏——自组 MainFrame 减法式（rail ≠ 隐藏） ([647d4ff](https://github.com/Nyasers/dsh-hanako/commit/647d4ffeef0872405f58f383e510a0d4e0484c15))
* **view:** fpFullPanel V4 跨边联动——BroadcastChannel 选中态桥 + 握手/防回环 ([eed0b9d](https://github.com/Nyasers/dsh-hanako/commit/eed0b9db5281714874550e7bcada4432fe5ae6d3))
* **view:** settings 跨边——sidebar trigger 拦截转发 main 打开官方设置（V4 结论突破） ([4f2af27](https://github.com/Nyasers/dsh-hanako/commit/4f2af27b945b9a90d8c6beafe36615f912438c91))
* **view:** sidebar 减法剪 logoRow——fp 窄栏隐藏品牌行（hash_local 后缀稳定匹配 + 帧作用域） ([162f459](https://github.com/Nyasers/dsh-hanako/commit/162f45957d5c0dfd4c9c85fc6386508a0826aa54))

### Bug Fixes

* 卡片「任务记录不存在」——ACP 会话 jsonl 无 rpcId，rebuild 退化取最近 prompt ([2194b38](https://github.com/Nyasers/dsh-hanako/commit/2194b38796fcb982fa12db1a109fb9395c7e8bcc))
* ACP 会话 effort 默认保持——acpCreate 补 set reasoning_effort ([69c74da](https://github.com/Nyasers/dsh-hanako/commit/69c74dae3b7813b37be90eb9cf0dc41be7552970))
* ACP 会话事件面接入（session/event 通用广播）——run.js 终态 + 卡片状态流 ([bc153cf](https://github.com/Nyasers/dsh-hanako/commit/bc153cffe2e76f4fa40cd47e9160bfea05625290))
* **acp-assist:** assist await ctx.inject fiber——preset 在首 turn 前挂载完成（CR2 [#6](https://github.com/Nyasers/dsh-hanako/issues/6)） ([1111364](https://github.com/Nyasers/dsh-hanako/commit/111136455249ac57cb9372e0a0881a93ddae6361))
* **acp-assist:** create/resume wrap catch 改 log + rethrow，不再二次调原工厂（CR2 [#5](https://github.com/Nyasers/dsh-hanako/issues/5)） ([7501194](https://github.com/Nyasers/dsh-hanako/commit/7501194c1f94008a70ecfa38b7d8b8976c043504))
* **acp-assist:** preset 挂载查重——resume 已挂会话跳过重复 mount ([1045637](https://github.com/Nyasers/dsh-hanako/commit/1045637c436ee1e12003ab9d090e83e1dc6ffc70))
* **acp:** 审批 onAbort resolve 透传 cancelled，不再误映射为授权（CR2 [#2](https://github.com/Nyasers/dsh-hanako/issues/2)） ([919789e](https://github.com/Nyasers/dsh-hanako/commit/919789e82d221762dd8e5e033c6378e17072e563))
* **acp:** 审批 settle 单飞守卫 + onAbort 清超时计时器（CR Minor [#4](https://github.com/Nyasers/dsh-hanako/issues/4)） ([8078c3a](https://github.com/Nyasers/dsh-hanako/commit/8078c3a3e6cc2cebd8ac896e191f12a07f6d10c6))
* **acp:** readDefaultModel 按块截取 agent-default-model，消除跨块误匹配（CR2 [#7](https://github.com/Nyasers/dsh-hanako/issues/7)） ([3d174b7](https://github.com/Nyasers/dsh-hanako/commit/3d174b78a17416bfe6bc9c817824f6f937b80407))
* **acp:** takeUpdate/close 生命周期——closed 标志、幂等、停用后短路（CR2 [#3](https://github.com/Nyasers/dsh-hanako/issues/3)） ([61528b6](https://github.com/Nyasers/dsh-hanako/commit/61528b666518417df24dc4cb564f9c2052b7e8bd))
* **acp:** toolCache 有界化（上限淘汰）+ close 清空 + 宿主回收前关 ACP client（CR2 [#1](https://github.com/Nyasers/dsh-hanako/issues/1)） ([9fb0301](https://github.com/Nyasers/dsh-hanako/commit/9fb030160c4bc9fb581ea339c5063add446572ec))
* **acp:** toolCache/updateQueue 前置声明到审批应答前，修审批 TDZ 险（CR Minor [#3](https://github.com/Nyasers/dsh-hanako/issues/3)） ([e002eb9](https://github.com/Nyasers/dsh-hanako/commit/e002eb9f0749c3fc586e51c847e26c7673a8ade4))
* **acp:** updateQueue 有界化 + close 清空缓冲/等待者（CR Major [#5](https://github.com/Nyasers/dsh-hanako/issues/5)） ([961d95f](https://github.com/Nyasers/dsh-hanako/commit/961d95fb35d1b87420515df11dfb4ea48415484a))
* **bus:** 进程内 RPC 收口退订 disposer——effect 清理时移除 stale handler（CR Major [#1](https://github.com/Nyasers/dsh-hanako/issues/1)） ([ffab4fe](https://github.com/Nyasers/dsh-hanako/commit/ffab4fee1c9783c556ab40e8b3e204767653dc97))
* CodeRabbit 第五轮两条——assist 等待计时器清理 + readDefaultModel 缩进层级 ([e4bc593](https://github.com/Nyasers/dsh-hanako/commit/e4bc593410b2e4e44cb6782716399d6865f51b91))
* config 下发进程内化——DSH 版本卡「总线配置未就绪」修复 ([b95e1e1](https://github.com/Nyasers/dsh-hanako/commit/b95e1e15e933cc3a38f6e15043f33e85f47da966))
* cordis bridge/bus 用 bus-inproc 版——master 版与 dsh 0.1.2 组合 boot 失败 ([fea5363](https://github.com/Nyasers/dsh-hanako/commit/fea5363c69c54cabdf980eed16080ee7d5b52204))
* **dsh-events:** 白名单 ctx.on 全失败时 subscribe 返回 null（CR [#8](https://github.com/Nyasers/dsh-hanako/issues/8)） ([9f94293](https://github.com/Nyasers/dsh-hanako/commit/9f9429301c8d4af9a9350bf8092bf16d357c263e))
* **dsh-run:** 同会话提交串行化——resume/send 并发复用会话防互相消费 ([9f63984](https://github.com/Nyasers/dsh-hanako/commit/9f639845ed7b153c395bd9b70c26e283a257b228))
* **dsh-run:** assistant 输出取真文本，不再拿会话 title 元数据冒充（CR [#11](https://github.com/Nyasers/dsh-hanako/issues/11)） ([2a517d8](https://github.com/Nyasers/dsh-hanako/commit/2a517d8e46d5d4951473b5aff56bf3ba7557b6fc)), references [#12](https://github.com/Nyasers/dsh-hanako/issues/12)
* **dsh-run:** turn/end 先判 reason.kind——error 失败回合不被当成功（CR [#12](https://github.com/Nyasers/dsh-hanako/issues/12)） ([d7229b2](https://github.com/Nyasers/dsh-hanako/commit/d7229b2128eef93e4c09d4e7615ccd33b9517d0a))
* **events:** 区分「ctx 订阅注册成功」与「producer 可用」，可用前保留总线兜底（CR2 [#4](https://github.com/Nyasers/dsh-hanako/issues/4)） ([5205e2e](https://github.com/Nyasers/dsh-hanako/commit/5205e2e3971d758b52e238997e8cebdd2c7cf6a9)), references [#8](https://github.com/Nyasers/dsh-hanako/issues/8)
* iframe src 端口客户端拼装——随机端口固进模板钉死 3080 兑底 ([caca48b](https://github.com/Nyasers/dsh-hanako/commit/caca48b3cbbca9936c761d1ee3dac457fc6104c6))
* **lifecycle:** providerPushWired 换新 web 实例时清零 + ctx.on 成功后才置位（CR [#6](https://github.com/Nyasers/dsh-hanako/issues/6)） ([08f3087](https://github.com/Nyasers/dsh-hanako/commit/08f3087f257040dc3f81102bf19b3736c9462579))
* **protocol:** ACP cancel notify await——写失败经既有错误路径抛出（CR [#7](https://github.com/Nyasers/dsh-hanako/issues/7)） ([27ca2d4](https://github.com/Nyasers/dsh-hanako/commit/27ca2d4e2e84d62f445baef917fb17101b934e98))
* **provider:** legacy config.routesJSON 初始快照先于 replay 请求执行（CR Data Integrity [#2](https://github.com/Nyasers/dsh-hanako/issues/2)） ([3a6ad3e](https://github.com/Nyasers/dsh-hanako/commit/3a6ad3eb37b0ddcd6adb7b06a95e4b011179826b))
* resume 续会话两修——session.resume 返回无 sessionId + 活跃会话直续（prompt 插话） ([9766fbd](https://github.com/Nyasers/dsh-hanako/commit/9766fbd9852bd09587173ab7c397c9750c3b477e))
* **scripts:** version-hook tag preflight 补远程 origin 检查 + push 提示改 atomic ([143d9d3](https://github.com/Nyasers/dsh-hanako/commit/143d9d33b76c780ec6a4ba080b45cbf6cfd51ed3))
* **tools:** query.js cwd-key 示例编码结果对齐实现——内部连接符为单 '-' ([490d319](https://github.com/Nyasers/dsh-hanako/commit/490d3197e4e7663fb8a7f6b2827e28c74ff2ce7e))
* **view:** 打开时焦点进 dialog——inert 解除竞态（官方 open focus 被 inert 静默阻止） ([2a3a6c9](https://github.com/Nyasers/dsh-hanako/commit/2a3a6c94d4376d2798a50ebb52a516d35ad1e758))
* **view:** CodeRabbit 闭环——宿主键盘可达性（动态 inert）+ settings 请求 pending 重试 ([89cd61a](https://github.com/Nyasers/dsh-hanako/commit/89cd61ab98d8cf7e4f1bc5771f5015ec52b8f61f))
* **view:** ESC 关闭后焦点不再滞留屏幕外 trigger——inert 恢复时移出宿主 ([eb208d4](https://github.com/Nyasers/dsh-hanako/commit/eb208d4c3a2875b6275a0962e37bc73a7e48d443))
* **view:** MainFrame DragHandle 补 onPointerCancel——pointercancel 残留 data-dragging 卡死 ([a72053a](https://github.com/Nyasers/dsh-hanako/commit/a72053a7b1e5c0357dda4ee8c59ef5ea2a8a5040))
* **view:** settings 宿主层叠——fixed 容器建 SC 沉底，输入框盖 modal（用户实测） ([76cf383](https://github.com/Nyasers/dsh-hanako/commit/76cf38360bbab56ba9d43abdfd6aa17ec15cc9d2))
* **view:** settings dialog 焦点陷阱（CodeRabbit 二轮）——Tab/Shift+Tab dialog 内循环 + 逃逸拉回 ([0d23d52](https://github.com/Nyasers/dsh-hanako/commit/0d23d525c5ea7e32c6e40ddcc2399284df0b4b06))
* **view:** sync-bridge pending 补开后重读快照——snap 时序脱节修复（CodeRabbit [#70](https://github.com/Nyasers/dsh-hanako/issues/70)） ([b6cade6](https://github.com/Nyasers/dsh-hanako/commit/b6cade605424d8a2147c7f8f59f428fc3979bad9))
* WebUI 壳页 ready 事件收不到（总线退役后 busReady 恒 false）——就绪判定对齐 web.ready ([73e5b54](https://github.com/Nyasers/dsh-hanako/commit/73e5b545c8ade69d7655504a8a6d1e0025043688))
* **webui:** readiness 翻转通知当前 /webui/events 活动流（CR [#10](https://github.com/Nyasers/dsh-hanako/issues/10)） ([55f2911](https://github.com/Nyasers/dsh-hanako/commit/55f291107a80bf44405210222be10b9bcdb83a2d))

### Performance Improvements

* **view:** settings 宿主观察降级——全树 subtree 观察 → 单元素 aria-expanded attributes 观察 ([cf29f64](https://github.com/Nyasers/dsh-hanako/commit/cf29f6445615488221c3c44769f16fc22f2a4ae8))

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

