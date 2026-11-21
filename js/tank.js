// js/tank.js —— 主战坦克：载具内核（模型 + 观察窗 + 装填/受热数据）
//
// 与 js/aagun.js 的关系：同一套「车体 + 旋转炮塔 + 俯仰炮组」的对外结构
// （group / turret / guns / weakPoints / gunMuzzles），所以 applyAAGun / updateWeakAAGun /
// 引擎的地面载具同步都能直接复用。区别在视觉与武器：
//   · 单管高射机枪 → **单管 125mm 主炮**（长身管 + 热护套 + 炮口制退器）
//   · 删除炮塔两侧的火箭发射巢（本模式二号武器是燃烧弹，从主炮打出去）
//   · 炮塔左前方加**观察窗/瞄准镜**（scopeEye）：右键开镜时相机就贴在这个位置，
//     炮管在视野右上角（位置关系：镜在左、炮在中，所以炮管天然偏右）。
//
// 车体坐标：机头 -Z，地面 y=0；炮塔中心 y≈2.55。
import * as THREE from 'three';

const std = (color, m, r, extra) => new THREE.MeshStandardMaterial(Object.assign({
  color, metalness: m === undefined ? 0.28 : m, roughness: r === undefined ? 0.68 : r,
}, extra || {}));

const _UP = new THREE.Vector3(0, 1, 0);
function rodMesh(geo, mat, p0, p1) {
  const m = new THREE.Mesh(geo, mat);
  const a = new THREE.Vector3().fromArray(p0), b = new THREE.Vector3().fromArray(p1);
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length();
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(_UP, d.normalize());
  m.scale.y = len;
  return m;
}

/* =====================================================================
   主战坦克（机头朝 -Z，含炮管全长 ≈ 11.6m，车体宽 4.0m，炮塔顶 3.6m）
   ===================================================================== */
