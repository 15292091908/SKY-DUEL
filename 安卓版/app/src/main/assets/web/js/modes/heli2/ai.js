// js/modes/heli2/ai.js —— 直升机对决 AI（空对空）
//
// 和 heli 模式的 HeliBot 是两种东西：那边打的是地面防空车（悬停压制、机头固定向下），
// 这边打的是同样会动的直升机 —— 必须：
//   · 进到 250m 左右就停下来吊打（太近会被对方的霰弹秒，太远机枪散得厉害）；
//   · 全程带提前量（目标 100 m/s 横向机动，1 秒飞行时间就是 100m 偏移）；
//   · 不做喷气机那种"脱离再进入"，直升机没有能量优势，脱离只会白挨打。
import * as THREE from 'three';
import { Bot } from '../../ai.js?v=1572';
import { BULLET_DRAG_Q, BULLET_MUZZLE } from '../../config.js?v=1572';

const _hv = new THREE.Vector3();   // 本模块专用（不复用 ai.js 的内部向量）

export class HeliDuelBot extends Bot {
  constructor(plane) {
    super(plane);
    this.groundTarget = false;   // ★ 目标是空中单位
    this.turnRate = 1.7;
    this.speedLerp = 1.6;
    this.speed = 55;
    this.phase = 'in';           // in（接近）/ hold（盘旋吊打）/ out（后撤）
    this.orbitT = Math.random() * 6.28;
    this.targetStrafe = 0;
    this.hurtT = 0;
    /* 准头（用户反馈"AI 太准打不过"）：手抖幅度是默认对空值的 4 倍（0.5 → 2.0），
       射击间隔也从 0.12s 放慢到 0.24s。200m 处弹着点左右飘 ±6m，
       而直升机判定球半径只有 2.1~2.6 —— 大部分弹会擦过去。 */
    this.swayScale = 2.0;
    this.fireInterval = 0.24;
    /* 机体俯仰上限：直升机机头不允许大角度抬头/低头（玩家侧是 ±0.30）。
       旧版沿用喷气机的 ±1.1，AI 整架机头能甩到 60°+（用户反馈）。 */
    this.pitchLimit = 0.32;
    this.rushCd = 7 + Math.random() * 4;   // 每隔一阵突进一次（用霰弹）
    this.rushT = 0;
  }

  reset(pos, yaw) {
    super.reset(pos, yaw);
    this.phase = 'in';
    this.orbitT = Math.random() * 6.28;
    this.targetStrafe = 0;
    this.hurtT = 0;
    this.speed = 55;
    this.groundTarget = false;
    this.swayScale = 2.0;
    this.fireInterval = 0.24;
    this.pitchLimit = 0.32;
    this.rushCd = 7 + Math.random() * 4;
    this.rushT = 0;
  }

  tactics(dt, ctx) {
    const { p, mePos, dist } = ctx;

    // 被击中 → 0.8s 后撤（不做翻滚，直升机翻滚只会自己飞出掩体）
    if (this.hp < this.hpPrev - 0.5 && this.hurtT <= 0) this.hurtT = 0.8;
    if (this.hurtT > 0) this.hurtT -= dt;

    /* 距离带（滞回）：330m 外加速接近 → 250m 停住吊打 → 100m 内后撤，退到 300m 才再压上。
       没有滞回会在临界距离一进一退地抖。 */
    if (this.phase === 'in') {
      if (dist < 250) this.phase = 'hold';
    } else if (this.phase === 'hold') {
      if (dist < 100) this.phase = 'out';
      else if (dist > 420) this.phase = 'in';
    } else if (dist > 300) this.phase = 'hold';

    let wantSpeed;
    if (this.phase === 'in') wantSpeed = dist > 500 ? 92 : 62;
    else if (this.phase === 'hold') wantSpeed = dist > 300 ? 26 : 8;
    else wantSpeed = -26;
    if (this.hurtT > 0) wantSpeed = Math.min(wantSpeed, -18);

    /* 突进节奏：平时在 250m 吊打，每隔 7~11s 冲一次近身（冲到 60~100m 打霰弹），
       让练习模式真的能练到"近身对霰弹"这件事，而不是永远只在中距离对枪。 */
    this.rushCd -= dt;
    if (this.rushT > 0) { this.rushT -= dt; wantSpeed = 96; }
    else if (this.rushCd <= 0 && dist > 150 && this.hp > 35) {
      this.rushT = 3.0;
      this.rushCd = 9 + Math.random() * 5;
    }

    // 悬停段缓慢横移：机头仍对着目标（射击判定只看机头），但机身在漂 → 不会被当成固定靶
    this.orbitT += dt;
    this.targetStrafe = (this.phase === 'hold' && this.rushT <= 0) ? Math.sin(this.orbitT * 0.6) * 10 : 0;

    // 提前量：真实二次阻力下的飞行时间（和基类同一个公式）
    const flyT = BULLET_DRAG_Q > 0
      ? (Math.exp(BULLET_DRAG_Q * dist) - 1) / (BULLET_DRAG_Q * BULLET_MUZZLE)
      : dist / BULLET_MUZZLE;
    _hv.copy(mePos).addScaledVector(this._tv, Math.min(1.1, flyT));

    return { aimPoint: _hv, wantSpeed, mode: 'attack' };
  }
}
