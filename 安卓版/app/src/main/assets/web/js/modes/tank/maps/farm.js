// js/modes/tank/maps/farm.js —— 乡村地图（坦克对决）
//
// 地形：程序化起伏（不是平面）+ 一座缓丘 / 一片洼地；炮弹落地会挖出**真实下沉的弹坑**
//       （地面高度函数同样减去坑深，所以坦克开进坑里会往下沉，不是贴图）。
// 建筑：木房子由「一块块木板」拼成（InstancedMesh），被穿甲弹打中会按命中点**开洞**，
//       洞后面能看见屋里的桌子/床/炉子；打中承重梁（角柱、顶梁）整栋立即倒塌；
//       燃烧弹命中后缓慢燃烧，最终烧塌。倒塌/开洞掉下来的每一块木板都变成**留在原地**的碎片，
//       不做淡出、不做删除（质量守恒）。
// 其它：草垛（可撞散）、木栅栏（可撞断）、麦田（冲击后倒伏）、稻草人、树、土路。
import * as THREE from 'three';
import { setupSun } from '../../../world/common.js?v=1572';

/* ================= 地形 ================= */
export const FARM_SIZE = 900;

// 基础起伏（解析函数：地形网格、坦克贴地、弹着点、弹坑都用它，保证三者完全一致）
/* 起伏分成两层：
   ① 大尺度缓波（振幅 ~1.2m）—— 只让地面"不平"，不致于把 300m 外的平射弹道全挡住；
   ② 局部土丘/洼地（5m 级）—— 真正的掩体，绕开就能打，躲后面就安全。
   早期版本把大尺度波也做到 3.4m，结果出生点对射的炮弹全打在中间土坡上（AI 一发不中）。 */
export function baseHeight(x, z) {
  return 1.15 * Math.sin(x * 0.0062) * Math.cos(z * 0.0051)
    + 0.85 * Math.sin((x + z) * 0.0034 + 1.7)
    + 0.42 * Math.sin(x * 0.017 - z * 0.013)
    + 5.2 * Math.exp(-(((x - 270) ** 2 + (z + 170) ** 2) / 70000))     // 东侧缓丘（掩体）
    - 3.4 * Math.exp(-(((x + 300) ** 2 + (z - 210) ** 2) / 64000))     // 西侧洼地
    + 2.4 * Math.exp(-(((x + 180) ** 2 + (z + 110) ** 2) / 26000))     // 西北土包
    + 1.7 * Math.exp(-(((x - 160) ** 2 + (z - 170) ** 2) / 24000));    // 东南土包
}

/* ================= 模块内状态 ================= */
let rootRef = null, collidersRef = null, dynamicRef = null;
let groundMesh = null;
const groundBase = null;
let wheat = null;                 // { im, items, geo, mat }
let debris = null;                // { im, items, active }
let fires = [];                   // { x,y,z,r,t,max,phase,g,kind }
let craters = [];                 // { x,z,r,d,mesh }
export const CRATERS = craters;
export const PROPS = [];          // 可破坏物
export const FIRES = fires;

let uid = 0;
const M = {
  wood: new THREE.MeshStandardMaterial({ color: 0x9a6a3c, roughness: 0.86, metalness: 0.02 }),
  woodDark: new THREE.MeshStandardMaterial({ color: 0x5c3d24, roughness: 0.9 }),
  woodPale: new THREE.MeshStandardMaterial({ color: 0xb98b57, roughness: 0.88 }),
  roof: new THREE.MeshStandardMaterial({ color: 0x6b4b33, roughness: 0.92 }),
  roofDark: new THREE.MeshStandardMaterial({ color: 0x4a3222, roughness: 0.95 }),
  hay: new THREE.MeshStandardMaterial({ color: 0xc9a951, roughness: 0.98 }),
  hayDark: new THREE.MeshStandardMaterial({ color: 0xa8873c, roughness: 0.98 }),
  stone: new THREE.MeshStandardMaterial({ color: 0x8d897d, roughness: 0.95 }),
  dirt: new THREE.MeshStandardMaterial({ color: 0x6b5334, roughness: 1.0 }),
  trunk: new THREE.MeshStandardMaterial({ color: 0x5a4630, roughness: 0.95 }),
  leaf: new THREE.MeshStandardMaterial({ color: 0x4e7a3f, roughness: 0.92 }),
  cloth: new THREE.MeshStandardMaterial({ color: 0x9c4b3a, roughness: 0.9 }),
  metal: new THREE.MeshStandardMaterial({ color: 0x5a5f63, roughness: 0.6, metalness: 0.4 }),
};

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
const ZERO_MAT = new THREE.Matrix4().makeScale(0, 0, 0);

/* ================= 弹坑：地形高度 ================= */
function craterDrop(x, z) {
  let dy = 0;
  for (let i = 0; i < craters.length; i++) {
    const c = craters[i];
    const dx = x - c.x, dz = z - c.z;
    const d2 = dx * dx + dz * dz;
    const rr = c.r;
    if (d2 > rr * rr * 1.5 * 1.5) continue;
    const d = Math.sqrt(d2);
    if (d <= rr) {
      const k = 1 - d / rr;
      dy -= c.d * Math.pow(k, 1.25);
    } else if (d <= rr * 1.42) {
      // 坑沿：挖出来的土堆在四周，不是平的
      const k = 1 - (d - rr) / (rr * 0.42);
      dy += c.d * 0.20 * k;
    }
  }
  return dy;
}

export function farmGroundY(x, z) {
  return baseHeight(x, z) + craterDrop(x, z);
}

/* ================= 小工具 ================= */
function addMesh(parent, mat, hx, hy, hz, x, y, z, rx, ry, rz) {
  const m = new THREE.Mesh(UNIT_BOX, mat);
  m.scale.set(hx * 2, hy * 2, hz * 2);
  m.position.set(x, y, z);
  if (rx || ry || rz) m.rotation.set(rx || 0, ry || 0, rz || 0);
  m.castShadow = true; m.receiveShadow = true;
  parent.add(m);
  return m;
}
function finishProp(prop) {
  let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9;
  for (const p of prop.parts) {
    if (p.dead) continue;
    minX = Math.min(minX, p.x - p.hx); maxX = Math.max(maxX, p.x + p.hx);
    minY = Math.min(minY, p.y - p.hy); maxY = Math.max(maxY, p.y + p.hy);
    minZ = Math.min(minZ, p.z - p.hz); maxZ = Math.max(maxZ, p.z + p.hz);
  }
  prop.bounds = { minX, minY, minZ, maxX, maxY, maxZ };
  return prop;
}
function part(prop, kind, mat, hx, hy, hz, x, y, z, rx, ry, rz, meshOverride) {
  const m = meshOverride || addMesh(prop.group, mat, hx, hy, hz, x, y, z, rx, ry, rz);
  const p = {
    prop, kind, mesh: m, dead: false,
    x: prop.x + x, y: prop.gy + y, z: prop.z + z,
    hx, hy, hz,
  };
  // 旋转过的屋面板：用旋转后的 AABB 近似（够做命中判定）
  if (rx) {
    const c = Math.abs(Math.cos(rx)), s = Math.abs(Math.sin(rx));
    const ny = hy * c + hz * s, nz = hy * s + hz * c;
    p.hy = ny; p.hz = nz;
  }
  prop.parts.push(p);
  return p;
}

/* ================= 碎片池（实例化：一块木板一个实例，全部留在原地） ================= */
function initDebris() {
  const cap = 2200;
  const im = new THREE.InstancedMesh(UNIT_BOX, new THREE.MeshStandardMaterial({ roughness: 0.92 }), cap);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.count = 0;
  im.castShadow = false; im.receiveShadow = true;
  im.frustumCulled = false;
  rootRef.add(im);
  debris = { im, cap, n: 0, items: [], active: [] };
  for (let i = 0; i < cap; i++) {
    im.setMatrixAt(i, ZERO_MAT);
    im.setColorAt(i, new THREE.Color(0x8a6a44));
  }
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
}

