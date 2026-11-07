import * as THREE from 'three';
import { forwardOf } from './plane.js';
import { forwardOfTurret } from './aagun.js';
import { BULLET_GRAVITY, BULLET_MUZZLE, BULLET_DRAG_Q } from './config.js?v=1543';

/* v3.17：子弹有重力和阻力，AI 必须自己抬枪 ——
   否则 500m 外弹着点会低 3m，AI 一发都打不中（练习模式直接变沙包）。
   飞行时间用真实二次阻力的解析解反推：s = ln(1+c·v0·t)/c → t = (e^(c·s)−1)/(c·v0)，
   再乘 ½·g·t² 得到下坠量，换算成角度。 */
function dropComp(aimDist, k) {
  const v0 = BULLET_MUZZLE * 0.9;                       // 载机速度让实际初速更高，取保守值
  const t = BULLET_DRAG_Q > 0
    ? (Math.exp(BULLET_DRAG_Q * aimDist) - 1) / (BULLET_DRAG_Q * v0)
    : aimDist / v0;
  const tt = Math.min(2.0, t);
  /* k < 1 = 只补偿一部分（v3.18.1）。真人不可能把下坠算到小数点，
     全额补偿会让 AI 变成弹道计算机 —— 这是"防空车一轮就死"的根因之一。 */
  return (k === undefined ? 1 : k) * Math.atan2(0.5 * BULLET_GRAVITY * tt * tt, Math.max(1, aimDist));
}

/* 瞄准摆动（v3.18.1）：给 AI 一点"手抖"，让它不是每发都精确压线。
   关键：必须是**低频**的（用 age 驱动的正弦，周期 2~5 秒），
   如果每帧随机，等于把弹着点摊成一团喷雾，覆盖面反而更大、更容易命中。
   幅度按距离缩放：500m 处约 ±7.5m，100m 处只有 ±1.5m —— 近身仍然危险，远距离才开始打飘。 */
function swayOffset(age, phase, dist, out, scale) {
  const a = Math.min(1, dist / 500) * 6 * (scale === undefined ? 1 : scale);   // 固定幅度（相位只决定节奏）：个体之间强弱一致，体验稳定
  out.set(
    Math.sin(age * 4.0 + phase) * a,
    Math.sin(age * 5.5 + phase * 1.7) * a * 0.55,
    Math.cos(age * 4.5 + phase * 0.6) * a,
  );
  return out;
}

