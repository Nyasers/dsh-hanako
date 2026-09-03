---
name: dsh-hanako
description: "dsh-hanako 鎻掍欢锛堟妸 DeepSeek Harness 鎺ヨ繘 Hana 鐨勮繘绋嬪唴宓?subagent 鎵ц鍣級鐨勯厤缃緟鍔╀笌浣跨敤鎸囧崡銆傝Е鍙戝満鏅細dsh-hanako 鍒氳濂介渶瑕侀厤缃紙榛樿鍗冲彲锛屾棤闇€鎵嬪姩瑁呬緷璧?閰?Node锛夈€丏SHana 鏍囩椤垫樉绀鸿嚜涓句腑/闇€瑕佸鐞嗭紙errorClass 浜鸿瘽鎸囧紩锛夈€亀eb host 璧蜂笉鏉ワ紙鍏堝紑鏍囩椤电湅涓夋€佽嚜涓鹃〉锛歜ooting 闃舵/action-needed 鎸囧紩/ready 鐩村祵锛夈€佷緷璧栧畨瑁呭叏鑷姩锛堣嚜鍔ㄩ摼/鑷妇椤典笁鎬侊紝鏃犳墜鍔ㄥ伐鍏锋棤鎵嬪姩鎸夐挳锛夈€丏SH 浠诲姟澶辫触鎺掓煡銆佸鎵规€庝箞搴旂瓟锛坉sh_session action=approve锛夈€侀粯璁ゆā鍨嬫€庝箞閰嶏紙DSH 璁剧疆椤点€孌SHana 璁剧疆銆嶅垎椤碉紝provider/model/鎬濊€冧笁绾ц仈鍔級銆丏SH 鐗堟湰锛堟洿鏂?DSH = 鏇存柊鎻掍欢鍙戠増 + 閲嶅惎瀹夸富锛夈€佸畨瑁呰繘搴﹀疄鏃舵棩蹇楋紙鑷姩閾?鍗＄墖锛夈€丏eepSeek Harness 鐩稿叧銆傞亣鍒?dsh-hanako 鐩稿叧闇€姹備紭鍏堣鏈妧鑳藉啀鍔ㄦ墜銆?
---

# dsh-hanako 閰嶇疆杈呭姪涓庝娇鐢ㄦ寚鍗?
鎶?DeepSeek Harness锛圖SH锛夋帴杩?Hana锛氭彃浠跺姞杞藉嵆鍚姩**鑷姩閾剧姸鎬佹満**锛堜緷璧栬嚜涓?鈫?杩涚▼鍐呮媺璧?DSH web host锛夛紝DSH Web UI锛坔ttp://127.0.0.1:3080锛変互 **DSHana 鏍囩椤?*锛圔ootstrap 涓夋€佽嚜涓鹃〉锛夊唴宓屽彲瑙佸叏閮ㄤ細璇濄€?
## 棣栨瀹夎閰嶇疆锛圓gent 杈呭姪鐢ㄦ埛瀹屾垚锛?
config.json 鐢卞涓昏缃晫闈㈢敓鎴愩€?*涓嶉殢鍖呭垎鍙?*锛岀己鐪佸叏閮ㄥ彲鐢紝鏃犻渶浜哄伐棰勯厤缃細

