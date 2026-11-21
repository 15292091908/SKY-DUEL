// js/modes/heli2/damage.js —— 直升机对决 · 部位倍率（v3.31）
//
// 双方都是直升机，倍率表只需要直升机部位。
// 数值 = v3.27 的原始倍率（驾驶舱 3 / 发动机 2 / 尾梁 1.5）。
export const PART_MULT = {
  '驾驶舱': 3,
  '发动机': 2,
  '尾梁': 1.5,
};

/* 一次部位命中的伤害：基础 × 距离衰减 × 部位倍率。未知部位按 1×，最低 1 点。 */
export function partDamage(part, base, df) {
  const k = (df === undefined || df === null || !isFinite(df)) ? 1 : df;
  return Math.max(1, Math.round(base * k * (PART_MULT[part] || 1)));
}