function spawnDebris(x, y, z, hx, hy, hz, color, vx, vy, vz, spin) {
  if (!debris || debris.n >= debris.cap) return;
  const i = debris.n++;
  const it = {
    i, x, y, z, hx, hy, hz,
    vx, vy, vz, rx: 0, ry: 0, rz: 0,
    wx: (Math.random() - 0.5) * (spin || 4), wy: (Math.random() - 0.5) * (spin || 4), wz: (Math.random() - 0.5) * (spin || 4),
    rest: false,
  };
  debris.items.push(it);
  debris.im.setColorAt(i, color instanceof THREE.Color ? color : new THREE.Color(color === undefined ? 0x8a6a44 : color));
  if (debris.im.instanceColor) debris.im.instanceColor.needsUpdate = true;
  writeDebris(it);
  debris.im.count = debris.n;
  if (!it.rest) debris.active.push(it);
  return it;
}
const _dq = new THREE.Quaternion();
const _de = new THREE.Euler();
function writeDebris(it) {
  _de.set(it.rx, it.ry, it.rz, 'YXZ');
  _dq.setFromEuler(_de);
  _v.set(it.x, it.y, it.z);
  _s.set(it.hx * 2, it.hy * 2, it.hz * 2);
  _m4.compose(_v, _dq, _s);
  debris.im.setMatrixAt(it.i, _m4);
}

/* ================= 火焰 ================= */
const FLAME_GEO = new THREE.ConeGeometry(1, 1, 7, 1, false);
const SMOKE_GEO = new THREE.SphereGeometry(1, 7, 5);
function addFire(x, y, z, radius, kind, life) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const flames = [];
  for (let i = 0; i < 3; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: i === 0 ? 0xffc247 : (i === 1 ? 0xff7a1e : 0xd8451a),
      transparent: true, opacity: 0.62, depthWrite: false, side: THREE.DoubleSide,
    });
    const f = new THREE.Mesh(FLAME_GEO, mat);
    const r = radius * (0.55 - i * 0.12);
    f.scale.set(r, radius * (1.2 + i * 0.5), r);
    f.position.set((Math.random() - 0.5) * radius * 0.7, radius * (0.55 + i * 0.45), (Math.random() - 0.5) * radius * 0.7);
    g.add(f); flames.push(f);
  }
  const smoke = new THREE.Mesh(SMOKE_GEO, new THREE.MeshBasicMaterial({
    color: 0x1d2124, transparent: true, opacity: 0.26, depthWrite: false,
  }));
  smoke.scale.setScalar(radius * 1.1);
  smoke.position.y = radius * 2.4;
  g.add(smoke);
  rootRef.add(g);
  const f = { x, y, z, r: radius, t: 0, max: life || 999, phase: Math.random() * 6.28, g, flames, smoke, kind: kind || 'ground', dead: false };
  fires.push(f);
  return f;
}
export function addFireAt(x, y, z, radius, kind, life) { return addFire(x, y, z, radius, kind, life); }

/* ================= 麦田 ================= */
function wheatGeometry() {
  // 两片交叉的竖直面（单位高 1、宽 1），实例按 (宽, 高) 缩放
  const pos = [], nor = [], idx = [];
  const quad = (ax, az, bx, bz, start) => {
    pos.push(ax, 0, az, bx, 0, bz, bx, 1, bz, ax, 1, az);
    const nx = (bz - az), nz = (ax - bx);
    const l = Math.hypot(nx, nz) || 1;
    for (let i = 0; i < 4; i++) nor.push(nx / l, 0, nz / l);
    idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
  };
  quad(-0.5, 0, 0.5, 0, 0);
  quad(0, -0.5, 0, 0.5, 4);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

function buildWheat(cx, cz, w, d, count) {
  const geo = wheatGeometry();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xd9b757, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
  });
  const im = new THREE.InstancedMesh(geo, mat, count);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.receiveShadow = true;
  const items = [];
  for (let i = 0; i < count; i++) {
    const fx = cx + (Math.random() - 0.5) * w;
    const fz = cz + (Math.random() - 0.5) * d;
    const y = farmGroundY(fx, fz);
    const h = 0.75 + Math.random() * 0.55;
    const rot = Math.random() * Math.PI;
    const sc = 0.35 + Math.random() * 0.35;
    const it = { x: fx, y, z: fz, rot, h, sc, flat: false };
    items.push(it);
    writeWheat(im, it, i);
    im.setColorAt(i, new THREE.Color().setHSL(0.11, 0.55, 0.44 + Math.random() * 0.12));
  }
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.frustumCulled = false;
  rootRef.add(im);
  wheat = { im, items, geo, mat };
}
function writeWheat(im, it, i) {
  _de.set(it.flat ? 1.35 : 0, it.rot, 0, 'YXZ');
  _dq.setFromEuler(_de);
  _v.set(it.x, it.y + (it.flat ? 0.03 : 0), it.z);
  _s.set(it.sc * (it.flat ? 1.5 : 1), it.flat ? 0.10 : it.h, it.sc);
  _m4.compose(_v, _dq, _s);
  im.setMatrixAt(i, _m4);
}
export function flattenWheatAt(x, z, r) {
  if (!wheat) return;
  const r2 = r * r;
  let dirty = false;
  for (let i = 0; i < wheat.items.length; i++) {
    const it = wheat.items[i];
    if (it.flat) continue;
    const dx = it.x - x, dz = it.z - z;
    if (dx * dx + dz * dz > r2) continue;
    it.flat = true;
    writeWheat(wheat.im, it, i);
    dirty = true;
  }
  if (dirty) wheat.im.instanceMatrix.needsUpdate = true;
}

/* ================= 木屋 ================= */
/* 25 座木屋（v3.22：用户要求"房子加到 25 间，全部集中在战斗区域附近，再加一点大谷仓"）。
   布局思路：
   · 出生点仍在 z=±330（相距 660m），开局不在直射距离内；
   · 所有房子落在 |z| ≤ 290、|x| ≤ 300 的中场村落里，推进到中线后处处有掩体，
     不会再出现"冲出去一片空地谁先看到谁赢"；
   · 5 座大谷仓（22×14 / 20×13 两座 / 18×13 两座）压在中轴与南北两端，切断对穿视线，
     也提供可绕、可穿、可烧塌的立体掩体；
   · 其余 20 座是 11~15m 的农舍/村屋，成对错位摆放，形成街巷而不是一堵墙。
   布局已避开 HAY_DEFS / FENCE_DEFS / SCARECROW_DEFS / 树石与出生点（见文件下方定义）。 */
const HOUSE_DEFS = [
  // ── 中央村落（核心交战区）──
  { x: 0, z: 0, w: 22, d: 14, h: 5.2, roof: 3.0, name: '中央大谷仓' },
  { x: -150, z: 55, w: 13, d: 10, h: 3.6, roof: 1.9, name: '西农舍' },
  { x: 150, z: 62, w: 13, d: 10, h: 3.6, roof: 1.9, name: '东农舍' },
  { x: -95, z: -68, w: 18, d: 13, h: 4.8, roof: 2.6, name: '西谷仓' },
  { x: 95, z: -72, w: 18, d: 13, h: 4.8, roof: 2.6, name: '东谷仓' },
  { x: -232, z: 0, w: 15, d: 11, h: 4.2, roof: 2.2, name: '西仓' },
  { x: 232, z: -4, w: 15, d: 11, h: 4.2, roof: 2.2, name: '东仓' },
  // ── 南半场（红队一侧的街巷）──
  { x: -58, z: 132, w: 12, d: 9, h: 3.4, roof: 1.8, name: '南村西屋' },
  { x: 62, z: 140, w: 12, d: 9, h: 3.4, roof: 1.8, name: '南村东屋' },
  { x: -182, z: 166, w: 11, d: 8, h: 3.2, roof: 1.7, name: '西南小屋' },
  { x: 180, z: 172, w: 11, d: 8, h: 3.2, roof: 1.7, name: '东南小屋' },
  { x: 0, z: 202, w: 20, d: 13, h: 5.0, roof: 2.8, name: '南大谷仓' },
  { x: -292, z: 122, w: 14, d: 10, h: 3.8, roof: 2.0, name: '西南仓' },
  { x: 292, z: 132, w: 14, d: 10, h: 3.8, roof: 2.0, name: '东南仓' },
  // ── 北半场（蓝队一侧的街巷）──
  { x: -56, z: -140, w: 12, d: 9, h: 3.4, roof: 1.8, name: '北村西屋' },
  { x: 60, z: -146, w: 12, d: 9, h: 3.4, roof: 1.8, name: '北村东屋' },
  { x: -186, z: -176, w: 11, d: 8, h: 3.2, roof: 1.7, name: '西北小屋' },
  { x: 186, z: -182, w: 11, d: 8, h: 3.2, roof: 1.7, name: '东北小屋' },
  { x: 0, z: -206, w: 20, d: 13, h: 5.0, roof: 2.8, name: '北大谷仓' },
  { x: -296, z: -126, w: 14, d: 10, h: 3.8, roof: 2.0, name: '西北仓' },
  { x: 296, z: -136, w: 14, d: 10, h: 3.8, roof: 2.0, name: '东北仓' },
  // ── 出生区前最后一道掩体（离出生点约 50m，别贴着坦克出生位）──
  { x: -150, z: 278, w: 18, d: 12, h: 4.6, roof: 2.5, name: '南侧谷仓' },
  { x: 160, z: 284, w: 15, d: 11, h: 4.2, roof: 2.2, name: '南侧农舍' },
  { x: -150, z: -278, w: 18, d: 12, h: 4.6, roof: 2.5, name: '北侧谷仓' },
  { x: 160, z: -284, w: 15, d: 11, h: 4.2, roof: 2.2, name: '北侧农舍' },
];

