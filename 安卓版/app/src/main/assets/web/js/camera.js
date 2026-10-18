// js/camera.js — 第三人称相机（v3.4.1 从 main.js 抽出）
// 菜单轨道视角 / 防空车炮塔视角（准星=弹道）/ 飞机视角（视角领先 + 飞机追赶）/ 死亡观战轨道。
// 视角状态 aimYaw/aimPitch/zoom 存于 state.js（输入层写、本模块读）。
import * as THREE from 'three';
import { STATE, me, myPlane, myAAGun, meAAGun, meIsAAGun, aimYaw, aimPitch, zoom, planeWeapon } from './state.js?v=1516';
import { modeField } from './mode.js?v=1516';
import { camera, effects } from './core.js?v=1516';
import { menuSceneType, menuCamOrbitYaw, menuCamOrbitPitch, menuCamDist } from './scene3d.js?v=1516';
import { spec, specTargetObj } from './spectate.js?v=1516';
import { deathPos } from './loop.js?v=1516';   // 坠机点（loop.js 持有）

const _camPos = new THREE.Vector3(), _look = new THREE.Vector3();
const _viewE = new THREE.Euler(), _viewDir = new THREE.Vector3();
const _tmpA = new THREE.Vector3();   // 兜底观战位置的临时向量（原 main.js 的 tmpA）
let menuCamT = 0;                    // 菜单相机计时（仅本模块自增）

