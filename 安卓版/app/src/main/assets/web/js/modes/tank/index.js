// js/modes/tank/index.js —— 坦克对决（主战坦克 vs 主战坦克）· 乡村
//
// 玩法：与空战一致（歼灭五局三胜 / 死斗），双方都是地面坦克。
//   一号武器：尾翼稳定脱壳穿甲弹（APFSDS）—— 出膛后弹托分离、弹体继续飞。
//             v3.26 起**不再一击必杀**：按命中部位的装甲厚度判定击穿（见文件内「装甲结算」段），
//             击穿后 26~40 伤害；履带/发动机打断动力，弹药架殉爆并波及周围。
//   二号武器：燃烧弹 —— 直接伤害很低，但命中点会持续燃烧；火焰不扣血，
//             只让车体受热（装填变慢）并在观察窗前晃动时干扰瞄准。
//   地图：乡村（起伏地形、木屋、草垛、栅栏、麦田、稻草人）。木屋可被炮弹开洞 /
//         打中承重梁倒塌 / 被燃烧弹点燃烧塌；炮弹落地留下不会消失的弹坑。
import * as THREE from 'three';
import { scene, camera, effects, audio } from '../../core.js?v=1572';
import {
  STATE, me, myPlane, myAAGun, meAAGun, myTeam, myPeerId, planes, aaguns,
  aagunWeapon, zoom, mode, iAmHost, hostPeerId, myFireSeq, setMyFireSeq, setLastDmgFrom, world,
} from '../../state.js?v=1572';
import {
  hostSettleHit, applyMeAAGunDamage, peerDie, updateWeaponHud,
} from '../../combat.js?v=1572';
import { showPart, banner, setReticleVisible } from '../../hud.js?v=1572';
import { forwardOfTurret, forwardOfBody, updateWeakAAGun } from '../../aagun.js?v=1572';
import { buildTank, makeTank, buildScopeViewmodel, TANK, applyTankDamage, tankMobility } from '../../tank.js?v=1572';
import { TankBot } from './ai.js?v=1572';
import {
  MAP, PROPS, FIRES, CRATERS, farmGroundY, raycastProp, addCrater, addFireAt,
  igniteProp, carveHole, collapseHouse, breakProp, ramProps, tickFarm, resetFarm, flattenWheatAt, nearBeam,
} from './maps/farm.js?v=1572';
import { netBroadcast, netSendEventTo } from '../../netev.js?v=1572';

// ── 本模式参数 ──
/* 弹道全部按现实数值填（M829A2 级 120mm APFSDS）：
   · 弹芯 4.6 kg，炮口初速 1670 m/s → 炮口动能 6.42 MJ
   · 空气阻力用"2000m 存速 ≈1500 m/s"反推的有效阻力系数 k = 5.36e-5 /m：
       v(x) = v0 · exp(-k·x)   →   780m 处 1602 m/s（动能剩 92%）
     真实的杆式弹在 780m 内几乎不掉速 —— 这就是为什么"打一堵木墙就打不穿装甲"
     在物理上不成立：木头对动能弹的阻力小到可以忽略（见 PIERCE 的比能）。
   · 穿透木材按破碎比能 2 MJ/m³ × 弹芯扫过的体积算：一堵 0.13m 厚的木板墙
     只吃掉约 0.25 kJ（万分之四），穿三座木屋后仍然是一击必杀。
   · 因此跳弹只有两个真实成因：
       ① 着角 > 72°（长杆弹对均质钢的实测跳弹角，掠射才会跳）
       ② 动能低于"击穿 500mm 等效装甲"的门限：P = P0·(v/v0)^0.5，
          P0 = 700mm @1670m/s → 门限 852 m/s → 1.67 MJ。
          这张图上永远达不到（780m 时还有 5.9 MJ），所以实际不会出现，
          但机制保留 —— 换更大的地图或加厚装甲时它会自动生效。 */
export const DUEL = {
  apMass: 4.6,                // 弹芯质量（kg）
  apV0: 1670,                 // 炮口初速（m/s）
  apDragK: 5.36e-5,           // 有效空气阻力（1/m）：v(x)=v0·exp(-k·x)
  /* v3.26 装甲模型：穿深随存速衰减（长杆弹 P ∝ √动能），与部位装甲比较。
     420mm @1670m/s —— 780m 处约 403mm，足以打穿炮塔正面（330），
     但斜着打（着角放大有效装甲）或打更厚的角度就会跳弹。 */
  apPenP0: 420,               // 1670 m/s 时的穿深（mm RHA）
  ricochetAngle: 72 * Math.PI / 180,   // 跳弹角
  woodEnergy: 2.0e6,          // 木材破碎比能（J/m³）
  coreR: 0.011,               // 弹芯半径（m）
  apCrater: [3.8, 1.15],      // 穿甲弹落地的弹坑（半径 / 深度）
  heatCrater: [2.3, 0.55],
  shellStep: 5.5,             // 弹道子步长（m）
  heatRadius: 10,             // 多近算"被火烤到"
};

/* 炮口动能（穿深换算的基准）：P = P0 · √(ke/ke0) = P0 · v/v0 */
DUEL.apKe0 = 0.5 * DUEL.apMass * DUEL.apV0 * DUEL.apV0;
/* 击穿后的伤害区间（车体 100 点装甲 → 3 发左右击毁）与特殊部位伤害 */
DUEL.hitDmgMin = 26;
DUEL.hitDmgMax = 40;
DUEL.trackDmg = 18;          // 打断履带：伤害不高，但要命的是动不了
DUEL.engineDmg = 24;         // 打坏发动机：同上
DUEL.blastR = 22;            // 弹药架殉爆：波及半径（m）
DUEL.blastDmg = 62;          // 殉爆中心伤害（按距离衰减，边缘仍有 6 点）

/* 命中点到车体中心的水平法线 → 着角（0 = 垂直命中，90° = 掠射） */
function obliquity(pt, center, dir) {
  let nx = pt.x - center.x, nz = pt.z - center.z;
  const l = Math.hypot(nx, nz);
  if (l < 0.35) return 0;                    // 命中车顶/中心 → 按法向处理
  nx /= l; nz /= l;
  const dl = Math.hypot(dir.x, dir.z) || 1;
  const cos = Math.abs((dir.x / dl) * nx + (dir.z / dl) * nz);
  return Math.acos(Math.min(1, cos));
}

export const MODE = {
  sides: [
    { side: 0, name: '🔴 红队', desc: '南侧农道\n向北推进' },
    { side: 1, name: '🔵 蓝队', desc: '北侧林地\n向南防守' },
  ],
  sideLabel: (t) => (t === 1 ? '蓝队' : '红队'),
  dropLabels: ['🔴 红队', '🔵 蓝队'],
  lobbyTitle: '你是主机 · 选择乡村战区',
  matchName: '坦克对决',

  groundBoth: true,            // 双方都是地面载具
  /* v3.23 弹夹：坦克主炮 1 发（装填即"换弹"，由 apT/heatT 驱动，不额外计时），备弹无限 */
  magSize: 1,
  magReload: 0,
  groundHp: 100,
  groundHpLabel: '车体装甲',
  groundPitch: [TANK.groundPitchMin, TANK.groundPitchMax],
  groundPitchRest: 0.02,
  groundMove: { fwd: TANK.speedFwd, back: TANK.speedBack, turn: TANK.turnRate },
  groundBounds: 780,
  groundHpBarMax: 100,
  aiNoRocket: true,
  /* v3.26：取消"穿甲弹一击必杀"。改由部位装甲 + 损伤结算：
     · 房主看到 part='弹药箱' → 这一发致命才判死（殉爆），并调 ammoBlast 结算范围伤害
     · 履带 / 发动机 → 一炮击穿即瘫痪，由 dis 字段下发，受害端自己锁动力 */
  ammoBlow: true,
  ammoBlast,
  /* v3.30：装甲损伤 —— 只作用于坦克，空中四模式不读这些钩子 */
  groundDisable: applyTankDamage,
  groundMobility: tankMobility,
  /* v3.31：炮盾精确命中 → 固定扣 90 点装甲（不受 wd 的 1~40 夹紧影响） */
  partFixedDmg: { '炮盾': 90 },
  /* v3.32.1：击杀镜头文案（坦克不是高射机枪 / 不是"击落"） */
  killcamWeapon: tankKillWeapon,
  killVerb: '击毁',
  /* v3.32.1：死斗重生点避开残骸与活车（残骸是实心盒，重生在里面会卡住） */
  groundRespawnPos: freeGroundSpawn,

  buildGround: (color) => buildTank(color),
  makeGround: (t) => makeTank(t),
  groundCamera,
  fireGround,
  botFireGround,
  hud,
  zoomLabel: '观察窗',
  /* 切换武器的播报：只报弹种，不解释"备弹无限"这类规则（v3.22 精简 HUD 文案） */
  weaponSwitchText: (w) => (w === 'rocket' ? '切换：燃烧弹' : '切换：穿甲弹'),
  hideWeaponHud: () => !!zoom,

  menu: {
    world: 'farm',
    scene: 'tank',
    useTarget: true,
    target: [-128, 2.4, 86],
    yaw: 0.92, pitch: 0.18, dist: 27,
    zoomBase: 27,
    props: [
      { kind: 'tank', color: 0x3fa7ff, pos: [-136, 0, 96], yaw: 0.55 },
      { kind: 'tank', color: 0xff5340, pos: [-118, 0, 80], yaw: 2.25 },
    ],
  },

  menuProp,
  menuCleanup,
  tick: tickTank,
  roundReset,
  sessionEnd,
  netEvent,
  spawnPractice,
};

/* =====================================================================
   会话 / 回合状态
   ===================================================================== */
/* 原始键位提示：坦克模式会把它改成履带键位，退出模式要还原，
   否则切回空战会看到"W/S 前进后退"的坦克说明。 */