function buildHouse(def) {
  const gy = farmGroundY(def.x, def.z);
  const prop = {
    id: 'h' + (++uid), type: 'house', name: def.name,
    x: def.x, z: def.z, gy, w: def.w, d: def.d, h: def.h,
    hp: 520, maxHp: 520, dead: false, burning: 0, burnT: 0, fireT: 0,
    parts: [], group: new THREE.Group(), ramCd: 0, rad: Math.hypot(def.w, def.d) / 2,
    collider: null, brickIM: null, bricks: [], beams: [], roofParts: [], furniture: [],
  };
  const g = prop.group;
  g.position.set(def.x, gy, def.z);
  rootRef.add(g);
  PROPS.push(prop);

  const W = def.w, D = def.d, H = def.h;
  // 石砌地基（露出地面 0.3m）
  addMesh(g, M.stone, W / 2 + 0.25, 0.22, D / 2 + 0.25, 0, 0.18, 0, 0, 0, 0);

  /* ---- 木板墙（实例化）：4 面墙，按 1.1m 一段、0.34m 一层，错缝排列 ---- */
  const BW = 1.10, BH = 0.34, BT = 0.13;      // 板宽 / 板高 / 板厚
  const items = [];                            // { x,y,z, hx,hy,hz, rx,ry }
  const pushRow = (axis, fixed, from, to, y, gapFn) => {
    const rowOff = (Math.round(y / BH) % 2) * (BW * 0.5);
    for (let s = from + BW * 0.5 - rowOff; s < to; s += BW) {
      const x = axis === 'x' ? s : fixed;
      const z = axis === 'x' ? fixed : s;
      const lx = x, lz = z;
      if (gapFn && gapFn(lx, y, lz)) continue;
      // 段长夹到墙端，避免板子戳出墙角
      const half = Math.min(BW * 0.5, to - s, s - from) * 0.98;
      if (half < 0.14) continue;
      items.push({
        x: axis === 'x' ? s : fixed,
        z: axis === 'x' ? fixed : s,
        y,
        hx: axis === 'x' ? half : BT,
        hz: axis === 'x' ? BT : half,
        hy: BH * 0.5,
      });
    }
  };
  const rows = Math.floor((H - 0.3) / BH);
  for (let r = 0; r < rows; r++) {
    const y = 0.3 + BH * 0.5 + r * BH;
    // 前墙（z = -D/2）：门 + 两扇窗
    pushRow('x', -D / 2, -W / 2, W / 2, y, (x, yy) => {
      if (Math.abs(x) < 1.15 && yy < 2.35) return true;                       // 门
      if (Math.abs(Math.abs(x) - W * 0.31) < 0.85 && yy > 1.15 && yy < 2.30) return true;  // 窗
      return false;
    });
    // 后墙（z = +D/2）
    pushRow('x', D / 2, -W / 2, W / 2, y, (x, yy) => Math.abs(x + W * 0.22) < 1.0 && yy > 1.25 && yy < 2.35);
    // 左右墙
    pushRow('z', -W / 2, -D / 2, D / 2, y, (x, yy, z) => Math.abs(z) < 1.0 && yy > 1.2 && yy < 2.3);
    pushRow('z', W / 2, -D / 2, D / 2, y, (x, yy, z) => Math.abs(z - D * 0.18) < 1.0 && yy > 1.2 && yy < 2.3);
  }
  const im = new THREE.InstancedMesh(UNIT_BOX, new THREE.MeshStandardMaterial({ roughness: 0.88 }), items.length);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.castShadow = true; im.receiveShadow = true;
  im.frustumCulled = false;
  prop.brickIM = im; prop.bricks = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    _de.set(0, 0, 0);
    _dq.setFromEuler(_de);
    _v.set(it.x, it.y, it.z);
    _s.set(it.hx * 2, it.hy * 2, it.hz * 2);
    _m4.compose(_v, _dq, _s);
    im.setMatrixAt(i, _m4);
    const shade = 0.82 + ((i * 37) % 11) / 40;
    im.setColorAt(i, new THREE.Color(0x9a6a3c).multiplyScalar(shade));
    const p = {
      prop, kind: 'wall', inst: i, dead: false,
      x: prop.x + it.x, y: prop.gy + it.y, z: prop.z + it.z,
      hx: it.hx, hy: it.hy, hz: it.hz,
    };
    prop.bricks.push(p); prop.parts.push(p);
  }
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  g.add(im);

  /* ---- 承重梁：4 角柱 + 长墙中柱 + 顶圈梁。打中任何一根 = 整栋倒塌 ---- */
  const beam = (hx, hy, hz, x, y, z) => {
    const m = addMesh(g, M.woodDark, hx, hy, hz, x, y, z);
    const p = part(prop, 'beam', M.woodDark, hx, hy, hz, x, y, z, 0, 0, 0, m);
    prop.beams.push(p);
  };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    beam(0.28, H * 0.5, 0.28, sx * (W / 2 - 0.18), H * 0.5, sz * (D / 2 - 0.18));
  }
  beam(0.24, H * 0.5, 0.24, 0, H * 0.5, -D / 2 + 0.16);
  beam(0.24, H * 0.5, 0.24, 0, H * 0.5, D / 2 - 0.16);
  beam(W / 2 + 0.06, 0.16, 0.18, 0, H - 0.15, -D / 2 + 0.10);
  beam(W / 2 + 0.06, 0.16, 0.18, 0, H - 0.15, D / 2 - 0.10);
  beam(0.18, 0.16, D / 2 + 0.06, -W / 2 + 0.10, H - 0.15, 0);
  beam(0.18, 0.16, D / 2 + 0.06, W / 2 - 0.10, H - 0.15, 0);

  /* ---- 屋顶：双坡板 + 屋脊 + 山墙 ---- */
  const slope = Math.atan2(def.roof, D / 2);
  const slabLen = Math.hypot(def.roof, D / 2) + 0.35;
  for (const s of [-1, 1]) {
    const m = addMesh(g, M.roof, W / 2 + 0.55, 0.14, slabLen / 2, 0, H + def.roof * 0.5, s * D / 4, s * slope, 0, 0);
    const p = part(prop, 'roof', M.roof, W / 2 + 0.55, 0.14, slabLen / 2, 0, H + def.roof * 0.5, s * D / 4, s * slope, 0, 0, m);
    prop.roofParts.push(p);
  }
  addMesh(g, M.roofDark, W / 2 + 0.6, 0.10, 0.26, 0, H + def.roof + 0.05, 0);
  // 山墙：真正的三角形（矩形会从屋面两侧穿出去）
  const gableShape = new THREE.Shape();
  gableShape.moveTo(-W / 2 + 0.05, 0);
  gableShape.lineTo(W / 2 - 0.05, 0);
  gableShape.lineTo(0, def.roof);
  gableShape.closePath();
  const gableGeo = new THREE.ExtrudeGeometry(gableShape, { depth: 0.12, bevelEnabled: false });
  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(gableGeo, M.woodPale);
    m.position.set(0, H, s * (D / 2 - 0.10) - (s > 0 ? 0 : 0.12));
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    const p = part(prop, 'wall', M.woodPale, W / 2 - 0.05, def.roof * 0.5, 0.10,
      0, H + def.roof * 0.5, s * (D / 2 - 0.16), 0, 0, 0, m);
    p.gable = true;
  }
  // 门框
  addMesh(g, M.woodDark, 0.10, 1.2, 0.10, -1.15, 1.2, -D / 2 + 0.03);
  addMesh(g, M.woodDark, 0.10, 1.2, 0.10, 1.15, 1.2, -D / 2 + 0.03);
  addMesh(g, M.woodDark, 1.25, 0.10, 0.10, 0, 2.36, -D / 2 + 0.03);
  // 门扇（半开）
  const door = addMesh(g, M.woodPale, 0.52, 1.05, 0.05, -0.55, 1.15, -D / 2 + 0.30, 0, -0.5, 0);
  part(prop, 'furniture', M.woodPale, 0.52, 1.05, 0.05, -0.55, 1.15, -D / 2 + 0.30, 0, -0.5, 0, door);

  /* ---- 室内家具（洞后面能看见的东西） ---- */
  const furn = (hx, hy, hz, x, y, z, mat) => {
    const m = addMesh(g, mat || M.woodPale, hx, hy, hz, x, y, z);
    const p = part(prop, 'furniture', mat || M.woodPale, hx, hy, hz, x, y, z, 0, 0, 0, m);
    prop.furniture.push(p);
    return p;
  };
  // 长桌 + 两条长凳
  furn(1.5, 0.06, 0.55, -W * 0.18, 0.86, 0.2);
  furn(0.06, 0.42, 0.06, -W * 0.18 - 1.35, 0.42, 0.2);
  furn(0.06, 0.42, 0.06, -W * 0.18 + 1.35, 0.42, 0.2);
  furn(1.1, 0.05, 0.22, -W * 0.18, 0.46, 1.15);
  furn(1.1, 0.05, 0.22, -W * 0.18, 0.46, -0.75);
  // 床（靠后墙）
  furn(0.9, 0.22, 1.5, W * 0.24, 0.24, D * 0.18);
  furn(0.86, 0.10, 1.4, W * 0.24, 0.55, D * 0.18, M.cloth);
  furn(0.9, 0.55, 0.07, W * 0.24, 0.55, D * 0.18 - 1.48);
  // 壁炉 / 炉子
  furn(0.55, 0.75, 0.45, -W * 0.28, 0.75, D / 2 - 0.55, M.stone);
  furn(0.22, 0.9, 0.22, -W * 0.28, 1.85, D / 2 - 0.55, M.metal);
  // 架子 + 木箱
  furn(0.35, 1.0, 1.0, W / 2 - 0.55, 1.0, -D * 0.16);
  furn(0.42, 0.42, 0.42, -W / 2 + 0.8, 0.42, -D * 0.25);
  furn(0.42, 0.36, 0.42, W / 2 - 0.9, 0.36, D * 0.35);

  /* ---- 碰撞体（坦克撞不进去；倒塌后移除） ---- */
  prop.collider = { s: 1, x: def.x, z: def.z, hx: W / 2, hz: D / 2, h: gy + H + def.roof * 0.5, __prop: prop };
  // s=1 的语义是「从地心长到 c.h」——地面有高度，所以 h 用世界坐标（gy + 墙顶）
  collidersRef.push(prop.collider);
  // 压平房基下的麦子：25 座房子铺开后会压到东侧麦田，麦秆从屋内地板里长出来很难看
  flattenWheatAt(def.x, def.z, Math.hypot(W, D) * 0.55);
  return finishProp(prop);
}

