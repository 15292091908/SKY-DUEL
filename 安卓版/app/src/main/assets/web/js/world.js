import * as THREE from 'three';

export const WORLD = {
  BOUNDARY_WARN: 1700,
  BOUNDARY_HURT: 2100,
  CEILING: 780,
  SEA: 0
};

const rand = (a, b) => a + Math.random() * (b - a);
const SPAWNS = [{ x: 0, z: 850 }, { x: 0, z: -850 }];
function nearSpawn(x, z, pad) {
  return SPAWNS.some((s) => Math.hypot(x - s.x, z - s.z) < pad);
}

/* ---------------- 天空 / 太阳 / 阴影（画质升级核心） ----------------
   自定义渐变天空穹顶（ShaderMaterial 不经过 ACES 色调映射，蓝天所见即所得，
   彻底解决 Preetham Sky 被 tone mapping 过曝成一片白的问题）
   + PMREM 环境贴图（PBR 材质自动获得蓝天反光）
   + 方向光太阳（PCFSoft 软阴影，触屏自动关闭） */
function setupSky(scene, renderer, preset) {
  // 跨图切换清理：上一张图的天空穹顶与环境贴图（它们挂在 scene 上，不在 root 里）
  if (setupSky._sky) {
    scene.remove(setupSky._sky);
    setupSky._sky.material.dispose();
    setupSky._sky.geometry.dispose();
    setupSky._sky = null;
  }
  if (setupSky._rt) { setupSky._rt.dispose(); setupSky._rt = null; }

  const sunDir = new THREE.Vector3().setFromSphericalCoords(
    1, THREE.MathUtils.degToRad(90 - preset.elevation), THREE.MathUtils.degToRad(preset.azimuth)
  );

  // 渐变穹顶：天顶饱和蓝 → 地平线浅白蓝，太阳方向加暖色光晕
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(preset.top || 0x1e63c8) },
      horizonColor: { value: new THREE.Color(preset.horizon || 0xcfe8f8) },
      sunDir: { value: sunDir.clone() },
      sunTint: { value: new THREE.Color(0xfff0c8) },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform vec3 topColor; uniform vec3 horizonColor; uniform vec3 sunDir; uniform vec3 sunTint;
            void main() {
        float h = max(vDir.y, 0.0);
        vec3 col = mix(horizonColor, topColor, pow(h, 0.52));
        float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        col += sunTint * pow(s, 220.0) * 1.1;    // 太阳盘
        col += sunTint * pow(s, 5.0) * 0.16;     // 太阳周围暖光
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false
  });
  // 半径 6000：必须满足「穹顶半径 + 相机离原点最大距离 < 相机 far」，
  // 否则穹顶会被远裁剪面切出一个洞，露出 scene.background —— 表现为天上一块淡色多边形（曾在出生点后方必现）
  const sky = new THREE.Mesh(new THREE.SphereGeometry(6000, 32, 15), skyMat);
  sky.renderOrder = -10;   // 最先绘制，纯背景
  scene.add(sky);
  setupSky._sky = sky;

  // 用天空穹顶生成环境贴图：所有 MeshStandard 材质自动获得蓝天漫反射/高光
  if (renderer) {
    setupSky._renderer = renderer;   // 供云层纹理强制预上传（避免开局首帧无纹理的纯色块）
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new THREE.Scene();
      envScene.add(sky);              // 借到临时场景渲染（Mesh 单父节点，自动从主场景移除）
      const rt = pmrem.fromScene(envScene);
      scene.environment = rt.texture;
      setupSky._rt = rt;
      pmrem.dispose();
    } catch (e) { /* 环境生成失败不影响游戏 */ }
  }
  scene.add(sky);   // 归还主场景
  return sunDir;
}

