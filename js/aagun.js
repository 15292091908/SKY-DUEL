import * as THREE from 'three';

// 防空车：履带底盘 + 旋转炮塔 + 双管高射机枪（精细版）
// 机头方向 -Z；turretYaw 控制炮塔水平旋转，turretPitch 控制枪管俯仰，bodyYaw 车体朝向
export function buildAAGun(color) {
  const group = new THREE.Group();   // 位置（地面）+ 车体朝向（bodyYaw）
  const matBody = new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.55, envMapIntensity: 0.85 });
  const matArmor = new THREE.MeshStandardMaterial({ color: 0x3d4a3a, metalness: 0.3, roughness: 0.65, envMapIntensity: 0.85 });  // 装甲绿
  const matDark = new THREE.MeshStandardMaterial({ color: 0x2a2f35, metalness: 0.5, roughness: 0.55 });
  const matTrack = new THREE.MeshStandardMaterial({ color: 0x1a1d20, roughness: 0.95 });
  const matTire = new THREE.MeshStandardMaterial({ color: 0x33363b, roughness: 0.9 });

  // ===== 车体 =====
  // 底盘
  const hull = new THREE.Mesh(new THREE.BoxGeometry(3.3, 0.85, 4.9), matBody);
  hull.position.y = 1.0;
  group.add(hull);
  // 上层结构
  const upper = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.75, 4.0), matBody);
  upper.position.y = 1.8;
  group.add(upper);
  // 前倾斜甲板
  const glacis = new THREE.Mesh(new THREE.BoxGeometry(3.1, 1.1, 0.22), matBody);
  glacis.position.set(0, 1.5, -2.45);
  glacis.rotation.x = 0.62;
  group.add(glacis);
  // 侧裙板
  const skirtGeo = new THREE.BoxGeometry(0.16, 0.72, 4.7);
  const skL = new THREE.Mesh(skirtGeo, matArmor); skL.position.set(-1.86, 1.15, 0); group.add(skL);
  const skR = new THREE.Mesh(skirtGeo, matArmor); skR.position.set(1.86, 1.15, 0); group.add(skR);

  // ===== 履带 + 负重轮 =====
  const trackGeo = new THREE.BoxGeometry(1.05, 0.85, 5.1);
  const tL = new THREE.Mesh(trackGeo, matTrack); tL.position.set(-1.95, 0.72, 0); group.add(tL);
  const tR = new THREE.Mesh(trackGeo, matTrack); tR.position.set(1.95, 0.72, 0); group.add(tR);
  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.34, 10);
  wheelGeo.rotateZ(Math.PI / 2);
  for (let i = 0; i < 5; i++) {
    const wz = -1.85 + i * 0.92;
    const wL = new THREE.Mesh(wheelGeo, matTire); wL.position.set(-1.95, 0.42, wz); group.add(wL);
    const wR = new THREE.Mesh(wheelGeo, matTire); wR.position.set(1.95, 0.42, wz); group.add(wR);
  }

  // ===== 炮塔组（yaw 旋转） =====
  const turret = new THREE.Group();
  turret.position.y = 2.2;
  group.add(turret);
  // 炮塔底座
  const tBase = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.32, 0.85, 10), matBody);
  tBase.position.y = 0.42;
  turret.add(tBase);
  // 塔顶收窄段
  const tTop = new THREE.Mesh(new THREE.CylinderGeometry(0.88, 1.05, 0.42, 10), matBody);
  tTop.position.y = 1.02;
  turret.add(tTop);
  // 舱盖
  const hatch = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.16, 8), matDark);
  hatch.position.set(0, 1.3, 0.45);
  turret.add(hatch);
  // 后部储物篮
  const basket = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.55, 0.75), matArmor);
  basket.position.set(0, 0.55, 1.15);
  turret.add(basket);
  // 烟雾弹发射器（4联装）
  const smokeGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.55, 6);
  for (let i = 0; i < 4; i++) {
    const sm = new THREE.Mesh(smokeGeo, matDark);
    sm.rotation.x = Math.PI / 2 - 0.5;
    sm.position.set(-0.45 + (i % 2) * 0.32, 0.95, 0.72 + Math.floor(i / 2) * 0.3);
    turret.add(sm);
  }

  // ===== 机枪组（pitch 俯仰） =====
  const guns = new THREE.Group();
  turret.add(guns);
  // 双管机枪
  const gunGeo = new THREE.CylinderGeometry(0.09, 0.12, 3.2, 8);
  const gL = new THREE.Mesh(gunGeo, matDark); gL.rotation.x = Math.PI / 2; gL.position.set(-0.3, 0.78, -1.35); guns.add(gL);
  const gR = new THREE.Mesh(gunGeo, matDark); gR.rotation.x = Math.PI / 2; gR.position.set(0.3, 0.78, -1.35); guns.add(gR);
  // 枪口消焰器
  const mzGeo = new THREE.CylinderGeometry(0.14, 0.17, 0.5, 8);
  const mzL = new THREE.Mesh(mzGeo, matDark); mzL.rotation.x = Math.PI / 2; mzL.position.set(-0.3, 0.78, -2.9); guns.add(mzL);
  const mzR = new THREE.Mesh(mzGeo, matDark); mzR.rotation.x = Math.PI / 2; mzR.position.set(0.3, 0.78, -2.9); guns.add(mzR);
  // 枪盾
  const shield = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.75, 0.1), matArmor);
  shield.position.set(0, 0.85, -0.55);
  guns.add(shield);
  // 两侧弹链箱
  const ammoGeo = new THREE.BoxGeometry(0.52, 0.42, 0.65);
  const amL = new THREE.Mesh(ammoGeo, matDark); amL.position.set(-0.62, 0.55, 0.1); guns.add(amL);
  const amR = new THREE.Mesh(ammoGeo, matDark); amR.position.set(0.62, 0.55, 0.1); guns.add(amR);
  // 火控雷达天线（小圆盘+杆）
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 6), matDark);
  rod.position.set(0, 1.55, -0.55);
  turret.add(rod);
  const dish = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.52, 0.07, 10), matBody);
  dish.rotation.x = Math.PI / 2;
  dish.position.set(0, 2.1, -0.55);
  turret.add(dish);
  // 通信天线
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.0, 5), matDark);
  ant.position.set(-0.8, 1.9, 0.9);
  ant.rotation.z = 0.12;
  turret.add(ant);

  // ===== 精修细节 =====
  // 炮管散热环（每管 3 道，punch 型高射机枪特征）
  const coolGeo = new THREE.TorusGeometry(0.135, 0.028, 6, 10);
  for (const gx of [-0.3, 0.3]) {
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(coolGeo, matDark);
      ring.position.set(gx, 0.78, -1.6 - i * 0.38);
      guns.add(ring);
    }
  }
  // 车体前部备用履带板（战地储备件）
  const linkGeo = new THREE.BoxGeometry(0.5, 0.1, 0.42);
  for (let i = 0; i < 3; i++) {
    const link = new THREE.Mesh(linkGeo, matTrack);
    link.position.set(-0.62 + i * 0.62, 2.12, -2.2);
    link.rotation.x = 0.62;
    group.add(link);
  }
  // 车尾备用油桶 + 拖钩
  const jerry = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 0.2), matArmor);
  jerry.position.set(1.2, 1.95, 2.1);
  group.add(jerry);
  const hitch = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.3), matDark);
  hitch.position.set(0, 0.8, 2.6);
  group.add(hitch);
  // 炮塔侧检修舱门（圆形凸起）
  const sideHatch = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 10), matArmor);
  sideHatch.rotation.z = Math.PI / 2;
  sideHatch.position.set(1.08, 0.6, 0.2);
  turret.add(sideHatch);

  // 全部实体件投影/接收阴影（触屏端渲染器关闭阴影映射时无额外开销）
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

  // ===== 弱点判定球（车体静止；炮塔弱点跟随炮塔旋转） =====
  const weakPoints = [
    { name: '弹药箱', part: 'ammo',   offset: new THREE.Vector3(0, 2.75, 0.1),  r: 1.25, mult: 2.0, onTurret: true, _w: new THREE.Vector3() },
    { name: '炮塔',   part: 'turret', offset: new THREE.Vector3(0, 2.6, -0.2),  r: 1.55, mult: 1.3, onTurret: true, _w: new THREE.Vector3() },
    { name: '车体',   part: 'body',   offset: new THREE.Vector3(0, 1.35, 0),    r: 2.65, mult: 1.0, _w: new THREE.Vector3() }
  ];
  // 枪口（相对 guns 机枪组坐标系）
  const gunMuzzles = [new THREE.Vector3(-0.3, 0.78, -3.1), new THREE.Vector3(0.3, 0.78, -3.1)];

  return { group, turret, guns, weakPoints, gunMuzzles };
}