export function buildTank(color) {
  const group = new THREE.Group();      // 位置 + 车体朝向（bodyYaw）
  group.name = 'tank';
  group.rotation.order = 'YXZ';         // 先 yaw，再按地形做俯仰/侧倾（见 tank 模式的 applySlope）
  const mesh = new THREE.Group();       // 视觉层（地形俯仰/侧倾）
  group.add(mesh);

  const team = new THREE.Color(color);
  const bodyColor = team.clone().lerp(new THREE.Color(0x2b3224), 0.50);      // 军绿（保留队伍色，别黑成一团）
  const body = std(bodyColor, 0.30, 0.62);
  const bodyDark = std(bodyColor.clone().multiplyScalar(0.72), 0.34, 0.66);
  const armor = std(bodyColor.clone().lerp(new THREE.Color(0x3b4236), 0.45), 0.26, 0.72);
  const metal = std(0x59616a, 0.62, 0.42);
  const dark = std(0x1c2228, 0.30, 0.70);
  const gunMat = std(0x6d757e, 0.46, 0.54);   // 炮管：别用近黑色，逆光时观察窗里就是一根纯黑剪影
  const rubber = std(0x121619, 0.12, 0.92);
  const glass = new THREE.MeshStandardMaterial({
    color: 0x9fd0e8, metalness: 0.2, roughness: 0.08,
    transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthWrite: false,
  });

  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    (parent || mesh).add(m); return m;
  };
  const rodGeo = (r0, r1, seg) => new THREE.CylinderGeometry(r0, r1, 1, seg || 8);
  const rod = (p0, p1, r0, r1, mat, parent) => {
    const m = rodMesh(rodGeo(r0, r1), mat, p0, p1);
    (parent || mesh).add(m); return m;
  };

  /* ---------- 1. 车体 ---------- */
  // 下车体（窄，成梯形侧面）：用四块板拼，避免一眼看出是方块
  add(new THREE.BoxGeometry(3.5, 0.95, 5.9), body, 0, 1.02, 0.05);
  add(new THREE.BoxGeometry(3.5, 0.40, 5.9), bodyDark, 0, 0.58, 0.05);       // 底甲
  // 上车体（略窄、前低后高）
  add(new THREE.BoxGeometry(3.3, 0.62, 4.9), body, 0, 1.62, 0.12);
  add(new THREE.BoxGeometry(3.1, 0.22, 3.4), body, 0, 1.98, 0.55);           // 机舱盖板
  // 前倾斜甲板（首上）：从车体前缘斜向上，是一整块板
  const glacis = add(new THREE.BoxGeometry(3.35, 1.15, 0.16), armor, 0, 1.62, -2.86, 0.62, 0, 0);
  glacis.position.z = -2.86;
  // 首下甲板
  const lower = add(new THREE.BoxGeometry(3.2, 0.9, 0.14), armor, 0, 0.94, -3.02, -0.55, 0, 0);
  lower.position.z = -3.02;
  // 车尾板
  add(new THREE.BoxGeometry(3.35, 1.05, 0.14), bodyDark, 0, 1.18, 3.02);

  /* ---------- 2. 履带 + 负重轮 ---------- */
  const trackGeo = new THREE.BoxGeometry(1.08, 1.02, 6.55);
  const tL = add(trackGeo, rubber, -2.02, 0.66, 0.05);
  const tR = add(trackGeo, rubber, 2.02, 0.66, 0.05);
  // 履带板齿（外侧一条）：让侧面不是纯黑方块
  const linkGeo = new THREE.BoxGeometry(0.10, 0.14, 0.62);
  for (const s of [-1, 1]) {
    for (let i = 0; i < 16; i++) add(linkGeo, metal, s * 2.58, 0.20, -3.05 + i * 0.40);
  }
  // 负重轮（6 对）+ 主动轮/诱导轮
  const wheelGeo = new THREE.CylinderGeometry(0.44, 0.44, 0.36, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  for (const s of [-1, 1]) {
    for (let i = 0; i < 6; i++) add(wheelGeo, rubber, s * 2.06, 0.48, -2.35 + i * 0.94);
    add(new THREE.CylinderGeometry(0.40, 0.40, 0.38, 10), metal, s * 2.06, 0.92, -2.75, 0, 0, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.36, 0.36, 0.38, 10), metal, s * 2.06, 0.92, 2.55, 0, 0, Math.PI / 2);
  }
  // 挡泥板
  add(new THREE.BoxGeometry(1.15, 0.10, 6.7), armor, -2.02, 1.22, 0.05);
  add(new THREE.BoxGeometry(1.15, 0.10, 6.7), armor, 2.02, 1.22, 0.05);
  // 侧裙板（前段）
  add(new THREE.BoxGeometry(0.10, 0.52, 3.8), armor, -1.79, 1.10, -0.55);
  add(new THREE.BoxGeometry(0.10, 0.52, 3.8), armor, 1.79, 1.10, -0.55);

  /* ---------- 3. 炮塔 ---------- */
  const turret = new THREE.Group();
  turret.name = 'turret';
  turret.position.set(0, 2.18, 0.30);
  group.add(turret);

  // 炮塔座圈 + 主体：用圆柱 + 前脸斜板，不要一个圆柱戳在那
  add(new THREE.CylinderGeometry(1.42, 1.52, 0.22, 14), bodyDark, 0, 0.08, 0, 0, 0, 0, turret);
  const turBody = add(new THREE.CylinderGeometry(1.30, 1.46, 0.78, 14), body, 0, 0.55, 0, 0, 0, 0, turret);
  turBody.scale.z = 1.16;                                  // 前后略长（尾舱）
  add(new THREE.CylinderGeometry(1.06, 1.26, 0.30, 14), body, 0, 1.02, 0.02, 0, 0, 0, turret);
  // 炮塔前脸（防盾）：一块厚板，炮管从中间穿出
  add(new THREE.BoxGeometry(1.72, 0.92, 0.34), armor, 0, 0.60, -1.28, 0, 0, 0, turret);
  add(new THREE.BoxGeometry(1.30, 0.60, 0.22), armor, 0, 0.66, -1.48, 0, 0, 0, turret);
  // 炮塔尾舱（储物筐）
  add(new THREE.BoxGeometry(2.05, 0.62, 0.72), bodyDark, 0, 0.58, 1.42, 0, 0, 0, turret);
  for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(0.28, 0.42, 0.34), armor, -0.66 + i * 0.66, 0.66, 1.76, 0, 0, 0, turret);
  // 顶部舱盖（车长）+ 舱口环
  add(new THREE.CylinderGeometry(0.44, 0.44, 0.12, 10), bodyDark, 0.45, 1.16, 0.22, 0, 0, 0, turret);
  add(new THREE.TorusGeometry(0.42, 0.05, 5, 12), metal, 0.45, 1.20, 0.22, Math.PI / 2, 0, 0, turret);
  // 高射机枪（车长位，小口径，纯装饰）
  add(new THREE.CylinderGeometry(0.045, 0.055, 1.05, 6), dark, 0.45, 1.72, 0.02, Math.PI / 2, 0, 0, turret);
  add(new THREE.BoxGeometry(0.22, 0.22, 0.36), dark, 0.45, 1.50, 0.18, 0, 0, 0, turret);

  /* 观察窗（瞄准镜）：炮塔左前方一个突出的小镜箱，正面一块窄玻璃。
     scopeEye 是相机机位 —— 在镜箱后面一点点，所以视野里看不到镜箱自身，只看到炮管在右。 */
  add(new THREE.BoxGeometry(0.46, 0.34, 0.62), bodyDark, -0.86, 1.02, -0.98, 0, 0, 0, turret);
  add(new THREE.BoxGeometry(0.32, 0.20, 0.08), glass, -0.86, 1.04, -1.30, 0, 0, 0, turret);
  add(new THREE.BoxGeometry(0.52, 0.06, 0.10), armor, -0.86, 1.20, -1.31, 0, 0, 0, turret);
  const scopeEye = new THREE.Object3D();
  /* 观察窗机位：炮盾左侧、炮管轴线下方一点。
     ★ 机位比炮管低 → 炮管会出现在视野**右上方**（这是用户要的效果）；
       如果机位在炮管上方，炮管就跑到画面右下角了。 */
  scopeEye.position.set(-0.95, 0.40, -1.80);   // 相对炮塔
  turret.add(scopeEye);

  /* ---------- 4. 主炮（pitch 组）—— 单管 125mm ---------- */
  const guns = new THREE.Group();
  guns.name = 'guns';
  turret.add(guns);
  const barrelGeo = new THREE.CylinderGeometry(0.115, 0.135, 5.6, 10);
  barrelGeo.rotateX(Math.PI / 2);
  const sleeveGeo = new THREE.CylinderGeometry(0.175, 0.185, 2.35, 10);
  sleeveGeo.rotateX(Math.PI / 2);
  const brakeGeo = new THREE.CylinderGeometry(0.185, 0.20, 0.52, 10);
  brakeGeo.rotateX(Math.PI / 2);
  const muzzleGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.06, 10);
  muzzleGeo.rotateX(Math.PI / 2);
  add(barrelGeo, gunMat, 0, 0.56, -3.35, 0, 0, 0, guns);
  add(sleeveGeo, armor, 0, 0.56, -2.05, 0, 0, 0, guns);
  add(brakeGeo, metal, 0, 0.56, -6.05, 0, 0, 0, guns);
  add(muzzleGeo, dark, 0, 0.56, -6.34, 0, 0, 0, guns);
  // 炮管与炮盾之间的帆布套
  add(new THREE.CylinderGeometry(0.30, 0.34, 0.42, 10), bodyDark, 0, 0.56, -1.30, Math.PI / 2, 0, 0, guns);
  // 抽烟装置（炮管中段加粗的一圈）
  add(new THREE.CylinderGeometry(0.175, 0.175, 0.62, 10), metal, 0, 0.56, -4.25, Math.PI / 2, 0, 0, guns);
  // 同轴机枪（主炮右侧，细）
  add(new THREE.CylinderGeometry(0.045, 0.05, 1.30, 6), dark, 0.52, 0.80, -2.05, Math.PI / 2, 0, 0, guns);
  // 炮口基准（单根，居中）
  const gunMuzzles = [new THREE.Vector3(0, 0.56, -6.42)];

  /* ---------- 5. 细节 ---------- */
  // 炮塔侧面附加装甲块
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(0.16, 0.34, 0.62), armor, s * 1.40, 0.60, -0.55 + i * 0.66, 0, 0, 0, turret);
  }
  // 烟雾弹发射器（炮塔两侧，4 联）
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      add(new THREE.CylinderGeometry(0.075, 0.075, 0.34, 6), dark,
        s * 1.10, 0.96, -1.02 + (i % 2) * 0.18, Math.PI / 2 - 0.35, 0, 0, turret);
    }
  }
  // 天线
  const ant = add(new THREE.CylinderGeometry(0.025, 0.025, 2.3, 5), dark, 0.92, 1.95, 0.95, 0.10, 0, -0.10, turret);
  // 车体前部拖钩 / 备品
  add(new THREE.BoxGeometry(0.42, 0.16, 0.26), metal, -1.10, 1.28, -3.10);
  add(new THREE.BoxGeometry(0.42, 0.16, 0.26), metal, 1.10, 1.28, -3.10);
  add(new THREE.BoxGeometry(0.52, 0.34, 0.42), armor, -1.34, 1.86, 1.55);   // 左储物箱
  add(new THREE.BoxGeometry(0.52, 0.34, 0.42), armor, 1.34, 1.86, 1.55);    // 右储物箱
  // 排气管（车体左后）
  add(new THREE.CylinderGeometry(0.16, 0.16, 0.50, 8), dark, -1.10, 1.72, 2.86, Math.PI / 2, 0, 0);
  // 车尾油桶
  add(new THREE.CylinderGeometry(0.30, 0.30, 0.86, 10), armor, 0.95, 1.66, 2.86, 0, 0, Math.PI / 2);

  // 全部实体件投影/接收阴影
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  /* ---------- 6. 弱点判定球 ---------- */
  /* 命中部位（v3.30）：每个部位带**装甲厚度**与损伤类型 —— 穿甲弹按「实际穿深 vs 有效装甲」判定。
     数组顺序 = 判定优先级：细部位先判，最后才落到车体大球。
       · 左 / 右履带（各两段）：45mm —— 击穿 = 该侧履带断裂（速度减半、不能朝该侧转）
       · 发动机（车体后部）：75mm —— 击穿 = 熄火，整车不能移动
       · 弹药箱（炮塔尾舱）：120mm —— 只有致命那一发才殉爆（22m 范围伤害）
       · 炮塔：380mm（正面最厚：30° 着角就开始跳弹）
       · 车体：260mm
     左右履带用**不同的名字**（左履带/右履带），房主结算时才能分辨断的是哪一侧；
     着角会放大有效装甲（armor / cos 着角），所以侧后与近垂直入射才是正确打法。 */
  const weakPoints = [
    { name: '左履带', part: 'track', offset: new THREE.Vector3(-1.55, 0.45, -1.25), r: 0.85, armor: 45, effect: 'trackL', _w: new THREE.Vector3() },
    { name: '左履带', part: 'track', offset: new THREE.Vector3(-1.55, 0.45, 1.25), r: 0.85, armor: 45, effect: 'trackL', _w: new THREE.Vector3() },
    { name: '右履带', part: 'track', offset: new THREE.Vector3(1.55, 0.45, -1.25), r: 0.85, armor: 45, effect: 'trackR', _w: new THREE.Vector3() },
    { name: '右履带', part: 'track', offset: new THREE.Vector3(1.55, 0.45, 1.25), r: 0.85, armor: 45, effect: 'trackR', _w: new THREE.Vector3() },
    { name: '发动机', part: 'engine', offset: new THREE.Vector3(0, 1.45, 2.55), r: 0.95, armor: 75, effect: 'engine', _w: new THREE.Vector3() },
    { name: '弹药箱', part: 'ammo', offset: new THREE.Vector3(0, 2.90, 2.05), r: 1.15, armor: 120, effect: 'ammo', onTurret: true, _w: new THREE.Vector3() },
    /* v3.31：炮盾中心 / 炮管根部 —— 只有 0.30m 半径的精确点。
       位置在炮塔正前方防盾外缘（比炮塔大球凸出约 0.2m），正面精确瞄准才会被它先接住；
       AP 击穿后固定扣 90 点装甲，存活则炮塔卡死（不能旋转/俯仰，但仍可朝当前方向开火）。 */
    { name: '炮盾', part: 'mantlet', offset: new THREE.Vector3(0, 2.78, -1.18), r: 0.30, armor: 120, effect: 'turretJam', onTurret: true, _w: new THREE.Vector3() },
    { name: '炮塔', part: 'turret', offset: new THREE.Vector3(0, 3.20, 0.10), r: 1.45, armor: 380, _w: new THREE.Vector3() },
    /* 车体是"兜底"部位：它的大球会包住其它小部位，所以不参加"最近命中"竞争，
       只有其它部位都没命中时才按车体算（否则侧面/后方的任何一发都会被它抢先）。 */
    { name: '车体', part: 'body', offset: new THREE.Vector3(0, 1.45, 0), r: 3.05, armor: 260, fallback: true, _w: new THREE.Vector3() },
  ];

  return { group, mesh, turret, guns, weakPoints, gunMuzzles, scopeEye, barrelTipY: 2.74 };
}

