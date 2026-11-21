// js/heli.js —— MH-6「小鸟」直升机：载具内核（模型 + 视角领先操控）
//
// v3.20 模型重做：旧版是「旋成体 + 一堆直接怼进蒙皮的方块」——
//   机炮吊舱半埋在机腹里、滑橇横撑从蒙皮里穿出来、外挂长凳压在机身上，
//   近距离一眼就能看到部件互相穿插（用户报的"穿模太多"）。
//   新版按「真实装配关系」重建：每个外挂件都有独立的挂架/支座，与机身留出间隙，
//   所有杆件用 rod(端点, 端点) 精确摆放（不再用欧拉角"估"角度），
//   旋转件（炮塔/旋翼/尾桨）的扫掠范围内不放任何其它几何。
//
// 操控：
//   · 鼠标 = 视角（绝对角，1:1）→ 机头缓慢追随视角；小准星恒在屏幕中心 = 弹道方向
//   · W/S 前进 / 后退；A/D 纯横向平移；Q/E 上升 / 下降；可悬停
//   · 姿态：前飞时机头下压（随速度）+ 加速额外低头；转弯/侧移向内侧压坡度
//   · 相机跟"视角"而不是"炮塔"→ 机体追赶时画面不再被拽回（修复一抽一抽）
//   · 所有角度差都做 ±π 归一 → 不会绕远路 / 下一回合原地狂转
import * as THREE from 'three';

export const HELI = {
  speedMax: 108, speedBack: -40,
  accel: 1.4,            // 速度响应
  yawRate: 2.2,          // 机体追赶视角的基础角速度
  yawRateMax: 4.6,       // 大偏差时的追赶上限
  aimSens: 0.0021,       // 鼠标 → 视角灵敏度
  pitchMin: -0.85, pitchMax: 0.55,   // 视角俯仰范围（下 / 上）
  climbMax: 20, climbAccel: 2.8,
  strafeMax: 16, strafeAccel: 2.4,
  cruisePitch: 0.17,     // 满速前飞时的机头下压角（弧度）
  accelPitch: 0.010,     // 加速度 → 额外低头系数
  pitchMaxAtt: 0.30,     // 姿态俯仰上限
  rollMax: 0.42,
  rotorSpin: 26, tailSpin: 62,
  hoverBob: 0.035,
};

export const MG_LIMIT = {
  yaw: THREE.MathUtils.degToRad(150),
  pitchUp: THREE.MathUtils.degToRad(55),
  pitchDown: THREE.MathUtils.degToRad(80),
};

const _e = new THREE.Euler();
const _dir = new THREE.Vector3();
const _v1 = new THREE.Vector3();

