// js/modes/heli2/index.js —— 直升机对决（直升机 vs 直升机）· 海上钻井平台
//
// 玩法：和空战一样（歼灭五局三胜 / 死斗），只是双方都开直升机。
//   一号武器：机腹机炮（沿准星，可上下摆）
//   二号武器：机身两侧双管霰弹 —— **只能沿机身水平方向发射**（机翼固定，不能像机枪那样仰俯），
//             8 颗弹丸、6 发弹夹（换弹 5s）、射速慢、弹速低、下坠大，30m 内一轮齐射能秒掉一架。
//   地图：五座可打炸的海上石油钻井平台。打炸后甲板起火：
//             火焰外缘每秒灼伤，进入火焰核心直接击毁；平台残骸保留（仍可当掩体/落脚点）。
import * as THREE from 'three';
import { scene, camera, effects, audio } from '../../core.js?v=1572';
import {
  STATE, planes, me, myPlane, myPeerId, myTeam, mode, iAmHost, hostPeerId,
  planeWeapon, setAimYaw, setAimPitch, setMyFireSeq, setLastDmgFrom,
} from '../../state.js?v=1572';
import {
  spawnBullet, bulletNetParams, bulletDmgFactor, fireGun, updateWeaponHud,
  applyMeDamage, peerDie, hostSettleHit,
} from '../../combat.js?v=1572';
import { showPart, setReticleVisible } from '../../hud.js?v=1572';
import { buildHeli, makeHeli, flightHeli, aimHeli as aimHeliBase, mgDirection, viewDirection, resetHeli, setCamUi } from '../../heli.js?v=1572';
import { HeliDuelBot } from './ai.js?v=1572';
import { partDamage } from './damage.js?v=1572';
import { RIGS } from './maps/oilrig.js?v=1572';
import { netBroadcast, netSendEventTo } from '../../netev.js?v=1572';

// ── 本模式参数 ──
export const DUEL = {
  mgInterval: 0.042,          // 机炮射速（≈24 发/秒，与直升机突袭一致）
  mgRange: 600,               // 弹道汇聚距离（子弹飞向准星 600m 处 → 命中点 = 准星）

  /* 双管霰弹（用户口径：射程近、近距离可秒杀、扩散/下坠/弹速都不如机枪、只能水平发射） */
  shotInterval: 0.9,          // 泵动循环（两发之间 0.9s）
  shotPellets: 8,             // 每轮 8 颗弹丸
  shotSpeed: 430,             // 弹丸初速（机炮 880 的一半）
  shotDmg: 18,                // 单颗弹丸基础伤害（8 颗全中 144 → 满血直升机一枪带走）
  shotSpread: 0.052,          // 扩散半角（弧度）≈3°，100m 处弹着圈直径约 10m
  shotLife: 1.35,             // 寿命（秒）→ 有效射程 ≈ 400m，但衰减后 200m 外就很弱
  shotRecoil: 0.055,

  /* 平台 */
  rigFireEdgeDps: 15,         // 火焰外缘每秒伤害
  rigFireCoreRatio: 0.52,     // 核心半径 = 平台半径 × 该系数（进核心 = 秒杀）
  rigFireHeight: 30,          // 火柱高度（甲板上方），飞过 60m+ 安全
};

