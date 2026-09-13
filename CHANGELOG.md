# Changelog

## [1.0.0-rc.1+dsh-0.1.5-rc.2](https://github.com/Nyasers/dshana/compare/v1.0.0-beta.5%2Bdsh-0.1.2-rc.1...v1.0.0-rc.1%2Bdsh-0.1.5-rc.2) (2026-09-13)

### ⚠ BREAKING CHANGES

* 全面改名 dsh-hanako → dshana（App 身份、包作用域、技能目录）

### Features

* **app-v2:** 壳页 UI 升级——复刻 v1 webui-shell 纸张风三态壳（时间线 + 实时日志 + 错误折叠 + 主题桥） ([997ea50](https://github.com/Nyasers/dshana/commit/997ea504506d722614e17aa94869911c78b5a227)), references [#dsh-stage](https://github.com/Nyasers/dshana/issues/dsh-stage)
* **app-v2:** 迁移步骤 1 骨架——v2 manifest / apply 入口 / 设置 / 工具注册（dsh_session list/get 离线可读） ([011abe0](https://github.com/Nyasers/dshana/commit/011abe0722b5979d6f81897ea92f54885bc4405e))
* **app-v2:** 迁移步骤 2 受管运行时——DSH 迁入 App 受管 Node 子进程 ([a69bd35](https://github.com/Nyasers/dshana/commit/a69bd350e46b16e00d2139a9b94dcff20a024deb))
* **app-v2:** 迁移步骤 3 provider adapter 与 create/send 业务链——DSH 推理改走受管 hana.models（NDJSON+done.assistant 签名回放），create/send 经 ctx.tasks.create + task-map 映射 + task-bridge 回投（决策 A-D 见 DESIGN） ([7c1d583](https://github.com/Nyasers/dshana/commit/7c1d583c1adcdac26515f72766dc3b749e47556c))
* **app-v2:** 迁移步骤 4a 审批/取消/超时链——approval-bridge 经 hana.tasks.requestApproval + watch(approvalId) SSE 对账把 outcome 只投给正确 DSH 等待者（rejected/allowed-once 原样，超时/父任务结束/撤销 fail-closed）；cancel 经映射 cancel 标记 + DSH session.cancel、DSH 真中止后宿主才 canceled，宿主 task canceled/aborted 反向触发（task-bridge watch 反向 session.cancel + 定向 models.cancel）；执行超时走 cancel 链；watch SSE 解析/对账（snapshot/app-task/reset、断线 get 对账）与 NDJSON 分侧；task-map 扩展 approvals/cancel 协调字段（决策 E-J 见 DESIGN）；单测 21 例新增（watch-sse/task-map-ext/cancel-chain/approval-bridge），既有 104 例保持全绿 ([1469105](https://github.com/Nyasers/dshana/commit/146910536a543a7ae1484c61030824d004a7463f))
* **app-v2:** 迁移步骤 4b/5 代码收口——ctx.routes 壳页诊断 registrar + contributes.cards/ui 回归 + 旧数据迁移 + pack/syncver v2 版本域 ([4f12c52](https://github.com/Nyasers/dshana/commit/4f12c52e13e943ae334c48a78ef2df915e7acd43))
* **approval:** 审批归属以宿主 parentTaskId 交叉校验，漂移即 fail-closed ([cdfdbff](https://github.com/Nyasers/dshana/commit/cdfdbff108c11b449d8ed49d79db7f6bed428f41))
* **binding:** 会话↔任务绑定搬进宿主会话投影，身份判定改本地读 ([e52ad98](https://github.com/Nyasers/dshana/commit/e52ad98841a313435afdabb8d35214441959acb1))
* **binding:** 投影 v2 加“取消标记”格（写侧双写，读侧暂不动） ([488adbe](https://github.com/Nyasers/dshana/commit/488adbe808d816a27a357e624e4ccb394a3a7d1f))
* **binding:** 投影补 action（v4）；task-bridge 也切到投影读绑定 ([f50e0e7](https://github.com/Nyasers/dshana/commit/f50e0e7e5cd675fa9b1576549cdad227fe05b31c))
* **binding:** 投影补 rpcId 并升 v3；approval-bridge 改“投影优先”读绑定 ([a289b20](https://github.com/Nyasers/dshana/commit/a289b20d3d1e3f78ab2c66cded52ef7ce401116a))
* **card:** 补 detached 拆窗面（standalone.html + 第四个面接线） ([42f84d2](https://github.com/Nyasers/dshana/commit/42f84d2491f5987f6dcc470e2b0f9fe963e3f195)), references [#root](https://github.com/Nyasers/dshana/issues/root)
* **card:** 卡片封面接上 face.image（宿主契约：路径相对 ui/） ([219e688](https://github.com/Nyasers/dshana/commit/219e688d751aff925127a41bef6b0fe055d86c6c))
* **card:** create/send 在会话流里出卡（流内卡字面量 + ui/card.html） ([491a592](https://github.com/Nyasers/dshana/commit/491a592d7e08058e1b9352f588148f36d3149f54))
* **data-source:** 两个超时并入自持设置（与数据模式同栈同 revision） ([c994dd8](https://github.com/Nyasers/dshana/commit/c994dd863152a9afd60197fb53d2fd1361121ebf))
* **data-source:** 数据来源设置与身份解析 + DSH_HOME 不再硬编码（T3.1） ([d5bec5a](https://github.com/Nyasers/dshana/commit/d5bec5aed8550807153cb8768767b96b841901bb))
* **integrations:** 编译进包管线跑通 —— 官方 client 包可由我们自行重建 ([8c14354](https://github.com/Nyasers/dshana/commit/8c143548d45e1b3c0f080d7635e3882e3208c1d4))
* **integrations:** 第一枚 overlay 落地 —— ui-layout 认「面」，FP 回到纯侧栏 ([b9c27b3](https://github.com/Nyasers/dshana/commit/b9c27b309ed19b2e72ec5e6fdf673bb4e256ad34))
* **integrations:** 集成层脚手架与漂移闸（先立闸，后写集成） ([167fb9b](https://github.com/Nyasers/dshana/commit/167fb9b60c8147d3a2b74dedf4b5dc706f5b44a2))
* **integrations:** 跨面会话选中同步（FP 点会话、主卡跟随）——ui-session 补丁 + 桥加选中面 ([4c459de](https://github.com/Nyasers/dshana/commit/4c459deae6819e6ba4121c1ff3a0e38c89cfa973))
* **integrations:** 设置跨面（FP 点、主卡开）——ui-settings-general 补丁 + settingsShell 归位 + 桥的视图状态 ([3d45d95](https://github.com/Nyasers/dshana/commit/3d45d95475438a61427a84a6e33d78499dfa0f99))
* **integrations:** 收掉 /plugins/events 403（client-hmr overlay）+ 发布 __DSHANA__.runtimeUrl ([c7a9bdc](https://github.com/Nyasers/dshana/commit/c7a9bdccefba0fa987613c9c6ea60ae80cf95325))
* **integrations:** 照样例逐字补回 layout 三文件 + ui-sidebar 两文件（批次①后半） ([0dda9c1](https://github.com/Nyasers/dshana/commit/0dda9c1e53d9629644972106bedd9a0f407f7f27))
* **integrations:** ui-open-in-app 转正（图标也过桥）+ 待内联库的解析别名 ([e764f7e](https://github.com/Nyasers/dshana/commit/e764f7e0868cbeda9932a39b53a5eb4ad029ddf6))
* **pack:** 逐目标出包（4 平台包 + 通用兜底）+ 暂存树即用即清 ([4ec9f85](https://github.com/Nyasers/dshana/commit/4ec9f853e5f94cfb974ecb316c38d1eacf395e62))
* **provider:** 按来源取模型请求身份，DSH Web UI 独立会话可直接推理 ([2fb2e25](https://github.com/Nyasers/dshana/commit/2fb2e25fc7acd15df0b7adaee7998420a405e352))
* **provider:** 真流式——增量 emit，done 出权威块 ([ad713b0](https://github.com/Nyasers/dshana/commit/ad713b050b706eb0e0bfd72591cb53d9f181a943))
* **query:** list/get 改走官方查询面（session/list + session/page） ([db4ca9b](https://github.com/Nyasers/dshana/commit/db4ca9ba9e4dad11ec1b3c30eb7c726f4a178184))
* **routes:** 数据源切换入口暂撤（未跑通，先回 503） ([6ec71ee](https://github.com/Nyasers/dshana/commit/6ec71ee92a2e590926193bf1b9945bc3d22b54d2))
* **runtime:** 端口随机化与启动契约对齐（T5.1） ([5969585](https://github.com/Nyasers/dshana/commit/59695856057f6c9e46ebbd9f42afda121e211a4f))
* **runtime:** 中继支持「取流首帧」——读路径只取开场快照，不把流读到底 ([4206ee2](https://github.com/Nyasers/dshana/commit/4206ee29a276503f9915a4a384097a038e6f6cd5))
* **runtime:** preflight 预检模式（数据源切换探针）+ e2e 冒烟回到配置契约（T3.2a） ([c8c635a](https://github.com/Nyasers/dshana/commit/c8c635a13896515b139214e1d5aa13332d22cfea))
* **settings:** 设置页改为 App 自己的页（settings.ui.route 取代 schema）+ DESIGN 过时描述清理 ([56444d0](https://github.com/Nyasers/dshana/commit/56444d0fc8a20259695478daa59795c676173e0b))
* **settings:** 设置页改用宿主的设置组件 ([643c854](https://github.com/Nyasers/dshana/commit/643c854a8a7470445cb34895ac95af9b2167a30a))
* **settings:** 设置栈统一——两个超时走自持存储，读写面带 revision 与 409 ([baf409a](https://github.com/Nyasers/dshana/commit/baf409a41a1774c04253ec6b2806f4cb73396cdb))
* **settings:** 数据来源三档 UI（选目录 + 应用并重启 + operation 轮询） ([63e3f09](https://github.com/Nyasers/dshana/commit/63e3f09c6d62402c41d46116f34e9b0a1f646679))
* **settings:** 宿主设置页的默认模型选择（读写走 DSH 自己的 settings 服务） ([c64b56d](https://github.com/Nyasers/dshana/commit/c64b56dad68b34a4903557e9b9e27b8e28f39c79))
* **settings:** 页面重新可见时重读设置 ([704ddd9](https://github.com/Nyasers/dshana/commit/704ddd9ecc1a57e738f9c0ce5f043c44d63d511a))
* **shell:** 标题栏交互区域（0.950.0+ setInteractiveRegions）；补 open-external 能力；拆窗自举台不再下移 ([bdee56c](https://github.com/Nyasers/dshana/commit/bdee56cf2231cbe8b9d6305a9d5778d556d77511)), references [#dsh-stage](https://github.com/Nyasers/dshana/issues/dsh-stage) [#root](https://github.com/Nyasers/dshana/issues/root)
* **shell:** 删掉死壳 [#frame](https://github.com/Nyasers/dshana/issues/frame)-wrap/[#dsh](https://github.com/Nyasers/dshana/issues/dsh)-frame；自举台收成官方 loading 形态；壳页 tag 选择器不再泼到 DSH 上 ([9873e4a](https://github.com/Nyasers/dshana/commit/9873e4a75d85af7b48c4cf2791b3b6e595db8e1a)), references [#dsh-stage](https://github.com/Nyasers/dshana/issues/dsh-stage) [#runtime-bar](https://github.com/Nyasers/dshana/issues/runtime-bar) [#frame-wrap](https://github.com/Nyasers/dshana/issues/frame-wrap) [#runtime-bar](https://github.com/Nyasers/dshana/issues/runtime-bar) [#dsh-stage](https://github.com/Nyasers/dshana/issues/dsh-stage) [#runtime-bar](https://github.com/Nyasers/dshana/issues/runtime-bar)
* **shell:** boot-state 轮询去重（主卡 owner + FP 订阅）；siteNavEntry 加回；主题跟随提前到插件之前 ([6350765](https://github.com/Nyasers/dshana/commit/63507657758aec66293794a71bc60a36ac81cd7f))
* **source-switch:** 数据源切换链（preflight→冻结→停旧起新→成功才落盘）+ 切换端点 ([5c1d6d0](https://github.com/Nyasers/dshana/commit/5c1d6d08c722c759167f2cdf0cfeaeb0551a8a87))
* **tasks:** 档位显式声明；宿主任务元数据成为 task↔会话的持久记录 ([d2cac2e](https://github.com/Nyasers/dshana/commit/d2cac2e37eab5048c11be54046f3dc36dd317379))
* **theme:** --dsw-alias-border-l3 映射到 --border（占用环的轨道色） ([28607bc](https://github.com/Nyasers/dshana/commit/28607bcfc53096b176b8fc03e3cbd8310175d3b0))
* **theme:** 按三层分工落地——壳只维持宿主变量，偏好由 presenter 投影、DSH 内桥自观察 ([76f8ed3](https://github.com/Nyasers/dshana/commit/76f8ed316987648da9e14bb53d62246df1def1c1))
* **theme:** 偏好变成活值（boot-state 轮询下发）+ 切主题不再等 2s 兜底推送 ([4125f83](https://github.com/Nyasers/dshana/commit/4125f835ce30f3913684ae672824fa3880de094f))
* **tool:** 句柄默认、凭证显式——cancel/approve/get 收 taskId/approvalId，归属由宿主记录校验 ([487691a](https://github.com/Nyasers/dshana/commit/487691af4ee55b1bdaae1ea0761ea5453e9ff7ea))
* **transport:** 一处接管本页请求原语，替掉逐调用点打补丁 ([7b8d43e](https://github.com/Nyasers/dshana/commit/7b8d43ea3ef65fc4b2af8f52ce0e542ccc73212a))
* **ui-session:** 跨面会话选中改为双向同步（+ 回声闸刀） ([5df900f](https://github.com/Nyasers/dshana/commit/5df900fb1b56cf068e3a7d4c28eb93da39c8b95e))
* **ui:** 壳页改同文档注入 DSH 前端 + __DSH_TRANSPORT__（bootstrap 向样例看齐） ([cee4e66](https://github.com/Nyasers/dshana/commit/cee4e667673ef23e70cbe56af3a93feaa918a67e)), references [#root](https://github.com/Nyasers/dshana/issues/root)
* **v2:** IPC 向官方样例对齐——connection 交回官方 + runtime 中继补 cookie ([ab23e16](https://github.com/Nyasers/dshana/commit/ab23e169227128dac21b2c7b609a9222564e5ac1))

### Bug Fixes

* **app-v2:** 恢复 app/ui.clipboard-write 并接上宿主剪贴板能力 ([cc41f88](https://github.com/Nyasers/dshana/commit/cc41f882599bccd839668ef4726a99745f791b40))
* **app-v2:** 壳页 iframe 预种 hana_app_runtime cookie（warm）+ ready 清残留 error（beta.6） ([083d417](https://github.com/Nyasers/dshana/commit/083d417480710b18403ef31dccaf988bc0f65704))
* **app-v2:** 受管运行时权限档切 local-machine（刀 1/3） ([bc10d66](https://github.com/Nyasers/dshana/commit/bc10d66b469321e64de1478261c60265f0e92fe4))
* **app-v2:** 依赖 ensure 移到 App 进程（runtime 沙箱 spawn 硬限制）+ 自动链 Promise 化（beta.5） ([e4f1e74](https://github.com/Nyasers/dshana/commit/e4f1e74b1bd1d9563245fee577e36fda9df53476))
* **app-v2:** 依赖安装 spawn 授权 + apply 级自动链 + sidebar functionPanel 声明（beta.3） ([33e8c25](https://github.com/Nyasers/dshana/commit/33e8c25affc17abe82e35e053382ea4b84ced94b))
* **app-v2:** apply 自动链避让宿主 bootstrap 60s 窗口（延迟 5s 触发，beta.4） ([4f25310](https://github.com/Nyasers/dshana/commit/4f25310cdec891e0ce0ff557231ecafcec78bfec))
* **app-v2:** DSHana 卡片 403 missing_credential——壳页后端路由改走浏览器 SDK hana.api.fetch + vendor @hana/plugin-sdk + bump 2.0.0-beta.2 ([753c429](https://github.com/Nyasers/dshana/commit/753c42970cd8cf38c8102591de8f489b69c96f9e))
* **binding:** 取消标记落进投影只能在 runtime 做（App 侧没有 sessions 句柄） ([fdd6150](https://github.com/Nyasers/dshana/commit/fdd61501c5953d720ae97d91b048ee880073ebb1))
* **ci:** 发布校验的产物名与 pack.mts 对齐（dsh-hanako-v → dshana-v） ([5dd5973](https://github.com/Nyasers/dshana/commit/5dd5973f8e245e9e9f4171992ab1f59b2093be83))
* **ci:** checkout 递归 submodule 并取全量历史（镜像校验读 submodule 的 tag） ([5cb2c21](https://github.com/Nyasers/dshana/commit/5cb2c21c804069a3d3ef557b8e89fff437a5f938))
* **ci:** overlayTsconfig 的 typeRoots/paths 补顶层（干净环境下 @types/node 找不到） ([e040a74](https://github.com/Nyasers/dshana/commit/e040a74cf4fdbd6809725f621bbdd27969ed2a54))
* **clipboard:** 壳级全局影子 + 宿主通道优先；修 written/ok 字段名 ([56560a9](https://github.com/Nyasers/dshana/commit/56560a90142007d0cc510fc4be14155568a411df))
* **cordis:** 装配者交回官方 ui-layout —— 修真机黑屏（自接管是 0.1.2 的冻结副本） ([0a88417](https://github.com/Nyasers/dshana/commit/0a88417152d8e99762a54cfebf98c0915a2f0307))
* **deps:** 补 [@types](https://github.com/types) 声明（@types/node 从幽灵转正，另补四个缺类型的包） ([073c0ca](https://github.com/Nyasers/dshana/commit/073c0cab1c70319cb828f3c7c4c0990191390fcb))
* **integrations:** 设置面板可交互（补回 pointer-events:auto）+ FP 只发射不渲染面板 ([89f69e5](https://github.com/Nyasers/dshana/commit/89f69e55d772f3253b6eedb8fcc8c21ca86f9132))
* **integrations:** 暂不渲染 workspace 的 settingsShell（修设置入口漂到主卡顶部） ([52a0cda](https://github.com/Nyasers/dshana/commit/52a0cda1a41e155cb83919ac61047ffa1a647a6f))
* **integrations:** navigation 面回到「侧栏就是整张面」——修 FP 空白 ([2fcebf9](https://github.com/Nyasers/dshana/commit/2fcebf987854d39a42d7df5a1613486b0a30c7bc))
* **integrations:** ui-layout 网格与渲染同源 —— 修 workspace 下 centerCol 被挤成 56px ([a75a88b](https://github.com/Nyasers/dshana/commit/a75a88b13189800073c6de815e39418e1aed6f4f))
* **lifecycle:** 修复自动重试根本没生效（声明被插进了文档注释）+ 打开页面补一次启动 ([ea0543d](https://github.com/Nyasers/dshana/commit/ea0543d4afce33ceba60fcb37f49b6824deadce1))
* **lifecycle:** 自启失败改为自动重试；siteNavEntry 声明 false；titlebar 改 solid 并去掉拆窗留白 ([a3736a7](https://github.com/Nyasers/dshana/commit/a3736a7b4e055562a8b3d99103947cfa705e516a)), references [#root](https://github.com/Nyasers/dshana/issues/root)
* **pack:** --target 单数取值、必须显式给出；三种失败路径打印支持目标列表 ([da38fdf](https://github.com/Nyasers/dshana/commit/da38fdf57fb18638ee724faa448af4bc9ba6b405))
* **pack:** 裁剪不再动 doc；加“被同包代码引用就保留”闸门；.md 进候选 ([a365990](https://github.com/Nyasers/dshana/commit/a365990fe5fb623bc300ad06dd2856f1c6b957f4))
* **pack:** 裁剪退回保守口径——只按平台筛与四类扩展名，不再按目录名删 ([b747b09](https://github.com/Nyasers/dshana/commit/b747b09e949f2bbd39c8fb4c475477512be83c4f))
* **pack:** 覆盖步骤改指 src-integrations 并 fail-closed——最近几个包里的官方包其实是上游原版 ([2d4dbce](https://github.com/Nyasers/dshana/commit/2d4dbcedd41f782e0d92ce076ffbd15649ad5158))
* **pack:** zip 根 = 包根，不再套一层目录（装不上的根因） ([3151308](https://github.com/Nyasers/dshana/commit/3151308f16a0262337ba97c106753823604a0b83))
* **provider:** 身份三态判定——损坏映射显式失败，不再静默降级成 App 身份 ([670d82a](https://github.com/Nyasers/dshana/commit/670d82a975b919224652a66602b9d54ed991cbe9))
* **provider:** ctx is not defined——身份日志改走 deps 注入；补 adapter 级单测 ([ca0cbf1](https://github.com/Nyasers/dshana/commit/ca0cbf179d8a82c2fe515de75281f2d4f079132d))
* **provider:** maxTokens 超宿主请求闸时不传字段，不再收敛到 65536 ([4e80be0](https://github.com/Nyasers/dshana/commit/4e80be073e9be214a6f48bd66d8880bf0b3e45f8))
* **relay:** WS 升级握手头被剥离致浏览器事件流连不上 + 补齐数据源切换冻结（T5.2） ([d6cb43f](https://github.com/Nyasers/dshana/commit/d6cb43f81af9c0bfc818a4ad49fe0bc11c724bb3))
* **routes:** 数据目录改取宿主顶层 ctx.dataDir ([eaf2b99](https://github.com/Nyasers/dshana/commit/eaf2b99d6fbd9f5ffdfeeeda194e058621448b6a))
* **settings:** 保存默认模型后不再清空候选列表 ([144cb9c](https://github.com/Nyasers/dshana/commit/144cb9caa57134b5aafe1e8fd5947923a3b3e112))
* **settings:** 补回设置页自己的底色与文字色 ([60ed9b1](https://github.com/Nyasers/dshana/commit/60ed9b1749426da7d8d58e92b15be3842c149351)), references [#F5EFE4](https://github.com/Nyasers/dshana/issues/F5EFE4) [#2A2622](https://github.com/Nyasers/dshana/issues/2A2622)
* **settings:** 模型选择改成宿主那个分组形状（一个下拉、provider 当组标题） ([94b4b94](https://github.com/Nyasers/dshana/commit/94b4b94734aa15d30073c2c2fbe8e536471dfd75))
* **settings:** 默认模型改回三段式选择，长候选可滚 ([2ee55ed](https://github.com/Nyasers/dshana/commit/2ee55ed75c5015638e22889468b522401ce83c03))
* **test:** 反斜杠同义断言加平台守卫（Linux 上 "\ds h\" 不是绝对路径） ([78a3686](https://github.com/Nyasers/dshana/commit/78a36865d93e4b4e2c17888b1c4609582fef813d))
* **theme:** 补 warn/success 语义色的主题映射——连接状态指示灯不再穿 DSH 内置色 ([813972f](https://github.com/Nyasers/dshana/commit/813972ffcbc8dc302e6f719a25d2244f885a56df))
* **theme:** 补齐 alias 语义层 token 覆盖；映射表拆成可单测模块 ([0030c86](https://github.com/Nyasers/dshana/commit/0030c86279f13f293969640ca85f87bba6843dca))
* **theme:** 层次位改叠色、结构性深浅还给原生（修 tooltip 白底白字 / 按钮与输入框融为一体 / elevation 失效） ([7bd1fa2](https://github.com/Nyasers/dshana/commit/7bd1fa243b7fd1d26dbd2247ea4e2b6fcaf29cae)), references [#FCFAF5](https://github.com/Nyasers/dshana/issues/FCFAF5)
* **theme:** 偏好改由壳页下发（取自 DSH index 的 boot-theme 行），退役 RPC 与总线事件链 ([c04a552](https://github.com/Nyasers/dshana/commit/c04a552cf0754e8d78b36460fb7d7f5abcbeecd6))
* **theme:** 统一到宿主变量名，空值不再出手——修「整个 UI 背景变 transparent」 ([3c605f6](https://github.com/Nyasers/dshana/commit/3c605f6b523526ff87cb1919e4350f99a9428bd5))
* **theme:** 主题桥适配同文档拓扑——来源校验改双拓扑 + 直读文档根；注入器补 <style> 搬运 ([e97e452](https://github.com/Nyasers/dshana/commit/e97e45237bf87b091aa47edcd0763a106d9302df))
* **theme:** settings/describe 改走 __DSH_TRANSPORT__（私有运行时基址）——修 403 missing_credential ([38b2409](https://github.com/Nyasers/dshana/commit/38b240921162bc64c4bb59c77aa474b302a9b825))
* **tool:** 工具上下文继承宿主 ctx（真机：list/get 报“宿主不支持受管服务请求”） ([b613ab2](https://github.com/Nyasers/dshana/commit/b613ab2bbe57c3cb01b0d7b233a6df1f322c5674))
* **tools:** 修 create/send 定位键丢失与 App 进程崩溃；DSH 访问收进 runtime 控制面 ([624886e](https://github.com/Nyasers/dshana/commit/624886e611211f7765ca05848a48f1364bb97f50))
* **tsconfig:** typeRoots 同时列顶层与 hoist（编辑器找不到 @types/node） ([242f1a8](https://github.com/Nyasers/dshana/commit/242f1a8b65aa72d0108602eb4c5d5635761f328c))
* **typecheck:** 失败清单纳入重声明类错误（TS2451 / TS2393） ([9641cb5](https://github.com/Nyasers/dshana/commit/9641cb5a5a74db7fb150aa22336f93fcb9d423a8))
* **types:** 覆盖层口径修复与 vendor 同步（8 条归零） ([9e7b4b4](https://github.com/Nyasers/dshana/commit/9e7b4b4fd1f1e4b2e0520129e398dcd821beefae))
* **types:** 全仓清掉 never[] 推断，并为 cordis service 半补 swc ([10891f8](https://github.com/Nyasers/dshana/commit/10891f8429e73736a47396f5411033d5aa3ec4f3))
* **types:** app-runtime 运行包补类型，并修 #/types/host 漏扩展名 ([6513b41](https://github.com/Nyasers/dshana/commit/6513b41d3ece5601a6cf7e047239ea3bc88b2389))
* **types:** app-shell 的初始值推断（= null / {} / 空集合） ([a1b888f](https://github.com/Nyasers/dshana/commit/a1b888f2276ff0793426f83f911c98d8ca77ba62))
* **types:** dsh-inject / build / index 的编辑器报错 ([def633b](https://github.com/Nyasers/dshana/commit/def633b044d76d6ba438e14e5c48ccbbc650fbcd))
* **types:** lib/session-run 与 lib/config 补类型（38 条归零） ([e4aeab5](https://github.com/Nyasers/dshana/commit/e4aeab55ec33b092ff2e875dc50b16ee976b9919))
* **types:** routes/dshana-routes 与 lib/data-source 补类型（52 条归零） ([f88d8af](https://github.com/Nyasers/dshana/commit/f88d8afbb586b61b55ab09e749e6007d2a846cca))
* **types:** runtime/approval-bridge 补类型（34 条归零） ([f1efb1c](https://github.com/Nyasers/dshana/commit/f1efb1cd850fca1936d9c0dd4b26a67a365c18ba))
* **types:** runtime/main 补类型（21 条归零） ([1b50173](https://github.com/Nyasers/dshana/commit/1b50173bd605b06d1156d80481797ce95c925588))
* **types:** src / src-cordis / scripts 三域补类型（182 条归零） ([dd95be8](https://github.com/Nyasers/dshana/commit/dd95be83a2b1db9efb99a4f3bcc7e29727ae1ba9))
* **types:** tools/shared/query 补类型（48 条归零） ([ca79fdf](https://github.com/Nyasers/dshana/commit/ca79fdf078147769715a99bf9c35f57c39dc5b01))
* **ui-layout:** 补回取「面」的那行代码（清注释时被连带删掉） ([3e43ca3](https://github.com/Nyasers/dshana/commit/3e43ca330a7cd114c9f1f85c1d530c08fed7ddda))
* **ui-layout:** 拆窗面去掉「收起」机制——侧栏不再被 0 宽吞掉 ([86af008](https://github.com/Nyasers/dshana/commit/86af0085137eeec72d5b3912261348c4cecfcac2))
* **ui-layout:** workspace 是合法角色不是未知——修正主卡被判成拆窗面 ([60ac120](https://github.com/Nyasers/dshana/commit/60ac120612c0af0e9e07ba73f3f0c451dd761afe))
* **ui-session:** 主卡不再被 FP 的陈旧选中压回去（共享值带写入时刻） ([ef89743](https://github.com/Nyasers/dshana/commit/ef89743403f7fe0e2109fb755b9fb1cf730c0c52))
* **ui:** 补上 __DSH_FILE_UPLOAD__ —— 不设它时 DSH 附件上传会落到宿主源被 403 ([5347d44](https://github.com/Nyasers/dshana/commit/5347d44e552a25080087b37b1147bd88fba6477d))
* **ui:** 接上宿主主题能力——壳页以前从没加载过 hana-css，主题一直是兜底色 ([2fe26b0](https://github.com/Nyasers/dshana/commit/2fe26b07eb68b10dfc4989a9a83926d308abc8aa)), references [#F5EFE4](https://github.com/Nyasers/dshana/issues/F5EFE4)
* **ui:** 认面的事实源改回「页面自己的静态声明」（meta），宿主 slot 降为兜底；退役 ?dshana-view= ([2adfe87](https://github.com/Nyasers/dshana/commit/2adfe875822bf8d313ca502e3e8637c381792e6b))
* **ui:** 页面启动协议改成 context 驱动（认面问宿主，不再用自家查询参数）+ 认路径票据 ([59152b7](https://github.com/Nyasers/dshana/commit/59152b7f131e32e818d9cd4c8c80940d5aeba80e))
* **ui:** 主题投递改壳页主动推（同文档注入后桥的 parent 是宿主，请求到不了壳） ([a93d998](https://github.com/Nyasers/dshana/commit/a93d998f8d1edb1edeabd544ed5b1880398a9ff5))
* **ui:** ready 态顶上白占一整屏——遗留壳容器盖过了 [hidden]（真机反馈） ([af8655d](https://github.com/Nyasers/dshana/commit/af8655dcddfce9e73ff38360c7f79f971cce4afa)), references [#frame-wrap](https://github.com/Nyasers/dshana/issues/frame-wrap) [#frame-wrap](https://github.com/Nyasers/dshana/issues/frame-wrap)

### Performance Improvements

* **pack:** 源码层精简体积——64.9MB → 39.6MB（已低于市场 50MB 闸） ([dca9b7b](https://github.com/Nyasers/dshana/commit/dca9b7ba972219af30e9827328db4b83449cbc86))

### Reverts

* **clipboard:** 撤回日志静音，退回每次失败即时上报 ([1cb9b6b](https://github.com/Nyasers/dshana/commit/1cb9b6b5d961294f5882a3678c7fa8c6883d45e1))
* **theme:** 收回「嵌入式一律跟随」——跟随门回到仅 preference=system ([7616028](https://github.com/Nyasers/dshana/commit/7616028de75467887706c018fe01a7644353c90e))

### Code Refactoring

* 全面改名 dsh-hanako → dshana（App 身份、包作用域、技能目录） ([e31c42e](https://github.com/Nyasers/dshana/commit/e31c42ebbd197281ee3bc6e1898c5b02bc3851da))

## [1.0.0-beta.5+dsh-0.1.5-rc.2](https://github.com/Nyasers/dsh-hanako/compare/v1.0.0-beta.5%2Bdsh-0.1.2-rc.1...v1.0.0-beta.5%2Bdsh-0.1.5-rc.2) (2026-09-11)

### Features

* **app-v2:** 壳页 UI 升级——复刻 v1 webui-shell 纸张风三态壳（时间线 + 实时日志 + 错误折叠 + 主题桥） ([997ea50](https://github.com/Nyasers/dsh-hanako/commit/997ea504506d722614e17aa94869911c78b5a227)), references [#dsh-stage](https://github.com/Nyasers/dsh-hanako/issues/dsh-stage)
* **app-v2:** 迁移步骤 1 骨架——v2 manifest / apply 入口 / 设置 / 工具注册（dsh_session list/get 离线可读） ([011abe0](https://github.com/Nyasers/dsh-hanako/commit/011abe0722b5979d6f81897ea92f54885bc4405e))
* **app-v2:** 迁移步骤 2 受管运行时——DSH 迁入 App 受管 Node 子进程 ([a69bd35](https://github.com/Nyasers/dsh-hanako/commit/a69bd350e46b16e00d2139a9b94dcff20a024deb))
* **app-v2:** 迁移步骤 3 provider adapter 与 create/send 业务链——DSH 推理改走受管 hana.models（NDJSON+done.assistant 签名回放），create/send 经 ctx.tasks.create + task-map 映射 + task-bridge 回投（决策 A-D 见 DESIGN） ([7c1d583](https://github.com/Nyasers/dsh-hanako/commit/7c1d583c1adcdac26515f72766dc3b749e47556c))
* **app-v2:** 迁移步骤 4a 审批/取消/超时链——approval-bridge 经 hana.tasks.requestApproval + watch(approvalId) SSE 对账把 outcome 只投给正确 DSH 等待者（rejected/allowed-once 原样，超时/父任务结束/撤销 fail-closed）；cancel 经映射 cancel 标记 + DSH session.cancel、DSH 真中止后宿主才 canceled，宿主 task canceled/aborted 反向触发（task-bridge watch 反向 session.cancel + 定向 models.cancel）；执行超时走 cancel 链；watch SSE 解析/对账（snapshot/app-task/reset、断线 get 对账）与 NDJSON 分侧；task-map 扩展 approvals/cancel 协调字段（决策 E-J 见 DESIGN）；单测 21 例新增（watch-sse/task-map-ext/cancel-chain/approval-bridge），既有 104 例保持全绿 ([1469105](https://github.com/Nyasers/dsh-hanako/commit/146910536a543a7ae1484c61030824d004a7463f))
* **app-v2:** 迁移步骤 4b/5 代码收口——ctx.routes 壳页诊断 registrar + contributes.cards/ui 回归 + 旧数据迁移 + pack/syncver v2 版本域 ([4f12c52](https://github.com/Nyasers/dsh-hanako/commit/4f12c52e13e943ae334c48a78ef2df915e7acd43))
* **data-source:** 数据来源设置与身份解析 + DSH_HOME 不再硬编码（T3.1） ([d5bec5a](https://github.com/Nyasers/dsh-hanako/commit/d5bec5aed8550807153cb8768767b96b841901bb))
* **pack:** 逐目标出包（4 平台包 + 通用兜底）+ 暂存树即用即清 ([4ec9f85](https://github.com/Nyasers/dsh-hanako/commit/4ec9f853e5f94cfb974ecb316c38d1eacf395e62))
* **runtime:** 端口随机化与启动契约对齐（T5.1） ([5969585](https://github.com/Nyasers/dsh-hanako/commit/59695856057f6c9e46ebbd9f42afda121e211a4f))
* **runtime:** preflight 预检模式（数据源切换探针）+ e2e 冒烟回到配置契约（T3.2a） ([c8c635a](https://github.com/Nyasers/dsh-hanako/commit/c8c635a13896515b139214e1d5aa13332d22cfea))
* **ui:** 壳页改同文档注入 DSH 前端 + __DSH_TRANSPORT__（bootstrap 向样例看齐） ([cee4e66](https://github.com/Nyasers/dsh-hanako/commit/cee4e667673ef23e70cbe56af3a93feaa918a67e)), references [#root](https://github.com/Nyasers/dsh-hanako/issues/root)
* **v2:** IPC 向官方样例对齐——connection 交回官方 + runtime 中继补 cookie ([ab23e16](https://github.com/Nyasers/dsh-hanako/commit/ab23e169227128dac21b2c7b609a9222564e5ac1))

### Bug Fixes

* **app-v2:** 恢复 app/ui.clipboard-write 并接上宿主剪贴板能力 ([cc41f88](https://github.com/Nyasers/dsh-hanako/commit/cc41f882599bccd839668ef4726a99745f791b40))
* **app-v2:** 壳页 iframe 预种 hana_app_runtime cookie（warm）+ ready 清残留 error（beta.6） ([083d417](https://github.com/Nyasers/dsh-hanako/commit/083d417480710b18403ef31dccaf988bc0f65704))
* **app-v2:** 受管运行时权限档切 local-machine（刀 1/3） ([bc10d66](https://github.com/Nyasers/dsh-hanako/commit/bc10d66b469321e64de1478261c60265f0e92fe4))
* **app-v2:** 依赖 ensure 移到 App 进程（runtime 沙箱 spawn 硬限制）+ 自动链 Promise 化（beta.5） ([e4f1e74](https://github.com/Nyasers/dsh-hanako/commit/e4f1e74b1bd1d9563245fee577e36fda9df53476))
* **app-v2:** 依赖安装 spawn 授权 + apply 级自动链 + sidebar functionPanel 声明（beta.3） ([33e8c25](https://github.com/Nyasers/dsh-hanako/commit/33e8c25affc17abe82e35e053382ea4b84ced94b))
* **app-v2:** apply 自动链避让宿主 bootstrap 60s 窗口（延迟 5s 触发，beta.4） ([4f25310](https://github.com/Nyasers/dsh-hanako/commit/4f25310cdec891e0ce0ff557231ecafcec78bfec))
* **app-v2:** DSHana 卡片 403 missing_credential——壳页后端路由改走浏览器 SDK hana.api.fetch + vendor @hana/plugin-sdk + bump 2.0.0-beta.2 ([753c429](https://github.com/Nyasers/dsh-hanako/commit/753c42970cd8cf38c8102591de8f489b69c96f9e))
* **pack:** --target 单数取值、必须显式给出；三种失败路径打印支持目标列表 ([da38fdf](https://github.com/Nyasers/dsh-hanako/commit/da38fdf57fb18638ee724faa448af4bc9ba6b405))
* **pack:** zip 根 = 包根，不再套一层目录（装不上的根因） ([3151308](https://github.com/Nyasers/dsh-hanako/commit/3151308f16a0262337ba97c106753823604a0b83))
* **relay:** WS 升级握手头被剥离致浏览器事件流连不上 + 补齐数据源切换冻结（T5.2） ([d6cb43f](https://github.com/Nyasers/dsh-hanako/commit/d6cb43f81af9c0bfc818a4ad49fe0bc11c724bb3))
* **tools:** 修 create/send 定位键丢失与 App 进程崩溃；DSH 访问收进 runtime 控制面 ([624886e](https://github.com/Nyasers/dsh-hanako/commit/624886e611211f7765ca05848a48f1364bb97f50))
* **ui:** ready 态顶上白占一整屏——遗留壳容器盖过了 [hidden]（真机反馈） ([af8655d](https://github.com/Nyasers/dsh-hanako/commit/af8655dcddfce9e73ff38360c7f79f971cce4afa)), references [#frame-wrap](https://github.com/Nyasers/dsh-hanako/issues/frame-wrap) [#frame-wrap](https://github.com/Nyasers/dsh-hanako/issues/frame-wrap)

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