// 角度归一化到 (-π, π]
export function wrapPi(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/* 材质统一压金属度：旧版 metalness 0.6~0.85 的"哑光黑"部件会整块反射天空，
   远景看着像浅蓝色塑料。旋翼/蒙皮这类大面积件必须粗糙。 */
const std = (color, m = 0.25, r = 0.68, extra) => new THREE.MeshStandardMaterial(Object.assign({ color, metalness: m, roughness: r }, extra || {}));

const _UP = new THREE.Vector3(0, 1, 0);
/* 两点之间摆一根圆柱：端点即几何端点，不用手算欧拉角（旧版靠 rx/rz 猜角度，
   斜撑经常一端插进蒙皮、另一端浮在空中）。 */
function rodMesh(geo, mat, p0, p1, parent) {
  const m = new THREE.Mesh(geo, mat);
  const a = new THREE.Vector3().fromArray(p0), b = new THREE.Vector3().fromArray(p1);
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(_UP, d.normalize());
  m.scale.y = len;                     // 几何按 1m 长建，缩放到实际长度
  return m;
}

/* =====================================================================
   MH-6 Little Bird（机头朝 -Z，全长 ≈ 8.7m，主旋翼直径 8.0m）
   ===================================================================== */
export function buildHeli(color, opts) {
  const o = opts || {};
  const group = new THREE.Group();       // 位置 + 航向（yaw/pitch）
  const mesh = new THREE.Group();        // 视觉层（滚转 / 悬停浮动）
  group.add(mesh);

  const team = new THREE.Color(color);
  const bodyColor = team.clone().lerp(new THREE.Color(0x1b2320), 0.62);   // 军绿/近黑
  const body = std(bodyColor, 0.18, 0.62);
  const bodyDark = std(bodyColor.clone().multiplyScalar(0.72), 0.2, 0.66);
  const accent = std(team, 0.3, 0.5, { emissive: team.clone().multiplyScalar(0.16) });
  const metal = std(0x555d66, 0.72, 0.38);
  const tube = std(0x39424a, 0.28, 0.66);
  const dark = std(0x1a2026, 0.18, 0.74);
  const rubber = std(0x101418, 0.12, 0.9);
  const glass = new THREE.MeshStandardMaterial({
    color: 0x8fc4dd, metalness: 0.25, roughness: 0.06,
    transparent: true, opacity: 0.30, side: THREE.DoubleSide, depthWrite: false,
  });

  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    (parent || mesh).add(m); return m;
  };
  // 单位长（1m）圆柱，rodMesh 负责摆位 + 拉长
  const rodGeo = (r0, r1, seg) => new THREE.CylinderGeometry(r0, r1, 1, seg || 8);
  const rod = (p0, p1, r0, r1, mat, parent) => {
    const m = rodMesh(rodGeo(r0, r1), mat, p0, p1);
    (parent || mesh).add(m); return m;
  };

  /* ---------- 1. 机身：一条连续的旋成体（机头 → 尾梁根部） ----------
     剖面 (半径, 轴向) 由机头 0 到 4.45；rotateX(90°) 映射到 +Z 后平移 -3.05
     → 机头尖 z=-3.05，尾梁根部 z=1.40。半径峰值 0.945 在座舱后段，向后平顺收进尾梁。 */
  const profile = [
    [0.03, 0.00], [0.15, 0.09], [0.27, 0.22], [0.41, 0.40], [0.55, 0.61],
    [0.68, 0.85], [0.79, 1.11], [0.87, 1.40], [0.92, 1.70], [0.945, 2.00],
    [0.945, 2.26], [0.915, 2.50], [0.865, 2.72], [0.795, 2.94], [0.705, 3.14],
    [0.605, 3.34], [0.505, 3.53], [0.405, 3.72], [0.325, 3.90], [0.265, 4.08],
    [0.205, 4.24], [0.135, 4.38], [0.04, 4.45],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const fusGeo = new THREE.LatheGeometry(profile, 30);
  fusGeo.rotateX(Math.PI / 2);          // y → z（机头 -Z）
  fusGeo.translate(0, 0, -3.05);
  const fus = new THREE.Mesh(fusGeo, body);
  fus.scale.x = 0.88;                   // 截面略扁：小鸟是"宽扁蛋形"，不是正圆
  mesh.add(fus);

  // 机腹龙骨：贴在最底下的一条窄整流罩（沿机身轴向，不切进蒙皮）
  add(new THREE.CapsuleGeometry(0.15, 2.5, 4, 8), bodyDark, 0, -0.80, -0.30, Math.PI / 2, 0, 0).scale.y = 0.72;

  /* ---------- 2. 座舱：气泡风挡 + 舱底沿 + 贴合表面的框条 ---------- */
  // 气泡罩：上半球壳，底面落在机身背部 → 不与蒙皮打架
  const domeGeo = new THREE.SphereGeometry(1, 26, 14, 0, Math.PI * 2, 0, Math.PI * 0.5);
  const dome = new THREE.Mesh(domeGeo, glass);
  dome.position.set(0, 0.34, -1.74);
  dome.scale.set(0.80, 0.80, 1.24);
  mesh.add(dome);
  // 舱底沿（椭圆环，压在玻璃与机身交界处）
  const rim = add(new THREE.TorusGeometry(0.84, 0.032, 6, 30), dark, 0, 0.36, -1.74, Math.PI / 2, 0, 0);
  rim.scale.set(1.0, 1.46, 1);
  /* 框条：气泡座舱本来就没有几根框（MH-6 就是一块大玻璃）。
     旧版在玻璃上"搭"了 5 根圆柱，杆子一半在玻璃里一半在空中，是最明显的穿模源；
     现在只保留舱底沿这一圈，玻璃上不再有任何杆件。
     （机头下颚窗也去掉了：那是第二个玻璃球，会在鼻子下方鼓出一块透明泡。） */

  /* ---------- 3. 发动机舱 / 主减速器 / 排气 ---------- */
  const deck = add(new THREE.CapsuleGeometry(0.34, 1.02, 5, 12), body, 0, 0.62, 0.28, Math.PI / 2, 0, 0);
  deck.scale.set(1.0, 0.80, 1.0);                                              // 压扁：贴合机背的整流罩，不是圆罐
  add(new THREE.BoxGeometry(0.58, 0.16, 0.54), metal, 0, 0.90, -0.36);          // 主减速器
  // 排气：右侧向后上方，管口在罩子外侧（不再插进尾梁）
  rod([0.30, 0.66, 0.66], [0.50, 0.80, 1.22], 0.15, 0.13, dark);
  add(new THREE.TorusGeometry(0.14, 0.024, 5, 12), metal, 0.50, 0.80, 1.22, Math.PI / 2 - 0.34, 0, 0.22);
  // 机身两侧队伍色识别条（贴在蒙皮外侧）
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.02, 0.05, 2.2), accent, s * 0.79, 0.14, -0.30);

  /* ---------- 4. 尾梁 + 垂尾 + T 型平尾 + 尾桨 ----------
     v3.28.4：整段尾段收进 tailBoom 组 —— 尾梁被打断时可以直接整段隐藏，
     玩家一眼就能看出"尾巴没了"，而不是只看到机身莫名其妙地打转。 */
  const tailBoom = new THREE.Group();
  mesh.add(tailBoom);
  rod([0, 0.16, 1.30], [0, 0.20, 5.72], 0.22, 0.125, body, tailBoom);
  // 垂尾（后掠）
  add(new THREE.BoxGeometry(0.09, 1.14, 0.50), body, 0, 0.76, 5.60, -0.18, 0, 0, tailBoom);
  add(new THREE.BoxGeometry(0.08, 0.38, 0.30), accent, 0, 1.16, 5.76, -0.18, 0, 0, tailBoom);   // 顶帽（队伍色）
  // T 型平尾：坐在垂尾顶端，两端带端板
  add(new THREE.BoxGeometry(1.80, 0.05, 0.40), body, 0, 1.22, 5.56, -0.04, 0, 0, tailBoom);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.08, 0.14, 0.26), dark, s * 0.90, 1.22, 5.56, 0, 0, 0, tailBoom);
  // 尾撑斜杆（尾梁上表面 → 平尾）
  rod([0, 0.30, 4.92], [0, 1.18, 5.52], 0.03, 0.03, tube, tailBoom);

  // 尾桨（左侧）：桨毂 + 2 叶，扫掠面与垂尾留 0.06m 间隙
  const tail = new THREE.Group(); tail.position.set(-0.28, 0.92, 5.62); tailBoom.add(tail);
  add(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 10), dark, 0, 0, 0, 0, 0, Math.PI / 2, tail);
  for (let i = 0; i < 2; i++) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.62, 0.095), dark);
    t.position.set(0, Math.sin(i * Math.PI) * 0.31, Math.cos(i * Math.PI) * 0.31);
    t.rotation.x = i * Math.PI;
    tail.add(t);
  }

  /* ---------- 5. 滑橇起落架：橇管 + 前后各两根斜撑（端点精确相连） ---------- */
  const SKID_Y = -1.26, SKID_X = 0.78;
  for (const sx of [-1, 1]) {
    const x = sx * SKID_X;
    // 橇管：主体 + 前段上翘 + 尾端上翘
    rod([x, SKID_Y, -1.05], [x, SKID_Y + 0.06, 1.10], 0.052, 0.052, tube);
    rod([x, SKID_Y + 0.06, -1.05], [x, SKID_Y + 0.34, -1.72], 0.05, 0.05, tube);
    rod([x, SKID_Y + 0.06, 1.10], [x, SKID_Y + 0.30, 1.58], 0.048, 0.048, tube);
    // 斜撑：橇管 → 机身下侧（两个端点都在实体表面，无穿插）
    rod([x, SKID_Y, -0.60], [sx * 0.42, -0.78, -0.60], 0.042, 0.042, tube);
    rod([x, SKID_Y, 0.82], [sx * 0.42, -0.76, 0.82], 0.042, 0.042, tube);
    // 橇管端头防滑垫
    add(new THREE.BoxGeometry(0.10, 0.04, 0.16), rubber, x, SKID_Y - 0.02, -1.70);
  }
  // 横向连接管（两根，接在橇管与斜撑交点上方）
  rod([-SKID_X, SKID_Y, -0.60], [SKID_X, SKID_Y, -0.60], 0.038, 0.038, tube);
  rod([-SKID_X, SKID_Y, 0.82], [SKID_X, SKID_Y, 0.82], 0.038, 0.038, tube);

  /* ---------- 6. MH-6 外挂长凳（特种部队侧座）：挂架 + 座板 + 靠背 ---------- */
  if (o.benches !== false) {
    for (const s of [-1, 1]) {
      // 座板：贴着机腹外沿的窄条（离蒙皮 0.02m），不是整块大平板
      add(new THREE.BoxGeometry(0.34, 0.05, 1.05), bodyDark, s * 0.99, -0.60, -0.62);
      // 靠背：竖直板 + 两道斜撑连到机身
      add(new THREE.BoxGeometry(0.04, 0.26, 1.05), bodyDark, s * 1.14, -0.46, -0.62);
      rod([s * 1.13, -0.34, -1.05], [s * 0.72, -0.28, -1.05], 0.02, 0.02, metal);
      rod([s * 1.13, -0.34, -0.20], [s * 0.72, -0.28, -0.20], 0.02, 0.02, metal);
      // 座板 → 机腹的两根吊杆
      rod([s * 0.98, -0.58, -1.02], [s * 0.66, -0.82, -1.02], 0.022, 0.022, metal);
      rod([s * 0.98, -0.58, -0.22], [s * 0.66, -0.82, -0.22], 0.022, 0.022, metal);
    }
  }

  /* ---------- 7. 主旋翼：桅杆 + 桨毂 + 5 叶 + 桨盘 ---------- */
  add(new THREE.CylinderGeometry(0.09, 0.12, 0.64, 10), metal, 0, 1.26, -0.52);
  add(new THREE.CylinderGeometry(0.18, 0.18, 0.12, 10), dark, 0, 1.58, -0.52);
  const prop = new THREE.Group(); prop.position.set(0, 1.62, -0.52); mesh.add(prop);
  add(new THREE.CylinderGeometry(0.14, 0.16, 0.18, 10), dark, 0, 0, 0, 0, 0, 0, prop);
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI * 2) / 5;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.06, 0.32), metal);
    grip.position.set(Math.sin(a) * 0.24, 0, Math.cos(a) * 0.24);
    grip.rotation.y = a; prop.add(grip);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.038, 3.64), dark);
    blade.position.set(Math.sin(a) * 2.16, 0, Math.cos(a) * 2.16);
    blade.rotation.y = a;
    blade.rotation.x = 0.018;            // 轻微锥度
    prop.add(blade);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.235, 0.042, 0.18), accent);
    tip.position.set(Math.sin(a) * 3.92, 0, Math.cos(a) * 3.92);
    tip.rotation.y = a;
    prop.add(tip);
  }
  // 旋翼盘（极淡，告诉玩家桨叶范围）
  const tipRing = new THREE.Mesh(
    new THREE.CylinderGeometry(3.92, 3.92, 0.012, 40, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xbcd2e4, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }));
  prop.add(tipRing);

  /* ---------- 8. 光电球 / 天线 / 航行灯 ---------- */
  add(new THREE.SphereGeometry(0.115, 12, 10), dark, 0, -0.06, -2.94);         // 机头光电球
  add(new THREE.CylinderGeometry(0.011, 0.008, 0.54, 5), metal, 0, 0.60, 2.24, 0.26, 0, 0);   // 鞭状天线
  const lampR = new THREE.MeshStandardMaterial({ color: 0x8a1f1f, emissive: 0xff2a2a, emissiveIntensity: 2.0 });
  const lampG = new THREE.MeshStandardMaterial({ color: 0x1f7a3a, emissive: 0x2aff5a, emissiveIntensity: 2.0 });
  const lampW = new THREE.MeshStandardMaterial({ color: 0xcfd8e0, emissive: 0xfff2c8, emissiveIntensity: 1.5 });
  add(new THREE.SphereGeometry(0.042, 8, 6), lampR, -0.74, 0.06, -2.26);
  add(new THREE.SphereGeometry(0.042, 8, 6), lampG, 0.74, 0.06, -2.26);
  add(new THREE.SphereGeometry(0.038, 8, 6), lampW, 0, 0.32, 5.94);

  /* ---------- 9. 机腹炮塔：挂架 + 转座 + 机炮 ----------
     ★ 旧版把炮舱放在 y=-0.62，机身半径 0.95 → 整个炮舱埋在蒙皮里，只能看到一截枪管"长"出来。
     新版：挂架吊在机腹下方（y=-0.86 → -1.06），转座在 y=-1.08，枪管轴 y=-1.14，
     两侧滑橇（y=-1.26 / x=±0.78）之内，扫掠范围与滑橇、蒙皮都不相交。 */
  const mgPod = new THREE.Group(); mgPod.position.set(0, -1.08, -1.42); mesh.add(mgPod);
  // 挂架（不随炮塔转：固定吊挂，视觉上把炮舱"挂"在机腹）
  rod([0, -0.80, -1.42], [0, -1.06, -1.42], 0.09, 0.09, metal);
  add(new THREE.CylinderGeometry(0.125, 0.125, 0.10, 10), metal, 0, 0, 0, 0, 0, 0, mgPod);   // 转座
  add(new THREE.BoxGeometry(0.32, 0.26, 0.58), bodyDark, 0, -0.06, -0.22, 0, 0, 0, mgPod);  // 炮舱
  add(new THREE.SphereGeometry(0.15, 12, 9), dark, 0, -0.05, -0.52, 0, 0, 0, mgPod);        // 球形耳轴
  // 枪管护套 + 枪管（都在炮舱前方，轴线 y 稳定在 -0.05）
  add(new THREE.CylinderGeometry(0.058, 0.048, 0.26, 8), metal, 0, -0.05, -0.66, Math.PI / 2, 0, 0, mgPod);
  add(new THREE.CylinderGeometry(0.036, 0.036, 0.74, 8), dark, 0, -0.05, -1.10, Math.PI / 2, 0, 0, mgPod);
  add(new THREE.CylinderGeometry(0.050, 0.042, 0.11, 8), metal, 0, -0.05, -1.46, Math.PI / 2, 0, 0, mgPod);
  // 供弹盒（挂在炮舱侧面，不进入机身）
  add(new THREE.BoxGeometry(0.09, 0.24, 0.30), metal, 0.20, -0.02, -0.16, 0, 0, 0, mgPod);
  // 枪口节点（world 用；子弹/枪口焰从这里出）
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, -0.05, -1.54); mgPod.add(muzzle);

  /* ---------- 10. 霰弹吊舱（新模式专用：机身两侧各一具双管） ----------
     挂在机腹外扩挂梁上（x=±1.02），与滑橇（x=±0.78）、长凳（x=±0.99）错开高度：
     吊舱 y=-0.64，长凳座板 y=-0.60 但 z 段不同（吊舱 z=-0.55 处机身半径更大），
     实测两件不重叠；挂梁端点落在蒙皮外 0.02m。 */
  const shotPods = [];
  if (o.shotgun) {
    for (const s of [-1, 1]) {
      const pod = new THREE.Group();
      pod.position.set(s * 1.02, -0.66, -0.50);
      mesh.add(pod);
      rod([s * 0.62, -0.52, -0.50], [s * 0.88, -0.64, -0.50], 0.045, 0.045, metal);
      add(new THREE.BoxGeometry(0.28, 0.24, 0.80), bodyDark, 0, 0, -0.04, 0, 0, 0, pod);
      add(new THREE.CylinderGeometry(0.034, 0.034, 0.74, 8), dark, s * 0.06, -0.03, -0.70, Math.PI / 2, 0, 0, pod);
      add(new THREE.CylinderGeometry(0.028, 0.028, 0.74, 8), dark, s * 0.06, 0.05, -0.70, Math.PI / 2, 0, 0, pod);
      const tip = new THREE.Object3D();
      tip.position.set(s * 0.05, 0.015, -0.98);
      pod.add(tip);
      shotPods.push(tip);
    }
  }

  /* ---------- 弱点（局部坐标，判定球比模型略大一点，便于命中） ----------
     v3.31：判定球只负责几何；伤害倍率由 heli / heli2 模式文件夹的 damage.js 决定
     （驾驶舱 3× / 发动机 2× / 尾梁 1.5×）。 */
  const weakPoints = [
    { name: '驾驶舱', part: 'cockpit', offset: new THREE.Vector3(0, 0.30, -1.80), r: 2.3, _w: new THREE.Vector3() },
    { name: '发动机', part: 'engine', offset: new THREE.Vector3(0, 0.72, 0.35), r: 2.1, _w: new THREE.Vector3() },
    { name: '尾梁', part: 'tail', offset: new THREE.Vector3(0, 0.16, 4.60), r: 2.6, _w: new THREE.Vector3() },
  ];

  // 机头摄像头（枪口视角用）：在机头蒙皮（-3.05）与下颚面板前方
  const gunCam = new THREE.Object3D();
  gunCam.position.set(0, -0.70, -3.38);
  mesh.add(gunCam);

  /* v3.14.7：把「旋翼怎么转」写进模型，远端玩家（别人的客户端里）也能正确转 ——
     旧版 loop.js 对所有远端飞机统一 `prop.rotation.z -= dt*40`（那是螺旋桨的轴向），
     直升机的 prop 是主旋翼盘，绕 z 转会整个盘翻滚 = 防空车玩家看到的"鬼畜旋翼"。
     propAxis/propSpeed/tailSpeed 由 loop.js 的远端插值分支读取。 */
  return {
    group, mesh, prop, weakPoints, shotPods,
    guns: [new THREE.Vector3(0, -1.13, -2.96), new THREE.Vector3(0, -1.13, -2.96)],
    muzzle, mgPod, tail, tailBoom, gunCam,
    propAxis: 'y', propSpeed: HELI.rotorSpin, tailSpeed: HELI.tailSpin,
  };
}

