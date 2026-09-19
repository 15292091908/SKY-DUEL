# 苍穹对决 · 安卓版（WebView 架构）

**v0.3.0 起改为 WebView 架构：游戏本体就是网页版代码**（打包在 `assets/web/`，网页版 v2.3.7 快照），
启动即游戏（无落地页 / sitemap / robots / SEO）。

> 手感、画面、操控、联机协议与 https://game.4365754.xyz **1:1 一致**——因为运行的就是同一套
> HTML/JS/three.js 代码。安卓 ↔ 安卓、安卓 ↔ 电脑网页版可直接联机（纯 WebRTC 手动交换
> 邀请码/应答码，无服务器）。
>
> 已在本机实测编译通过（Gradle 8.11.1 + AGP 8.9.0 + JDK 17 + compileSdk 36），
> 产物 APK 约 **0.8 MB**，每次编译后自动复制到项目根目录 `苍穹对决.apk`。

---

## 一、架构说明（为什么从原生 GLES 改成 WebView）

| 阶段 | 架构 | 结论 |
|---|---|---|
| v0.1 ~ v0.2 | 原生 OpenGL ES 2.0 重写（零依赖，38 KB） | 联机协议已对齐网页版（含 kstat），但渲染/手感与网页版差异大，实测体验"像两个游戏" |
| **v0.3.0（当前）** | **WebView 加载打包的网页版游戏** | 画面/操控/规则/协议天然 1:1；原生代码全部移入 `native-backup/` 存档 |

WebView 宿主（`MainActivity.java`）的关键配置：
- **WebViewAssetLoader**（androidx.webkit）：以 `https://appassets.androidplatform.net/assets/...`
  提供 APK 内资源 —— 页面获得**安全上下文**，WebRTC DataChannel（联机）、剪贴板、麦克风才可用
- DOM storage 开启：设置面板用 localStorage 持久化
- `setMediaPlaybackRequiresUserGesture(false)`：Web Audio 合成音效自动播放
- `onPermissionRequest` 授权麦克风：联机语音
- `LOAD_NO_CACHE`：APK 升级后资源立即生效（不走缓存）
- 沉浸式全屏 + `sensorLandscape` 横屏锁定 + 保持亮屏

---

## 二、功能清单（v0.3.0）

| 模块 | 状态 | 说明 |
|---|---|---|
| 游戏本体 | ✅ | 网页版 v2.3.7 全量：练习/联机、空战/防空车、海岛/都市/基地三图、五局三胜 |
| 跨端联机 | ✅ | 与网页版同协议（host-mini-world、kstat、hitRep/dmgReject 全在），安卓↔网页互通 |
| 联机语音 | ✅ | 右上角「麦克风/收听」，首次开启请求麦克风权限 |
| 触屏操控 | ✅ | 网页版触屏模式原样：左摇杆 + 屏幕滑动 + 开火/瞄准按钮 |
| 设置面板 | ✅ | 安卓特色：触屏灵敏度 / 画质精度 / 阴影 / 音量（localStorage 持久化） |
| 帮助 | ✅ | 安卓特色版（触屏操作为主 + 联机/剪贴板/返回键说明） |
| 应用图标 | ✅ | 自适应图标（沿用原生版资产） |

---

## 三、目录结构

```
安卓版/
├── build-apk.bat                    一键：编译 + 复制 APK 到项目根目录
├── native-backup/com/skyduel/game/  原生 GLES 版全部代码存档（13 个 .java，不参与编译）
├── tools/make_icon.py               图标生成脚本
├── settings.gradle / gradle.properties（android.useAndroidX=true）/ local.properties
├── app/build.gradle                 依赖仅 androidx.webkit:webkit:1.11.0
└── app/src/main/
    ├── AndroidManifest.xml          横屏、全屏、INTERNET + RECORD_AUDIO
    ├── res/                          图标与文案（沿用）
    ├── java/com/skyduel/game/MainActivity.java   WebView 宿主（唯一 Java）
    └── assets/web/                   游戏本体（网页版快照）
        ├── index.html                play/index.html 安卓改造版（删 SEO、加设置面板、帮助安卓版）
        ├── js/                       main.js / net.js / plane.js / world.js / aagun.js / effects.js / audio.js / ai.js
        └── vendor/three.module.min.js
```

---

## 四、编译与运行