export const MODE = {
  sides: [
    { side: 0, name: '🔴 红队', desc: '南侧空域\n向北突进' },
    { side: 1, name: '🔵 蓝队', desc: '北侧空域\n向南压制' },
  ],
  sideLabel: (t) => (t === 1 ? '蓝队' : '红队'),
  dropLabels: ['🔴 红队', '🔵 蓝队'],
  lobbyTitle: '你是主机 · 选择平台空域',
  matchName: '直升机对决',

  planeLoadout: 'shot',       // 2 号武器 = 双管霰弹（combat.js 的 selectWeapon 认这个值）
  /* v3.24 弹夹：1 号机炮 100 发、2 号双管霰弹 6 发（各自独立分仓，切换不重置） */
  magSize: 100,
  shotMag: 6,
  magReload: 5,
  /* v3.31：本模式的部位倍率（直升机 3/2/1.5），由本文件夹的 damage.js 拥有 */
  partDamage,
  aiNoRocket: true,           // AI 没有火箭弹（否则 200~800m 就会发射，玩家根本没这武器）
  gunSplash: 0,               // 机炮无溅射
  rotor: true,                // 直升机：HUD 的上升/下降按钮文案
  /* 出生点：两队在南北各 250m 处对头（相距 500m）。
     旧值 640（相距 1280m）在 70° FOV 下对方只有 5~6 像素，肉眼基本看不见（用户反馈），
     500m 时对方约 20 像素 + IFF 菱形标记，一眼能锁到。 */
  spawn: { airY: 110, airZ: 250 },
  spawnSpeed: 0,              // 直升机开局悬停

  /* 菜单 3D：两架直升机悬停在中央平台的停机坪上方。
     ★ 取景点必须避开井架（在平台中心偏 -x/-z 一侧，高 36m）——旧配置把相机放在甲板下方，
       整屏都是导管架的钢梁。现在把注视点挪到停机坪一侧、抬高到甲板以上。 */
  menu: {
    world: 'oilrig',
    scene: 'heli2',
    useTarget: true,
    target: [22, 31, -16],
    yaw: 0.55, pitch: 0.20, dist: 30,
    zoomBase: 30,
    props: [
      { kind: 'heli', color: 0x38bdf8, pos: [14, 30, -10], rot: [0.02, 2.35, 0], scale: 2.2 },
      { kind: 'heli', color: 0xf97316, pos: [30, 33, -24], rot: [0.0, -0.85, 0], scale: 1.9 },
    ],
  },

  buildAir: (color) => buildHeli(color, { shotgun: true, benches: false }),
  makeAir: (plane) => makeHeli(plane, { bombs: false }),
  flight: flightHeli,
  aim: aimHeli,
  fire: fireHeli2,
  botFire,                    // AI 副武器：近距离也会打双管霰弹（练习模式）
  camera: cameraHeli2,
  hud: hudHeli2,
  update: updateHeli2,
  tick: tickDuel,             // 全局每帧：火焰动画 / 火焰伤害 / 平台血量广播
  bulletHit,                  // 子弹撞平台（先于通用世界碰撞）
  rigDamage,                  // 房主：累加平台伤害（本机与 netev 的 rigHit 共用）
  rigSync,                    // 客户端：应用房主广播的平台血量
  menuProp,
  menuCleanup,
  roundReset,
  sessionEnd,
  spawnPractice,
};

/* ================= 瞄准（复用 heli.js，多同步一次准星）================= */
export function aimHeli(f, ctx) {
  aimHeliBase(f, { ...ctx, setAim: (y, p) => { setAimYaw(y); setAimPitch(p); } });
}

/* ================= 开火 ================= */
const _aim = new THREE.Vector3();
let camAimValid = false;

export function fireHeli2(kind, ctx) {
  const f = me;
  if (!f || !f.alive || ctx.roundOver) return;
  if (ctx.weapon === 'shot') { fireShotgun(f, ctx); return; }
  fireMachineGun(f, ctx);
}

function mgMuzzle(f) {
  f.plane.group.updateMatrixWorld(true);
  if (f.plane.muzzle) return f.plane.muzzle.getWorldPosition(new THREE.Vector3());
  return f.plane.guns[0].clone().applyMatrix4(f.plane.group.matrixWorld);
}