export function updateCamera(dt) {
  if (!me || !me.alive) camera.up.set(0, 1, 0);   // 投弹俯视会临时改 up，死亡/观战必须还原
  if (!STATE.started) {
    // 菜单：轨道视角围绕主体（飞机/防空车），拖动旋转 + 滚轮缩放，始终对准主体不穿地
    menuCamT += dt;
    const tx = menuSceneType === 'aavs' ? 0 : 0, ty = menuSceneType === 'aavs' ? 13 : 1.8, tz = menuSceneType === 'aavs' ? 6 : -6;
    const cp = Math.cos(menuCamOrbitPitch), sp = Math.sin(menuCamOrbitPitch);
    const cy = Math.cos(menuCamOrbitYaw), sy = Math.sin(menuCamOrbitYaw);
    _camPos.set(tx + cp * sy * menuCamDist, ty + sp * menuCamDist, tz + cp * cy * menuCamDist);
    camera.position.lerp(_camPos, 1 - Math.exp(-6 * dt));
    camera.lookAt(tx, ty, tz);
    if (Math.abs(camera.fov - 55) > 0.5) { camera.fov += (55 - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix(); }
    return;
  }
  // 模式自定义相机（直升机：机枪摄像头视角 / 炸弹俯视视角）
  if (!meIsAAGun && me && me.alive) {
    const _camFn = modeField('camera', null);
    if (_camFn && _camFn({ f: me, camera, dt, zoom, yaw: me.yaw, weapon: planeWeapon })) return;
  }
  if (meIsAAGun) {
    // 防空车视角：相机与视线目标做相同垂直偏移 → 视线与弹道方向完全平行，准星=实际弹道
    if (meAAGun.alive) {
      _viewE.set(meAAGun.turretPitch, meAAGun.turretYaw, 0, 'YXZ');
      _viewDir.set(0, 0, -1).applyEuler(_viewE);
      const dist = zoom ? 10 : 16;
      // 瞄准参考点：炮塔顶部（车中心上方 3m）
      _camPos.copy(myAAGun.group.position);
      _camPos.y += 3.0;
      const refY = _camPos.y;
      _camPos.addScaledVector(_viewDir, -dist);
      _camPos.y = refY + 3.4;
      if (_camPos.y < 3.5) _camPos.y = 3.5;
      camera.position.lerp(_camPos, 1 - Math.exp(-8 * dt));
      _look.copy(myAAGun.group.position);
      _look.y = refY + 3.4;
      _look.addScaledVector(_viewDir, 70);
      camera.lookAt(_look);
    } else {
      // 死亡：多人观战轨道跟随存活单位；无目标兜底坠机点固定视角
      const st = specTargetObj();
      if (st) {
        const cp2 = Math.cos(spec.pitch), sp2 = Math.sin(spec.pitch);
        const cy2 = Math.cos(spec.yaw), sy2 = Math.sin(spec.yaw);
        _camPos.set(st.position.x + cp2 * sy2 * spec.dist, st.position.y + sp2 * spec.dist, st.position.z + cp2 * cy2 * spec.dist);
        if (_camPos.y < 2.5) _camPos.y = 2.5;   // 防钻地
        camera.position.lerp(_camPos, 1 - Math.exp(-8 * dt));
        camera.lookAt(st.position);
      } else {
        _look.copy(deathPos);
        camera.position.lerp(_tmpA.copy(_look).add(new THREE.Vector3(0, 18, 42)), 1 - Math.exp(-3 * dt));
        camera.lookAt(_look);
      }
    }
  } else if (me.alive) {
    // 视角方向 = 飞机朝向 + aim偏移（鼠标快转时视角先转，飞机再追）
    _viewE.set(me.pitch + aimPitch, me.yaw + aimYaw, 0, 'YXZ');
    _viewDir.set(0, 0, -1).applyEuler(_viewE);
    const dist = zoom ? 9.5 : 13.5, h = zoom ? 2.1 : 3.6;
    _camPos.copy(myPlane.group.position).addScaledVector(_viewDir, -dist); _camPos.y += h;
    camera.position.lerp(_camPos, 1 - Math.exp(-11 * dt));
    // [ANDROID] v0.3.4 准星校真：lookAt 点与相机同高（原 +2 与相机 +3.6 不等高，光轴比机头低倾
    // ~1.65°，非开镜远距离子弹偏高 20-48m——网页版用户靠开镜狙远，安卓版触屏不开镜就打不到）。
    // 改为 look.y += h 后光轴与机头线严格平行：小准星=弹道方向，开镜/非开镜、近距/远距全部命中一致。
    // 注：v3.4.1 起该段代码从 main.js 迁入 camera.js（拆分），补丁随之迁移。
    _look.copy(myPlane.group.position).addScaledVector(_viewDir, 42); _look.y += h;
    camera.lookAt(_look);
  } else {
    // 死亡：清掉直升机镜头 HUD（枪镜/投弹框），进入观战
    const _hcu = document.getElementById('heliCamUi');
    if (_hcu) _hcu.classList.remove('on', 'bomb');
    // 死亡：多人观战轨道跟随存活单位；无目标兜底坠机点固定视角
    const st = specTargetObj();
    if (st) {
      const cp2 = Math.cos(spec.pitch), sp2 = Math.sin(spec.pitch);
      const cy2 = Math.cos(spec.yaw), sy2 = Math.sin(spec.yaw);
      _camPos.set(st.position.x + cp2 * sy2 * spec.dist, st.position.y + sp2 * spec.dist, st.position.z + cp2 * cy2 * spec.dist);
      if (_camPos.y < 2.5) _camPos.y = 2.5;   // 防钻地
      camera.position.lerp(_camPos, 1 - Math.exp(-8 * dt));
      camera.lookAt(st.position);
    } else {
      _look.copy(deathPos);
      camera.position.lerp(_tmpA.copy(_look).add(new THREE.Vector3(0, 14, 36)), 1 - Math.exp(-3 * dt));
      camera.lookAt(_look);
    }
  }
  const targetFov = zoom ? 32 : 70;
  if (Math.abs(camera.fov - targetFov) > 0.1) { camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 10); camera.updateProjectionMatrix(); }
  if (effects.shakeAmp > 0.005) {
    camera.position.x += (Math.random() - 0.5) * effects.shakeAmp * 0.9;
    camera.position.y += (Math.random() - 0.5) * effects.shakeAmp * 0.9;
    camera.position.z += (Math.random() - 0.5) * effects.shakeAmp * 0.9;
  }
}