function setupSun(sunDir, opt) {
  const sun = new THREE.DirectionalLight(opt.color, opt.intensity);
  sun.position.copy(sunDir).multiplyScalar(opt.dist);
  if (opt.shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(opt.mapSize, opt.mapSize);
    const c = sun.shadow.camera;
    c.left = -opt.half; c.right = opt.half; c.top = opt.half; c.bottom = -opt.half;
    c.near = opt.dist * 0.3; c.far = opt.dist * 3;
    sun.shadow.bias = -0.00035;
    sun.shadow.normalBias = 2.2;
  }
  return sun;
}

/* ---------------- 贴图 ---------------- */
function makeCloudTexture() {
  // 多个错位软圆叠出"棉花"感；最后用 destination-in 径向遮罩保证四角全透明——
  // 旧版单渐变在半径 55% 处仍有 0.45 亮度，方形 Sprite 轮廓直接可见（游戏里像一片片方形色块）
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const puffs = [
    [128, 132, 104], [94, 122, 70], [166, 120, 74],
    [120, 96, 62], [156, 152, 58], [98, 158, 54], [162, 88, 48],
  ];
  for (const [x, y, r] of puffs) {
    const grd = g.createRadialGradient(x, y, r * 0.12, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.9)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.42)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const mask = g.createRadialGradient(128, 128, 66, 128, 128, 127);
  mask.addColorStop(0, 'rgba(0,0,0,0)');
  mask.addColorStop(0.82, 'rgba(0,0,0,0.12)');
  mask.addColorStop(1, 'rgba(0,0,0,1)');
  g.globalCompositeOperation = 'destination-in';
  g.fillStyle = mask;
  g.fillRect(0, 0, 256, 256);
  g.globalCompositeOperation = 'source-over';
  return new THREE.CanvasTexture(c);
}

// 现代都市楼体贴图：墙体主色 + 竖向结构柱 + 14 层窗格（层间横梁/玻璃反光/亮灯）+ 底层商铺门面
function makeBuildingTexture(base, win, band) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = base;                               // 墙体主色
  g.fillRect(0, 0, 256, 512);
  g.fillStyle = 'rgba(255,255,255,0.07)';           // 竖向结构分缝
  for (let x = 0; x < 256; x += 64) g.fillRect(x, 0, 6, 512);
  for (let row = 0; row < 13; row++) {
    const y = 8 + row * 36;
    g.fillStyle = band;                             // 层间横梁
    g.fillRect(0, y + 25, 256, 9);
    for (let col = 0; col < 10; col++) {
      const x = 8 + col * 25;
      g.fillStyle = Math.random() < 0.15 ? '#ffd98a' : win;   // 少量亮灯
      g.fillRect(x, y, 18, 22);
      g.fillStyle = 'rgba(255,255,255,0.12)';       // 玻璃斜向反光
      g.beginPath(); g.moveTo(x, y + 22); g.lineTo(x + 9, y); g.lineTo(x + 15, y); g.lineTo(x + 5, y + 22); g.closePath(); g.fill();
    }
  }
  g.fillStyle = 'rgba(18,20,24,0.9)';               // 底层沿街商铺门面
  g.fillRect(0, 512 - 44, 256, 44);
  g.fillStyle = '#5a6470';                          // 商铺卷帘门/橱窗
  for (let x = 6; x < 256; x += 42) g.fillRect(x, 512 - 38, 30, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

// 沥青路面贴图：深灰底 + 颗粒 + 中央黄虚线 + 两侧白边线（axis: 'x' 横向虚线 / 'z' 纵向）
function makeRoadTexture(axis) {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#33363b';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 160; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.08)';
    g.fillRect(Math.random() * 128, Math.random() * 128, 3, 3);
  }
  g.fillStyle = '#e8e8e0';                          // 两侧边线
  g.fillRect(2, 0, 4, 128); g.fillRect(122, 0, 4, 128);
  g.fillStyle = '#e6c94f';                          // 中央黄虚线（两段）
  if (axis === 'x') { g.fillRect(20, 62, 34, 5); g.fillRect(74, 62, 34, 5); }
  else { g.fillRect(62, 20, 5, 34); g.fillRect(62, 74, 5, 34); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// 城市行道树 / 公园树 / 郊区树（共享几何体 + 材质，工厂批量生产）
function makeTreeFactory() {
  const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 3.2, 6);
  const crownGeo = new THREE.SphereGeometry(2.1, 8, 7);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6a4e34, roughness: 0.95 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x3f7a44, roughness: 0.9 });
  return (s) => {
    const t = new THREE.Group();
    const trunk = new THREE.Mesh(trunkGeo, trunkMat); trunk.position.y = 1.6; t.add(trunk);
    const crown = new THREE.Mesh(crownGeo, crownMat); crown.position.y = 4.1; crown.scale.setScalar(s || 1); t.add(crown);
    return t;
  };
}