const ORIG_ZOOM_TIP = (typeof document !== 'undefined' && document.getElementById('zoomTip'))
  ? document.getElementById('zoomTip').innerHTML : '';

const SHELLS = [];
const SABOTS = [];
const TANK_FIRES = new Map();
let scopeG = null;
let seenEvt = new Set();
let eidN = 0;

function evtId() { return myPeerId + ':' + (++eidN); }
function sendEvt(ev) {
  ev.eid = evtId();
  seenEvt.add(ev.eid);
  if (seenEvt.size > 900) seenEvt = new Set();
  if (mode === 'practice') return;
  if (iAmHost) netBroadcast({ t: 'modeEvt', ...ev, from: myPeerId });
  else if (hostPeerId) netSendEventTo(hostPeerId, { t: 'modeEvt', ...ev, from: myPeerId, relay: 1 });
}
function propById(id) {
  for (let i = 0; i < PROPS.length; i++) if (PROPS[i].id === id) return PROPS[i];
  return null;
}
const _pt = new THREE.Vector3();

/* =====================================================================
   坦克残骸
   ---------------------------------------------------------------------
   车被打爆以后不再"直接消失"，而是原地留一具烧毁的车壳：
     · 视觉：整车 clone → 材质压暗到炭黑、炮塔歪掉、炮管下垂、上方持续冒烟
     · 碰撞：world.colliders 里放一个车体大小的 s=1 盒 —— 撞上去就停（撞不动）
     · 挡弹：不走 __prop，所以引擎的 segSolidT 会把它当实心障碍，炮弹打上去就炸
   存活到回合结束（歼灭）/ 整场结束（死斗）；死斗里每次重生再死会再留一具，
   最多同时 12 具，超出删最旧的。
   ===================================================================== */
const WRECKS = [];
const WRECK_MAX = 12;
const wrecked = new Set();
const BURNT = [
  new THREE.MeshStandardMaterial({ color: 0x1c1a17, metalness: 0.24, roughness: 0.90 }),
  new THREE.MeshStandardMaterial({ color: 0x2c2823, metalness: 0.32, roughness: 0.84 }),
  new THREE.MeshStandardMaterial({ color: 0x100f0d, metalness: 0.12, roughness: 0.96 }),
];
const _smokeGeo = new THREE.SphereGeometry(1.15, 7, 5);

function spawnWreck(id, model) {
  const src = model.group;
  src.visible = false;               // 残骸替代原车（peerDie 也会隐藏，双保险）
  const g = src.clone(true);
  g.position.copy(src.position);
  g.rotation.copy(src.rotation);
  g.visible = true;
  let k = 0;
  g.traverse((o) => {
    if (!o.isMesh) return;
    o.material = BURNT[k++ % 3];
    o.castShadow = true; o.receiveShadow = true;
  });
  // 炮塔歪掉 / 炮管下垂：一眼能看出是废车而不是待命的车
  const tu = g.getObjectByName('turret');
  if (tu) { tu.rotation.y += (Math.random() - 0.5) * 1.5; tu.rotation.z = 0.05 + Math.random() * 0.06; }
  const gu = g.getObjectByName('guns');
  if (gu) gu.rotation.x = -0.10 - Math.random() * 0.08;
  scene.add(g);

  const smoke = new THREE.Mesh(_smokeGeo, new THREE.MeshBasicMaterial({
    color: 0x24272b, transparent: true, opacity: 0.34, depthWrite: false,
  }));
  smoke.position.set(src.position.x, src.position.y + 3.6, src.position.z);
  scene.add(smoke);

  // 车体大小的实心盒：撞不动（法线由 collideTerrain 的 s=1 分支给出）
  const col = {
    s: 1, x: src.position.x, z: src.position.z,
    hx: 2.15, hz: 3.35, h: src.position.y + 3.05, __wreck: id,
  };
  if (world && world.colliders) world.colliders.push(col);

  WRECKS.push({ id, g, col, smoke, t: Math.random() * 4 });
  if (WRECKS.length > WRECK_MAX) {
    const w = WRECKS.shift();
    if (w.g.parent) w.g.parent.remove(w.g);
    if (w.smoke.parent) w.smoke.parent.remove(w.smoke);
    if (world && world.colliders) { const i = world.colliders.indexOf(w.col); if (i >= 0) world.colliders.splice(i, 1); }
  }
}

function updateWrecks(dt) {
  for (let i = 0; i < WRECKS.length; i++) {
    const w = WRECKS[i];
    w.t += dt;
    const ph = w.t % 5.5;
    w.smoke.position.y = w.col.h - 3.05 + 3.4 + ph * 1.5;
    w.smoke.scale.setScalar(0.8 + ph * 0.28);
    w.smoke.material.opacity = Math.max(0, 0.36 - ph * 0.062);
    w.smoke.position.x = w.g.position.x + Math.sin(w.t * 0.6) * 0.7;
    w.smoke.position.z = w.g.position.z + Math.cos(w.t * 0.5) * 0.7;
  }
}

/* 每帧比对 alive 状态：死了但还没留残骸 → 留一具 */
function checkWrecks() {
  if (meAAGun && myAAGun) {
    if (meAAGun.alive) wrecked.delete(myPeerId);
    else if (!wrecked.has(myPeerId)) { wrecked.add(myPeerId); spawnWreck(myPeerId, myAAGun); }
  }
  for (const id in aaguns) {
    const ag = aaguns[id];
    if (!ag || !ag.aagun) continue;
    if (ag.alive) { wrecked.delete(id); continue; }
    if (wrecked.has(id)) continue;
    wrecked.add(id);
    spawnWreck(id, ag.aagun);
  }
}

function clearWrecks() {
  for (const w of WRECKS) {
    if (w.g.parent) w.g.parent.remove(w.g);
    if (w.smoke.parent) w.smoke.parent.remove(w.smoke);
    if (world && world.colliders) { const i = world.colliders.indexOf(w.col); if (i >= 0) world.colliders.splice(i, 1); }
  }
  WRECKS.length = 0;
  wrecked.clear();
}

/* =====================================================================
   死斗重生点（v3.32.1）
   ---------------------------------------------------------------------
   旧版每次都选「离敌人最远」的那一个出生点 → 实际上每队永远回同一个坑。
   在出生点被击毁后，残骸是**实心盒**（colliders s:1），下一辆坦克复活在同一个
   坐标：模型穿进残骸里，collideTerrain 又把每一帧移动都回退 → 出生即卡死。
   这里保持"优先离敌人远"的策略，但跳过被残骸（10m）或活车（9m）占住的点；
   五个点全被占时沿 x 向外错开 12m 一档（最多 ±36m）。
   ===================================================================== */
function freeGroundSpawn(cur, team) {
  const list = ((world && world.aaSpawns) || []).filter((s) => s && (s.team === undefined || s.team === team));
  if (!list.length) return cur;
  const gy = (x, z) => ((world && world.groundY) ? world.groundY(x, z) : 0);
  const cands = list.map((s) => new THREE.Vector3(s.x, gy(s.x, s.z), s.z));
  const foeDist = (p) => {
    let best = Infinity;
    for (const id in aaguns) {
      const ag = aaguns[id];
      if (!ag || !ag.alive || ag.team === team || !ag.aagun) continue;
      const q = ag.aagun.group.position;
      best = Math.min(best, Math.hypot(q.x - p.x, q.z - p.z));
    }
    return best;
  };
  cands.sort((a, b) => foeDist(b) - foeDist(a));   // 离敌人远的优先（与原策略一致）
  const free = (p) => {
    for (const w of WRECKS) if (Math.hypot(w.g.position.x - p.x, w.g.position.z - p.z) < 10) return false;
    for (const id in aaguns) {
      const ag = aaguns[id];
      if (!ag || !ag.alive || !ag.aagun) continue;
      const q = ag.aagun.group.position;
      if (Math.hypot(q.x - p.x, q.z - p.z) < 9) return false;
    }
    /* 房主自己是"活车"时也要让开（远端重生时 meAAGun 不在 aaguns 里） */
    if (meAAGun && meAAGun.alive && myAAGun
      && Math.hypot(myAAGun.group.position.x - p.x, myAAGun.group.position.z - p.z) < 9) return false;
    return true;
  };
  for (const p of cands) if (free(p)) return p;
  const base = cands[0].clone();
  for (let k = 1; k <= 3; k++) {
    for (const s of [1, -1]) {
      const p = base.clone(); p.x += s * 12 * k; p.y = gy(p.x, p.z);
      if (free(p)) return p;
    }
  }
  return base;
}

/* 击杀镜头里的致命武器：AP 命中的 part 是部位名（车体/炮塔/履带…），
   燃烧弹与爆炸类有独立 part，按它们区分弹种。 */
function tankKillWeapon(killer, hit) {
  if (!hit) return '坦克炮';
  if (hit.part === '殉爆') return '弹药殉爆';
  if (hit.part === '爆炸') return '爆炸波及';
  if (hit.part === '燃烧弹') return '燃烧弹';
  return '穿甲弹';
}

/* =====================================================================
   炮弹
   ===================================================================== */
const AP_GEO = (() => {
  const g = new THREE.CylinderGeometry(0.045, 0.075, 1.45, 7);
  g.rotateX(Math.PI / 2);          // 沿 -Z
  return g;
})();
const HEAT_GEO = (() => {
  const g = new THREE.CylinderGeometry(0.10, 0.12, 0.9, 8);
  g.rotateX(Math.PI / 2);
  return g;
})();
const TRACER_GEO = new THREE.SphereGeometry(0.13, 6, 5);
const AP_MAT = new THREE.MeshStandardMaterial({ color: 0xc8ccd0, metalness: 0.75, roughness: 0.35, emissive: 0x221a0c, emissiveIntensity: 0.6 });
const HEAT_MAT = new THREE.MeshStandardMaterial({ color: 0xb4642a, metalness: 0.5, roughness: 0.5, emissive: 0x3a1400, emissiveIntensity: 0.9 });
const TRACER_MAT = new THREE.MeshBasicMaterial({ color: 0xffd27a });