/* 观察窗里的"自己的炮管"：相机空间的一个前伸件，单独挂在场景里跟着相机走。
   不做 depthTest 关闭 —— 它离相机 0.9m，正常深度就能盖住远处景物；关掉反而会糊到 UI 上。 */
export function buildScopeViewmodel() {
  const g = new THREE.Group();
  const dark = std(0x20262b, 0.35, 0.62);
  const metal = std(0x6a727a, 0.55, 0.45);
  const b1 = new THREE.CylinderGeometry(0.052, 0.060, 1.35, 10);
  b1.rotateX(Math.PI / 2);
  const m1 = new THREE.Mesh(b1, dark);
  m1.position.set(0, 0, -0.72);
  g.add(m1);
  const b2 = new THREE.CylinderGeometry(0.075, 0.088, 0.22, 10);
  b2.rotateX(Math.PI / 2);
  const m2 = new THREE.Mesh(b2, metal);
  m2.position.set(0, 0, -1.36);
  g.add(m2);
  // 炮口内孔（深色圆面）
  const hole = new THREE.Mesh(new THREE.CircleGeometry(0.040, 10), std(0x050607, 0.1, 0.95));
  hole.position.set(0, 0, -1.471);
  g.add(hole);
  g.traverse((o) => { if (o.isMesh) o.frustumCulled = false; });
  return g;
}

