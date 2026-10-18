import * as THREE from 'three';
import { forwardOf } from './plane.js';
import { forwardOfTurret } from './aagun.js';

// 练习模式 AI：追击 + 规避 + 边界回中 + 防坠海
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export class Bot {
  constructor(plane) {
    this.plane = plane;
    this.yaw = 0; this.pitch = 0; this.roll = 0; this.yawVel = 0;
    this.speed = 95; this.targetSpeed = 100;
    this.hp = 100; this.alive = true; this.gunSide = false;
    this.fireT = 0;
    this.evadeT = 0;
    this.evadeDir = new THREE.Vector3(1, 0, 0);
    this.turnRate = 1.15;   // rad/s
    this.groundTarget = false;  // true = 目标是地面防空车，允许俯冲低空
  }

  reset(pos, yaw) {
    this.plane.group.position.copy(pos);
    this.yaw = yaw; this.pitch = 0; this.roll = 0; this.yawVel = 0;
    this.speed = 95; this.targetSpeed = 100;
    this.hp = 100; this.alive = true; this.fireT = 0; this.evadeT = 0;
    this.plane.group.visible = true;
  }

  update(dt, me, fireCb) {
    if (!this.alive) return;
    const p = this.plane.group.position;
    const mePos = me.plane.group.position;
    const targetSpeed = (me && me.speed) ? me.speed : 0;

    // 目标点：默认追击目标（带少量预判）
    const aimPoint = _v1.copy(mePos);
    if (me && me.alive !== false && targetSpeed > 0) {
      _v2.set(mePos.x - p.x, 0, mePos.z - p.z);
      aimPoint.addScaledVector(_v2.normalize(), targetSpeed * 0.35); // 粗略前置量
    }

    // 被咬尾时规避机动（仅空中目标）
    if (!this.groundTarget && me.alive && this.evadeT <= 0) {
      const myFwd = forwardOf(this, _v2);
      const fromMe = _v3.copy(p).sub(mePos).normalize();
      if (myFwd.dot(fromMe) > 0.93 && p.distanceTo(mePos) < 260) {
        this.evadeT = 1.6 + Math.random() * 1.4;
        this.evadeDir.set(Math.random() - 0.5, Math.random() * 0.6 - 0.1, Math.random() - 0.5).normalize();
      }
    }
    if (this.evadeT > 0) {
      this.evadeT -= dt;
      aimPoint.copy(p).addScaledVector(this.evadeDir, 500);
    }

    // 边界回中
    const r = Math.hypot(p.x, p.z);
    if (r > 1500) aimPoint.set(0, 230, 0);
    // 禁止无限爬升：高于高度上限时把目标点压回（避免触发边界扣血）
    if (p.y > 540) aimPoint.y = Math.min(aimPoint.y, 460);
    // 防坠海/防触地：地面目标允许俯冲到低空再拉起
    if (this.groundTarget) {
      if (p.y < 28) aimPoint.y = Math.max(aimPoint.y, 45);
    } else {
      if (p.y < 90) aimPoint.y = Math.max(aimPoint.y, 240);
    }

    // 期望 yaw/pitch
    const d = aimPoint.sub(p).normalize();
    const wantYaw = Math.atan2(-d.x, -d.z);
    const wantPitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
    const maxTurn = this.turnRate * dt;
    const dy = wrapAngle(wantYaw - this.yaw);
    const stepYaw = THREE.MathUtils.clamp(dy, -maxTurn, maxTurn);
    this.yaw += stepYaw;
    this.yawVel = stepYaw / Math.max(dt, 1e-4);
    this.pitch += THREE.MathUtils.clamp(wantPitch - this.pitch, -maxTurn * 0.8, maxTurn * 0.8);
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.1, 1.1);
    this.targetSpeed = this.evadeT > 0 ? 135 : 105;

    // 开火：机头对准且在射程内
    this.fireT -= dt;
    const fwd = forwardOf(this, _v2);
    const toMe = _v1.copy(mePos).sub(p).normalize();
    const dist = p.distanceTo(mePos);
    const canFire = this.groundTarget
      ? (fwd.dot(toMe) > 0.97 && dist < 540)
      : (me.alive && fwd.dot(toMe) > 0.994 && dist < 430);
    if (canFire && this.fireT <= 0) {
      this.fireT = 0.12;
      fireCb(this);
    }
  }
}