function spawnShell(o, dir, kind, src, fid, visual, team) {
  const speed = kind === 'ap' ? TANK.apSpeed : TANK.heatSpeed;
  const g = new THREE.Group();
  const body = new THREE.Mesh(kind === 'ap' ? AP_GEO : HEAT_GEO, kind === 'ap' ? AP_MAT : HEAT_MAT);
  g.add(body);
  const tr = new THREE.Mesh(TRACER_GEO, TRACER_MAT);
  tr.position.z = 0.75;
  tr.scale.set(1, 1, 2.6);
  g.add(tr);
  g.position.copy(o);
  scene.add(g);
  const s = {
    pos: o.clone(), prev: o.clone(), vel: dir.clone().multiplyScalar(speed),
    dir: dir.clone(), kind, src, fid: fid || 0, visual: !!visual,
    t: 0, dist: 0, pierced: 0, mesh: g, ric: 0, team: (team === undefined ? myTeam : team),
    v0: speed,
    ke0: kind === 'ap' ? 0.5 * DUEL.apMass * speed * speed : 0.5 * 18 * speed * speed,
    ke: kind === 'ap' ? 0.5 * DUEL.apMass * speed * speed : 0.5 * 18 * speed * speed,
    life: kind === 'ap' ? TANK.apLife : TANK.heatLife,
  };
  SHELLS.push(s);
  return s;
}

function despawnShell(i) {
  const s = SHELLS[i];
  if (s.mesh && s.mesh.parent) s.mesh.parent.remove(s.mesh);
  SHELLS.splice(i, 1);
}

// 弹托分离：三片花瓣沿径向飞散（视觉件，1.2s 后消失）
const SABOT_GEO = new THREE.BoxGeometry(0.16, 0.03, 0.5);
const SABOT_MAT = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.45 });
function spawnSabots(o, dir) {
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir));
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(SABOT_GEO, SABOT_MAT);
    m.position.copy(o);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    scene.add(m);
    const a = (i / 3) * Math.PI * 2;
    const lat = right.clone().multiplyScalar(Math.cos(a)).addScaledVector(up, Math.sin(a));
    SABOTS.push({
      m, t: 0,
      v: dir.clone().multiplyScalar(140).addScaledVector(lat, 16).addScaledVector(up, 4),
      w: new THREE.Vector3((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 9),
    });
  }
}

/* 线段 vs 球：返回参数 t（0~1），无命中 -1 */
function segSphereT(p0, p1, cx, cy, cz, r) {
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  const fx = p0.x - cx, fy = p0.y - cy, fz = p0.z - cz;
  const a = dx * dx + dy * dy + dz * dz;
  if (a < 1e-9) return fx * fx + fy * fy + fz * fz <= r * r ? 0 : -1;
  const b = 2 * (fx * dx + fy * dy + fz * dz);
  const c = fx * fx + fy * fy + fz * fz - r * r;
  let disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  disc = Math.sqrt(disc);
  const t1 = (-b - disc) / (2 * a), t2 = (-b + disc) / (2 * a);
  if (t1 >= 0 && t1 <= 1) return t1;
  if (t2 >= 0 && t2 <= 1) return t2;
  return -1;
}

