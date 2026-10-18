// js/modes/air/index.js —— 空战对决：**游戏内**专属内容（模式模块）
//
// 谁在用它：js/mode.js 按需动态加载（大厅切到本模式时才加载这个文件）。
// 放这里的 = 只有本模式（或主要是本模式）才需要的东西：
//   阵营卡片 / 大厅文案 / 模式名 / 可选地图集 / 默认地图 / 菜单 3D 展示参数 / 玩法说明。
// 不放这里的 = 两种模式共用的引擎与载具内核（大厅、联机、渲染、循环、飞机/防空车物理与命中）——
//   防空车模式里玩家也能开飞机，两种载具在两种玩法里都真实存在，拆开会把同一套内核复制两份。
//
// 模式包结构（新增模式：复制 docs/modes-template/ 整个目录）：
//   mode.json  名字/排序/主题色/默认地图（由 server/scan-modes.js 扫描成 /js/modes.json）
//   index.js   本文件：玩法内容与函数
//   net.js     联机契约（组队/地面载具/同步字段）
//   maps.js + maps/  本模式的地图目录与地形文件
//   lobby.css  本模式的大厅皮肤（切到本模式时动态注入）
export const MODE = {

  // ── 大厅 ──
  sides: [                                  // 练习/联机的阵营卡片（side 序号 → 文案）
    { side: 0, name: '🔴 红队', desc: '南侧空域\n向北突进' },
    { side: 1, name: '🔵 蓝队', desc: '北侧空域\n向南压制' },
  ],
  sideLabel: (t) => (t === 1 ? '蓝队' : '红队'),   // 战绩表/名单里的阵营名
  lobbyTitle: '你是主机 · 选择空域',                 // 选图大厅标题
  matchName: '空战对决',                            // 战绩/结算页里的玩法名
  helpKeys: ['plane'],                              // 帮助面板里与本模式相关的段落

  // ── 游戏内容 ──
  // 本模式飞机的二号武器（同时决定 AI 的对地武器）：'rocket' = 机载火箭炮 / 'he' = 高爆子弹
  planeLoadout: 'rocket',
  spawn: { airY: 280, airZ: 900 },   // 飞机出生高度 / 前后距离（空战：高空对头）
  dropLabels: ['🔴 红队', '🔵 蓝队'],  // 房主拖拽分配阵营时的两个投放框标题

  // ── 菜单 3D 展示场景（飞机停在跑道）──
  menu: {
    world: 'base',
    scene: 'dogfight',
    target: [0, 1.8, -6],
    yaw: 0, pitch: 0.4, dist: 28,
    zoomBase: 28,
    props: [
      { kind: 'plane', color: 0x3fa7ff, pos: [0, 1.3, -6], gear: true, player: true },
    ],
  },

  // 本模式的编成函数（由共用代码在开局时调用；新增玩法只需实现这一个）
  spawnPractice,
};

// 练习模式编成：玩家飞机 vs 1 架 AI 飞机（阵营由选择决定，AI 站对面）
// ctx 由 match.js 提供（含实体工厂、容器、setter 与实时 getter）
export function spawnPractice(ctx) {
  const { THREE, scene, side } = ctx;
  ctx.set.myTeam(side === 1 ? 1 : 0);
  ctx.set.meIsAAGun(false);
  ctx.set.myPlane(ctx.buildPlane(ctx.color.ally)); scene.add(ctx.myPlane.group);
  ctx.set.me(ctx.makeFighter(ctx.myPlane));
  const fp = ctx.buildPlane(ctx.color.foe); scene.add(fp.group);
  const b = new ctx.Bot(fp); b.id = 'bot';
  ctx.planes['bot'] = {
    id: 'bot', plane: fp, team: 1 - ctx.myTeam, slot: 0,
    alive: true, hp: 100, tPos: new THREE.Vector3(), tQuat: new THREE.Quaternion(),
    lastState: 0, isBot: true, bot: b
  };
}
