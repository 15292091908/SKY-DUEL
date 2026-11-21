// js/modes/heli/index.js —— 直升机突袭（直升机 vs 防空车）【游戏内模式模块】· v3.9.0
//
// 操控：鼠标 = 视角（1:1，小准星恒在屏幕中心 = 弹道），机头缓慢追随视角；
//   W/S 前后；A/D 纯横向平移；Q/E 升降；可悬停；前飞自动低头、转弯压坡度
//   一号武器 机枪（右键 = 机头枪镜：隐藏常规准星，改用摄像机准星，能看到枪口火焰）
//   二号武器 航空炸弹（继承载机速度的抛物线，顶部投弹视角 + 大号落点投影，不穿模）
import * as THREE from 'three';
import { scene, camera, effects } from '../../core.js?v=1572';
import { me, meIsAAGun, planeWeapon, myPeerId, setPlaneWeapon, planes, aaguns, setAimYaw, setAimPitch } from '../../state.js?v=1572';
import { spawnRocketFx, fireGun, bulletNetParams, updateWeaponHud } from '../../combat.js?v=1572';
import { showPart, setReticleVisible } from '../../hud.js?v=1572';
import { buildHeli, makeHeli, flightHeli, aimHeli as aimHeliBase, mgDirection, viewDirection, resetHeli, buildBomb, setCamUi } from '../../heli.js?v=1572';
import { HeliBot } from './ai.js?v=1572';
import { partDamage } from './damage.js?v=1572';

// ── 本模式参数 ──
export const HELI_MODE = {
  mgInterval: 0.042,      // 机枪射速（≈24 发/秒）
  mgSplash: 4,            // 机枪对地溅射
  mgRange: 600,           // 弹道汇聚距离（子弹飞向准星 600m 处 → 命中点 = 准星）
  bombFallAccel: 9.8,     // 炸弹重力（m/s²，真实自由落体；旧版写 38 是放大的）
  bombBlastR: 40,
  bombLethalR: 20,
  /* 向下弹射初速（v3.19.3 从 2 提到 28）。真实挂架是**气动弹射**把弹压离挂架，
     不是松手自由落体。这是唯一能同时「落得更快 + 投弹距离更短」的量：
       · 质量在无空气阻力时不影响下落时间（伽利略），调质量没有效果；
       · 加空气阻力只会让下落更慢（水平距离略短，但观感更飘），与诉求相反。
     28 m/s 时：120m 高 / 78 m/s 平飞 → 2.85 秒落地、落点 222m（原来 4.95s / 386m）。 */
  bombEject: 28,
  bombCooldown: 0.22,     // 两次投弹之间的最小间隔（一次点击只投一枚）
  bombViewH: 62,          // 投弹视角：机身正上方高度
  bombViewFov: 58,
  cruiseAlt: 75,
};

export const MODE = {

  sides: [
    { side: 0, name: '🚁 直升机突袭', desc: '低空悬停\n机炮与炸弹清场' },
    { side: 1, name: '🛡 防空拦截', desc: '操控高炮车\n击落来袭直升机' },
  ],
  sideLabel: (t) => (t === 1 ? '防空车' : '直升机'),
  dropLabels: ['🚁 直升机', '🛡 防空车'],
  lobbyTitle: '你是主机 · 选择突袭空域',
  matchName: '直升机突袭',

  planeLoadout: 'bomb',
  magReload: 5,
  /* v3.31：本模式的部位倍率（直升机 3/2/1.5 + 防空车 2/1.3/1），由本文件夹的 damage.js 拥有 */
  partDamage,
  gunSplash: 4,
  spawn: { airY: 120, airZ: 330 },
  spawnSpeed: 0,          // 直升机开局悬停（飞机是 95 巡航速度）

  menu: {
    world: 'base',
    scene: 'heli',
    target: [0, 9, 0],
    yaw: 0, pitch: 0.3, dist: 30,
    zoomBase: 30,
    props: [
      { kind: 'heli', color: 0x6ee7b7, pos: [-1.8, 7.4, -2.2], rot: [0.04, 2.35, 0], scale: 1.7 },
      { kind: 'aagun', color: 0x3fa7ff, pos: [9, 0, 4.5], bodyYaw: Math.PI * 0.72 },
    ],
  },

  buildAir: buildHeli,
  makeAir: makeHeli,
  flight: flightHeli,
  aim: aimHeli,
  fire: fireHeli,
  camera: cameraHeli,
  hud: hudHeli,
  update: updateHeli,
  tick: syncBombMeshes,   // 全局每帧（与玩家载具无关）：别人投的炸弹也要动
  spawnRemoteBomb,        // netev：其他玩家投下的炸弹按广播参数重建
  menuProp,
  menuCleanup,
  roundReset,
  sessionEnd,             // 回大厅/切模式时清弹体与落点投影（任何模式都能安全调用）
  spawnPractice,
};