function segSolidT(p0, p1, c) {
  if (c.s === 0) return segSphereT(p0, p1, c.v.x, c.v.y, c.v.z, c.r);
  const yLo = c.s === 2 ? c.y0 : -1e6;
  const yHi = c.s === 2 ? c.y1 : c.h;
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  let tmin = 0, tmax = 1;
  const axes = [
    [p0.x, dx, c.x - c.hx, c.x + c.hx],
    [p0.y, dy, yLo, yHi],
    [p0.z, dz, c.z - c.hz, c.z + c.hz],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return -1; }
    else {
      let a = (lo - o) / d, b = (hi - o) / d;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > tmin) tmin = a;
      if (b < tmax) tmax = b;
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

/* 命中坦克：车体 + 炮塔两个球，取最近。
   shooterTeam = 开火方队伍：只考虑**不同队**的单位；skipMe 用于自己的炮弹不撞自己。 */
function tankHitT(p0, p1, shooterTeam, skipMe) {
  let best = null;
  const consider = (id, pos, unit, isMe) => {
    const t1 = segSphereT(p0, p1, pos.x, pos.y + 1.5, pos.z, 3.0);
    const t2 = segSphereT(p0, p1, pos.x, pos.y + 2.85, pos.z, 1.95);
    const t = (t1 < 0) ? t2 : (t2 < 0 ? t1 : Math.min(t1, t2));
    if (t < 0) return;
    if (best && t >= best.t) return;
    /* 部位判定（v3.26）：取弹道上**最先命中**的那个部位球。
       ★ 不能按数组顺序取第一个"被穿过的"球：正面打炮塔时弹道也会穿过尾舱的弹药箱球，
         按顺序会把每一次正面命中都判成殉爆。取最小 t 才是物理上的"先打到谁"。 */
    let part = null, partT = Infinity;
    const wps = unit && unit.aagun && unit.aagun.weakPoints;
    if (wps && wps.length) {
      updateWeakAAGun(unit);
      for (const wp of wps) {
        if (wp.fallback) continue;          // 车体只做兜底，不参与"最近命中"竞争
        const tt = segSphereT(p0, p1, wp._w.x, wp._w.y, wp._w.z, wp.r);
        if (tt >= 0 && tt < partT) { partT = tt; part = wp; }
      }
    }
    best = { t, id, pos, unit, isMe, part };
  };
  if (!skipMe && meAAGun && meAAGun.alive && myTeam !== shooterTeam) consider(myPeerId, myAAGun.group.position, meAAGun, true);
  for (const id in aaguns) {
    const ag = aaguns[id];
    if (!ag.alive || ag.team === shooterTeam) continue;
    consider(id, ag.aagun.group.position, ag.ent, false);
  }
  return best;
}

/* 开火：单管，弹道沿炮塔指向 */
const _dir = new THREE.Vector3(), _o = new THREE.Vector3(), _bodyV = new THREE.Vector3();
function fireShell(ent, kind, ctx, src, team) {
  const sideTeam = (team === undefined) ? myTeam : team;
  const model = ent.aagun;
  model.group.updateMatrixWorld(true);
  _o.copy(model.gunMuzzles[0]).applyMatrix4(model.guns.matrixWorld);
  forwardOfTurret(ent, _dir);
  _o.addScaledVector(_dir, 0.4);

  // 载具速度叠加（坦克 14 m/s，对 1250 m/s 影响很小，但物理上应该带）
  _bodyV.set(0, 0, 0);
  if (Math.abs(ent.speed) > 0.05) forwardOfBody(ent, _bodyV).multiplyScalar(ent.speed);

  let fid = 0;
  if (mode !== 'practice') {
    fid = (myFireSeq || 0) + 1;
    setMyFireSeq(fid);
  }
  const s = spawnShell(_o, _dir, kind, src || 'me', fid, false, sideTeam);
  s.vel.add(_bodyV);

  // 后坐：炮组向后一顶，tick 里回弹
  model.guns.position.z = 0.42;
  effects.muzzle(_o, kind === 'ap' ? 2.4 : 1.8);
  effects.shake(kind === 'ap' ? 0.24 : 0.18);
  /* v3.28：炮声按音速传播 —— 自己的车立即响，别人的车按距离延迟（343 m/s）。
     炮口火光（effects.muzzle）仍是光速，只有声音会晚到。 */
  if ((src || 'me') === 'me') {
    audio.shoot();
    audio.explosionAt(_o);
  } else {
    const _ear = myAAGun ? myAAGun.group.position : _o;
    const _p0 = _o.clone();
    const _dly = Math.min(2600, _o.distanceTo(_ear) / 343 * 1000);
    setTimeout(() => { audio.shoot(); audio.explosionAt(_p0); }, _dly);
  }

  if (kind === 'ap') spawnSabots(_o, _dir);
  if (mode !== 'practice' && (src || 'me') === 'me') {
    sendEvt({ k: 'shot', o: _o.toArray(), d: _dir.toArray(), kind, fid });
  }
  return s;
}

/* =====================================================================
   装甲结算（v3.26）
   ---------------------------------------------------------------------
   穿深 P = P0 · √(ke/ke0)（长杆弹 P ∝ √动能 → 780m 仍有 403mm）
   有效装甲 = armor / cos(着角)（掠射时急剧变厚）
       P ≥ 有效装甲 → 击穿：26~40 伤害（富余越多伤害越高）
         履带 / 发动机 → 较低伤害，不再锁死移动
         弹药箱 → 只有这一发会清空血量时才殉爆（v3.29）
       P < 有效装甲 → 未击穿：只有火星，不掉血
   着角 > 72° 直接跳弹（长杆弹的掠射极限）。
   ===================================================================== */
const _blastC = new THREE.Vector3();

/* 弹药架殉爆：中心大爆炸 + 半径 22m 的衰减伤害。
   只在房主 / 练习本地结算（客户端只负责在命中时上报 part='弹药箱'）。 */
export function ammoBlast(posArr, shooterId, excludeId) {
  const c = _blastC.fromArray(posArr || [0, 0, 0]);
  effects.explosion(c, 4.4);
  effects.explosion(c, 2.4);
  audio.explosionAt(c);
  effects.shake(1.1);
  if (mode !== 'practice') sendEvt({ k: 'ammoBlow', p: [c.x, c.y, c.z] });

  const R = DUEL.blastR;
  const hits = [];
  if (meAAGun && meAAGun.alive && myPeerId !== excludeId) {
    hits.push({ id: myPeerId, pos: myAAGun.group.position, me: true, ent: meAAGun });
  }
  for (const id in aaguns) {
    const ag = aaguns[id];
    if (ag.alive && id !== excludeId) hits.push({ id, pos: ag.aagun.group.position, me: false, ent: ag.ent });
  }
  for (const it of hits) {
    const d = it.pos.distanceTo(c);
    if (d > R) continue;
    /* 距离衰减：中心 62、8m ≈ 40、14m ≈ 22、边缘 6 —— 停在旁边的车会被一起带走 */
    const dmg = Math.max(6, Math.round(DUEL.blastDmg * Math.pow(1 - d / R, 1.2)));
    if (mode === 'practice') {
      setLastDmgFrom(shooterId || null);
      if (it.me) applyMeAAGunDamage(dmg);
      else { it.ent.hp = Math.max(0, it.ent.hp - dmg); if (it.ent.hp <= 0) peerDie(it.id); }
      setLastDmgFrom(null);
    } else if (iAmHost) {
      hostSettleHit(shooterId || null, it.id, '殉爆', true, dmg, [it.pos.x, it.pos.y + 1.6, it.pos.z], 0, 1);
    }
  }
}

function disName(code) {
  if (code === 'trackL') return '左履带断裂 · 无法左转';
  if (code === 'trackR') return '右履带断裂 · 无法右转';
  if (code === 'engine') return '发动机损毁 · 无法移动';
  if (code === 'turretJam') return '炮塔卡死 · 无法旋转';
  return '';
}

function hitTankWithShell(s, hit) {
  const posArr = [hit.pos.x, hit.pos.y + 1.6, hit.pos.z];
  /* 命中部位（v3.26）：部位决定装甲厚度与特殊效果，不再有"命中即击毁"。 */
  const part = hit.part || null;
  const partName = part ? part.name : '车体';
  const armor = (part && part.armor) || 260;
  const effect = part ? part.effect : null;

  if (s.kind === 'ap') {
    const obl = obliquity(s.pos, hit.pos, s.vel);
    const eff = armor / Math.max(0.32, Math.cos(obl));      // 72° 时 cos≈0.31，夹一下避免爆炸
    const pen = DUEL.apPenP0 * Math.sqrt(Math.max(0, s.ke) / DUEL.apKe0);
    let why = '';
    if (obl > DUEL.ricochetAngle) why = '跳弹';
    else if (pen < eff) why = '未击穿 · ' + partName;
    if (why) {
      effects.sparks(s.pos, 0xffd9a0);
      effects.sparks(s.pos, 0xffffff);
      audio.hitConfirm();
      if (s.src === 'me') showPart(why);
      s.ric = 1;
      s.vel.set(-s.vel.x * 0.25, Math.abs(s.vel.y) * 0.35 + 90, -s.vel.z * 0.25);
      s.life = 0.45;
      return;
    }

    /* 伤害：炮盾精确命中固定扣 90 点；履带/发动机伤害较低，但**一炮击穿就瘫痪**（v3.30）。
       弹药箱只有这一发会把血打空时才殉爆。 */
    const _track = (effect === 'trackL' || effect === 'trackR');
    let dmg;
    if (effect === 'turretJam') dmg = 90;
    else if (_track) dmg = DUEL.trackDmg;
    else if (effect === 'engine') dmg = DUEL.engineDmg;
    else dmg = Math.round(DUEL.hitDmgMin + (DUEL.hitDmgMax - DUEL.hitDmgMin) * Math.min(1, (pen - eff) / 120));

    if (s.src === 'me') showPart('命中 ' + partName);
    effects.explosion(s.pos, 2.1);
    audio.explosionAt(s.pos);

    if (mode === 'practice') {
      const shooter = s.src === 'bot' ? 'bot' : myPeerId;
      if (hit.isMe) {
        setLastDmgFrom(shooter);
        /* v3.30：弹药箱只有致命那一发才殉爆；履带/发动机一炮击穿就瘫痪 */
        const _ammoBlow = effect === 'ammo' && meAAGun.hp - dmg <= 0;
        showPart(_ammoBlow ? '受到爆炸伤害' : '被击中 ' + partName);
        applyMeAAGunDamage(_ammoBlow ? 9999 : dmg);
        if (!_ammoBlow && meAAGun.alive) {
          applyTankDamage(meAAGun, effect);
          const _dn = disName(effect);
          if (_dn) { showPart(_dn); updateWeaponHud(); }
        }
        setLastDmgFrom(null);
        if (_ammoBlow) ammoBlast(posArr, shooter, myPeerId);
      } else {
        /* ★ 血量记在 aaguns[id].hp（引擎的权威字段，HUD/回合结束都读它），
           ent.hp 只是模型实体的副本 —— 旧版只改 ent.hp，界面上的血条不会掉。 */
        const ag = aaguns[hit.id];
        if (ag) {
          const _ammoBlow = effect === 'ammo' && ag.hp - dmg <= 0;
          setLastDmgFrom(myPeerId);
          ag.hp = _ammoBlow ? 0 : Math.max(0, ag.hp - dmg);
          if (ag.ent) ag.ent.hp = ag.hp;
          if (ag.hp <= 0) peerDie(hit.id);
          else if (ag.ent) applyTankDamage(ag.ent, effect);   // AI 车同样一炮瘫痪
          setLastDmgFrom(null);
          if (_ammoBlow) ammoBlast(posArr, myPeerId, hit.id);
        }
      }
    } else if (iAmHost) {
      hostSettleHit(s.src === 'bot' ? 'bot' : myPeerId, hit.id, partName, false, 0, posArr, s.fid, 1, dmg, effect || '');
    } else if (s.src === 'me') {
      netSendEventTo(hostPeerId, {
        t: 'hitRep', fid: s.fid, id: hit.id, part: partName, dmg: 0, p: posArr,
        wd: dmg, dis: effect || '',
      });
    }
    return;
  }

  // 燃烧弹：固定直伤（不再按部位倍率）+ 在车体上挂一团持续火
  const heatDmg = TANK.heatDmg;
  if (s.src === 'me') showPart('命中 ' + partName);
  effects.explosion(s.pos, 1.1);
  audio.explosionAt(s.pos);
  if (mode === 'practice') {
    if (hit.isMe) {
      setLastDmgFrom(s.src === 'bot' ? 'bot' : myPeerId);
      applyMeAAGunDamage(heatDmg);
      setLastDmgFrom(null);
    } else {
      setLastDmgFrom(myPeerId);
      const ag = aaguns[hit.id];
      if (ag) {
        ag.hp = Math.max(0, ag.hp - heatDmg);
        if (ag.ent) ag.ent.hp = ag.hp;
        if (ag.hp <= 0) peerDie(hit.id);
      }
      setLastDmgFrom(null);
    }
  } else if (iAmHost) {
    hostSettleHit(s.src === 'bot' ? 'bot' : myPeerId, hit.id, '燃烧弹', false, 0, posArr, s.fid, 1, heatDmg);
  } else if (s.src === 'me') {
    netSendEventTo(hostPeerId, { t: 'hitRep', fid: s.fid, id: hit.id, part: '燃烧弹', dmg: 0, p: posArr, wd: heatDmg });
  }
  attachTankFire(hit.id, hit.unit, hit.pos);
  if (mode !== 'practice') sendEvt({ k: 'tankFire', id: hit.id, p: posArr, life: TANK.heatFireT });
}

/* 坦克身上的持续火（跟着车走） */
function attachTankFire(id, ent, pos) {
  const old = TANK_FIRES.get(id);
  if (old) { old.t = 0; old.max = TANK.heatFireT; ent.burning = TANK.heatFireT; return; }
  const g = new THREE.Group();
  const mats = [];
  for (let i = 0; i < 2; i++) {
    const mat = new THREE.MeshBasicMaterial({ color: i ? 0xff8a2a : 0xffc247, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(new THREE.ConeGeometry(0.7 - i * 0.16, 1.9 + i * 0.6, 6, 1, false), mat);
    m.position.set((i ? 0.5 : -0.35), 2.1 + i * 0.7, 0.4);
    g.add(m); mats.push(m);
  }
  const smoke = new THREE.Mesh(new THREE.SphereGeometry(1.1, 7, 5),
    new THREE.MeshBasicMaterial({ color: 0x1e2226, transparent: true, opacity: 0.3, depthWrite: false }));
  smoke.position.set(0, 3.4, 0.4); g.add(smoke);
  g.position.copy(pos);
  scene.add(g);
  TANK_FIRES.set(id, { g, ent, t: 0, max: TANK.heatFireT, mats, smoke });
  if (ent) ent.burning = TANK.heatFireT;
}
function updateTankFires(dt) {
  for (const [id, f] of TANK_FIRES) {
    f.t += dt;
    if (f.ent) {
      f.ent.burning = Math.max(0, f.max - f.t);
      if (f.ent.aagun) f.g.position.copy(f.ent.aagun.group.position);
    }
    const s = 0.82 + 0.24 * Math.sin(f.t * 11 + (id || '').length);
    for (let i = 0; i < f.mats.length; i++) {
      f.mats[i].scale.set(s, 0.9 + 0.3 * s, s);
      f.mats[i].opacity = 0.42 + 0.2 * s;
    }
    if (f.smoke) {
      f.smoke.position.y += dt * 1.6;
      if (f.smoke.position.y > 7) f.smoke.position.y = 3.4;
    }
    if (f.t > f.max) {
      if (f.g.parent) f.g.parent.remove(f.g);
      TANK_FIRES.delete(id);
    }
  }
}
/* v3.28.4：回合重置必须**把火从场景里摘掉**。
   旧版 roundReset/sessionEnd 只写 TANK_FIRES.clear() —— Map 空了，但每个火苗 Group
   还挂在 scene 上（且不再被 updateTankFires 驱动），于是地图上永久留着几簇不会灭的火。
   这里连带释放几何/材质，避免每局重开累积显存。 */
function clearTankFires() {
  for (const [, f] of TANK_FIRES) {
    if (f.g) {
      if (f.g.parent) f.g.parent.remove(f.g);
      f.g.traverse((o) => {
        if (!o.isMesh) return;
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material.dispose) o.material.dispose();
      });
    }
  }
  TANK_FIRES.clear();
}

/* =====================================================================
   弹道推进
   ===================================================================== */
function updateShells(dt) {
  for (let i = SHELLS.length - 1; i >= 0; i--) {
    const s = SHELLS[i];
    s.t += dt;
    if (s.t > s.life) { explodeShell(s, null); despawnShell(i); continue; }

    const speed = s.vel.length();
    const move = speed * dt;
    const n = Math.min(14, Math.max(1, Math.ceil(move / DUEL.shellStep)));
    const h = dt / n;
    let dead = false;
    for (let k = 0; k < n; k++) {
      s.prev.copy(s.pos);
      const sp0 = s.vel.length();
      s.pos.addScaledVector(s.vel, h);
      s.vel.y -= 9.8 * h;
      const segLen = s.prev.distanceTo(s.pos);
      s.dist += segLen;
      /* 空气阻力：按本步走过的距离衰减 v（v(x)=v0·exp(-k·x)）。
         AP 弹用真实系数；燃烧弹按弹体形状给一个粗估（k 取 3 倍）。 */
      const dk = s.kind === 'ap' ? DUEL.apDragK : DUEL.apDragK * 3;
      const decay = Math.exp(-dk * segLen);
      s.vel.multiplyScalar(decay);
      if (s.kind === 'ap') s.ke = 0.5 * DUEL.apMass * s.vel.lengthSq();
      else s.ke = 0.5 * 18 * s.vel.lengthSq();

      if (s.visual) {
        // 远端只做视觉：撞地就消失
        const gy = farmGroundY(s.pos.x, s.pos.z);
        if (s.pos.y <= gy) {
          effects.explosion(new THREE.Vector3(s.pos.x, gy + 0.4, s.pos.z), s.kind === 'ap' ? 0.9 : 0.7);
          dead = true; break;
        }
        continue;
      }

      // 近战坦克（先算，和墙体比距离）
      const tank = tankHitT(s.prev, s.pos, s.team, s.src === 'me');
      const prop = raycastProp(s.prev, s.pos);
      let solidT = -1;
      const cols = (world && world.colliders) || [];
      for (let c = 0; c < cols.length; c++) {
        const cc = cols[c];
        if (cc.__prop) continue;                 // 可破坏物由 raycastProp 处理
        const t = segSolidT(s.prev, s.pos, cc);
        if (t < 0) continue;
        if (solidT < 0 || t < solidT) solidT = t;
      }
      const groundY = farmGroundY(s.pos.x, s.pos.z);
      const groundHit = s.pos.y <= groundY;

      // 取最近的一个
      let bestT = 2, what = null;
      if (tank && tank.t < bestT) { bestT = tank.t; what = 'tank'; }
      if (prop && prop.t < bestT) { bestT = prop.t; what = 'prop'; }
      if (solidT >= 0 && solidT < bestT) { bestT = solidT; what = 'solid'; }
      if (groundHit) { bestT = 1; what = 'ground'; }

      if (!what) continue;

      const pt = new THREE.Vector3().lerpVectors(s.prev, s.pos, Math.min(1, bestT));
      s.pos.copy(pt);

      if (typeof window !== 'undefined' && window.__shellLog) {
        window.__shellLog.push({ what, x: +pt.x.toFixed(1), y: +pt.y.toFixed(1), z: +pt.z.toFixed(1), ke: Math.round(s.ke / 1000) });
      }
      if (what === 'tank') {
        hitTankWithShell(s, tank);
        if (s.ric) { /* 跳弹后继飞 */ }
        else dead = true;
      } else if (what === 'prop') {
        const stop = handlePropHit(s, prop, pt);
        if (stop || s.kind !== 'ap') { dead = true; }
        else {
          /* 穿甲弹穿透木质物：继续飞，动能按"破碎功"扣减。
             体积 = 弹芯截面 × 穿透厚度（斜穿按段长放大），木材比能 2 MJ/m³。
             一堵 0.13m 厚的墙只吃掉约 0.25 kJ —— 万分之四，符合现实。 */
          const q = prop.partHit || null;
          const thick = q ? (q.hx < q.hz ? q.hx : q.hz) * 2 : 0.3;
          const cosA = Math.max(0.25, Math.abs(s.vel.clone().normalize().dot(s.dir)));
          const vol = Math.PI * DUEL.coreR * DUEL.coreR * (thick / cosA);
          s.ke = Math.max(0, s.ke - DUEL.woodEnergy * vol);
          const vNew = Math.sqrt(2 * s.ke / DUEL.apMass);
          if (vNew > 1) s.vel.setLength(vNew);
          s.pierced++;
          s.pos.addScaledVector(s.dir, 0.32);
        }
      } else if (what === 'solid') {
        explodeShell(s, pt);
        dead = true;
      } else {
        impactGround(s, pt);
        dead = true;
      }
      if (dead) break;
    }

    // 更新视觉
    if (!dead && s.mesh) {
      s.mesh.position.copy(s.pos);
      const v = s.vel;
      const len = v.length() || 1;
      s.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _dir.copy(v).divideScalar(len));
    }
    if (dead) despawnShell(i);
  }
}

function explodeShell(s, pt) {
  if (!pt) return;
  effects.explosion(pt, s.kind === 'ap' ? 1.0 : 0.8);
  audio.explosionAt(pt);
  if (mode !== 'practice') sendEvt({ k: 'fx', x: pt.x, y: pt.y, z: pt.z, s: s.kind === 'ap' ? 1.0 : 0.8 });
}

function impactGround(s, pt) {
  const gy = farmGroundY(pt.x, pt.z);
  const c = s.kind === 'ap' ? DUEL.apCrater : DUEL.heatCrater;
  addCrater(pt.x, pt.z, c[0], c[1]);
  flattenWheatAt(pt.x, pt.z, c[0] * 1.4);
  if (s.kind !== 'ap') {
    // 燃烧弹：命中位置持续燃烧（火本身不扣血，只烤车）
    const fy = gy + 0.35;
    addFireAt(pt.x, fy, pt.z, 1.8, 'ground', TANK.heatFireT);
    if (mode !== 'practice') sendEvt({ k: 'fire', x: pt.x, y: fy, z: pt.z, r: 1.8 });
  }
  effects.explosion(new THREE.Vector3(pt.x, gy + 0.5, pt.z), s.kind === 'ap' ? 1.5 : 1.1);
  effects.sparks(new THREE.Vector3(pt.x, gy + 0.6, pt.z), 0xb99a6a);
  audio.explosionAt(pt);
  if (mode !== 'practice') {
    sendEvt({ k: 'crater', x: pt.x, z: pt.z, r: c[0], d: c[1], fx: s.kind });
  }
}

/* 命中可破坏物：AP 开洞（继续飞）/ 打梁倒塌；燃烧弹点燃。
   返回值：true = 这颗炮弹到此为止（瓦砾堆挡住）。 */
function handlePropHit(s, hit, pt) {
  const prop = hit.prop;
  if (!prop) return true;
  /* 倒塌后的瓦砾堆：是实体障碍，炮弹打上去就停（AP 也停）。不弹提示 —— 命中反馈靠爆炸特效。 */
  if (prop.dead) {
    if (s.kind === 'ap') {
      effects.sparks(pt, 0xb9a888);
      effects.explosion(pt, 0.9);
      audio.explosionAt(pt);
      if (mode !== 'practice') sendEvt({ k: 'fx', x: pt.x, y: pt.y, z: pt.z, s: 0.9 });
    } else {
      impactGround(s, pt);
    }
    return true;
  }
  const kind = s.kind;
  if (kind === 'heat') {
    igniteProp(prop, pt);
    if (mode !== 'practice') sendEvt({ k: 'ignite', id: prop.id, p: pt.toArray() });
    return false;
  }
  // AP
  if (prop.type === 'house') {
    if (hit.part.kind === 'beam' || nearBeam(prop, pt)) {
      collapseHouse(prop, pt);
      prop.__announced = true;
      if (mode !== 'practice') sendEvt({ k: 'collapse', id: prop.id, p: pt.toArray() });
    } else if (hit.part.kind === 'furniture') {
      carveHole(prop, pt, 1.1);
      if (mode !== 'practice') sendEvt({ k: 'propHit', id: prop.id, p: pt.toArray(), shell: 'ap' });
    } else {
      carveHole(prop, pt, 1.7);
      if (mode !== 'practice') sendEvt({ k: 'propHit', id: prop.id, p: pt.toArray(), shell: 'ap' });
    }
    if (prop.dead) {
      prop.__announced = true;
      if (mode !== 'practice') sendEvt({ k: 'collapse', id: prop.id, p: pt.toArray() });
    }
  } else {
    /* 草垛/栅栏：木头很薄，AP 穿过去继续飞（只掉一点动能）。 */
    const wasDead = prop.dead;
    breakProp(prop, pt, 1.0);
    prop.partHit = hit.part;
    if (!wasDead) {
      if (mode !== 'practice') sendEvt({ k: 'break', id: prop.id, p: pt.toArray() });
    }
  }
  return false;
}

/* =====================================================================
   输入：开火 / 装填 / 受热
   ===================================================================== */
export function fireGround(ent, weapon, ctx) {
  if (!ent || !ent.alive || STATE.roundOver) return;
  const heatK = 1 + TANK.heatReloadPenalty * (ent.heat || 0);
  if (weapon === 'rocket') {
    if (ent.heatT > 0) { ctx.setFireT(0.12); return; }
    ent.heatT = TANK.heatReload * heatK;
    fireShell(ent, 'heat', ctx);
    ctx.setFireT(0.16);
  } else {
    if (ent.apT > 0) { ctx.setFireT(0.12); return; }
    ent.apT = TANK.apReload * heatK;
    fireShell(ent, 'ap', ctx);
    ctx.setFireT(0.16);
  }
  if (ctx.updateWeaponHud) ctx.updateWeaponHud();
  else updateWeaponHud();
}

/* AI 开火：由 loop 的 AI 地面武器钩子调用；返回 true = 本帧已开火 */
export function botFireGround(ag, target, ent) {
  if (!ag || !ent || !ent.alive) return true;   // 消费回调：坦克没有机炮，不能掉到 fireGunAAGun
  if (STATE.roundOver) return true;
  // AI 交替使用穿甲弹和燃烧弹：远距离穿甲，近距离先烧一发再补穿甲
  const dist = target && target.plane ? ent.aagun.group.position.distanceTo(target.plane.group.position) : 9999;
  if (dist > 760) return true;
  const useHeat = ent.heatT <= 0 && dist < 300 && Math.random() < 0.35;
  if (useHeat) {
    ent.heatT = TANK.heatReload * (1 + TANK.heatReloadPenalty * (ent.heat || 0));
    fireShell(ent, 'heat', {}, 'bot', ag.team);
    return true;
  }
  if (ent.apT > 0) return true;
  ent.apT = TANK.apReload * (1 + TANK.heatReloadPenalty * (ent.heat || 0));
  fireShell(ent, 'ap', {}, 'bot', ag.team);
  return true;
}

/* 受热：距离火焰越近上升越快；离开后缓慢冷却。燃烧不扣血 —— 只影响装填与瞄准。 */
function updateHeat(ent, dt) {
  if (!ent || !ent.alive) { if (ent) ent.heat = Math.max(0, ent.heat - dt); return; }
  const p = ent.aagun.group.position;
  let want = 0;
  const fwdX = -Math.sin(ent.turretYaw || 0), fwdZ = -Math.cos(ent.turretYaw || 0);
  for (let i = 0; i < FIRES.length; i++) {
    const f = FIRES[i];
    const R = DUEL.heatRadius + f.r * 1.8;
    const dx = f.x - p.x, dz = f.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < R) {
      want = Math.max(want, 1 - d / R);
      // 火在炮口正前方（观察窗方向）→ 额外的瞄准干扰
      if (d < R * 0.9 && (dx * fwdX + dz * fwdZ) / Math.max(1, d) > 0.25) {
        ent.heatFront = Math.max(ent.heatFront || 0, 1 - d / R);
      }
    }
  }
  ent.heatFront = Math.max(0, (ent.heatFront || 0) - dt * 0.5);
  if (ent.burning > 0) { want = 1; ent.heatFront = 1; }
  const k = want > ent.heat ? TANK.heatRise : -TANK.heatCool;
  ent.heat = THREE.MathUtils.clamp(ent.heat + k * dt, 0, 1);
  return want;
}

