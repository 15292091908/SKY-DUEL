// js/modes/aavs/damage.js —— 防空车突袭 · 部位倍率（v3.31）
//
// 本模式同时存在两种载具：飞机（攻方）与防空车（守方）。
// 倍率表是两者的并集；房主按目标弱点表查到的部位名直接在这里取值。
// 数值 = v3.27 的原始倍率（飞机 3/2.5/2/1，防空车 2/1.3/1）。
export const PART_MULT = {
  '驾驶舱': 3,
  '发动机': 2.5,
  '左翼': 2,
  '右翼': 2,
  '机身': 1,
  '弹药箱': 2,
  '炮塔': 1.3,
  '车体': 1,
};

/* 一次部位命中的伤害：基础 × 距离衰减 × 部位倍率。未知部位按 1×，最低 1 点。 */
export function partDamage(part, base, df) {
  const k = (df === undefined || df === null || !isFinite(df)) ? 1 : df;
  return Math.max(1, Math.round(base * k * (PART_MULT[part] || 1)));
}
