---
name: dsh-session
description: "dsh_session 宸ュ叿鎵嬪唽锛堟簮鐮?src/tools/session.js 鏍稿锛涘悎骞跺師 dsh_run / dsh_cancel / dsh_approve锛屾搷浣滄寜 subtool 妯″潡鍖栵級銆傝Е鍙戝満鏅細鎻愪氦 DSH 浠诲姟锛坅ction=create 鏂板缓浼氳瘽+鎻愪氦 / send 缁凡鏈変細璇濓紝task/cwd 蹇呭～锛岃秴鏃?棰勮/鎺ㄧ悊寮哄害/provider/model 鍙€夛紝sessionId 鍗宠闂嚟璇侊級銆佸彇娑堜换鍔★紙action=cancel锛宻essionId 蹇呭～锛屽箓绛夛級銆佹煡浼氳瘽娓呭崟锛坅ction=list锛岃В鏋?session_projcache锛宭imit 榛樿 10锛夈€佸嚟 sessionId 鍙栦細璇濆唴瀹逛笌鏈€缁堢粨璁猴紙action=get锛岃浼氳瘽 jsonl zstd 瀹瑰櫒鏈湴瑙ｅ帇锛夈€佸簲绛斾細璇濇寕璧峰鎵癸紙action=approve锛歴essionId/approvalId 蹇呭～锛宱utcome=allowed-once/rejected锛屽喅绛栫湅 args 涓嶅惉 reason锛屽涓诲鎵归€傞厤搴旂瓟缁忔€荤嚎 respond 鍥炴姇锛夈€乺esume 澶嶇敤浼氳瘽锛坰end 浼犱笂娆?sessionId 鍗崇画锛夈€傞渶瑕佹彁浜?鍙栨秷/鏌ヨ/瀹℃壒 DSH 浠诲姟鎴栦細璇濆墠鍏堣鏈妧鑳姐€?
---

# dsh_session 宸ュ叿鎵嬪唽

DSH 浼氳瘽鍏ㄧ敓鍛藉懆鏈熷伐鍏凤紙鍚堝苟鍘?`dsh_run` / `dsh_cancel` / `dsh_approve` 鑳藉姏锛夈€傛潈闄?`external_side_effect`锛坋xternal_llm_api锛宑reate/send 娑堣€楀涓?provider 棰濆害锛沜ancel/approve 鏀瑰彉浼氳瘽/瀹℃壒鐘舵€侊級銆傚疄鐜?`tools/session.js`锛堟敞鍐屽垎娲惧３锛? `tools/subtool/{run,query,cancel,approve}.js`锛堝悇鎿嶄綔鐙珛 execute锛歳un=create/send 鎻愪氦銆乹uery=list/get 鍙鏌ヨ銆乧ancel銆乤pprove鈥斺€攕ubtool 涓嶅啀鍗曠嫭娉ㄥ唽锛屽涓?Agent 闈粎 dsh_session锛夈€?
## 鍙傛暟濂戠害