// 构造坦克实体（引擎把它当"地面载具"用；apT/heatT 是本模式自己的状态）
export function makeTank(tank) {
  return {
    aagun: tank, bodyYaw: 0, turretYaw: 0, turretPitch: 0.02,
    speed: 0, targetSpeed: 0,
    hp: 100, alive: true,
    /* v3.30 装甲损伤：一炮击穿即瘫痪，本回合不恢复（回合重置 / 重生时清零） */
    trackL: false, trackR: false, engOut: false, turretJammed: false, immobilized: null,
    apT: 0,            // 穿甲弹装填剩余（秒）
    heatT: 0,          // 燃烧弹装填剩余
    heat: 0,           // 车体受热 0~1（影响装填与瞄准）
    burned: 0,         // 本车被点燃的剩余时间
  };
}

export const TANK = {
  apReload: 3.6,        // 穿甲弹装填（秒）
  heatReload: 5.2,      // 燃烧弹装填（秒）
  apSpeed: 1670,        // 炮口初速（m/s）—— M829A2 级 APFSDS 实测值
  apMaxPen: 700,        // （历史字段）击穿判定已改为动能模型，见 modes/tank/index.js 的 DUEL
  apLife: 2.4,          // 飞行寿命（秒）
  apLethal: true,       // 命中即击毁
  heatSpeed: 760,       // 燃烧弹初速
  heatDmg: 6,           // 直接命中伤害（少量）
  heatLife: 2.6,
  heatFireT: 16,        // 燃烧弹在地面/车体上的持续火焰（秒）
  heatReloadPenalty: 0.85,   // 满受热时装填时间 +85%
  heatAimJitter: 0.010,      // 观察窗被火干扰的最大偏摆（弧度）
  heatRadius: 9,        // 距离火源多近开始受热
  heatRise: 0.55,       // 受热上升速率（/秒）
  heatCool: 0.22,       // 冷却速率（/秒）
  groundPitchMin: -0.10,
  groundPitchMax: 0.36,
  speedFwd: 14, speedBack: 7, turnRate: 0.82,
};

