// docs/modes-template/index.js —— 【新玩法模板 · 游戏内容】（复制到 js/modes/<目录名>）
//
// 一个模式 = js/modes/ 下的一个文件夹（复制 docs/modes-template 整个目录到 js/modes/<目录名>）：
//   mode.json    名字 / 排序 / 主题色 / 默认地图   ← 大厅药丸与排序都读这里
//   index.js     本文件：玩法内容与函数
//   net.js       联机契约（组队 / 地面载具 / 同步字段）
//   maps.js      地图目录（+ maps/ 下的地形文件）
//   lobby.css    本模式的大厅皮肤
//
// 加完不用改任何 HTML / lobby.js / mode.js：
//   node server/serve.js        开发服务器每次请求清单都会重扫，刷新页面就能看到新药丸
//   node server/scan-modes.js   手动刷新清单（生成 js/modes.json）
//   node server/pack.js         打包时自动重扫
import * as THREE from 'three';

export const MODE = {
  // ── 大厅（名字/排序/默认地图在 mode.json；这里只放玩法自己的文案）──
  sides: [                    // 练习/联机开局前可选的阵营（side 序号必须从 0 连续）
    { side: 0, name: '🅰 阵营甲', desc: '一句话介绍\n（换行用 \\n）' },
    { side: 1, name: '🅱 阵营乙', desc: '一句话介绍' },
  ],
  sideLabel: (t) => (t === 1 ? '阵营乙' : '阵营甲'),   // 名单/战绩里的阵营名
  dropLabels: ['🅰 甲', '🅱 乙'],                        // 房主拖拽分配阵营时的两个投放框标题
  lobbyTitle: '你是主机 · 选择空域',                      // 联机选图大厅标题
  matchName: '你的玩法',                                   // 战绩/结算页里的玩法名

  // ── 游戏内容 ──
  planeLoadout: 'rocket',     // 飞行单位二号武器（同时决定 AI 对地武器）：'rocket' | 'he' | 'bomb'
  spawn: { airY: 280, airZ: 900 },   // 飞行单位出生高度 / 前后距离

  // ── 菜单 3D 展示（打开游戏第一眼看到的场景）──
  // props 支持：plane（跑道上的飞机，gear=true 带起落架）/ planeFly（空中悬停）/ aagun（防空车）
  // 模式自建模型：在 MODE 上加 menuProp(p, ctx) / menuCleanup()（见 heli 模式）
  menu: {
    world: 'flat',            // 展示用世界（模板自带 flat 地图）
    scene: 'yourmode',
    target: [0, 1.8, -6],     // 相机看向的点（决定取景，改完务必截图核对）
    yaw: 0, pitch: 0.4, dist: 28,
    zoomBase: 28,
    props: [
      { kind: 'plane', color: 0x3fa7ff, pos: [0, 1.3, -6], gear: true, player: true },
    ],
  },

  // ── 可选扩展点 ──
  // flight(f, dt, ctx)：自定义飞行物理（默认 plane.js 的 applyFlight；直升机在 heli.js 里实现）
  // flight(f, dt, ctx) { ... },

  // 练习编成：**必须实现**。ctx 由 match.js 提供：
  //   ctx.THREE / ctx.scene / ctx.side（玩家选的阵营）
  //   ctx.planes / ctx.aaguns（实体容器，直接写）
  //   ctx.buildPlane(color) / ctx.makeFighter(planeObj) / ctx.buildAAGun(color) / ctx.makeAAGun(group)
  //   ctx.Bot(planeObj) / ctx.AAGunBot(ent)   ← AI
  //   ctx.spawnPos(team, slot, ts) / ctx.aagunSpawnPos(slot, ctx.aaSpawns)   ← 出生点
  //   ctx.AAGUN_HP / ctx.color.{ally, foe}
  //   ctx.set.{myTeam, meIsAAGun, myPlane, me, myAAGun, meAAGun}（写入必须走 setter）
  //   ctx.myTeam / ctx.myPlane / ctx.myAAGun（实时 getter，setter 之后拿到新值）
  spawnPractice,
};

export function spawnPractice(ctx) {
  const { THREE, scene, side } = ctx;
  // 例：玩家开飞机打 AI 防空车
  ctx.set.myTeam(side); ctx.set.meIsAAGun(false);
  ctx.set.myPlane(ctx.buildPlane(ctx.color.ally)); scene.add(ctx.myPlane.group);
  ctx.set.me(ctx.makeFighter(ctx.myPlane));
  const ag = ctx.buildAAGun(ctx.color.foe); scene.add(ag.group);
  const ent = ctx.makeAAGun(ag);
  ctx.aaguns['bot'] = {
    id: 'bot', aagun: ag, ent, team: 1 - side, slot: 0,
    alive: true, hp: ctx.AAGUN_HP,
    tPos: new THREE.Vector3(), tTurretYaw: 0, tTurretPitch: 0,
    lastState: 0, isBot: true, bot: new ctx.AAGunBot(ent),
  };
  ctx.aaguns['bot'].aagun.group.position.copy(ctx.aagunSpawnPos(0, ctx.aaSpawns));
}
