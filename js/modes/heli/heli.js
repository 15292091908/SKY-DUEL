// js/modes/heli/heli.js —— MH-6「小鸟」直升机：精细模型 + 视角领先操控（v3.9.0 重做）
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
const _v2 = new THREE.Vector3();

// 角度归一化到 (-π, π]
export function wrapPi(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

const std = (color, m = 0.45, r = 0.45, extra) => new THREE.MeshStandardMaterial(Object.assign({ color, metalness: m, roughness: r }, extra || {}));

/* =====================================================================
   MH-6 Little Bird 模型（机头朝 -Z）
   外形要点：蛋形机身 + 大面积气泡座舱 + 细长尾梁 + T 型平尾 + 滑橇 + 五叶主旋翼
   比例：机身长 ≈ 7.6，旋翼直径 ≈ 8.0，尾桨在垂尾左侧
   ===================================================================== */
export function buildHeli(color) {
  const group = new THREE.Group();       // 位置 + 航向（yaw/pitch）
  const mesh = new THREE.Group();        // 视觉层（滚转 / 悬停浮动）
  group.add(mesh);

  const team = new THREE.Color(color);
  const bodyColor = team.clone().lerp(new THREE.Color(0x1b2320), 0.62);   // 军绿/近黑
  const body = std(bodyColor, 0.32, 0.58);
  const bodyDark = std(bodyColor.clone().multiplyScalar(0.72), 0.35, 0.6);
  const accent = std(team, 0.4, 0.42, { emissive: team.clone().multiplyScalar(0.18) });
  const metal = std(0x4c545c, 0.85, 0.35);
  const dark = std(0x1a2026, 0.6, 0.45);
  const rubber = std(0x101418, 0.2, 0.85);
  const glass = new THREE.MeshStandardMaterial({
    color: 0x8fc4dd, metalness: 0.35, roughness: 0.08,
    transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false,
  });

  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    (parent || mesh).add(m); return m;
  };

  /* ---------- 机身：旋成体（蛋形，前圆后收） ---------- */
  // 剖面 y: 0(机头) → 4.45(尾梁根部)；绕 Y 旋转后 rotateX(90°) 映射到 +Z
  const profile = [
    [0.02, 0.00], [0.17, 0.10], [0.32, 0.23], [0.48, 0.40], [0.63, 0.60],
    [0.76, 0.84], [0.86, 1.12], [0.93, 1.44], [0.96, 1.76], [0.96, 2.06],
    [0.93, 2.34], [0.87, 2.60], [0.79, 2.86], [0.70, 3.08], [0.60, 3.29],
    [0.50, 3.49], [0.42, 3.68], [0.35, 3.86], [0.30, 4.02], [0.24, 4.20],
    [0.15, 4.38], [0.02, 4.45],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const fusGeo = new THREE.LatheGeometry(profile, 26);
  fusGeo.rotateX(Math.PI / 2);          // y → z（机头 -Z）
  fusGeo.translate(0, 0, -3.05);        // 机头 z=-3.05，尾梁根部 z≈1.40
  const fus = new THREE.Mesh(fusGeo, body);
  fus.scale.y = 1.0;                    // 截面接近圆（小鸟的蛋形机身）
  mesh.add(fus);

  // 机腹龙骨（一条深色窄条，遮住旋成体正下方的圆润感）
  add(new THREE.BoxGeometry(0.34, 0.10, 2.9), bodyDark, 0, -0.83, -0.55);

  /* ---------- 座舱：气泡玻璃罩 + 框条 ---------- */
  // 玻璃穹顶：半球体压扁，覆盖机身前上部
  const domeGeo = new THREE.SphereGeometry(1, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.58);
  const dome = new THREE.Mesh(domeGeo, glass);
  dome.position.set(0, 0.18, -1.62);
  dome.scale.set(0.88, 0.74, 1.32);
  mesh.add(dome);
  // 座舱底沿（深色环）
  const rim = add(new THREE.TorusGeometry(0.9, 0.035, 6, 26), dark, 0, 0.16, -1.62, Math.PI / 2, 0, 0);
  rim.scale.set(0.98, 1.42, 1);         // 椭圆（Torus 在 XY 平面 → 旋转后 z 轴方向拉长）
  // 顶脊 + 前风挡立柱（A 柱）
  add(new THREE.BoxGeometry(0.055, 0.05, 1.62), dark, 0, 0.78, -1.66);
  for (const s of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.035, 0.035, 0.92, 6), dark, s * 0.56, 0.44, -2.44, -0.62, 0, s * -0.32);
    add(new THREE.CylinderGeometry(0.03, 0.03, 1.05, 6), dark, s * 0.86, 0.35, -1.62, 0, 0, s * 0.12);
    // 侧门后沿
    add(new THREE.CylinderGeometry(0.03, 0.03, 0.95, 6), dark, s * 0.83, 0.32, -0.62, 0, 0, s * 0.10);
  }
  // 机头下颚玻璃（小鸟辨识度很高的下颌窗）
  const chin = add(new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, Math.PI * 0.52, Math.PI * 0.3), glass, 0, -0.18, -2.62);
  chin.scale.set(0.5, 0.52, 0.62);

  /* ---------- 发动机舱 / 传动 / 排气 ---------- */
  add(new THREE.BoxGeometry(0.92, 0.30, 1.55), bodyDark, 0, 0.68, 0.32);      // 发动机罩
  add(new THREE.BoxGeometry(0.62, 0.22, 0.75), metal, 0, 0.88, -0.30);        // 主减速器
  // 排气口（右侧向后上方）
  add(new THREE.CylinderGeometry(0.14, 0.17, 0.55, 10), dark, 0.48, 0.62, 0.95, Math.PI / 2 - 0.28, 0, 0.25);
  add(new THREE.CylinderGeometry(0.15, 0.15, 0.06, 10), metal, 0.55, 0.70, 1.20, Math.PI / 2 - 0.28, 0, 0.25);
  // 尾梁根部整流罩
  add(new THREE.CylinderGeometry(0.34, 0.20, 1.0, 12), body, 0, 0.20, 1.55, Math.PI / 2, 0, 0);
  // 队伍色细条（远景辨识）
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.02, 0.035, 3.6), accent, s * 0.205, 0.30, 3.6);

  /* ---------- 尾梁 / T 型尾翼 ---------- */
  add(new THREE.CylinderGeometry(0.145, 0.25, 4.35, 12), body, 0, 0.16, 3.60, Math.PI / 2, 0, 0);
  // 垂尾（后掠）
  add(new THREE.BoxGeometry(0.10, 1.18, 0.52), body, 0, 0.72, 5.65, -0.20, 0, 0);
  add(new THREE.BoxGeometry(0.09, 0.42, 0.34), accent, 0, 1.16, 5.81, -0.20, 0, 0);   // 顶帽（队伍色）
  // T 型平尾
  add(new THREE.BoxGeometry(1.86, 0.055, 0.44), body, 0, 1.20, 5.59, -0.05, 0, 0);
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.10, 0.16, 0.30), dark, s * 0.93, 1.20, 5.59);
  // 尾撑斜杆
  add(new THREE.CylinderGeometry(0.035, 0.035, 0.80, 6), dark, 0, 0.85, 5.18, 0.55, 0, 0);

  // 尾桨（左侧，2 叶）
  const tail = new THREE.Group(); tail.position.set(-0.20, 0.86, 5.68); mesh.add(tail);
  add(new THREE.CylinderGeometry(0.11, 0.11, 0.16, 8), dark, 0, 0, 0, 0, 0, Math.PI / 2, tail);
  for (let i = 0; i < 2; i++) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.68, 0.11), dark);
    t.position.set(0, Math.sin((i * Math.PI)) * 0.34, Math.cos((i * Math.PI)) * 0.34);
    t.rotation.x = i * Math.PI;
    tail.add(t);
  }
  add(new THREE.BoxGeometry(0.03, 0.10, 0.22), accent, -0.20, 1.52, 5.70);   // 尾桨警示条

  /* ---------- 滑橇起落架 ---------- */
  for (const sx of [-1, 1]) {
    const x = sx * 0.80;
    // 纵向滑管（前端上翘）
    add(new THREE.CylinderGeometry(0.060, 0.060, 2.95, 8), dark, x, -1.02, 0.15, Math.PI / 2, 0, 0);
    add(new THREE.CylinderGeometry(0.058, 0.058, 0.62, 8), dark, x, -0.90, -1.52, Math.PI / 2 - 0.42, 0, 0);
    add(new THREE.CylinderGeometry(0.058, 0.058, 0.34, 8), dark, x, -1.10, 1.68, Math.PI / 2 + 0.5, 0, 0);
    // 前后横撑 + 支柱
    for (const z of [-0.72, 1.02]) {
      add(new THREE.CylinderGeometry(0.050, 0.050, 0.56, 8), dark, x - sx * 0.14, -0.72, z, 0, 0, sx * 0.72);
      add(new THREE.CylinderGeometry(0.048, 0.048, 0.50, 8), dark, x - sx * 0.30, -0.55, z, 0, 0, sx * 0.52);
    }
  }
  add(new THREE.CylinderGeometry(0.050, 0.050, 1.60, 8), dark, 0, -1.02, -0.72, 0, 0, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.050, 0.050, 1.60, 8), dark, 0, -1.02, 1.02, 0, 0, Math.PI / 2);
  // 滑橇端头防滑垫
  for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.13, 0.05, 0.20), rubber, sx * 0.80, -0.98, -1.72);

  /* ---------- MH-6 外挂长凳（特种部队侧座） ---------- */
  for (const s of [-1, 1]) {
    add(new THREE.BoxGeometry(0.50, 0.07, 1.28), dark, s * 1.02, -0.36, -0.72);
    add(new THREE.BoxGeometry(0.05, 0.34, 1.28), bodyDark, s * 1.28, -0.20, -0.72);
    add(new THREE.CylinderGeometry(0.028, 0.028, 0.42, 6), metal, s * 1.06, -0.60, -1.28, 0, 0, s * 0.16);
    add(new THREE.CylinderGeometry(0.028, 0.028, 0.42, 6), metal, s * 1.06, -0.60, -0.12, 0, 0, s * 0.16);
  }

  /* ---------- 主旋翼：桅杆 + 桨毂 + 5 叶 ---------- */
  add(new THREE.CylinderGeometry(0.10, 0.13, 0.72, 10), metal, 0, 1.20, -0.52);
  add(new THREE.CylinderGeometry(0.20, 0.20, 0.14, 10), dark, 0, 1.54, -0.52);
  const prop = new THREE.Group(); prop.position.set(0, 1.60, -0.52); mesh.add(prop);
  add(new THREE.CylinderGeometry(0.15, 0.17, 0.20, 10), dark, 0, 0, 0, 0, 0, 0, prop);
  for (let i = 0; i < 5; i++) {
    const a = (i * Math.PI * 2) / 5;
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.07, 0.36), metal);
    grip.position.set(Math.sin(a) * 0.26, 0, Math.cos(a) * 0.26);
    grip.rotation.y = a; prop.add(grip);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.045, 3.78), dark);
    blade.position.set(Math.sin(a) * 2.22, 0, Math.cos(a) * 2.22);
    blade.rotation.y = a;
    blade.rotation.x = 0.018;            // 轻微锥度
    prop.add(blade);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.255, 0.048, 0.22), accent);
    tip.position.set(Math.sin(a) * 4.02, 0, Math.cos(a) * 4.02);
    tip.rotation.y = a;
    prop.add(tip);
  }
  // 旋翼盘（极淡，告诉玩家桨叶范围）
  const tipRing = new THREE.Mesh(
    new THREE.CylinderGeometry(4.0, 4.0, 0.015, 40, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xbcd2e4, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }));
  prop.add(tipRing);

  /* ---------- 光电球 / 天线 / 灯 ---------- */
  add(new THREE.SphereGeometry(0.14, 12, 10), dark, 0, -0.30, -2.86);        // 机头光电球
  add(new THREE.CylinderGeometry(0.014, 0.010, 0.62, 5), metal, 0, 0.62, 2.35, 0.24, 0, 0);   // 鞭状天线
  const lampR = new THREE.MeshStandardMaterial({ color: 0x8a1f1f, emissive: 0xff2a2a, emissiveIntensity: 2.2 });
  const lampG = new THREE.MeshStandardMaterial({ color: 0x1f7a3a, emissive: 0x2aff5a, emissiveIntensity: 2.2 });
  const lampW = new THREE.MeshStandardMaterial({ color: 0xcfd8e0, emissive: 0xfff2c8, emissiveIntensity: 1.6 });
  add(new THREE.SphereGeometry(0.055, 8, 6), lampR, -0.86, 0.02, -2.35);
  add(new THREE.SphereGeometry(0.055, 8, 6), lampG, 0.86, 0.02, -2.35);
  add(new THREE.SphereGeometry(0.05, 8, 6), lampW, 0, 0.42, 5.98);

  /* ---------- 机枪吊舱（机腹前下方，随炮塔转动） ---------- */
  const mgPod = new THREE.Group(); mgPod.position.set(0, -0.62, -1.55); mesh.add(mgPod);
  add(new THREE.BoxGeometry(0.40, 0.34, 0.72), bodyDark, 0, 0, -0.18, 0, 0, 0, mgPod);
  add(new THREE.SphereGeometry(0.20, 12, 9), dark, 0, -0.03, -0.52, 0, 0, 0, mgPod);
  add(new THREE.CylinderGeometry(0.052, 0.052, 1.05, 8), dark, 0, -0.03, -1.05, Math.PI / 2, 0, 0, mgPod);
  add(new THREE.CylinderGeometry(0.070, 0.062, 0.16, 8), metal, 0, -0.03, -1.56, Math.PI / 2, 0, 0, mgPod);
  // 枪口节点（world 用；子弹/枪口焰从这里出）
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, -0.03, -1.66); mgPod.add(muzzle);
  // 弹链/挂架
  add(new THREE.BoxGeometry(0.10, 0.30, 0.12), metal, 0.20, 0.20, -0.10, 0, 0, 0, mgPod);

  /* ---------- 弱点（局部坐标，判定球比模型略大一点，便于命中） ---------- */
  const weakPoints = [
    { name: '驾驶舱', part: 'cockpit', offset: new THREE.Vector3(0, 0.30, -1.80), r: 2.3, mult: 3.0, _w: new THREE.Vector3() },
    { name: '发动机', part: 'engine', offset: new THREE.Vector3(0, 0.72, 0.35), r: 2.1, mult: 2.0, _w: new THREE.Vector3() },
    { name: '尾梁', part: 'wing', offset: new THREE.Vector3(0, 0.16, 4.60), r: 2.6, mult: 1.5, _w: new THREE.Vector3() },
  ];

  // 机头摄像头（枪口视角用）。v3.10.4：挪到枪口（z≈-3.21）前 0.17m —— 旧位 (0,-0.72,-3.00)
  // 在枪口后方，1m 长的枪管/枪口圆柱贴脸占据画面下缘 = 用户看到的"炮管穿模"；
  // 现在机头蒙皮（-3.05）、下颚玻璃前缘（-3.24）、枪管（-3.21）全部在镜头后方，画面干净。
  const gunCam = new THREE.Object3D();
  gunCam.position.set(0, -0.70, -3.38);
  mesh.add(gunCam);

  return { group, mesh, prop, weakPoints, guns: [new THREE.Vector3(0, -0.65, -3.2), new THREE.Vector3(0, -0.65, -3.2)], muzzle, mgPod, tail, gunCam };
}

