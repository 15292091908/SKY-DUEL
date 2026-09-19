import * as THREE from 'three';

// 镜像几何体（翻转 X 并反转三角形绕向，保证法线正确）
function mirrorGeo(src) {
  const g = src.clone();
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setX(i, -pos.getX(i));
  if (g.index) {
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i]; idx[i] = idx[i + 1]; idx[i + 1] = t; }
  }
  g.computeVertexNormals();
  return g;
}

// 半翼几何：展向收锥 + 后掠 + 上反（顶点级修形，真实翼平面形状）
// sign=1 右翼 / -1 左翼（从翼根 0 到翼尖 halfSpan）
function makeWingGeo(sign, halfSpan, rootChord, tipChord, thick, sweep, dihedral) {
  const g = new THREE.BoxGeometry(halfSpan, thick, rootChord, 5, 1, 2);
  g.translate(halfSpan / 2, 0, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = x / halfSpan;                                   // 0 翼根 → 1 翼尖
    const chord = rootChord + (tipChord - rootChord) * t;      // 弦长收窄
    pos.setX(i, sign * x);
    pos.setZ(i, pos.getZ(i) * (chord / rootChord) + t * sweep); // 收锥 + 后掠
    pos.setY(i, pos.getY(i) - t * dihedral * halfSpan);         // 上反角
  }
  g.computeVertexNormals();
  return g;
}