- **鏃犻渶鎵嬪姩瑁呬緷璧?/ 鏃犻渶 Node 璺緞**锛氭彃浠跺姞杞斤紙onStartUp锛夎嚜鍔ㄩ摼浼氬箓绛夋鏌ュ苟鎸夋彃浠跺０鏄庯紙鎻掍欢鏍?package.json 鐨?dependencies锛屽浐瀹氱増鏈級鑷姩 `pnpm install --prod` 瑁呰繘**鎻掍欢鏍?node_modules**锛岃濂借嚜鍔ㄦ媺璧?web host鈥斺€斿叏绋嬫棤鎵嬪姩鎸夐挳銆倃eb host 榛樿鐢ㄥ涓?electron 鑷韩 Node 杩愯鏃讹紙`process.execPath`锛宍ELECTRON_RUN_AS_NODE=1`锛夈€?- **鍙€夐厤缃?`nodejsPath`**锛歮acOS 涓?Electron 鍐呭祵 node 璺?pnpm 瑙﹀彂绛惧悕鏍￠獙澶辫触锛坢acos-signature锛夋椂锛屽湪 **DSH 璁剧疆椤点€孌SHana 璁剧疆銆嶁啋 鑷畾涔?NodeJS 璺緞**锛堟垨 config.json `global.nodejsPath`锛夊～绯荤粺 node 缁濆璺緞锛堝 /opt/homebrew/bin/node锛夛紱淇濆瓨 config.json 鍚庤嚜鍔ㄩ摼浼?*鑷姩缁窇**锛坈onfig watch锛夛紝鏃犻渶閲嶅惎銆佹棤闇€鎵嬪姩鎿嶄綔椤甸潰銆?- **鏃犻渶閰嶇疆 API Key / 妯″瀷**锛氬嚟鎹敱 @dsh-hanako/provider 鐩磋瀹夸富 `provider-catalog.json`锛屾ā鍨嬭窡闅忓涓?`models.json`銆備换鍔￠粯璁ゆā鍨?= DSH 榛樿妯″瀷锛屽彲鍦ㄣ€孌SHana 璁剧疆銆嶅垎椤点€岄粯璁ゆā鍨嬨€嶅崱鐗囬厤缃紙provider/model/鎬濊€冧笁绾ц仈鍔級銆?- **DSH 鐗堟湰鍗＄墖**锛氬彧鏄剧ず鏈湴 DSH 鐗堟湰 + 銆屾洿鏂?DSH = 鏇存柊鎻掍欢鍙戠増銆嶈鏄庯紱**鍗囩骇 dsh = 瑁呮柊鎻掍欢鍖?+ 閲嶅惎瀹夸富**锛堣繘绋嬪唴 ESM 缂撳瓨璞佸厤涓嶅彲琛岋紝瑙佸凡鐭ラ檺鍒讹級銆?- `dsh_session(action="create")` 姣忔璋冪敤**蹇呴』鏄惧紡浼?`cwd`**锛坉efaultCwd 宸插垹闄わ級銆?
**閰嶇疆鐢熸晥锛堝疄鏃讹級**锛歯odejsPath 绛夐厤缃繍琛屾湡鐩磋 config.json/鍗曚緥锛坮esolveNodeExec 姣忔 spawn 鍓嶈В鏋愶級锛屼繚瀛樺嵆瀵逛笅涓€娆″瓙杩涚▼鐢熸晥锛涘仠绛夌被澶辫触锛坢acos-signature锛変繚瀛?config.json 鍚庤嚜鍔ㄩ摼缁窇銆備粎銆岃繘绋嬪唴 boot 鐨勬棫妯″潡缂撳瓨銆嶇被闂闇€瑕侀噸鍚涓伙紙restart-needed锛岃涓嬶級銆?
## 鍚姩鑷姩閾撅紙T2 鐘舵€佹満锛屽叏鑷姩锛岄〉闈㈡棤鎵嬪姩鍏ュ彛锛?
鎻掍欢 onload 鍚庤嚜鍔ㄩ摼鍦ㄥ悗鍙版帹杩涳紙鏃犲父椹昏疆璇紝澶辫触閫€閬块噸璇曪級锛岄樁娈垫寔涔呯姸鎬佸瓨鍗曚緥 `g.boot`锛?
1. **ensure-deps**锛氬箓绛夋鏌?瀹夎 dsh 渚濊禆锛坈liBin 鍦ㄤ笖鐗堟湰===澹版槑 + 闈欐€佹牳瀵归€氳繃 鈫?绉掕繃璺宠繃锛涘惁鍒?pnpm install --prod锛屽畼鏂规簮澶辫触鑷姩鍒?npmmirror锛夆啋
2. **booting**锛氳繘绋嬪唴鍚姩 DSH web host锛坄g.startWebHost`锛夆啋
3. **ready**锛氭敹鏁涳紙web host 灏辩华锛屾爣绛鹃〉鐩村祵 iframe锛?
**澶辫触鍐崇瓥锛坋rrorClass 鍒嗙被锛孴1锛?*锛歩nstall/boot 澶辫触鍏堝垎绫诲啀琛屽姩鈥斺€?
- **鍙仮澶嶈嚜鍔ㄩ€€閬块噸璇?*锛坣etwork / environment / unknown / native-toolchain锛夛細閫€閬?30s 鈫?2m 鈫?10m 鈫?30m锛坈ap锛夛紝鎻掍欢鐢熷懡鍛ㄦ湡鍐呮寔缁紝缃戠粶/宸ュ叿閾?鐜鎭㈠鍚?*鑷姩瀹屾垚**锛屾棤闇€鎿嶄綔銆?- **涓嶅彲鑷姩鎭㈠ 鈫?鍋滅瓑鏉′欢鍙樺寲**锛坢acos-signature 绛夐厤缃被 / declaration 澹版槑闂 / restart-needed 鍗囩骇缂撳瓨娈嬬暀锛夛細椤甸潰缁欐槑纭寚寮曪紱鏉′欢婊¤冻鍚庤嚜鍔ㄧ画璺戯紙閰嶇疆淇濆瓨 / 鎻掍欢鏇存柊 / 閲嶅惎瀹夸富锛夈€?
鐘舵€佸揩鐓у崟涓€鍑哄彛 `GET /webui/boot-state`锛圱3锛夛細`{ phase, ready, deps:{ status,errorClass,guidance,error,version,logTail }, boot:{ attempt,nextRetryAt,errorClass,guidance,lastError }, web:{ ready,lastError } }`鈥斺€旀爣绛鹃〉鍙秷璐瑰畠娓叉煋涓夋€侊紙瑙佷笅锛夛紝Agent 鎺掓煡涔熺洿鎺ヨ瀹冦€?
## DSHana 鏍囩椤碉紙Bootstrap 涓夋€佽嚜涓鹃〉锛孴4锛?
鏍囩椤碉紙`/webui`锛夋寜 `boot-state` 娓叉煋涓夋€侊紝**鏃犱换浣曞彲鐐圭殑鍚姩/瀹夎/妫€娴嬫寜閽?*锛堟墜鍔ㄥ叆鍙ｅ凡闅?T5 閫€褰癸級锛?
1. **booting锛堣嚜涓句腑锛?*锛氶樁娈垫椂闂寸嚎锛堜緷璧栧氨缁?鈫?鍚姩 Web Host 鈫?灏辩华锛? 渚濊禆瀹夎瀹炴椂鏃ュ織灏炬粴鍔?+ 閲嶈瘯淇℃伅锛堢 N 娆?/ 涓嬫鑷姩閲嶈瘯鏃跺埢锛夈€傝嚜鍔ㄦ帹杩涗腑锛岀瓑鍗冲彲銆?2. **action-needed锛堥渶瑕佸鐞嗭級**锛氳嚜鍔ㄩ摼鏆傚仠銆傞〉闈㈢粰鍑?**errorClass 浜鸿瘽 + 鏄庣‘鎿嶄綔姝ラ**锛堝閰嶇疆 nodejsPath銆佽缂栬瘧宸ュ叿閾俱€佹竻鐞嗙鐩橈級+ 銆岃嚜鍔ㄧ画璺戜腑/鍋滅瓑銆嶈鏄庯紙鍖哄垎鍙仮澶嶉€€閬块噸璇曚腑 vs 闇€閲嶅惎瀹夸富/绛夋潯浠讹級锛涘師濮嬮敊璇姌鍙犮€岃鎯呫€嶃€傜敤鎴峰彧鍋氶〉闈㈡墍杩扮幆澧冨姩浣滐紝**瀹屾垚鍚庤嚜鍔ㄧ画璺?*銆?3. **ready锛堝氨缁級**锛歩frame 鐩村祵 dsh Web UI銆?
浜嬩欢娴?`GET /webui/events`锛堜繚鐣欙級锛歚ready`锛堟寕杞?iframe锛? `pending`锛堝仠鏈洪€€鍥炶嚜涓鹃〉锛? `diag-changed`锛堣嚜涓剧姸鎬佸彉鍖栦俊鍙凤細deps 缈昏浆鎴?web host 鍚姩澶辫触 鈫?鍒锋柊 boot-state锛? `theme-pref`銆?
## 宸ュ叿閫熸煡

| 宸ュ叿 | 鐢ㄩ€?| 鍏抽敭鐐?| 璇︽儏 |
|---|---|---|---|
| `dsh_session(action, task?, cwd?, 鈥?` | 浼氳瘽鍏ㄧ敓鍛藉懆鏈燂紙瀹夸富 Agent 闈㈠敮涓€宸ュ叿锛?| action 鈭?create锛堟彁浜わ紝task+cwd 蹇呭～锛屽紓姝ユ彁浜ゅ悗涓诲姩缁撴潫鍥炲悎锛? send锛堢画浼氳瘽锛? cancel锛堝彇娑堬級/ list/get锛堝洖鐪嬶級/ approve锛堝簲绛斿鎵癸細sessionId+approvalId锛屽喅绛栫湅 args 涓嶅惉 reason锛夛紱鎿嶄綔瀹炵幇鎸?subtool 妯″潡鍖?| [dsh-session 鎶€鑳絔(dsh-session) |

> 渚濊禆瀹夎宸插叏鑷姩锛堣嚜鍔ㄩ摼 + Bootstrap 鑷妇锛屾棤鎵嬪姩宸ュ叿锛夛細`g.installDeps`/`g.verifyDeps` 鐢辨彃浠剁敓鍛藉懆鏈熼┍鍔紝鏍囩椤靛彧璇诲睍绀轰笁鎬併€?
## 鎺掗敊琛?
**web host 璧蜂笉鏉?鈫?鍏堝紑 DSHana 鏍囩椤电湅涓夋€佽嚜涓鹃〉**锛歜ooting 鏄剧ず闃舵/杩涘害/閲嶈瘯锛沘ction-needed 鐩存帴缁?errorClass 浜鸿瘽 + 鎿嶄綔姝ラ锛涘師濮嬮敊璇姌鍙犮€岃鎯呫€嶃€傚鐓э細

| 鐜拌薄 | 鍘熷洜 | 澶勭悊 |
|---|---|---|
| 椤甸潰 action-needed锛歮acos-signature | Electron node 绛惧悕鏍￠獙澶辫触 | 閰嶇疆 nodejsPath锛堣缃〉 鈫?鑷畾涔?NodeJS 璺緞锛夛紝淇濆瓨鍚庤嚜鍔ㄧ画璺?|
| 椤甸潰 action-needed锛歯ative-toolchain | koffi/node-pty 绛夊師鐢熸ā鍧楃紪璇戝け璐?| 瑁呯紪璇戝伐鍏烽摼锛坢acOS `xcode-select --install` / Windows VS Build Tools锛夛紝鑷姩閾句細閲嶈瘯 |
| 椤甸潰 action-needed锛歟nvironment锛圗ACCES/EPERM/ENOSPC锛?| 鏉冮檺/纾佺洏 | 娓呯悊纾佺洏鎴栬皟鏁存潈闄愶紙EBUSY 灞為攣锛岃嚜鍔ㄩ噸璇曪級 |
| 椤甸潰 action-needed锛歳estart-needed | dsh 宸茶法鐗堟湰鍗囩骇锛屽涓讳粛鎸佹棫妯″潡缂撳瓨 | **閲嶅惎瀹夸富锛圚ana锛?*锛岄噸鍚悗鑷姩缁窇 |
| 椤甸潰 action-needed锛歞eclaration / unknown | 澹版槑鎴栦笂娓搁棶棰?/ 鏈煡 | 鏃犻渶鎵嬪姩锛涚瓑鎻掍欢鏇存柊鎴栦笂鎶ヤ綔鑰咃紝鑷姩閾句繚瀹堥噸璇?|
| booting 闀挎椂闂存棤杩涘睍 / 浜嬩欢涓㈠け | 浜嬩欢娴佹柇鎴栭€€閬块棿闅?| 椤甸潰 30s 鍏滃簳/閫€閬垮埌鐐硅嚜鍔ㄥ埛鏂帮紱寮€浼氳瘽鏃ュ織鐪嬭嚜鍔ㄩ摼閲岀▼纰?|
| 椤甸潰 ready 浣嗕换鍔℃姤 web host 閿欒 | 绔彛鍗犵敤/杩涚▼寮傚父 | 鏌?webPort 鍗犵敤锛涘紑浼氳瘽鏃ュ織锛堣嚜鍔ㄩ摼 `[hana]` 琛岋級瀹氫綅 |
| `dsh_session` 鎶ャ€孌SH 鍖呮湭灏辩华銆?| 渚濊禆缂哄け/婕傜Щ | 鑷姩閾鹃€氬父宸茶嚜鎰堬紙ensure-deps 闃舵鑷姩瀹夎锛夛紱浠嶅け璐ョ瓑閫€閬?鏌ヤ細璇濇棩蹇?|
| pnpm install 涓嬭浇澶辫触/瓒呮椂 | registry 缃戠粶 | 宸插唴缃畼鏂规簮 鈫?npmmirror 鑷姩閲嶈瘯锛涙寔缁け璐ユ煡浠ｇ悊/缃戠粶 |
| bash 鎶?`E_ACCESSDENIED` | DSH bash 娌欑 Windows 闄愬埗 | 鏀圭敤鏂囦欢绯荤粺宸ュ叿锛坵rite/read/edit锛?|
| 鏀逛簡閰嶇疆/浠ｇ爜涓嶇敓鏁?| 瀹夸富妯″潡缂撳瓨 / 闇€閲嶅惎鐨勭紦瀛樻畫鐣?| 閰嶇疆绫诲疄鏃剁敓鏁堬紱鍗囩骇/浠ｇ爜绫婚噸鍚?Hana |

**璇婃柇鏃ュ織**锛氬叏閮ㄨ繍琛屾棩蹇楀湪浼氳瘽鏃ュ織鏂囦欢 `<dataDir>/logs/<YYYYMMDD-HHmmss-SSS>.log`锛堟棫鏃ュ織 onload zstd 鍘嬬缉 `.log.zst` 淇濈暀锛夈€傝鍓嶇紑 src锛歚out`/`err`锛坵eb host锛夈€乣hana`锛堟彃浠剁敓鍛藉懆鏈?+ 閲岀▼纰?`[鑷姩閾綸`/`[渚濊禆瀹夎]`/`[渚濊禆楠岃瘉]`锛夈€乣pnpm`锛坧npm 鍘熷杈撳嚭閫?chunk 瀹炴椂钀界洏锛夈€俻npm/鑷姩閾惧け璐ュ厛鐪?`[hana]` 鑷姩閾捐锛坋rrorClass + 閫€閬?鍋滅瓑鍐崇瓥锛変笌 `[pnpm]` 琛屻€?
## 宸茬煡闄愬埗

- **鍗囩骇 dsh = 瑁呮柊鎻掍欢鍖?+ 閲嶅惎瀹夸富**锛氭彃浠朵晶鏃犳硶璞佸厤瀹夸富杩涚▼鍐?ESM 妯″潡缂撳瓨锛坰pec 鍐崇瓥锛屽嬁閲嶈蛋寮矾锛夛紱璺ㄧ増鏈崌绾у悗 boot 鎾炴棫 .pnpm 缂撳瓨 鈫?restart-needed 鍋滅瓑锛岄噸鍚涓昏嚜鍔ㄧ画璺?- 涓婚璺熼殢锛歴ystem 璺熼殢瀹夸富锛宭ight/dark 鍘熺敓锛涘涓诲垏涓婚鍚庡３椤靛疄鏃惰窡闅忥紙缁?`hana.theme.changed` + `/webui/events` theme-pref锛?- bash 鍦?Windows 鍙兘 E_ACCESSDENIED锛圖SH 娌欑闄愬埗锛夛紱鏂囦欢宸ュ叿姝ｅ父锛學indows 浼樺厛鐢?- wait=true 鍚屾妯″紡鏃犲鎵归€氱煡锛堝彧鑳?Web UI 鎴栬秴鏃讹級锛涢暱浠诲姟寤鸿寮傛
- 瓒婄晫鏉冮檺榛樿璧板鎵癸細deferred 閫氱煡 鈫?`dsh_session(action="approve", 鈥?` 搴旂瓟锛沗approvalTimeoutSec` 鍐呮棤浜哄簲绛旇嚜鍔ㄦ嫆缁濓紙鏈厤缃洖钀?0 = 绂佺敤鑷姩鎷掔粷锛?- 浠诲姟榛樿鏂板缓浼氳瘽锛涗紶 sessionId 澶嶇敤锛坮esume锛夛紱浼氳瘽/璐︽湰鍦ㄦ彃浠舵暟鎹洰褰?dsh-home/锛屼笉纰?~/.DSH