/* ================= 瞄准（heli.js 的 aimHeli + 准星同步）================= */
export function aimHeli(f, ctx) {
  aimHeliBase(f, { ...ctx, setAim: (yaw, pitch) => { setAimYaw(yaw); setAimPitch(pitch); } });
}

/* ================= 开火（fire 钩子）================= */
const camAim = new THREE.Vector3();
let camAimValid = false;

export function fireHeli(kind, ctx) {
  const f = me;
  if (!f || !f.alive || ctx.roundOver) return;
  if (kind === 'secondary') { dropBomb(f, ctx); return; }

  ctx.setFireT(HELI_MODE.mgInterval);
  const mz = mgMuzzle(f);
  /* v3.30：机炮沿相机准星方向出膛（相机贴枪口，弹道与准星一致） */
  const dir = camAimValid
    ? camAim.clone().sub(mz).normalize()
    : mgDirection(f).clone();
  const shot = fireGun(f, 'me', { dir, muzzle: mz.clone(), muzzleScale: 0.05 });   // 相机贴枪口，火光必须很小
  if (ctx.audio) ctx.audio.shoot();
  effects.shake(0.028);   // 连发震屏（轻微）

  if (ctx.mode !== 'practice') {
    // ★ fid 必须取「自增之后」的值：loop.js 传进来的 ctx 是对象字面量快照，ctx.myFireSeq 只是拷贝，
    //   先 set 再读 ctx.myFireSeq 拿到的是上一发的序号 → 第一发 fid=0 → hitRep 被房主的 `if (!d.fid)` 丢弃、
    //   killBulletFx 也因 `if (!fid) return` 不销毁弹道（表现为：本地有火花、别人看到子弹穿过去继续飞）。
    const fid = ctx.myFireSeq + 1;
    ctx.setMyFireSeq(fid);
    if (shot.bullet) { shot.bullet.fid = fid; shot.bullet.fFrom = myPeerId; }
    const payload = { o: shot.origin.toArray(), d: shot.dir.toArray(), ...bulletNetParams(shot) };
    if (ctx.iAmHost) ctx.netBroadcast({ t: 'blt', from: myPeerId, ...payload });
    // ★ 必须带齐 s/dm/sl：接收端按上报速度重建弹道，漏了会退回 BULLET_MUZZLE 默认值
    //   （直升机子弹是 fighter.speed+BULLET_MUZZLE，悬停/高速能差 8%~20%，弹道位置对不上命中点）
    else ctx.netBroadcast({ t: 'fire', fid, o: shot.origin.toArray(), d: shot.dir.toArray(), ...bulletNetParams(shot) });
  }
}

function mgMuzzle(f) {
  f.plane.group.updateMatrixWorld(true);
  if (f.plane.muzzle) return f.plane.muzzle.getWorldPosition(new THREE.Vector3());
  return f.plane.guns[0].clone().applyMatrix4(f.plane.group.matrixWorld);
}

/* ================= 航空炸弹（继承载机速度 + 真实抛物线）================= */
const bombMeshes = new Map();
let bombCd = 0;

// 是否处于投弹视角：只看武器与库存（v3.10.4：投完最后一枚会立刻自动切回机枪 →
// 相机随之立即回到第三人称。旧版借"空中炸弹/落地保持期"继续维持投弹视角，
// 镜头还会跟着空中炸弹的抛物线落点越推越高、落地后又残留一截——用户明确不要）
function bombMode(f, weapon) {
  if (!f) return false;
  return weapon === 'bomb' && !!(f.bombs.left || f.bombs.right);
}

function releasePos(f, side, out) {
  // v3.10.5：释放点改用 mesh 层（挂弹模型所在层，随滚转/浮动一致）
  f.plane.group.updateMatrixWorld(true);
  return out.set(side === 'left' ? -1.18 : 1.18, -0.56, 0.45).applyMatrix4(f.plane.mesh.matrixWorld);
}

