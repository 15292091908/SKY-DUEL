// js/modes/tank/ai.js —— 坦克对决的 AI 车长
//
// 与防空车 AI 的区别：它打的是**地面目标**，不能用"炮塔对准就扫射"那套
// （炮是单发、装填几秒，打空一发就白给）。所以：
//   · 走位：维持在 260~520m 的直射距离，太近倒车、太远前进，并横向游走避免站桩；
//   · 瞄准：**阶梯式解算** —— 每 1.6~2.8s 才重新测距/算提前量一次，中间沿用旧解，
//            所以玩家横移/倒车能把它甩掉（真实炮长的节奏）。
//            每次解算叠一个距离相关的手抖，让它不是狙击手。
//   · 开火：对准度足够 + 装填完成 + 首发反应延迟结束才扣扳机。
//
// ★ v3.22 用户反馈"AI 强一点，但不能过强"：在 v3.21.1 偏弱的基础上回调一档
//   （手抖 −24%、解算 1.4~2.4s、间隔 6.6~9.6s、转速 0.95、首发 ×1.5、失误 20%）。
//   命中率约提升到 230m 17% / 413m 8%，仍然不是狙击手：玩家横移+倒车能甩掉解算，
//   配合 6.6~9.6s 的射击间隔，站着不动也扛得住半分钟以上。
import * as THREE from 'three';
import { TANK, tankMobility } from '../../tank.js?v=1572';

const _e = new THREE.Euler();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();

