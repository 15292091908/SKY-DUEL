// js/world/index.js —— 世界构建入口 + 地图注册表（v3.10.0）
//
// 地图文件现在属于各模式包：js/modes/<dir>/maps/*.js
// 该模式包的 maps.js 会调用 registerMap(MAP) 把地图登记进来；本文件只保留共用世界基础设施
// （天空 / 太阳 / 边界 / createWorld），不再硬编码任何玩法与地图。
import * as THREE from 'three';
import { WORLD, setupSky, makeCloudTexture, withSeed, hashStr } from './common.js?v=1543';

export { WORLD };   // 全局单例：边界/高度上限随地图切换被覆写

const REGISTRY = new Map();

// 模式包（maps.js）加载时登记地图
export function registerMap(map) {
  if (map && map.id) REGISTRY.set(map.id, map);
}
export function mapById(id) { return REGISTRY.get(id) || null; }
export function allMaps() { return [...REGISTRY.values()]; }

/* 建世界入口。
   ★ v3.13.1：整段构建都跑在「地图 id 种子」的确定性随机窗口里（withSeed）——
     地图是程序化生成的，原来直接用 Math.random() 会让每个客户端长出不同的城市，
     联机时两边看到的楼/掩体/碰撞体完全不一样（城市图最明显）。
     同一 id → 任何机器、任何次数都得到逐字节一致的几何与 colliders。 */
export function createWorld(scene, type = 'island', renderer = null, quality = null) {
  const map = mapById(type) || allMaps()[0];
  if (!map) throw new Error('[world] 没有已登记的地图：模式包的 maps.js 还未加载');
  return withSeed(hashStr(map.id), () => buildWorld(scene, map, renderer, quality));
}

function buildWorld(scene, map, renderer, quality) {
  const root = new THREE.Group();
  const colliders = [];
  const dynamic = { fires: [], smokes: [], clouds: null };
  const glowTex = makeCloudTexture();
  if (setupSky._renderer) { try { setupSky._renderer.initTexture(glowTex); } catch (e) {} }
  const sunDir = setupSky(scene, renderer, map.sky);
  scene.background = new THREE.Color(map.background);
  scene.fog = new THREE.Fog(map.fog[0], map.fog[1], map.fog[2]);
  WORLD.BOUNDARY_WARN = map.bounds.warn; WORLD.BOUNDARY_HURT = map.bounds.hurt; WORLD.CEILING = map.bounds.ceiling;
  map.build(root, colliders, dynamic, { sunDir, quality, glowTex });
  for (const c of colliders) if (c.s === 0) c.r2 = c.r * c.r;
  // 全场景最高碰撞体（子弹撞世界的快速剔除用：整段都在它之上的子弹不必逐个采样）
  let maxTop = -Infinity;
  for (const c of colliders) maxTop = Math.max(maxTop, c.s === 1 ? c.h : c.v.y + c.r);

  // 全场景标记：阴影投射/接收 + 环境反射强度统一压低（消除 IBL 整体泛白，天空更蓝）
  root.traverse((o) => {
    if (!o.isMesh) return;
    if (quality && quality.shadows) { o.castShadow = true; o.receiveShadow = true; }
    if (o.material && o.material.isMeshStandardMaterial) o.material.envMapIntensity = 0.85;
  });

  return {
    root,
    colliders,
    maxTop: Number.isFinite(maxTop) ? maxTop : 0,
    aaSpawns: map.aaSpawns || null,
    map,   // 当前地图元数据（id/name/desc，供 UI 与战绩导出读取）
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