// 构造防空车实体
export function makeAAGun(aagun) {
  return {
    aagun, bodyYaw: 0, turretYaw: 0, turretPitch: 0.35,
    speed: 0, targetSpeed: 0,
    hp: 120, alive: true, gunSide: false
  };
}

// 炮塔朝向（yaw/pitch → 方向向量）
const _e = new THREE.Euler();
export function forwardOfTurret(ag, out) {
  out = out || new THREE.Vector3();
  _e.set(ag.turretPitch, ag.turretYaw, 0, 'YXZ');
  return out.set(0, 0, -1).applyEuler(_e);
}

// 车体朝向（bodyYaw → 移动方向，坦克式前进后退）
export function forwardOfBody(ag, out) {
  out = out || new THREE.Vector3();
  return out.set(-Math.sin(ag.bodyYaw), 0, -Math.cos(ag.bodyYaw));
}

// 将车体朝向 + 炮塔角度应用到模型
export function applyAAGun(ag) {
  ag.aagun.group.rotation.y = ag.bodyYaw;
  ag.aagun.turret.rotation.y = ag.turretYaw - ag.bodyYaw;
  ag.aagun.guns.rotation.x = ag.turretPitch;
}

// 防空车弱点世界坐标（炮塔弱点跟随炮塔旋转；兼容容器 {aagun, ent} 与实体 {aagun, turretYaw}）
export function updateWeakAAGun(ag) {
  const ent = ag.ent || ag;
  const model = ag.aagun;
  model.group.updateMatrixWorld(true);
  const rot = (ent.turretYaw || 0) - (ent.bodyYaw || 0);
  const c = Math.cos(rot), s = Math.sin(rot);
  for (const wp of model.weakPoints) {
    if (wp.onTurret) {
      const x = wp.offset.x, z = wp.offset.z;
      wp._w.set(x * c + z * s, wp.offset.y, -x * s + z * c);
    } else {
      wp._w.copy(wp.offset);
    }
    wp._w.applyMatrix4(model.group.matrixWorld);
  }
}