// 练习模式 AI：追击 + 规避 + 边界回中 + 防坠海
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _swayV = new THREE.Vector3();   // 瞄准摆动（v3.18.1）

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
    this.turnRate = 1.22;   // rad/s（转弯半径 ≈ speed / turnRate）
    this.groundTarget = false;  // true = 目标是地面防空车，允许俯冲低空
    /* v3.11.3 战斗状态机：解决「一直朝目标转、转不过来就绕圈」 */
    this.mode = 'attack';    // attack / egress / evade
    this.egressT = 0;        // 脱离剩余时间
    this.attackT = 0;        // 本轮攻击已持续
    this.age = 0;            // 回合内存活时长（模式 AI 用来看"开局保护"）
    this.hpPrev = 100;
    this._tp = null;         // 目标上一帧位置（帧间差分算速度）
    this.swayPhase = Math.random() * Math.PI * 2;   // v3.18.1 个体手抖相位
    this._tv = new THREE.Vector3();
  }

  reset(pos, yaw) {
    this.plane.group.position.copy(pos);
    this.yaw = yaw; this.pitch = 0; this.roll = 0; this.yawVel = 0;
    this.speed = 95; this.targetSpeed = 100;
    this.hp = 100; this.alive = true; this.fireT = 0; this.evadeT = 0;
    this.mode = 'attack'; this.egressT = 0; this.attackT = 0; this.age = 0; this.hpPrev = 100;
    this.swayPhase = Math.random() * Math.PI * 2;
    this._tp = null; this._tv.set(0, 0, 0);
    this.plane.group.visible = true;
  }

  update(dt, me, fireCb) {
    if (!this.alive) return;
    this.age += dt;
    const p = this.plane.group.position;
    const mePos = me.plane.group.position;
    const dist = p.distanceTo(mePos);

    // 目标速度：帧间差分 + 平滑（用于打提前量，比旧的「speed 标量沿视线」准）
    if (!this._tp) { this._tp = mePos.clone(); this._tv.set(0, 0, 0); }
    else {
      _v1.copy(mePos).sub(this._tp).divideScalar(Math.max(dt, 1e-4));
      if (_v1.lengthSq() < 40000 && this._tp.distanceToSquared(mePos) > 1e-6) this._tv.lerp(_v1, 0.4);
      this._tp.copy(mePos);
    }
    const tgtSpeed = this._tv.length();

    // 地面目标：外部标记，或「贴地且几乎不动」（直升机 AI 打防空车走这条）
    const isGround = this.groundTarget || (mePos.y < 25 && tgtSpeed < 12);

    // 受伤 → 规避机动（空中目标才做；被打一下就开始扭）
    if (!isGround && this.hp < this.hpPrev - 0.5 && this.evadeT <= 0) {
      this.evadeT = 1.2 + Math.random() * 0.9;
      this.evadeDir.set(Math.random() - 0.5, Math.random() * 0.55, Math.random() - 0.5).normalize();
    }
    this.hpPrev = this.hp;

    // 被咬尾 → 规避机动（原有逻辑保留）
    if (!isGround && me.alive && this.evadeT <= 0) {
      const myFwd = forwardOf(this, _v2);
      const fromMe = _v3.copy(p).sub(mePos).normalize();
      if (myFwd.dot(fromMe) > 0.93 && dist < 260) {
        this.evadeT = 1.6 + Math.random() * 1.4;
        this.evadeDir.set(Math.random() - 0.5, Math.random() * 0.6 - 0.1, Math.random() - 0.5).normalize();
      }
    }

    /* ---- 状态机：攻击 → 脱离 → 再进入 ----
       ★ 旧版永远把目标点设成玩家位置：近距离时目标落在侧方/下方，转向率不够就永远差一个固定角，
         表现为「绕着玩家转圈」。脱离段先按机头飞出去，把角度差重新拉开再进入。 */
    let wantSpeed = 108;
    if (this.evadeT > 0) {
      this.evadeT -= dt; this.mode = 'evade'; wantSpeed = 142;
    } else if (this.egressT > 0) {
      this.egressT -= dt; this.mode = 'egress'; wantSpeed = 148;
    } else {
      const fwdDot = forwardOf(this, _v2).dot(_v3.copy(mePos).sub(p).normalize());
      // standoff：模式可指定「保持距离」（直升机 AI 在 280m 外投弹，不贴脸）
      const tooClose = dist < (this.standoff || (isGround ? 150 : 100));
      const badAngle = fwdDot < 0.12 && dist < 340;          // 目标跑到身后/侧后
      // 攻击段跑了 2.6s 也要脱离，但只在「已经打到近距」时才算一轮结束：
      // 远距离（>320m）一直追，否则每 2.6s 就掉头，永远接近不了目标（实测卡在 1200m）
      const attackDone = this.attackT > 2.6 && dist < 320;
      if (tooClose || badAngle || attackDone) {
        this.egressT = isGround ? 2.8 : 2.1;
        this.attackT = 0;
        this.mode = 'egress';
        wantSpeed = 148;
      } else {
        this.mode = 'attack';
        this.attackT += dt;
        wantSpeed = dist > 600 ? 132 : 112;                  // 远距离加速追上，近距离收油门
      }
    }
    this.targetSpeed = wantSpeed;

    /* ---- 目标点 ---- */
    const aimPoint = _v1;
    if (this.mode === 'evade') {
      aimPoint.copy(p).addScaledVector(this.evadeDir, 520);
      aimPoint.y = Math.max(aimPoint.y, p.y + 20);
    } else if (this.mode === 'egress') {
      /* ★ 脱离必须「离开目标」，不能只沿机头飞：
         机头正好指着目标时，沿机头飞等于继续冲过去，永远拉不开距离（实测水平距离贴到 8m）。 */
      const away = _v3.copy(p).sub(mePos); away.y = 0;
      if (away.lengthSq() < 4) away.set(Math.cos(this.yaw + 1.3), 0, Math.sin(this.yaw + 1.3));  // 正上方：侧向脱离
      away.normalize();
      aimPoint.copy(p).addScaledVector(away, 600);
      aimPoint.y = p.y + (isGround ? 120 : 60);
    } else {
      /* 攻击：按子弹真实飞行时间打提前量。
         旧版写 dist/615 —— 那是 v3.14 之前的旧枪口初速，弹速提到 880 后 AI 的提前量一直偏大。
         真实二次阻力下 s = ln(1+c·v0·t)/c → t = (e^(c·s)−1)/(c·v0)。 */
      const flyT = BULLET_DRAG_Q > 0
        ? (Math.exp(BULLET_DRAG_Q * dist) - 1) / (BULLET_DRAG_Q * BULLET_MUZZLE)
        : dist / BULLET_MUZZLE;
      const lead = Math.min(1.2, flyT);
      aimPoint.copy(mePos).addScaledVector(this._tv, lead);
    }

    // 边界回中
    if (Math.hypot(p.x, p.z) > 1500) aimPoint.set(0, Math.max(230, p.y), 0);
    /* ★ 前向避障（v3.11.4）：机头 420m 内有建筑/山体 → 把瞄点抬到障碍顶上方。
       probe 由 loop.js 注入（它拿得到 world.colliders 与 rayHitWorld），ai.js 不直接依赖世界模块。
       城市图里 AI 低空追击/俯冲会直接撞楼，撞了就是 peerDie（与玩家同规则）。
       探测距离必须够远：城市最高楼 442m，从 200m 爬到 470m 要 4s 左右，130m/s 对应约 450m 的水平距离。 */
    if (this.probe) {
      forwardOf(this, _v2);
      _v3.copy(p).addScaledVector(_v2, 460);
      const h = this.probe(p, _v3);
      if (h && p.y < h.top) {
        aimPoint.set(h.x, h.top, h.z);   // 直接瞄「楼顶正上方」：爬升角最大，比"抬高前方点"更快到位
        this.targetSpeed = Math.min(this.targetSpeed, 96);   // 爬升时收油门：同样的角度下水平前进更少，更容易爬到楼顶
      }
    }
    /* v3.18.1 手抖：攻击态才抖（规避/脱离本来就不射击）。
       低频正弦 → 打出来的是一串有规律的偏弹，而不是每帧乱跳的喷雾。 */
    if (this.mode === 'attack') aimPoint.add(swayOffset(this.age, this.swayPhase, aimPoint.distanceTo(p), _swayV, isGround ? 1 : 0.5));

    // 禁止无限爬升
    if (p.y > 540) aimPoint.y = Math.min(aimPoint.y, 460);
    // 防坠海/防触地
    if (isGround) {
      // ★ 60m 以下不再压机头：再低俯冲就拉不起来了（实测会扎进地里）。
      //   注意阈值不能太高 —— 直升机 AI 的巡航高度只有 75m，抬太高它就永远抬着头打不到地面。
      if (p.y < 60) aimPoint.y = Math.max(aimPoint.y, p.y + 50);
    } else {
      if (p.y < 90) aimPoint.y = Math.max(aimPoint.y, 240);
    }

    // 期望 yaw/pitch
    const d = _v3.copy(aimPoint).sub(p).normalize();
    const wantYaw = Math.atan2(-d.x, -d.z);
    let wantPitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
    wantPitch += dropComp(aimPoint.distanceTo(p), 0.65);   // v3.18.1：只补偿 65%（真人算不了那么准）
    // ★ 对地攻击限制俯冲角（-0.55 rad ≈ -31°）：从 100~200m 扫射地面目标足够，
    //   不限制的话 AI 会把机头压到 -60° 直接扎进地里（实测 dMin 触到 1m 后坠毁）
    if (isGround) wantPitch = Math.max(wantPitch, -0.55);
    const maxTurn = this.turnRate * dt;
    const dy = wrapAngle(wantYaw - this.yaw);
    const stepYaw = THREE.MathUtils.clamp(dy, -maxTurn, maxTurn);
    this.yaw += stepYaw;
    this.yawVel = stepYaw / Math.max(dt, 1e-4);
    this.pitch += THREE.MathUtils.clamp(wantPitch - this.pitch, -maxTurn * 0.8, maxTurn * 0.8);
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.1, 1.1);
    this.speed += (this.targetSpeed - this.speed) * Math.min(1, dt * 0.8);   // 加/减速有惯性

    // 开火：只在攻击态（脱离/规避途中不射击，避免"边绕圈边泼弹"）
    this.fireT -= dt;
    if (this.mode === 'attack' && this.fireT <= 0) {
      const fwd = forwardOf(this, _v2);
      const toMe = _v1.copy(mePos).sub(p).normalize();
      const canFire = isGround
        ? (fwd.dot(toMe) > 0.965 && dist < 560)
        : (me.alive && fwd.dot(toMe) > (dist < 300 ? 0.978 : 0.992) && dist < 460);   // 近距放宽对准要求（高速掠过时开火窗口只有一两帧）
      if (canFire) {
        /* v3.18.1：对地攻击拉长射击间隔（8.3 发/秒 → 5 发/秒）。
           真人飞行员对地扫射是点射，不会一直按住扳机；这也是防空车一轮就死的另一半原因。 */
        this.fireT = isGround ? 0.16 : 0.12;
        fireCb(this);
      }
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
    this.age = 0;
    this.swayPhase = Math.random() * Math.PI * 2;
  }

  reset(pos) {
    this.aagun.aagun.group.position.copy(pos);
    this.turretYaw = 0; this.turretPitch = 0.4; this.fireT = 0;
    this.aagun.alive = true;
    this.aagun.aagun.group.visible = true;
    this.basePos = pos.clone();
    this.swayPhase = Math.random() * Math.PI * 2;
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
    const aimVec = _v3.copy(t).add(aim).sub(p);
    /* v3.18.1：炮塔也有手抖。幅度随距离缩放（500m 处 ±8m），近距仍然准。 */
    this.age += dt;
    aimVec.add(swayOffset(this.age, this.swayPhase, dist, _swayV));
    aimVec.y += Math.tan(dropComp(dist, 0.65)) * Math.max(1, dist);   // v3.18.1：只补偿 65%
    const aimDir = aimVec.normalize();
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