function dropBomb(f, ctx) {
  if (bombCd > 0) return;
  if (f.bombLatch) return;                 // ★ 同一次按住只投一枚（松开再点才投下一枚）
  if (!f.bombs.left && !f.bombs.right) { showPart('航空炸弹已投完'); return; }
  const side = f.bombs.left ? 'left' : 'right';
  f.bombs[side] = false;
  f.bombLatch = true;
  bombCd = HELI_MODE.bombCooldown;
  ctx.setFireT(0.2);
  if (f.bombRack && f.bombRack[side]) f.bombRack[side].visible = false;   // 挂弹模型离架（v3.10.5）

  const v0 = (f.vel ? f.vel.clone() : new THREE.Vector3()).setY((f.vel ? f.vel.y : 0) - HELI_MODE.bombEject);
  const pos = releasePos(f, side, new THREE.Vector3());
  const r = spawnRocketFx(pos, new THREE.Vector3(0, -1, 0), 'me', myPeerId);
  if (!r) { f.bombs[side] = true; f.bombLatch = false; return; }
  r.fuelT = 0;   // v3.17：炸弹没有助推段（燃料为 0），直接从无动力段起算
  r.grav = HELI_MODE.bombFallAccel;
  r.dragQ = 0;
  r.blastR = HELI_MODE.bombBlastR;
  r.lethalR = HELI_MODE.bombLethalR;
  r.isBomb = true;
  r.life = 30;
  r.vel.copy(v0);                     // ★继承载机速度：不再"垂直掉铁块"
  r.releaseY = pos.y;
  if (r.mesh) r.mesh.visible = false;
  const bm = buildBomb();
  bm.position.copy(pos);
  bm.userData.dropped = true;   // 标记「已投下的弹体」（挂弹是 plane.mesh 的子节点，不会混）
  scene.add(bm);
  bombMeshes.set(r, bm);
  if (ctx && ctx.audio) ctx.audio.shoot();
  // ★ 联机广播（v3.11.0）：之前炸弹完全没有网络消息 —— 别人根本看不到你投的弹，
  //   而且 r.fid 恒为 0（killBulletFx 首行 `if (!fid) return` 直接跳过，命中/爆炸后弹道永不销毁）。
  //   复用火箭的 rkt / fireRocket 协议，额外带 bomb 标记 + 初速/重力/杀伤半径，接收端按同一套物理重建。
  if (ctx && ctx.mode !== 'practice') {
    const fid = (ctx.myFireSeq || 0) + 1;
    ctx.setMyFireSeq(fid);
    r.fid = fid; r.fFrom = myPeerId;
    const msg = {
      o: pos.toArray(), d: [0, -1, 0], fid, bomb: 1, v: v0.toArray(),
      g: HELI_MODE.bombFallAccel, br: HELI_MODE.bombBlastR, lr: HELI_MODE.bombLethalR, life: 30,
    };
    if (ctx.iAmHost) ctx.netBroadcast({ t: 'rkt', from: myPeerId, ...msg });
    else ctx.netBroadcast({ t: 'fireRocket', ...msg });   // 房主收到后重建并广播 rkt
  }
  // ★ 最后一枚离架就立刻切回机枪（不等落地）；投弹视角只跟武器状态走 → 立即回第三人称
  if (!f.bombs.left && !f.bombs.right) {
    /* ★ 必须切回 'gun'：全游戏的弹夹 / 武器条只认 'gun'｜'shot'，
       旧版写 'mg'（防空车武器名）导致机枪照常开火但永远不走弹夹、子弹数不掉。 */
    setPlaneWeapon('gun');
    showPart('航空炸弹已投完');
  }
  updateWeaponHud();
}

/* ================= 远程炸弹（其他玩家投下的） =================
   纯视觉：物理参数由广播带来（初速/重力/半径/寿命），与本机投弹完全一致；
   命中与伤害仍由投弹者走 hitRep → 房主校验 → hit 广播，本端不判定。 */
