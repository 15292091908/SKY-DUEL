// js/modes/air/maps/city.js — 现代都市地图（曼哈顿风格：密集楼群 + 河流 + 高架 + 郊区带 + 公园）
import * as THREE from 'three';
import { rand, nearSpawn, setupSun, makeBuildingTexture, makeRoadTexture, makeTreeFactory } from '../../../world/common.js?v=1516';

// 地铁"M"标牌贴图：蓝底白 M
function makeMetroSign() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#1a4f9c';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#ffffff';
  g.font = 'bold 46px Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('M', 32, 36);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

function buildCity(root, colliders, dynamic, glowTex, sunDir, quality) {
  root.add(new THREE.HemisphereLight(0xcfe4ff, 0x4a5548, 0.65));
  root.add(setupSun(sunDir, {
    color: 0xfff2dd, intensity: 2.4, dist: 2400,
    shadows: quality && quality.shadows, mapSize: quality ? quality.shadowSize : 0, half: 1750
  }));

  const RIVER_Z = 600, RIVER_HALF = 28;           // 穿城运河（东西向）
  const inRiver = (x, z, pad) => Math.abs(z - RIVER_Z) < RIVER_HALF + pad;

  // 城岛地面（街区基底色）
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2050, 64),
    new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  root.add(ground);

  // 水域环绕（曼哈顿是岛；PBR 低粗糙度反射天空）
  const water = new THREE.Mesh(
    new THREE.RingGeometry(2050, 4200, 64),
    new THREE.MeshStandardMaterial({ color: 0x1a3a4a, roughness: 0.2, metalness: 0.05, envMapIntensity: 0.8 })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = -1.5;
  root.add(water);

  // ===== 穿城运河：水面 + 两岸堤岸（高度分层防 z-fighting：地面0 < 水0.12 < 路0.4） =====
  const riverW = new THREE.Mesh(
    new THREE.BoxGeometry(4100, 0.24, RIVER_HALF * 2),
    new THREE.MeshStandardMaterial({ color: 0x2e6a86, roughness: 0.12, metalness: 0.05, envMapIntensity: 1.0 })
  );
  riverW.position.set(0, 0.12, RIVER_Z);
  root.add(riverW);
  const bankMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.95 });
  for (const side of [-1, 1]) {
    const bank = new THREE.Mesh(new THREE.BoxGeometry(4100, 1.6, 5), bankMat);
    bank.position.set(0, 0.5, RIVER_Z + side * (RIVER_HALF + 2.5));
    root.add(bank);
  }
  // 跨河桥（7 条街道交叉口处）：桥身侧板 + 栏杆（路面平面本身连续跨河）
  const bridgeMat = new THREE.MeshStandardMaterial({ color: 0xb0b6bc, roughness: 0.85 });
  const railMat = new THREE.MeshStandardMaterial({ color: 0x5a646e, roughness: 0.6, metalness: 0.4 });
  for (let i = -6; i <= 6; i++) {
    const bx = i * 240;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(15, 1.9, RIVER_HALF * 2 + 8), bridgeMat);
    deck.position.set(bx, -0.45, RIVER_Z);
    root.add(deck);
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.3, RIVER_HALF * 2 + 8), railMat);
      rail.position.set(bx + side * 7.2, 1.05, RIVER_Z);
      root.add(rail);
    }
  }

  // ===== 道路网格：大道（沿 X，宽20）× 街道（沿 Z，宽12），y=0.4 防 z-fighting =====
  const roadMatX = new THREE.MeshStandardMaterial({ map: makeRoadTexture('x'), roughness: 0.95 });
  const roadMatZ = new THREE.MeshStandardMaterial({ map: makeRoadTexture('z'), roughness: 0.95 });
  roadMatX.map.repeat.set(100, 1); roadMatZ.map.repeat.set(100, 1);
  const aveGeo = new THREE.PlaneGeometry(4100, 20);
  const stGeo = new THREE.PlaneGeometry(12, 4100);
  for (let i = -6; i <= 6; i++) {
    const ave = new THREE.Mesh(aveGeo, roadMatX);
    ave.rotation.x = -Math.PI / 2;
    ave.position.set(0, 0.4, i * 240);
    root.add(ave);
    const st = new THREE.Mesh(stGeo, roadMatZ);
    st.rotation.x = -Math.PI / 2;
    st.position.set(i * 240, 0.4, 0);
    root.add(st);
  }

  // ===== 高架快速路（z=-480 大道上方）：桥面 + 护栏 + 桥墩 + 桥上汽车 =====
  const elevY = 13;
  const elevDeck = new THREE.Mesh(new THREE.BoxGeometry(4000, 1.4, 18),
    new THREE.MeshStandardMaterial({ color: 0x4a4e54, roughness: 0.9 }));
  elevDeck.position.set(0, elevY, -480);
  root.add(elevDeck);
  for (const side of [-1, 1]) {
    const guard = new THREE.Mesh(new THREE.BoxGeometry(4000, 1.1, 0.7), railMat);
    guard.position.set(0, elevY + 1.2, -480 + side * 8.6);
    root.add(guard);
  }
  const pierGeo = new THREE.CylinderGeometry(1.4, 1.8, elevY, 10);
  const pierMat = new THREE.MeshStandardMaterial({ color: 0x8a9096, roughness: 0.9 });
  for (let i = -7; i <= 7; i++) {
    const px = i * 240 + 120;                      // 桥墩落在街区中央，避开交叉口
    if (Math.abs(px) > 1900) continue;
    const pier = new THREE.Mesh(pierGeo, pierMat);
    pier.position.set(px, elevY / 2, -480);
    root.add(pier);
  }
  colliders.push({ s: 1, x: 0, z: -480, hx: 2000, hz: 9, h: elevY + 0.7 });   // 高架桥面可撞

  // ===== 街区人行道（浅色混凝土台，y=0.22 与道路错层） =====
  const paveMat = new THREE.MeshStandardMaterial({ color: 0x8e949b, roughness: 0.95 });
  const paveGeo = new THREE.BoxGeometry(212, 0.35, 212);
  for (let gx = -6; gx < 6; gx++) {
    for (let gz = -6; gz < 6; gz++) {
      const pcx = gx * 240 + 120, pcz = gz * 240 + 120;
      if (inRiver(pcx, pcz, 120)) continue;        // 河带不铺人行道
      const pave = new THREE.Mesh(paveGeo, paveMat);
      pave.position.set(pcx, 0.22, pcz);
      root.add(pave);
    }
  }

  // 中央公园：绿地 + 步道 + 池塘 + 大树
  const parkMat = new THREE.MeshStandardMaterial({ color: 0x4a6a38, roughness: 1 });
  const park = new THREE.Mesh(new THREE.BoxGeometry(320, 0.7, 440), parkMat);
  park.position.set(0, 0.4, 0);
  root.add(park);
  const pathMat = new THREE.MeshStandardMaterial({ color: 0xa89f8c, roughness: 1 });
  const pathV = new THREE.Mesh(new THREE.BoxGeometry(8, 0.75, 440), pathMat); pathV.position.set(0, 0.43, 0); root.add(pathV);
  const pathH = new THREE.Mesh(new THREE.BoxGeometry(320, 0.75, 8), pathMat); pathH.position.set(0, 0.43, 0); root.add(pathH);
  const parkPond = new THREE.Mesh(new THREE.CircleGeometry(34, 20),
    new THREE.MeshStandardMaterial({ color: 0x2e5a72, roughness: 0.15, metalness: 0.05, envMapIntensity: 0.9 }));
  parkPond.rotation.x = -Math.PI / 2;
  parkPond.position.set(-70, 0.8, 90);
  root.add(parkPond);

  // ===== 楼体贴图（办公楼 / 住宅楼 / 玻璃幕墙塔） =====
  const mats = [
    new THREE.MeshStandardMaterial({ map: makeBuildingTexture('#8d99a6', '#2c4a66', '#6e7a86'), roughness: 0.75, metalness: 0.1 }),
    new THREE.MeshStandardMaterial({ map: makeBuildingTexture('#b8aa94', '#3a3f45', '#9a8d78'), roughness: 0.85 }),
    new THREE.MeshStandardMaterial({ map: makeBuildingTexture('#9a8f85', '#2e3d4c', '#7d746a'), roughness: 0.8 }),
    new THREE.MeshStandardMaterial({ map: makeBuildingTexture('#a8b2bc', '#26384a', '#848e98'), roughness: 0.7, metalness: 0.15 }),
    new THREE.MeshStandardMaterial({ map: makeBuildingTexture('#3c5468', '#1f3244', '#2e4254'), roughness: 0.25, metalness: 0.55 })   // 玻璃幕墙塔
  ];
  const matDark = new THREE.MeshStandardMaterial({ color: 0x2a3138, metalness: 0.6, roughness: 0.45 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x5c6168, roughness: 0.9 });

  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  const spireGeo = new THREE.CylinderGeometry(0.3, 0.9, 1, 6);
  function inPark(x, z) { return Math.abs(x) < 170 && Math.abs(z) < 225; }

  const mkTree = makeTreeFactory();

  // ===== 沿街小商店（2-3 层小楼 + 彩色招牌 + 雨棚，填补街区沿街空隙） =====
  const shopWallMat = new THREE.MeshStandardMaterial({ color: 0xc8beb0, roughness: 0.9 });
  const shopSignColors = [0xd83a3a, 0xe89b2e, 0x2e9e4f, 0x2e6fd8, 0xb03aa0, 0xd8c22e];
  const shopSignMats = shopSignColors.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.5, emissive: c, emissiveIntensity: 0.25 }));
  const awningMat = new THREE.MeshStandardMaterial({ color: 0x8a3a2e, roughness: 0.85 });
  function addShop(x, z, alongX) {
    if (nearSpawn(x, z, 240)) return;
    const w = rand(11, 17), d = rand(9, 13), h = rand(5.5, 8.5);
    const shop = new THREE.Group();
    const body = new THREE.Mesh(boxGeo, shopWallMat);
    body.scale.set(w, h, d); body.position.y = h / 2; shop.add(body);
    const sign = new THREE.Mesh(boxGeo, shopSignMats[Math.floor(Math.random() * shopSignMats.length)]);
    sign.scale.set(alongX ? w : 0.5, 1.8, alongX ? 0.5 : d);
    sign.position.set(alongX ? 0 : w / 2 + 0.2, h - 1.3, alongX ? d / 2 + 0.2 : 0);
    shop.add(sign);
    const awn = new THREE.Mesh(boxGeo, awningMat);
    awn.scale.set(alongX ? w * 0.9 : 2, 0.25, alongX ? 2 : d * 0.9);
    awn.position.set(alongX ? 0 : w / 2 + 1, 3.1, alongX ? d / 2 + 1 : 0);
    shop.add(awn);
    shop.position.set(x, 0.4, z);
    root.add(shop);
    colliders.push({ s: 1, x, z, hx: w / 2 + 1, hz: d / 2 + 1, h: h + 1 });
  }

  // ===== 密集楼群：每街区块 2-4 栋（贴块密排堵住空地），高层向中心渐增 =====
  for (let gx = -6; gx <= 6; gx++) {
    for (let gz = -6; gz <= 6; gz++) {
      const bcx = gx * 240 + 120, bcz = gz * 240 + 120;   // 街区中心（两条路之间）——修楼压马路
      if (inRiver(bcx, bcz, 120)) continue;
      if (Math.hypot(bcx, bcz) > 1830) continue;

      if (!inPark(bcx, bcz)) {
        const n = 2 + Math.floor(Math.random() * 3);     // 每块 2-4 栋
        for (let k = 0; k < n; k++) {
          const w = rand(30, 56), d = rand(30, 56);
          const bx = bcx + rand(-72, 72);                // 块内半宽 111，楼半宽≤28 → 不压路缘
          const bz = bcz + rand(-72, 72);
          if (Math.hypot(bx, bz) > 1830 || inPark(bx, bz)) continue;

          const dc = Math.hypot(bx, bz);
          const heightFactor = 1 - Math.min(1, dc / 1900);
          const h = rand(35, 50 + heightFactor * 210);
          const isGlass = h > 120 && Math.random() < 0.5;
          const mat = isGlass ? mats[4] : mats[Math.floor(Math.random() * 4)];

          // 底层沿街商铺裙楼（比塔身宽一圈、6m 高）
          const podium = new THREE.Mesh(boxGeo, matDark);
          podium.scale.set(w + 4, 6, d + 4);
          podium.position.set(bx, 3.4, bz);
          root.add(podium);

          const b = new THREE.Mesh(boxGeo, mat);
          b.scale.set(w, h, d);
          b.position.set(bx, h / 2 + 3.4, bz);
          root.add(b);
          let topH = h + 3.4;

          // 退台式天台（现代摩天楼）
          if (h > 110 && Math.random() < 0.6) {
            const sh1 = h * rand(0.2, 0.34);
            const sb1 = new THREE.Mesh(boxGeo, mat);
            sb1.scale.set(w * 0.72, sh1, d * 0.72);
            sb1.position.set(bx, topH + sh1 / 2, bz);
            root.add(sb1);
            topH += sh1;
            if (h > 170 && Math.random() < 0.5) {
              const sh2 = sh1 * rand(0.5, 0.7);
              const sb2 = new THREE.Mesh(boxGeo, mat);
              sb2.scale.set(w * 0.48, sh2, d * 0.48);
              sb2.position.set(bx, topH + sh2 / 2, bz);
              root.add(sb2);
              topH += sh2;
            }
            if (topH > 190 && Math.random() < 0.4) {
              const spH = rand(15, 32);
              const spire = new THREE.Mesh(spireGeo, matDark);
              spire.scale.set(1, spH, 1);
              spire.position.set(bx, topH + spH / 2, bz);
              root.add(spire);
              topH += spH;
            }
          }

          // 屋顶设备：水箱 + 空调机组 + 顶板
          const cap = new THREE.Mesh(boxGeo, roofMat);
          cap.scale.set(w * 0.86, 0.8, d * 0.86);
          cap.position.set(bx, topH + 0.4, bz);
          root.add(cap);
          const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 3.2, 8), roofMat);
          tank.position.set(bx + rand(-w * 0.25, w * 0.25), topH + 2.2, bz + rand(-d * 0.25, d * 0.25));
          root.add(tank);
          const ac = new THREE.Mesh(boxGeo, roofMat);
          ac.scale.set(rand(3, 5), 1.4, rand(2, 3.5));
          ac.position.set(bx + rand(-w * 0.28, w * 0.28), topH + 1.2, bz + rand(-d * 0.28, d * 0.28));
          root.add(ac);

          colliders.push({ s: 1, x: bx, z: bz, hx: w / 2 + 2, hz: d / 2 + 2, h: topH });
        }

        // 沿街小商店：每块 2 个（长边随机 + 短边随机），朝向马路
        if (Math.random() < 0.85) {
          const s1along = Math.random() < 0.5;
          addShop(bcx + (s1along ? rand(-80, 80) : rand(88, 96) * (Math.random() < 0.5 ? 1 : -1)),
                  bcz + (s1along ? rand(88, 96) * (Math.random() < 0.5 ? 1 : -1) : rand(-80, 80)), s1along);
        }
        if (Math.random() < 0.6) {
          addShop(bcx + rand(-85, 85), bcz + (Math.random() < 0.5 ? -92 : 92), true);
        }

        // 行道树（沿街两排，块边缘）
        for (let t = 0; t < 4; t++) {
          const tx = bcx + rand(-92, 92), tz = bcz + (t < 2 ? -104 : 104) + rand(-5, 5);
          if (Math.hypot(tx, tz) > 1900 || inPark(tx, tz)) continue;
          const tree = mkTree(rand(0.8, 1.25));
          tree.position.set(tx, 0.45, tz);
          tree.rotation.y = Math.random() * Math.PI;
          root.add(tree);
        }
      }
    }
  }

  // ===== 地铁站（绿玻璃亭 + 顶盖 + M 标柱） =====
  const metroGlassMat = new THREE.MeshStandardMaterial({ color: 0x3a9d78, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.85 });
  const metroRoofMat = new THREE.MeshStandardMaterial({ color: 0x363c42, roughness: 0.7, metalness: 0.3 });
  const metroSignTex = makeMetroSign();
  const metroSpots = [[-360, 120], [360, -360], [600, 360], [-600, -360], [500, 720], [-840, -120]];
  for (const [mx, mz] of metroSpots) {
    if (inRiver(mx, mz, 30) || inPark(mx, mz) || Math.hypot(mx, mz) > 1900) continue;
    const st = new THREE.Group();
    const box = new THREE.Mesh(boxGeo, metroGlassMat);
    box.scale.set(9, 3.6, 9); box.position.y = 1.8; st.add(box);
    const roof = new THREE.Mesh(boxGeo, metroRoofMat);
    roof.scale.set(11, 0.6, 11); roof.position.y = 4.1; st.add(roof);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 8, 8), metroRoofMat);
    pole.position.set(6.5, 4, 6.5); st.add(pole);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(3, 3),
      new THREE.MeshStandardMaterial({ map: metroSignTex, roughness: 0.6, side: THREE.DoubleSide }));
    sign.position.set(6.5, 7, 6.5); st.add(sign);
    st.position.set(mx, 0.4, mz);
    root.add(st);
    colliders.push({ s: 1, x: mx, z: mz, hx: 6.5, hz: 6.5, h: 5 });
  }

  // ===== 沿街车辆（车身+深色车窗舱，随机车漆；路边顺向停放） =====
  const carColors = [0xd8dce0, 0x22262b, 0x8a2027, 0x2a4a8a, 0x9aa2ab, 0x5a6e50];
  const carMats = carColors.map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.35, metalness: 0.5 }));
  const carBodyGeo = new THREE.BoxGeometry(2.1, 1.1, 4.6);
  const carCabGeo = new THREE.BoxGeometry(1.9, 0.65, 2.3);
  const carGlassMat = new THREE.MeshStandardMaterial({ color: 0x1e2a33, roughness: 0.15, metalness: 0.6 });
  function addCar(x, z, alongX, mi, y, noColl) {
    const car = new THREE.Group();
    const body = new THREE.Mesh(carBodyGeo, carMats[mi]); body.position.y = 0.75; car.add(body);
    const cab = new THREE.Mesh(carCabGeo, carGlassMat); cab.position.set(0, 1.55, 0.2); car.add(cab);
    if (alongX) car.rotation.y = Math.PI / 2;
    car.position.set(x, y || 0.55, z);
    root.add(car);
    if (!noColl) colliders.push({ s: 1, x, z, hx: alongX ? 2.5 : 1.2, hz: alongX ? 1.2 : 2.5, h: (y || 0.55) + 2.2 });
  }
  for (let i = -6; i <= 6; i++) {
    for (let k = 0; k < 5; k++) {
      const side = k % 2 === 0 ? 1 : -1;
      const cx2 = i * 240 + rand(-700, 700);
      if (Math.abs(cx2) > 1800 || inRiver(cx2, i * 240, 12)) continue;
      addCar(cx2, i * 240 + side * 6.5, true, Math.floor(Math.random() * carMats.length));   // 大道沿 X
      const cz2 = i * 240 + rand(-700, 700);
      if (Math.abs(cz2) > 1800 || inRiver(i * 240, cz2, 12)) continue;
      addCar(i * 240 + side * 4.2, cz2, false, Math.floor(Math.random() * carMats.length));  // 街道沿 Z
    }
  }
  for (let k = 0; k < 6; k++) {   // 高架桥上车流（无碰撞——桥面已有整体碰撞体）
    addCar(rand(-1700, 1700), -480 + rand(-4, 4), true, Math.floor(Math.random() * carMats.length), elevY + 0.7, true);
  }

  // ===== 郊区低矮房子带（外环 r 1480-1960：小楼 + 坡屋顶 + 院树，150 栋填满远景） =====
  const suburbWallMat = new THREE.MeshStandardMaterial({ color: 0xcfc4ae, roughness: 0.9 });
  const suburbRoofMat = new THREE.MeshStandardMaterial({ color: 0x8a4a3a, roughness: 0.85 });
  const houseGeo = new THREE.BoxGeometry(1, 1, 1);
  const roofGeo = new THREE.ConeGeometry(0.72, 1, 4);
  let suburbN = 0;
  for (let i = 0; i < 400 && suburbN < 150; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = rand(1480, 1960);
    const hx2 = Math.cos(a) * r, hz2 = Math.sin(a) * r;
    if (inRiver(hx2, hz2, 24)) continue;
    if (nearSpawn(hx2, hz2, 200)) continue;
    const w = rand(8, 13), d = rand(7, 11), h = rand(4.5, 7.5);
    const rot = rand(0, Math.PI);
    const house = new THREE.Mesh(houseGeo, suburbWallMat);
    house.scale.set(w, h, d);
    house.position.set(hx2, h / 2, hz2);
    house.rotation.y = rot;
    root.add(house);
    const roof = new THREE.Mesh(roofGeo, suburbRoofMat);
    roof.scale.set(w * 0.78, rand(2.5, 3.6), d * 0.78);
    roof.position.set(hx2, h + roof.scale.y / 2, hz2);
    roof.rotation.y = rot + Math.PI / 4;
    root.add(roof);
    const tree = mkTree(rand(0.7, 1.1));
    tree.position.set(hx2 + rand(-9, 9), 0.1, hz2 + rand(-9, 9));
    root.add(tree);
    const ec = Math.cos(rot), es = Math.sin(rot);
    colliders.push({ s: 1, x: hx2, z: hz2, hx: (w / 2) * Math.abs(ec) + (d / 2) * Math.abs(es), hz: (w / 2) * Math.abs(es) + (d / 2) * Math.abs(ec), h: h + 1 });
    suburbN++;
  }
  // 郊区零散树（填补房与房之间的空隙）
  for (let i = 0; i < 90; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = rand(1450, 1980);
    const tx = Math.cos(a) * r, tz = Math.sin(a) * r;
    if (inRiver(tx, tz, 16) || nearSpawn(tx, tz, 180)) continue;
    const tree = mkTree(rand(0.8, 1.4));
    tree.position.set(tx, 0.1, tz);
    root.add(tree);
  }

  // 公园大树
  for (let i = 0; i < 22; i++) {
    const tx = rand(-140, 140), tz = rand(-195, 195);
    if (Math.abs(tx) < 12 || Math.abs(tz) < 12) continue;   // 避开步道
    const tree = mkTree(rand(1.3, 1.9));
    tree.position.set(tx, 0.75, tz);
    tree.rotation.y = Math.random() * Math.PI;
    root.add(tree);
  }


  // 地标建筑（曼哈顿中城超高层，固定位置 + 三级退台 + 尖顶）
  const landmarks = [[480, -200], [-520, 180]];
  for (const [lx, lz] of landmarks) {
    if (nearSpawn(lx, lz, 280)) continue;
    const lh = rand(240, 290);
    const lw = rand(55, 65), ld = rand(55, 65);
    const lm = new THREE.Mesh(boxGeo, mats[4]);
    lm.scale.set(lw, lh, ld);
    lm.position.set(lx, lh / 2, lz);
    root.add(lm);
    let ltop = lh;
    for (let s = 0; s < 3; s++) {
      const sh = lh * (0.18 - s * 0.04);
      const sf = 0.72 - s * 0.18;
      const sb = new THREE.Mesh(boxGeo, mats[4]);
      sb.scale.set(lw * sf, sh, ld * sf);
      sb.position.set(lx, ltop + sh / 2, lz);
      root.add(sb);
      ltop += sh;
    }
    const spH = rand(30, 45);
    const spire = new THREE.Mesh(spireGeo, matDark);
    spire.scale.set(1, spH, 1);
    spire.position.set(lx, ltop + spH / 2, lz);
    root.add(spire);
    ltop += spH;
    colliders.push({ s: 1, x: lx, z: lz, hx: lw / 2, hz: ld / 2, h: ltop });
  }
}

export const MAP = {
  id: 'city',
  name: '现代都市',
  desc: '摩天楼群 · 穿城运河',
  sky: { top: 0x2266cc, horizon: 0xd2e9f8, elevation: 48, azimuth: 200 },
  background: 0x87b5d9,
  fog: [0xa9c6de, 1200, 4400],
  bounds: { warn: 1700, hurt: 2100, ceiling: 780 },
  aaSpawns: null,
  build(root, colliders, dynamic, ctx) {
    buildCity(root, colliders, dynamic, ctx.glowTex, ctx.sunDir, ctx.quality);
  }
};