/* =====================================================================
   装甲损伤（v3.30 / v3.31）
   ---------------------------------------------------------------------
   · 一炮击穿履带 / 发动机 / 炮盾 → 立刻瘫痪，本回合不修复
   · 左右履带分开：断一侧 → 速度减半、不能朝断带方向转
   · 两侧履带全断 或 发动机损毁 → 完全不能移动（炮塔仍可旋转、仍可开火）
   · 炮盾被击穿 → 炮塔卡死（不能旋转/俯仰，但仍可朝当前方向开火）
   状态只挂在坦克实体上，空中四个模式完全不受影响。
   ===================================================================== */
export function applyTankDamage(unit, code) {
  if (!unit || !code) return;
  const set = (e) => {
    if (!e) return;
    if (code === 'turretJam') { e.turretJammed = true; return; }
    if (code === 'trackL') e.trackL = true;
    else if (code === 'trackR') e.trackR = true;
    else if (code === 'engine') e.engOut = true;
    else return;
    if (e.engOut) e.immobilized = 'engine';
    else if (e.trackL && e.trackR) e.immobilized = 'track';
  };
  set(unit);
  if (unit.ent) set(unit.ent);   // 防空车/坦克 wrapper + ent 两层结构
}

/* 当前机动能力：loop.js（玩家）与 modes/tank/ai.js（AI）共用。
   speedK 是速度倍率，turnL/turnR 表示还能不能朝该侧转车体。 */
export function tankMobility(ent) {
  if (!ent) return { speedK: 1, turnL: true, turnR: true };
  if (ent.immobilized || (ent.trackL && ent.trackR)) return { speedK: 0, turnL: false, turnR: false };
  return { speedK: (ent.trackL || ent.trackR) ? 0.5 : 1, turnL: !ent.trackL, turnR: !ent.trackR };
}
