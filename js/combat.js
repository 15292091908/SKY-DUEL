// js/combat.js — 战斗核心（v3.4 从 main.js 抽出）：子弹/火箭、命中判定、伤害与死亡、
// 回合与比赛结算、房主权威校验与击杀台账。所有跨模块依赖通过 import 显式声明。
import * as THREE from 'three';
import { modeField, modeDef } from './mode.js?v=1543';   // 「游戏内」模式模块（武器/参数由模式描述符决定）
import {
  planes, aaguns, STATE, hitSettled, me, myPlane, myAAGun, meAAGun, meIsAAGun, mode, gamemode,
  myTeam, mySlot, myPeerId, roster, iAmHost, hostPeerId, killLedger, lastDmgFrom, killCount, nets, netSize,
  sbRows, setSbRows, setLastDmgFrom, setKillCount, world, crashPairs,
  aagunWeapon, setAagunWeapon, planeWeapon, setPlaneWeapon, heAmmo, rocketAmmo, setHeAmmo, setRocketAmmo,
  setAimYaw, setAimPitch,
} from './state.js?v=1543';
import {
  AAGUN_HP, AAGUN_DMG, BASE_DMG, HE_AMMO, HE_DMG_MULT, HE_SPLASH_MULT, HIT_TOLERANCE, KILL_FEED_TTL,
  ROCKET_BLAST_R, ROCKET_FUEL_T, ROCKET_DMG, ROCKET_GRAVITY, ROCKET_LIFE,
  ROCKET_PROX_R, ROCKET_SPEED, SPLASH_DMG, SPLASH_R, WIN_ROUNDS, FUSE_R, BULLET_MUZZLE,
  ROCKETS_PER_AAGUN, DM_RESPAWN_MS, DM_KILL_TARGET, DM_KILL_TARGET_MIN, DM_KILL_TARGET_MAX,
  BULLET_INHERIT_MAX, BULLET_DMG_MIN,
} from './config.js?v=1543';
import { effects, audio, scene, IS_ANDROID_APP } from './core.js?v=1543';
import { $, banner, subBanner, dmgFlashEl, showPart, showHitmark, showFriendlyFire, addKillFeed, clearKillFeed, nameOfPlayer, matchPanel, matchTitle, matchSub, updateScore } from './hud.js?v=1543';
import { buildScoreRows, renderScoreboard } from './scores.js?v=1543';
import { forwardOf } from './plane.js?v=1543';
import { forwardOfTurret, forwardOfBody, updateWeakAAGun, applyAAGun } from './aagun.js?v=1543';
import { safeSpawnPos, safeAAGunSpawn } from './units.js?v=1543';
import { showKillcam, clearKillcam } from './killcam.js?v=1543';
import { netBroadcast, netSendEventTo } from './netev.js?v=1543';
import { nextRound } from './match.js?v=1543';
// 坠机点 / 开火状态（loop.js 持有）
import { deathPos, setFiring } from './loop.js?v=1543';