/* =====================================================================
   每帧
   ===================================================================== */
const _slopeF = new THREE.Vector3();
function applySlope(ent) {
  const g = ent.aagun.group;
  const p = g.position;
  const yaw = ent.bodyYaw || 0;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const yF = farmGroundY(p.x + fx * 2.4, p.z + fz * 2.4);
  const yB = farmGroundY(p.x - fx * 2.4, p.z - fz * 2.4);
  const yR = farmGroundY(p.x - fz * 2.0, p.z + fx * 2.0);
  const yL = farmGroundY(p.x + fz * 2.0, p.z - fx * 2.0);
  g.rotation.x = THREE.MathUtils.clamp(Math.atan2(yF - yB, 4.8), -0.22, 0.22);
  g.rotation.z = THREE.MathUtils.clamp(Math.atan2(yR - yL, 4.0), -0.22, 0.22);
}

let farmHeatT = 0;
export function tickTank(dt) {
  const now = performance.now() / 1000;

  // 装填 / 后坐回弹 / 受热
  const ents = [];
  if (meAAGun) ents.push(meAAGun);
  for (const id in aaguns) if (aaguns[id].ent) ents.push(aaguns[id].ent);
  for (const ent of ents) {
    ent.apT = Math.max(0, (ent.apT || 0) - dt);
    ent.heatT = Math.max(0, (ent.heatT || 0) - dt);
    ent.burning = Math.max(0, (ent.burning || 0) - dt);
    if (ent.aagun && ent.aagun.guns && ent.aagun.guns.position.z !== 0) {
      ent.aagun.guns.position.z *= Math.max(0, 1 - dt * 7);
      if (Math.abs(ent.aagun.guns.position.z) < 0.01) ent.aagun.guns.position.z = 0;
    }
    updateHeat(ent, dt);
    /* v3.30：履带 / 发动机被打瘫 → 迅速停车（保留一点滑行惯性，不做瞬停） */
    if (ent.immobilized) {
      ent.targetSpeed = 0;
      ent.speed *= Math.max(0, 1 - dt * 6);
      if (Math.abs(ent.speed) < 0.05) ent.speed = 0;
    }
    if (ent.aagun) {
      applySlope(ent);
      // 贴地（AI / 远端也要贴：host 的插值位置可能带旧的 y）。
      // -0.16：履带底距模型原点 0.15m，不减这一下整车会浮在地面上。
      const p = ent.aagun.group.position;
      p.y = farmGroundY(p.x, p.z) - 0.16;
    }
  }

  // 玩家在火里：观察窗被烤 → 瞄准轻微晃动（是"偏移量"不是累积，松手不会漂走）
  if (meAAGun && meAAGun.alive && meAAGun.heatFront > 0.18 && !meAAGun.turretJammed) {
    const k = TANK.heatAimJitter * meAAGun.heatFront * meAAGun.heat * (zoom ? 1.15 : 0.4);
    const jy = Math.sin(now * 9.3) * k + Math.sin(now * 21.7) * k * 0.35;
    const jp = Math.sin(now * 13.1 + 1.2) * k * 0.8;
    meAAGun.turretYaw += jy - (meAAGun.__jy || 0);
    meAAGun.turretPitch = THREE.MathUtils.clamp(
      meAAGun.turretPitch + jp - (meAAGun.__jp || 0), TANK.groundPitchMin, TANK.groundPitchMax);
    meAAGun.__jy = jy; meAAGun.__jp = jp;
  }

  // 撞击可破坏物（只判玩家本机；远端由各自客户端判并广播）
  if (meAAGun && meAAGun.alive && !STATE.roundOver) {
    const res = ramProps(myAAGun.group.position, meAAGun.speed, dt);
    if (res) {
      effects.shake(res.hard ? 0.34 : 0.16);
      if (res.hard) { meAAGun.speed = 0; meAAGun.targetSpeed = 0; audio.explosionAt(myAAGun.group.position); }
      else { meAAGun.speed *= 0.78; }
      if (mode !== 'practice') {
        if (res.hard) sendEvt({ k: 'collapse', id: res.prop.id, p: [res.prop.x, res.prop.gy + 1.5, res.prop.z] });
        else sendEvt({ k: 'break', id: res.prop.id, p: [res.prop.x, res.prop.gy + 1, res.prop.z] });
      }
    }
    // 麦田倒伏（每 0.25s 一次，避免每帧遍历 1900 株）
    farmHeatT -= dt;
    if (farmHeatT <= 0) {
      farmHeatT = 0.25;
      if (Math.abs(meAAGun.speed) > 1) flattenWheatAt(myAAGun.group.position.x, myAAGun.group.position.z, 3.4);
    }
  }

  tickFarm(dt);
  checkWrecks();
  updateWrecks(dt);
  updateShells(dt);
  updateTankFires(dt);

  // 弹托
  for (let i = SABOTS.length - 1; i >= 0; i--) {
    const p = SABOTS[i];
    p.t += dt;
    p.v.y -= 9.8 * dt;
    p.m.position.addScaledVector(p.v, dt);
    p.m.rotation.x += p.w.x * dt;
    p.m.rotation.y += p.w.y * dt;
    p.m.rotation.z += p.w.z * dt;
    if (p.t > 1.1) { if (p.m.parent) p.m.parent.remove(p.m); SABOTS.splice(i, 1); }
  }

  // 燃烧 / 倒塌的同步：tickFarm 里烧塌的房屋在这里补一条广播
  if (mode !== 'practice') {
    for (let i = 0; i < PROPS.length; i++) {
      const p = PROPS[i];
      if (p.dead && !p.__announced) {
        p.__announced = true;
        sendEvt({ k: 'collapse', id: p.id, p: [p.x, p.gy + 1.5, p.z] });
      }
    }
  } else {
    for (let i = 0; i < PROPS.length; i++) if (PROPS[i].dead) PROPS[i].__announced = true;
  }

  updateScopeUi();
}

