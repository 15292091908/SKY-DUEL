// js/modes/heli/maps/base.js —— 直升机模式的独立副本（与 aavs/maps/base.js 同源；改地形时两处一起改） — 军事基地小岛（防空车玩法地图，紧凑型）
import * as THREE from 'three';
import { rand, setupSun } from '../../../world/common.js?v=1516';

// 真实机场跑道贴图：边线/中线虚线/跑道号码/接地带标线/瞄准点/橡胶痕迹
function makeRunwayTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 2048;
  const g = c.getContext('2d');
  // 沥青底色 + 颗粒噪点
  g.fillStyle = '#3d3f43';
  g.fillRect(0, 0, 256, 2048);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.06)';
    g.fillRect(Math.random() * 256, Math.random() * 2048, 3, 3);
  }
  // 两端着陆橡胶痕迹（黑色渐变）
  for (const [sy, dir] of [[340, 1], [1708, -1]]) {
    const grd = g.createLinearGradient(0, sy, 0, sy + dir * 300);
    grd.addColorStop(0, 'rgba(15,15,17,0.5)');
    grd.addColorStop(1, 'rgba(15,15,17,0)');
    g.fillStyle = grd;
    g.fillRect(55, dir > 0 ? sy : sy - 300, 146, 300);
  }
  const W = '#e8e8e0';
  // 左右边线
  g.fillStyle = W;
  g.fillRect(24, 0, 7, 2048);
  g.fillRect(225, 0, 7, 2048);
  // 中线虚线
  for (let y = 130; y < 1930; y += 92) g.fillRect(122, y, 12, 52);
  // 跑道号码（36 北端 / 18 南端，两端倒置）
  g.font = 'bold 100px "Arial Black", Arial, sans-serif';
  g.textAlign = 'center';
  g.fillText('36', 128, 245);
  g.save();
  g.translate(128, 1808); g.rotate(Math.PI);
  g.fillText('18', 0, -10);
  g.restore();
  // 接地带标线（每侧3组，1/2/3条渐进）
  for (const side of [62, 176]) {
    for (let gi = 1; gi <= 3; gi++) {
      const y = 420 + (gi - 1) * 170;
      for (let k = 0; k < gi; k++) {
        const off = (k - (gi - 1) / 2) * 18;
        g.fillRect(side - 5 + off, y, 9, 66);
      }
    }
    // 对称南端
    for (let gi = 1; gi <= 3; gi++) {
      const y = 1628 - (gi - 1) * 170;
      for (let k = 0; k < gi; k++) {
        const off = (k - (gi - 1) / 2) * 18;
        g.fillRect(side - 5 + off, y - 66, 9, 66);
      }
    }
  }
  // 瞄准点（两侧大白块）
  g.fillRect(58, 940, 46, 110);
  g.fillRect(152, 940, 46, 110);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

// 防空车点位（7 个）——main.js 的 aagunSpawnPos 按此布置防空车阵营
export const AAGUN_SPAWNS = [
  { x: -90, z: -60 },    // 1 跑道西侧
  { x: 90, z: -60 },     // 2 跑道东侧
  { x: -90, z: 210 },    // 3
  { x: 90, z: 210 },     // 4
  { x: -90, z: -280 },   // 5
  { x: 90, z: -280 },    // 6
  { x: 0, z: 385 }       // 7 北端
];

