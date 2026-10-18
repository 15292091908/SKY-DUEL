// js/modes/aavs/index.js —— 防空车突袭：**游戏内**专属内容（模式模块）
//
// 谁在用它：js/mode.js 按需动态加载（大厅切到本模式时才加载这个文件）。
// 放这里的 = 只有本模式才需要的东西：阵营卡片 / 大厅文案 / 模式名 / 可选地图集 / 默认地图 /
//   菜单 3D 展示参数（防空车停跑道 + 天上飞机悬停）。
// 模式包结构见 docs/modes.md（mode.json / net.js / maps.js / maps/ / lobby.css）。
export const MODE = {

  // ── 大厅 ──
  sides: [
    { side: 0, name: '✈ 飞机突袭', desc: '驾驶战机\n击爆敌方防空车' },
    { side: 1, name: '🛡 防空拦截', desc: '操控高炮车\n击败来袭战机' },
  ],
  sideLabel: (t) => (t === 1 ? '防空车' : '飞机'),
  lobbyTitle: '你是主机 · 选择突袭空域',
  matchName: '防空车突袭',
  helpKeys: ['plane', 'aagun'],

  // ── 游戏内容 ──
  // 本模式飞机对地攻击 + AI 都用高爆子弹，二号武器 = 高爆子弹
  planeLoadout: 'he',
  spawn: { airY: 240, airZ: 520 },   // 飞机出生高度 / 前后距离（本模式地图更紧凑，收紧到岛两侧近空）
  dropLabels: ['✈ 飞机', '🛡 防空车'],   // 房主拖拽分配阵营时的两个投放框标题

  // ── 菜单 3D 展示场景（防空车停跑道 + 天上飞机悬停）──
  menu: {
    world: 'base',
    scene: 'aavs',
    target: [0, 8.5, 0],         // 对准跑道上的防空车（曾因目标过高导致相机贴到天上飞机旁边）
    yaw: 0, pitch: 0.33, dist: 30,
    zoomBase: 30,
    props: [
      { kind: 'aagun', color: 0x3fa7ff, pos: [0, 0, 6], bodyYaw: Math.PI },
      { kind: 'planeFly', color: 0xff6b5e, pos: [0, 17, -34], rot: [0.14, Math.PI, 0] },
    ],
  },

  // 本模式的编成函数（由共用代码在开局时调用；新增玩法只需实现这一个）
  spawnPractice,
};

// 练习模式编成：side1 = 玩家开防空车（AI 飞机来打）；side0 = 玩家开飞机（AI 防空车在地面）
export function spawnPractice(ctx) {
  const { THREE, scene, side } = ctx;
  if (side === 1) {
    ctx.set.myTeam(1); ctx.set.meIsAAGun(true);
    ctx.set.myAAGun(ctx.buildAAGun(ctx.color.ally)); scene.add(ctx.myAAGun.group);
    ctx.set.meAAGun(ctx.makeAAGun(ctx.myAAGun));
    ctx.myAAGun.group.position.copy(ctx.aagunSpawnPos(0, ctx.aaSpawns));
    const fp = ctx.buildPlane(ctx.color.foe); scene.add(fp.group);
    const b = new ctx.Bot(fp); b.id = 'bot'; b.groundTarget = true;
    ctx.planes['bot'] = {
      id: 'bot', plane: fp, team: 0, slot: 0,
      alive: true, hp: 100, tPos: new THREE.Vector3(), tQuat: new THREE.Quaternion(),
      lastState: 0, isBot: true, bot: b
    };
  } else {
    ctx.set.myTeam(0); ctx.set.meIsAAGun(false);
    ctx.set.myPlane(ctx.buildPlane(ctx.color.ally)); scene.add(ctx.myPlane.group);
    ctx.set.me(ctx.makeFighter(ctx.myPlane));
    const ag = ctx.buildAAGun(ctx.color.foe); scene.add(ag.group);
    const ent = ctx.makeAAGun(ag);
    const ab = new ctx.AAGunBot(ent);
    ctx.aaguns['bot'] = {
      id: 'bot', aagun: ag, ent, team: 1, slot: 0,
      alive: true, hp: ctx.AAGUN_HP,
      // tBodyYaw 必填（v3.10.6）：缺字段会让远程同步分支算出 NaN → 车体旋转/出膛点全 NaN
      tPos: new THREE.Vector3(), tTurretYaw: 0, tTurretPitch: 0, tBodyYaw: 0,
      lastState: 0, isBot: true, bot: ab
    };
    ctx.aaguns['bot'].aagun.group.position.copy(ctx.aagunSpawnPos(0, ctx.aaSpawns));
  }
}
