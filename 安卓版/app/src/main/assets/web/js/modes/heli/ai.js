import * as THREE from 'three';
import { Bot } from '../../ai.js?v=1572';
import { BULLET_DRAG_Q, BULLET_MUZZLE } from '../../config.js?v=1572';

const _hv = new THREE.Vector3();   // 本模块专用（不复用 ai.js 的内部向量）

/* ================= 直升机突袭 AI =================
   喷气机那套「高速掠过 → 脱离 → 再进入」放到直升机上是错的：
     · 直升机最大也就 108 m/s，脱离段又慢又没意义 → 表现为「打几枪就往回飞」；
     · 受伤/被咬尾的随机规避机动，方块机身做起大角度翻滚 → 像喝醉酒；
     · 一直被钉在 78 m/s 巡航 → 玩家根本打不到。
   直升机的正确打法是「接近 → 悬停压制 → 被逼近才后退」：
     · 机头始终对着目标（武器射界 ±150°，所以机身可以侧移而机头不动）；
     · 悬停段只做缓慢横向漂移（±11 m/s，周期 ~11s），有动感但不会飘到打不中；
     · 被击中只做 0.9 秒的小幅后退，不做翻滚机动；
     · 全程没有 egress，不会主动掉头跑。 */
export class HeliBot extends Bot {
  constructor(plane) {
    super(plane);
    this.groundTarget = true;    // 目标恒为地面防空车
    this.turnRate = 1.7;         // 机身转向比喷气机灵活一点
    this.speedLerp = 1.6;        // 速度响应（基类默认 0.8，直升机需要更快收油门）
    this.speed = 60;             // 初始巡航（基类默认 95 太快）
    this.phase = 'in';           // in（接近）/ hold（悬停压制）/ out（后退拉开）
    this.hurtT = 0;              // 被击中后的短促后退
    this.orbitT = Math.random() * 6.28;
    this.targetStrafe = 0;       // 给 flightHeli 的横向速度（机头不动、机身侧移）
  }

  reset(pos, yaw) {
    super.reset(pos, yaw);
    this.phase = 'in'; this.hurtT = 0; this.orbitT = Math.random() * 6.28;
    this.targetStrafe = 0; this.speed = 60;
    this.groundTarget = true;
  }

  /* 覆盖战术：只有「接近 / 悬停 / 后退」，没有脱离、没有随机规避。 */
  tactics(dt, ctx) {
    const { p, mePos, dist } = ctx;

    // 被击中 → 0.9 秒后退（缩一下，不是乱窜）
    if (this.hp < this.hpPrev - 0.5 && this.hurtT <= 0) this.hurtT = 0.9;
    if (this.hurtT > 0) this.hurtT -= dt;

    /* 距离带 + 滞回：没有滞回就会在临界距离来回抖（进→退→进）
       240m 停住打、150m 才后退、退到 390m 再停。 */
    if (this.phase === 'in') {
      if (dist < 240) this.phase = 'hold';
    } else if (this.phase === 'hold') {
      if (dist < 150) this.phase = 'out';
      else if (dist > 470) this.phase = 'in';
    } else if (dist > 390) this.phase = 'hold';

    let wantSpeed;
    if (this.phase === 'in') wantSpeed = dist > 520 ? 84 : 58;
    else if (this.phase === 'hold') wantSpeed = 7;
    else wantSpeed = -24;
    if (this.hurtT > 0) wantSpeed = Math.min(wantSpeed, -20);

    // 悬停段的缓慢侧移（机头仍对目标 → 射击判定不受影响）
    this.orbitT += dt;
    this.targetStrafe = this.phase === 'hold' ? Math.sin(this.orbitT * 0.55) * 11 : 0;

    // 瞄准：按真实弹道飞行时间打提前量（打的是机枪，弹速 ≈ 880）
    const flyT = BULLET_DRAG_Q > 0
      ? (Math.exp(BULLET_DRAG_Q * dist) - 1) / (BULLET_DRAG_Q * BULLET_MUZZLE)
      : dist / BULLET_MUZZLE;
    _hv.copy(mePos).addScaledVector(this._tv, Math.min(0.9, flyT));

    return { aimPoint: _hv, wantSpeed, mode: 'attack' };
  }
}