`required: ["action"]`锛?
| 鍙傛暟 | 绫诲瀷 | 璇箟 |
|---|---|---|
| `action` | string | `list` / `get` / `create` / `send` / `cancel` / `approve`锛堣涓嬪悇鑺傦級 |
| `limit` | integer | 浠?list锛氳繑鍥炴潯鏁帮紙榛樿 10锛屾湁鏁?1~100锛?|
| `sessionId` | string | get/send/cancel/approve 蹇呬紶锛堝舰濡?`session-<uuid>`锛屽彇鑷洖璋?鍗＄墖/list锛沝sh-home 瀛樺湪鍗宠锛?|
| `approvalId` | string | 浠?approve锛氬鎵?id锛堝鎵归€氱煡閲屽甫锛涘悓涓€浠诲姟鍙兘鎸傝捣澶氫釜瀹℃壒锛岄€愪釜搴旂瓟锛?|
| `outcome` | enum | 浠?approve锛歚allowed-once`锛堟斁琛屽崟娆★紝瀹夊叏榛樿锛? `rejected`锛堟嫆缁濊璇锋眰锛?|
| `task` | string | create/send 蹇呬紶锛氫换鍔℃弿杩?娑堟伅鏂囨湰 |
| `cwd` | string | 浠?create 蹇呬紶锛氭矙绠卞伐浣滅洰褰曪紙defaultCwd 閰嶇疆宸插垹闄わ紝姣忔璋冪敤鏄惧紡鎸囧畾锛?|
| `timeout` | number | 浠?create/send锛氫换鍔¤秴鏃讹紙绉掞級锛岀己鐪佺敤閰嶇疆 defaultTimeoutSec锛?/缂哄け鍥炶惤 600s锛?|
| `agentPreset` | string | 浠?create/send锛歛gent 棰勮锛坰tandard/ptc/cordis/minimal锛?|
| `reasoningEffort` | string | 浠?create/send锛氭帹鐞嗗己搴︼紙off/high/max锛屾樉寮忎紶鎵嶆寚瀹氾級 |
| `provider` | string | 浠?create/send锛氭樉寮?provider锛堟樉寮忓嵆鎴愪负 DSH 鏂伴粯璁わ級 |
| `model` | string | 浠?create/send锛氭樉寮?model id锛堜笌 provider 涓€璧蜂紶鏃惰鐩?DSH 榛樿锛?|

## action=create锛氭柊寤轰細璇?+ 鎻愪氦浠诲姟锛堝師 dsh_run锛?
- **涓嶅厑璁镐紶 sessionId**锛堟柊寤猴紱缁細璇濈敤 send锛?- **task + cwd 蹇呭～**锛坉efaultCwd 閰嶇疆宸插垹闄わ紝鏃犲洖閫€锛?- **浠诲姟鍙戣捣鍚庝富鍔ㄧ粨鏉熷綋鍓嶅洖鍚?*锛歝reate/send 鍥哄畾寮傛鎻愪氦锛屾彁浜ゅ悗 Agent 搴旂珛鍗?return锛堢粨鏉熷洖澶嶏級锛岃瀹夸富閫氳繃 deferred 鎶曢€掑洖璋冿紙浠诲姟瀹屾垚/瀹℃壒鎸傝捣/澶辫触锛夈€傚鎵归€氱煡璧?interlude 鍨?deferred锛屼絾 interlude 鍚屾牱鍦ㄥ洖鍚堢粨鏉熸椂鎵嶈惤鍦帮紙瀹炴祴涓嶈兘鍦ㄧ粨鏉熷洖鍚堝墠鎻掑叆鏃堕棿绾匡級锛屼笉缁撴潫鍥炲悎鍚屾牱鏀朵笉鍒般€?- 鍥哄畾寮傛锛氱珛鍗宠繑鍥?`{ content: [{ type: "text", text: "浠诲姟宸叉彁浜ょ粰 DSH锛坮pcId: xxx锛夆€? }], details: { dsh: { rpcId, status: "running", cwd }, card: { route: "/card/op?sessionId=鈥?rpcId=鈥?timeoutMs=鈥? } } }`锛沝eferred 娉ㄥ唽 taskId=浠诲姟 rpcId锛坱ype=dsh-run锛屽け璐ヤ篃鍞ら啋锛夛紝瀹屾垚鍚庡涓绘姇閫?`<hana-background-result>`
- 鎻愪氦閾捐矾锛歚session.create`锛堟柊寤猴細`{cwd, agentPreset?}`锛夆啋 璁?sessionId + cwd 鈫?`selectModel`锛堜粎鏄惧紡浼?provider/model/effort 鏃讹紱model-unavailable 鎶ラ敊闄嶇骇涓嶅甫 effort 閲嶈瘯锛夆啋 `session.prompt`锛坢ode=queue锛岀珛鍗?accepted锛夆啋 缁忔€荤嚎 events 棰戦亾浜嬩欢寰幆锛坆us 鎻掍欢璁㈤槄 `$events` 杞彂锛夆啋 缁堟€?- 浜嬩欢娴侊紙DSH 0.1.2锛夛細浜嬩欢涓嶇洿杩?remote.mux鈥斺€擿@dsh-hanako/bus` 鍦?DSH 杩涚▼鍐呰闃?`$events` 骞剁粡鎬荤嚎杞彂锛坮eady/emit/waterfall锛夈€俙api-session/status false` 鍗充换鍔＄粓鎬侊紱`api-session/error` 璁板け璐ュ厹搴曪紱waterfall 甯у凡鍥炴姇 next
- **缁堟€佹槧灏?*锛歚api-session/status [sid, false]` 鈫?`end_turn`锛堟棤 error 鏃讹級锛涘嚭鐜拌繃 `api-session/error` 鈫?`error`锛涙祦缁撴潫鏃犵粓鎬佸抚鍏滃簳 `end_turn`
- 瓒呮椂锛氫换鍔¤秴鏃讹紙timeout 绉掞級浼氱粓姝㈠苟鎶ラ敊锛涘鎵规寕璧锋殏鍋滆鏃讹紙瀹℃壒绛夊緟鏄閮ㄥ喅绛栵紝涓嶈鍏ユ墽琛岃秴鏃讹紝搴旂瓟鍚庢仮澶嶏級
- 鍗＄墖锛歚/card/op?sessionId=鈥?rpcId=鈥锛堝疄鏃舵棩蹇?杩涘害锛屾彃浠堕噸鍚悗鍙仮澶嶏級

## action=send锛氱画宸叉湁浼氳瘽鍙戞秷鎭紙鍘?dsh_run resume锛?
- **sessionId + task 蹇呭～**锛堢画涓婃浼氳瘽锛沜wd 娌跨敤浼氳瘽宸叉湁鍊硷紝鎻愪氦灞傝嚜鍔ㄦ煡璇級
- 鍏朵綑琛屼负涓?create 鐩稿悓锛堟彁浜?鈫?浜嬩欢娴?鈫?缁堟€?鈫?鍗＄墖锛?
## action=cancel锛氬彇娑堜换鍔★紙鍘?dsh_cancel锛?
- **sessionId 蹇呭～**锛坉sh_run 鍥炶皟/鍗＄墖 URL 閲屽甫锛涘彇娑堜竴寰嬫樉寮忎紶 sessionId锛?- 骞傜瓑锛氫换鍔″凡缁撴潫杩斿洖鏃犻渶鍙栨秷锛涜繍琛屾湡鍗忚皟鏉＄洰浠?sessionId 閿帶锛屾瀬鏃?cancel 璺宠繃鏍囪
- 鎬荤嚎 Unary RPC `session.cancel` 鈫?浠诲姟浠?aborted 缁堟€佹敹灏?鈫?鍞ら啋 Agent
- 鍗℃/璇淳/涓嶅啀闇€瑕佺粨鏋滄椂姝㈡崯鐢?
## action=approve锛氬簲绛斾細璇濇寕璧峰鎵癸紙鍘?dsh_approve锛?
- **sessionId + approvalId 蹇呭～**锛堝鎵归€氱煡閲屽甫锛涘叏閾捐矾鍞竴瀹氫綅閿?= 浠诲姟 sessionId锛屽悓閿嵆搴旂瓟璇ヤ細璇濇寕璧风殑瀹℃壒锛涘悓涓€浠诲姟鍙兘鎸傝捣澶氫釜瀹℃壒锛岄€愪釜搴旂瓟锛?- **outcome**锛歚allowed-once`锛堥粯璁わ紝瀹夊叏榛樿鍊硷細鏀捐鍗曟浠呮湰娆℃搷浣滐級/ `rejected`锛堟嫆缁濊璇锋眰锛?- **瀹℃壒瑙﹀彂**锛欴SH agent 璇锋眰瓒婄晫鏉冮檺锛坅pproval/requested锛夆啋 浠诲姟鎸傝捣锛屽鎵逛笂涓嬫枃瀛?`g.ops[sessionId].activeApprovals`锛涘涓荤粡 deferred锛坕nterlude 鍨嬶級鎶曢€?dsh-approval 閫氱煡锛宲ayload锛歚{ kind, rpcId, sessionId, approvalId, toolName, callId, reason, args, taskPreview }`锛坅rgs = 宸ュ叿璋冪敤鍙傛暟鍘熸枃锛屽懡浠?璺緞锛?- **鍐崇瓥锛氱湅 args锛堝叿浣撴墽琛屼簡浠€涔堬級锛屼笉鍚?reason锛坢odel 鑷堪涓嶅彲灏戒俊锛?*鈥斺€斿悎鐞嗘斁琛岋紝鍗遍櫓鎷掔粷
- **搴旂瓟閾捐矾**锛氬簲绛旂粡鎬荤嚎 RPC锛坈allUnaryBus锛夊彂 `method="respond"` 鈫?bus 缈昏瘧鍣ㄨ嚜鐜皟 `POST /api/$events/result`锛坋ventId = 瀹℃壒甯?eventId锛宱utcome `{ kind: 'result', value }`锛夛紱鎬荤嚎鏈繛鎺ラ檷绾?HTTP 鐩磋繛
- **瓒呮椂**锛歚approvalTimeoutSec`锛坈onfig.json `global.approvalTimeoutSec` 浼樺厛锛岀己鐪?0=绂佺敤锛夊唴鏃犱汉搴旂瓟鑷姩 rejected锛坄auto: expired`锛?- **瀹℃壒鎸傝捣鏆傚仠鎵ц瓒呮椂璁℃椂**锛堝鎵圭瓑寰呮槸澶栭儴鍐崇瓥锛屼笉璁″叆浠诲姟瓒呮椂锛涘簲绛?瓒呮椂鍚庢仮澶嶏級锛涘簲绛旀垚鍔?瓒呮椂鍚庝换鍔＄户缁窇鑷崇粓鎬?- **鍏滃簳**锛欴SH Web UI锛坵ebPort 榛樿 3080锛変汉宸ュ鐞嗕粛鍙敤
- **閿欒璇箟**锛氫换鍔′笉瀛樺湪/宸茶繃鏈熴€佸鎵逛笉鍦ㄥ緟鍔炲垪琛紙鍙兘宸插簲绛?瓒呮椂锛夈€佸凡搴旂瓟鍕块噸澶嶅簲绛斻€佸簲绛旀湭鎺ュ彈锛堝彲鑳借秴鏃?浠栨柟澶勭悊锛夆€斺€旀寜杩斿洖娑堟伅澶勭悊鍗冲彲

## action=list锛氫細璇濇竻鍗?
瑙ｆ瀽 `session_projcache.json`锛坉sh-home 鍞竴浜嬪疄婧愶級锛歚{ sessionId, title, cwd?, createdAt?, lastPromptAt?, usage?, turns?, steps?, llmMs? }`锛屾寜 lastPromptAt 闄嶅簭鍙栨渶杩?N 鏉°€傜函鏈湴璇伙紝涓嶈皟 DSH web host銆?
## action=get锛氬嚟 sessionId 鐩村彇浼氳瘽鍐呭