/* ---- 一号武器：机腹机炮（与直升机突袭完全一致） ---- */
function fireMachineGun(f, ctx) {
  ctx.setFireT(DUEL.mgInterval);
  const mz = mgMuzzle(f);
  const dir = camAimValid ? _aim.clone().sub(mz).normalize() : mgDirection(f).clone();
  const shot = fireGun(f, 'me', { dir, muzzle: mz.clone(), muzzleScale: 0.05 });
  if (ctx.audio) ctx.audio.shoot();
  effects.shake(0.028);
  if (ctx.mode !== 'practice') {
    const fid = ctx.myFireSeq + 1;
    ctx.setMyFireSeq(fid);
    if (shot.bullet) { shot.bullet.fid = fid; shot.bullet.fFrom = myPeerId; }
    const payload = { o: shot.origin.toArray(), d: shot.dir.toArray(), ...bulletNetParams(shot) };
    if (ctx.iAmHost) ctx.netBroadcast({ t: 'blt', from: myPeerId, ...payload });
    else ctx.netBroadcast({ t: 'fire', fid, o: shot.origin.toArray(), d: shot.dir.toArray(), ...bulletNetParams(shot) });
  }
}

/* ---- 二号武器：双管霰弹 ----
   ★ 只能沿机身水平方向发射（用户口径：机翼固定，无法像机枪那样上下摆动）。
     dir 只随机身 yaw，不含 pitch —— 想打高/打低必须靠机体本身俯仰。 */
const _sDir = new THREE.Vector3(), _sRight = new THREE.Vector3(), _sUp = new THREE.Vector3(0, 1, 0);
const _sE = new THREE.Euler();
let shotSide = 0;
function fireShotgun(f, ctx) {
  ctx.setFireT(DUEL.shotInterval);
  _sE.set(0, f.yaw, 0, 'YXZ');
  _sDir.set(0, 0, -1).applyEuler(_sE);
  _sRight.set(1, 0, 0).applyEuler(_sE);

  // 左右吊舱轮转（两具各打一轮）
  f.plane.group.updateMatrixWorld(true);
  const pod = f.plane.shotPods && f.plane.shotPods[shotSide];
  const origin = pod ? pod.getWorldPosition(new THREE.Vector3())
    : f.plane.guns[0].clone().applyMatrix4(f.plane.group.matrixWorld);
  shotSide = 1 - shotSide;

  let seq = ctx.myFireSeq || 0;
  for (let i = 0; i < DUEL.shotPellets; i++) {
    // 圆锥扩散：水平/垂直各自随机（tan 近似，扩散角很小）
    const ax = (Math.random() * 2 - 1) * DUEL.shotSpread;
    const ay = (Math.random() * 2 - 1) * DUEL.shotSpread * 0.85;
    const d = _sDir.clone().addScaledVector(_sRight, Math.tan(ax)).addScaledVector(_sUp, Math.tan(ay)).normalize();
    const b = spawnBullet(origin, d, DUEL.shotSpeed, 'me', DUEL.shotDmg, 0, f.vel, 12);   // 霰弹弹丸穿深低
    if (!b) break;
    b.life = DUEL.shotLife;
    if (ctx.mode !== 'practice') {
      seq += 1; ctx.setMyFireSeq(seq);
      b.fid = seq; b.fFrom = myPeerId;
      const payload = { o: origin.toArray(), d: d.toArray(), ...bulletNetParams({ bullet: b }) };
      if (ctx.iAmHost) ctx.netBroadcast({ t: 'blt', from: myPeerId, ...payload });
      else ctx.netBroadcast({ t: 'fire', fid: seq, o: origin.toArray(), d: d.toArray(), ...bulletNetParams({ bullet: b }) });
    }
  }
  if (ctx.audio) ctx.audio.shoot();
  effects.muzzle(origin, 1.1);
  effects.shake(DUEL.shotRecoil);
  updateWeaponHud();
}

/* ---- AI 的副武器：近距离双管霰弹 ----
   与玩家同一套弹道（水平发射、8 颗弹丸），但扩散放大 1.6 倍：
   否则 AI 会在 100m 外把玩家一轮带走，练习模式变成惩罚。 */
