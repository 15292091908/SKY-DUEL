# 苍穹对决 Sky Duel — 项目长期记忆

## 项目概述
3D空战网页游戏，HTML+JS+Three.js r160（本地化vendor/three.module.min.js），v2.1.0
- 纯WebRTC手动SDP交换联机（iceServers:[]，无STUN/TURN/信令服务器），星型拓扑
- 双DataChannel：state无序不可靠20Hz / event可靠有序
- **房主小世界架构（v2.0）**：所有玩家只与房主直连；房主本地权威结算伤害/位置/死亡/回合/胜利，20Hz 推送 sync 快照；非房主 20Hz 上报 upd；fire 上报→房主生成子弹→blt 广播显示
- **本地预判 + 权威回溯（v2.1，市售网游模式，服务器=房主）**：
  - 实时性强的伤害/碰撞：非房主本地先扣血（即时反馈）+ 上报房主；房主命中→sync 确认对账；房主未命中（子弹消失）→ dmgReject{fid} 立即回溯
  - 实体维护 predTotal（未确认预判量）/lastAuth（权威血量）：sync 覆盖时 hp = 权威 - predTotal；nextRound 清零
  - 被打预判：applyMeDamage(dmg, pred=true) 只扣血不判死；被打方向由 sync 直接覆盖回溯（无需 dmgReject）
  - 死亡不做本地预测（撞海/撞地除外）；fatal 碰撞非房主只上报等 sync；环境伤害（撞地8/出界3）经 envDmg 上报房主结算
  - firePred{fid:{id,dmg,t}} 对账表（5s 过期清理）；房主子弹带 fid/fFrom/fHit，foeBulletMiss 判未命中发 dmgReject
- 延迟补偿：房主命中判定时对方上报过期（飞机>350ms / 防空车>400ms）跳过命中
- 房主掉线全员立即弹窗判负；非房主掉线房主权威判死并广播 peerGone
- Web Audio合成全部音效，零外部音频资源
- 部署目标：Cloudflare Pages纯静态直传

