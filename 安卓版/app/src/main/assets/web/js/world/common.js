// world/common.js — 各地图共享的基础设施：世界边界常量 / 工具函数 / 天空太阳 / 程序化贴图
// （2026-10 拆分自 world.js：每张地图一个独立文件，见 空战对决/ 与 防空车突袭/ 两个子文件夹）
import * as THREE from 'three';

// 世界边界（会被 createWorld 按当前地图的 bounds 覆写——main.js 直接引用本对象，保持单例）
export const WORLD = {
  BOUNDARY_WARN: 1700,
  BOUNDARY_HURT: 2100,
  CEILING: 780,
  SEA: 0
};

export const rand = (a, b) => a + Math.random() * (b - a);

// 双方出生锚点（地图内物禁近：island 小岛 / city 郊区房子 / 商店都避开出生区）
export const SPAWNS = [{ x: 0, z: 850 }, { x: 0, z: -850 }];
export function nearSpawn(x, z, pad) {
  return SPAWNS.some((s) => Math.hypot(x - s.x, z - s.z) < pad);
}

/* ---------------- 天空 / 太阳 / 阴影（画质升级核心） ----------------
   自定义渐变天空穹顶（ShaderMaterial 不经过 ACES 色调映射，蓝天所见即所得，
   彻底解决 Preetham Sky 被 tone mapping 过曝成一片白的问题）
   + PMREM 环境贴图（PBR 材质自动获得蓝天反光）
   + 方向光太阳（PCFSoft 软阴影，触屏自动关闭） */
export function setupSky(scene, renderer, preset) {
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

export function setupSun(sunDir, opt) {
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

/* ---------------- 程序化贴图 ---------------- */
export function makeCloudTexture() {
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
export function makeBuildingTexture(base, win, band) {
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
export function makeRoadTexture(axis) {
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
export function makeTreeFactory() {
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