// 防空车 AI：炮塔跟踪最近飞机 + 前置量 + 射击 + 出生点附近巡逻换位
export class AAGunBot {
  constructor(aagun) {
    this.aagun = aagun;        // makeAAGun 实体（含 aagun 模型、turretYaw/turretPitch）
    this.turretYaw = 0;
    this.turretPitch = 0.4;
    this.fireT = 0;
    this.basePos = null;       // 出生点（巡逻中心）
    this.patrolPos = null;     // 当前巡逻目标点
    this.patrolT = 0;          // 到达后停留计时
    this.agPrev = new THREE.Vector3();
  }

  reset(pos) {
    this.aagun.aagun.group.position.copy(pos);
    this.turretYaw = 0; this.turretPitch = 0.4; this.fireT = 0;
    this.aagun.alive = true;
    this.aagun.aagun.group.visible = true;
    this.basePos = pos.clone();
    this.patrolPos = null;
    this.patrolT = 0;
  }

  update(dt, target, fireCb) {
    if (!this.aagun.alive) return;
    const ent = this.aagun;
    const p = ent.aagun.group.position;
    const t = target.plane.group.position;
    const d = _v1.copy(t).sub(p);
    const dist = d.length();

    // 前置量预测（目标飞行速度）
    const targetSpeed = (target && target.speed) ? target.speed : 0;
    const aim = _v2.copy(d).normalize().multiplyScalar(targetSpeed * 0.35);
    const aimDir = _v3.copy(t).add(aim).sub(p).normalize();
    const wantYaw = Math.atan2(-aimDir.x, -aimDir.z);
    const wantPitch = Math.asin(THREE.MathUtils.clamp(aimDir.y, -1, 1));

    // 炮塔限速旋转
    const maxTurn = 1.7 * dt;
    this.turretYaw += THREE.MathUtils.clamp(wrapAngle(wantYaw - this.turretYaw), -maxTurn, maxTurn);
    this.turretPitch += THREE.MathUtils.clamp(wantPitch - this.turretPitch, -maxTurn * 0.8, maxTurn * 0.8);
    this.turretPitch = THREE.MathUtils.clamp(this.turretPitch, -0.15, 1.35);
    ent.turretYaw = this.turretYaw;
    ent.turretPitch = this.turretPitch;

    // 巡逻移动：出生点附近随机换位（车体转向 + 前进），避免站在原地挨打
    if (!this.basePos) this.basePos = p.clone();
    if (!this.patrolPos || this.patrolT <= 0) {
      const a = Math.random() * Math.PI * 2;
      const pr = 90 + Math.random() * 110;
      this.patrolPos = new THREE.Vector3(this.basePos.x + Math.cos(a) * pr, 0, this.basePos.z + Math.sin(a) * pr);
      this.patrolT = 2.5 + Math.random() * 3.5;
    }
    this.patrolT -= dt;
    const toP = _v2.copy(this.patrolPos).sub(p); toP.y = 0;
    const distP = toP.length();
    if (distP > 6) {
      const wantBodyYaw = Math.atan2(-toP.x, -toP.z);
      ent.bodyYaw += THREE.MathUtils.clamp(wrapAngle(wantBodyYaw - ent.bodyYaw), -1.2 * dt, 1.2 * dt);
      toP.normalize();
      p.addScaledVector(toP, 9 * dt);   // 巡逻速度 9 单位/s（约 32 km/h）
    }

    // 开火：炮管对准 + 射程内
    this.fireT -= dt;
    const fwd = forwardOfTurret(this.aagun, _v2);
    const toT = _v1.copy(t).sub(p).normalize();
    if (fwd.dot(toT) > 0.988 && dist < 620 && this.fireT <= 0) {
      this.fireT = 0.1;
      fireCb(this.aagun);
    }
  }
}
