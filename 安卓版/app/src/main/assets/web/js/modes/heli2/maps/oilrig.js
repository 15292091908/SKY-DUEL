// js/modes/heli2/maps/oilrig.js —— 海上石油钻井平台（直升机对决专属）
//
// 五座平台：中央一座大型生产平台 + 东南西北各一座卫星平台（菱形分布）。
// 每座平台的结构（甲板 / 井架 / 吊车 / 集装箱）都是可破坏物：
//   机炮或霰弹打中 → 累计伤害 → 打炸后甲板起火（火焰外缘持续灼伤、核心瞬杀）。
// 平台本体**不会消失**：打炸后保留残骸，仍然是掩体与落脚点，但甲板整片燃烧。
//
// 破坏与火焰的游戏逻辑在模式包 index.js 里；本文件只负责「建模型 + 登记 RIGS」。
import * as THREE from 'three';
import { rand, setupSun } from '../../../world/common.js?v=1572';

/* 平台状态表：模式包直接引用这个数组（同一个模块实例，双方共享引用）。
   build() 会清空并重新填充 —— 换图/重开一局都从干净状态开始。 */
export const RIGS = [];

const RIG_DEFS = [
  { id: 'core', x: 0, z: 0, r: 48, deckY: 21, big: true },
  { id: 'north', x: 0, z: -470, r: 34, deckY: 17 },
  { id: 'south', x: 0, z: 470, r: 34, deckY: 17 },
  { id: 'west', x: -470, z: 0, r: 34, deckY: 17 },
  { id: 'east', x: 470, z: 0, r: 34, deckY: 17 },
];

const steel = () => new THREE.MeshStandardMaterial({ color: 0x7d848c, metalness: 0.55, roughness: 0.55 });
const steelDark = () => new THREE.MeshStandardMaterial({ color: 0x4a5259, metalness: 0.5, roughness: 0.62 });
const deckMat = () => new THREE.MeshStandardMaterial({ color: 0x6a6257, metalness: 0.25, roughness: 0.85 });
const rustMat = () => new THREE.MeshStandardMaterial({ color: 0x8a5a3c, metalness: 0.35, roughness: 0.8 });

const _up = new THREE.Vector3(0, 1, 0);
/* 两点之间摆一根圆管（和直升机模型同一套做法：端点即真实端点，斜撑不会穿模） */
function beam(parent, a, b, r, mat) {
  const A = new THREE.Vector3().fromArray(a), B = new THREE.Vector3().fromArray(b);
  const d = new THREE.Vector3().subVectors(B, A);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 6), mat);
  m.position.copy(A).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(_up, d.normalize());
  parent.add(m);
  return m;
}

/* 火焰锥（加法混合 + 双面，远景像一团跳动的火） */
/* 火焰锥：白天用**普通混合**（加法混合在亮蓝天空下会整片过曝成白球），
   靠颜色和透明度出火，而不是靠叠加加亮。 */
function makeFlame(color, h, r) {
  const g = new THREE.ConeGeometry(r, h, 8, 1, false);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.62, side: THREE.DoubleSide, depthWrite: false,
  }));
  m.position.y = h * 0.5;
  return m;
}

