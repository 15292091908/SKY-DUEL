// js/modes/air/maps/island.js — 太平洋海岛地图（千岛环礁）
// 地图元数据（名字/八字介绍）由选图界面直接读取展示；新增地图只需在本目录加一个同结构文件
import * as THREE from 'three';
import { rand, nearSpawn, setupSun } from '../../../world/common.js?v=1516';

const SPAWNS = [{ x: 0, z: 850 }, { x: 0, z: -850 }];

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
    if (SPAWNS.some((s) => Math.hypot(ix - s.x, iz - s.z) < 280)) continue;
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

export const MAP = {
  id: 'island',
  name: '太平洋海岛',
  desc: '碧海岛屿 · 山峰掩体',
  sky: { top: 0x1e63c8, horizon: 0xcfe8f8, elevation: 55, azimuth: 135 },
  background: 0x87b5d9,
  fog: [0x9fc2dd, 1400, 4600],
  bounds: { warn: 1700, hurt: 2100, ceiling: 780 },
  aaSpawns: null,   // 防空车点位：仅基地图有
  build(root, colliders, dynamic, ctx) {
    buildIsland(root, colliders, dynamic, ctx.sunDir, ctx.quality);
  }
};