/* ---------- 航空炸弹模型 ---------- */
export function buildBomb() {
  const g = new THREE.Group();
  const dark = std(0x2d333a, 0.55, 0.42);
  const band = std(0xd8a33a, 0.4, 0.5);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.20, 0.95, 12), dark);
  body.rotation.x = Math.PI / 2; g.add(body);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.20, 12, 9), dark);
  nose.scale.z = 1.9; nose.position.z = -0.53; g.add(nose);
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.10, 12), band);
  ring.rotation.x = Math.PI / 2; ring.position.z = -0.26; g.add(ring);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.36, 0.30), dark);
    fin.position.set(Math.sin(a) * 0.24, Math.cos(a) * 0.24, 0.45);
    fin.rotation.z = -a; g.add(fin);
  }
  const lug = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 0.22), std(0x59616a, 0.7, 0.4));
  lug.position.set(0, 0.22, 0.05); g.add(lug);
  return g;
}

/* ---------- 实体 ---------- */
export function makeHeli(plane, opts) {
  const o = opts || {};
  // 机身两侧常驻挂弹（v3.10.5）：与 dropBomb 的 releasePos 同坐标（mesh 层），
  // 投一侧隐藏一侧（dropBomb），回合重置恢复（resetHeli）。
  // 新模式（机炮+霰弹）不需要挂弹 → opts.bombs === false 时整段跳过。
  let bombL = null, bombR = null;
  if (o.bombs !== false) {
    bombL = buildBomb(); bombL.position.set(-1.18, -0.56, 0.45);
    bombR = buildBomb(); bombR.position.set(1.18, -0.56, 0.45);
    plane.mesh.add(bombL); plane.mesh.add(bombR);
  }
  return {
    plane, yaw: 0, pitch: 0, roll: 0, yawVel: 0,
    speed: 0, targetSpeed: 0, vSpeed: 0, strafe: 0,
    hp: 100, alive: true, gunSide: false, kind: 'heli',
    viewYaw: 0, viewPitch: 0, mgYaw: 0, mgPitch: 0,
    vel: new THREE.Vector3(),
    bombs: bombL ? { left: true, right: true } : null,
    bombRack: bombL ? { left: bombL, right: bombR } : null,
    bobPhase: Math.random() * Math.PI * 2,
  };
}

