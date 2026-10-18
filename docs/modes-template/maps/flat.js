// maps/flat.js —— 模板自带的极简地图：一块平地 + 一条跑道
// 正式模式：复制一张现成地形（如 ../air/maps/island.js）到本目录，改 id/name/desc 与 build 即可。
import * as THREE from 'three';

export const MAP = {
  id: 'flat', name: '测试平原', desc: '模板地图 · 一块平地',
  sky: { top: 0x1e63c8, horizon: 0xcfe8f8, elevation: 50, azimuth: 120 },
  background: 0x8fb8d8,
  fog: [0x9fc0d8, 700, 2600],
  bounds: { warn: 700, hurt: 900, ceiling: 600 },
  aaSpawns: [{ x: 0, z: 0 }],
  build(root, colliders) {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.MeshStandardMaterial({ color: 0x4c7a4a, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; root.add(ground);
    const runway = new THREE.Mesh(
      new THREE.PlaneGeometry(56, 900),
      new THREE.MeshStandardMaterial({ color: 0x3d3f43, roughness: 0.92 }));
    runway.rotation.x = -Math.PI / 2; runway.position.y = 0.02; root.add(runway);
    root.add(new THREE.HemisphereLight(0xd6ecff, 0x2f4f3a, 0.6));
    const sun = new THREE.DirectionalLight(0xfff1da, 2.0);
    sun.position.set(300, 600, 200); root.add(sun);
  }
};