function wrapPi(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

export class TankBot {
  constructor(ent) {
    this.ent = ent;                 // makeTank 实体（aagun 模型 + bodyYaw/turretYaw/...）
    this.ent.bot = this;
    this.turretYaw = 0;
    this.turretPitch = 0.02;
    this.fireT = 0;
    this.age = 0;
    this.swayPhase = Math.random() * 6.28;
    this.basePos = null;
    this.patrolPos = null;
    this.patrolT = 0;
    this.mode = 'hold';
    this.holdT = 0;
    this._tp = null;
    this._tv = new THREE.Vector3();
    this.speed = 0;
    this.aimTick = 0;              // 阶梯解算计时
    this.aimPoint = new THREE.Vector3();
    this.hasAim = false;
    this.reactT = 0;               // 首次发现目标后的反应延迟
  }

  reset(pos, yaw) {
    const p = this.ent.aagun.group.position;
    p.copy(pos);
    this.ent.alive = true;
    this.ent.hp = 100;
    this.ent.aagun.group.visible = true;
    this.ent.bodyYaw = (yaw === undefined) ? (pos.z < 0 ? Math.PI : 0) : yaw;
    this.ent.turretYaw = 0;
    this.ent.turretPitch = 0.02;
    this.ent.speed = 0; this.ent.targetSpeed = 0;
    /* v3.30：新回合 / 重生把履带与发动机修好（本回合内不修复） */
    this.ent.trackL = false; this.ent.trackR = false; this.ent.engOut = false; this.ent.turretJammed = false; this.ent.immobilized = null;
    this.turretYaw = this.ent.bodyYaw; this.turretPitch = 0.02;
    /* 反应延迟：AI 不是"一出生就知道你在哪"。2.4~4s 内只转塔不扣扳机。 */
    this.fireT = 2.4 + Math.random() * 1.6;
    this.reactT = 2.4 + Math.random() * 1.6;
    this.shotsFired = 0;
    this.hasAim = false;
    this.aimTick = 0;
    this.age = 0;
    this.mode = 'hold'; this.holdT = 0;
    this.patrolPos = null; this.patrolT = 0;
    this.basePos = pos.clone();
    this._tp = null;
    this.swayPhase = Math.random() * 6.28;
  }

  update(dt, target, fireCb) {
    const ent = this.ent;
    if (!ent.alive) return;
    const p = ent.aagun.group.position;
    const t = target && target.plane ? target.plane.group.position : p;
    this.age += dt;

    // 目标速度（帧间差分，用于打提前量）
    if (!this._tp) { this._tp = t.clone(); this._tv.set(0, 0, 0); }
    else {
      _v1.copy(t).sub(this._tp);
      if (_v1.lengthSq() < 40000) this._tv.lerp(_v1.divideScalar(Math.max(dt, 1e-3)), 0.35);
      this._tp.copy(t);
    }
    const dist = p.distanceTo(t);

    /* ---- 瞄准：阶梯式解算（每 1.4~2.4s 一次） + 手抖 ---- */
    this.aimTick -= dt;
    if (this.aimTick <= 0 || !this.hasAim) {
      this.aimTick = 1.4 + Math.random() * 1.0;
      const shellT = Math.min(1.4, dist / TANK.apSpeed);
      const aim = _v2.copy(t).addScaledVector(this._tv, shellT * 0.8);
      aim.y += 2.3;                                     // 瞄炮塔/车体上部
      aim.y += 0.5 * 9.8 * shellT * shellT;             // 炮弹下坠
      /* 手抖：660m 处约 ±9m、230m 处约 ±5m。
         坦克一发定生死，AI 不能当狙击手 —— 这个量级下 230m 命中率约 12%、
         660m 约 3%，配合 7~10s 的射击间隔，玩家站着不动也能扛 60 秒以上。 */
      /* ★ 每次解算独立取随机偏移 —— 旧版用 sin(age) 生成，配合阶梯解算会退化成
         "一个固定的小偏移"：如果相位碰巧接近 0，AI 就会变成百发百中的狙击手
         （实测 413m 首发命中）。纯随机才有统计意义上的命中率。*/
      /* 手抖：210m 约 ±5.9m、413m 约 ±8.9m、660m 约 ±12.5m。
         车体判定球 r=3.0（直径 6m），所以 210m 命中率 ≈18%、413m ≈8%、660m ≈4%。
         再乘 80%（20% 算错一档）与首发 ×1.5，第一发仍然大概率打偏。 */
      let sway = (3.4 + dist * 0.018) * (0.50 + Math.random() * 0.65);
      if (!(this.shotsFired > 0)) sway *= 1.5;   // 第一发是测距校射，打得特别飘
      const sa = Math.random() * 6.283;
      aim.x += Math.cos(sa) * sway;
      aim.z += Math.sin(sa) * sway;
      aim.y += (Math.random() - 0.5) * sway * 0.30;
      /* 20% 概率"算错一档"：额外偏 5~11m，模拟炮长的失误 */
      if (Math.random() < 0.20) {
        const a = Math.random() * 6.28, r = 5 + Math.random() * 6;
        aim.x += Math.cos(a) * r; aim.z += Math.sin(a) * r;
      }
      this.aimPoint.copy(aim);
      this.hasAim = true;
    }
    const aim = this.aimPoint;

    /* ★ 方向必须从**炮口**算，不是从车体原点算：
       炮口在世界坐标里比原点高 2.74m，用原点算出来的 pitch 会让炮弹整条弹道高 2.7m
       （下坡对射时直接从目标头顶飞过去 —— 实测 AI 4 发 0 中）。 */
    const from = _v4.copy(p); from.y += 2.74;
    const dir = _v3.copy(aim).sub(from).normalize();
    const wantYaw = Math.atan2(-dir.x, -dir.z);
    const wantPitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    const maxTurn = 0.95 * dt;
    if (!ent.turretJammed) {
      this.turretYaw += THREE.MathUtils.clamp(wrapPi(wantYaw - this.turretYaw), -maxTurn, maxTurn);
      this.turretPitch += THREE.MathUtils.clamp(wantPitch - this.turretPitch, -maxTurn * 0.7, maxTurn * 0.7);
      this.turretPitch = THREE.MathUtils.clamp(this.turretPitch, TANK.groundPitchMin, TANK.groundPitchMax);
      ent.turretYaw = this.turretYaw;
      ent.turretPitch = this.turretPitch;
    } else {
      /* v3.31：炮塔卡死 → 保持当前朝向；AI 内部角度跟着冻结值走，避免下一回合解冻时跳变 */
      this.turretYaw = ent.turretYaw;
      this.turretPitch = ent.turretPitch;
    }

    /* ---- 走位：远则进、近则退，中间横向游走 ---- */
    let wantSpeed = 0;
    let bodyYawWant = ent.bodyYaw;
    if (dist > 500) {
      bodyYawWant = wantYaw;
      wantSpeed = 11.5;
    } else if (dist < 230) {
      /* ★ 倒车必须"车头不动、速度取负"。
         旧版把 bodyYawWant 转 180° 再给负速度 —— 两个反向抵消，AI 反而朝目标加速，
         实测会一路贴到 42m 才停（然后手抖再大也架不住贴脸）。 */
      bodyYawWant = wantYaw;
      wantSpeed = -7.5;
    } else {
      // 绕圈：每隔几秒换一次横移方向
      this.holdT -= dt;
      if (this.holdT <= 0) { this.holdT = 2.6 + Math.random() * 3; this.strafeDir = Math.random() < 0.5 ? -1 : 1; }
      bodyYawWant = wantYaw + (this.strafeDir || 1) * 0.95;
      wantSpeed = 7.2;
    }
    // 别开出地图
    const r = Math.hypot(p.x, p.z);
    if (r > 690) {
      bodyYawWant = Math.atan2(p.x, p.z);   // 朝地图中心
      wantSpeed = 10;
    }
    // 撞到房子后（引擎会把位置退回去）换个方向：这里用简单的随机扰动
    /* 卡住自解：引擎会把撞墙后的位置退回去，AI 如果一直朝同一方向推就会永远贴着墙。
       每 1.2s 检查一次实际位移，几乎没有位移就随机转 75°~160° 再倒一点。
       （v3.22 房子加到 25 间，街巷更窄，转角/倒车幅度都加大一档。） */
    this.stuckT = (this.stuckT || 0) + dt;
    if (this.stuckT > 1.2) {
      if (!ent.immobilized && this._lastPos && this._lastPos.distanceTo(p) < 1.2) {
        ent.bodyYaw += (Math.random() < 0.5 ? -1 : 1) * (1.3 + Math.random() * 1.5);
        ent.targetSpeed = -6;
      }
      this._lastPos = (this._lastPos || new THREE.Vector3()).copy(p);
      this.stuckT = 0;
    }
    /* v3.30：履带 / 发动机损伤 —— 断一侧不能朝该侧转，速度减半；全断或熄火就原地当炮台 */
    const _mob = tankMobility(ent);
    const _dy = wrapPi(bodyYawWant - ent.bodyYaw);
    if (!ent.immobilized && (_dy > 0 ? _mob.turnL : _mob.turnR)) {
      ent.bodyYaw += THREE.MathUtils.clamp(_dy, -0.9 * dt, 0.9 * dt);
    }
    ent.targetSpeed = wantSpeed * _mob.speedK;
    ent.speed += (ent.targetSpeed - ent.speed) * Math.min(1, dt * 1.6);
    if (Math.abs(ent.speed) > 0.05) {
      const fx = -Math.sin(ent.bodyYaw), fz = -Math.cos(ent.bodyYaw);
      p.x += fx * ent.speed * dt;
      p.z += fz * ent.speed * dt;
    }

    /* ---- 开火判定 ---- */
    this.fireT -= dt;
    this.reactT -= dt;
    _e.set(this.turretPitch, this.turretYaw, 0, 'YXZ');
    const fwd = _v1.set(0, 0, -1).applyEuler(_e);
    const toT = _v3.copy(t).add(new THREE.Vector3(0, 1.8, 0)).sub(p).normalize();
    const aligned = fwd.dot(toT);
    if (this.fireT <= 0 && this.reactT <= 0 && dist < 640 && aligned > 0.9975) {
      this.fireT = 6.6 + Math.random() * 3.0;          // 玩家 3.6s，AI 6.6~9.6s
      this.aimTick = 0;                                // 后坐后重新解算
      this.shotsFired = (this.shotsFired || 0) + 1;
      if (fireCb) fireCb(ent);
    }
  }
}