projcache 鍏冩暟鎹?+ summary锛坖sonl 鏈€鍚庝竴鏉?assistant/message 鐨?text锛屾埅鏂?鈮?000锛夈€俲sonl `<dataDir>/dsh-home/sessions/<cwd-key>/<sessionId>/session.jsonl.zstd` 鏄甯?zstd 瀹瑰櫒锛堝抚 magic `0xFD2FB528`锛夛紝node:zlib 閫愬抚瑙ｅ帇鎷兼帴銆?
## 浣跨敤鍦烘櫙

- 鎻愪氦浠诲姟锛歚create`锛堟柊浠诲姟锛夋垨 `send`锛堢画涓婃 sessionId鈥斺€斿厛 list/get 纭浼氳瘽锛?- 姝㈡崯锛歚cancel`锛堝崱姝?璇淳锛?- 鍥炵湅锛歚list`锛堟竻鍗曪級鈫?`get`锛堟渶缁堢粨璁?鍐呭锛?- 瀹℃壒锛氭敹鍒?dsh-approval 閫氱煡鍚?`approve`锛坰essionId+approvalId+outcome锛屽喅绛栫湅 args 涓嶅惉 reason锛?
## 鍏宠仈

- `dsh_install` 宸查€€褰癸細渚濊禆瀹夎鐢辫嚜鍔ㄩ摼 + Bootstrap 鑷妇鎵挎媴锛堟棤闇€鎵嬪姩宸ュ叿锛?- 浜嬩欢娴?鎬荤嚎锛歚@dsh-hanako/bus`锛堟秷鎭€荤嚎锛宒shana.bus WS 鏈嶅姟绔級锛涘鎵圭€戝竷甯у箍鎾笉鍖哄垎浼氳瘽锛堝涓绘寜 sessionId 褰掑睘杩囨护灏氭湭瀹炵幇锛?