/* ---------- 重置（出生 / 新回合）：视角、姿态、速度全部对齐机头 ---------- */
export function resetHeli(f, yaw) {
  if (!f) return;
  f.yaw = wrapPi(yaw || 0);
  f.pitch = 0; f.roll = 0; f.yawVel = 0;
  f.viewYaw = f.yaw; f.viewPitch = 0;
  f.mgYaw = 0; f.mgPitch = 0;
  f.speed = 0; f.targetSpeed = 0; f.vSpeed = 0; f.strafe = 0;
  if (f.vel) f.vel.set(0, 0, 0);
  if (f.bombs) f.bombs = { left: true, right: true };
  const p = f.plane;
  if (p) {
    if (p.mesh) { p.mesh.rotation.x = 0; p.mesh.rotation.z = 0; }
    if (p.mgPod) { p.mgPod.rotation.set(0, 0, 0); }
    if (p.tailBoom) p.tailBoom.visible = true;
    if (p.tail) p.tail.visible = true;
    if (f.bombRack) { f.bombRack.left.visible = true; f.bombRack.right.visible = true; }   // 新回合挂弹回位
    p.group.quaternion.setFromEuler(_e.set(0, f.yaw, 0, 'YXZ'));
  }
}

/* ---------- 瞄准：鼠标累积绝对视角 → 炮塔限幅 → 大准星 = 机头相对视角偏移 ---------- */
export function aimHeli(f, ctx) {
  const c = ctx || {};
  const k = c.ctlActive ? 1 : 0;
  if (f.viewYaw === undefined) f.viewYaw = f.yaw || 0;
  f.viewYaw = wrapPi(f.viewYaw - (c.rawAccX || 0) * HELI.aimSens * k);
  f.viewPitch = THREE.MathUtils.clamp(
    (f.viewPitch || 0) - (c.rawAccY || 0) * HELI.aimSens * k,
    HELI.pitchMin, HELI.pitchMax);
  // 炮塔相对机身（限幅）
  f.mgYaw = THREE.MathUtils.clamp(wrapPi(f.viewYaw - f.yaw), -MG_LIMIT.yaw, MG_LIMIT.yaw);
  f.mgPitch = THREE.MathUtils.clamp(f.viewPitch - (f.pitch || 0), -MG_LIMIT.pitchDown, MG_LIMIT.pitchUp);
  // 大准星 = 相机相对机身：屏幕坐标偏移（clamp 到边缘内，避免飞出屏幕）
  if (c.setAim) {
    c.setAim(
      THREE.MathUtils.clamp(wrapPi(f.viewYaw - f.yaw), -0.62, 0.62),
      THREE.MathUtils.clamp(f.viewPitch - (f.pitch || 0), -0.5, 0.5));
  }
}