export function spawnRemoteBomb(o, dir, v, g, br, lr, life) {
  const pos = new THREE.Vector3().fromArray(o || [0, 0, 0]);
  const d = new THREE.Vector3().fromArray(dir || [0, -1, 0]).normalize();
  const r = spawnRocketFx(pos, d, 'foeVis', null);
  if (!r) return null;
  if (Array.isArray(v)) r.vel.fromArray(v);            // 继承投弹者当时的载机速度
  r.fuelT = 0;   // v3.17：炸弹没有助推段（燃料为 0），直接从无动力段起算
  r.grav = g || HELI_MODE.bombFallAccel;
  r.dragQ = 0;
  r.blastR = br || HELI_MODE.bombBlastR;
  r.lethalR = lr || HELI_MODE.bombLethalR;
  r.isBomb = true;
  r.life = life || 30;
  r.releaseY = pos.y;
  if (r.mesh) r.mesh.visible = false;                   // 用炸弹模型替代火箭模型
  const bm = buildBomb();
  bm.position.copy(pos);
  bm.userData.dropped = true;
  scene.add(bm);
  bombMeshes.set(r, bm);
  return r;
}

/* ================= 落点预测（与炸弹同一套物理）================= */
const _imp = new THREE.Vector3(), _rel = new THREE.Vector3();
export function predictImpact(f, out) {
  const p = f.plane.group.position;
  const v = f.vel || _rel.set(0, 0, 0);
  const y0 = Math.max(1, p.y - 0.56);
  const vy = v.y - HELI_MODE.bombEject;      // 离架瞬间的垂直速度（向下为负）
  const g = HELI_MODE.bombFallAccel;
  /* 解 y0 + vy·t − ½·g·t² = 0 → t = (vy + √(vy² + 2g·y0)) / g。
     ★ 这里是 +vy，不是 −vy：写成 −vy 相当于把「向下弹射」当成「向上抛」，
       弹射越快预测圈越远（实测速度 46 m/s 时偏 33m）。 */
  const t = (vy + Math.sqrt(vy * vy + 2 * g * y0)) / g;
  return out.set(p.x + v.x * t, 0, p.z + v.z * t);
}

/* ================= 落点投影（现代战舰式大号投影，不穿模）================= */
let marker = null;
function ensureMarker() {
  if (marker) return marker;
  const grp = new THREE.Group();
  const M = (geo, color, opacity) => {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, side: THREE.DoubleSide,
      depthWrite: false, depthTest: false,   // ★ 永远画在地形/楼房之上 → 不再被地面吞掉
    }));
    m.renderOrder = 999;
    m.frustumCulled = false;
    return m;
  };
  // 外层：爆炸半径
  const outer = M(new THREE.RingGeometry(HELI_MODE.bombBlastR - 2.2, HELI_MODE.bombBlastR, 72), 0xff6b4a, 0.55);
  outer.rotation.x = -Math.PI / 2; grp.add(outer); grp.userData.outer = outer;
  // 内层：致死半径
  const inner = M(new THREE.RingGeometry(HELI_MODE.bombLethalR - 1.1, HELI_MODE.bombLethalR, 56), 0xffd24a, 0.85);
  inner.rotation.x = -Math.PI / 2; grp.add(inner);
  // 内圈淡填充
  const fill = M(new THREE.CircleGeometry(HELI_MODE.bombLethalR, 48), 0xffb43a, 0.10);
  fill.rotation.x = -Math.PI / 2; fill.position.y = -0.02; grp.add(fill);
  // 中心十字
  for (const r of [0, Math.PI / 2]) {
    const b = M(new THREE.PlaneGeometry(HELI_MODE.bombLethalR * 2.3, 0.65), 0xffe08a, 0.9);
    b.rotation.x = -Math.PI / 2; b.rotation.z = r; b.position.y = 0.02; grp.add(b);
  }
  const dot = M(new THREE.CircleGeometry(1.5, 20), 0xfff3c4, 0.95);
  dot.rotation.x = -Math.PI / 2; dot.position.y = 0.03; grp.add(dot);
  // 竖直投放引导线（从飞机 → 落点）
  const line = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.28, 1, 8, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffa46b, transparent: true, opacity: 0.36, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
  line.renderOrder = 998; line.frustumCulled = false;
  grp.add(line); grp.userData.line = line;
  grp.visible = false;
  scene.add(grp);
  marker = grp;
  return marker;
}

/* ================= 炸弹模型同步（每帧、与玩家载具无关）=================
   ★ 必须由 loop 的全局 tick 调用，不能挂在 updateHeli 里 ——
   updateHeli 只在「玩家自己开直升机」时执行，房主开防空车时别人的炸弹
   会停在投弹点悬浮，直到爆炸才消失（用户反馈的联机 bug）。 */
