// js/modes/heli/damage.js —— 直升机突袭 · 部位倍率（v3.31）
//
// 本模式是直升机 vs 防空车，倍率表同时包含两种载具。
// 数值 = v3.27 的原始倍率（直升机 3/2/1.5，防空车 2/1.3/1）。
export const PART_MULT = {
  '驾驶舱': 3,
  '发动机': 2,
  '尾梁': 1.5,
  '弹药箱': 2,
  '炮塔': 1.3,
  '车体': 1,
};

/* 一次部位命中的伤害：基础 × 距离衰减 × 部位倍率。未知部位按 1×，最低 1 点。 */
export function partDamage(part, base, df) {
  const k = (df === undefined || df === null || !isFinite(df)) ? 1 : df;
  return Math.max(1, Math.round(base * k * (PART_MULT[part] || 1)));
}