/* =====================================================================
   相机 + 观察窗
   ===================================================================== */
const _camPos = new THREE.Vector3(), _camLook = new THREE.Vector3(), _camDir = new THREE.Vector3();
export function groundCamera(c) {
  const ent = c.f;
  if (!ent || !ent.aagun) return false;
  const p = ent.aagun.group.position;
  const dt = c.dt || 0.016;
  forwardOfTurret(ent, _camDir);

  if (c.zoom) {
    ent.aagun.group.updateMatrixWorld(true);
    if (ent.aagun.scopeEye) ent.aagun.scopeEye.getWorldPosition(_camPos);
    else _camPos.copy(p).setY(p.y + 3.2);
    _camPos.y += 0.04;
    camera.position.copy(_camPos);
    camera.up.set(0, 1, 0);
    _camLook.copy(_camPos).addScaledVector(_camDir, 160);
    camera.lookAt(_camLook);
    setScopeViewmodelVisible(false);
    if (Math.abs(camera.fov - 22) > 0.15) {
      camera.fov += (22 - camera.fov) * Math.min(1, dt * 12);
      camera.updateProjectionMatrix();
    }
  } else {
    setScopeViewmodelVisible(false);
    camera.up.set(0, 1, 0);
    _camPos.copy(p).addScaledVector(_camDir, -13.5);
    _camPos.y = p.y + 6.2 - _camDir.y * 2.0;
    camera.position.lerp(_camPos, 1 - Math.exp(-9 * dt));
    if (camera.position.distanceTo(_camPos) > 22) camera.position.copy(_camPos);
    _camLook.copy(p).setY(p.y + 2.4).addScaledVector(_camDir, 55);
    camera.lookAt(_camLook);
    if (Math.abs(camera.fov - 62) > 0.2) {
      camera.fov += (62 - camera.fov) * Math.min(1, dt * 8);
      camera.updateProjectionMatrix();
    }
  }
  if (effects.shakeAmp > 0.005) {
    const a = effects.shakeAmp * 0.9;
    camera.position.x += (Math.random() - 0.5) * a;
    camera.position.y += (Math.random() - 0.5) * a;
    camera.position.z += (Math.random() - 0.5) * a;
  }
  return true;
}