/* ================= 草垛 ================= */
const HAY_DEFS = [
  { x: 60, z: 20 }, { x: -80, z: -45 }, { x: 235, z: 55 }, { x: -265, z: 155 },
  { x: 150, z: -155 }, { x: -335, z: -120 }, { x: 320, z: 220 }, { x: -225, z: 265 },
  { x: 20, z: -80 }, { x: -410, z: 40 },
  /* 出生区附近各放两个：一开局就有掩体可躲，不用裸奔 300m */
  { x: -205, z: 258 }, { x: 205, z: 262 }, { x: -45, z: -262 }, { x: 175, z: -250 },
];

/* 栅栏（定义集中在这里：buildFarm 与 resetFarm 共用，避免两处写法不一致） */
const FENCE_DEFS = [
  [250, -118, 190, true, { at: 20, w: 16 }],
  [250, 42, 190, true, { at: -55, w: 18 }],
  [152, -40, 140, false, { at: 35, w: 18 }],
  [348, -40, 140, false, { at: -30, w: 18 }],
  [-150, 120, 66, true, null],
  [-186, 95, 50, false, null],
  [175, 152, 58, true, { at: 0, w: 10 }],
  [-350, -60, 80, true, null],
  [430, 210, 70, false, null],
  [-100, 252, 72, true, { at: 0, w: 13 }],    // 南侧出生区前方
  [90, -248, 72, true, null],                 // 北侧出生区前方
];

const SCARECROW_DEFS = [[250, -40], [180, 30], [-150, 130], [-250, 210]];
function buildHay(def) {
  const gy = farmGroundY(def.x, def.z);
  const prop = {
    id: 'y' + (++uid), type: 'hay', x: def.x, z: def.z, gy,
    hp: 26, maxHp: 26, dead: false, burning: 0,
    parts: [], group: new THREE.Group(), ramCd: 0, rad: 2.6, collider: null,
  };
  const g = prop.group; g.position.set(def.x, gy, def.z); rootRef.add(g);
  PROPS.push(prop);
  // 7 个草捆堆成塔：3 底 + 2 中 + 1 顶 + 1 斜顶
  const bales = [
    [-1.45, 0.55, 0], [0, 0.55, 0], [1.45, 0.55, 0],
    [-0.72, 1.55, 0.05], [0.72, 1.55, 0.05],
    [0, 2.5, 0], [0, 3.15, 0.15, 0.5],
  ];
  for (const [bx, by, bz, rot] of bales) {
    const m = addMesh(g, by > 2 ? M.hayDark : M.hay, 0.82, 0.44, 0.58, bx, by, bz, 0, rot || 0, 0);
    part(prop, 'bale', M.hay, 0.82, 0.44, 0.58, bx, by, bz, 0, rot || 0, 0, m);
  }
  prop.collider = { s: 0, v: new THREE.Vector3(def.x, gy + 1.3, def.z), r: 2.35, __prop: prop };
  collidersRef.push(prop.collider);
  return finishProp(prop);
}

/* ================= 栅栏（轴对齐，便于碰撞与开洞） ================= */
function buildFence(x, z, len, alongX, gap) {
  const prop = {
    id: 'f' + (++uid), type: 'fence', x, z, gy: farmGroundY(x, z),
    hp: 34, maxHp: 34, dead: false, burning: 0,
    parts: [], group: new THREE.Group(), ramCd: 0,
    hx: alongX ? len / 2 : 0.14, hz: alongX ? 0.14 : len / 2, rad: len / 2,
    collider: null, alongX, len,
  };
  const g = prop.group; g.position.set(x, prop.gy, z); rootRef.add(g);
  PROPS.push(prop);
  // 立柱
  const nPost = Math.max(2, Math.round(len / 2.4) + 1);
  for (let i = 0; i < nPost; i++) {
    const t = -len / 2 + (len * i) / (nPost - 1);
    const lx = alongX ? t : 0, lz = alongX ? 0 : t;
    if (gap && Math.abs(t - gap.at) < gap.w / 2) continue;
    const m = addMesh(g, M.woodDark, 0.10, 0.72, 0.10, lx, 0.72, lz);
    part(prop, 'post', M.woodDark, 0.10, 0.72, 0.10, lx, 0.72, lz, 0, 0, 0, m);
  }
  // 三道横杆：有缺口就分成两段（横杆不能跨过门）
  const spans = [];
  if (gap) {
    const a = -len / 2, b = gap.at - gap.w / 2;
    const c = gap.at + gap.w / 2, d2 = len / 2;
    if (b - a > 0.3) spans.push([a, b]);
    if (d2 - c > 0.3) spans.push([c, d2]);
  } else spans.push([-len / 2, len / 2]);
  for (const hy of [0.42, 0.82, 1.22]) {
    for (const [a, b] of spans) {
      const mid = (a + b) / 2, half = (b - a) / 2;
      const m = addMesh(g, M.wood, alongX ? half : 0.055, 0.055, alongX ? 0.055 : half,
        alongX ? mid : 0, hy, alongX ? 0 : mid);
      part(prop, 'rail', M.wood, alongX ? half : 0.055, 0.055, alongX ? 0.055 : half,
        alongX ? mid : 0, hy, alongX ? 0 : mid, 0, 0, 0, m);
    }
  }
  prop.collider = {
    s: 2, x, z,
    hx: alongX ? len / 2 : 0.16, hz: alongX ? 0.16 : len / 2,
    y0: prop.gy - 0.6, y1: prop.gy + 1.5, __prop: prop,
  };
  collidersRef.push(prop.collider);
  return finishProp(prop);
}