const _bDir = new THREE.Vector3(), _up = new THREE.Vector3(0, 0, -1);
export function syncBombMeshes() {
  for (const [r, bm] of bombMeshes) {
    if (!r.active) {
      scene.remove(bm); bombMeshes.delete(r);
      continue;
    }
    bm.position.copy(r.pos);
    if (r.vel.lengthSq() > 1e-3) {
      _bDir.copy(r.vel).normalize();
      bm.quaternion.setFromUnitVectors(_up, _bDir);   // 炸弹模型机头朝 -Z
    }
  }
}

/* ================= 每帧（落点投影 / 视角 HUD；只在玩家开直升机时跑）================= */
export function updateHeli(dt, ctx0) {
  const ctx = ctx0 || {};
  if (bombCd > 0) bombCd -= dt;
  const f = me;

  const mk = ensureMarker();
  const ch = document.getElementById('crosshair');
  const pr = document.getElementById('planeReticle');
  const showBoth = (on) => {
    if (ch) ch.style.display = on ? '' : 'none';
    if (pr) pr.style.display = on ? '' : 'none';
  };

  if (!f || !f.alive || ctx.roundOver || f.kind !== 'heli') {
    mk.visible = false; setCamUi(null); showBoth(false); return;
  }

  if (!ctx.firing) f.bombLatch = false;      // 松开开火键 → 下一枚解锁
  const usable = bombMode(f, ctx.weapon);
  const gunCam = !!ctx.zoom && !usable;
  if (usable) {
    const p = f.plane.group.position;
    // 落点环只跟"下一枚"的预测走（按当前速度实时算）：
    //   · 不再跟着已投出的炸弹 → 按 S 减速时不会先冲前、落地后瞬间跳到机身后方
    //   · 最后一枚投完（武器已切机枪）只保留视角看爆炸，不再画一个不存在的落点
    const hasBombs = !!(f.bombs.left || f.bombs.right);
    if (hasBombs) {
      predictImpact(f, _imp);
      mk.position.set(_imp.x, 0.6, _imp.z);
      const line = mk.userData.line;
      const dx = _imp.x - p.x, dz = _imp.z - p.z, dy = _imp.y - p.y;
      const len = Math.max(1, Math.hypot(dx, dy, dz));
      line.position.set((p.x + _imp.x) / 2 - mk.position.x, (p.y + _imp.y) / 2 - mk.position.y, (p.z + _imp.z) / 2 - mk.position.z);
      line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), _bDir.set(dx, dy, dz).normalize());
      line.scale.set(1, len, 1);
      const pulse = 0.45 + 0.25 * Math.sin(performance.now() / 320);
      mk.userData.outer.material.opacity = pulse;
      mk.visible = true;
    } else {
      mk.visible = false;
    }
    showBoth(false);
    setCamUi('bomb', p.y);
  } else {
    mk.visible = false;
    if (gunCam) { showBoth(false); setCamUi('gun', f.plane.group.position.y); }
    else { showBoth(true); setCamUi(null); }
  }
}