### 方式 A：Android Studio（推荐）
1. `File → Open…` → 选中本文件夹 **`安卓版`**（不要选整个项目根目录）
2. 首次同步：AS 会用 `settings.gradle` 里的 **AGP 8.9.0 + Gradle 8.11.1**（本机已缓存）
3. 连手机（开 USB 调试）→ 点绿色 ▶ 运行 `app`

### 方式 B：一键脚本（日常推荐）
双击 **`安卓版/build-apk.bat`** —— 自动找 JDK 与 Gradle、编译、并把 APK 复制到**项目根目录** `苍穹对决.apk`。

### 方式 C：命令行（本工程实测通过）
```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
C:\Users\<用户名>\.gradle\wrapper\dists\gradle-8.11.1-bin\*\gradle-8.11.1\bin\gradle.bat `
  -p 安卓版 assembleDebug
```
产物：`app/build/outputs/apk/debug/app-debug.apk`

### 环境注意点
| 现象 | 原因 / 处理 |
|---|---|
| `Your project path contains non-ASCII characters` | 中文目录 `安卓版`。已在 `gradle.properties` 开 `android.overridePathCheck=true` |
| `android.useAndroidX is not enabled` | v0.3.0 起引入 androidx.webkit，必须 `android.useAndroidX=true`（已改） |
| 找不到 SDK | 新建 `local.properties` 写 `sdk.dir=C:/Users/<用户名>/AppData/Local/Android/Sdk`（**正斜杠**） |
| WebView 版本过老 | 需 Chromium 89+（importmap）。系统 WebView 一般随 Play 自动更新，minSdk 24 设备基本无忧 |

---

## 五、网页版 ↔ 安卓版 同步规则（重要）

安卓版运行的就是网页版代码，同步即**复制文件 + 保留安卓补丁**：

1. 网页版改了 `js/*.js`（landing.js 除外）→ 复制到 `安卓版/app/src/main/assets/web/js/`
2. 网页版改了 `vendor/three.module.min.js` → 同样复制
3. **保留两处 `[ANDROID]` 补丁**（复制覆盖后检查，丢失需手工恢复）：
   - `main.js` 顶部 GFX 定义处（读 `sd_settings`：shadows/pixel）与 `TOUCH_SENS`（读 touchSens）
   - `audio.js` 顶部 `VOL_DEFAULT`（读 vol）+ `master.gain` 两处引用
4. `index.html` 是安卓特有改造版，**不要**用网页版 play/index.html 覆盖；网页版 HUD/DOM 有变时
   参照其差异手工同步到安卓版 index.html（菜单结构/HUD id 两边一致，JS 才能正常驱动）
5. **缓存铁律**：改了 assets/web 下任何 js → 同步升安卓版 index.html 里所有 `?v=`（当前 8001）
   以及 build.gradle 的 `versionCode`；APK 内资源走 LOAD_NO_CACHE，双保险
6. 落地页 / sitemap / robots / articles / SEO / 统计脚本 **不移植**

---

## 六、安卓特色功能

| 功能 | 说明 |
|---|---|
| 设置面板 | 菜单左上角「设置」：触屏灵敏度 0.8–3.0（默认 1.7）、画质精度 0.75×–2×（默认 1.25×）、阴影开关、音量 0–100%（默认 55%）。「应用」保存并自动重启到菜单（localStorage 键 `sd_settings`） |
| 帮助 | 安卓特色版：触屏操控为主，附跨端联机、剪贴板长按粘贴、返回键说明 |
| 语音 | 「麦克风/收听」按钮 → WebView 权限请求 → 宿主自动授予（Manifest 已声明 RECORD_AUDIO） |
| 剪贴板 | 邀请码「复制」按钮用 `execCommand('copy')`（WebView 原生支持）；粘贴用输入框长按系统菜单 |
| 返回键 | 双击退出（2 秒内），避免对局中误触 |
| 联机 | 与网页版完全一致：创建房间（1v1/3v3/5v5）→ 生成邀请码 → 好友生成应答码 → 互通；同一 WiFi 最稳，跨网用热点或同一网络 |

---

## 七、native-backup（原生 GLES 版存档）

`native-backup/com/skyduel/game/` 保留 v0.2 原生重写版的 13 个源文件
（Game/Renderer/World/Plane/AAGun/Bot/Net/HudView/Sfx/Gfx/M4/Settings/MainActivity），
**不参与编译**，仅作历史参考。其中 Game.java/Net.java 已完成与网页版的协议对齐
（hitRep/dmgReject/kstat/纯 WebRTC 双通道），如将来想做"极小包体原生版"可从此恢复。