/* ================= 稻草人 ================= */
function buildScarecrow(x, z) {
  const gy = farmGroundY(x, z);
  const prop = {
    id: 's' + (++uid), type: 'scarecrow', x, z, gy,
    hp: 16, maxHp: 16, dead: false, burning: 0,
    parts: [], group: new THREE.Group(), ramCd: 0, rad: 1.1, collider: null,
  };
  const g = prop.group; g.position.set(x, gy, z); rootRef.add(g);
  PROPS.push(prop);
  const add = (mat, hx, hy, hz, lx, ly, lz, rx, ry, rz) => {
    const m = addMesh(g, mat, hx, hy, hz, lx, ly, lz, rx, ry, rz);
    part(prop, 'stick', mat, hx, hy, hz, lx, ly, lz, rx, ry, rz, m);
  };
  add(M.woodDark, 0.07, 1.0, 0.07, 0, 1.0, 0);
  add(M.woodDark, 0.63, 0.065, 0.065, 0, 1.62, 0);
  add(M.cloth, 0.30, 0.42, 0.18, 0, 1.35, 0);
  add(M.hayDark, 0.20, 0.20, 0.20, 0, 1.92, 0);
  add(M.woodDark, 0.34, 0.035, 0.34, 0, 2.10, 0);
  add(M.hayDark, 0.18, 0.16, 0.18, 0, 2.20, 0);
  add(M.cloth, 0.10, 0.30, 0.10, -0.62, 1.58, 0, 0, 0, 0.4);
  add(M.cloth, 0.10, 0.30, 0.10, 0.62, 1.58, 0, 0, 0, -0.4);
  return finishProp(prop);
}

/* ================= 树 / 石头（静态掩体） ================= */
function buildTree(x, z, s) {
  const gy = farmGroundY(x, z);
  const g = new THREE.Group(); g.position.set(x, gy, z); rootRef.add(g);
  addMesh(g, M.trunk, 0.28 * s, 2.6 * s, 0.28 * s, 0, 2.6 * s, 0);
  for (const [ox, oy, oz, r] of [[0, 4.6, 0, 2.3], [-1.1, 4.0, 0.5, 1.5], [1.0, 4.1, -0.4, 1.55], [0.2, 5.6, 0.6, 1.4]]) {
    const c = new THREE.Mesh(new THREE.SphereGeometry(r * s, 9, 7), M.leaf);
    c.position.set(ox * s, oy * s, oz * s);
    c.castShadow = true; c.receiveShadow = true;
    g.add(c);
  }
  collidersRef.push({ s: 0, v: new THREE.Vector3(x, gy + 2.6 * s, z), r: 0.75 * s });
}
function buildRock(x, z, s) {
  const gy = farmGroundY(x, z);
  const m = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), M.stone);
  m.position.set(x, gy + s * 0.55, z);
  m.scale.y = 0.7;
  m.castShadow = true; m.receiveShadow = true;
  rootRef.add(m);
  collidersRef.push({ s: 0, v: new THREE.Vector3(x, gy + s * 0.5, z), r: s * 0.9 });
}

/* ================= 地形网格 ================= */
function buildGround() {
  const seg = 150;
  const geo = new THREE.PlaneGeometry(FARM_SIZE * 2, FARM_SIZE * 2, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const cGrass = new THREE.Color(0x6f8a4a);
  const cGrass2 = new THREE.Color(0x5b7a3d);
  const cDirt = new THREE.Color(0x8a6b42);
  const cDirt2 = new THREE.Color(0x74562f);
  const roadA = [[-760, -330], [-380, -190], [0, -30], [300, 130], [700, 330]];
  const roadB = [[-560, 430], [-190, 270], [150, 90], [470, -130]];
  const distSeg = (px, pz, ax, az, bx, bz) => {
    const vx = bx - ax, vz = bz - az;
    const l2 = vx * vx + vz * vz || 1;
    let t = ((px - ax) * vx + (pz - az) * vz) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
  };
  const distRoad = (x, z) => {
    let d = 1e9;
    for (let i = 0; i < roadA.length - 1; i++) d = Math.min(d, distSeg(x, z, roadA[i][0], roadA[i][1], roadA[i + 1][0], roadA[i + 1][1]));
    for (let i = 0; i < roadB.length - 1; i++) d = Math.min(d, distSeg(x, z, roadB[i][0], roadB[i][1], roadB[i + 1][0], roadB[i + 1][1]));
    return d;
  };
  const col = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, baseHeight(x, z));
    const n = Math.sin(x * 0.11) * Math.cos(z * 0.09) * 0.5 + 0.5;
    col.copy(cGrass).lerp(cGrass2, n);
    const dr = distRoad(x, z);
    if (dr < 24) {
      const k = Math.min(1, (24 - dr) / 9);
      col.lerp(dr < 12 ? cDirt2 : cDirt, k * 0.92);
    }
    // 麦田范围的土色
    if (Math.abs(x - 250) < 105 && Math.abs(z + 40) < 80) col.lerp(cDirt, 0.35);
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0 });
  groundMesh = new THREE.Mesh(geo, mat);
  groundMesh.receiveShadow = true;
  rootRef.add(groundMesh);
}

/* ================= 弹坑（真实下沉 + 四周堆土，不会消失） ================= */
export function addCrater(x, z, r, depth) {
  if (craters.length > 64) return null;
  const c = { x, z, r, d: depth };
  // 网格：中心 + 3 圈（坑底 → 坑壁 → 坑沿）
  const seg = 20;
  const rings = [0, 0.55, 1.0, 1.4];
  const pos = [], col = [], idx = [];
  const cd = new THREE.Color(0x3a2c1e), cr = new THREE.Color(0x6b5334);
  const yAt = (px, pz, k) => {
    const base = baseHeight(px, pz);
    let dy;
    if (k <= 0) dy = -depth;
    else if (k <= 0.55) dy = -depth * 0.86;
    else if (k <= 1.0) dy = -depth * 0.10;
    else dy = depth * 0.22;
    return base + dy + craterDrop(px, pz) + 0.02;
  };
  // 顶点
  for (let ri = 0; ri < rings.length; ri++) {
    const k = rings[ri];
    if (ri === 0) {
      pos.push(x, yAt(x, z, 0), z); col.push(cd.r, cd.g, cd.b);
      continue;
    }
    for (let si = 0; si <= seg; si++) {
      const a = (si / seg) * Math.PI * 2;
      const px = x + Math.cos(a) * r * k;
      const pz = z + Math.sin(a) * r * k;
      pos.push(px, yAt(px, pz, k), pz);
      const cc = ri === 1 ? cd : (ri === 2 ? cd.clone().lerp(cr, 0.55) : cr);
      col.push(cc.r, cc.g, cc.b);
    }
  }
  // 索引
  const baseOf = (ri) => (ri === 0 ? 0 : 1 + (ri - 1) * (seg + 1));
  for (let si = 0; si < seg; si++) idx.push(0, baseOf(1) + si, baseOf(1) + si + 1);
  for (let ri = 1; ri < rings.length - 1; ri++) {
    const a0 = baseOf(ri), b0 = baseOf(ri + 1);
    for (let si = 0; si < seg; si++) {
      idx.push(a0 + si, b0 + si, b0 + si + 1, a0 + si, b0 + si + 1, a0 + si + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 }));
  mesh.receiveShadow = true;
  rootRef.add(mesh);
  c.mesh = mesh;
  craters.push(c);
  flattenWheatAt(x, z, r * 1.6);
  return c;
}

/* ================= 破坏 ================= */
function detachPartToDebris(prop, p, point, force) {
  if (p.dead) return;
  p.dead = true;
  const mat = p.mesh ? p.mesh.material : null;
  let color = 0x9a6a3c;
  if (mat && mat.color) color = mat.color.clone();
  const dx = p.x - point.x, dy = p.y - point.y, dz = p.z - point.z;
  const l = Math.hypot(dx, dz) || 1;
  const k = force === undefined ? 1 : force;
  spawnDebris(
    p.x, p.y, p.z, p.hx, p.hy, p.hz, color,
    (dx / l) * (2.4 + Math.random() * 3) * k,
    1.2 + Math.random() * 3.2 * k,
    (dz / l) * (2.4 + Math.random() * 3) * k,
    6,
  );
  if (p.inst !== undefined && prop.brickIM) {
    prop.brickIM.setMatrixAt(p.inst, ZERO_MAT);
    prop.brickIM.instanceMatrix.needsUpdate = true;
  } else if (p.mesh) {
    p.mesh.visible = false;
  }
}