let botSgT = 0;
const _bSgFwd = new THREE.Vector3(), _bSgRight = new THREE.Vector3(), _bSgE = new THREE.Euler();
export function botFire(botEnt, id, dist) {
  if (!botEnt || !botEnt.plane) return null;
  if (dist > 130) return null;                       // 只有贴脸才用霰弹
  const now = performance.now();
  if (now < botSgT) return null;                     // 全局 1.4s 冷却（AI 之间也不会连喷）
  botSgT = now + 1400;

  const pl = botEnt.plane;
  _bSgE.set(0, botEnt.yaw || 0, 0, 'YXZ');           // ★ 只随机身 yaw：机翼固定，不能仰俯
  _bSgFwd.set(0, 0, -1).applyEuler(_bSgE);
  _bSgRight.set(1, 0, 0).applyEuler(_bSgE);
  pl.group.updateMatrixWorld(true);
  const pod = pl.shotPods && pl.shotPods[0];
  const origin = pod ? pod.getWorldPosition(new THREE.Vector3())
    : pl.guns[0].clone().applyMatrix4(pl.group.matrixWorld);

  for (let i = 0; i < DUEL.shotPellets; i++) {
    const ax = (Math.random() * 2 - 1) * DUEL.shotSpread * 1.6;
    const ay = (Math.random() * 2 - 1) * DUEL.shotSpread * 1.3;
    const d = _bSgFwd.clone()
      .addScaledVector(_bSgRight, Math.tan(ax))
      .addScaledVector(_sUp, Math.tan(ay))
      .normalize();
    const b = spawnBullet(origin, d, DUEL.shotSpeed, 'bot', DUEL.shotDmg, 0, botEnt.vel, 12);
    if (!b) break;
    b.life = DUEL.shotLife;
  }
  effects.muzzle(origin, 1.1);
  audio.shoot();
  return { origin: origin.clone(), dir: _bSgFwd.clone() };
}

/* ================= 相机（第三人称 / 机头枪镜，没有投弹视角）================= */
const _cDir = new THREE.Vector3(), _cPos = new THREE.Vector3(), _cLook = new THREE.Vector3();
export function cameraHeli2(c) {
  const f = c.f;
  const p = f.plane.group.position;
  const dt = c.dt || 0.016;
  const dir = viewDirection(f, _cDir);
  camAimValid = true;
  _aim.copy(p).addScaledVector(dir, DUEL.mgRange);

  let targetFov = 70;
  if (c.zoom) {
    f.plane.group.updateMatrixWorld(true);
    if (f.plane.gunCam) f.plane.gunCam.getWorldPosition(_cPos);
    else _cPos.copy(p).addScaledVector(dir, -2.4);
    _cPos.y += 0.02;
    camera.position.copy(_cPos);
    camera.up.set(0, 1, 0);
    _cLook.copy(_cPos).addScaledVector(dir, 140);
    camera.lookAt(_cLook);
    targetFov = 54;
  } else {
    camera.up.set(0, 1, 0);
    /* 第三人称距离：直升机突袭是 -17.5，这里收到 -15.2 —— 海上平台 96m 宽、周围没有任何近景参照物，
       同一架机身在同一套相机参数下"看起来"就是小一圈（实测两模式的包围盒与相机距离完全一致：
       7.9×3.0×10.5m / 18.3m / FOV70）。镜头拉近一点，机身占比回到正常观感。 */
    _cPos.copy(p).addScaledVector(dir, -15.2);
    _cPos.y += 5.0;
    if (f.vel) _cPos.addScaledVector(f.vel, 0.08);
    camera.position.lerp(_cPos, 1 - Math.exp(-13 * dt));
    if (camera.position.distanceTo(_cPos) > 24) camera.position.copy(_cPos);
    _cLook.copy(p).setY(p.y + 1.6).addScaledVector(dir, 60);
    camera.lookAt(_cLook);
  }
  if (Math.abs(camera.fov - targetFov) > 0.2) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 8);
    camera.updateProjectionMatrix();
  }
  if (effects && effects.shakeAmp > 0.005) {
    const a = effects.shakeAmp * 0.9;
    camera.position.x += (Math.random() - 0.5) * a;
    camera.position.y += (Math.random() - 0.5) * a;
    camera.position.z += (Math.random() - 0.5) * a;
  }
  return true;
}