function buildRig(root, def, colliders) {
  const g = new THREE.Group();
  g.position.set(def.x, 0, def.z);
  root.add(g);
  const R = def.r, DY = def.deckY;
  const S = steel(), SD = steelDark(), DK = deckMat(), RU = rustMat();
  /* 平台的"可被子弹打中"的实体盒（世界坐标）。colliders 供物理/撞机使用，
     boxes 供模式包的子弹命中判定使用 —— 两者同源，改一处不会漏。 */
  const boxes = [];
  const pushBox = (bx, bz, hx, hz, y0, y1) => {
    const c = { s: 2, x: bx, z: bz, hx, hz, y0, y1 };
    colliders.push(c); boxes.push(c);
  };

  /* ---- 导管架（桩腿 + 水平撑 + 斜撑）---- */
  const legR = R * 0.045 + 0.7;
  const legs = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * R * 0.60, z = sz * R * 0.60;
    legs.push([x, z]);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(legR, legR * 1.2, DY + 10, 10), S);
    leg.position.set(x, (DY + 10) / 2 - 10, z);
    g.add(leg);
  }
  // 水平撑（三层）+ 每层四边
  for (const y of [DY * 0.30, DY * 0.58, DY * 0.86]) {
    const pts = legs.map(([x, z]) => [x, y, z]);
    for (let i = 0; i < 4; i++) {
      const a = pts[i], b = pts[(i + 1) % 4];
      beam(g, a, b, R * 0.018 + 0.22, SD);
    }
  }
  // X 形斜撑（只在两面做，够看且省三角面）
  for (const s of [-1, 1]) {
    beam(g, [s * R * 0.60, DY * 0.20, -R * 0.60], [s * R * 0.60, DY * 0.86, R * 0.60], R * 0.014 + 0.16, SD);
    beam(g, [s * R * 0.60, DY * 0.86, -R * 0.60], [s * R * 0.60, DY * 0.20, R * 0.60], R * 0.014 + 0.16, SD);
  }

  /* ---- 甲板（方形，碰撞体与之完全一致）+ 边缘护栏 ---- */
  const deck = new THREE.Mesh(new THREE.BoxGeometry(R * 2, 2.6, R * 2), DK);
  deck.position.set(0, DY - 1.3, 0);
  g.add(deck);
  pushBox(def.x, def.z, R, R, DY - 2.6, DY);
  // 甲板下方的承重梁（横竖各两根，让底面不是一块平板）
  for (const k of [-0.5, 0.5]) {
    const bx = new THREE.Mesh(new THREE.BoxGeometry(R * 2, 1.1, R * 0.16), SD);
    bx.position.set(0, DY - 3.2, k * R); g.add(bx);
    const bz = new THREE.Mesh(new THREE.BoxGeometry(R * 0.16, 1.1, R * 2), SD);
    bz.position.set(k * R, DY - 3.2, 0); g.add(bz);
  }
  // 甲板围栏（只在四边做细管）
  for (const s of [-1, 1]) {
    beam(g, [-R, DY + 1.1, s * R], [R, DY + 1.1, s * R], 0.09, S);
    beam(g, [s * R, DY + 1.1, -R], [s * R, DY + 1.1, R], 0.09, S);
    for (let i = -2; i <= 2; i++) {
      beam(g, [i * R * 0.4, DY, s * R], [i * R * 0.4, DY + 1.1, s * R], 0.06, S);
      beam(g, [s * R, DY, i * R * 0.4], [s * R, DY + 1.1, i * R * 0.4], 0.06, S);
    }
  }
  // 直升机停机坪（贴甲板面的一层深色圆 + H 标记），不参与碰撞
  const pad = new THREE.Mesh(new THREE.CircleGeometry(R * 0.30, 28),
    new THREE.MeshStandardMaterial({ color: 0x2e3a3a, metalness: 0.1, roughness: 0.95 }));
  pad.rotation.x = -Math.PI / 2; pad.position.set(R * 0.30, DY + 0.03, -R * 0.28); g.add(pad);
  for (const s of [-1, 1]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(R * 0.03, 0.05, R * 0.26),
      new THREE.MeshStandardMaterial({ color: 0xd8d2b8, roughness: 0.9 }));
    bar.position.set(R * 0.30 + s * R * 0.075, DY + 0.05, -R * 0.28); g.add(bar);
  }
  const crossBar = new THREE.Mesh(new THREE.BoxGeometry(R * 0.15, 0.05, R * 0.03),
    new THREE.MeshStandardMaterial({ color: 0xd8d2b8, roughness: 0.9 }));
  crossBar.position.set(R * 0.30, DY + 0.05, -R * 0.28); g.add(crossBar);

  /* ---- 井架（derrick）：四腿收分 + 顶部天车 + 二层台 ---- */
  const DX = R * 0.16, DH = def.big ? 36 : 26;
  const baseX = -R * 0.44, baseZ = R * 0.20;
  const halfB = R * 0.20, halfT = R * 0.07;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    beam(g,
      [baseX + sx * halfB, DY, baseZ + sz * halfB],
      [baseX + sx * halfT, DY + DH, baseZ + sz * halfT],
      R * 0.016 + 0.18, S);
  }
  for (const y of [DY + DH * 0.35, DY + DH * 0.7]) {
    const k = 1 - 0.5 * (y - DY) / DH;
    const hb = halfB * k;
    for (const sz of [-1, 1]) beam(g, [baseX - hb, y, baseZ + sz * hb], [baseX + hb, y, baseZ + sz * hb], 0.09, SD);
    for (const sx of [-1, 1]) beam(g, [baseX + sx * hb, y, baseZ - hb], [baseX + sx * hb, y, baseZ + hb], 0.09, SD);
  }
  const crown = new THREE.Mesh(new THREE.BoxGeometry(halfT * 3.2, 1.0, halfT * 3.2), SD);
  crown.position.set(baseX, DY + DH, baseZ); g.add(crown);
  pushBox(def.x + baseX, def.z + baseZ, halfB + 0.6, halfB + 0.6, DY, DY + DH);

  /* ---- 吊车（基座 + 转台 + 吊臂）---- */
  const craneBase = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.09, R * 0.11, 3.0, 10), SD);
  craneBase.position.set(R * 0.46, DY + 1.5, R * 0.34); g.add(craneBase);
  const jib = new THREE.Mesh(new THREE.BoxGeometry(R * 0.95, 0.7, 0.7), rustMat());
  jib.position.set(R * 0.46 - R * 0.34, DY + 3.4, R * 0.34);
  jib.rotation.z = -0.22; g.add(jib);
  beam(g, [R * 0.46, DY + 4.6, R * 0.34], [R * 0.46 - R * 0.80, DY + 3.2, R * 0.34], 0.10, SD);

  /* ---- 集装箱 / 罐体（矮掩体，可打炸）---- */
  const containerDefs = [
    { x: R * 0.52, z: -R * 0.52, w: R * 0.34, h: 2.8, d: R * 0.20, rot: 0.15 },
    { x: R * 0.10, z: -R * 0.62, w: R * 0.30, h: 2.8, d: R * 0.18, rot: -0.1 },
    { x: -R * 0.60, z: -R * 0.42, w: R * 0.26, h: 2.8, d: R * 0.16, rot: 0.5 },
  ];
  for (const b of containerDefs) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d),
      new THREE.MeshStandardMaterial({ color: Math.random() > 0.5 ? 0x2f6f8f : 0x9a6a2f, metalness: 0.3, roughness: 0.75 }));
    m.position.set(b.x, DY + b.h / 2, b.z); m.rotation.y = b.rot; g.add(m);
    pushBox(def.x + b.x, def.z + b.z, b.w * 0.55, b.d * 0.55, DY, DY + b.h);
  }
  // 两个立式储罐
  for (const s of [-1, 1]) {
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.10, R * 0.10, 5.0, 12), S);
    tank.position.set(-R * 0.30 + s * R * 0.20, DY + 2.5, R * 0.60); g.add(tank);
  }

  /* ---- 火炬臂（斜伸出海面的一根长管）---- */
  beam(g, [R * 0.9, DY, -R * 0.9], [R * 1.9, DY + 14, -R * 1.9], 0.45, SD);
  const flareTip = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffb14a, transparent: true, opacity: 0.85 }));
  flareTip.position.set(R * 1.9, DY + 14.6, -R * 1.9); g.add(flareTip);

  /* ---- 火焰（默认隐藏；打炸后显示）---- */
  const fireG = new THREE.Group();
  fireG.visible = false;
  g.add(fireG);
  const flames = [];
  const nF = def.big ? 26 : 18;
  for (let i = 0; i < nF; i++) {
    const a = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(Math.random()) * R * 0.84;
    // 火焰尺寸按平台半径缩放：甲板 96m 宽时 r=3 的火苗只是个小点，要 4~7m 才成"一片火海"
    const h = rand(R * 0.16, R * 0.40), fr = rand(R * 0.06, R * 0.12);
    const f = makeFlame(i % 3 === 0 ? 0xffc247 : (i % 3 === 1 ? 0xff7a1e : 0xe8451a), h, fr);
    f.position.set(Math.cos(a) * rr, DY, Math.sin(a) * rr);
    f.rotation.y = Math.random() * 3;
    fireG.add(f);
    flames.push({ mesh: f, phase: Math.random() * 6.28, baseH: h, h, fr });
  }
  // 火场底盘（橙色发光圆）
  const glow = new THREE.Mesh(new THREE.CircleGeometry(R * 0.95, 30),
    new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 0.30, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.rotation.x = -Math.PI / 2; glow.position.y = DY + 0.06; fireG.add(glow);
  fireG.userData.glow = glow;
  // 黑烟柱
  const smokes = [];
  for (let i = 0; i < (def.big ? 6 : 4); i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(rand(R * 0.09, R * 0.16), 8, 6),
      new THREE.MeshBasicMaterial({ color: 0x1a1d21, transparent: true, opacity: 0.30, depthWrite: false }));
    const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * R * 0.7;
    s.position.set(Math.cos(a) * rr, DY + rand(8, 20), Math.sin(a) * rr);
    s.userData.y0 = s.position.y; s.userData.spd = rand(4, 9); s.userData.drift = rand(-3, 3);
    fireG.add(s); smokes.push(s);
  }

  const rig = {
    id: def.id, x: def.x, z: def.z, r: R, deckTop: DY,
    // 伤害判定半径：甲板边缘略收，火柱对外缘最烫
    edgeR: R * 1.02, coreR: R * 0.52, fireH: 30,
    maxHp: Math.round(R * 22), hp: Math.round(R * 22), dead: false,
    boxes,
    group: g, fireG, flames, smokes, glow,
    towerTop: DY + DH,
  };
  RIGS.push(rig);
  return rig;
}