// 唯一机型：单引擎螺旋桨战斗机（机头朝 -Z）
// 弱点（本地坐标）：驾驶舱 x3 / 发动机 x2.5 / 机翼 x2 / 机身 x1 —— 坐标与判定球半径与旧版完全一致
export function buildPlane(color) {
  const group = new THREE.Group();          // 位置+航向（yaw/pitch）
  const mesh = new THREE.Group();           // 视觉层（滚转动画）
  group.add(mesh);

  const matBody = new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.42, envMapIntensity: 0.85 });
  const matDark = new THREE.MeshStandardMaterial({ color: 0x232a31, metalness: 0.5, roughness: 0.5, envMapIntensity: 0.85 });
  const matSteel = new THREE.MeshStandardMaterial({ color: 0x4a4f56, metalness: 0.85, roughness: 0.35 });
  const matGlass = new THREE.MeshStandardMaterial({ color: 0x9fd8ff, metalness: 0.95, roughness: 0.08, envMapIntensity: 1.4 });
  const matFrame = new THREE.MeshStandardMaterial({ color: 0x2e3a44, metalness: 0.6, roughness: 0.45 });
  const matLightL = new THREE.MeshStandardMaterial({ color: 0x883333, emissive: 0xff2222, emissiveIntensity: 1.6 });
  const matLightR = new THREE.MeshStandardMaterial({ color: 0x338844, emissive: 0x22ff44, emissiveIntensity: 1.6 });

  // ===== 机身：旋成体曲面（Lathe），尾尖→桨轴，机头朝 -Z =====
  // profile y: 0(尾锥)→8.9(桨轴)；rotateX(-90°) 后 z = 3.7 - y → 机尾 z=3.7、机头 z=-5.2
  // 尾锥一直延伸到尾翼根部（z≈3.2-3.5 处半径 0.1-0.15），填满尾翼与机身之间的空白
  const profile = [
    [0.05, 0.0], [0.13, 1.0], [0.26, 2.0], [0.42, 3.0], [0.54, 4.2],
    [0.57, 5.2], [0.51, 6.2], [0.45, 7.2], [0.35, 8.1], [0.23, 8.55], [0.0, 8.9]
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const fusGeo = new THREE.LatheGeometry(profile, 18);
  fusGeo.rotateX(-Math.PI / 2);
  fusGeo.translate(0, 0, 3.7);
  const fus = new THREE.Mesh(fusGeo, matBody);
  fus.scale.y = 0.93;   // 截面微椭圆
  mesh.add(fus);

  // 发动机罩（略宽的短圆筒 + 散热片环）
  const cowl = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.44, 1.15, 18), matDark);
  cowl.rotation.x = Math.PI / 2;
  cowl.position.z = -4.55;
  mesh.add(cowl);
  for (let i = 0; i < 2; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.455, 0.022, 6, 18), matSteel);
    ring.position.z = -4.25 - i * 0.42;
    mesh.add(ring);
  }
  // 排气管（两侧各 3 根短管，微后掠）
  const exhGeo = new THREE.CylinderGeometry(0.055, 0.07, 0.42, 6);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const ex = new THREE.Mesh(exhGeo, matSteel);
      ex.position.set(side * 0.44, 0.08 + (i % 2) * 0.12, -3.7 - i * 0.3);
      ex.rotation.x = Math.PI / 2 - 0.18;
      mesh.add(ex);
    }
  }
  // 化油器进气口（机罩下方）
  const intake = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), matDark);
  intake.scale.set(1, 0.7, 1.5);
  intake.position.set(0, -0.42, -3.9);
  mesh.add(intake);

  // 螺旋桨：整流锥 + 三叶桨（applyFlight 按 prop.rotation.z 旋转）
  const prop = new THREE.Group();
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.45, 12), matDark);
  spinner.rotation.x = -Math.PI / 2;
  spinner.position.z = -0.2;
  prop.add(spinner);
  const bladeGeo = new THREE.BoxGeometry(0.15, 1.62, 0.05);
  bladeGeo.translate(0, 0.81, 0);   // 从桨毂伸出（半径 0.81m，与机身等宽不穿地）
  bladeGeo.rotateY(0.4);            // 桨叶扭角烘焙进几何体（三片完全一致，不会装歪）
  for (let b = 0; b < 3; b++) {
    const blade = new THREE.Mesh(bladeGeo, matDark);
    blade.rotation.z = b * (Math.PI * 2 / 3);   // 120° 均布
    prop.add(blade);
  }
  prop.position.z = -5.35;
  mesh.add(prop);

  // ===== 主翼：锥形+后掠+上反（真实翼平面形状），翼根弦长 2.1 → 翼尖 1.05 =====
  const wingR = new THREE.Mesh(makeWingGeo(1, 5.7, 2.1, 1.05, 0.15, 0.55, 0.055), matBody);
  wingR.position.set(0, 0.02, 0.2);
  mesh.add(wingR);
  const wingL = new THREE.Mesh(makeWingGeo(-1, 5.7, 2.1, 1.05, 0.15, 0.55, 0.055), matBody);
  wingL.position.set(0, 0.02, 0.2);
  mesh.add(wingL);
  // 翼尖圆弧整流罩 + 航行灯（左红右绿）
  const tipGeo = new THREE.SphereGeometry(0.11, 8, 6);
  const tipL = new THREE.Mesh(tipGeo, matLightL); tipL.position.set(-5.68, -0.29, 0.72); mesh.add(tipL);
  const tipR = new THREE.Mesh(tipGeo, matLightR); tipR.position.set(5.68, -0.29, 0.72); mesh.add(tipR);

  // ===== 尾翼：平尾 + 垂尾回到原位（z≈3.2），由延长的尾锥托住（锥体在该处半径 0.1-0.15） =====
  const stabR = new THREE.Mesh(makeWingGeo(1, 1.95, 1.3, 0.6, 0.09, 0.3, 0.04), matBody);
  stabR.position.set(0, 0.02, 3.2);
  mesh.add(stabR);
  const stabL = new THREE.Mesh(makeWingGeo(-1, 1.95, 1.3, 0.6, 0.09, 0.3, 0.04), matBody);
  stabL.position.set(0, 0.02, 3.2);
  mesh.add(stabL);
  const finGeo = new THREE.BoxGeometry(0.12, 1.55, 1.15, 1, 2, 2);
  finGeo.translate(0, 0.775, 0);
  {
    const pos = finGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const t = pos.getY(i) / 1.55;                      // 0 根部 → 1 顶端
      pos.setZ(i, pos.getZ(i) * (1 - t * 0.4) + t * 0.42);   // 顶端收窄 + 后掠
    }
    finGeo.computeVertexNormals();
  }
  const fin = new THREE.Mesh(finGeo, matBody);
  fin.position.set(0, 0.05, 3.1);   // 底部沉入尾锥（z=3.1 处锥体半径≈0.11）
  mesh.add(fin);
  const finCap = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.3, 6), matBody);
  finCap.position.set(0, 1.62, 3.52);   // 垂尾顶端（根部 z3.1 + 顶端后掠 0.42）
  mesh.add(finCap);

  // 座舱盖：玻璃气泡 + 金属框架（滑轨式）
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10), matGlass);
  canopy.scale.set(0.8, 0.72, 1.6);
  canopy.position.set(0, 0.55, 0.9);
  mesh.add(canopy);
  const frameGeo = new THREE.TorusGeometry(0.42, 0.035, 6, 12, Math.PI);
  for (const fz of [0.35, 1.45]) {
    const fr = new THREE.Mesh(frameGeo, matFrame);
    fr.position.set(0, 0.5, fz);   // XY 平面半环：跨在座舱横截面上（默认方向即所需）
    mesh.add(fr);
  }
  // 天线杆 + 张线（座舱桅杆 → 垂尾顶端）
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.5, 5), matDark);
  mast.position.set(0, 1.0, 0.2);
  mesh.add(mast);
  {
    const y0 = 1.0, z0 = 0.2, y1 = 1.62, z1 = 3.45;   // 桅杆顶 → 垂尾顶
    const len = Math.hypot(y1 - y0, z1 - z0);
    const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, len, 4), matDark);
    wire.position.set(0, (y0 + y1) / 2, (z0 + z1) / 2);
    wire.rotation.x = Math.atan2(z1 - z0, y1 - y0);   // 圆柱 Y 轴转向两点连线
    mesh.add(wire);
  }

  // 机身识别带（翼根后白色环带，贴合该处机身半径~0.45）
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.47, 0.5, 16), matFrame);
  band.rotation.x = Math.PI / 2;
  band.position.z = 0.4;
  mesh.add(band);

  // 副油箱（机腹中轴线）
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 1.9, 10), matBody);
  tank.rotation.x = Math.PI / 2;
  tank.position.set(0, -0.78, 0.3);
  mesh.add(tank);
  const tankNose = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.4, 10), matBody);
  tankNose.rotation.x = -Math.PI / 2;
  tankNose.position.set(0, -0.78, -0.85);
  mesh.add(tankNose);
  const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.3, 0.7), matDark);
  pylon.position.set(0, -0.55, 0.3);
  mesh.add(pylon);

  // 机翼机炮（从翼前缘伸出，与炮口坐标一致）
  const gunGeo = new THREE.CylinderGeometry(0.07, 0.07, 1.5, 6);
  const gL = new THREE.Mesh(gunGeo, matDark);
  gL.rotation.x = Math.PI / 2;
  gL.position.set(-2.4, -0.05, -0.9);
  mesh.add(gL);
  const gR = gL.clone();
  gR.position.x = 2.4;
  mesh.add(gR);

  // 全部实体件投影/接收阴影（触屏端渲染器关闭阴影映射时无额外开销）
  mesh.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // 弱点判定球（按倍率从高到低检测，先中先得）——坐标与旧版完全一致
  const weakPoints = [
    { name: '驾驶舱', part: 'cockpit', offset: new THREE.Vector3(0, 0.55, 0.9), r: 1.05, mult: 3.0, _w: new THREE.Vector3() },
    { name: '发动机', part: 'engine',  offset: new THREE.Vector3(0, 0, -3.6),  r: 1.15, mult: 2.5, _w: new THREE.Vector3() },
    { name: '左翼',   part: 'wing',    offset: new THREE.Vector3(-3.6, 0, 0.2), r: 1.35, mult: 2.0, _w: new THREE.Vector3() },
    { name: '右翼',   part: 'wing',    offset: new THREE.Vector3(3.6, 0, 0.2),  r: 1.35, mult: 2.0, _w: new THREE.Vector3() },
    { name: '机身',   part: 'body',    offset: new THREE.Vector3(0, 0, 1.2),    r: 2.0,  mult: 1.0, _w: new THREE.Vector3() }
  ];
  // 机炮口（本地坐标）
  const guns = [new THREE.Vector3(-2.4, -0.05, -1.7), new THREE.Vector3(2.4, -0.05, -1.7)];

  return { group, mesh, prop, weakPoints, guns };
}