function removeCollider(prop) {
  if (!prop.collider || !collidersRef) return;
  const i = collidersRef.indexOf(prop.collider);
  if (i >= 0) collidersRef.splice(i, 1);
  prop.collider = null;
}

export function breakProp(prop, point, force) {
  if (!prop || prop.dead) return;
  prop.dead = true;
  removeCollider(prop);
  const pt = point || new THREE.Vector3(prop.x, prop.gy + 1, prop.z);
  for (const p of prop.parts) if (!p.dead) detachPartToDebris(prop, p, pt, force);
  // 草垛/栅栏倒下时扬尘
  const dust = new THREE.Mesh(new THREE.SphereGeometry(1.6, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xc9b98a, transparent: true, opacity: 0.32, depthWrite: false }));
  dust.position.set(pt.x, prop.gy + 1.2, pt.z);
  rootRef.add(dust);
  dust.userData.t = 0;
  dust.userData.fade = dust;
  // 简单淡出（这是"尘土"，不是物体本体）
  const fade = () => {
    dust.userData.t += 0.05;
    dust.scale.setScalar(1 + dust.userData.t * 2.2);
    dust.material.opacity = Math.max(0, 0.32 - dust.userData.t * 0.16);
    if (dust.material.opacity > 0) requestAnimationFrame(fade); else rootRef.remove(dust);
  };
  requestAnimationFrame(fade);
  return true;
}

/* 瓦砾堆：房子塌了以后留下的实体堆。
   ★ 旧版 removeCollider() 把碰撞体删干净 —— 残骸对坦克和炮弹都完全透明，
     用户反馈"房屋残骸不能挡炮，是虚的"。现在保留一个实心盒：
       · collider  → 坦克/AI 撞不进去（撞不动）
       · rubblePart → 炮弹打上去就停（raycastProp 会检测它）
   ★ v3.22.1：堆高从 ~1.1m 提到 ~2.9m。旧版碰撞盒只有 1.2m 高，而坦克炮口在 2.74m，
     AP 弹平射时整条弹道都在废墟顶上飞过 —— 玩家看到的是"炮弹直接从残骸里穿过去"。
     现在视觉两层碎石 + 斜梁堆到 2.7m 左右，碰撞盒与视觉同高（顶 2.9m），
     平射会实打实被挡下来；弹道特别高时仍能从顶上越过。 */
const RUBBLE_GEO = new THREE.IcosahedronGeometry(1, 1);
function makeRubble(prop) {
  const gy = prop.gy;
  const hx = prop.w * 0.47, hz = prop.d * 0.47;
  /* 残骸高度跟着原房高走：一层农舍 3.2m → 堆高 3.2m，大谷仓 5.2m → 4.4m。
     下限 1.6（半高）保证比坦克炮口（2.74m）高 —— 平射一定打在废墟上，不会从顶上飘过去。 */
  const hy = Math.max(1.6, prop.h * 0.42);
  // 视觉：压扁的土石堆（两层）+ 几块翘出来的木板
  const g = new THREE.Group();
  const rubMat = M.rubble || (M.rubble = new THREE.MeshStandardMaterial({ color: 0x6b5a44, roughness: 0.96, metalness: 0.04, flatShading: true }));
  const core = new THREE.Mesh(RUBBLE_GEO, rubMat);
  core.scale.set(hx * 1.02, hy * 0.80, hz * 1.02);
  core.position.set(0, hy * 0.80, 0);
  core.castShadow = true; core.receiveShadow = true;
  g.add(core);
  // 上层塌落的墙体/屋架堆（偏一点，看起来是塌下来压上去的）
  const top = new THREE.Mesh(RUBBLE_GEO, rubMat);
  top.scale.set(hx * 0.66, hy * 0.50, hz * 0.66);
  top.position.set(hx * 0.16, hy * 1.40, -hz * 0.12);
  top.rotation.y = 0.7;
  top.castShadow = true; top.receiveShadow = true;
  g.add(top);
  // 堆里露出来的梁/板（几块斜插的木头，最高伸到接近堆顶）
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.4;
    const m = new THREE.Mesh(UNIT_BOX, M.woodDark);
    m.scale.set(0.16, 0.16, 1.4 + Math.random() * 1.6);
    m.position.set(Math.cos(a) * hx * 0.58, hy * 0.8 + Math.random() * hy * 0.95, Math.sin(a) * hz * 0.58);
    m.rotation.set((Math.random() - 0.5) * 0.9, a, (Math.random() - 0.5) * 0.9);
    m.castShadow = true;
    g.add(m);
  }
  g.position.set(prop.x, gy, prop.z);
  rootRef.add(g);

  prop.rubbleG = g;
  prop.rubblePart = {
    prop, kind: 'rubble', dead: false, isRubble: true,
    x: prop.x, y: gy + hy, z: prop.z, hx, hy, hz,
  };
  prop.rubble = { s: 1, x: prop.x, z: prop.z, hx: prop.w / 2, hz: prop.d / 2, h: gy + hy * 2, __prop: prop };
  collidersRef.push(prop.rubble);
  prop.collider = prop.rubble;      // 让 removeCollider 在回合重置时能清掉
}

export function collapseHouse(prop, point) {
  if (!prop || prop.dead) return;
  prop.dead = true;
  removeCollider(prop);
  const pt = point || new THREE.Vector3(prop.x, prop.gy + 2, prop.z);
  // 所有木板、梁、屋顶全部变成碎片（质量守恒：一块不少）
  for (const p of prop.parts) if (!p.dead) detachPartToDebris(prop, p, pt, 1.35);
  // 家具留在原地（可能被埋住），只把它上面的小件打翻
  for (const p of prop.furniture) {
    if (p.mesh && p.mesh.visible) {
      p.mesh.rotation.z += (Math.random() - 0.5) * 0.5;
      p.mesh.rotation.x += (Math.random() - 0.5) * 0.5;
    }
  }
  // 扬尘
  for (let i = 0; i < 3; i++) {
    const dust = new THREE.Mesh(new THREE.SphereGeometry(2.2 + i, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xb9a888, transparent: true, opacity: 0.3, depthWrite: false }));
    dust.position.set(prop.x + (Math.random() - 0.5) * prop.w * 0.6, prop.gy + 1 + i * 1.2, prop.z + (Math.random() - 0.5) * prop.d * 0.6);
    rootRef.add(dust);
    let t = 0;
    const fade = () => {
      t += 0.05;
      dust.scale.setScalar(1 + t * 2.6);
      dust.material.opacity = Math.max(0, 0.3 - t * 0.14);
      if (dust.material.opacity > 0) requestAnimationFrame(fade); else rootRef.remove(dust);
    };
    requestAnimationFrame(fade);
  }
  makeRubble(prop);
}

/* 命中点是否落在某根承重梁附近（含 0.4m 容差）。
   双管左右各 0.27m，纯靠 AABB 去"正中 0.5m 的柱子"几乎打不中；
   这里给一点宽容度，让"打中承重梁 → 倒塌"是玩家真能做到的事。 */
export function nearBeam(prop, pt) {
  for (let i = 0; i < prop.beams.length; i++) {
    const b = prop.beams[i];
    if (Math.abs(pt.x - b.x) > b.hx + 0.40) continue;
    if (Math.abs(pt.z - b.z) > b.hz + 0.40) continue;
    if (pt.y < b.y - b.hy - 0.35 || pt.y > b.y + b.hy + 0.35) continue;
    return b;
  }
  return null;
}

/* 穿甲弹开洞：把命中点附近的木板取下来（不是整面墙消失），并露出里面的家具 */
export function carveHole(prop, point, radius) {
  if (!prop || prop.dead || prop.type !== 'house') return 0;
  const R = radius || 1.7;
  let n = 0;
  for (const p of prop.bricks) {
    if (p.dead) continue;
    const dx = p.x - point.x, dy = p.y - point.y, dz = p.z - point.z;
    if (dx * dx + dy * dy * 1.4 + dz * dz > R * R) continue;
    detachPartToDebris(prop, p, point, 0.9);
    n++;
  }
  // 洞周围的家具也可能被打坏
  for (const p of prop.furniture) {
    if (p.dead) continue;
    const dx = p.x - point.x, dy = p.y - point.y, dz = p.z - point.z;
    if (dx * dx + dy * dy + dz * dz > (R * 0.9) ** 2) continue;
    detachPartToDebris(prop, p, point, 0.6);
    n++;
  }
  prop.hp -= n ? 30 : 6;
  if (prop.hp <= 0) collapseHouse(prop, point);
  return n;
}

