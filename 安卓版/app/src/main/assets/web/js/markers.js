// js/markers.js — IFF 敌我标记（DOM 投影）+ 最近敌人血条（v3.4.1 从 main.js 抽出）
// 机体上方的敌红/友蓝菱形标记：屏幕内跟随机体、屏幕外吸附到屏幕边缘；同时统计最近敌人血量驱动顶部血条。
import * as THREE from 'three';
import { planes, aaguns, markerPool, myTeam, mode, meIsAAGun, myAAGun, myPlane } from './state.js?v=1516';
import { MAX_MARKERS, AAGUN_HP } from './config.js?v=1516';
import { camera } from './core.js?v=1516';
import { foeHpFill, nameOfPlayer } from './hud.js?v=1516';
import { spec, specTargetObj } from './spectate.js?v=1516';

/* ================= IFF 标记池（DOM投影，敌红/友蓝菱形） ================= */
const markersContainer = document.getElementById('markers');
for (let i = 0; i < MAX_MARKERS; i++) {
  const el = document.createElement('div');
  el.className = 'planeMarker';
  el.innerHTML = '<div class="mname"></div><div class="diamond"></div><div class="distance">0 m</div>';
  el.style.opacity = '0';
  markersContainer.appendChild(el);
  markerPool.push({ el, dist: el.querySelector('.distance'), mname: el.querySelector('.mname'), used: false });
}

/* ================= 敌我标记池（DOM投影，复用foeMarker逻辑） ================= */
const _v4 = new THREE.Vector4();
function projectToScreen(pos3) {
  _v4.set(pos3.x, pos3.y, pos3.z, 1).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
  const w = _v4.w || 1;
  return { x: (_v4.x / w * 0.5 + 0.5) * window.innerWidth, y: (-_v4.y / w * 0.5 + 0.5) * window.innerHeight, z: _v4.z / w, w };
}
// 单个实体的标记定位（屏幕内跟随 / 屏幕外吸附边缘），planes 与 aaguns 共用
function placeMarker(m, sx) {
  let x = sx.x, y = sx.y;
  let onScreen = sx.w > 0 && sx.z > -1 && sx.z < 1 && x >= -window.innerWidth * 0.2 && x <= window.innerWidth * 1.2 && y >= -window.innerHeight * 0.2 && y <= window.innerHeight * 1.2;
  if (sx.w > 0 && (sx.z < -1 || sx.z > 1)) onScreen = false;
  if (!onScreen) {
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    let dx = sx.x - cx, dy = sx.y - cy;
    if (sx.w <= 0) { dx = -dx; dy = -dy; }
    const ang = Math.atan2(dy, dx);
    const rx = window.innerWidth / 2 - 50, ry = window.innerHeight / 2 - 50;
    const scl = Math.min(rx / Math.abs(Math.cos(ang) || 1e-6), ry / Math.abs(Math.sin(ang) || 1e-6));
    x = cx + Math.cos(ang) * scl; y = cy + Math.sin(ang) * scl;
  }
  m.el.style.left = x + 'px'; m.el.style.top = y + 'px';
  m.el.style.opacity = '0.95';
}
export function updateMarkers() {
  let idx = 0;
  let nearestFoeDist = Infinity, nearestFoeHp = 0, nearestFoeMax = 100;
  let myPos = meIsAAGun ? myAAGun.group.position : (myPlane ? myPlane.group.position : null);
  if (spec.active) { const st = specTargetObj(); if (st) myPos = st.position; }   // 观战时距离基准=跟随目标
  if (myPos) {
    for (const id in planes) {
      const pl = planes[id];
      if (!pl.alive) continue;
      if (idx >= MAX_MARKERS) break;
      const m = markerPool[idx++];
      m.used = true;
      const isFoe = pl.team !== myTeam;
      m.el.className = 'planeMarker ' + (isFoe ? 'foe' : 'ally');
      m.mname.textContent = mode === 'practice' ? '' : nameOfPlayer(id);   // 头顶姓名（人机模式不显示）
      placeMarker(m, projectToScreen(pl.plane.group.position));
      const dist = myPos.distanceTo(pl.plane.group.position);
      m.dist.textContent = Math.round(dist) + ' m';
      if (isFoe && dist < nearestFoeDist) { nearestFoeDist = dist; nearestFoeHp = pl.hp; nearestFoeMax = 100; }
    }
    for (const id in aaguns) {
      const ag = aaguns[id];
      if (!ag.alive) continue;
      if (idx >= MAX_MARKERS) break;
      const m = markerPool[idx++];
      m.used = true;
      const isFoe = ag.team !== myTeam;
      m.el.className = 'planeMarker ' + (isFoe ? 'foe' : 'ally');
      m.mname.textContent = mode === 'practice' ? '' : nameOfPlayer(id);   // 头顶姓名（人机模式不显示）
      placeMarker(m, projectToScreen(ag.aagun.group.position));
      const dist = myPos.distanceTo(ag.aagun.group.position);
      m.dist.textContent = Math.round(dist) + ' m';
      if (isFoe && dist < nearestFoeDist) { nearestFoeDist = dist; nearestFoeHp = ag.hp; nearestFoeMax = AAGUN_HP; }
    }
  }
  for (let i = idx; i < MAX_MARKERS; i++) {
    if (markerPool[i].used) { markerPool[i].used = false; markerPool[i].el.style.opacity = '0'; }
  }
  foeHpFill.style.width = (nearestFoeDist < Infinity ? Math.max(0, Math.round(nearestFoeHp / nearestFoeMax * 100)) : 0) + '%';   // 同样按最大血量归一化（防空车 120）
}