// 由 yaw/pitch 计算机头朝向
const _e = new THREE.Euler();
export function forwardOf(f, out) {
  out = out || new THREE.Vector3();
  _e.set(f.pitch, f.yaw, 0, 'YXZ');
  return out.set(0, 0, -1).applyEuler(_e);
}

// 通用飞行积分：f 需要 {plane, yaw, pitch, roll, yawVel, speed, targetSpeed}
const _dir = new THREE.Vector3();
export function applyFlight(f, dt) {
  f.speed += (f.targetSpeed - f.speed) * Math.min(1, dt * 1.3);
  _e.set(f.pitch, f.yaw, 0, 'YXZ');
  f.plane.group.quaternion.setFromEuler(_e);
  _dir.set(0, 0, -1).applyEuler(_e);
  f.plane.group.position.addScaledVector(_dir, f.speed * dt);
  // 视觉滚转（根据偏航角速度）：向右转→右翼下沉→右滚
  const target = THREE.MathUtils.clamp(f.yawVel * 0.38, -1.05, 1.05);
  f.roll += (target - f.roll) * Math.min(1, dt * 5.5);
  f.plane.mesh.rotation.z = f.roll;
  if (f.plane.prop) f.plane.prop.rotation.z -= dt * (12 + f.speed * 0.4);
}

// 构造一个战斗机实体（玩家本地 / AI 通用）
export function makeFighter(plane) {
  return {
    plane, yaw: 0, pitch: 0, targetYaw: 0, targetPitch: 0,
    roll: 0, yawVel: 0,
    speed: 95, targetSpeed: 95,
    hp: 100, alive: true, gunSide: false
  };
}