export function igniteProp(prop, point) {
  if (!prop || prop.dead) return;
  if (prop.type === 'house') {
    if (prop.burning > 0) return;
    prop.burning = 1;
    prop.burnT = 0;
    prop.fireT = 0;
    addFire(point.x, point.y + 0.2, point.z, 1.5, 'house', 999);
    return;
  }
  // 栅栏 / 草垛 / 稻草人：直接点着，烧几秒后烧毁
  if (prop.burning > 0) return;
  prop.burning = 1;
  prop.burnT = 0;
  addFire(point.x, Math.max(point.y, prop.gy + 0.6), point.z, prop.type === 'hay' ? 2.2 : 1.1, prop.type, 999);
}

/* 命中检测：线段 vs 所有可破坏物的 AABB；返回最近的一个 */
export function raycastProp(p0, p1) {
  let best = null;
  for (let i = 0; i < PROPS.length; i++) {
    const prop = PROPS[i];
    if (prop.dead) {
      /* 倒塌的房子：只测瓦砾堆（低矮实心盒）。草垛/栅栏碎了就真的没了。 */
      const rb = prop.rubblePart;
      if (!rb) continue;
      const t0 = segBox(p0, p1, rb, 0.09);
      if (t0 < 0) continue;
      if (!best || t0 < best.t) best = { prop, part: rb, t: t0, point: new THREE.Vector3().lerpVectors(p0, p1, t0) };
      continue;
    }
    const b = prop.bounds;
    if (b) {
      const sx0 = Math.min(p0.x, p1.x), sx1 = Math.max(p0.x, p1.x);
      const sy0 = Math.min(p0.y, p1.y), sy1 = Math.max(p0.y, p1.y);
      const sz0 = Math.min(p0.z, p1.z), sz1 = Math.max(p0.z, p1.z);
      if (sx1 < b.minX - 0.3 || sx0 > b.maxX + 0.3) continue;
      if (sy1 < b.minY - 0.3 || sy0 > b.maxY + 0.3) continue;
      if (sz1 < b.minZ - 0.3 || sz0 > b.maxZ + 0.3) continue;
    } else {
      const cx = (p0.x + p1.x) / 2 - prop.x, cz = (p0.z + p1.z) / 2 - prop.z;
      const span = Math.hypot(p1.x - p0.x, p1.z - p0.z) / 2 + prop.rad + 4;
      if (cx * cx + cz * cz > span * span) continue;
    }
    for (let k = 0; k < prop.parts.length; k++) {
      const q = prop.parts[k];
      if (q.dead) continue;
      // 给炮弹一点"弹径"（0.09m）：擦着墙角/梁边飞过也算命中，
      // 否则双管左右各 0.27m 的偏移会让"瞄准梁中心"从梁边上滑过去。
      const t = segBox(p0, p1, q, 0.09);
      if (t < 0) continue;
      if (!best || t < best.t) best = { prop, part: q, t, point: new THREE.Vector3().lerpVectors(p0, p1, t) };
    }
  }
  return best;
}

function segBox(p0, p1, b, pad) {
  const P = pad || 0;
  const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
  let tmin = 0, tmax = 1;
  const axes = [
    [p0.x, dx, b.x - b.hx - P, b.x + b.hx + P],
    [p0.y, dy, b.y - b.hy - P, b.y + b.hy + P],
    [p0.z, dz, b.z - b.hz - P, b.z + b.hz + P],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return -1;
    } else {
      let a = (lo - o) / d, c = (hi - o) / d;
      if (a > c) { const t = a; a = c; c = t; }
      if (a > tmin) tmin = a;
      if (c < tmax) tmax = c;
      if (tmin > tmax) return -1;
    }
  }
  return tmin;
}

/* 坦克撞击：返回撞到的可破坏物（房子只掉血、栅栏草垛直接撞碎） */
export function ramProps(pos, speed, dt) {
  if (!PROPS.length) return null;
  const sp = Math.abs(speed);
  if (sp < 2.0) return null;
  for (let i = 0; i < PROPS.length; i++) {
    const prop = PROPS[i];
    if (prop.dead) continue;   // 塌掉以后是瓦砾堆：由 collider 硬挡，不再触发撞击破坏
    if (prop.ramCd > 0) { prop.ramCd -= dt; continue; }
    const ex = prop.type === 'house' ? prop.w / 2 : (prop.hx || 2.2);
    const ez = prop.type === 'house' ? prop.d / 2 : (prop.hz || 2.2);
    const dx = Math.max(0, Math.abs(pos.x - prop.x) - ex);
    const dz = Math.max(0, Math.abs(pos.z - prop.z) - ez);
    const dist = Math.hypot(dx, dz);
    const reach = prop.type === 'house' ? 3.8 : 3.2;
    if (dist > reach) continue;
    if (prop.type === 'house') {
      if (sp < 5.5) continue;
      prop.ramCd = 1.0;
      prop.hp -= 24;
      effectsDust(prop, pos);
      if (prop.hp <= 0) collapseHouse(prop, new THREE.Vector3(pos.x, prop.gy + 1.5, pos.z));
      return { prop, kind: 'house', hard: true };
    }
    breakProp(prop, new THREE.Vector3(pos.x, prop.gy + 1, pos.z), 1.1);
    return { prop, kind: prop.type, hard: false };
  }
  return null;
}
function effectsDust(prop, pos) {
  const dust = new THREE.Mesh(new THREE.SphereGeometry(1.1, 7, 5),
    new THREE.MeshBasicMaterial({ color: 0xbfae8e, transparent: true, opacity: 0.26, depthWrite: false }));
  dust.position.set(pos.x, prop.gy + 1.4, pos.z);
  rootRef.add(dust);
  let t = 0;
  const fade = () => {
    t += 0.05; dust.scale.setScalar(1 + t * 2); dust.material.opacity = Math.max(0, 0.26 - t * 0.14);
    if (dust.material.opacity > 0) requestAnimationFrame(fade); else rootRef.remove(dust);
  };
  requestAnimationFrame(fade);
}

export function debrisCount() { return debris ? debris.n : 0; }

/* ================= 每帧：碎片物理 / 火焰 / 燃烧蔓延 ================= */
let farmT = 0;
export function tickFarm(dt) {
  farmT += dt;
  // 碎片
  if (debris && debris.active.length) {
    const act = debris.active;
    let w = 0;
    for (let i = 0; i < act.length; i++) {
      const it = act[i];
      if (it.rest) continue;
      it.vy -= 9.8 * dt;
      it.x += it.vx * dt; it.y += it.vy * dt; it.z += it.vz * dt;
      it.rx += it.wx * dt; it.ry += it.wy * dt; it.rz += it.wz * dt;
      const gy = farmGroundY(it.x, it.z) + it.hy * 0.7;
      if (it.y <= gy) {
        it.y = gy;
        if (Math.abs(it.vy) > 2.2) {
          it.vy = -it.vy * 0.24;
          it.vx *= 0.62; it.vz *= 0.62;
          it.wx *= 0.5; it.wy *= 0.5; it.wz *= 0.5;
        } else {
          it.vy = 0;
          it.vx *= 1 - Math.min(1, dt * 5);
          it.vz *= 1 - Math.min(1, dt * 5);
          it.wx *= 0.9; it.wy *= 0.9; it.wz *= 0.9;
          if (Math.hypot(it.vx, it.vz) < 0.35) { it.rest = true; }
        }
      }
      writeDebris(it);
      if (!it.rest) act[w++] = it;
    }
    act.length = w;
    debris.im.instanceMatrix.needsUpdate = true;
  }

  // 火焰跳动
  for (let i = fires.length - 1; i >= 0; i--) {
    const f = fires[i];
    if (f.dead) { fires.splice(i, 1); continue; }
    f.t += dt;
    const s = 0.84 + 0.22 * Math.sin(farmT * 7.3 + f.phase);
    for (let k = 0; k < f.flames.length; k++) {
      const fl = f.flames[k];
      fl.scale.y = f.r * (1.15 + k * 0.5) * (0.8 + 0.35 * s);
      fl.material.opacity = 0.46 + 0.18 * s;
    }
    if (f.smoke) {
      f.smoke.position.y += dt * (1.6 + f.r * 0.4);
      f.smoke.material.opacity = 0.16 + 0.08 * Math.sin(farmT * 1.6 + f.phase);
      if (f.smoke.position.y > f.r * 8) f.smoke.position.y = f.r * 2.2;
    }
    if (f.max < 900 && f.t > f.max) {
      if (f.g.parent) f.g.parent.remove(f.g);
      f.dead = true;
      fires.splice(i, 1);
    }
  }

  // 燃烧蔓延：木屋烧 26 秒后塌；草垛 9 秒烧光；栅栏 6 秒
  for (let i = 0; i < PROPS.length; i++) {
    const p = PROPS[i];
    if (p.burning <= 0 || p.dead) continue;
    p.burnT += dt;
    if (p.type === 'house') {
      p.fireT -= dt;
      if (p.fireT <= 0) {
        p.fireT = 2.4;
        const a = Math.random() * Math.PI * 2;
        addFire(p.x + Math.cos(a) * p.w * 0.32, p.gy + p.h * 0.5, p.z + Math.sin(a) * p.d * 0.32, 1.3 + Math.random() * 0.9, 'house', 999);
      }
      // 越烧越黑（每 0.8 秒刷一次实例色）
      if (!p.__lastChar || p.burnT - p.__lastChar > 0.8) {
        p.__lastChar = p.burnT;
        const k = Math.max(0.18, 1 - p.burnT / 30);
        for (const b of p.bricks) if (!b.dead) p.brickIM.setColorAt(b.inst, new THREE.Color(0x9a6a3c).multiplyScalar(k * 0.55));
        if (p.brickIM.instanceColor) p.brickIM.instanceColor.needsUpdate = true;
      }
      if (p.burnT > 26) collapseHouse(p, new THREE.Vector3(p.x, p.gy + 1.5, p.z));
    } else if (p.burnT > (p.type === 'hay' ? 9 : 6)) {
      breakProp(p, new THREE.Vector3(p.x, p.gy + 1, p.z), 0.5);
    }
  }
}