## 架构关键约定
- 操控：视角领先+飞机追赶（类似Ace Combat/War Thunder）
  - 鼠标/触屏滑动→aimYaw/aimPitch偏移（1:1无延迟，MAX_AIM=0.55rad）
  - 飞机以TURN_RATE=2.4/PITCH_RATE=1.8追赶视角，慢移几乎同步，快甩视角先转
  - 小准星(#crosshair)=视角方向，大准星(#planeReticle)=飞机实际朝向（偏移显示）
  - 相机跟随视角方向(me.yaw+aimYaw)，子弹方向跟随飞机朝向(forwardOf)
- 手机端：摇杆上下=加速/减速，左右=左飞/右飞(joySteerX连续)；屏幕滑动=控制视角
- 敌我识别：DOM标记池（.planeMarker .foe红/.ally蓝），投影到屏幕+边缘钳制
- 地图：island（海岛）/ city（废墟都市，曼哈顿风格）/ base（军事基地岛，防空车玩法）
- 双玩法：dogfight 空战 / aavs 防空车vs飞机（team0=飞机，team1=防空车）
  - 防空车：固定地面，炮塔旋转+俯仰，双管高射机枪（低伤害高射速+散布）
  - 防空车弱点：弹药箱×2 / 炮塔×1.3 / 车体×1，HP=150
  - 人机对决可选阵营；联机主机随机分配阵营（{t:'team'}消息告知加入方）
  - aavs 固定军事基地图，防空车点位 AAGUN_SPAWNS（7个）
- 练习模式固定1v1；开房间支持1v1/3v3/5v5
- **选阵营定向分配（v2.1）**：房主建表后对每个玩家单独发 pickList{team,slot,m:[[id,slot]队友],f:[[id,slot]对手]}（玩家A视角：B是队友、C是对手）；玩家端不持有完整名单、**无校验链**（checkReq/Ok/Bad/pickReset 已删），确认收到即 ready；ready 用 pickWaitingReady 标志（不能用 pickPhase）；applyPickTeams 仅房主端用（小世界需要全量）
- 碰撞权威结算：crash 消息带 dmg（友军轻撞双方各扣）/ fatal（敌机/撞防空车同归于尽）；crashPairs + markCrashPair 1.5s 去重（双方各自上报只结算一次）；房主端碰撞检测同样先去重
- 队伍比分统一 STATE.s0/s1（队伍视角），syncScoreFromWorld 换算本地视角；房主广播 rEnd/matchEnd

## 文件结构
- index.html: 页面/HUD/菜单/触屏控件
- js/main.js: 主循环/回合制/射击命中/相机/房主小世界联机/双玩法
- js/aagun.js: 防空车模型+炮塔控制（buildAAGun/makeAAGun/forwardOfTurret/applyAAGun）
- js/net.js: 纯WebRTC Net类
- js/plane.js: 机型+弱点+飞行物理（makeFighter/applyFlight/forwardOf）
- js/world.js: 三地图+碰撞体（island/city/base）
- js/effects.js: 爆炸粒子/冲击波/震屏
- js/audio.js: 全合成音效
- js/ai.js: Bot（飞机AI）+ AAGunBot（防空车AI，groundTarget支持俯冲打地面目标）
- host-mini-world-arch.html: 架构演示图（?static 静态模式；SVG defs 必须放 topoG 图层外，render 清空图层时不能清 defs）

## 重要决策记录
- 用户拒绝任何外部服务器（STUN/TURN/信令），最终为纯WebRTC直连（手动SDP交换）
- 联机架构演进：mesh（已废弃删除）→ 房主小世界星型（v2.0 起）；死亡校验vrfy机制已删除，选阵营核对链也删除（v2.1 定向分配）
- **总体原则（用户明确）：按市面上的游戏做，只是服务器换成了房主**——实时性强（伤害/碰撞）本地预判+权威回溯，死亡不做本地预测（撞海撞地除外）
- 非房主端 netSize 在 case 'roster' 同步（roster.length），否则 3v3/5v5 出生点布局重叠
- 房主开火广播 blt（非 fire）；blt 带 from 字段，开火者收到自己的 blt 跳过（防重复子弹）
- 横滚方向：applyFlight中 `f.yawVel * 0.38`（正号）
- 地图必须 scene.add(world.root) 才能显示
- 城市地图参考曼哈顿：退台天台+尖顶天线+玻璃幕墙+水域环绕+中央公园
- **缓存参数铁律（v2.3.5 教训）**：main.js 顶部 import 的 ?v= 参数曾停在 1414 多个版本未更新，导致浏览器拿缓存旧文件、用户测不到修复——**每次改任何 js 文件，必须同步升 index.html 的 ?v= 和 main.js 里所有 import 的 ?v=**（现在都是 1427）
- **天空 = 自定义渐变穹顶 ShaderMaterial**（v2.3.5）：Preetham Sky 插件被 ACES tone mapping 过曝成白，已弃用渲染（vendor/Sky.js 仅存档）；穹顶 top 0x1e63c8→horizon 0xcfe8f8，ShaderMaterial 不经过 tone mapping 颜色可控；PMREM 环境贴图从穹顶生成；穹顶偏暗故三图 sun 2.2-2.4 / Hemi 0.55-0.65 / envMapIntensity 0.85
- **城市布局几何约定**：路在 i*240（大道宽20/街道宽12），街区中心 = gx*240+120（块内半宽111）；楼偏移±72+半宽28 不压路；道路 y=0.4/人行道 0.22/水面 0.12 分层防 z-fighting；河 RIVER_Z=600、高架 z=-480 y=13、地铁站6座、沿街商店随机
- **浏览器实测流程**：agent-browser（npmmirror 源装）+ python http.server 8321；标签页跨 bash 调用会重置→单条命令串 open→eval点击→screenshot；snapshot 对游戏 UI 返回空→用 eval DOM click
- **对同一文件禁止并行 Edit**：两个 Edit 并行写同一文件会互相覆盖（v2.3.5 踩坑）

## 安卓版（安卓版/，v0.3.0 WebView 架构，2026-09-16 起）
- **v0.3.0 架构转向：原生 GLES 弃用，改为 WebView 加载打包的网页版游戏**（用户真机试玩判定原生版"像两个游戏"）。原生 13 个 .java 存档于 `安卓版/native-backup/com/skyduel/game/`（不参与编译），联机协议对齐成果（hitRep/dmgReject/kstat/WebRTC 双通道）随档保留
- 目录：`安卓版/`。启动即游戏（无落地页/sitemap/robots/SEO）。APK ~783KB，每次编译后复制到项目根目录 `苍穹对决.apk`（用户要求工作流）；`build-apk.bat` 一键脚本
- 构建：Gradle 8.11.1 + AGP 8.9.0 + JDK17(AS jbr) + compileSdk 36 / minSdk 24；`gradle.properties` 必须 `android.overridePathCheck=true`（中文路径）**和 `android.useAndroidX=true`**（v0.3.0 引 androidx.webkit）；`local.properties` 正斜杠 sdk.dir
- assets/web/ = 游戏本体快照（网页版 v2.3.7）：index.html 是 play/index.html 的**安卓改造版**（删 SEO、"首页"→"设置"、帮助安卓化、新增设置面板、路径 ../→./、?v=8001）+ js 8 个（无 landing.js）+ vendor/three.module.min.js（Sky.js 无引用不打包）
- **同步规则（改网页版后必做）**：js 复制进 assets/web/js → **恢复 3 处 [ANDROID] 补丁**（main.js GFX+TOUCH_SENS 读 localStorage('sd_settings')、audio.js VOL_DEFAULT）→ 升安卓版 index.html 的 ?v= 与 versionCode；index.html 不能被网页版直接覆盖；落地页/SEO 不移植
- MainActivity.java = WebView 宿主：WebViewAssetLoader（https://appassets.androidplatform.net/assets/ → 安全上下文，WebRTC/剪贴板/麦克风必需）、DOM storage、免手势媒体、onPermissionRequest 授麦克风、LOAD_NO_CACHE、沉浸全屏、sensorLandscape、返回键双击退出；依赖仅 androidx.webkit:1.11.0（webrtc-sdk 已删）
- 设置面板：触屏灵敏度/画质精度/阴影/音量/键位布局编辑器（拖动改位置+滑条改大小,localStorage 键 `sd_layout`,编辑模式**必须隐藏 #menu** 否则菜单层吃掉触摸+独立深色画布）,`sd_settings` 存储,"应用"后 reload 生效；帮助面板为安卓特色版；返回键经 __sdHandleBack 桥优先关面板（v0.3.3 删右上角✕、标题居中；删 HTML 必须同步删 JS 引用否则 IIFE TypeError）
- **WebView 面板滚动铁律（v0.3.4 终解）**：外层 .glassPanel=flex column+overflow:hidden 只做定位/圆角/阴影（圆角+阴影+滚动同元素走 WebView 慢路径瓦片不更新），内层 .panelScroll 纯滚动（无圆角无阴影），**底部按钮行移出滚动区固定面板底**（按钮常显）；禁 will-change/translateZ（合成层滚动瓦片光栅化更慢，v0.3.3 反而加重）；禁 transform 居中+backdrop-filter
- **辅助瞄准已删除（v0.3.4），且永不再加——除非以枪口为瞄准原点**：v0.3.3 锁以「相机→目标」收敛机头，但子弹从机翼枪位（低相机 3.6m）射出，弹道平行偏低 2-2.5m，结构视差不可自愈（准星咬死、子弹擦过）。**第三人称相机与枪口的视差是辅助瞄准的天敌**
- **准星校真（v0.3.4 [ANDROID] 补丁，网页版未动）**：相机 `_look.y += h`（原 +2 与相机 h=3.6 不等高→光轴低倾 1.65°→非开镜小准星≠弹道，1800m 偏高 48m；网页版用户靠开镜狙远所以没暴露）。改后光轴∥机头线，小准星=弹道，全距离一致。同步网页版到安卓时**保留此补丁**；网页版将来也建议同样修
- 版本标识：main.js GAME_VERSION='v0.3.4 安卓版'（安卓独立版本号，非网页版 v2.3.7）
- 菜单 3D 展示已支持触屏（单指拖拽旋转+双指缩放，[ANDROID] 补丁）；全屏含刘海 cutout SHORT_EDGES
- 跨端联机：与网页版 1:1（同一套代码），安卓↔网页可直接对战；纯 WebRTC 手动交换邀请码，同一 WiFi 最稳
