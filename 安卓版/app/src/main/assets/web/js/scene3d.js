// js/scene3d.js — 地图重建 + 菜单 3D 展示场景（v3.4 从 main.js 抽出）
// 负责：世界切换（rebuildWorld）、主菜单沉浸式展示（飞机停跑道 / 防空车+悬停飞机）、
// 菜单轨道相机（鼠标拖动旋转 + 滚轮缩放）与部件自转动画（updateMenuScene）。
import * as THREE from 'three';
import { createWorld } from './world/index.js?v=1516';
import { buildPlane, makeFighter } from './plane.js?v=1516';
import { buildAAGun, makeAAGun, applyAAGun } from './aagun.js?v=1516';
import { scene, renderer, GFX } from './core.js?v=1516';
import { modeDef } from './mode.js?v=1516';   // 「游戏内」模式模块（菜单展示参数）
import { $ } from './hud.js?v=1516';
import { STATE, setWorld, world } from './state.js?v=1516';
import { MENU_PITCH_MIN, MENU_PITCH_MAX, MENU_DIST_MIN, MENU_DIST_MAX } from './config.js?v=1516';

/* ================= 地图重建 ================= */
export function rebuildWorld(type) {
  if (world) {
    scene.remove(world.root);
    world.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose && o.geometry.dispose();
      if (o.material) { if (Array.isArray(o.material)) o.material.forEach(m => m && m.dispose && m.dispose()); else o.material.dispose && o.material.dispose(); }
    });
  }
  setWorld(createWorld(scene, type, renderer, GFX));
  scene.add(world.root);
  STATE.mapType = type;
}

