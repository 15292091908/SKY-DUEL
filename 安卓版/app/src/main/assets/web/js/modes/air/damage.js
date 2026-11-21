// js/modes/air/damage.js —— 空战对决 · 部位倍率（v3.31）
//
// 倍率系统随模式走：本文件夹拥有本模式的倍率表，combat.js / loop.js 只通过
// modeField('partDamage') 调用，不再读载具文件（plane.js / heli.js / aagun.js）里的字段。
// 数值 = v3.27 的原始倍率（用户要求回归，旧的 1.6/1.3/1.2 偏小）。
export const PART_MULT = {
  '驾驶舱': 3,
  '发动机': 2.5,
  '左翼': 2,
  '右翼': 2,
  '机身': 1,
};

/* 一次部位命中的伤害：基础 × 距离衰减 × 部位倍率。未知部位按 1×，最低 1 点。 */
export function partDamage(part, base, df) {
  const k = (df === undefined || df === null || !isFinite(df)) ? 1 : df;
  return Math.max(1, Math.round(base * k * (PART_MULT[part] || 1)));
}