function setScopeViewmodelVisible(on, dir) {
  if (on && !scopeG) {
    scopeG = buildScopeViewmodel();
    scene.add(scopeG);
  }
  if (!scopeG) return;
  scopeG.visible = !!on;
  if (!on) return;
  // 挂在相机前方 0.95m、右上角：炮管从画面右上伸进来
  const off = new THREE.Vector3(1.02, 0.58, -0.55).applyQuaternion(camera.quaternion);
  scopeG.position.copy(camera.position).add(off);
  scopeG.quaternion.copy(camera.quaternion);
  scopeG.rotateY(0.16);      // 炮管从右上角斜着指向画面中心，能看到管身而不是只有炮口
  scopeG.scale.setScalar(0.82);
  if (dir) {
    // 与炮塔朝向严格一致（相机本身已经沿炮塔方向，这里保持相机姿态即可）
  }
}

/* =====================================================================
   HUD
   ===================================================================== */
export function hud(ctx0) {
  const ent = meAAGun;
  if (!ent) return null;
  /* v3.23：武器条只报武器名，与其他模式完全一致。
     装填 / 过热状态改由左下角「弹药 0 / ∞」（换弹时数字变黄）与观察窗里的装填条表达。 */
  const w = (ctx0 && ctx0.weapon === 'rocket') ? '🔥 燃烧弹' : '🎯 穿甲弹';
  /* v3.30：装甲损伤常驻提示 —— 一炮瘫痪、本回合不恢复，玩家必须随时知道自己还能不能动 */
  let warn = '';
  if (ent.engOut) warn += '⚠ 发动机损毁 · ';
  else if (ent.trackL && ent.trackR) warn += '⚠ 双履带断裂 · ';
  else if (ent.trackL) warn += '⚠ 左履带断裂 · ';
  else if (ent.trackR) warn += '⚠ 右履带断裂 · ';
  /* v3.31：炮塔卡死可以和履带/发动机同时存在，单独再拼一段 */
  if (ent.turretJammed) warn += '⚠ 炮塔卡死 · ';
  return warn + w;
}

let scopeEl = null;
function ensureScopeUi() {
  if (scopeEl) return scopeEl;
  const d = document.createElement('div');
  d.id = 'tankScope';
  d.innerHTML = `
    <div class="tsVig"></div>
    <div class="tsRing"><i class="tsTick t1"></i><i class="tsTick t2"></i><i class="tsTick t3"></i><i class="tsTick t4"></i>
      <div class="tsCrossH"></div><div class="tsCrossV"></div><div class="tsDot"></div></div>
    <div class="tsTop"><b>125mm</b> · 车长观察镜</div>
    <div class="tsRec"><i></i><span id="tsRecTxt">APFSDS</span></div>
    <div class="tsReload"><i id="tsReloadFill"></i></div>
    <div class="tsHeat">车体温度 <b id="tsHeatVal">0%</b></div>
    <div class="tsWarn" id="tsWarn"></div>
    <div class="tsHint">右键退出 · 左键开火</div>`;
  const st = document.createElement('style');
  st.textContent = `
  #tankScope{position:fixed;inset:0;z-index:44;pointer-events:none;display:none;
    font-family:"Noto Sans SC","PingFang SC",system-ui,sans-serif;color:#d8ead9}
  #tankScope.on{display:block}
  #tankScope .tsVig{position:absolute;inset:0;background:
    radial-gradient(ellipse at center, rgba(0,0,0,0) 34%, rgba(4,10,6,.42) 66%, rgba(2,6,3,.86) 100%)}
  #tankScope .tsRing{position:absolute;left:50%;top:50%;width:min(62vh,62vw);height:min(62vh,62vw);
    transform:translate(-50%,-50%);border:1.5px solid rgba(180,230,170,.45);border-radius:50%;
    box-shadow:0 0 0 1px rgba(0,0,0,.35) inset,0 0 26px rgba(120,220,120,.10)}
  #tankScope .tsRing::before{content:"";position:absolute;left:50%;top:50%;width:34%;height:34%;
    transform:translate(-50%,-50%);border:1px solid rgba(180,230,170,.30);border-radius:50%}
  #tankScope .tsCrossH{position:absolute;left:8%;right:8%;top:50%;height:1px;background:rgba(190,235,180,.42)}
  #tankScope .tsCrossV{position:absolute;top:8%;bottom:8%;left:50%;width:1px;background:rgba(190,235,180,.42)}
  #tankScope .tsDot{position:absolute;left:50%;top:50%;width:5px;height:5px;margin:-2.5px 0 0 -2.5px;
    background:#c9f5bf;border-radius:50%;box-shadow:0 0 8px rgba(180,255,170,.8)}
  #tankScope .tsTick{position:absolute;width:1px;height:14px;background:rgba(190,235,180,.5);left:50%}
  #tankScope .t1{top:-1px} #tankScope .t2{bottom:-1px}
  #tankScope .t3{top:50%;left:0;transform:rotate(90deg)} #tankScope .t4{top:50%;right:0;left:auto;transform:rotate(90deg)}
  #tankScope .tsTop{position:absolute;left:28px;top:24px;font:600 13px/1.5 inherit;letter-spacing:.04em;
    color:#cfe8c8;text-shadow:0 1px 6px #000}
  #tankScope .tsTop b{color:#f0ffe8}
  #tankScope .tsAlt{opacity:.6;font-weight:400;font-size:11px}
  #tankScope .tsRec{position:absolute;right:30px;top:56px;font:700 12px/1 inherit;letter-spacing:.12em;
    color:#ffcf7a;text-shadow:0 1px 8px #000;display:flex;align-items:center;gap:7px}
  #tankScope .tsRec i{width:7px;height:7px;border-radius:50%;background:#ff5a3c;box-shadow:0 0 8px #ff5a3c;display:block}
  #tankScope .tsReload{position:absolute;left:30px;bottom:26px;width:180px;height:4px;border-radius:2px;
    background:rgba(10,20,12,.55);border:1px solid rgba(180,230,170,.25);overflow:hidden}
  #tankScope .tsReload i{display:block;height:100%;width:100%;background:linear-gradient(90deg,#8ad06f,#d6f5a8)}
  #tankScope .tsHeat{position:absolute;right:30px;bottom:26px;font:500 11px/1 inherit;color:#cfe8c8;opacity:.85}
  #tankScope .tsHeat b{color:#ffd08a;font-weight:700}
  #tankScope .tsWarn{position:absolute;left:50%;bottom:64px;transform:translateX(-50%);
    font:700 13px/1 inherit;letter-spacing:.08em;color:#ff9a5a;text-shadow:0 0 14px #ff5a1a;display:none}
  #tankScope .tsWarn.on{display:block;animation:tsBlink 1.1s infinite}
  @keyframes tsBlink{0%,100%{opacity:.35}50%{opacity:1}}
  #tankScope .tsHint{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);
    font:500 11px/1 inherit;color:#cfe8c8;opacity:.55}
  #tankScope.hot .tsVig{background:
    radial-gradient(ellipse at center, rgba(0,0,0,0) 26%, rgba(60,18,4,.42) 62%, rgba(40,10,2,.88) 100%)}
  #tankScope.hot .tsRing{border-color:rgba(255,170,90,.5);box-shadow:0 0 34px rgba(255,110,40,.16)}
  `;
  document.head.appendChild(st);
  document.body.appendChild(d);
  scopeEl = d;
  return d;
}

function updateScopeUi() {
  const el = ensureScopeUi();
  const alive = !!(meAAGun && meAAGun.alive && !STATE.roundOver);
  const on = alive && zoom;
  el.classList.toggle('on', !!on);
  el.classList.toggle('hot', !!(on && meAAGun && meAAGun.heat > 0.3));
  const ch = document.getElementById('crosshair');
  if (ch) ch.style.display = (alive && !on) ? '' : 'none';
  const pr = document.getElementById('planeReticle');
  if (pr && meAAGun) pr.style.display = (alive && !on) ? '' : 'none';
  /* 开镜时把普通 HUD 收起来：左下角装甲面板 / 底部武器条会和观察窗的
     装填条、温度读数叠在一起（实测很难看）。炮塔键位提示在坦克模式永远不适用。 */
  const st = document.getElementById('stats');
  if (st) st.style.display = on ? 'none' : '';
  const wh = document.getElementById('weaponHud');
  if (wh && on) wh.style.display = 'none';
  const av = document.getElementById('altVal');
  if (av && av.parentElement) av.parentElement.style.display = 'none';
  const zt = document.getElementById('zoomTip');
  if (zt) {
    zt.style.display = 'none';
    zt.innerHTML = '左键 开火 · 右键 观察窗 · W/S 前进后退 · A/D 转向 · 1/2 换弹 · F 战绩';
  }

  if (!on || !meAAGun) return;
  const heatK = 1 + TANK.heatReloadPenalty * (meAAGun.heat || 0);
  const max = aagunWeapon === 'rocket' ? TANK.heatReload * heatK : TANK.apReload * heatK;
  const left = aagunWeapon === 'rocket' ? (meAAGun.heatT || 0) : (meAAGun.apT || 0);
  const fill = document.getElementById('tsReloadFill');
  if (fill) fill.style.width = Math.max(0, Math.min(100, (1 - left / max) * 100)) + '%';
  const hv = document.getElementById('tsHeatVal');
  if (hv) hv.textContent = Math.round((meAAGun.heat || 0) * 100) + '%';
  const rt = document.getElementById('tsRecTxt');
  if (rt) rt.textContent = aagunWeapon === 'rocket' ? 'HEAT · 燃烧弹' : 'APFSDS · 穿甲弹';
  const warn = document.getElementById('tsWarn');
  if (warn) {
    const hot = meAAGun.heat > 0.3;
    warn.textContent = hot ? '车体过热' : '';
    warn.classList.toggle('on', hot);
  }
}