function buildOilRig(root, colliders, dynamic, sunDir, quality) {
  root.add(new THREE.HemisphereLight(0xd8ecff, 0x2a4a55, 0.55));
  root.add(setupSun(sunDir, {
    color: 0xfff0d8, intensity: 2.3, dist: 2000,
    shadows: quality && quality.shadows, mapSize: quality ? quality.shadowSize : 0, half: 1200
  }));

  // 海面（低粗糙度 → 反射天空环境贴图）
  const sea = new THREE.Mesh(
    new THREE.CircleGeometry(4600, 80),
    new THREE.MeshStandardMaterial({ color: 0x1a5b84, roughness: 0.12, metalness: 0.08, envMapIntensity: 0.9 })
  );
  sea.rotation.x = -Math.PI / 2;
  root.add(sea);

  RIGS.length = 0;
  for (const def of RIG_DEFS) buildRig(root, def, colliders);
}

export const MAP = {
  id: 'oilrig',
  name: '海上钻井平台',
  desc: '五座平台 · 打炸即燃',
  sky: { top: 0x1a5ec0, horizon: 0xd8ecfa, elevation: 48, azimuth: 120 },
  background: 0x8fb8d6,
  fog: [0xa9c9dd, 1500, 5200],
  bounds: { warn: 1350, hurt: 1550, ceiling: 720 },
  aaSpawns: null,
  build(root, colliders, dynamic, ctx) {
    buildOilRig(root, colliders, dynamic, ctx.sunDir, ctx.quality);
  }
};