/* ================= 构建 ================= */
function buildFarm(root, colliders, dynamic, sunDir, quality) {
  rootRef = root; collidersRef = colliders; dynamicRef = dynamic;
  /* ★ 只能清空内容，不能重新赋值：FIRES / CRATERS 是对外导出的常量引用，
     一旦 `fires = []` 换个新数组，模式层手里的还是旧数组 —— 受热判定永远看不到火焰。 */
  fires.length = 0; craters.length = 0;
  PROPS.length = 0; uid = 0; wheat = null; debris = null; farmT = 0;

  root.add(new THREE.HemisphereLight(0xdfeaff, 0x55663f, 0.95));
  root.add(setupSun(sunDir, {
    color: 0xfff2d8, intensity: 2.15, dist: 1200,
    shadows: quality && quality.shadows, mapSize: quality ? quality.shadowSize : 0, half: 700,
  }));

  buildGround();
  initDebris();

  // 麦田
  buildWheat(250, -40, 200, 150, 1900);

  // 木屋 / 草垛 / 栅栏 / 稻草人
  for (const def of HOUSE_DEFS) buildHouse(def);
  for (const def of HAY_DEFS) buildHay(def);
  for (const sc of SCARECROW_DEFS) buildScarecrow(sc[0], sc[1]);

  for (const f of FENCE_DEFS) buildFence(f[0], f[1], f[2], f[3], f[4]);

  // 树与石头（静态掩体）
  const trees = [
    [-420, 120, 1.0], [-470, 190, 1.2], [400, 380, 1.1], [360, -300, 1.0], [-260, -330, 1.15],
    [120, -350, 0.95], [520, 40, 1.1], [-100, 350, 1.0], [280, 320, 1.05], [-520, -260, 1.2],
    [90, 400, 1.0], [560, -240, 1.15], [-40, 430, 0.95], [-360, 340, 1.1],
    [-255, 292, 1.1], [262, 296, 1.05], [-240, -296, 1.1], [238, -286, 1.0],
  ];
  for (const [x, z, s] of trees) buildTree(x, z, s);
  const rocks = [[-60, 150, 2.2], [300, -180, 1.8], [-320, -40, 2.0], [180, -260, 1.6], [470, 120, 2.4], [-200, 400, 1.7]];
  for (const [x, z, s] of rocks) buildRock(x, z, s);

  // 远处的风车（地标，不参与碰撞）
  buildWindmill(root, -560, -60);
}

function buildWindmill(root, x, z) {
  const gy = baseHeight(x, z);
  const g = new THREE.Group(); g.position.set(x, gy, z); root.add(g);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 3.4, 18, 10), M.woodPale);
  tower.position.y = 9; tower.castShadow = true; g.add(tower);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(3.0, 3.0, 10), M.roofDark);
  cap.position.y = 19.4; g.add(cap);
  const hub = new THREE.Group(); hub.position.set(0, 17.0, -3.0); g.add(hub);
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(1.2, 8.0, 0.14), M.woodPale);
    blade.position.y = 4.0;
    const arm = new THREE.Group();
    arm.rotation.z = (i * Math.PI) / 2;
    arm.add(blade);
    hub.add(arm);
  }
  // 缓慢转（不依赖每帧钩子：用 CSS 那套不行，直接写进 world.update 以外的动画会打架 —— 用固定角度即可）
  hub.rotation.z = 0.6;
}

/* ================= 导出 ================= */
export const MAP = {
  id: 'farm',
  name: '乡村',
  desc: '麦田 · 农舍 · 起伏丘陵',
  sky: { top: 0x2a6cb8, horizon: 0xdfe9dc, elevation: 42, azimuth: 205 },
  background: 0xa9c6dc,
  fog: [0xd7e2d6, 820, 2400],
  bounds: { warn: 820, hurt: 900, ceiling: 520 },
  /* 两队各 5 个出生点（坦克对决双方都是地面载具）。
     南侧红队 z≈+330，北侧蓝队 z≈-330，相距 660m —— 开局不在直射距离内，
     中间隔着一座中央谷仓，必须推进/绕行才会交火（v3.21.1 用户反馈"一上来就短兵相接"）。 */
  aaSpawns: [
    { x: -140, z: 330, team: 0 }, { x: -70, z: 345, team: 0 }, { x: 0, z: 330, team: 0 },
    { x: 70, z: 345, team: 0 }, { x: 140, z: 330, team: 0 },
    { x: -140, z: -330, team: 1 }, { x: -70, z: -345, team: 1 }, { x: 0, z: -330, team: 1 },
    { x: 70, z: -345, team: 1 }, { x: 140, z: -330, team: 1 },
  ],
  groundY: farmGroundY,
  build(root, colliders, dynamic, ctx) {
    buildFarm(root, colliders, dynamic, ctx.sunDir, ctx.quality);
  },
};

/* 模式层直接调用：重建全部可破坏物（回合开始） */
export function resetFarm() {
  if (!rootRef || !rootRef.parent) return;   // 世界已销毁/已换图：不要往废弃的 root 里重建
  // 清碎片
  if (debris) {
    for (let i = 0; i < debris.cap; i++) debris.im.setMatrixAt(i, ZERO_MAT);
    debris.im.count = 0;
    debris.im.instanceMatrix.needsUpdate = true;
    debris.n = 0; debris.items.length = 0; debris.active.length = 0;
  }
  // 清火焰
  for (const f of fires) if (f.g && f.g.parent) f.g.parent.remove(f.g);
  fires.length = 0;
  // 清弹坑
  for (const c of craters) if (c.mesh && c.mesh.parent) c.mesh.parent.remove(c.mesh);
  craters.length = 0;
  // 清可破坏物（保留静态树/石头/地形）
  for (const p of PROPS) {
    if (p.group && p.group.parent) p.group.parent.remove(p.group);
    if (p.rubbleG && p.rubbleG.parent) p.rubbleG.parent.remove(p.rubbleG);
    removeCollider(p);
  }
  PROPS.length = 0;
  // 麦田恢复
  if (wheat) {
    for (let i = 0; i < wheat.items.length; i++) {
      const it = wheat.items[i];
      it.flat = false;
      writeWheat(wheat.im, it, i);
    }
    wheat.im.instanceMatrix.needsUpdate = true;
  }
  // 重建：id 从 0 重新计数 —— 联机两端只有 id 一致，propHit/ignite/collapse 才不会打错房子
  uid = 0;
  for (const def of HOUSE_DEFS) buildHouse(def);
  for (const def of HAY_DEFS) buildHay(def);
  for (const sc of SCARECROW_DEFS) buildScarecrow(sc[0], sc[1]);
  for (const f of FENCE_DEFS) buildFence(f[0], f[1], f[2], f[3], f[4]);
}
