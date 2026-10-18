# 模式包（js/modes/）—— 自包含、按需加载

**一句话**：大厅、联机传输、引擎、主循环、载具内核是共用库；**每个玩法是一个自己的文件夹**。
大厅只读清单渲染，不写死任何玩法；玩到哪个模式，才动态加载哪个目录。

```
js/
  lobby.js          大厅外壳（渲染药丸/地图/阵营，不含任何玩法名）
  mode.js           读取器 + 装载器（读 js/modes.json → import 模式包）
  modes.json        ⚠ 自动生成，不要手改
  world/            共用世界基础设施（天空/边界/createWorld + common.js）
  modes/
    air/            空战对决（一个完整模式包）
      mode.json     名字 / 排序 / 主题色 / 默认地图
      index.js      游戏内容（MODE：阵营/出生点/菜单/武器/编成函数）
      net.js        联机契约（组队/地面载具/同步字段）
      maps.js       地图目录 + registerMap
      maps/         本模式的地形文件（island.js / city.js）
      lobby.css     本模式的大厅皮肤
    aavs/           防空车突袭（同结构）
    heli/           直升机突袭（同结构）
docs/
  modes.md          本文档
  modes-template/   新玩法模板（复制到 js/modes/<目录名> 后开工）
```

## 加一个模式（不用改 HTML / lobby.js / mode.js）

1. `cp -r docs/modes-template js/modes/<目录名>`
2. 改 `mode.json`（id / name / order / accent / defaultMap）
3. 改 `index.js`（阵营、出生点、菜单、spawnPractice）与 `net.js`（组队规则）
4. 地形：把 `maps/*.js` 换成自己的地图，在 `maps.js` 里登记
5. `node server/scan-modes.js`（或直接刷新开发服务器）→ 大厅自动多一个药丸

删除模式 = 删掉整个文件夹 → 清单自动少一个。

## 清单为什么需要生成

浏览器不能列目录，静态站点也没有目录索引。`server/scan-modes.js` 扫描
`js/modes/*/mode.json` 生成 `js/modes.json`：

- 开发：`node server/serve.js` 对每次 `/js/modes.json` 请求实时重扫（加/删文件夹立即生效）
- 打包：`node server/pack.js` 自动重扫并把清单带进 `发布/js/modes.json`

## 模式包内各文件职责

| 文件 | 职责 | 会被谁读 |
|---|---|---|
| `mode.json` | 名字、排序、主题色、默认地图、大厅 CSS 文件名 | `server/scan-modes.js` → 清单 → `mode.js` |
| `index.js` | `MODE` 描述符 + `spawnPractice` 等玩法函数 | `mode.js` 动态 import |
| `net.js` | `NET`：`hostPrePick / groundTeam / maxSize / sync` | `mode.js` 合并进 MODE |
| `maps.js` | `MAPS` 数组 + `registerMap()` | `mode.js` → `modeDef().maps` → 大厅/世界 |
| `maps/*.js` | 地形（`MAP = { id,name,desc,sky,fog,bounds,build }`） | 该模式的 `maps.js` |
| `lobby.css` | 只作用于 `#menu[data-mode="<id>"]` 的大厅皮肤 | `mode.js` 切模式时注入 |

## 共用部分（不要复制进模式包）

`lobby.js / mode.js / match.js / combat.js / netev.js / sdp.js / loop.js / camera.js /
scene3d.js / hud.js / units.js / plane.js / aagun.js / world/` 是引擎与传输层。
模式包只声明"差异"，不复制 WebRTC、物理、命中、渲染这些内核——否则三种模式会各跑一套、
互相打架（2026-10-13 整目录拆两套的教训）。