/* ================= 子弹 ================= */
export const bulletGeo = new THREE.CylinderGeometry(0.07, 0.07, 4.5, 5);
bulletGeo.rotateX(Math.PI / 2);
export const tracerMatMe = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
export const tracerMatFoe = new THREE.MeshBasicMaterial({ color: 0xff8a7a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
export const bullets = [];
// 弹池容量：按 5v5 全员持续扫射估算（10 人 × 3.4s 寿命 ÷ 0.09s 射速 ≈ 380 发），留余量取 480。
// 打光时 spawnBullet 返回 null → 子弹不可见且无法模拟/上报，多人局会"打不出子弹"
for (let i = 0; i < 480; i++) {
  const m = new THREE.Mesh(bulletGeo, tracerMatMe);
  m.visible = false; scene.add(m);
  bullets.push({ mesh: m, pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), iv: new THREE.Vector3(), v0: BULLET_MUZZLE, life: 0, active: false, src: 'me', dmg: BASE_DMG, splashR: 0 });
}
export const Z_AXIS = new THREE.Vector3(0, 0, 1);

/* 子弹的伤害衰减系数（v3.17）：按命中瞬间速度与初速之比的平方（动能 ∝ v²）。
   600m 处约 0.74、900m 处约 0.63，下限 BULLET_DMG_MIN 防止远距离完全挠痒。
   这个值由**射手端**算好，通过 hitRep 的 df 字段交给房主复算（房主没有这颗子弹的弹道，
   不传就只能按满伤害结算；夹紧在 0.2~1，改包也拿不到超额伤害）。 */
export function bulletDmgFactor(b) {
  if (!b || !b.v0) return 1;
  const r = b.vel.length() / b.v0;
  return Math.max(BULLET_DMG_MIN, Math.min(1, r * r));
}

// 子弹网络参数（弹道一致性）：fire/blt 必须携带实际速度/伤害/溅射标志。
// 否则房主与各接收端按默认参数重建弹道 → 与开火者本地弹道偏离（速度差 ~9%，300m 外偏差可达 20m+），
// 房主权威判定大量误判 miss → dmgReject 误回溯；AAGun 弹伤害还会被按 BASE_DMG 结算（2.5 倍）
export function bulletNetParams(shot) {
  const b = shot.bullet;
  if (!b) return { s: BULLET_MUZZLE, dm: BASE_DMG, sl: 0, fid: 0 };
  // fid：本发子弹的编号（v3.0 命中广播靠「射手+fid」定位并销毁各端弹道特效）
  // s = 纯枪口初速标量（不含载具速度），iv = 发射瞬间的载具速度矢量。
  // 接收端用 v(0) = dir·s + iv 重建出与射手端逐帧一致的唯一速度矢量。
  const p = { s: Math.round(b.muzzle || BULLET_MUZZLE), dm: Math.max(1, Math.round(b.dmg)), sl: Math.round(b.splashR || 0), fid: b.fid || 0 };
  /* 载具速度（v3.18）：静止发射时为 0 → 报文不带这个字段。
     注意 b.iv 是**发射瞬间快照**，不随弹道衰减；衰减发生在 b.vel 上，两端各算各的但公式相同。 */
  if (b.iv && b.iv.lengthSq() > 0.04) p.iv = [Math.round(b.iv.x * 10) / 10, Math.round(b.iv.y * 10) / 10, Math.round(b.iv.z * 10) / 10];
  return p;
}

// 机炮对地溅射：近失/落地爆炸对防空车造成范围伤害（解决高速俯冲难命中）
// 2026-10-06 用户反馈"溅射伤害与范围过大"：半径 16→8、基础伤害 6→4（伤害下限 1）
// 飞机 2 号武器·高爆子弹（仅防空车模式）：伤害翻倍的普通子弹，溅射范围 ×1.2
// 武器状态（每回合重置）：防空车 1=高射机枪 / 2=火箭炮；飞机 1=机炮 / 2=火箭炮(空战) 或 高爆子弹(aavs)

/* ================= v3.0 客户端判定 / 房主校验（架构参数） =================
   命中判定权在开火者本地（用自己看到的画面判定），房主只做「位置合理性校验」后权威扣血并广播。
   客户端一律不做本地扣血预判（血量只认房主下发的值），因此不再需要预判回溯对账。 */
                            // 推导：80ms 延迟门槛下，目标在开火者画面里的滞后 ≈ (RTTa+RTTb)/2 ≤ 80ms，
                            // 按最大 170m/s 飞行 → 位置偏差 ≤ 14m；再加接收端插值平滑滞后(~50-80ms) ≈ 24m，
                            // 取 40m 留抖动余量；远超此值即为明显异常（错目标/瞬移/改包）。

/* ================= 统一弹道模型（v3.18）=================
   不再按「沿弹道 / 垂直弹道」拆两段、也不为前进/后退/侧飞/爬升分别写分支。
   只有一条速度矢量、三条公式，覆盖所有发射角与所有载具运动状态：

     v(0) = dir · 枪口初速 + 载具世界速度         （伽利略速度叠加）
     dv/dt = -c·|v|·v - g·ŷ                     （真实二次阻力 + 重力）
     伤害系数 = (|v_hit| / |v0|)²                （动能 ∝ v²）

   前进时向下射：载具的前进速度自然进入 v(0)，弹道斜向前下；
   后退时前射：载具速度反向，v(0) 变小 → 弹速下降、后坐方向偏移；
   侧飞/升降/任意组合：都只是同一个矢量加法，不需要任何特判。
   联机只传「枪口初速标量 s」+「载具速度矢量 iv」，接收端按同一公式重建。 */
export function spawnBullet(origin, dir, speed, src, dmg, splashR, carrier) {
  const b = bullets.find((x) => !x.active);
  if (!b) return null;
  // splashR：本发子弹的溅射半径（0 = 无溅射）；不同武器（普通机炮 / 高爆）各自的溅射范围不同
  b.active = true; b.src = src; b.life = 3.4; b.dmg = dmg || BASE_DMG; b.splashR = splashR || 0;
  // 复用防残留：弹池对象跨发复用，上一发的归属/编号/擦身标记必须清零（否则命中广播会销毁错误的弹道）
  b.fid = 0; b.fFrom = null; b._whiz = 0;
  b.muzzle = speed;                           // 纯枪口初速（报文 s 用，接收端靠它重建）
  b.iv.set(0, 0, 0);                          // 发射瞬间的载具速度快照（报文 iv / 调试用，不参与逐帧积分）
  if (carrier) {
    b.iv.copy(carrier);
    if (b.iv.lengthSq() > BULLET_INHERIT_MAX * BULLET_INHERIT_MAX) b.iv.setLength(BULLET_INHERIT_MAX);
  }
  b.pos.copy(origin); b.prev.copy(origin);
  b.vel.copy(dir).multiplyScalar(speed).add(b.iv);   // ★ 唯一的速度矢量：枪口 + 载具
  b.v0 = b.vel.length();                      // 合初速模长（伤害衰减基准）
  b.mesh.visible = true;
  b.mesh.material = (src === 'me') ? tracerMatMe : tracerMatFoe;
  b.mesh.position.copy(origin);
  b.mesh.quaternion.setFromUnitVectors(Z_AXIS, _bulletDir.copy(b.vel).normalize());
  return b;
}
const _bulletDir = new THREE.Vector3();

export const _gunPos = new THREE.Vector3();
export const _fireDir = new THREE.Vector3();
export const _noseV = new THREE.Vector3();       // 机头方向（弹道被模式改写时也要用它算载具速度）
export const _carrierV = new THREE.Vector3();    // 载具的**完整**世界速度矢量
/* 统一模型：只返回载具此刻的速度，不投影、不分解、不按载具类型分支。
   直升机由 flightHeli 算出 vel = 前进/后退 + 横移 + 升降；飞机与防空车沿运动方向 × speed。
   前进向下射、后退前射、侧飞爬升 —— 都是同一个矢量加法，交给 spawnBullet 处理。 */
function carrierVelocity(fighter, noseDir) {
  if (fighter.vel) return _carrierV.copy(fighter.vel);
  return _carrierV.copy(noseDir).multiplyScalar(fighter.speed || 0);
}
export function fireGun(fighter, src, opts) {
  fighter.gunSide = !fighter.gunSide;
  const off = fighter.plane.guns[fighter.gunSide ? 1 : 0] || fighter.plane.guns[0];   // 单炮口载具（直升机吊舱）兜底
  // 关键：枪口/弱点坐标是相对 mesh（机翼随 roll 滚转），必须用 mesh.matrixWorld（含 roll），
  // 不能用 group.matrixWorld（group 只有 yaw/pitch，无 roll）——否则转弯时机身倾斜而子弹从水平位置射出
  fighter.plane.group.updateMatrixWorld(true);
  if (opts && opts.muzzle) _gunPos.copy(opts.muzzle);                       // 模式自定义炮口（直升机炮塔）
  else _gunPos.copy(off).applyMatrix4(fighter.plane.mesh.matrixWorld);
  forwardOf(fighter, _noseV);
  if (opts && opts.dir) _fireDir.copy(opts.dir).normalize();                // 模式自定义弹道方向
  else _fireDir.copy(_noseV);
  // 高爆子弹（v3.2 飞机 2 号武器，仅防空车模式）：伤害翻倍 + 溅射范围 ×1.2
  const he = !!(opts && opts.he);
  const dmg = he ? BASE_DMG * HE_DMG_MULT : undefined;
  // 溅射半径：本模式飞机若配高爆子弹（planeLoadout='he'）则带溅射（高爆时 ×倍率）
  const splR = (modeField('planeLoadout', 'rocket') === 'he') ? (he ? SPLASH_R * HE_SPLASH_MULT : SPLASH_R) : modeField('gunSplash', 0);
  const b = spawnBullet(_gunPos, _fireDir, BULLET_MUZZLE, src, dmg, splR,
    carrierVelocity(fighter, _noseV));
  effects.muzzle(_gunPos, (opts && opts.muzzleScale) || 1);
  return { origin: _gunPos.clone(), dir: _fireDir.clone(), bullet: b, he };
}
// 机载火箭（v3.2 空战模式飞机 2 号武器）：机制/参数与防空车火箭完全相同，从机翼挂架发射
export function firePlaneRocket(fighter, src, ownerId, aimDir) {
  fighter.plane.group.updateMatrixWorld(true);
  // v3.17.1：翼下左右各 1 个发射巢，两发按 左→右 交替（旧版固定 [0] = 永远左翼）；旧实体无 rocketMuzzles 时兜底机炮口
  const muzzles = fighter.plane.rocketMuzzles || fighter.plane.guns;
  const side = (fighter.rocketSide | 0) % muzzles.length;
  fighter.rocketSide = (side + 1) % muzzles.length;
  _gunPos.copy(muzzles[side]).applyMatrix4(fighter.plane.mesh.matrixWorld);
  forwardOf(fighter, _fireDir);
  if (aimDir) _fireDir.copy(aimDir).normalize();  // AI：弹道用"前置解"方向
  const r = spawnRocketFx(_gunPos, _fireDir, src, ownerId);
  if (!r) return null;
  effects.muzzle(_gunPos);
  return { origin: _gunPos.clone(), dir: _fireDir.clone(), rocket: r };
}

// 溅射伤害计算（距离衰减）：只算伤害返回给调用方，结算统一走 v3.0 的"开火者判定 → 房主校验"链路
// R = 本发子弹的溅射半径（普通机炮 SPLASH_R / 高爆 ×1.2）；baseDmg 用于伤害倍率换算（高爆 ×2）
export function splashDamageAt(ag, pos, R, baseDmg) {
  const dist = ag.aagun.group.position.distanceTo(pos);
  if (dist > R) return 0;
  const scale = (baseDmg || BASE_DMG) / BASE_DMG;
  return Math.max(1, Math.round(SPLASH_DMG * scale * (1 - dist / R)));
}

/* ================= 防空车火箭炮（v3.1 新武器，1/2 键切换） =================
   发射：从炮塔管口沿炮塔朝向出发；速度随动能衰减（RPG 风格，耗尽后坠海）
   近炸引信：每帧检测最近的敌方飞机，≤ ROCKET_PROX_R 起爆
   爆炸：主目标 ROCKET_DMG（飞机 HP 100 → 一击致命）；主目标的队友在 ROCKET_BLAST_R 内按距离衰减受伤
   联机：发射"只广播特效"（fireRocket → 房主重建 → rkt 广播）；命中由发射者判定后复用
         hitRep/hit 链路（房主按位置校验）——与机枪完全同一套 v3.0 判定架构 */
export const rockets = [];
// v3.10.5 火箭弹精细建模（机头朝 -Z，全长 ≈2.4m 与旧弹体一致）：
// 弹头锥 + 弹体 + 识别环带 + 4 片尾翼 + 尾喷口 + 尾焰
export const rocketBodyGeo = new THREE.CylinderGeometry(0.16, 0.17, 1.7, 10);
rocketBodyGeo.rotateX(Math.PI / 2);
export const rocketNoseGeo = new THREE.CylinderGeometry(0.02, 0.16, 0.62, 10);
rocketNoseGeo.rotateX(-Math.PI / 2);          // 锥尖朝 -Z
export const rocketNozzleGeo = new THREE.CylinderGeometry(0.145, 0.12, 0.22, 10);
rocketNozzleGeo.rotateX(Math.PI / 2);
export const rocketFinGeo = new THREE.BoxGeometry(0.035, 0.46, 0.4);
export const rocketBandGeo = new THREE.CylinderGeometry(0.172, 0.172, 0.14, 10);
rocketBandGeo.rotateX(Math.PI / 2);
export const rocketBodyMat = new THREE.MeshStandardMaterial({ color: 0xb8bfc4, metalness: 0.55, roughness: 0.42 });
export const rocketNoseMat = new THREE.MeshStandardMaterial({ color: 0x4a4f55, metalness: 0.6, roughness: 0.35 });
export const rocketBandMat = new THREE.MeshStandardMaterial({ color: 0xd8a33a, metalness: 0.4, roughness: 0.5 });
export const rocketFinMat = new THREE.MeshStandardMaterial({ color: 0x6b7278, metalness: 0.5, roughness: 0.45 });
export const flameGeo = new THREE.SphereGeometry(0.55, 6, 5);
export const rocketFlameMat = new THREE.MeshBasicMaterial({ color: 0xffa24a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
export function makeRocketMesh() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(rocketBodyGeo, rocketBodyMat); body.position.z = 0.15; g.add(body);
  const nose = new THREE.Mesh(rocketNoseGeo, rocketNoseMat); nose.position.z = -1.0; g.add(nose);
  const band = new THREE.Mesh(rocketBandGeo, rocketBandMat); band.position.z = -0.35; g.add(band);
  const nozzle = new THREE.Mesh(rocketNozzleGeo, rocketNoseMat); nozzle.position.z = 1.06; g.add(nozzle);
  for (let i = 0; i < 4; i++) {                       // 尾翼 ×4（+X/-X/+Y/-Y）
    const fin = new THREE.Mesh(rocketFinGeo, rocketFinMat);
    const a = (i * Math.PI) / 2;
    fin.position.set(Math.sin(a) * 0.24, Math.cos(a) * 0.24, 0.92);
    fin.rotation.z = -a;
    g.add(fin);
  }
  const flame = new THREE.Mesh(flameGeo, rocketFlameMat);
  flame.position.z = 1.5;   // 尾部尾焰
  g.add(flame);
  g.userData.flame = flame;   // v3.17：助推段结束要把它关掉（燃料烧完 = 没有火焰）
  g.visible = false;
  scene.add(g);
  return g;
}
for (let i = 0; i < 20; i++) {   // 池：5v5 最多 10 辆车 × 1 发，留余量
  rockets.push({ active: false, mesh: makeRocketMesh(), pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), axis: new THREE.Vector3(0, 0, -1), life: 0, fid: 0, fFrom: null, src: 'me', owner: null, traveled: 0, frame: 0, burnT: 0, cruise: false });
}
export const _rkDir = new THREE.Vector3();
// 创建一枚飞行中的火箭（本地发射 / 收到广播特效，共用）
export function spawnRocketFx(origin, dir, src, ownerId) {
  const r = rockets.find((x) => !x.active);
  if (!r) return null;
  r.active = true; r.src = src; r.life = ROCKET_LIFE; r.fid = 0; r.fFrom = null; r._whiz = 0; r.owner = ownerId || null; r.traveled = 0; r.frame = 0;
  // ★ 池化复用必须把「上一发」的个性字段清干净（v3.14.4）：
  //   炸弹用过的槽位若被火箭复用，isBomb/blastR/lethalR/grav 残留会让火箭变成"无近炸的炸弹"。
  r.isBomb = false; r.blastR = 0; r.lethalR = 0; r.grav = undefined; r.dragQ = undefined;
  r.releaseY = undefined;
  r.fuelT = ROCKET_FUEL_T;      // v3.19：燃料总时长 = 点火段(IGNITE_T) + 巡航段
  r.burnT = 0;                  // 已燃烧时间（用来切「点火 → 巡航」两个子状态）
  r.cruise = false;             // 是否已进入巡航（进入瞬间把速度精确拉到 V_MAX）
  r.axis.copy(dir);             // 弹轴 / 发射方向（点火段推力沿它；速度为 0 时用它设初始朝向）
  if (r.mesh.userData.flame) r.mesh.userData.flame.visible = true;
  r.pos.copy(origin); r.prev.copy(origin);
  /* v3.19：离架初速 0 —— 从静止点火，靠自己在 1 秒内加速到 ROCKET_V_MAX。
     （真实 RPG-7 是炮射 117 m/s + 火箭增程，这里按用户要求做成纯火箭从零起步。） */
  r.vel.copy(dir).multiplyScalar(ROCKET_SPEED);
  r.mesh.visible = true;
  r.mesh.position.copy(origin);
  r.mesh.quaternion.setFromUnitVectors(Z_AXIS, dir);
  return r;
}
export function fireRocket(ag, src, ownerId, aimDir) {
  ag.aagun.group.updateMatrixWorld(true);
  /* v3.17.1：左右各 1 个发射巢，两发备弹按 左→右 交替出膛
     （旧版固定取 [0]，两发都从同一侧飞出来，看着别扭）。 */
  const muzzles = ag.aagun.rocketMuzzles || ag.aagun.gunMuzzles;
  const side = (ag.rocketSide | 0) % muzzles.length;
  ag.rocketSide = (side + 1) % muzzles.length;
  const mz = muzzles[side];
  _agMuzzle.copy(mz).applyMatrix4(ag.aagun.guns.matrixWorld);
  forwardOfTurret(ag, _agDir);
  if (aimDir) _agDir.copy(aimDir).normalize();   // AI：弹道用"前置解"方向（炮塔限速追不上，会导致长距离必脱靶）
  const r = spawnRocketFx(_agMuzzle, _agDir, src, ownerId);
  if (!r) return null;
  r.slot = side;                 // 联机：接收端也按同一挂架出膛（视觉一致）
  effects.muzzle(_agMuzzle);
  return { origin: _agMuzzle.clone(), dir: _agDir.clone(), rocket: r };
}
// 起爆结算：主目标一击致命 + 主目标队友按距离衰减（练习本地结算 / 房主权威 / 非房主上报）
// v3.3 全面友伤：爆炸点 ROCKET_BLAST_R 内的**所有存活单位**（飞机 + 防空车，敌我不分，
// 含发射者自己）都按距离衰减受伤；主目标（近炸直接命中的那架/那辆）固定满伤害（一击致命）。
// mainPl 为 null 即"打地板"：无主目标，只结算波及伤害（防空车火箭也能炸地面/炸队友/炸自己）。
export const lastRocketBlast = new THREE.Vector3();   // 最近一次火箭起爆点（调试/自动化测试用）
export function detonateRocket(r, mainPl, blastPos) {
  r.active = false; r.mesh.visible = false;
  const partName = r.isBomb ? '航空炸弹' : '火箭弹';
  const pos = blastPos || r.pos;
  lastRocketBlast.copy(pos);
  effects.explosion(pos, 2.4); audio.explosionAt(pos); effects.shake(0.35);
  const killer = (r.src === 'bot') ? 'bot' : (r.src === 'me' ? myPeerId : (r.fFrom || null));
  const victims = [];
  const seen = {};
  // 本发爆炸参数：航空炸弹可自定义半径与致死区（r.blastR / r.lethalR）
  const BR = r.blastR || ROCKET_BLAST_R;
  const LR = r.lethalR || 0;
  const dmgAt = (d) => ((LR > 0 && d <= LR) ? 999 : Math.max(2, Math.round(ROCKET_DMG * (1 - d / BR))));
  if (mainPl && mainPl.alive) {
    // 主目标可能是防空车（近炸引信敌我不分）：按实体形态判别，否则练习结算会去 planes 找
    // 防空车 → undefined → 一击致死的 999 伤害静默丢失（v3.10.4 修复：炸弹/火箭炸不死防空车）
    const mainIsAg = !!mainPl.aagun;
    victims.push({ id: mainPl.id, dmg: LR > 0 ? 999 : ROCKET_DMG, isAAGun: mainIsAg, self: false });
    seen[mainPl.id] = 1;
  }
  // 波及：所有飞机（含队友、含发射者自己）
  for (const id in planes) {
    if (seen[id]) continue;
    const o = planes[id];
    if (!o.alive) continue;
    const d = pos.distanceTo(o.plane.group.position);
    if (d >= BR) continue;
    victims.push({ id, dmg: dmgAt(d), isAAGun: false, self: false });
    seen[id] = 1;
  }
  // 波及：所有防空车（含队友、含发射者自己）
  for (const id in aaguns) {
    if (seen[id]) continue;
    const o = aaguns[id];
    if (!o.alive) continue;
    const d = pos.distanceTo(o.aagun.group.position);
    if (d >= BR) continue;
    victims.push({ id, dmg: dmgAt(d), isAAGun: true, self: false });
    seen[id] = 1;
  }
  // 发射者自身（自己在 planes/aaguns 字典之外，单独判定"自伤"）
  // v3.14.6：弹药只有归属者会起爆（不再能被子弹打爆、也不会被爆炸连锁），
  //   所以这里永远不会重复结算 —— 一条弹在这一台机器上只走一次。
  //   发射者自己也在爆炸半径里时照常吃伤害（自炸「X 误伤 X」）。
  const selfAlive = meIsAAGun ? !!(meAAGun && meAAGun.alive) : !!(me && me.alive);
  const selfPos = meIsAAGun ? (myAAGun ? myAAGun.group.position : null) : (myPlane ? myPlane.group.position : null);
  if (selfAlive && selfPos && pos.distanceTo(selfPos) < BR) {
    victims.push({ id: myPeerId, dmg: dmgAt(pos.distanceTo(selfPos)), isAAGun: meIsAAGun, self: true });
  }
  // 友伤提示（v3.5.1）：我发射的火箭波及到队友 → 屏幕中下方弹「误伤队友」（自伤不算）
  if (r.src === 'me' && victims.some((v) => !v.self && teamOf(v.id) === myTeam)) showFriendlyFire();
  for (const v of victims) {
    if (mode === 'practice') {
      // 练习模式：本地即权威
      if (v.self) {
        setLastDmgFrom(killer);
        if (meIsAAGun) applyMeAAGunDamage(v.dmg); else applyMeDamage(v.dmg);
        setLastDmgFrom(null);
      } else {
        const o = v.isAAGun ? aaguns[v.id] : planes[v.id];
        if (!o) continue;
        setLastDmgFrom(killer);
        o.hp -= v.dmg; if (o.hp <= 0) peerDie(o.isBot ? 'bot' : v.id);
        setLastDmgFrom(null);
      }
    } else if (iAmHost) {
      // 房主权威结算（target 可为房主自己，hostSettleHit 内部已处理自伤分支）
      hostSettleHit(killer, v.id, partName, true, v.dmg, [pos.x, pos.y, pos.z], r.fid);
    } else if (r.fid) {
      netSendEventTo(hostPeerId, { t: 'hitRep', fid: r.fid, id: v.id, part: partName, splash: 1, dmg: v.dmg, p: [pos.x, pos.y, pos.z] });
    }
  }
  /* v3.14.6：**删掉连锁引爆**。爆炸不再点着范围内的其他火箭/炸弹 ——
     连同 v3.14.5 删掉的空中拦截，弹药现在只有"归属者自己的引信/撞地/超时"一个起爆来源，
     不会再出现"非归属者去引爆别人的弹"导致的重复结算。 */
  return victims;
}

// 武器切换（键盘 1/2；安卓触屏按钮也调它）+ HUD 显示
export function switchAAGunWeapon(w) {
  if (!meIsAAGun || !meAAGun || !meAAGun.alive) return;
  if (w === 'rocket' && rocketAmmo <= 0) { showPart('火箭弹已用尽'); return; }
  if (aagunWeapon === w) return;
  setAagunWeapon(w);
  updateWeaponHud();
  showPart(w === 'rocket' ? '切换：火箭炮（剩 ' + rocketAmmo + ' 发）' : '切换：高射机枪');
}
// 统一武器选择入口（键盘 1/2、安卓触屏按钮共用）：n = 1 主武器 / 2 副武器
export function selectWeapon(n) {
  if (meIsAAGun) { switchAAGunWeapon(n === 2 ? 'rocket' : 'mg'); return; }
  if (!me || !me.alive || STATE.roundOver) return;
  if (n === 1) {
    if (planeWeapon !== 'gun') { setPlaneWeapon('gun'); updateWeaponHud(); showPart('切换：机炮'); }
    return;
  }
  // 2 号武器由「游戏内」模式模块指定：'rocket' → 机载火箭炮；'he' → 高爆子弹；'bomb' → 航空炸弹
  if (modeField('planeLoadout', 'rocket') === 'bomb') {
    if (planeWeapon === 'bomb') return;
    const _bn = me.bombs ? (me.bombs.left ? 1 : 0) + (me.bombs.right ? 1 : 0) : 0;
    if (_bn <= 0) { showPart('航空炸弹已投完'); return; }
    setPlaneWeapon('bomb');
    showPart('切换：航空炸弹（剩 ' + _bn + ' 枚）');
    updateWeaponHud();
    return;
  }
  if (modeField('planeLoadout', 'rocket') === 'he') {
    if (heAmmo <= 0) { showPart('高爆子弹已用尽'); return; }
    if (planeWeapon === 'he') return;
    setPlaneWeapon('he');
    showPart('切换：高爆子弹（剩 ' + heAmmo + ' 发）');
  } else {
    if (rocketAmmo <= 0) { showPart('火箭弹已用尽'); return; }
    if (planeWeapon === 'rocket') return;
    setPlaneWeapon('rocket');
    showPart('切换：火箭炮（剩 ' + rocketAmmo + ' 发）');
  }
  updateWeaponHud();
}
export let weaponHudEl = null;
export function updateWeaponHud() {
  if (!weaponHudEl) {
    weaponHudEl = document.createElement('div');
    weaponHudEl.id = 'weaponHud';
    weaponHudEl.style.cssText = 'position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:60;'
      + 'font:600 13px/1.5 "Noto Sans SC","PingFang SC",sans-serif;color:#dff1ff;'
      + 'background:rgba(10,25,45,.55);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);'
      + 'border:1px solid rgba(140,200,255,.35);border-radius:999px;padding:6px 16px;display:none;pointer-events:none;white-space:nowrap';
    document.body.appendChild(weaponHudEl);
  }
  if (!STATE.started || STATE.roundOver) {
    weaponHudEl.style.display = 'none';
    const bw0 = $('btnWeapon'); if (bw0) bw0.style.display = 'none';
    hideThrottleBtns();
    return;
  }
  weaponHudEl.style.display = 'block';
  let txt;
  if (meIsAAGun) txt = (aagunWeapon === 'rocket' ? '🚀 火箭炮 · ' + rocketAmmo + ' 发' : '🔫 高射机枪');
  else if (modeField('hud', null)) txt = modeField('hud')({ weapon: planeWeapon }) || '';   // 模式自定义武器文案（直升机）
  else if (modeField('planeLoadout', 'rocket') === 'he') txt = (planeWeapon === 'he' ? '💥 高爆子弹 · ' + heAmmo + ' 发' : '🔫 机炮');
  else txt = (planeWeapon === 'rocket' ? '🚀 火箭炮 · ' + rocketAmmo + ' 发' : '🔫 机炮');
  weaponHudEl.textContent = txt + '　[1 / 2 切换]';
  const bw = $('btnWeapon');   // 安卓触屏：对局中显示武器切换按钮（防空车/飞机通用）
  if (bw) bw.style.display = IS_ANDROID_APP ? 'flex' : 'none';
  // 油门按钮（v3.5.2 皇牌空战式操控）：只在操控飞机时显示——防空车用摇杆上下直接挪车，不需要油门键
  const showThr = IS_ANDROID_APP && !meIsAAGun;
  const isHeli = gamemode === 'heli';
  for (const id of ['btnFast', 'btnSlow']) {
    const b = $(id); if (!b) continue;
    b.style.display = showThr ? 'flex' : 'none';
    const label = id === 'btnFast' ? (isHeli ? '上升' : '加速') : (isHeli ? '下降' : '减速');
    if (b.textContent !== label) b.textContent = label;
  }
  const bz = $('btnZoom');
  if (bz) { const lb = isHeli ? '枪镜' : '瞄准'; if (bz.textContent !== lb) bz.textContent = lb; }
}
function hideThrottleBtns() {
  for (const id of ['btnFast', 'btnSlow']) { const b = $(id); if (b) b.style.display = 'none'; }
}

// 防空车高射机枪（低伤害高射速 + 散布）
export const _agMuzzle = new THREE.Vector3();
export const _agDir = new THREE.Vector3();
export const _agPos = new THREE.Vector3();
export const _agBody = new THREE.Vector3();       // 车体朝向（移动方向）
export const _agCarrier = new THREE.Vector3();    // 车体速度里垂直于炮口方向的分量
export const _botAim = new THREE.Vector3();   // v3.2：防空车 AI 火箭瞄准用
export function fireGunAAGun(ag, src) {
  ag.gunSide = !ag.gunSide;
  ag.aagun.group.updateMatrixWorld(true);
  const mz = ag.aagun.gunMuzzles[ag.gunSide ? 1 : 0];
  _agMuzzle.copy(mz).applyMatrix4(ag.aagun.guns.matrixWorld);
  forwardOfTurret(ag, _agDir);
  // 机枪散布
  _agDir.x += (Math.random() - 0.5) * 0.016;
  _agDir.y += (Math.random() - 0.5) * 0.016;
  _agDir.z += (Math.random() - 0.5) * 0.016;
  _agDir.normalize();
  /* 车体速度（v3.18 统一模型）：不再投影、不再减掉沿炮口方向的分量。
     整台车的速度原样进入 v(0)，边跑边侧射、边倒车边开火、爬坡时升降，全部由同一条公式给出。 */
  _agCarrier.set(0, 0, 0);
  if (ag.speed && Math.abs(ag.speed) > 0.05) {
    forwardOfBody(ag, _agBody).multiplyScalar(ag.speed);
    _agCarrier.copy(_agBody);
  }
  // 高射机枪与机炮同属「子弹」：v3.14 一起提到枪口初速 880（原先 520）
  const b = spawnBullet(_agMuzzle, _agDir, BULLET_MUZZLE, src, AAGUN_DMG, 0, _agCarrier);
  effects.muzzle(_agMuzzle);
  return { origin: _agMuzzle.clone(), dir: _agDir.clone(), bullet: b };
}

/* ================= 命中判定 ================= */
export const _seg = new THREE.Vector3(), _toC = new THREE.Vector3(), _cp = new THREE.Vector3();
export function segSphere(p0, p1, c, r) {
  _seg.copy(p1).sub(p0); const l2 = _seg.lengthSq(); let t = 0;
  if (l2 > 0) t = THREE.MathUtils.clamp(_toC.copy(c).sub(p0).dot(_seg) / l2, 0, 1);
  _cp.copy(p0).addScaledVector(_seg, t);
  return _cp.distanceToSquared(c) <= r * r;
}
export function updateWeakWorld(plane) {
  plane.group.updateMatrixWorld(true);
  // 弱点坐标相对 mesh（含 roll 滚转），与枪口同理
  for (const wp of plane.weakPoints) wp._w.copy(wp.offset).applyMatrix4(plane.mesh.matrixWorld);
}
export function checkBulletHit(b, plane) {
  updateWeakWorld(plane);
  for (const wp of plane.weakPoints) if (segSphere(b.prev, b.pos, wp._w, wp.r)) return wp;
  return null;
}
export function checkAAGunHit(b, ag) {
  updateWeakAAGun(ag);
  for (const wp of ag.aagun.weakPoints) if (segSphere(b.prev, b.pos, wp._w, wp.r)) return wp;
  return null;
}

/* ================= 地图碰撞 ================= */
const _tmpA = new THREE.Vector3();   // 本地临时向量（原 main.js 的 tmpA 拆分后自带）
export function collideTerrain(plane) {
  if (!world) return null;
  const p = plane.group.position;
  for (const c of world.colliders) {
    if (c.s === 0) {
      _tmpA.set(p.x - c.v.x, p.y - c.v.y, p.z - c.v.z);
      if (_tmpA.lengthSq() <= (c.r + FUSE_R) * (c.r + FUSE_R)) {
        _tmpA.normalize();
        return { normal: _tmpA.clone(), pos: c.v.clone().addScaledVector(_tmpA, c.r + FUSE_R) };
      }
    } else if (c.s === 1) {
      if (p.y - FUSE_R < c.h && Math.abs(p.x - c.x) - c.hx < FUSE_R && Math.abs(p.z - c.z) - c.hz < FUSE_R) {
        const dx = p.x - c.x, dz = p.z - c.z;
        let nx = 0, nz = 0;
        if (Math.abs(dx) * c.hz >= Math.abs(dz) * c.hx) nx = Math.sign(dx); else nz = Math.sign(dz);
        _tmpA.set(nx, 0, nz).normalize();
        const ox = (nx !== 0 ? c.hx + FUSE_R : 0), oz = (nz !== 0 ? c.hz + FUSE_R : 0);
        return { normal: _tmpA.clone(), pos: new THREE.Vector3(c.x + nx * ox, Math.min(p.y, c.h), c.z + nz * oz) };
      }
    }
  }
  return null;
}

/* ================= 队伍 / 回合 ================= */
// 子弹撞楼/撞山检测（点是否在任一碰撞体内；楼房=AABB，山/物体=球）
export function hitWorldAt(p) {
  if (!world) return false;
  for (const c of world.colliders) {
    if (c.s === 1) {
      if (p.y < c.h && Math.abs(p.x - c.x) < c.hx && Math.abs(p.z - c.z) < c.hz) return true;
    } else {
      const dx = p.x - c.v.x, dy = p.y - c.v.y, dz = p.z - c.v.z;
      if (dx * dx + dy * dy + dz * dz < c.r2) return true;
    }
  }
  return false;
}

/* ================= 线段 vs 世界碰撞体（v3.5.1） =================
   用途：火箭这类高速物体一帧可飞 ~4.3m（260 m/s @60fps），逐帧点检测会直接"穿过"楼宇与山体，
   表现为"火箭穿楼而过、不爆炸"。这里对「上一帧位置 → 这一帧位置」的线段做精确相交测试：
   · 楼房等 AABB（c.s === 1）：y 从 -∞ 到 c.h（底面无限深，与 hitWorldAt 一致）
   · 山体/障碍球（c.s === 0）：中心 c.v、半径平方 c.r2
   起点已在体内时视为 t=0 命中（贴着几何体发射时立刻起爆，不会漏判）。
   返回 { t, pos }（pos 为命中点）；无命中返回 null。 */
export function rayHitWorld(p0, p1) {
  if (!world) return null;
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  const span = dx * dx + dy * dy + dz * dz;
  let bestT = 1, hit = false;
  for (const c of world.colliders) {
    if (c.s === 1) {
      // —— AABB：逐轴收缩参数区间 [tmin, tmax] ——
      let tmin = 0, tmax = 1, ok = true;
      if (Math.abs(dx) < 1e-9) { if (p0.x < c.x - c.hx || p0.x > c.x + c.hx) ok = false; }
      else {
        let a = (c.x - c.hx - p0.x) / dx, b = (c.x + c.hx - p0.x) / dx;
        if (a > b) { const t = a; a = b; b = t; }
        if (a > tmin) tmin = a;
        if (b < tmax) tmax = b;
        if (tmin > tmax) ok = false;
      }
      if (ok) {
        if (Math.abs(dz) < 1e-9) { if (p0.z < c.z - c.hz || p0.z > c.z + c.hz) ok = false; }
        else {
          let a = (c.z - c.hz - p0.z) / dz, b = (c.z + c.hz - p0.z) / dz;
          if (a > b) { const t = a; a = b; b = t; }
          if (a > tmin) tmin = a;
          if (b < tmax) tmax = b;
          if (tmin > tmax) ok = false;
        }
      }
      if (ok) {   // y 轴：下界取 -1e6（地表以下），上界 = 楼顶 c.h
        if (Math.abs(dy) < 1e-9) { if (p0.y > c.h) ok = false; }
        else {
          let a = (-1e6 - p0.y) / dy, b = (c.h - p0.y) / dy;
          if (a > b) { const t = a; a = b; b = t; }
          if (a > tmin) tmin = a;
          if (b < tmax) tmax = b;
          if (tmin > tmax) ok = false;
        }
      }
      if (ok && tmin < bestT) { bestT = tmin; hit = true; }
    } else {
      // —— 球：解 |p0 + t·d − c|² = r² ——
      const ox = p0.x - c.v.x, oy = p0.y - c.v.y, oz = p0.z - c.v.z;
      const cc = ox * ox + oy * oy + oz * oz - c.r2;
      if (cc <= 0) { if (0 < bestT) { bestT = 0; hit = true; } continue; }   // 起点已在球内
      if (span < 1e-12) continue;
      const bq = 2 * (ox * dx + oy * dy + oz * dz);
      const disc = bq * bq - 4 * span * cc;
      if (disc < 0) continue;                       // 无交点
      const t = (-bq - Math.sqrt(disc)) / (2 * span);   // 取最近的正根
      if (t < 0 || t > 1) continue;
      if (t < bestT) { bestT = t; hit = true; }
    }
  }
  if (!hit) return null;
  return { t: bestT, pos: new THREE.Vector3(p0.x + dx * bestT, p0.y + dy * bestT, p0.z + dz * bestT) };
}

export function teamAliveCount(team) {
  let n = 0;
  if (meIsAAGun) { if (meAAGun && meAAGun.alive && myTeam === team) n++; }
  else { if (me && me.alive && myTeam === team) n++; }
  for (const id in planes) if (planes[id].team === team && planes[id].alive) n++;
  for (const id in aaguns) if (aaguns[id].team === team && aaguns[id].alive) n++;
  return n;
}
export function checkRoundEnd() {
  if (STATE.roundOver) return;
  // 死斗（v3.15）：没有回合概念 —— 少一个人只是等 3 秒重生，绝不能触发"全队阵亡"结算
  if (STATE.matchType === 'dm') return;
  // 联机模式下回合结算由房主权威：非房主只跟随房主的 rEnd / sync.over / round，
  // 绝不能本地自推进 —— 否则局号会跑到房主前面，之后房主的 round 推送因"局号不够大"被全部忽略，
  // 表现为：手机端飞机永久冻结（roundOver 卡死 + 实体不复位），但血量仍随 sync 更新。
  if (mode !== 'practice' && !iAmHost) return;
  const a0 = teamAliveCount(0), a1 = teamAliveCount(1);
  if (a0 === 0 && a1 === 0) { settleRound('draw'); return; }
  if (a0 === 0 && STATE.eliminatedTeam !== 0) { STATE.eliminatedTeam = 0; STATE.teamElimTimer = 0.8; }
  else if (a1 === 0 && STATE.eliminatedTeam !== 1) { STATE.eliminatedTeam = 1; STATE.teamElimTimer = 0.8; }
}
export function syncScoreFromWorld() {
  // 队伍比分 → 本地视角比分（双方用同一份 s0/s1，保证一致）
  STATE.myScore = (myTeam === 0 ? STATE.s0 : STATE.s1);
  STATE.foeScore = (myTeam === 0 ? STATE.s1 : STATE.s0);
  updateScore();
}
export function settleRound(winner) {
  if (STATE.roundOver) return;
  // 双保险：联机的"回合结算"只有房主有裁决权 —— 末端那个 3.2s 计时器有两支
  // （到 3 胜 → matchOver 结束整场；否则 → nextRound 开下一回合），任一支被非房主执行
  // 都会让本端局号脱离房主的标尺（历史 bug：手机端局号超前 → 飞机永久冻结）。
  if (mode !== 'practice' && !iAmHost) { STATE.roundOver = true; setFiring(false); return; }
  STATE.roundOver = true; setFiring(false); STATE.teamElimTimer = 0;
  let winTeam = -1;
  if (winner === 'me') { winTeam = myTeam; banner('回合胜利', '#7CFC98', 3); audio.roundWin(); }
  else if (winner === 'foe') { winTeam = 1 - myTeam; banner('回合失败', '#ff7a6b', 3); audio.roundLose(); }
  else { banner('双方同归于尽', '#ffe08a', 3); subBanner('平局 · 双方均不计分', 3); }
  if (winTeam === 0) STATE.s0++;
  else if (winTeam === 1) STATE.s1++;
  syncScoreFromWorld();
  // 房主小世界：房主权威推送回合结果（w=胜方队伍，-1 平局；非房主据此显示回合横幅/音效）
  if (mode !== 'practice' && iAmHost) netBroadcast({ t: 'rEnd', rn: STATE.roundNum, s0: STATE.s0, s1: STATE.s1, w: winTeam });
  // 3.2s 只用于「同一场内的回合衔接」：到 3 胜 → 结束整场（弹结算面板等玩家点「再来一局」，绝不自动开新场）；
  // 未分胜负 → 下一回合。非房主不执行本段，只跟随房主的 round / matchEnd 推送。
  setTimeout(() => {
    if (mode !== 'practice' && !iAmHost) return;
    if (STATE.s0 >= WIN_ROUNDS || STATE.s1 >= WIN_ROUNDS) matchOver(STATE.myScore > STATE.foeScore);
    else nextRound();
  }, 3200);
}

// 本端扣血（v3.0）。调用方仅限：房主结算自己被打 / 练习模式 / 环境伤害（撞地出界，本地物理）。
// 联机下"被别人打中"不再走这里——血量由房主 'hit' 广播直接赋值（客户端不做任何本地预判扣血）
export function applyMeDamage(dmg) {
  if (meIsAAGun) { applyMeAAGunDamage(dmg); return; }
  if (!me.alive || STATE.roundOver) return;
  me.hp = Math.max(0, me.hp - dmg);
  audio.damageTaken(); dmgFlashEl.style.opacity = 0.9; effects.shake(0.4);
  if (me.hp <= 0) selfDestruct();
}
export function applyMeAAGunDamage(dmg) {
  if (!meAAGun.alive || STATE.roundOver) return;
  meAAGun.hp = Math.max(0, meAAGun.hp - dmg);
  audio.damageTaken(); dmgFlashEl.style.opacity = 0.9; effects.shake(0.4);
  if (meAAGun.hp <= 0) selfDestructAAGun();
}
export function selfDestruct() {
  if (!me.alive || STATE.roundOver) return;
  me.alive = false;
  setFiring(false);                      // 死亡瞬间松开扳机（否则死前按住左键，重生后一落地就在扫射）
  setAimYaw(0); setAimPitch(0);          // 死亡瞬间两准星归中（否则大准星会追着残留的小准星狂转）
  if (me.viewYaw !== undefined) {        // 直升机：视角归位到机头
    me.viewYaw = me.yaw; me.viewPitch = 0; me.mgYaw = 0; me.mgPitch = 0;
    if (me.plane && me.plane.mgPod) me.plane.mgPod.rotation.set(0, 0, 0);
  }
  deathPos.copy(myPlane.group.position);
  effects.explosion(deathPos, 1.4); audio.explosionAt(deathPos);
  // 练习模式：我被击落/坠毁也播报（无台账，纯本地）。lastDmgFrom === 我 = 自炸 → 播报「我 误伤 我」（sk 标记）
  if (mode === 'practice') { const sk = lastDmgFrom === myPeerId; addKillFeed(sk ? myPeerId : lastDmgFrom, myPeerId, undefined, undefined, false, sk); }
  else if (iAmHost) { recordAuthKill(lastDmgFrom, myPeerId); setLastDmgFrom(null); netBroadcast({ t: 'died', id: myPeerId }); }
  myPlane.group.visible = false;
  // 非房主本地死亡也必须上报：若本地 hp 因"未确认预判+环境伤害"混合提前归零而房主随后否决射击，
  // 权威 hp 永远 >0、sync 永不下发 al:false → 永久幽灵分歧（本地死亡/房主认为存活）。上报后房主权威对齐。
  if (mode !== 'practice' && !iAmHost && hostPeerId) netSendEventTo(hostPeerId, { t: 'died', id: myPeerId });
  // 死斗：本端起击杀镜头 + （房主）安排重生；加入方只等房主的 respawn 报文
  if (STATE.matchType === 'dm' && mode !== 'practice') { startKillcam(dmKillerId()); scheduleRespawn(myPeerId); }
  // 房主小世界：死亡由房主权威判定与结算；非房主端回合/比分等房主 sync/rEnd 推送
  if (mode === 'practice' || iAmHost) checkRoundEnd();
}
export function selfDestructAAGun() {
  if (!meAAGun.alive || STATE.roundOver) return;
  meAAGun.alive = false;
  setFiring(false);
  setAimYaw(0); setAimPitch(0);
  deathPos.copy(myAAGun.group.position); deathPos.y += 2;
  effects.explosion(deathPos, 1.6); audio.explosionAt(deathPos);
  myAAGun.group.visible = false;
  if (mode === 'practice') { const sk = lastDmgFrom === myPeerId; addKillFeed(sk ? myPeerId : lastDmgFrom, myPeerId, undefined, undefined, false, sk); }   // 同上：自炸 → 「我 误伤 我」
  else if (iAmHost) { recordAuthKill(lastDmgFrom, myPeerId); setLastDmgFrom(null); netBroadcast({ t: 'died', id: myPeerId }); }
  if (mode !== 'practice' && !iAmHost && hostPeerId) netSendEventTo(hostPeerId, { t: 'died', id: myPeerId });
  if (STATE.matchType === 'dm' && mode !== 'practice') { startKillcam(dmKillerId()); scheduleRespawn(myPeerId); }
  // 同上：房主权威结算
  if (mode === 'practice' || iAmHost) checkRoundEnd();
}
// 房主端：非房主死亡判定（房主小世界权威），结算由房主统一推送
export function peerDie(id) {
  const pl = planes[id];
  if (pl && pl.alive && !STATE.roundOver) {
    pl.alive = false;
    effects.explosion(pl.plane.group.position, 1.4); audio.explosionAt(pl.plane.group.position);
    pl.plane.group.visible = false;
    // 回合结束检查：房主权威 + 人机模式（practice 下 iAmHost=false，漏了会"击杀 bot 不判胜利"）
    if (iAmHost || mode === 'practice') { recordAuthKill(lastDmgFrom, id); setLastDmgFrom(null); checkRoundEnd(); scheduleRespawn(id); }
    return;
  }
  const ag = aaguns[id];
  if (ag && ag.alive && !STATE.roundOver) {
    ag.alive = false;
    effects.explosion(ag.aagun.group.position, 1.6); audio.explosionAt(ag.aagun.group.position);
    ag.aagun.group.visible = false;
    if (iAmHost || mode === 'practice') { recordAuthKill(lastDmgFrom, id); setLastDmgFrom(null); checkRoundEnd(); scheduleRespawn(id); }
  }
}
// 房主端：对非房主实体权威扣血（房主小世界结算）
export function applyPeerDamage(id, dmg) {
  const pl = planes[id];
  if (pl && pl.alive) { pl.hp -= dmg; if (pl.hp <= 0) peerDie(id); return; }
  const ag = aaguns[id];
  if (ag && ag.alive) { ag.hp -= dmg; if (ag.hp <= 0) peerDie(id); }
}

/* ================= 死斗：击杀镜头 + 重生（v3.15） =================
   权威划分：alive 状态仍由房主决定（peerDie 是唯一死亡出口），重生也由房主调度并广播；
   加入方只做两件事 —— 本地立刻起击杀镜头、等 respawn 报文后复原实体。
   为什么不让客户端自己复活：重生点要避开所有敌人，只有房主同时握有全场的权威位置。 */
const respawnTimers = new Map();     // 房主：id -> setTimeout
const tmpRespawn = new THREE.Vector3();
function dmActive() { return STATE.matchType === 'dm' && mode === 'net' && !STATE.matchEnded; }
// 击杀者：优先本次致命命中报文里的射手；其次是 lastDmgFrom（房主/近距离路径）
function dmKillerId() {
  const hit = STATE.lastHit;
  if (hit && performance.now() - hit.t < 2600 && hit.by) return hit.by;
  return lastDmgFrom || '';
}
export function startKillcam(killer) {
  if (!dmActive()) return;
  if (killer === myPeerId) { showKillcam({ by: '', weapon: '误伤自己（爆炸 / 撞击）' }); return; }
  const hit = STATE.lastHit;
  const fresh = !!hit && performance.now() - hit.t < 2600 && (!killer || hit.by === killer);
  let weapon = '';
  if (!killer) weapon = '坠毁 / 出界';
  else if (fresh && hit.part === '航空炸弹') weapon = '航空炸弹';
  else if (fresh && hit.part === '火箭弹') weapon = '火箭弹';
  else if (aaguns[killer]) weapon = '高射机枪';
  else if (fresh && hit.splash) weapon = '爆炸波及';
  else if (fresh) weapon = '机炮';
  else weapon = '撞击';
  const team = killer ? teamOf(killer) : null;
  const label = modeField('sideLabel', null) || ((t) => (t === 1 ? '蓝队' : '红队'));
  showKillcam({
    by: killer || '',
    name: killer ? nameOfPlayer(killer) : '',
    teamLabel: (team === 0 || team === 1) ? label(team) : '',
    weapon,
  });
}
// 房主：阵亡后安排重生（同一人只排一次；比赛结束/离开对局则不再执行）
export function scheduleRespawn(id) {
  if (!dmActive() || !iAmHost || !id) return;
  if (respawnTimers.has(id)) return;
  respawnTimers.set(id, setTimeout(() => {
    respawnTimers.delete(id);
    respawnHost(id);
  }, DM_RESPAWN_MS));
}
export function clearRespawnTimers() {
  for (const [, t] of respawnTimers) clearTimeout(t);
  respawnTimers.clear();
}
// 房主：选中远离敌人的重生点 → 本地应用 → 广播给所有人（含本人）
function respawnHost(id) {
  if (!dmActive()) return;
  let team, slot, isAg;
  if (id === myPeerId) { team = myTeam; slot = mySlot; isAg = meIsAAGun; }
  else {
    const p = roster.find((x) => x.peerId === id);
    if (!p || p.team < 0) return;
    team = p.team; slot = p.slot || 0; isAg = !!aaguns[id];
  }
  const ts = Math.max(2, netSize) / 2;
  const aa = (world && world.aaSpawns) ? world.aaSpawns : null;
  const pos = isAg ? safeAAGunSpawn(team, slot, aa) : safeSpawnPos(team, slot, ts);
  const yaw = team === 0 ? 0 : Math.PI;
  applyRespawnLocal(id, pos.toArray(), yaw);
  netBroadcast({ t: 'respawn', id, p: pos.toArray(), y: yaw });
}
/* 把某个实体复原到出生状态（房主本地 / 加入方收到报文后都走这里）。
   注意：重生没有无敌时间（用户明确要求），所以这里只是把 hp 拉满、位置拉开、弹药补满。 */
export function applyRespawnLocal(id, posArr, yaw) {
  const p = tmpRespawn.fromArray(posArr || [0, 0, 0]);
  const now = performance.now();
  if (id === myPeerId) {
    STATE.respawnAt = now;   // sync 里在途的旧快照（al:false）要据此忽略，否则刚复活又被判死
    if (meIsAAGun) {
      if (!meAAGun || !myAAGun) return;
      meAAGun.hp = AAGUN_HP; meAAGun.alive = true;
      meAAGun.turretYaw = yaw; meAAGun.turretPitch = 0.35;
      meAAGun.bodyYaw = yaw; meAAGun.speed = 0; meAAGun.targetSpeed = 0;
      meAAGun.rocketSide = 0;   // v3.17：重生后从左侧第一个挂架重新开始
      myAAGun.group.position.copy(p);
      myAAGun.group.visible = true;
      applyAAGun(meAAGun);
    } else {
      if (!me || !myPlane) return;
      me.hp = 100; me.alive = true;
      me.speed = me.targetSpeed = modeField('spawnSpeed', 95);
      me.pitch = 0; me.roll = 0; me.yawVel = 0; me.yaw = yaw;
      // 视角必须跟着重生朝向一起复位（否则上一命的视角会让机头绕大圈追赶）
      me.viewYaw = yaw; me.viewPitch = 0; me.mgYaw = 0; me.mgPitch = 0;
      if (me.vel && me.vel.set) me.vel.set(0, 0, 0);
      if (me.plane && me.plane.mgPod) me.plane.mgPod.rotation.set(0, 0, 0);
      myPlane.group.position.copy(p);
      myPlane.group.visible = true;
      myPlane.group.quaternion.setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
      setAimYaw(0); setAimPitch(0);
      me.rocketSide = 0;   // v3.17：重生后从左侧第一个挂架重新开始
      setPlaneWeapon('gun'); setHeAmmo(HE_AMMO); setRocketAmmo(ROCKETS_PER_AAGUN);
      const rr = modeDef() && modeDef().roundReset;
      if (typeof rr === 'function') rr();   // 直升机：航空炸弹每命补满
      updateWeaponHud();
    }
    clearKillcam();
    banner('重新出击', '#7CFC98', 1.4);
    return;
  }
  const pl = planes[id];
  if (pl) {
    pl.hp = 100; pl.alive = true; pl.respawnAt = now; pl.rocketSide = 0;
    pl.plane.group.position.copy(p);
    pl.plane.group.visible = true;
    pl.plane.group.quaternion.setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
    pl.tPos.copy(p); pl.tQuat.copy(pl.plane.group.quaternion);
    return;
  }
  const ag = aaguns[id];
  if (ag) {
    ag.hp = AAGUN_HP; ag.alive = true; ag.respawnAt = now; ag.rocketSide = 0;
    ag.aagun.group.position.copy(p);
    ag.aagun.group.visible = true;
    ag.ent.turretYaw = yaw; ag.ent.turretPitch = 0.35; ag.ent.bodyYaw = yaw;
    ag.ent.speed = 0; ag.ent.targetSpeed = 0;
    ag.tPos.copy(p); ag.tTurretYaw = yaw; ag.tBodyYaw = yaw;
    applyAAGun(ag.ent);
  }
}
// 碰撞去重：同一对实体（双方各自检测/上报）只允许权威结算一次（1.5s 窗口）
export function markCrashPair(a, b) {
  if (!a || !b) return false;
  const key = a < b ? a + '|' + b : b + '|' + a;
  const now = performance.now();
  if (crashPairs.has(key) && now - crashPairs.get(key) < 1500) return false;
  crashPairs.set(key, now);
  return true;
}
/* ===== v3.0：客户端判定命中的「房主校验 + 全端广播」 =====
   开火者本地判定命中 → 上报 {fid, id(目标), part(部位名), splash, dmg, p(目标位置)}；
   房主只做位置合理性校验（HIT_TOLERANCE 内即采信）→ 权威扣血 → 广播 hit（所有人据此放特效/更新血量，
   被打者据此扣血并放受击特效）。客户端一律不做本地扣血预判，血量只认房主下发的值。 */
export const tmpHitPos = new THREE.Vector3();
// 命中呈现（所有端共用；房主本地结算后也会自己调一次用于旁观视角）
export function presentHit(d) {
  const pos = tmpHitPos.fromArray(d.pos || [0, 0, 0]);
  const isMe = d.v === myPeerId;
  const isShooterMe = d.s === myPeerId;
  const part = d.part || '';
  const isRocket = part === '火箭弹' || part === '航空炸弹';
  // 击杀数即时反馈（非房主）：房主已确认这次致命命中 → +1；3s 内 kstat 会用台账值覆盖校正
  // v3.5.1：误杀队友不计人头（房主台账同样不计，kstat 校正后也不会涨）
  if (isShooterMe && d.fatal && !isFriendlyFire(d.s, d.v)) setKillCount(killCount + 1);
  const isSplash = !!d.splash;   // 溅射/爆炸类命中：所有端都要看到爆炸效果（用户反馈"防空车端看不到溅射"）
  if (isMe) {
    // 我是被打者：受击反馈（火箭=大爆炸，溅射=小爆炸，直击=火花）；v3.0 不预判，这里是权威到账的第一时间
    if (isRocket) { effects.explosion(pos, 2.4); audio.explosionAt(pos); effects.shake(0.7); dmgFlashEl.style.opacity = 1; }
    else if (isSplash) { effects.explosion(pos, 0.7); effects.sparks(pos, 0xffb3a0); audio.damageTaken(); effects.shake(0.4); dmgFlashEl.style.opacity = 0.9; }
    else { effects.sparks(pos, 0xffb3a0); audio.damageTaken(); effects.shake(0.4); dmgFlashEl.style.opacity = 0.9; }
    // 受击部位倍数也告诉我方（原来只有开火方看得到 ×N；防空车打直升机时看不到自己被打了要害）
    let _mult = 1;
    const _wps = meIsAAGun ? (myAAGun && myAAGun.weakPoints) : (myPlane && myPlane.weakPoints);
    if (_wps && part) { const _w = _wps.find((w) => w.name === part); if (_w) _mult = _w.mult; }
    if (isRocket || part === '溅射' || part === '爆炸') showPart('受到爆炸伤害');
    else showPart('被击中 ' + (part || '机身') + (_mult > 1 ? ' ×' + _mult : ''));
  } else if (!isShooterMe) {
    // 旁观者：命中特效与音效都要正确呈现（开火者本地判定时已放过，不重复）
    if (isRocket) { effects.explosion(pos, 2.4); audio.explosionAt(pos); }
    else if (isSplash) { effects.explosion(pos, 0.7); effects.sparks(pos, 0xffcf6b); audio.explosionAt(pos); }
    else { effects.sparks(pos, 0xffcf6b); audio.hitConfirm(); }
  }
  // 血量：直接采用房主权威值（v3.0 无预判，无需对账）
  if (isMe) {
    if (meIsAAGun) meAAGun.hp = d.hp; else me.hp = d.hp;
    /* 死斗击杀镜头要用「致命那一发的武器」：把本次命中记在 STATE.lastHit。
       必须在下面的 fatal 分支之前记 —— presentHit 会同步调用 selfDestruct，
       那里读的就是这条记录（晚一步就被清成空，镜头只能显示"坠毁"）。 */
    STATE.lastHit = { by: d.s || '', part: d.part || '', splash: !!d.splash, dmg: d.dmg | 0, t: performance.now() };
  }
  else {
    const pl = planes[d.v], ag = aaguns[d.v];
    if (pl) pl.hp = d.hp;
    if (ag) ag.hp = d.hp;
  }
  // 死亡表现：立即（不等 20Hz sync）
  if (d.fatal) {
    if (isMe) { if (meIsAAGun) selfDestructAAGun(); else selfDestruct(); }   // 内部上报 died（房主侧幂等）
    else {
      const pl = planes[d.v], ag = aaguns[d.v];
      if (pl && pl.alive) { pl.alive = false; effects.explosion(pl.plane.group.position, 1.4); audio.explosionAt(pl.plane.group.position); pl.plane.group.visible = false; }
      if (ag && ag.alive) { ag.alive = false; effects.explosion(ag.aagun.group.position, 1.6); audio.explosionAt(ag.aagun.group.position); ag.aagun.group.visible = false; }
    }
  }
  killBulletFx(d.s, d.fid);   // 该发子弹已消耗：所有端移除对应弹道特效
}
// 按「射手 + fid」移除本地弹道特效（各端都能定位到自己场景里的同一发子弹/火箭）
export function killBulletFx(shooterId, fid) {
  if (!fid) return;
  for (const b of bullets) if (b.active && b.fid === fid && b.fFrom === shooterId) { b.active = false; b.mesh.visible = false; }
  for (const r of rockets) if (r.active && r.fid === fid && r.fFrom === shooterId) { r.active = false; r.mesh.visible = false; }
}
// 房主：一次命中的权威结算（含伤害计算 + 广播）。伤害不信任上报值：
// 直击 = 开火者武器基础伤害 × 房主按目标弱点表复核的部位倍率；溅射 = 上报伤害（夹紧 2~40）
export function hostSettleHit(shooterId, targetId, part, splash, dmgRaw, posArr, fid, dfRaw) {
  if (!iAmHost || STATE.roundOver) return;
  const tgtIsMe = targetId === myPeerId;
  const ent = tgtIsMe ? null : (planes[targetId] || aaguns[targetId]);
  if (!tgtIsMe && (!ent || !ent.alive)) return;            // 目标已死/不存在 → 忽略
  const tgtAg = tgtIsMe ? meIsAAGun : !!aaguns[targetId];
  let dmg;
  if (splash) dmg = Math.max(2, Math.min(300, dmgRaw | 0));   // 夹紧：机炮溅射≤6、火箭主目标 150 都需在此范围内
  else {
    const shooterIsAAGun = shooterId === myPeerId ? meIsAAGun : !!aaguns[shooterId];
    const base = shooterIsAAGun ? AAGUN_DMG : BASE_DMG;
    const wps = tgtIsMe
      ? (tgtAg ? (myAAGun ? myAAGun.weakPoints : null) : (myPlane ? myPlane.weakPoints : null))
      : (tgtAg ? ent.aagun.weakPoints : ent.plane.weakPoints);
    let mult = 1;
    if (part && wps) { const wp = wps.find((w) => w.name === part); if (wp) mult = wp.mult; }
    /* 伤害衰减（v3.17）：射手端按自己的弹道算出速度比，随 hitRep 一起送来。
       房主端没有这颗子弹，只能信这个系数 —— 所以夹在 0.2~1，改包最多也只能拿满伤害，
       不可能靠伪造 df 打出超额伤害。缺省（旧客户端）按 1 处理。 */
    let df = Number(dfRaw);
    if (!Number.isFinite(df)) df = 1;
    df = Math.max(0.2, Math.min(1, df));
    dmg = Math.max(1, Math.round(base * mult * df));
  }
  setLastDmgFrom(shooterId);                                  // 击杀归因 = 开火者
  // 房主自己是受害者时不会走 presentHit（下面单独补特效），这里同步补一条命中记录给击杀镜头用
  if (tgtIsMe) STATE.lastHit = { by: shooterId || '', part: part || '', splash: !!splash, dmg, t: performance.now() };
  if (tgtIsMe) { if (meIsAAGun) applyMeAAGunDamage(dmg); else applyMeDamage(dmg); }
  else applyPeerDamage(targetId, dmg);                      // 内部含 hp<=0 → peerDie（记台账 + 广播 kill）
  setLastDmgFrom(null);
  let hpAfter, aliveAfter;
  if (tgtIsMe) { hpAfter = meIsAAGun ? meAAGun.hp : me.hp; aliveAfter = meIsAAGun ? meAAGun.alive : me.alive; }
  else { hpAfter = Math.max(0, ent.hp); aliveAfter = ent.alive; }
  const msg = { t: 'hit', s: shooterId, v: targetId, part: part || '', pos: posArr, dmg, hp: Math.max(0, Math.round(hpAfter)), fatal: aliveAfter ? 0 : 1, fid, splash: splash ? 1 : 0 };
  netBroadcast(msg);
  // 房主既非射手也非目标（旁观）时，本地补一次特效——广播不会回传给自己
  if (shooterId !== myPeerId && targetId !== myPeerId) presentHit(msg);
  /* v3.14.7：**房主自己是受害者时补上命中/爆炸特效**。
     非房主受害者会收到 `hit` → presentHit 的 isMe 分支（火箭有大爆炸）；
     房主走的是 applyMeDamage，只有受击闷响 + 震动，**连火箭爆炸都没有** ——
     这就是"被打的一方看不到火箭弹爆炸"的根因（房主那一端）。 */
  if (tgtIsMe) {
    const hp = tmpHitPos.fromArray(posArr || [0, 0, 0]);
    const isRocket = part === '火箭弹' || part === '航空炸弹';
    if (isRocket) { effects.explosion(hp, 2.4); audio.explosionAt(hp); showPart('受到爆炸伤害'); }
    else if (splash) { effects.explosion(hp, 0.7); effects.sparks(hp, 0xffb3a0); showPart('受到爆炸伤害'); }
    else { effects.sparks(hp, 0xffb3a0); showPart('被击中 ' + (part || '机身')); }
  }
}
// 网络簿记（每 50ms）：清理已结算命中表 / 过期的延迟探测记录
export function processNetReconcile() {
  const now = performance.now();
  for (const [k, t] of hitSettled) if (now - t > 5000) hitSettled.delete(k);
}

/* ================= 房主权威击杀台账（kstat） =================
   所有死亡裁决都在房主小世界完成：peerDie / selfDestruct 触发时按 lastDmgFrom 记"谁击杀了谁"，
   每 3s 把每人的 {击杀 k, 阵亡 d} 定向发给对应玩家。v3.0 客户端不再本地预判击杀，
   killCount 完全以 kstat 为权威（练习模式除外：本地即权威，命中致死本地直接 +1）。 */
export function ledgerOf(id) { if (!killLedger[id]) killLedger[id] = { k: 0, d: 0 }; return killLedger[id]; }
/* 击杀播报已移至 js/hud.js（v3.4） */


/* ===== 友伤判定（v3.5.1） =====
   击杀者与受害者同阵营 = 误杀。阵营来源：自己取 myTeam，其他玩家取 roster，
   人机/本地实体兜底取 planes/aaguns 字典（练习模式 roster 为空，必须走这条）。 */
export function teamOf(id) {
  if (!id) return null;
  if (id === myPeerId) return myTeam;
  const p = roster.find(x => x.peerId === id);
  if (p && p.team >= 0) return p.team;
  if (planes[id]) return planes[id].team;
  if (aaguns[id]) return aaguns[id].team;
  return null;
}
export function isFriendlyFire(killer, victim) {
  if (!killer || !victim || killer === victim) return false;
  const a = teamOf(killer), b = teamOf(victim);
  return a !== null && b !== null && a === b;
}
export function recordAuthKill(killer, victim) {
  if (STATE.matchEnded) return;   // 死斗达到目标后仍在飞的那几发不该再计分
  // 自炸（自己发射的火箭/溅射波及自己炸死自己）：killer === victim。
  // 语义：**不是击杀**（不计人头）→ 但也**不是环境坠毁**（播报用「X 误伤 X」），**阵亡照记**（自毁代价要算）。
  const sk = !!killer && killer === victim;
  const ff = !sk && isFriendlyFire(killer, victim);   // v3.5.1 误杀队友：不计人头，播报改「误杀」（自炸不走这条）
  if (mode === 'practice') {
    // 练习模式：无台账，击杀数就在此本地统计（覆盖子弹/火箭/碰撞所有致死路径，避免逐路径漏加）
    if (killer === myPeerId && !ff && !sk) setKillCount(killCount + 1);
    addKillFeed(killer, victim, undefined, undefined, ff, sk);
    return;
  }
  if (killer && !ff && !sk) ledgerOf(killer).k++;  // killer 为空 = 环境/自毁，只记阵亡；误杀与自炸都不加人头
  if (killer === myPeerId && !ff && !sk) setKillCount(killCount + 1);   // 房主端即时反馈（kstat 周期覆盖校正，不会重复计数）
  // v3.5.2 被队友误杀不计阵亡：误杀是意外，不该惩罚被误杀的那个队友（净击杀 = 击杀 − 阵亡 因此也不掉）
  // （自炸的 ff 恒为 false → 阵亡照记）
  if (!ff) ledgerOf(victim).d++;
  addKillFeed(killer, victim, killer ? nameOfPlayer(killer) : undefined, nameOfPlayer(victim), ff, sk);   // 房主端本地播报
  netBroadcast({ t: 'kill', k: killer || '', v: victim, kn: nameOfPlayer(killer), vn: nameOfPlayer(victim), ff: ff ? 1 : 0, sk: sk ? 1 : 0 });   // 权威击杀 → 全员播报（直接带名字）
  /* 死斗计分（v3.15）：只有「有效击杀」才给队伍加分（自炸、误杀队友都不算）。
     比分复用 STATE.s0/s1 —— 死斗时它们就是两队总击杀；sync 每帧带这两个值，
     所以即便某条 kill 事件丢了，下一次 sync 也会把比分校正回来。
     达到目标立刻判胜（房主权威），matchOver 内部负责广播与战绩表。 */
  if (STATE.matchType === 'dm' && killer && !ff && !sk) {
    const kt = teamOf(killer);
    if (kt === 0 || kt === 1) {
      if (kt === 0) STATE.s0++; else STATE.s1++;
      const target = Math.max(DM_KILL_TARGET_MIN, Math.min(DM_KILL_TARGET_MAX, STATE.killTarget || DM_KILL_TARGET));
      syncScoreFromWorld();
      if (STATE.s0 >= target || STATE.s1 >= target) matchOver((myTeam === 0 ? STATE.s0 : STATE.s1) >= target);
    }
  }
}
export function resetKillLedger() { for (const k in killLedger) delete killLedger[k]; setLastDmgFrom(null); }


export function matchOver(iWon) {
  STATE.matchEnded = true;
  // 房主小世界：房主权威推送胜利判定，非房主端由 matchEnd 消息应用
  if (mode !== 'practice' && iAmHost) {
    netBroadcast({ t: 'matchEnd', win: iWon, s0: STATE.s0, s1: STATE.s1 });
    setSbRows(buildScoreRows());                                        // 房主权威台账 → 排名
    netBroadcast({ t: 'scoreboard', rows: sbRows });                  // 全员同表（先 matchEnd 后 scoreboard，事件通道有序）
  }
  applyMatchEnd(iWon);
}
// 非房主端应用房主权威的胜利判定
export function applyMatchEnd(iWon) {
  STATE.matchEnded = true;
  clearKillcam();   // 死斗：结算面板不能被击杀镜头小卡压住（卡片 z-index 高于遮罩）
  matchTitle.textContent = iWon ? '最终胜利' : '惜败';
  matchTitle.style.color = iWon ? '#7CFC98' : '#ff7a6b';
  matchSub.textContent = STATE.matchType === 'dm'
    ? '总击杀 ' + STATE.myScore + ' : ' + STATE.foeScore + '（先到 ' + (STATE.killTarget || DM_KILL_TARGET) + ' 杀）'
    : '总比分 ' + STATE.myScore + ' : ' + STATE.foeScore + '（五局三胜）';
  $('btnRematch').classList.remove('hidden');
  matchPanel.classList.remove('hidden');
  if (sbRows.length) renderScoreboard(sbRows);      // 房主本地已构建；非房主等 scoreboard 消息到达再渲染
  if (document.pointerLockElement) document.exitPointerLock();
}