/* ================= HUD（武器文案）================= */
export function hudHeli2(ctx0) {
  const ctx = ctx0 || {};
  const f = me;
  if (!f || f.kind !== 'heli') return null;
  if (planeWeapon === 'shot') return '💥 双管霰弹';
  return '🔫 机炮' + (ctx.zoom ? '（机头枪镜）' : '');
}

/* ================= 每帧（只在玩家自己开直升机时跑）================= */
export function updateHeli2(dt, ctx0) {
  const ctx = ctx0 || {};
  const f = me;
  const ch = document.getElementById('crosshair');
  const pr = document.getElementById('planeReticle');
  const alive = !!(f && f.alive && !ctx.roundOver && f.kind === 'heli');
  const gunCam = alive && !!ctx.zoom;   // 右键开镜 = 机头枪镜（与直升机突袭完全同一套 HUD）
  if (ch) ch.style.display = (alive && !gunCam) ? '' : 'none';
  if (pr) pr.style.display = (alive && !gunCam) ? '' : 'none';
  if (gunCam) setCamUi(planeWeapon === 'shot' ? 'shot' : 'gun', f.plane.group.position.y);
  else setCamUi(null);
}

/* ================= 平台：命中判定 / 伤害 / 同步 ================= */
const _bp = new THREE.Vector3();

/* 线段 vs 平台的实体盒（甲板、井架、集装箱）——点采样即可，子弹一帧最多几十米，
   盒体最小边也有 2.6m，采样步长 ≤6m 足够。 */