/* ---------- 航空炸弹模型 ---------- */
export function buildBomb() {
  const g = new THREE.Group();
  const dark = std(0x2d333a, 0.75, 0.34);
  const band = std(0xd8a33a, 0.5, 0.4);
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
  const lug = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 0.22), metalSafe());
  lug.position.set(0, 0.22, 0.05); g.add(lug);
  return g;
}
function metalSafe() { return std(0x59616a, 0.8, 0.35); }

/* ---------- 实体 ---------- */
export function makeHeli(plane) {
  // 机身两侧常驻挂弹（v3.10.5）：与 dropBomb 的 releasePos 同坐标（mesh 层），
  // 投一侧隐藏一侧（dropBomb），回合重置恢复（resetHeli）。
  const bombL = buildBomb(); bombL.position.set(-1.18, -0.56, 0.45);
  const bombR = buildBomb(); bombR.position.set(1.18, -0.56, 0.45);
  plane.mesh.add(bombL); plane.mesh.add(bombR);
  return {
    plane, yaw: 0, pitch: 0, roll: 0, yawVel: 0,
    speed: 0, targetSpeed: 0, vSpeed: 0, strafe: 0,
    hp: 100, alive: true, gunSide: false, kind: 'heli',
    viewYaw: 0, viewPitch: 0, mgYaw: 0, mgPitch: 0,
    vel: new THREE.Vector3(),
    bombs: { left: true, right: true },
    bombRack: { left: bombL, right: bombR },
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
  f.bombs = { left: true, right: true };
  const p = f.plane;
  if (p) {
    if (p.mesh) { p.mesh.rotation.x = 0; p.mesh.rotation.z = 0; }
    if (p.mgPod) { p.mgPod.rotation.set(0, 0, 0); }
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
    /* ---- AI：跟 ai.js 的目标角飞，保持 55~110m 高度带 ---- */
    const dy = wrapPi((f.targetYaw || 0) - f.yaw);
    const turn = THREE.MathUtils.clamp(dy, -HELI.yawRate * 1.5 * dt, HELI.yawRate * 1.5 * dt);
    f.yaw = wrapPi(f.yaw + turn); f.yawVel = turn / Math.max(dt, 1e-4);
    if (f.targetPitch !== undefined) f.pitch += (THREE.MathUtils.clamp(f.targetPitch, -0.6, 0.6) - f.pitch) * Math.min(1, dt * 2.0);
    f.speed += (HELI.speedMax * 0.72 - f.speed) * Math.min(1, dt * 0.9);
    const y = f.plane.group.position.y;
    if (y < 62) f.vSpeed += (12 - f.vSpeed) * Math.min(1, dt * 1.5);
    else if (y > 108) f.vSpeed += (-14 - f.vSpeed) * Math.min(1, dt * 1.5);
    else f.vSpeed += (0 - f.vSpeed) * Math.min(1, dt * 1.2);
    const gb = f.plane.group;
    _e.set(f.pitch, f.yaw, 0, 'YXZ');
    _dir.set(0, 0, -1).applyEuler(_e);
    f.vel.copy(_dir).multiplyScalar(f.speed);
    f.vel.y += f.vSpeed;
    gb.position.addScaledVector(f.vel, dt);
    gb.quaternion.setFromEuler(_e);
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
  // mgPod 半埋在机腹，1.66m 长枪管大角度横扫/下压会刺进蒙皮与滑橇（用户报的穿模）；
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