/* ---------------- 海岛地图 ---------------- */
function buildIsland(root, colliders, dynamic, sunDir, quality) {
  root.add(new THREE.HemisphereLight(0xd6ecff, 0x2f4f3a, 0.55));
  root.add(setupSun(sunDir, {
    color: 0xfff1da, intensity: 2.2, dist: 2000,
    shadows: quality && quality.shadows, mapSize: quality ? quality.shadowSize : 0, half: 1500
  }));

  // 海面：PBR 材质自动反射天空（天空环境贴图），低粗糙度高光
  const sea = new THREE.Mesh(
    new THREE.CircleGeometry(4200, 72),
    new THREE.MeshStandardMaterial({ color: 0x1d5f8a, roughness: 0.14, metalness: 0.05, envMapIntensity: 0.85 })
  );
  sea.rotation.x = -Math.PI / 2;
  root.add(sea);

  const sandMat = new THREE.MeshStandardMaterial({ color: 0xc9b98a, roughness: 0.95 });
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x6f7a6a, roughness: 0.9 });
  const treeMat = new THREE.MeshStandardMaterial({ color: 0x3f7a4a, roughness: 0.9 });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.95 });

  for (let i = 0; i < 16; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = rand(220, 1450);
    const ix = Math.cos(ang) * r, iz = Math.sin(ang) * r;
    if (nearSpawn(ix, iz, 280)) continue;
    const isl = new THREE.Group();
    isl.position.set(ix, 0, iz);
    // 远处的小岛放大体量：否则 1km 外只剩一粒没有细节的色块
    const farK = r > 700 ? 1.6 : 1;
    const baseR = rand(28, 90) * farK;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(baseR * 0.85, baseR, 10, 18), sandMat);
    base.position.y = 3;
    isl.add(base);
    colliders.push({ s: 0, v: new THREE.Vector3(ix, 4, iz), r: baseR * 0.95 });

    const peaks = 1 + Math.floor(Math.random() * 3);
    for (let p = 0; p < peaks; p++) {
      const h = rand(22, 85);
      const cr = rand(14, baseR * 0.7);
      const px = rand(-baseR * 0.4, baseR * 0.4);
      const pz = rand(-baseR * 0.4, baseR * 0.4);
      const mtn = new THREE.Mesh(new THREE.ConeGeometry(cr, h, 14), rockMat);
      mtn.position.set(px, 8 + h / 2, pz);
      isl.add(mtn);
      colliders.push({ s: 0, v: new THREE.Vector3(ix + px, 8 + h * 0.45, iz + pz), r: Math.max(cr * 0.85, h * 0.42) });
    }
    // 松树：树干 + 双层锥形树冠（替代单锥体）
    for (let t = 0; t < 7; t++) {
      const ta = Math.random() * Math.PI * 2;
      const tr = rand(baseR * 0.35, baseR * 0.78);
      const tx = Math.cos(ta) * tr, tz = Math.sin(ta) * tr;
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 4.5, 6), trunkMat);
      trunk.position.y = 2.2;
      tree.add(trunk);
      const c1 = new THREE.Mesh(new THREE.ConeGeometry(rand(3.2, 5), rand(6, 9), 10), treeMat);
      c1.position.y = 7;
      tree.add(c1);
      const c2 = new THREE.Mesh(new THREE.ConeGeometry(rand(2, 3.2), rand(4, 6), 10), treeMat);
      c2.position.y = 11;
      tree.add(c2);
      tree.position.set(tx, 8, tz);
      tree.rotation.y = Math.random() * Math.PI;
      isl.add(tree);
    }
    root.add(isl);
  }

}


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

