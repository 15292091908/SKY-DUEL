// js/core.js — 3D 与音频基础设施（v3.4 从 main.js 抽出）
// 版本标签 / 设备检测（含手机浏览器闸门）/ WebGL 渲染器 / 场景 / 相机 / 特效 / 音频（全局单例）
import * as THREE from 'three';
import { Effects } from './effects.js?v=1516';
import { AudioEngine } from './audio.js?v=1516';
import { GAME_VERSION } from './config.js?v=1516';

/* ================= 版本号（部署识别；每次发版递增） ================= */
// 注意：不能在此处使用 $（它在文件下部用 const 声明，TDZ 会抛 ReferenceError 导致整个模块崩溃）
const _verTag = document.getElementById('verTag');
if (_verTag) _verTag.textContent = GAME_VERSION;
const _verTagPause = document.getElementById('verTagPause');
if (_verTagPause) _verTagPause.textContent = GAME_VERSION;

/* ================= 设备检测 ================= */
// 安卓 App（WebView）：优先认 WebViewAssetLoader 专属域名（万无一失），UA 的 "; wv)" 作双保险。
// 触屏操控只在安卓 App 激活——手机浏览器已被 mobile-gate 挡在下载引导页（见 play/index.html）。
export const IS_ANDROID_APP = location.host === 'appassets.androidplatform.net' || /;\s*wv\)/.test(navigator.userAgent);
export const isTouch = (window.matchMedia && window.matchMedia('(pointer:coarse)').matches) ||
  (('ontouchstart' in window) && navigator.maxTouchPoints > 0 && !window.matchMedia('(pointer:fine)').matches);
// 手机浏览器（非安卓 App 的移动设备）：v2.4 起网页端收窄为"桌面浏览器游玩"，
// 触屏操控逻辑只在安卓 App 运行；手机访问 /play/ 显示下载引导（mobile-gate 由页面内联脚本标记），
// 这里直接中断游戏模块初始化（遮罩盖住一切，菜单/引擎都不再启动）
if (document.documentElement.classList.contains('mobile-gate')) {
  throw new Error('SkyDuel: mobile browser → APK download gate');
}
if (IS_ANDROID_APP) document.body.classList.add('touch');

/* ================= 基础场景 ================= */
export const canvas = document.getElementById('c');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
// 画质档位：桌面全开（软阴影 + 高像素比 + 环境反射），触屏自动降级保帧率
// [ANDROID] 设置面板补丁：画质/阴影存于 localStorage('sd_settings')，默认值与网页版一致
const _sdSet = (() => { try { return JSON.parse(localStorage.getItem('sd_settings') || '{}'); } catch (e) { return {}; } })();
export const GFX = {
  shadows: _sdSet.shadows === undefined ? !isTouch : !!_sdSet.shadows,
  shadowSize: 2048,
  pixelCap: _sdSet.pixel === undefined ? (isTouch ? 1.25 : 2) : parseFloat(_sdSet.pixel)
};
renderer.setPixelRatio(Math.min(window.devicePixelRatio, GFX.pixelCap));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // 电影级色调映射（高光滚降，画面更真实）
renderer.toneMappingExposure = 0.88;
renderer.shadowMap.enabled = GFX.shadows;             // PCFSoft 软阴影
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
if (renderer.outputColorSpace !== undefined) renderer.outputColorSpace = THREE.SRGBColorSpace;

export const scene = new THREE.Scene();
export const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 12000);   // far 必须 > 穹顶半径 + 相机离原点最大距离，否则天空被裁洞
export const effects = new Effects(scene);
export const audio = new AudioEngine();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