/* ---------- 飞行 ----------
   机头以有限角速度追赶"视角"（不是炮塔）；姿态由速度和加速度决定；存世界速度供投弹继承 */
export function flightHeli(f, dt, ctx) {
  const keys = (ctx && ctx.keys) || {};
  if (f.vSpeed === undefined) f.vSpeed = 0;
  if (f.strafe === undefined) f.strafe = 0;
  if (!f.vel) f.vel = new THREE.Vector3();
  if (f.bobPhase === undefined) f.bobPhase = Math.random() * Math.PI * 2;
  if (f.viewYaw === undefined) f.viewYaw = f.yaw || 0;

  if (ctx && ctx.isBot) {
    /* ---- AI：跟 ai.js 的 HeliBot 给出的目标角飞，保持 55~110m 高度带 ---- */
    const dy = wrapPi((f.targetYaw || 0) - f.yaw);
    const turn = THREE.MathUtils.clamp(dy, -HELI.yawRate * 1.5 * dt, HELI.yawRate * 1.5 * dt);
    f.yaw = wrapPi(f.yaw + turn); f.yawVel = turn / Math.max(dt, 1e-4);
    if (f.targetPitch !== undefined) f.pitch += (THREE.MathUtils.clamp(f.targetPitch, -0.6, 0.6) - f.pitch) * Math.min(1, dt * 3.0);
    /* 速度：Bot.update 已按战术给的 targetSpeed 平滑过（HeliBot.speedLerp = 1.6），
       这里不再二次积分。旧版写死 speedMax*0.72 → AI 不管想悬停还是想后退都永远 78 m/s。 */
    /* 横向漂移：机头仍对着目标（射击判定只看机头），机身缓慢侧移 —— 悬停压制时不会像桩子。 */
    const wantStrafe = THREE.MathUtils.clamp(f.targetStrafe || 0, -HELI.strafeMax, HELI.strafeMax);
    f.strafe += (wantStrafe - f.strafe) * Math.min(1, dt * 1.5);
    const y = f.plane.group.position.y;
    if (y < 62) f.vSpeed += (12 - f.vSpeed) * Math.min(1, dt * 1.5);
    else if (y > 108) f.vSpeed += (-14 - f.vSpeed) * Math.min(1, dt * 1.5);
    else f.vSpeed += (0 - f.vSpeed) * Math.min(1, dt * 1.2);
    const gb = f.plane.group;
    _e.set(f.pitch, f.yaw, 0, 'YXZ');
    _dir.set(0, 0, -1).applyEuler(_e);
    _v1.set(1, 0, 0).applyEuler(_e);       // 机身右向（pitch 绕 X 轴，不影响 X 轴方向）
    f.vel.copy(_dir).multiplyScalar(f.speed).addScaledVector(_v1, f.strafe);
    f.vel.y += f.vSpeed;
    gb.position.addScaledVector(f.vel, dt);
    gb.quaternion.setFromEuler(_e);
    /* AI 直升机每帧写入 mesh 滚转，避免上一回合的姿态残留到下一回合。 */
    const m = f.plane.mesh;
    if (m) { m.rotation.x = 0; m.rotation.z = f.roll || 0; }
    if (f.plane.prop) f.plane.prop.rotation.y += dt * HELI.rotorSpin;
    if (f.plane.tail) f.plane.tail.rotation.x += dt * HELI.tailSpin;
    return;
  }

  /* ---- 机体偏航追赶视角（±π 归一 → 永远走最短路径，不会绕圈） ---- */
  const dyaw = wrapPi(f.viewYaw - f.yaw);
  const rate = HELI.yawRate + Math.min(HELI.yawRateMax - HELI.yawRate, Math.abs(dyaw) * 1.6);
  const step = THREE.MathUtils.clamp(dyaw, -rate * dt, rate * dt);
  f.yaw = wrapPi(f.yaw + step);
  f.yawVel = step / Math.max(dt, 1e-4);

  /* ---- W/S 前后；A/D 纯横移；Q/E 升降 ----
     Android：左摇杆 = 前后 / 左右平移（模拟量），加速/减速按钮改作 上升 / 下降 ---- */
  const android = !!(ctx && ctx.isAndroid);
  const fwdIn = android
    ? THREE.MathUtils.clamp(-(ctx.joyY || 0), -1, 1)
    : (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
  const want = fwdIn >= 0 ? fwdIn * HELI.speedMax : fwdIn * (-HELI.speedBack);
  const prevSpeed = f.speed;
  f.speed += (want - f.speed) * Math.min(1, dt * HELI.accel);
  const strafeIn = android
    ? THREE.MathUtils.clamp(ctx.joyX || 0, -1, 1)
    : (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  f.strafe += (strafeIn * HELI.strafeMax - f.strafe) * Math.min(1, dt * HELI.strafeAccel);
  const up = android
    ? (ctx.throttle || 0)
    : (keys.KeyQ ? 1 : 0) - (keys.KeyE ? 1 : 0);
  f.vSpeed += (up * HELI.climbMax - f.vSpeed) * Math.min(1, dt * HELI.climbAccel);

  /* ---- 世界速度（投弹继承 / 物理一致） ---- */
  const g = f.plane.group;
  _e.set(0, f.yaw, 0, 'YXZ');
  _dir.set(0, 0, -1).applyEuler(_e);      // 前
  _v1.set(1, 0, 0).applyEuler(_e);        // 右
  f.vel.copy(_dir).multiplyScalar(f.speed).addScaledVector(_v1, f.strafe);
  f.vel.y += f.vSpeed;
  g.position.addScaledVector(f.vel, dt);

  /* ---- 姿态：前飞低头（随速度）+ 加速额外低头；转弯/侧移压坡度 ---- */
  const accel = (f.speed - prevSpeed) / Math.max(dt, 1e-4);
  const speedK = THREE.MathUtils.clamp(f.speed / HELI.speedMax, -0.4, 1);
  const dip = THREE.MathUtils.clamp(accel * HELI.accelPitch, -0.10, 0.10);
  const pitchT = THREE.MathUtils.clamp(-HELI.cruisePitch * speedK - dip, -HELI.pitchMaxAtt, HELI.pitchMaxAtt);
  f.pitch += (pitchT - (f.pitch || 0)) * Math.min(1, dt * 2.6);
  // 左转（yaw 增大）→ 左倾（roll 正）；右移 → 右倾（负）
  const rollT = THREE.MathUtils.clamp(f.yawVel * 0.30 - f.strafe * 0.010, -HELI.rollMax, HELI.rollMax);
  f.roll += (rollT - (f.roll || 0)) * Math.min(1, dt * 3.6);

  const bob = Math.sin((f.bobPhase += dt * 1.6)) * HELI.hoverBob;
  _e.set(f.pitch, f.yaw, 0, 'YXZ');
  g.quaternion.setFromEuler(_e);
  const m = f.plane.mesh;
  m.rotation.x += (bob - m.rotation.x) * Math.min(1, dt * 5);
  m.rotation.z = f.roll;
  // 炮塔"视觉"跟随：角度衰减 + 硬限幅（±35° / -25°~+15°）。
  // 弹道不受影响（fireHeli 沿准星方向射击，mgDirection 不用这里的角度）。
  if (f.plane.mgPod) {
    const visYaw = THREE.MathUtils.clamp(f.mgYaw * 0.35, -0.61, 0.61);
    const visPitch = THREE.MathUtils.clamp(f.mgPitch * 0.5, -0.44, 0.26);
    f.plane.mgPod.rotation.y += (visYaw - f.plane.mgPod.rotation.y) * Math.min(1, dt * 18);
    f.plane.mgPod.rotation.x += (visPitch - f.plane.mgPod.rotation.x) * Math.min(1, dt * 18);
  }
  if (f.plane.prop) f.plane.prop.rotation.y += dt * HELI.rotorSpin;
  if (f.plane.tail) f.plane.tail.rotation.x += dt * HELI.tailSpin;
}

/* ---------- 炮塔世界方向 ---------- */
const _me2 = new THREE.Euler();
export function mgDirection(f, out) {
  out = out || new THREE.Vector3();
  _me2.set(f.mgPitch || 0, (f.yaw || 0) + (f.mgYaw || 0), 0, 'YXZ');
  return out.set(0, 0, -1).applyEuler(_me2);
}

/* ---------- 视角世界方向（相机 / 弹道汇聚） ---------- */
export function viewDirection(f, out) {
  out = out || new THREE.Vector3();
  _me2.set(f.viewPitch || 0, f.viewYaw || 0, 0, 'YXZ');
  return out.set(0, 0, -1).applyEuler(_me2);
}

/* ================= 机头枪镜 / 投弹视角 HUD（body 级动态创建，不依赖 index.html）=================
   v3.20.1：从 heli 模式包移到载具内核，heli（直升机突袭）与 heli2（直升机对决）共用同一套枪镜效果。
   kind: null 关闭 / 'gun' 机炮枪镜 / 'bomb' 投弹视角 / 'shot' 双管霰弹枪镜（hel i2）*/
let camUi = null;
export function ensureCamUi() {
  if (camUi) return camUi;
  const css = `
  #heliCamUi{position:fixed;inset:0;z-index:45;pointer-events:none;display:none;overflow:hidden;
    font:700 11px/1.5 'Noto Sans SC','PingFang SC',sans-serif;color:#a8ffd2;letter-spacing:2px;
    background:radial-gradient(ellipse at center,rgba(0,0,0,0) 46%,rgba(0,12,9,.42) 100%)}
  #heliCamUi.on{display:block}
  #heliCamUi .scan{position:absolute;inset:0;opacity:.10;
    background:repeating-linear-gradient(0deg,rgba(160,255,210,.55) 0 1px,transparent 1px 4px)}
  #heliCamUi .bk{position:absolute;width:58px;height:58px;border:2px solid rgba(150,255,205,.62)}
  #heliCamUi .bk.tl{left:26px;top:26px;border-right:0;border-bottom:0}
  #heliCamUi .bk.tr{right:26px;top:26px;border-left:0;border-bottom:0}
  #heliCamUi .bk.bl{left:26px;bottom:26px;border-right:0;border-top:0}
  #heliCamUi .bk.br{right:26px;bottom:26px;border-left:0;border-top:0}
  #heliCamUi .rec{position:absolute;right:34px;top:96px;color:#ff7a6b;letter-spacing:3px}
  #heliCamUi .rec i{display:inline-block;width:7px;height:7px;border-radius:50%;background:#ff5b4a;
    margin-right:6px;animation:hcamBlink 1.1s steps(1) infinite}
  @keyframes hcamBlink{50%{opacity:.15}}
  #heliCamUi .tag{position:absolute;left:34px;top:96px;color:#b6ffd9;text-shadow:0 0 10px rgba(60,255,170,.35)}
  #heliCamUi .tag b{font-size:13px;letter-spacing:3px}
  #heliCamUi .foot{position:absolute;left:50%;bottom:34px;transform:translateX(-50%);
    color:#8ff0c0;letter-spacing:4px;font-size:10px;opacity:.85;white-space:nowrap}
  /* 分划盘 SVG：必须以屏幕中心为中心的正方形盒子（viewBox 800×800 → meet 无偏移映射，
     中心圆 = 枪镜光轴）。旧版 top:50% + height:100% 把内容中心推到 100vh（屏幕下边缘），
     准星整个掉到屏幕下方。 */
  #heliCamUi .sv{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(78vw,780px);
    height:min(78vw,780px);pointer-events:none}
  #heliCamUi.bomb .tag{color:#ffd9a0;text-shadow:0 0 10px rgba(255,180,80,.4)}
  #heliCamUi.bomb .rec{color:#ffd9a0}
  #heliCamUi.shot .tag{color:#ffe0a8;text-shadow:0 0 10px rgba(255,190,90,.35)}
  #heliCamUi.shot .rec{color:#ffcf7a}
  #heliCamUi.bomb .sv{display:none}
  #heliCamUi.bomb .scan{opacity:.05;background:repeating-linear-gradient(90deg,rgba(255,220,150,.5) 0 1px,transparent 1px 5px)}
  `;
  const st = document.createElement('style'); st.id = 'heliCamUiCss'; st.textContent = css;
  document.head.appendChild(st);
  const el = document.createElement('div');
  el.id = 'heliCamUi';
  el.innerHTML = `
    <div class="scan"></div>
    <div class="bk tl"></div><div class="bk tr"></div><div class="bk bl"></div><div class="bk br"></div>
    <svg class="sv" viewBox="0 0 800 800" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <g fill="none" stroke="rgba(160,255,210,.85)" stroke-width="1.6">
        <circle cx="400" cy="400" r="58" opacity=".55"/>
        <circle cx="400" cy="400" r="4" fill="rgba(190,255,220,.95)" stroke="none"/>
        <path d="M400 296v56M400 448v56M296 400h56M448 400h56"/>
        <path d="M400 342v18M400 440v18M342 400h18M440 400h18" opacity=".65"/>
        <path d="M352 400h-30M448 400h30M400 352v-30M400 448v30" opacity=".35"/>
      </g>
      <g fill="rgba(160,255,210,.75)" stroke="none" font-family="monospace" font-size="13">
        <text x="404" y="286">000</text><text x="404" y="528">180</text>
      </g>
      <g stroke="rgba(160,255,210,.45)" stroke-width="1.2" fill="none">
        <path d="M400 176v22M400 602v22M176 400h22M602 400h22"/>
      </g>
    </svg>
    <div class="tag"><b>MH-6</b> · GUN CAM<br><span class="alt">ALT --- m</span></div>
    <div class="rec"><i></i>REC · 30MM</div>
    <div class="foot">右键退出枪镜 · 左键开火</div>`;
  document.body.appendChild(el);
  camUi = el;
  return el;
}

export function setCamUi(kind, alt) {
  if (!kind) {
    if (!camUi) return;
    if (camUi.dataset.kind) { camUi.classList.remove('on', 'bomb', 'shot'); camUi.dataset.kind = ''; }
    return;
  }
  const el = ensureCamUi();
  const changed = el.dataset.kind !== kind;
  if (changed) {
    el.classList.add('on');
    el.classList.toggle('bomb', kind === 'bomb');
    el.classList.toggle('shot', kind === 'shot');
    el.querySelector('.tag').innerHTML = kind === 'bomb'
      ? '<b>MH-6</b> · BOMB CAM<br><span class="alt">落点投影</span>'
      : '<b>MH-6</b> · ' + (kind === 'shot' ? 'SG CAM' : 'GUN CAM')
        + '<br><span class="alt">ALT ' + Math.round(alt || 0) + ' m</span>';
    el.querySelector('.rec').innerHTML = kind === 'bomb' ? '<i></i>BOMB · 500LB'
      : (kind === 'shot' ? '<i></i>DUAL SG · 12G' : '<i></i>REC · 30MM');
    el.querySelector('.foot').textContent = kind === 'bomb'
      ? '左键投弹 · 按 1 切回机枪'
      : (kind === 'shot' ? '右键退出 · 左键开火' : '右键退出 · 左键开火');
    el.dataset.kind = kind;
  } else if (kind === 'gun' || kind === 'shot') {
    const a = el.querySelector('.alt');
    if (a) a.textContent = 'ALT ' + Math.round(alt || 0) + ' m';
  }
}