/* ---------------- 现代都市地图（曼哈顿风格：密集楼群 + 河流 + 高架 + 郊区带 + 公园） ---------------- */
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



/* ---------------- 军事基地小岛（防空车玩法地图，紧凑型） ---------------- */
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

/* ---------------- 入口 ---------------- */
// 各图天空预设：top 天顶色 / horizon 地平线色 / elevation 太阳高度角 / azimuth 方位角（三图统一蓝天白云）
const SKY_PRESETS = {
  island: { top: 0x1e63c8, horizon: 0xcfe8f8, elevation: 55, azimuth: 135 },
  city:   { top: 0x2266cc, horizon: 0xd2e9f8, elevation: 48, azimuth: 200 },
  base:   { top: 0x1e63c8, horizon: 0xcfe8f8, elevation: 40, azimuth: 105 }
};

export function createWorld(scene, type = 'island', renderer = null, quality = null) {
  const root = new THREE.Group();
  const colliders = [];
  const dynamic = { fires: [], smokes: [], clouds: null };
  const glowTex = makeCloudTexture();
  if (setupSky._renderer) { try { setupSky._renderer.initTexture(glowTex); } catch (e) {} }   // 同上：预上传防首帧色块
  const preset = SKY_PRESETS[type] || SKY_PRESETS.island;
  const sunDir = setupSky(scene, renderer, preset);

  if (type === 'city') {
    scene.background = new THREE.Color(0x87b5d9);
    scene.fog = new THREE.Fog(0xa9c6de, 1200, 4400);   // 浅蓝雾（晴空）；near 后推：郊区楼带不再被压成扁平色块
    WORLD.BOUNDARY_WARN = 1700; WORLD.BOUNDARY_HURT = 2100; WORLD.CEILING = 780;
    buildCity(root, colliders, dynamic, glowTex, sunDir, quality);
  } else if (type === 'base') {
    scene.background = new THREE.Color(0x8fb8d8);
    scene.fog = new THREE.Fog(0x9fc0d8, 700, 2600);    // 基地：原 near=350 太近，环岛远景全被染成蓝块
    // 紧凑小岛：战斗空域相应收紧
    WORLD.BOUNDARY_WARN = 780; WORLD.BOUNDARY_HURT = 980; WORLD.CEILING = 620;
    buildBase(root, colliders, dynamic, sunDir, quality);
  } else {
    scene.background = new THREE.Color(0x87b5d9);
    scene.fog = new THREE.Fog(0x9fc2dd, 1400, 4600);   // 海岛：小岛分布 220~1450m，near=900 时正好落在雾区里变成蓝块
    WORLD.BOUNDARY_WARN = 1700; WORLD.BOUNDARY_HURT = 2100; WORLD.CEILING = 780;
    buildIsland(root, colliders, dynamic, sunDir, quality);
  }
  for (const c of colliders) if (c.s === 0) c.r2 = c.r * c.r;

  // 全场景标记：阴影投射/接收 + 环境反射强度统一压低（消除 IBL 整体泛白，天空更蓝）
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (quality && quality.shadows) { o.castShadow = true; o.receiveShadow = true; }
    if (o.material && o.material.isMeshStandardMaterial) o.material.envMapIntensity = 0.85;
  });

  return {
    root,
    colliders,
    aaSpawns: AAGUN_SPAWNS,
    update(dt, t) {
      for (let i = 0; i < dynamic.fires.length; i++) {
        dynamic.fires[i].material.opacity = 0.5 + 0.35 * Math.sin(t * 11 + i * 1.7);
      }
      for (const s of dynamic.smokes) {
        s.position.y += dt * 2.5;
        if (s.position.y > s.userData.y0 + 42) s.position.y = s.userData.y0;
      }
    }
  };
}