function segHitRig(rig, b) {
  const boxes = rig.boxes;
  const dx = b.pos.x - b.prev.x, dy = b.pos.y - b.prev.y, dz = b.pos.z - b.prev.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const n = Math.min(10, Math.max(2, Math.ceil(dist / 5)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const x = b.prev.x + dx * t, y = b.prev.y + dy * t, z = b.prev.z + dz * t;
    for (let k = 0; k < boxes.length; k++) {
      const c = boxes[k];
      if (y > c.y0 && y < c.y1 && Math.abs(x - c.x) < c.hx && Math.abs(z - c.z) < c.hz) return true;
    }
  }
  return false;
}

/* 子弹撞平台（loop.js 的 MODE.bulletHit 钩子）：命中即消耗子弹。
   只有「我自己打出的子弹」结算伤害 —— 别人的弹在本端只是视觉特效，由他自己的机器结算。 */
export function bulletHit(b) {
  if (!RIGS.length) return false;
  for (let i = 0; i < RIGS.length; i++) {
    const rig = RIGS[i];
    // 距离粗筛：子弹一帧最多几十米，离平台中心 300m 以上连采样都不必做
    const ddx = b.pos.x - rig.x, ddz = b.pos.z - rig.z;
    if (ddx * ddx + ddz * ddz > 90000) continue;
    if (!segHitRig(rig, b)) continue;
    const mine = (b.src === 'me');
    if (!rig.dead && mine) {
      const dmg = Math.max(1, Math.round(b.dmg * bulletDmgFactor(b)));
      hitRig(rig, dmg);
      effects.sparks(b.pos, rig.dead ? 0xffb14a : 0xcfd6dd);
    } else {
      effects.sparks(b.pos, 0xcfd6dd);
    }
    return true;
  }
  return false;
}

/* 本端打出的伤害：房主/练习直接结算，客户端累计后批量上报（每 0.2s 一条，避免每发一条） */
const pendRig = new Map();
let pendT = 0;
function hitRig(rig, dmg) {
  if (mode === 'practice' || iAmHost) { rigDamage(rig.id, dmg); return; }
  pendRig.set(rig.id, (pendRig.get(rig.id) || 0) + dmg);
}

/* 房主：平台扣血 + 打炸 + 广播（netev 的 rigHit 也走这里） */
const dirtyRigs = new Set();
export function rigDamage(id, dmg) {
  const rig = RIGS.find((r) => r.id === id);
  if (!rig || rig.dead || dmg <= 0) return;
  rig.hp = Math.max(0, rig.hp - dmg);
  dirtyRigs.add(id);
  if (rig.hp <= 0) destroyRig(rig, true);
}

function destroyRig(rig, broadcast) {
  if (rig.dead) return;
  rig.dead = true;
  rig.fireG.visible = true;
  const c = new THREE.Vector3(rig.x, rig.deckTop + 2, rig.z);
  effects.explosion(c, 3.2);
  effects.explosion(new THREE.Vector3(rig.x + 12, rig.deckTop + 6, rig.z - 8), 2.0);
  audio.explosionAt(c);
  rigBlast(rig);   // 打炸瞬间的大范围伤害（用户要求："给周围造成大范围伤害的同时起大火"）
  if (broadcast && mode !== 'practice' && iAmHost) {
    netBroadcast({ t: 'rig', id: rig.id, hp: 0, dead: 1 });
  }
}

/* 平台爆炸的范围伤害：中心 160、边缘 40（半径 = 平台半径 × 2.4，大平台约 115m、小平台约 82m）。
   房主权威：本机自己走 applyMeDamage / hostSettleHit，其他单位走 hostSettleHit（会广播 hit，
   受害者本地据此扣血，不依赖下一次 20Hz sync）。
   练习模式没有房主，本地直接判。 */
function rigBlast(rig) {
  const R = rig.r * 2.4;
  const cy = rig.deckTop + 4;
  const dmgAt = (p) => {
    const dx = p.x - rig.x, dy = p.y - cy, dz = p.z - rig.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > R) return 0;
    return Math.round(40 + 120 * (1 - d / R));
  };
  const pos = [rig.x, cy, rig.z];
  if (me && me.alive && myPlane) {
    const dmg = dmgAt(myPlane.group.position);
    if (dmg > 0) {
      if (mode === 'practice') applyMeDamage(dmg);
      else if (iAmHost) hostSettleHit('', myPeerId, '平台爆炸', true, dmg, pos);
    }
  }
  if (mode !== 'practice' && !iAmHost) return;   // 客户端等房主的 hit 广播
  for (const id in planes) {
    const pl = planes[id];
    if (!pl.alive || !pl.plane) continue;
    const dmg = dmgAt(pl.plane.group.position);
    if (!dmg) continue;
    if (mode === 'practice') {
      pl.hp -= dmg;
      if (pl.hp <= 0) { setLastDmgFrom(null); peerDie(id); }
    } else if (iAmHost) {
      hostSettleHit('', id, '平台爆炸', true, dmg, pos);
    }
  }
}

/* 客户端：应用房主广播的平台血量 */
export function rigSync(d) {
  const rig = RIGS.find((r) => r.id === d.id);
  if (!rig) return;
  if (d.dead) { destroyRig(rig, false); return; }
  const hp = Math.max(0, Math.min(rig.maxHp, d.hp | 0));
  if (hp < rig.hp) rig.hp = hp;
}

/* ================= 火焰伤害 =================
   只判定「本机玩家」与（练习模式的）AI：联机时每台机器只知道自己的精确位置，
   由受害者本地上报 envDmg、房主权威扣血 —— 和撞地/出界同一条链路。
   好处：房主不需要在 20Hz 插值的远端位置上做火焰判定（那样会漏判/误判）。 */