function buildBase(root, colliders, dynamic, sunDir, quality) {
  root.add(new THREE.HemisphereLight(0xcfe0ff, 0x5a6a5a, 0.55));
  root.add(setupSun(sunDir, {
    color: 0xfff0d8, intensity: 2.1, dist: 900,
    shadows: quality && quality.shadows, mapSize: quality ? quality.shadowSize : 0, half: 480
  }));

  // 小岛（紧凑：约两艘航母级面积）
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(420, 48),
    new THREE.MeshStandardMaterial({ color: 0x7a8a5a, roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  root.add(ground);

  // 水域环绕（PBR 低粗糙度反射天空）
  const water = new THREE.Mesh(
    new THREE.RingGeometry(420, 3200, 48),
    new THREE.MeshStandardMaterial({ color: 0x1a4a6a, roughness: 0.16, metalness: 0.05, envMapIntensity: 0.85 })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = -1.5;
  root.add(water);

  // 混凝土场坪（基地主体）
  const padMat = new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 0.9 });
  const pad = new THREE.Mesh(new THREE.CircleGeometry(385, 40), padMat);
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = 0.18;
  root.add(pad);

  // ===== 跑道（铺满大半张地图，真实机场标线贴图） =====
  const runway = new THREE.Mesh(
    new THREE.PlaneGeometry(46, 680),
    new THREE.MeshStandardMaterial({ map: makeRunwayTexture(), roughness: 0.92 })
  );
  runway.rotation.x = -Math.PI / 2;
  runway.position.set(0, 0.26, 0);
  root.add(runway);
  // 跑道两侧滑行道边线（黄色）
  const taxiMat = new THREE.MeshBasicMaterial({ color: 0xd8b83a });
  for (const tx of [-33, 33]) {
    const taxi = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.02, 620), taxiMat);
    taxi.position.set(tx, 0.24, 0);
    root.add(taxi);
  }
  // 滑行道（跑道两侧混凝土带）
  for (const tx of [-68, 68]) {
    const taxiway = new THREE.Mesh(new THREE.PlaneGeometry(40, 620), padMat);
    taxiway.rotation.x = -Math.PI / 2;
    taxiway.position.set(tx, 0.2, 0);
    root.add(taxiway);
  }

  // 材质（机库双面：拱形壳与挡板从任何角度都可见，避免"只剩一半"的透明感）
  const conMat = new THREE.MeshStandardMaterial({ color: 0x9a9a92, roughness: 0.85 });
  const hangarMat = new THREE.MeshStandardMaterial({ color: 0x6f6f68, roughness: 0.85, side: THREE.DoubleSide });
  const greenMat = new THREE.MeshStandardMaterial({ color: 0x4a5a3a, roughness: 0.9 });
  const metalMat = new THREE.MeshStandardMaterial({ color: 0x5c5f66, metalness: 0.6, roughness: 0.5 });
  const tankMat = new THREE.MeshStandardMaterial({ color: 0x3f4a4f, metalness: 0.4, roughness: 0.6 });
  const treeMat = new THREE.MeshStandardMaterial({ color: 0x3a5a3a, roughness: 0.9 });

  // 机库（横放完整圆柱 ×2，滑行道外侧；下半圆柱埋入地面，避免"只剩一半"）
  const hangarGeo = new THREE.CylinderGeometry(11, 11, 24, 12);
  for (const [hx, hz] of [[-135, -170], [135, -170]]) {
    const hang = new THREE.Mesh(hangarGeo, hangarMat);
    hang.rotation.z = Math.PI / 2;
    hang.position.set(hx, 11, hz);
    root.add(hang);
    // 完整圆柱自带两端端盖，无需挡板
    colliders.push({ s: 1, x: hx, z: hz, hx: 14, hz: 16, h: 14 });
  }

  // 塔台（跑道南端，高层建筑）
  const towerBase = new THREE.Mesh(new THREE.BoxGeometry(10, 20, 10), conMat);
  towerBase.position.set(85, 10, -390);
  root.add(towerBase);
  const towerTop = new THREE.Mesh(new THREE.BoxGeometry(13, 5, 13), metalMat);
  towerTop.position.set(85, 23, -390);
  root.add(towerTop);
  const towerRoof = new THREE.Mesh(new THREE.BoxGeometry(14, 0.8, 14), conMat);
  towerRoof.position.set(85, 26, -390);
  root.add(towerRoof);
  colliders.push({ s: 1, x: 85, z: -390, hx: 7, hz: 7, h: 26 });

  // 雷达站（西北角）
  const radTower = new THREE.Mesh(new THREE.CylinderGeometry(2, 3.2, 30, 8), conMat);
  radTower.position.set(-170, 15, 340);
  root.add(radTower);
  const radDish = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 1.2, 12), metalMat);
  radDish.rotation.x = Math.PI / 2 - 0.35;
  radDish.position.set(-170, 31, 340);
  root.add(radDish);
  colliders.push({ s: 0, v: new THREE.Vector3(-170, 8, 340), r: 5 });

  // 油罐区（东侧 ×3）
  for (const [tx, tz] of [[155, 215], [155, 265], [155, 315]]) {
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 17, 12), tankMat);
    tank.position.set(tx, 8.5, tz);
    root.add(tank);
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 0.8, 8), metalMat);
    lid.position.set(tx, 17.4, tz);
    root.add(lid);
    colliders.push({ s: 0, v: new THREE.Vector3(tx, 8, tz), r: 10 });
  }

  // 碉堡（对角 ×2）
  for (const [bx, bz] of [[-280, 280], [280, -280]]) {
    const bunker = new THREE.Mesh(new THREE.BoxGeometry(20, 6, 16), conMat);
    bunker.position.set(bx, 3, bz);
    root.add(bunker);
    colliders.push({ s: 1, x: bx, z: bz, hx: 11, hz: 9, h: 6 });
  }

  // 直升机停机坪（西侧）
  const heliPad = new THREE.Mesh(new THREE.CircleGeometry(13, 20), padMat);
  heliPad.rotation.x = -Math.PI / 2;
  heliPad.position.set(-150, 0.22, 80);
  root.add(heliPad);
  const heli = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 4.5, 2.2, 8), greenMat);
  heli.position.set(-150, 2.4, 80);
  root.add(heli);
  const heliRotor = new THREE.Mesh(new THREE.BoxGeometry(11, 0.18, 1.0), metalMat);
  heliRotor.position.set(-150, 3.8, 80);
  root.add(heliRotor);
  // 直升机碰撞
  colliders.push({ s: 0, v: new THREE.Vector3(-150, 2.5, 80), r: 5 });

  // 旗杆 + 旗帜（塔台旁）
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 0.6, roughness: 0.4 });
  const flagMat = new THREE.MeshStandardMaterial({ color: 0x2e7d4f, roughness: 0.7 });
  for (const [px, pz] of [[60, -390], [110, -390]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.35, 14, 6), poleMat);
    pole.position.set(px, 7, pz);
    root.add(pole);
    const flag = new THREE.Mesh(new THREE.BoxGeometry(4, 2, 0.18), flagMat);
    flag.position.set(px + 2, 12.2, pz);
    root.add(flag);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.5, 6, 6), poleMat);
    ball.position.set(px, 14, pz);
    root.add(ball);
    colliders.push({ s: 0, v: new THREE.Vector3(px, 5, pz), r: 2 });
  }

  // 军车（卡车 + 吉普，滑行道旁）
  const truckMat = new THREE.MeshStandardMaterial({ color: 0x5a5f4a, roughness: 0.85 });
  const truck = new THREE.Mesh(new THREE.BoxGeometry(3.5, 2.4, 7), truckMat);
  truck.position.set(-90, 1.8, 330);
  root.add(truck);
  const truckCab = new THREE.Mesh(new THREE.BoxGeometry(3.5, 2, 2.6), greenMat);
  truckCab.position.set(-90, 2.4, 326.5);
  root.add(truckCab);
  const jeep = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.5, 4.4), greenMat);
  jeep.position.set(90, 1.1, 330);
  root.add(jeep);
  // 军车碰撞
  colliders.push({ s: 1, x: -90, z: 330, hx: 2.6, hz: 4.5, h: 3.5 });
  colliders.push({ s: 1, x: 90, z: 330, hx: 2, hz: 3, h: 2.5 });

  // 沙袋掩体（跑道两端侧，带碰撞）
  for (const [sx, sz] of [[-45, -320], [45, -320], [-45, 310], [45, 310]]) {
    const bag = new THREE.Mesh(new THREE.BoxGeometry(4.5, 2, 2.6), greenMat);
    bag.position.set(sx, 1, sz);
    root.add(bag);
    colliders.push({ s: 1, x: sx, z: sz, hx: 2.5, hz: 1.8, h: 2.2 });
  }

  // 树木点缀（围栏内边缘环带，带碰撞）
  for (let i = 0; i < 22; i++) {
    // 随机尝试多次：避开跑道 + 避开所有防空车刷新点位（防止刷出时穿模卡树）
    let tx = 0, tz = 0, placed = false;
    for (let tries = 0; tries < 8 && !placed; tries++) {
      const a = Math.random() * Math.PI * 2, r = rand(330, 380);
      tx = Math.cos(a) * r; tz = Math.sin(a) * r;
      if (Math.abs(tx) < 100 && Math.abs(tz) < 360) continue;   // 避开跑道
      if (AAGUN_SPAWNS.every(s => Math.hypot(tx - s.x, tz - s.z) > 28)) placed = true;   // 避开防空车点位
    }
    if (!placed) continue;
    const tree = new THREE.Mesh(new THREE.ConeGeometry(rand(4, 7), rand(9, 15), 6), treeMat);
    tree.position.set(tx, 7, tz);
    root.add(tree);
    colliders.push({ s: 0, v: new THREE.Vector3(tx, 3, tz), r: 2.4 });
  }

  // 掩体设施群（防空车躲藏处，跑道两侧 + 点位附近，均有碰撞）
  const sandMat = new THREE.MeshStandardMaterial({ color: 0x8a8f78, roughness: 0.9 });
  // 沙袋阵地 ×8（每组 3 个沙袋 L 形，可隐蔽防空车）
  for (const [bx, bz] of [[-90, -130], [90, -130], [-90, 70], [90, 70], [-90, 180], [90, 180], [-60, 250], [60, 250]]) {
    for (let k = 0; k < 3; k++) {
      const bag = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.6, 1.4), sandMat);
      bag.position.set(bx + (k % 2) * 3.5, 0.8, bz + Math.floor(k / 2) * 3.4);
      root.add(bag);
    }
    colliders.push({ s: 1, x: bx + 1.8, z: bz + 1.7, hx: 3.4, hz: 3.2, h: 1.8 });
  }
  // 水泥掩体墙 ×6（低矮防爆墙，防空车可躲其后）
  for (const [wx, wz] of [[-90, -10], [90, -10], [-90, 110], [90, 110], [-135, 250], [135, 250]]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(7, 2.4, 1.2), conMat);
    wall.position.set(wx, 1.2, wz);
    root.add(wall);
    colliders.push({ s: 1, x: wx, z: wz, hx: 3.7, hz: 1, h: 2.6 });
  }
  // 弹药箱堆 ×4
  const crateGeo2 = new THREE.BoxGeometry(2.2, 2.2, 2.2);
  for (const [cx, cz] of [[-60, -60], [60, -60], [-60, 220], [60, 220]]) {
    for (let k = 0; k < 3; k++) {
      const crate = new THREE.Mesh(crateGeo2, sandMat);
      crate.position.set(cx + (k % 2) * 2.6, 1.1 + Math.floor(k / 2) * 2.3, cz + Math.floor(k / 2) * 0.6);
      root.add(crate);
    }
    colliders.push({ s: 1, x: cx, z: cz, hx: 3.2, hz: 2.6, h: 3.5 });
  }
  // 瞭望塔 ×2（岛西侧，塔台之外的观察点）
  for (const [ox, oz] of [[-150, -330], [150, -330]]) {
    const towerLeg = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.2, 12, 8), conMat);
    towerLeg.position.set(ox, 6, oz);
    root.add(towerLeg);
    const towerTop = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, 3, 8), metalMat);
    towerTop.position.set(ox, 13.5, oz);
    root.add(towerTop);
    colliders.push({ s: 0, v: new THREE.Vector3(ox, 6, oz), r: 4 });
  }

  // 基地防撞护栏（岛边缘一圈，防空车防止开出基地）
  // 连续白色混凝土矮墙 + 顶部深色横杆 + 立柱——比细铁丝网显眼得多，一眼可见
  const fenceMat = new THREE.MeshStandardMaterial({ color: 0xc9cdd2, roughness: 0.8 });   // 浅灰混凝土
  const railMat = new THREE.MeshStandardMaterial({ color: 0x3a3f45, metalness: 0.5, roughness: 0.5 }); // 深色金属
  const FENCE_R = 400, FENCE_SEGS = 28;
  for (let i = 0; i < FENCE_SEGS; i++) {
    const a0 = (i / FENCE_SEGS) * Math.PI * 2;
    const a1 = ((i + 1) / FENCE_SEGS) * Math.PI * 2;
    const x0 = Math.cos(a0) * FENCE_R, z0 = Math.sin(a0) * FENCE_R;
    const x1 = Math.cos(a1) * FENCE_R, z1 = Math.sin(a1) * FENCE_R;
    const midX = (x0 + x1) / 2, midZ = (z0 + z1) / 2;
    const segLen = Math.hypot(x1 - x0, z1 - z0);
    // 连续矮墙（防撞护栏主体）
    const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 1.5, 1), fenceMat);
    wall.scale.set(segLen + 0.4, 1, 1);
    wall.position.set(midX, 0.75, midZ);
    wall.rotation.y = -a0 - Math.PI / 2;
    root.add(wall);
    // 顶部金属横杆
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1, 5), railMat);
    rail.scale.y = segLen + 0.4;
    rail.position.set(midX, 2.2, midZ);
    rail.rotation.y = -a0 - Math.PI / 2;
    root.add(rail);
    // 立柱（墙外侧，每段两端）
    const postGeo = new THREE.CylinderGeometry(0.3, 0.3, 3, 6);
    for (const [px, pz] of [[x0, z0], [x1, z1]]) {
      const post = new THREE.Mesh(postGeo, railMat);
      post.position.set(px, 1.5, pz);
      root.add(post);
    }
    // 碰撞：沿段分布的球（贴合弧形围栏朝向；轴对齐盒无法贴合弧段、形同虚设）
    for (let k = 0; k < 3; k++) {
      const t = 0.25 + k * 0.25;
      const bx = x0 + (x1 - x0) * t, bz = z0 + (z1 - z0) * t;
      colliders.push({ s: 0, v: new THREE.Vector3(bx, 1, bz), r: segLen / 6 + 2 });
    }
  }
}

export const MAP = {
  id: 'base',
  name: '军事基地',
  desc: '机场跑道 · 防空阵地',
  sky: { top: 0x1e63c8, horizon: 0xcfe8f8, elevation: 40, azimuth: 105 },
  background: 0x8fb8d8,
  fog: [0x9fc0d8, 700, 2600],
  bounds: { warn: 780, hurt: 980, ceiling: 620 },
  aaSpawns: AAGUN_SPAWNS,
  build(root, colliders, dynamic, ctx) {
    buildBase(root, colliders, dynamic, ctx.sunDir, ctx.quality);
  }
};