/* ================= 菜单 3D 展示场景 ================= */
// 进入页面映入眼帘：空战 = 飞机停在跑道；防空车 = 防空车在跑道 + 天上飞机悬停
export let menuSceneType = 'dogfight';
let menuPlane = null, menuPlaneF = null;     // 展示飞机（模型 + 实体）
let menuAAGun = null;                        // 展示防空车（实体）
let menuFlying = null, menuFlyingF = null;   // 防空车模式下天上悬停的飞机
// ★ 模式自建展示件的"归属"：menuProp 是上一个模式建的，清理由它的 menuCleanup 负责。
//   不能读 modeDef()——切模式时 current 已经换成新模式，会把旧模型漏在场景里（直升机串模式）。
let menuPropOwner = null;
// 菜单轨道视角：围绕主体旋转 + 缩放（鼠标拖动/滚轮）
export let menuCamOrbitYaw = 0, menuCamOrbitPitch = 0.4, menuCamDist = 28;
let menuDragging = false, menuDragX = 0, menuDragY = 0;
function menuTarget(out) {
  const t = modeDef() && modeDef().menu && modeDef().menu.target;
  return t ? out.fromArray(t) : out.set(0, 1.8, -6);   // 取景参数来自「游戏内」模式模块
}
function updateMenuZoomLabel() {
  const base = (modeDef() && modeDef().menu && modeDef().menu.zoomBase) || 28;
  const el = $('menuZoomInfo'); if (el) el.textContent = (base / menuCamDist).toFixed(1) + '×';
}
// 面板/弹层是否正在遮住菜单场景 —— 遮住时鼠标拖动与滚轮都不该作用到背后的 3D 展示
// （用户反馈：打开「帮助」后滚轮滚动内容，背后的场景会跟着缩放）
function menuInputBlocked(e) {
  const t = e.target;
  if (t && t.closest && t.closest('button, textarea, input, select')) return true;   // 交互控件（原有规则）
  if (document.querySelector('.glassPanel:not(.hidden)')) return true;              // 帮助/设置/战绩等玻璃面板
  if (document.querySelector('.overlay:not(.hidden):not(#menu)')) return true;      // 暂停/阵营/结算等全屏弹层（#menu 本身不算）
  for (let n = t; n && n !== document.body; n = n.parentElement) {                  // 事件落在"真的能滚动"的容器里
    if (n.scrollHeight - n.clientHeight > 2 && /auto|scroll/.test(getComputedStyle(n).overflowY)) return true;
  }
  return false;
}
// 鼠标拖动旋转视角 + 滚轮缩放（仅菜单时，视角始终对准主体，不穿地；面板打开时不响应）
document.addEventListener('mousedown', (e) => {
  if (STATE.started) return;
  if (menuInputBlocked(e)) return;
  menuDragging = true; menuDragX = e.clientX; menuDragY = e.clientY;
});
document.addEventListener('mousemove', (e) => {
  if (STATE.started || !menuDragging) return;
  // 抓取式旋转：拖左 → 视角向右走；上滑 → 视角向下移动（俯视增强）
  menuCamOrbitYaw -= (e.clientX - menuDragX) * 0.005;
  menuCamOrbitPitch = THREE.MathUtils.clamp(menuCamOrbitPitch + (e.clientY - menuDragY) * 0.005, MENU_PITCH_MIN, MENU_PITCH_MAX);
  menuDragX = e.clientX; menuDragY = e.clientY;
});
document.addEventListener('mouseup', () => { menuDragging = false; });
document.addEventListener('wheel', (e) => {
  if (STATE.started) return;
  if (menuInputBlocked(e)) return;   // 面板打开/在面板内容上滚动 → 交给面板自己滚，不缩放场景
  menuCamDist = THREE.MathUtils.clamp(menuCamDist * Math.exp(e.deltaY * 0.0012), MENU_DIST_MIN, MENU_DIST_MAX);
  updateMenuZoomLabel();
}, { passive: true });
// [ANDROID] 菜单 3D 展示触屏：单指拖拽旋转 + 双指捏合缩放（面板/按钮区域除外）
let menuPinchD = 0;
document.addEventListener('touchstart', (e) => {
  if (STATE.started) return;
  if (e.target && e.target.closest && e.target.closest('button, textarea, .menuBox, .glassPanel')) return;
  if (e.touches.length === 1) {
    menuDragging = true; menuDragX = e.touches[0].clientX; menuDragY = e.touches[0].clientY; menuPinchD = 0;
  } else if (e.touches.length === 2) {
    menuDragging = false;
    menuPinchD = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  }
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (STATE.started) return;
  if (e.touches.length === 1 && menuDragging) {
    const t = e.touches[0];
    menuCamOrbitYaw -= (t.clientX - menuDragX) * 0.005;
    menuCamOrbitPitch = THREE.MathUtils.clamp(menuCamOrbitPitch + (t.clientY - menuDragY) * 0.005, MENU_PITCH_MIN, MENU_PITCH_MAX);
    menuDragX = t.clientX; menuDragY = t.clientY;
  } else if (e.touches.length === 2 && menuPinchD > 0) {
    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    if (d > 0) {
      menuCamDist = THREE.MathUtils.clamp(menuCamDist * menuPinchD / d, MENU_DIST_MIN, MENU_DIST_MAX);
      menuPinchD = d; updateMenuZoomLabel();
    }
  }
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (e.touches.length === 0) { menuDragging = false; menuPinchD = 0; }
}, { passive: true });
export function clearMenuProps() {
  // 模式自己建的展示件（如直升机）也一并清掉：必须用**建它的那个模式**的 cleanup，
  // 而不是当前模式（否则切到空战/防空车后，上一模式的模型会永远留在场景里）
  const owner = menuPropOwner || modeDef();
  const _mc = owner && owner.menuCleanup;
  if (typeof _mc === 'function') _mc();
  menuPropOwner = null;
  if (menuPlane) { scene.remove(menuPlane.group); menuPlane = null; menuPlaneF = null; }
  if (menuAAGun) { scene.remove(menuAAGun.aagun.group); menuAAGun = null; }
  if (menuFlying) { scene.remove(menuFlying.group); menuFlying = null; menuFlyingF = null; }
}
// 给展示飞机加起落架（前轮 + 左右主轮 + 支柱）
function addLandingGear(planeModel) {
  const g = planeModel.group;
  const gearMat = new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.6 });
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.2, 8);
  const strutGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.0, 5);
  const mk = (x, z) => {
    const wheel = new THREE.Mesh(wheelGeo, gearMat);
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(x, -0.72, z);
    const strut = new THREE.Mesh(strutGeo, gearMat);
    strut.position.set(x, -0.45, z);
    g.add(wheel, strut);
  };
  mk(-1.3, 0.6);   // 左主轮
  mk(1.3, 0.6);    // 右主轮
  mk(0, -3.3);     // 前轮
}
// 菜单 3D 展示：相机与展示内容全部由模式包声明（js/modes/<目录>/index.js 的 MODE.menu）
// props 种类：plane（停在跑道的飞机，可选起落架）/ planeFly（空中悬停的飞机）/ aagun（防空车，炮塔扫描）
export function showMenuScene(type) {
  const M = (modeDef() && modeDef().menu) || null;
  menuSceneType = (M && M.scene) || type || 'dogfight';
  clearMenuProps();
  if (!M) { rebuildWorld('base'); updateMenuZoomLabel(); return; }   // 兜底：模式模块未加载
  menuCamOrbitYaw = M.yaw; menuCamOrbitPitch = M.pitch; menuCamDist = M.dist;
  rebuildWorld(M.world || 'base');   // 两种玩法都复用军事基地机场
  const _self = modeDef();
  let _ownerSet = false;
  for (const p of M.props) {
    if (p.kind === 'plane') {
      const pl = buildPlane(p.color); scene.add(pl.group);
      menuPlane = pl; menuPlaneF = makeFighter(pl);
      if (p.gear) addLandingGear(pl);
      pl.group.position.fromArray(p.pos);
      pl.group.quaternion.setFromEuler(new THREE.Euler(0, 0, 0, 'YXZ'));   // 机头朝 -Z 面向相机
    } else if (p.kind === 'planeFly') {
      const pl = buildPlane(p.color); scene.add(pl.group);
      menuFlying = pl; menuFlyingF = makeFighter(pl);
      pl.group.position.fromArray(p.pos);
      pl.group.quaternion.setFromEuler(new THREE.Euler(...p.rot, 'YXZ'));
    } else if (_self && typeof _self.menuProp === 'function' && _self.menuProp(p, { scene, THREE })) {
      // 模式自己建好了这个 prop（如直升机）→ 记下归属，切模式时由它自己清理
      if (!_ownerSet) { menuPropOwner = _self; _ownerSet = true; }
    } else if (p.kind === 'aagun') {
      const ag = buildAAGun(p.color); scene.add(ag.group);
      menuAAGun = makeAAGun(ag);
      menuAAGun.aagun.group.position.fromArray(p.pos);
      menuAAGun.bodyYaw = p.bodyYaw || 0;
    }
  }
  updateMenuZoomLabel();
}
export function updateMenuScene(dt) {
  if (menuPlane && menuPlaneF) {
    if (menuPlane.prop) menuPlane.prop.rotation.z -= dt * 6;   // 螺旋桨慢转
  }
  if (menuAAGun) {
    menuAAGun.turretYaw += dt * 0.35;   // 炮塔缓慢扫描
    if (menuAAGun.turretYaw > Math.PI * 0.9) menuAAGun.turretYaw = -Math.PI * 0.9;
    applyAAGun(menuAAGun);
  }
  if (menuFlying && menuFlyingF) {
    // 静止悬停：位置朝向不动，只有螺旋桨转动
    if (menuFlying.prop) menuFlying.prop.rotation.z -= dt * 14;
  }
}