let fireAcc = 0, fireT = 0, fireWarnT = 0;
function updateFireDamage(dt) {
  if (STATE.roundOver) return;
  // 本机玩家
  if (me && me.alive && myPlane && !STATE.roundOver) {
    const p = myPlane.group.position;
    let dps = 0, inCore = false;
    for (let i = 0; i < RIGS.length; i++) {
      const r = RIGS[i];
      if (!r.dead) continue;
      if (p.y < r.deckTop - 4 || p.y > r.deckTop + r.fireH) continue;
      const dx = p.x - r.x, dz = p.z - r.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r.edgeR * r.edgeR) continue;
      const coreR = r.r * DUEL.rigFireCoreRatio;
      if (d2 < coreR * coreR) { inCore = true; break; }
      dps += DUEL.rigFireEdgeDps;
    }
    if (inCore) {
      showPart('被火焰吞没');
      applyMeDamage(999);
      if (mode !== 'practice' && !iAmHost && hostPeerId) netSendEventTo(hostPeerId, { t: 'died', id: myPeerId });
      return;
    }
    if (dps > 0) {
      fireAcc += dps * dt;
      fireT -= dt; fireWarnT -= dt;
      if (fireAcc >= 1 && fireT <= 0) {
        fireT = 0.25;
        const dm = Math.max(1, Math.round(fireAcc));
        fireAcc = 0;
        applyMeDamage(dm);
        if (mode !== 'practice' && !iAmHost && hostPeerId) netSendEventTo(hostPeerId, { t: 'envDmg', dmg: dm });
        if (fireWarnT <= 0) { fireWarnT = 1.6; showPart('高温灼伤'); }
      }
    } else {
      fireAcc = 0;
    }
  }
  // 练习模式：AI 直升机也在火里烧
  if (mode === 'practice') {
    for (const id in planes) {
      const pl = planes[id];
      if (!pl.alive || !pl.plane) continue;
      const p = pl.plane.group.position;
      for (let i = 0; i < RIGS.length; i++) {
        const r = RIGS[i];
        if (!r.dead) continue;
        if (p.y < r.deckTop - 4 || p.y > r.deckTop + r.fireH) continue;
        const dx = p.x - r.x, dz = p.z - r.z, d2 = dx * dx + dz * dz;
        if (d2 > r.edgeR * r.edgeR) continue;
        const coreR = r.r * DUEL.rigFireCoreRatio;
        const dm = (d2 < coreR * coreR) ? 999 : DUEL.rigFireEdgeDps * dt;
        pl.hp -= dm;
        if (pl.hp <= 0) { setLastDmgFrom(null); peerDie(id); }
        break;
      }
    }
  }
}

/* ================= 全局每帧：火焰动画 / 伤害 / 血量广播 ================= */
let firePhase = 0;
export function tickDuel(dt) {
  // 死亡瞬间 updateHeli2 不再被调用（只在存活分支里跑），枪镜遮罩必须在这里收
  if (!me || !me.alive) setCamUi(null);
  if (!RIGS.length) return;
  // 火焰跳动 + 黑烟上升
  firePhase += dt;
  for (let i = 0; i < RIGS.length; i++) {
    const rig = RIGS[i];
    if (!rig.dead) continue;
    const fl = rig.flames;
    for (let k = 0; k < fl.length; k++) {
      const f = fl[k];
      const s = 0.82 + 0.28 * Math.sin(firePhase * (5.5 + (k % 3)) + f.phase);
      f.mesh.scale.set(s, 0.85 + 0.45 * s, s);
      f.mesh.material.opacity = 0.48 + 0.20 * s;
    }
    if (rig.glow) rig.glow.material.opacity = 0.22 + 0.10 * Math.sin(firePhase * 4.2);
    for (let k = 0; k < rig.smokes.length; k++) {
      const s = rig.smokes[k];
      s.position.y += s.userData.spd * dt;
      s.position.x += s.userData.drift * dt;
      if (s.position.y > s.userData.y0 + 90) {
        s.position.y = s.userData.y0;
        s.position.x -= s.userData.drift * 90 / Math.max(1, s.userData.spd);
      }
      s.material.opacity = 0.16 + 0.10 * Math.sin(firePhase * 1.7 + k);
    }
  }

  updateFireDamage(dt);

  // 非房主：把累计伤害批量上报（0.2s 一条）
  if (mode !== 'practice' && !iAmHost && hostPeerId) {
    pendT -= dt;
    if (pendT <= 0 && pendRig.size) {
      pendT = 0.2;
      for (const [id, d] of pendRig) netSendEventTo(hostPeerId, { t: 'rigHit', id, dmg: d });
      pendRig.clear();
    }
  }
  // 房主：平台血量变化合并广播（0.2s 一次，打炸时立即广播过，这里只同步血量）
  if (mode !== 'practice' && iAmHost && dirtyRigs.size) {
    pendT -= dt;
    if (pendT <= 0) {
      pendT = 0.2;
      for (const id of dirtyRigs) {
        const rig = RIGS.find((r) => r.id === id);
        if (rig && !rig.dead) netBroadcast({ t: 'rig', id, hp: Math.round(rig.hp), dead: 0 });
      }
      dirtyRigs.clear();
    }
  }
}