/* ================= 相机（camera 钩子）================= */
const _cDir = new THREE.Vector3(), _cPos = new THREE.Vector3(), _cLook = new THREE.Vector3();
export function cameraHeli(c) {
  const f = c.f;
  const p = f.plane.group.position;
  const dt = c.dt || 0.016;
  const dir = viewDirection(f, _cDir);      // ★绝对视角（不再跟炮塔限幅抖）
  camAimValid = true;
  camAim.copy(p).addScaledVector(dir, HELI_MODE.mgRange);

  let targetFov = 70;
  if (bombMode(f, c.weapon)) {
    /* ---- 投弹视角：机身正上方俯视，**屏幕上方 = 机头方向**（跟随直升机朝向） ----
       注视点取"机身↔落点"中点并垂直向下看：机身和落点都在画面里，且镜头不会前后翻转
       （旧版用世界北朝上 + lookAt 落点，落点跑到身后时视角会乱翻） */
    const hasBombs = !!(f.bombs.left || f.bombs.right);
    if (hasBombs) predictImpact(f, _imp);
    else _imp.set(p.x, 0, p.z);
    const midX = (p.x + _imp.x) * 0.5, midZ = (p.z + _imp.z) * 0.5;
    const dist = Math.hypot(_imp.x - p.x, _imp.z - p.z);
    const viewH = Math.max(HELI_MODE.bombViewH, HELI_MODE.bombViewH + dist * 0.62);   // 落点越远，镜头升得越高（保证都在画面里）
    _cPos.set(midX, p.y + viewH, midZ);
    if (f.vel) _cPos.addScaledVector(f.vel, -0.06);
    camera.up.set(-Math.sin(f.yaw), 0, -Math.cos(f.yaw));           // ★跟随机头（yaw），不跟滚转
    camera.position.lerp(_cPos, 1 - Math.exp(-9 * dt));
    if (camera.position.distanceTo(_cPos) > 24) camera.position.copy(_cPos);
    _cLook.set(midX, 0.4, midZ);
    camera.lookAt(_cLook);
    targetFov = HELI_MODE.bombViewFov;
  } else if (c.zoom) {
    /* ---- 机头枪镜：贴在机头下方（枪管上方），沿视角看 → 屏幕下缘能看到枪口火焰 ---- */
    f.plane.group.updateMatrixWorld(true);
    if (f.plane.gunCam) f.plane.gunCam.getWorldPosition(_cPos);
    else _cPos.copy(p).addScaledVector(dir, -2.4);
    _cPos.y += 0.02;
    camera.position.copy(_cPos);
    camera.up.set(0, 1, 0);                    // ★必须在 lookAt 之前：否则会沿用上一帧（投弹视角）的 up，画面会横滚
    _cLook.copy(_cPos).addScaledVector(dir, 140);
    camera.lookAt(_cLook);
    targetFov = 54;
  } else {
    camera.up.set(0, 1, 0);
    /* ---- 第三人称：在视角后方，能完整看到机身与旋翼 ----
       v3.10.4 速度前馈：lerp 跟随在满速（108m/s）下稳态落后 ≈ v/13 ≈ 8.3m，
       旧版超过 7m 就硬切 copy → 高速时每十几帧"向前一抽"一次。
       前馈把目标点沿速度方向前推，稳态差距归零；硬切阈值放宽到 26m 只兜底回合重置/传送。 */
    _cPos.copy(p).addScaledVector(dir, -17.5);
    _cPos.y += 5.4;
    if (f.vel) _cPos.addScaledVector(f.vel, 0.08);
    camera.position.lerp(_cPos, 1 - Math.exp(-13 * dt));
    if (camera.position.distanceTo(_cPos) > 26) camera.position.copy(_cPos);
    _cLook.copy(p).setY(p.y + 1.6).addScaledVector(dir, 60);
    camera.lookAt(_cLook);
    targetFov = 70;
  }
  if (Math.abs(camera.fov - targetFov) > 0.2) {
    camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 8);
    camera.updateProjectionMatrix();
  }
  // 模式相机在 camera.js 的通用震屏之前 return，这里自己补一次（爆炸/开火手感）
  if (effects && effects.shakeAmp > 0.005) {
    const a = effects.shakeAmp * 0.9;
    camera.position.x += (Math.random() - 0.5) * a;
    camera.position.y += (Math.random() - 0.5) * a;
    camera.position.z += (Math.random() - 0.5) * a;
  }
  return true;
}

/* ================= HUD 文案（hud 钩子）================= */
export function hudHeli(ctx0) {
  const ctx = ctx0 || {};
  const f = me;
  if (!f || f.kind !== 'heli') return null;
  if (planeWeapon === 'bomb') {
    const n = (f.bombs.left ? 1 : 0) + (f.bombs.right ? 1 : 0);
    return n > 0 ? '💣 航空炸弹 · ' + n + ' 枚' : '💣 航空炸弹已投完';
  }
  return '🔫 机枪' + (ctx.zoom ? '（机头枪镜）' : '');
}

/* ================= 会话清理（回大厅 / 切模式 / 换回合都走它）=================
   ★ 必须能在**任何模式**下安全执行：炸弹模型是 scene 的顶层对象，
   挂在 heli 的 roundReset 上只在"下一局还是直升机"时才清；回大厅后切到空战，
   modeDef() 变成 air，heli 的 roundReset 再也不执行 → 空中那枚模型永远飘着。 */