/* =====================================================================
   网络事件
   ===================================================================== */
export function debugState() {
  return {
    wrecks: WRECKS.length,
    shells: SHELLS.length,
    shell0: SHELLS[0] ? { x: +SHELLS[0].pos.x.toFixed(2), y: +SHELLS[0].pos.y.toFixed(2), z: +SHELLS[0].pos.z.toFixed(2), d: +SHELLS[0].dist.toFixed(1), pierced: SHELLS[0].pierced } : null,
    apT: meAAGun ? +meAAGun.apT.toFixed(2) : null,
    pos: myAAGun ? myAAGun.group.position.toArray().map(n => +n.toFixed(2)) : null,
    yaw: meAAGun ? +meAAGun.turretYaw.toFixed(3) : null,
    pitch: meAAGun ? +meAAGun.turretPitch.toFixed(3) : null,
  };
}

export function netEvent(d) {
  if (!d) return;
  if (d.eid) {
    if (seenEvt.has(d.eid)) return;
    seenEvt.add(d.eid);
  }
  switch (d.k) {
    case 'shot': {
      if (d.from === myPeerId) break;
      const o = new THREE.Vector3().fromArray(d.o);
      const dir = new THREE.Vector3().fromArray(d.d).normalize();
      spawnShell(o, dir, d.kind || 'ap', 'foeVis', d.fid || 0, true);
      /* v3.32.1：别人的穿甲弹同样要看到弹托分离。旧版只有本地 fireShell 生成，
         远端只重建弹体 → 队友/对手的炮口看不到那三片弹托。 */
      if ((d.kind || 'ap') === 'ap') spawnSabots(o, dir);
      effects.muzzle(o, 2.0);
      /* v3.28：炮声按音速传播（343 m/s），不再"光速"到达 */
      {
        const _ear = myAAGun ? myAAGun.group.position : o;
        const _dly = Math.min(2600, o.distanceTo(_ear) / 343 * 1000);
        const _v = { x: dir.x * 1250, y: dir.y * 1250, z: dir.z * 1250 };
        setTimeout(() => audio.enemyShootAt(o, _v), _dly);
      }
      break;
    }
    case 'propHit': {
      const prop = propById(d.id);
      if (!prop || prop.dead) break;
      const pt = new THREE.Vector3().fromArray(d.p);
      if (d.shell === 'ap') {
        if (prop.type === 'house') carveHole(prop, pt, 1.7);
        else { prop.__announced = true; breakProp(prop, pt, 1.0); }
      }
      break;
    }
    case 'break': {
      const prop = propById(d.id);
      if (prop) { prop.__announced = true; breakProp(prop, new THREE.Vector3().fromArray(d.p), 1.0); }
      break;
    }
    case 'collapse': {
      const prop = propById(d.id);
      if (prop) { prop.__announced = true; collapseHouse(prop, new THREE.Vector3().fromArray(d.p)); }
      break;
    }
    case 'ignite': {
      const prop = propById(d.id);
      if (prop) igniteProp(prop, new THREE.Vector3().fromArray(d.p));
      break;
    }
    case 'fire': {
      addFireAt(d.x, d.y, d.z, d.r || 1.6, 'ground', TANK.heatFireT);
      break;
    }
    case 'crater': {
      addCrater(d.x, d.z, d.r, d.d);
      break;
    }
    case 'fx': {
      effects.explosion(new THREE.Vector3(d.x, d.y, d.z), d.s || 1);
      break;
    }
    case 'ammoBlow': {
      // 弹药架殉爆的大火球：房主结算后广播给其他端（房主自己已在 ammoBlast 里播过）
      const c = new THREE.Vector3().fromArray(d.p || [0, 0, 0]);
      effects.explosion(c, 4.4);
      effects.explosion(c, 2.4);
      audio.explosionAt(c);
      effects.shake(0.9);
      break;
    }
    case 'tankFire': {
      const id = d.id;
      const ent = (id === myPeerId) ? meAAGun : (aaguns[id] ? aaguns[id].ent : null);
      attachTankFire(id, ent, new THREE.Vector3().fromArray(d.p));
      break;
    }
  }
}

/* =====================================================================
   菜单展示 / 清理
   ===================================================================== */
let menuRefs = [];
export function menuProp(p, ctx) {
  if (p.kind !== 'tank') return false;
  const t = buildTank(p.color);
  ctx.scene.add(t.group);
  const y = farmGroundY(p.pos[0], p.pos[2]) - 0.16;
  t.group.position.set(p.pos[0], y, p.pos[2]);
  t.group.rotation.y = p.yaw || 0;
  t.turret.rotation.y = (p.turretYaw || 0);
  t.guns.rotation.x = 0.02;
  menuRefs.push(t.group);
  return true;
}
export function menuCleanup() {
  for (const g of menuRefs) scene.remove(g);
  menuRefs = [];
  sessionEnd();
}

/* =====================================================================
   回合 / 会话
   ===================================================================== */
export function roundReset() {
  clearShells();
  clearWrecks();
  resetFarm();
  clearTankFires();
  /* 清"失去动力"：新回合（含死斗重生）所有车必须能动 */
  for (const id in aaguns) {
    const e = aaguns[id].ent;
    if (e) { e.apT = 0; e.heatT = 0; e.heat = 0; e.burning = 0; e.__jy = 0; e.__jp = 0; e.immobilized = null; e.trackL = false; e.trackR = false; e.engOut = false; e.turretJammed = false; e.__lockYaw = undefined; }
  }
  if (meAAGun) { meAAGun.apT = 0; meAAGun.heatT = 0; meAAGun.heat = 0; meAAGun.burning = 0; meAAGun.__jy = 0; meAAGun.__jp = 0; meAAGun.immobilized = null; meAAGun.trackL = false; meAAGun.trackR = false; meAAGun.engOut = false; meAAGun.turretJammed = false; meAAGun.__lockYaw = undefined; }
  seenEvt = new Set();
  setScopeViewmodelVisible(false);
  updateScopeUi();
}

/* 退出坦克模式时把被改过的 HUD 元素还原（否则切回空战会带着坦克的键位提示/隐藏的高度行）。
   ★ 不要碰 #weaponHud：它由 updateWeaponHud 统一管理显隐。旧版这里写 `style.display = ''`，
   而 menuCleanup() 会在 backToMenu 隐藏武器条**之后**再调一次 sessionEnd —— 结果一局打完回大厅，
   底部一直挂着「🎯 穿甲弹 [1/2 切换]」消不掉（v3.23.1 修）。 */
function restoreHudDom() {
  const st = document.getElementById('stats'); if (st) st.style.display = '';
  const av = document.getElementById('altVal'); if (av && av.parentElement) av.parentElement.style.display = '';
  const zt = document.getElementById('zoomTip');
  if (zt) { zt.style.display = ''; if (ORIG_ZOOM_TIP) zt.innerHTML = ORIG_ZOOM_TIP; }
  setReticleVisible(true);   // 观察窗视角藏掉的准星，退出时统一还原（js/hud.js）
}

export function sessionEnd() {
  clearShells();
  clearWrecks();
  resetFarm();
  clearTankFires();
  setScopeViewmodelVisible(false);
  if (scopeEl) scopeEl.classList.remove('on', 'hot');
  restoreHudDom();
}

function clearShells() {
  for (const s of SHELLS) if (s.mesh && s.mesh.parent) s.mesh.parent.remove(s.mesh);
  SHELLS.length = 0;
  for (const p of SABOTS) if (p.m.parent) p.m.parent.remove(p.m);
  SABOTS.length = 0;
}

/* =====================================================================
   练习编成：玩家坦克 vs AI 坦克
   ===================================================================== */
export function spawnPractice(ctx) {
  const { scene } = ctx;
  const team = ctx.side === 1 ? 1 : 0;
  ctx.set.myTeam(team);
  ctx.set.meIsAAGun(true);

  // 玩家
  const my = ctx.buildGround(ctx.color.ally);
  scene.add(my.group);
  const ent = ctx.makeGround(my);
  ctx.set.myAAGun(my);
  ctx.set.meAAGun(ent);
  const sp = ctx.groundSpawnPos(2, team);
  my.group.position.copy(sp);
  ent.hp = ctx.groundHp;
  ent.bodyYaw = team === 0 ? 0 : Math.PI;
  ent.turretYaw = ent.bodyYaw;
  ent.turretPitch = 0.02;
  my.group.rotation.y = ent.bodyYaw;
  my.turret.rotation.y = 0;
  my.guns.rotation.x = 0.02;

  // AI
  const foe = ctx.buildGround(ctx.color.foe);
  scene.add(foe.group);
  const ent2 = ctx.makeGround(foe);
  const sp2 = ctx.groundSpawnPos(2, 1 - team);
  foe.group.position.copy(sp2);
  const ai = new TankBot(ent2);
  ai.reset(sp2, team === 0 ? Math.PI : 0);
  ent2.aagun.group.rotation.y = ent2.bodyYaw;
  ctx.aaguns['bot'] = {
    id: 'bot', aagun: foe, ent: ent2, team: 1 - team, slot: 0,
    alive: true, hp: ctx.groundHp,
    tPos: new THREE.Vector3(), tTurretYaw: 0, tTurretPitch: 0, tBodyYaw: 0,
    lastState: 0, isBot: true, bot: ai,
  };
}