/* ================= 回合 / 会话清理 ================= */
export function roundReset() {
  const f = me;
  if (f && f.kind === 'heli') resetHeli(f, f.yaw);
  resetRigs();
  setCamUi(null);
  setReticleVisible(true);   // 上一回合死在枪镜里 → 准星别带进新回合
}

export function sessionEnd() {
  resetRigs();
  setCamUi(null);
  /* 枪镜（右键开镜）把两个准星都藏了，退出时还原 —— 否则内联 display:none
     会跟到下一个模式（防空车自己不开准星 → 整局看不到，用户反馈）。 */
  setReticleVisible(true);
}

function resetRigs() {
  pendRig.clear();
  dirtyRigs.clear();
  for (const r of RIGS) {
    r.hp = r.maxHp;
    r.dead = false;
    if (r.fireG) r.fireG.visible = false;
    for (const s of r.smokes) s.position.y = s.userData.y0;
  }
}

/* ================= 菜单展示 / 清理 ================= */
let menuRefs = [];
export function menuCleanup() {
  for (const g of menuRefs) scene.remove(g);
  menuRefs = [];
  sessionEnd();
}

export function menuProp(p, ctx) {
  if (p.kind !== 'heli') return false;
  const h = buildHeli(p.color, { shotgun: true, benches: false });
  ctx.scene.add(h.group);
  if (p.scale) h.group.scale.setScalar(p.scale);
  h.group.position.fromArray(p.pos);
  if (p.rot) h.group.quaternion.setFromEuler(new THREE.Euler(p.rot[0] || 0, p.rot[1] || 0, 0, 'YXZ'));
  if (h.prop) h.prop.rotation.y = 0.4;
  menuRefs.push(h.group);
  return true;
}

/* ================= 练习编成：玩家直升机 vs AI 直升机 ================= */
export function spawnPractice(ctx) {
  const { THREE, scene, side } = ctx;
  ctx.set.myTeam(side === 1 ? 1 : 0);
  ctx.set.meIsAAGun(false);
  ctx.set.myPlane(ctx.buildAir(ctx.color.ally)); scene.add(ctx.myPlane.group);
  const ent = ctx.makeAir(ctx.myPlane);
  ctx.set.me(ent);
  resetHeli(ent, ctx.myTeam === 0 ? 0 : Math.PI);
  ctx.myPlane.group.position.set(0, 110, 250);

  const h = ctx.buildAir(ctx.color.foe); scene.add(h.group);
  const ent2 = ctx.makeAir(h);
  resetHeli(ent2, ctx.myTeam === 0 ? Math.PI : 0);
  h.group.position.set(0, 108, -250);
  const ai = new HeliDuelBot(h);
  ctx.planes['bot'] = {
    id: 'bot', plane: h, team: 1 - ctx.myTeam, slot: 0,
    alive: true, hp: 100, tPos: new THREE.Vector3(), tQuat: new THREE.Quaternion(),
    lastState: 0, isBot: true, bot: ai,
  };
}