export function sessionEnd() {
  for (const [, bm] of bombMeshes) scene.remove(bm);
  bombMeshes.clear();
  if (marker) marker.visible = false;
  setCamUi(null);
  /* 投弹视角 / 枪镜会把两个准星都藏起来（updateHeli 的 showBoth(false)）。
     必须在退出时还原：否则内联 display:none 会跟着进下一个模式 ——
     防空车这类自己不管准星的玩法就整局没有准星（用户反馈）。 */
  setReticleVisible(true);
}

/* ================= 回合重置（roundReset 钩子）================= */
export function roundReset() {
  const f = me;
  if (f && f.kind === 'heli') resetHeli(f, f.yaw);
  sessionEnd();
}

/* ================= 菜单清理 / 展示 ================= */
let menuHeliRef = null;
export function menuCleanup() {
  if (menuHeliRef) { scene.remove(menuHeliRef.group); menuHeliRef = null; }
  // 从其它模式切过来时顺手收掉上一局的弹体与落点投影
  sessionEnd();
}

export function menuProp(p, ctx) {
  if (p.kind !== 'heli') return false;
  const h = buildHeli(p.color);
  ctx.scene.add(h.group);
  if (p.scale) h.group.scale.setScalar(p.scale);
  h.group.position.fromArray(p.pos);
  if (p.rot) h.group.quaternion.setFromEuler(new THREE.Euler(p.rot[0] || 0, p.rot[1] || 0, 0, 'YXZ'));
  if (h.prop) h.prop.rotation.y = 0.4;
  menuHeliRef = h;
  return true;
}

/* ================= 练习编成（spawnPractice）================= */
export function spawnPractice(ctx) {
  const { THREE, scene, side } = ctx;
  if (side === 1) {
    // 玩家开防空车，AI 直升机来袭
    ctx.set.myTeam(1); ctx.set.meIsAAGun(true);
    ctx.set.myAAGun(ctx.buildAAGun(ctx.color.ally)); scene.add(ctx.myAAGun.group);
    ctx.set.meAAGun(ctx.makeAAGun(ctx.myAAGun));
    ctx.myAAGun.group.position.copy(ctx.aagunSpawnPos(0, ctx.aaSpawns));
    const h = ctx.buildAir(ctx.color.foe); scene.add(h.group);
    const ent = ctx.makeAir(h);
    resetHeli(ent, Math.PI);
    h.group.position.set(0, HELI_MODE.cruiseAlt, -180);
    const _ai = new HeliBot(h);   // 直升机专属 AI：接近 → 悬停压制 → 被逼近才后退（js/modes/heli/ai.js）
    ctx.planes['bot'] = {
      id: 'bot', plane: h, team: 0, slot: 0,
      alive: true, hp: 100, tPos: new THREE.Vector3(), tQuat: new THREE.Quaternion(),
      lastState: 0, isBot: true, bot: _ai,
    };
  } else {
    // 玩家开直升机，地面 1 辆 AI 防空车
    ctx.set.myTeam(0); ctx.set.meIsAAGun(false);
    const h = ctx.buildAir(ctx.color.ally); scene.add(h.group);
    ctx.set.myPlane(h);
    const ent = ctx.makeAir(h);
    ctx.set.me(ent);
    resetHeli(ent, 0);
    h.group.position.set(0, 120, 260);
    for (let i = 0; i < 1; i++) {
      const ag = ctx.buildAAGun(ctx.color.foe); scene.add(ag.group);
      const ent2 = ctx.makeAAGun(ag);
      const id = i === 0 ? 'bot' : ('bot' + i);
      aaguns[id] = {
        id, aagun: ag, ent: ent2, team: 1, slot: i,
        alive: true, hp: ctx.AAGUN_HP,
        // tBodyYaw 必填（v3.10.6）：bot 掉出 AI 分支时 loop 的"远程同步"分支用
        // `tBodyYaw - ent.bodyYaw` 插值；缺字段 = undefined - 数值 = NaN →
        // 车体/炮塔旋转全变 NaN → 出膛点 NaN → 该车的火箭永远不判定碰撞/近炸
        tPos: new THREE.Vector3(), tTurretYaw: 0, tTurretPitch: 0, tBodyYaw: 0,
        lastState: 0, isBot: true, bot: new ctx.AAGunBot(ent2),
      };
      aaguns[id].aagun.group.position.copy(ctx.aagunSpawnPos(i, ctx.aaSpawns));
    }
  }
}

