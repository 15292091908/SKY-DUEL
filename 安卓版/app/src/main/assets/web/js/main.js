import * as THREE from 'three';
import { AudioEngine } from './audio.js?v=8005';
import { createWorld, WORLD } from './world.js?v=8005';
import { buildPlane, makeFighter, applyFlight, forwardOf } from './plane.js?v=8005';
import { buildAAGun, makeAAGun, forwardOfTurret, forwardOfBody, applyAAGun, updateWeakAAGun } from './aagun.js?v=8005';
import { Effects } from './effects.js?v=8005';
import { Net, makePeerId } from './net.js?v=8005';
import { Bot, AAGunBot } from './ai.js?v=8005';

/* ================= 版本号（部署识别；每次发版递增） ================= */
// 注意：不能在此处使用 $（它在文件下部用 const 声明，TDZ 会抛 ReferenceError 导致整个模块崩溃）
const GAME_VERSION = 'v0.3.3 安卓版';   // [ANDROID] 安卓版独立版本号（底层游戏快照 v2.3.7）
const _verTag = document.getElementById('verTag');
if (_verTag) _verTag.textContent = GAME_VERSION;
const _verTagPause = document.getElementById('verTagPause');
if (_verTagPause) _verTagPause.textContent = GAME_VERSION;

/* ================= 设备检测 ================= */
const isTouch = (window.matchMedia && window.matchMedia('(pointer:coarse)').matches) ||
  (('ontouchstart' in window) && navigator.maxTouchPoints > 0 && !window.matchMedia('(pointer:fine)').matches);
if (isTouch) document.body.classList.add('touch');

/* ================= 基础场景 ================= */
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
// 画质档位：桌面全开（软阴影 + 高像素比 + 环境反射），触屏自动降级保帧率
// [ANDROID] 设置面板补丁：画质/阴影/触屏灵敏度存于 localStorage('sd_settings')，默认值与网页版一致
const _sdSet = (() => { try { return JSON.parse(localStorage.getItem('sd_settings') || '{}'); } catch (e) { return {}; } })();
const GFX = {
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

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 12000);   // far 必须 > 穹顶半径 + 相机离原点最大距离，否则天空被裁洞
let world = null;
const effects = new Effects(scene);
const audio = new AudioEngine();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ================= 玩家与飞机 ================= */
const myPeerId = makePeerId();
let myTeam = 0, mySlot = 0;
let mode = null;                 // 'practice' | 'net'
let practiceSize = 2;           // 练习模式固定 1v1
let netSize = 2;                // 联机模式队伍规模（2/6/10）
const nets = {};                // peerId -> Net（房主连接 + mesh 直连）
let hostPeerId = null;          // 非房主记录的房主真实 ID
let stateSeq = 0, eventSeq = 0; // 广播消息序号（接收方去重）
const lastEventSeq = {};        // peerId -> 最后处理的事件序号（event 通道，eventSeq 计数）
const lastUpdSeq = {};          // 房主端：非房主 upd 上报去重（state 通道，stateSeq 计数）
const lastSyncSeq = {};         // 非房主端：sync 快照去重（state 通道，stateSeq 计数——不能与 eventSeq 混用，否则事件会被乱序快照压掉）
const rejectedFids = new Map(); // 房主：已否决的 fid -> 时间（hitRep 迟到时防双结算）
let netOffer = null;            // 主机的 offer Net 模板
let roster = [];
let iAmHost = false;

let myPlane = null, me = null;
let myAAGun = null, meAAGun = null;   // 防空车玩家（模型 / 实体）
let meIsAAGun = false;                // 玩家当前操控防空车
const planes = {};                    // id -> { id, plane, team, slot, alive, hp, tPos, tQuat, lastState, isBot }
const aaguns = {};                    // id -> { id, aagun, team, slot, alive, hp, tPos, tTurretYaw, tTurretPitch, lastState, isBot }
let bot = null;                       // 练习模式
let gamemode = 'dogfight';            // 'dogfight' 空战 | 'aavs' 防空车vs飞机

const MODE_SIZE = { 'net': 2 };
const SPAWN_Z = 900;
const AAGUN_HP = 120;

function spawnPos(team, slot, teamSize) {
  const x = (slot - (teamSize - 1) / 2) * 140;
  // 防空车玩法：紧凑小岛，出生点收紧到岛两侧近空
  if (gamemode === 'aavs') return new THREE.Vector3(x, 240, team === 0 ? 520 : -520);
  return new THREE.Vector3(x, 280, team === 0 ? SPAWN_Z : -SPAWN_Z);
}
// 防空车出生点（军事基地岛点位，防空车阵营 = team1）
function aagunSpawnPos(slot, aaSpawns) {
  const s = aaSpawns ? aaSpawns[slot % aaSpawns.length] : { x: 0, z: 0 };
  return new THREE.Vector3(s.x, 0, s.z);
}

/* ================= IFF 标记池（DOM投影，敌红/友蓝菱形） ================= */
const markersContainer = document.getElementById('markers');
const markerPool = [];
const MAX_MARKERS = 12;
for (let i = 0; i < MAX_MARKERS; i++) {
  const el = document.createElement('div');
  el.className = 'planeMarker';
  el.innerHTML = '<div class="diamond"></div><div class="distance">0 m</div>';
  el.style.opacity = '0';
  markersContainer.appendChild(el);
  markerPool.push({ el, dist: el.querySelector('.distance'), used: false });
}

/* ================= 游戏状态 ================= */
const STATE = {};
resetState();
function resetState() {
  STATE.started = false;
  STATE.roundOver = false;
  STATE.matchEnded = false;
  STATE.myScore = 0;
  STATE.foeScore = 0;
  STATE.s0 = 0; STATE.s1 = 0;   // 队伍视角比分（team0/team1 各赢几局，房主小世界权威）
  STATE.roundNum = 0;
  STATE.mapType = 'island';
  STATE.mapFinalized = false;
  STATE.eliminatedTeam = -1;
  STATE.teamElimTimer = 0;
}

let firing = false, zoom = false, fireT = 0;
let killCount = 0;            // 本局击杀数（右上角显示）
let crashCd = 0;              // 空中相撞结算冷却（防友军相撞连续扣血）


/* ================= 选阵营（3v3/5v5 开局前；1v1 跳过） ================= */
let pickPhase = false;            // 房主：选阵营进行中
let pickSelections = {};          // 房主：peerId -> 0/1
let pickReadySet = new Set();     // 房主：已确认就绪的玩家
let pickCountTimer = null;        // 房主：人数固定频率广播定时器
let myPickSide = -1;              // 玩家端：我的选择（-1 未选）
let pickListGot = null;           // 玩家端：收到的最终名单 {peerId: side}
let curPickC0 = 0, curPickC1 = 0, pickTs0 = 1, pickTs1 = 1;   // 玩家端：两阵营已选人数 / 各自容量（掉线后人数可能为奇数 → 容量不对称）
let pickUIReady = false;
let pickRound = 0;                // 选阵营表格编号（幂等：重新选后旧编号消息丢弃）
let pickWaitingReady = false;    // 已定向发放名单，等待全员就绪（不能复用 pickPhase，它此时已结束）
let pickStartTs = 0;             // 房主：本轮选阵营开始时间（45s 超时自动分配，防挂机/失联卡局）
let crashPairs = new Map();      // 房主：碰撞去重（双方各自检测/上报，同一碰撞只权威结算一次）
let myFireSeq = 0;               // 非房主：开火序号（每颗子弹递增，供房主否决回溯对账）
const firePred = {};             // 非房主：fid -> {id, dmg, t} 本地预判扣血记录（等房主确认/否决）
const fireBullets = {};          // 房主：fid -> 非房主上报子弹对象（等 hitRep 声称命中做信任判定）
const pendingRejects = [];       // 房主：待否决队列 [{fid, from, expire}]（延迟 220ms 等 hitRep，避免先否决后确认的来回抖动）
let lastREndShown = -1;
let rnMismatchT = 0;             // 非房主：房主快照回合序号持续落后本端的起始时刻（看门狗自愈用）          // 非房主：已提示过回合结果的局号（防 rEnd 重放导致重复横幅）
let accX = 0, accY = 0;
let locked = false;
let pingMs = -1;
let stateT = 0, pingT = 0, fpsT = 0, fpsCnt = 0, beepT = 0, warnOn = false;
let dmgAcc = 0;
let mapLobbyTimerId = null;
let connectedPeers = 0;
const deathPos = new THREE.Vector3();
const tmpA = new THREE.Vector3();

const BASE_DMG = 7;
const SPEED_MIN = 45, SPEED_MAX = 170;
const SENS = 0.0022;
const TOUCH_SENS = _sdSet.touchSens === undefined ? 1.7 : parseFloat(_sdSet.touchSens);   // [ANDROID] 设置面板可调
const WIN_ROUNDS = 3;
const MAX_AIM = 0.55;       // 视角最大偏移量（弧度，~31°）
const TURN_RATE = 2.4;      // 飞机追赶视角的最大转弯速率（rad/s）
const PITCH_RATE = 1.8;     // 俯仰追赶速率
let aimYaw = 0, aimPitch = 0;  // 视角偏移（飞机朝向 + aim = 视角方向）
let joySteerX = 0;             // 手机摇杆X轴（-1左 ~ 1右）

/* ================= DOM ================= */
const $ = (id) => document.getElementById(id);
const hud = $('hud'), menu = $('menu'), pauseEl = $('pause');
const hpFill = $('hpFill'), foeHpFill = $('foeHpFill'), hpLabel = $('hpLabel');
const speedVal = $('speedVal'), altVal = $('altVal');
const bannerEl = $('banner'), subBannerEl = $('subBanner'), warnEl = $('warn');
const hitmarkEl = $('hitmark'), partHitEl = $('partHit'), dmgFlashEl = $('dmgFlash');
const pipsMeEl = $('pipsMe'), pipsFoeEl = $('pipsFoe'), scoreTextEl = $('scoreText');
const roundLabelEl = $('roundLabel');
const matchPanel = $('matchPanel'), matchTitle = $('matchTitle'), matchSub = $('matchSub');
const fpsValEl = $('fpsVal'), pingValTextEl = $('pingValText');
const planeReticle = $('planeReticle');
const rosterPanel = $('rosterPanel'), rosterMineUnits = $('rosterMineUnits'), rosterFoeUnits = $('rosterFoeUnits');
const killValEl = $('killVal');

let bannerTimer = 0, partHitTimer = 0, hitmarkTimer = 0;

function banner(text, color = '#fff', dur = 2.2) {
  bannerEl.textContent = text; bannerEl.style.color = color; bannerEl.style.opacity = 1; bannerTimer = dur;
}
function subBanner(text, dur = 2.2) {
  subBannerEl.textContent = text; subBannerEl.style.opacity = text ? 1 : 0;
  if (dur > 0) setTimeout(() => { subBannerEl.style.opacity = 0; }, dur * 1000);
}
function showPart(text) { partHitEl.textContent = text; partHitEl.style.opacity = 1; partHitTimer = 0.8; }
function showHitmark(kill) { hitmarkEl.classList.toggle('kill', !!kill); hitmarkEl.style.opacity = 1; hitmarkTimer = 0.13; }
function updateScore() {
  scoreTextEl.textContent = STATE.myScore + ' : ' + STATE.foeScore;
  const build = (el, n, cls) => {
    el.innerHTML = '';
    for (let i = 0; i < WIN_ROUNDS; i++) { const d = document.createElement('span'); d.className = 'pip' + (i < n ? ' on ' + cls : ''); el.appendChild(d); }
  };
  build(pipsMeEl, STATE.myScore, 'me');
  build(pipsFoeEl, STATE.foeScore, 'foe');
}

/* ================= 地图重建 ================= */
function rebuildWorld(type) {
  if (world) {
    scene.remove(world.root);
    world.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose && o.geometry.dispose();
      if (o.material) { if (Array.isArray(o.material)) o.material.forEach(m => m && m.dispose && m.dispose()); else o.material.dispose && o.material.dispose(); }
    });
  }
  world = createWorld(scene, type, renderer, GFX);
  scene.add(world.root);
  STATE.mapType = type;
}

/* ================= 菜单 3D 展示场景 ================= */
// 进入页面映入眼帘：空战 = 飞机停在跑道；防空车 = 防空车在跑道 + 天上飞机悬停
let menuSceneType = 'dogfight';
let menuPlane = null, menuPlaneF = null;     // 展示飞机（模型 + 实体）
let menuAAGun = null;                        // 展示防空车（实体）
let menuFlying = null, menuFlyingF = null;   // 防空车模式下天上悬停的飞机
let menuCamT = 0;
// 菜单轨道视角：围绕主体旋转 + 缩放（鼠标拖动/滚轮）
let menuCamOrbitYaw = 0, menuCamOrbitPitch = 0.4, menuCamDist = 28;
const MENU_PITCH_MIN = 0.12, MENU_PITCH_MAX = 1.25;   // 俯角下限防穿地
const MENU_DIST_MIN = 14, MENU_DIST_MAX = 85;          // 距离下限防贴脸穿模
let menuDragging = false, menuDragX = 0, menuDragY = 0;
function menuTarget(out) { return menuSceneType === 'aavs' ? out.set(0, 13, 6) : out.set(0, 1.8, -6); }
function updateMenuZoomLabel() {
  const base = menuSceneType === 'aavs' ? 58 : 28;
  const el = $('menuZoomInfo'); if (el) el.textContent = (base / menuCamDist).toFixed(1) + '×';
}
// 鼠标拖动旋转视角 + 滚轮缩放（仅菜单时，视角始终对准主体，不穿地）
document.addEventListener('mousedown', (e) => {
  if (STATE.started) return;
  if (e.target && e.target.closest && e.target.closest('button, textarea')) return;
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
function clearMenuProps() {
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
function showMenuScene(type) {
  menuSceneType = type;
  clearMenuProps();
  if (type === 'aavs') {
    // 防空车停在跑道 + 天上飞机静止悬停（只有螺旋桨转动），相机目标抬高让两者同框
    menuCamOrbitYaw = Math.PI; menuCamOrbitPitch = 0.42; menuCamDist = 58;
    rebuildWorld('base');
    const ag = buildAAGun(0x3fa7ff);
    scene.add(ag.group);
    menuAAGun = makeAAGun(ag);
    menuAAGun.aagun.group.position.set(0, 0, 6);
    menuAAGun.bodyYaw = Math.PI;
    const fp = buildPlane(0xff6b5e);
    scene.add(fp.group);
    menuFlying = fp;
    menuFlyingF = makeFighter(fp);
    menuFlying.group.position.set(0, 26, -30);
    menuFlying.group.quaternion.setFromEuler(new THREE.Euler(0.14, Math.PI, 0, 'YXZ'));   // 机头朝 +Z（面向跑道），微抬头
  } else {
    // 复用军事基地机场：飞机带起落架停在跑道上，机头朝相机
    menuCamOrbitYaw = 0; menuCamOrbitPitch = 0.4; menuCamDist = 28;
    rebuildWorld('base');
    const p = buildPlane(0x3fa7ff);
    scene.add(p.group);
    menuPlane = p;
    menuPlaneF = makeFighter(p);
    addLandingGear(p);
    menuPlane.group.position.set(0, 1.3, -6);   // 轮子着地（跑道 0.26 + 机腹 1.04）
    menuPlane.group.quaternion.setFromEuler(new THREE.Euler(0, 0, 0, 'YXZ'));   // 机头朝 -Z 面向相机
  }
  updateMenuZoomLabel();
}
function updateMenuScene(dt) {
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
showMenuScene('dogfight');

/* ================= 子弹 ================= */
const bulletGeo = new THREE.CylinderGeometry(0.07, 0.07, 4.5, 5);
bulletGeo.rotateX(Math.PI / 2);
const tracerMatMe = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
const tracerMatFoe = new THREE.MeshBasicMaterial({ color: 0xff8a7a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
const bullets = [];
// 弹池容量：按 5v5 全员持续扫射估算（10 人 × 3.4s 寿命 ÷ 0.09s 射速 ≈ 380 发），留余量取 480。
// 打光时 spawnBullet 返回 null → 子弹不可见且无法模拟/上报，多人局会"打不出子弹"
for (let i = 0; i < 480; i++) {
  const m = new THREE.Mesh(bulletGeo, tracerMatMe);
  m.visible = false; scene.add(m);
  bullets.push({ mesh: m, pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, active: false, src: 'me', dmg: BASE_DMG, splash: false });
}
const Z_AXIS = new THREE.Vector3(0, 0, 1);

// 子弹网络参数（弹道一致性）：fire/blt 必须携带实际速度/伤害/溅射标志。
// 否则房主与各接收端按默认参数重建弹道 → 与开火者本地弹道偏离（速度差 ~9%，300m 外偏差可达 20m+），
// 房主权威判定大量误判 miss → dmgReject 误回溯；AAGun 弹伤害还会被按 BASE_DMG 结算（2.5 倍）
function bulletNetParams(shot) {
  const b = shot.bullet;
  if (!b) return { s: 560, dm: BASE_DMG, sl: 0 };
  return { s: Math.round(b.vel.length()), dm: Math.max(1, Math.round(b.dmg)), sl: b.splash ? 1 : 0 };
}

// 机炮对地溅射：近失/落地爆炸对防空车造成范围伤害（解决高速俯冲难命中）
const SPLASH_R = 16;       // 溅射半径
const SPLASH_DMG = 6;      // 溅射基础伤害（距离衰减）
function spawnBullet(origin, dir, speed, src, dmg, splash) {
  const b = bullets.find((x) => !x.active);
  if (!b) return null;
  b.active = true; b.src = src; b.life = 3.4; b.dmg = dmg || BASE_DMG; b.splash = !!splash;
  // 复用防残留：弹池对象会跨发复用，上一发的开火对账状态必须全部清零，
  // 否则 foeBulletMiss 会把否决发给错误的玩家/序号，trust 会误登记到新弹道上
  b.fid = 0; b.fFrom = null; b.fHit = false; b.trust = null;
  b.pos.copy(origin); b.prev.copy(origin);
  b.vel.copy(dir).multiplyScalar(speed);
  b.mesh.visible = true;
  b.mesh.material = (src === 'me') ? tracerMatMe : tracerMatFoe;
  b.mesh.position.copy(origin);
  b.mesh.quaternion.setFromUnitVectors(Z_AXIS, dir);
  return b;
}

const _gunPos = new THREE.Vector3();
const _fireDir = new THREE.Vector3();
function fireGun(fighter, src) {
  fighter.gunSide = !fighter.gunSide;
  const off = fighter.plane.guns[fighter.gunSide ? 1 : 0];
  // 关键：枪口/弱点坐标是相对 mesh（机翼随 roll 滚转），必须用 mesh.matrixWorld（含 roll），
  // 不能用 group.matrixWorld（group 只有 yaw/pitch，无 roll）——否则转弯时机身倾斜而子弹从水平位置射出
  fighter.plane.group.updateMatrixWorld(true);
  _gunPos.copy(off).applyMatrix4(fighter.plane.mesh.matrixWorld);
  forwardOf(fighter, _fireDir);
  // 防空车玩法下机炮子弹带溅射（打地面也能伤到防空车）
  const b = spawnBullet(_gunPos, _fireDir, fighter.speed + 520, src, undefined, gamemode === 'aavs');
  effects.muzzle(_gunPos);
  return { origin: _gunPos.clone(), dir: _fireDir.clone(), bullet: b };
}

// 溅射伤害结算（距离衰减）；b 传入时用于房主端标记"已命中"（否决回溯对账）
function applySplashToAAGun(ag, pos, b) {
  const dist = ag.aagun.group.position.distanceTo(pos);
  if (dist > SPLASH_R) return;
  const dmg = Math.max(2, Math.round(SPLASH_DMG * (1 - dist / SPLASH_R)));
  showPart('溅射 ' + dmg);
  audio.hitConfirm(); effects.sparks(pos, 0xffcf6b);
  if (b) b.fHit = true;
  if (ag.hp - dmg <= 0 && (!b || b.src === 'me')) killCount++;   // 预判击杀只认自己的子弹；他人子弹由房主台账权威统计
  // 房主小世界：伤害裁决权在房主（权威扣血）；非房主端本地预判扣血（dmgReject 回溯 / sync 兜底）
  const splashKiller = b ? (b.src === 'me' ? myPeerId : (b.fFrom || null)) : null;   // 击杀归因：自己的弹=我；他人弹=开火者
  if (ag.isBot) { lastDmgFrom = splashKiller; ag.hp -= dmg; if (ag.hp <= 0) peerDie('bot'); lastDmgFrom = null; }
  else if (iAmHost) { lastDmgFrom = splashKiller; applyPeerDamage(ag.id, dmg); lastDmgFrom = null; }
  else if (mode === 'practice') ag.hp -= dmg;
  else {
    ag.hp -= dmg; ag.predTotal = (ag.predTotal || 0) + dmg;
    // 溅射命中上报（非房主 → 房主信任窗口判定）
    if (b && b.fid) { const hp3 = ag.aagun.group.position; netSendEventTo(hostPeerId, { t: 'hitRep', fid: b.fid, id: ag.id, p: [hp3.x, hp3.y, hp3.z], dmg }); }
  }
}

// 防空车高射机枪（低伤害高射速 + 散布）
const AAGUN_DMG = 4;
const _agMuzzle = new THREE.Vector3();
const _agDir = new THREE.Vector3();
const _agPos = new THREE.Vector3();
function fireGunAAGun(ag, src) {
  ag.gunSide = !ag.gunSide;
  ag.aagun.group.updateMatrixWorld(true);
  const mz = ag.aagun.gunMuzzles[ag.gunSide ? 1 : 0];
  _agMuzzle.copy(mz).applyMatrix4(ag.aagun.guns.matrixWorld);
  forwardOfTurret(ag, _agDir);
  // 机枪散布
  _agDir.x += (Math.random() - 0.5) * 0.016;
  _agDir.y += (Math.random() - 0.5) * 0.016;
  _agDir.z += (Math.random() - 0.5) * 0.016;
  _agDir.normalize();
  const b = spawnBullet(_agMuzzle, _agDir, 520, src, AAGUN_DMG);
  effects.muzzle(_agMuzzle);
  return { origin: _agMuzzle.clone(), dir: _agDir.clone(), bullet: b };
}

/* ================= 命中判定 ================= */
const _seg = new THREE.Vector3(), _toC = new THREE.Vector3(), _cp = new THREE.Vector3();
function segSphere(p0, p1, c, r) {
  _seg.copy(p1).sub(p0); const l2 = _seg.lengthSq(); let t = 0;
  if (l2 > 0) t = THREE.MathUtils.clamp(_toC.copy(c).sub(p0).dot(_seg) / l2, 0, 1);
  _cp.copy(p0).addScaledVector(_seg, t);
  return _cp.distanceToSquared(c) <= r * r;
}
function updateWeakWorld(plane) {
  plane.group.updateMatrixWorld(true);
  // 弱点坐标相对 mesh（含 roll 滚转），与枪口同理
  for (const wp of plane.weakPoints) wp._w.copy(wp.offset).applyMatrix4(plane.mesh.matrixWorld);
}
function checkBulletHit(b, plane) {
  updateWeakWorld(plane);
  for (const wp of plane.weakPoints) if (segSphere(b.prev, b.pos, wp._w, wp.r)) return wp;
  return null;
}
function checkAAGunHit(b, ag) {
  updateWeakAAGun(ag);
  for (const wp of ag.aagun.weakPoints) if (segSphere(b.prev, b.pos, wp._w, wp.r)) return wp;
  return null;
}

/* [ANDROID] v0.3.4：辅助瞄准已整体删除。
   v0.3.3 锁机制的实际缺陷：它把机头收敛到「相机→目标」连线，而子弹从机翼枪位（比相机低 ~3.6m、
   靠前 13.5m）射出，弹道与目标线平行偏低 ~2-2.5m——准星看着咬死目标、子弹却始终从下方擦过，
   结构性视差无法自愈，反而劣于手动瞄准，故删除，恢复与网页版完全一致的手动弹道。 */

/* ================= 地图碰撞 ================= */
const FUSE_R = 2.6;
function collideTerrain(plane) {
  if (!world) return null;
  const p = plane.group.position;
  for (const c of world.colliders) {
    if (c.s === 0) {
      tmpA.set(p.x - c.v.x, p.y - c.v.y, p.z - c.v.z);
      if (tmpA.lengthSq() <= (c.r + FUSE_R) * (c.r + FUSE_R)) {
        tmpA.normalize();
        return { normal: tmpA.clone(), pos: c.v.clone().addScaledVector(tmpA, c.r + FUSE_R) };
      }
    } else if (c.s === 1) {
      if (p.y - FUSE_R < c.h && Math.abs(p.x - c.x) - c.hx < FUSE_R && Math.abs(p.z - c.z) - c.hz < FUSE_R) {
        const dx = p.x - c.x, dz = p.z - c.z;
        let nx = 0, nz = 0;
        if (Math.abs(dx) * c.hz >= Math.abs(dz) * c.hx) nx = Math.sign(dx); else nz = Math.sign(dz);
        tmpA.set(nx, 0, nz).normalize();
        const ox = (nx !== 0 ? c.hx + FUSE_R : 0), oz = (nz !== 0 ? c.hz + FUSE_R : 0);
        return { normal: tmpA.clone(), pos: new THREE.Vector3(c.x + nx * ox, Math.min(p.y, c.h), c.z + nz * oz) };
      }
    }
  }
  return null;
}

/* ================= 队伍 / 回合 ================= */
// 子弹撞楼/撞山检测（点是否在任一碰撞体内；楼房=AABB，山/物体=球）
function hitWorldAt(p) {
  if (!world) return false;
  for (const c of world.colliders) {
    if (c.s === 1) {
      if (p.y < c.h && Math.abs(p.x - c.x) < c.hx && Math.abs(p.z - c.z) < c.hz) return true;
    } else {
      const dx = p.x - c.v.x, dy = p.y - c.v.y, dz = p.z - c.v.z;
      if (dx * dx + dy * dy + dz * dz < c.r2) return true;
    }
  }
  return false;
}

function teamAliveCount(team) {
  let n = 0;
  if (meIsAAGun) { if (meAAGun && meAAGun.alive && myTeam === team) n++; }
  else { if (me && me.alive && myTeam === team) n++; }
  for (const id in planes) if (planes[id].team === team && planes[id].alive) n++;
  for (const id in aaguns) if (aaguns[id].team === team && aaguns[id].alive) n++;
  return n;
}
function checkRoundEnd() {
  if (STATE.roundOver) return;
  // 联机模式下回合结算由房主权威：非房主只跟随房主的 rEnd / sync.over / round，
  // 绝不能本地自推进 —— 否则局号会跑到房主前面，之后房主的 round 推送因"局号不够大"被全部忽略，
  // 表现为：手机端飞机永久冻结（roundOver 卡死 + 实体不复位），但血量仍随 sync 更新。
  if (mode !== 'practice' && !iAmHost) return;
  const a0 = teamAliveCount(0), a1 = teamAliveCount(1);
  if (a0 === 0 && a1 === 0) { settleRound('draw'); return; }
  if (a0 === 0 && STATE.eliminatedTeam !== 0) { STATE.eliminatedTeam = 0; STATE.teamElimTimer = 0.8; }
  else if (a1 === 0 && STATE.eliminatedTeam !== 1) { STATE.eliminatedTeam = 1; STATE.teamElimTimer = 0.8; }
}
function syncScoreFromWorld() {
  // 队伍比分 → 本地视角比分（双方用同一份 s0/s1，保证一致）
  STATE.myScore = (myTeam === 0 ? STATE.s0 : STATE.s1);
  STATE.foeScore = (myTeam === 0 ? STATE.s1 : STATE.s0);
  updateScore();
}
function settleRound(winner) {
  if (STATE.roundOver) return;
  // 双保险：联机的"回合结算"只有房主有裁决权 —— 末端那个 3.2s 计时器有两支
  // （到 3 胜 → matchOver 结束整场；否则 → nextRound 开下一回合），任一支被非房主执行
  // 都会让本端局号脱离房主的标尺（历史 bug：手机端局号超前 → 飞机永久冻结）。
  if (mode !== 'practice' && !iAmHost) { STATE.roundOver = true; firing = false; return; }
  STATE.roundOver = true; firing = false; STATE.teamElimTimer = 0;
  let winTeam = -1;
  if (winner === 'me') { winTeam = myTeam; banner('回合胜利', '#7CFC98', 3); audio.roundWin(); }
  else if (winner === 'foe') { winTeam = 1 - myTeam; banner('回合失败', '#ff7a6b', 3); audio.roundLose(); }
  else { banner('双方同归于尽', '#ffe08a', 3); subBanner('平局 · 双方均不计分', 3); }
  if (winTeam === 0) STATE.s0++;
  else if (winTeam === 1) STATE.s1++;
  syncScoreFromWorld();
  // 房主小世界：房主权威推送回合结果（w=胜方队伍，-1 平局；非房主据此显示回合横幅/音效）
  if (mode !== 'practice' && iAmHost) netBroadcast({ t: 'rEnd', rn: STATE.roundNum, s0: STATE.s0, s1: STATE.s1, w: winTeam });
  // 3.2s 只用于「同一场内的回合衔接」：到 3 胜 → 结束整场（弹结算面板等玩家点「再来一局」，绝不自动开新场）；
  // 未分胜负 → 下一回合。非房主不执行本段，只跟随房主的 round / matchEnd 推送。
  setTimeout(() => {
    if (mode !== 'practice' && !iAmHost) return;
    if (STATE.s0 >= WIN_ROUNDS || STATE.s1 >= WIN_ROUNDS) matchOver(STATE.myScore > STATE.foeScore);
    else nextRound();
  }, 3200);
}

// pred=true：本地预判扣血（被打/轻撞的即时反馈），不触发本地死亡——死亡实时性不强，
// 完全由房主小世界权威判定后经 sync 推回（未命中时 sync 直接回溯血量）
function applyMeDamage(dmg, pred) {
  if (meIsAAGun) { applyMeAAGunDamage(dmg, pred); return; }
  if (!me.alive || STATE.roundOver) return;
  me.hp -= dmg;
  // 被打预判记账（问题：旧 sync 快照直接覆盖会"血量回满再扣回"→ 与 sync 对账 + 400ms 超时回滚）
  if (pred && mode !== 'practice') { me.predTotal = (me.predTotal || 0) + dmg; me.predT = performance.now(); }
  audio.damageTaken(); dmgFlashEl.style.opacity = 0.9; effects.shake(0.4);
  if (me.hp <= 0 && !pred) selfDestruct();
}
function applyMeAAGunDamage(dmg, pred) {
  if (!meAAGun.alive || STATE.roundOver) return;
  meAAGun.hp -= dmg;
  if (pred && mode !== 'practice') { meAAGun.predTotal = (meAAGun.predTotal || 0) + dmg; meAAGun.predT = performance.now(); }
  audio.damageTaken(); dmgFlashEl.style.opacity = 0.9; effects.shake(0.4);
  if (meAAGun.hp <= 0 && !pred) selfDestructAAGun();
}
function selfDestruct() {
  if (!me.alive || STATE.roundOver) return;
  me.alive = false;
  deathPos.copy(myPlane.group.position);
  effects.explosion(deathPos, 1.4); audio.explosion();
  myPlane.group.visible = false;
  if (mode !== 'practice' && iAmHost) { recordAuthKill(lastDmgFrom, myPeerId); lastDmgFrom = null; netBroadcast({ t: 'died', id: myPeerId }); }
  // 非房主本地死亡也必须上报：若本地 hp 因"未确认预判+环境伤害"混合提前归零而房主随后否决射击，
  // 权威 hp 永远 >0、sync 永不下发 al:false → 永久幽灵分歧（本地死亡/房主认为存活）。上报后房主权威对齐。
  if (mode !== 'practice' && !iAmHost && hostPeerId) netSendEventTo(hostPeerId, { t: 'died', id: myPeerId });
  // 房主小世界：死亡由房主权威判定与结算；非房主端回合/比分等房主 sync/rEnd 推送
  if (mode === 'practice' || iAmHost) checkRoundEnd();
}
function selfDestructAAGun() {
  if (!meAAGun.alive || STATE.roundOver) return;
  meAAGun.alive = false;
  deathPos.copy(myAAGun.group.position); deathPos.y += 2;
  effects.explosion(deathPos, 1.6); audio.explosion();
  myAAGun.group.visible = false;
  if (mode !== 'practice' && iAmHost) { recordAuthKill(lastDmgFrom, myPeerId); lastDmgFrom = null; netBroadcast({ t: 'died', id: myPeerId }); }
  if (mode !== 'practice' && !iAmHost && hostPeerId) netSendEventTo(hostPeerId, { t: 'died', id: myPeerId });
  // 同上：房主权威结算
  if (mode === 'practice' || iAmHost) checkRoundEnd();
}
// 房主端：非房主死亡判定（房主小世界权威），结算由房主统一推送
function peerDie(id) {
  const pl = planes[id];
  if (pl && pl.alive && !STATE.roundOver) {
    pl.alive = false;
    effects.explosion(pl.plane.group.position, 1.4); audio.explosion();
    pl.plane.group.visible = false;
    // 回合结束检查：房主权威 + 人机模式（practice 下 iAmHost=false，漏了会"击杀 bot 不判胜利"）
    if (iAmHost || mode === 'practice') { recordAuthKill(lastDmgFrom, id); lastDmgFrom = null; checkRoundEnd(); }
    return;
  }
  const ag = aaguns[id];
  if (ag && ag.alive && !STATE.roundOver) {
    ag.alive = false;
    effects.explosion(ag.aagun.group.position, 1.6); audio.explosion();
    ag.aagun.group.visible = false;
    if (iAmHost || mode === 'practice') { recordAuthKill(lastDmgFrom, id); lastDmgFrom = null; checkRoundEnd(); }
  }
}
// 房主端：对非房主实体权威扣血（房主小世界结算）
function applyPeerDamage(id, dmg) {
  const pl = planes[id];
  if (pl && pl.alive) { pl.hp -= dmg; if (pl.hp <= 0) peerDie(id); return; }
  const ag = aaguns[id];
  if (ag && ag.alive) { ag.hp -= dmg; if (ag.hp <= 0) peerDie(id); }
}
// 碰撞去重：同一对实体（双方各自检测/上报）只允许权威结算一次（1.5s 窗口）
function markCrashPair(a, b) {
  if (!a || !b) return false;
  const key = a < b ? a + '|' + b : b + '|' + a;
  const now = performance.now();
  if (crashPairs.has(key) && now - crashPairs.get(key) < 1500) return false;
  crashPairs.set(key, now);
  return true;
}
// 非房主：记录一次本地预判扣血（等房主权威确认或否决）；顺带清理 5s 前的过期记录
function recordFirePred(fid, id, dmg) {
  if (!fid) return;
  const now = performance.now();
  for (const k in firePred) if (now - firePred[k].t > 5000) delete firePred[k];
  firePred[fid] = { id, dmg, t: now };
}
// 房主：非房主上报的子弹未命中任何目标而消失 → 进入延迟否决队列（等 220ms 收 hitRep，过期才否决）
// 注意：fid 是各玩家独立计数，跨玩家会撞号 → 映射/已否决表一律用 "发送者id:fid" 复合键
function foeBulletMiss(b) {
  if (iAmHost && b && b.fFrom && !b.fHit) {
    if (b.fid) delete fireBullets[b.fFrom + ':' + b.fid];
    pendingRejects.push({ fid: b.fid, from: b.fFrom, expire: performance.now() + 220 });
  }
}
// 房主：信任结算（hitRep 声称命中 / 宽容延迟补偿），覆盖 bot / 远程玩家 / 房主自己
function trustDamage(id, dmg) {
  if (id === myPeerId) { if (meIsAAGun) applyMeAAGunDamage(dmg); else applyMeDamage(dmg); return; }
  const pl = planes[id];
  if (pl && pl.alive) { if (pl.isBot) { pl.hp -= dmg; if (pl.hp <= 0) peerDie('bot'); } else applyPeerDamage(id, dmg); return; }
  const ag = aaguns[id];
  if (ag && ag.alive) { if (ag.isBot) { ag.hp -= dmg; if (ag.hp <= 0) peerDie('bot'); } else applyPeerDamage(id, dmg); }
}
// 每帧网络对账杂项：否决队列过期下发 + 被打预判超时回滚（房主 400ms 未确认视为否决，sync 到达后自愈）
function processNetReconcile() {
  const now = performance.now();
  for (let i = pendingRejects.length - 1; i >= 0; i--) {
    const r = pendingRejects[i];
    if (now >= r.expire) {
      pendingRejects.splice(i, 1);
      rejectedFids.set(r.from + ':' + r.fid, now);   // 记入已否决表（复合键）：迟到的 hitRep 到达时忽略（防双结算）
      netSendEventTo(r.from, { t: 'dmgReject', fid: r.fid });
    }
  }
  for (const [k, t] of rejectedFids) if (now - t > 5000) rejectedFids.delete(k);
  if (me && me.predTotal && now - (me.predT || 0) > 400) { me.hp += me.predTotal; me.predTotal = 0; }
  if (meAAGun && meAAGun.predTotal && now - (meAAGun.predT || 0) > 400) { meAAGun.hp += meAAGun.predTotal; meAAGun.predTotal = 0; }
}

/* ================= 房主权威击杀台账（kstat） =================
   所有死亡裁决都在房主小世界完成：peerDie / selfDestruct 触发时按 lastDmgFrom 记"谁击杀了谁"，
   每 3s 把每人的 {击杀 k, 阵亡 d} 定向发给对应玩家。非房主端 killCount 以 kstat 为权威覆盖，
   本地预判 +1 只做即时反馈（与伤害的 预判+对账 模式一致）；本地子弹被 dmgReject 否决时，
   击杀数会在下一次 kstat 自动纠正（此前只增不减的问题由此根治）。 */
const killLedger = {};      // id -> { k: 击杀数, d: 阵亡数 }（整场比赛累计，开赛/重赛清零）
let lastDmgFrom = null;     // 即将发生的权威伤害来源（死亡判定同步读取并消费；每次伤害调用后必须清空）
let lastKstatPush = 0;
function ledgerOf(id) { if (!killLedger[id]) killLedger[id] = { k: 0, d: 0 }; return killLedger[id]; }
function recordAuthKill(killer, victim) {
  if (mode === 'practice') return;   // 练习模式无台账（纯本地）
  if (killer) ledgerOf(killer).k++;  // killer 为空 = 环境/自毁，只记阵亡
  ledgerOf(victim).d++;
}
function resetKillLedger() { for (const k in killLedger) delete killLedger[k]; lastDmgFrom = null; }

// 房主端：20Hz 推送小世界权威快照（所有玩家位置/血量/存活 + 队伍比分 + 局号）
function pushWorldSync() {
  if (mode === 'practice' || Object.keys(nets).length === 0) return;
  const lst = [];
  if (meIsAAGun) lst.push({ id: myPeerId, p: myAAGun.group.position.toArray(), hp: Math.max(0, Math.round(meAAGun.hp)), al: meAAGun.alive, ty: meAAGun.turretYaw, tp: meAAGun.turretPitch, by: meAAGun.bodyYaw });
  else { const q = myPlane.group.quaternion; lst.push({ id: myPeerId, p: myPlane.group.position.toArray(), q: [q.x, q.y, q.z, q.w], hp: Math.max(0, Math.round(me.hp)), al: me.alive }); }
  for (const id in planes) { const pl = planes[id]; const q = pl.tQuat; lst.push({ id, p: pl.tPos.toArray(), q: [q.x, q.y, q.z, q.w], hp: Math.max(0, Math.round(pl.hp)), al: pl.alive }); }
  for (const id in aaguns) { const ag = aaguns[id]; lst.push({ id, p: ag.tPos.toArray(), hp: Math.max(0, Math.round(ag.hp)), al: ag.alive, ty: ag.tTurretYaw, tp: ag.tTurretPitch, by: ag.tBodyYaw }); }
  netSendState({ t: 'sync', lst, s0: STATE.s0, s1: STATE.s1, rn: STATE.roundNum, over: STATE.roundOver });
  // 击杀台账定向下发（3s 一次）：每人只收到自己的权威 {击杀 k, 阵亡 d}；房主自己的显示同样以台账为准
  const nowK = performance.now();
  if (nowK - lastKstatPush > 3000) {
    lastKstatPush = nowK;
    killCount = ledgerOf(myPeerId).k;
    for (const p of roster) {
      if (p.peerId === myPeerId || !nets[p.peerId] || !nets[p.peerId].connected) continue;
      const ke = ledgerOf(p.peerId);
      netSendEventTo(p.peerId, { t: 'kstat', k: ke.k, d: ke.d });
    }
  }
}

/* ================= 单位创建/清理 ================= */
function clearUnits() {
  if (myPlane) { scene.remove(myPlane.group); myPlane = null; me = null; }
  if (myAAGun) { scene.remove(myAAGun.group); myAAGun = null; meAAGun = null; }
  for (const id in planes) scene.remove(planes[id].plane.group);
  for (const k in planes) delete planes[k];
  for (const id in aaguns) scene.remove(aaguns[id].aagun.group);
  for (const k in aaguns) delete aaguns[k];
  bot = null;
}

// 防空车实体工厂
function makeAAGunUnit(peerId, team, slot, color) {
  const ag = buildAAGun(color); scene.add(ag.group);
  const ent = makeAAGun(ag);
  aaguns[peerId] = {
    id: peerId, aagun: ag, ent, team, slot,
    alive: true, hp: AAGUN_HP,
    tPos: new THREE.Vector3(), tTurretYaw: 0, tTurretPitch: 0, tBodyYaw: 0,
    lastState: 0, isBot: false
  };
  return aaguns[peerId];
}

// 联机：按 roster 构建飞机（team0=空战双方 / aavs 的飞机阵营）与防空车（aavs 的 team1）
function buildAllUnits() {
  clearUnits();
  const ts = netSize / 2;
  const aaSpawns = (world && world.aaSpawns) ? world.aaSpawns : null;

  // 玩家实体
  const myR = roster.find(p => p.peerId === myPeerId) || { peerId: myPeerId, team: myTeam, slot: mySlot };
  myTeam = myR.team; mySlot = myR.slot;
  if (gamemode === 'aavs' && myR.team === 1) {
    // 玩家是防空车阵营
    meIsAAGun = true;
    myAAGun = buildAAGun(0x3fa7ff); scene.add(myAAGun.group);
    meAAGun = makeAAGun(myAAGun);
    myAAGun.group.position.copy(aagunSpawnPos(myR.slot, aaSpawns));
  } else {
    meIsAAGun = false;
    myPlane = buildPlane(0x3fa7ff); scene.add(myPlane.group);
    me = makeFighter(myPlane);
  }

  // 其他玩家单位
  for (const p of roster) {
    if (p.peerId === myPeerId) continue;
    if (p.team < 0) continue;   // 尚未分配阵营的占位，跳过
    const isFoe = p.team !== myTeam;
    const color = isFoe ? 0xff5340 : 0x3fa7ff;
    if (gamemode === 'aavs' && p.team === 1) {
      const unit = makeAAGunUnit(p.peerId, p.team, p.slot, color);
      unit.aagun.group.position.copy(aagunSpawnPos(p.slot, aaSpawns));
    } else {
      const pl = buildPlane(color); scene.add(pl.group);
      planes[p.peerId] = {
        id: p.peerId, plane: pl, team: p.team, slot: p.slot,
        alive: true, hp: 100, tPos: new THREE.Vector3(), tQuat: new THREE.Quaternion(),
        lastState: 0, isBot: false
      };
    }
  }
}

// 练习模式（人机对决）：固定 1v1
// side: dogfight → 玩家=蓝方飞机；aavs → 'plane'(玩家飞机) | 'aagun'(玩家防空车)
function startPractice(gm, side, map) {
  mode = 'practice';
  practiceSize = 2;
  gamemode = gm;
  mySlot = 0;
  rebuildWorld(map);
  clearUnits();
  const aaSpawns = (world && world.aaSpawns) ? world.aaSpawns : null;

  if (gamemode === 'aavs') {
    // 防空车vs飞机：team0=飞机阵营，team1=防空车阵营
    if (side === 'aagun') {
      // 玩家操控防空车
      myTeam = 1; meIsAAGun = true;
      myAAGun = buildAAGun(0x3fa7ff); scene.add(myAAGun.group);
      meAAGun = makeAAGun(myAAGun);
      myAAGun.group.position.copy(aagunSpawnPos(0, aaSpawns));
      // AI 飞机（追防空车）
      const fp = buildPlane(0xff5340); scene.add(fp.group);
      const b = new Bot(fp); b.id = 'bot'; b.groundTarget = true;
      planes['bot'] = {
        id: 'bot', plane: fp, team: 0, slot: 0,
        alive: true, hp: 100, tPos: new THREE.Vector3(), tQuat: new THREE.Quaternion(),
        lastState: 0, isBot: true, bot: b
      };
    } else {
      // 玩家操控飞机
      myTeam = 0; meIsAAGun = false;
      myPlane = buildPlane(0x3fa7ff); scene.add(myPlane.group);
      me = makeFighter(myPlane);
      // AI 防空车
      const ag = buildAAGun(0xff5340); scene.add(ag.group);
      const ent = makeAAGun(ag);
      const ab = new AAGunBot(ent);
      aaguns['bot'] = {
        id: 'bot', aagun: ag, ent, team: 1, slot: 0,
        alive: true, hp: AAGUN_HP,
        tPos: new THREE.Vector3(), tTurretYaw: 0, tTurretPitch: 0,
        lastState: 0, isBot: true, bot: ab
      };
      aaguns['bot'].aagun.group.position.copy(aagunSpawnPos(0, aaSpawns));
    }
  } else {
    // 空战狗斗：玩家飞机 vs AI飞机
    myTeam = 0; meIsAAGun = false;
    myPlane = buildPlane(0x3fa7ff); scene.add(myPlane.group);
    me = makeFighter(myPlane);
    const fp = buildPlane(0xff5340); scene.add(fp.group);
    const b = new Bot(fp); b.id = 'bot';
    planes['bot'] = {
      id: 'bot', plane: fp, team: 1, slot: 0,
      alive: true, hp: 100, tPos: new THREE.Vector3(), tQuat: new THREE.Quaternion(),
      lastState: 0, isBot: true, bot: b
    };
  }
  beginMatch();
}

function nextRound(targetRn) {
  if (STATE.matchEnded) return;   // 比赛已结束（如房主掉线）不再开新回合
  if (!STATE.started) return;     // 尚未开局（beginMatch 前）：sync 兜底/乱序消息不得提前重置（me/myPlane 为空会空引用崩溃）
  // 局号：房主本地自增；非房主由 'round' 消息 / sync 兜底指定（幂等：rn 不超前则被调用方过滤）
  STATE.roundNum = (targetRn !== undefined) ? targetRn : STATE.roundNum + 1;
  STATE.roundOver = false;
  STATE.eliminatedTeam = -1; STATE.teamElimTimer = 0;
  if (mode !== 'practice' && iAmHost) netBroadcast({ t: 'round', rn: STATE.roundNum });   // 房主权威推送局号
  const ts = (mode === 'practice') ? (practiceSize / 2) : (netSize / 2);
  const aaSpawns = (world && world.aaSpawns) ? world.aaSpawns : null;
  aimYaw = 0; aimPitch = 0;

  // 玩家实体重置
  if (meIsAAGun) {
    meAAGun.hp = AAGUN_HP; meAAGun.alive = true;
    meAAGun.turretYaw = (myTeam === 0) ? 0 : Math.PI; meAAGun.turretPitch = 0.35;
    meAAGun.bodyYaw = (myTeam === 0) ? 0 : Math.PI; meAAGun.speed = 0; meAAGun.targetSpeed = 0;
    myAAGun.group.position.copy(aagunSpawnPos(mySlot, aaSpawns));
    myAAGun.group.visible = true;
    applyAAGun(meAAGun);
  } else {
    me.hp = 100; me.alive = true; me.speed = me.targetSpeed = 95;
    me.pitch = me.roll = me.yawVel = 0;
    me.yaw = (myTeam === 0) ? 0 : Math.PI;
    myPlane.group.position.copy(spawnPos(myTeam, mySlot, ts));
    myPlane.group.visible = true;
  }

  for (const id in planes) {
    const pl = planes[id];
    pl.hp = 100; pl.alive = true;
    pl.predTotal = 0; pl.lastAuth = undefined;   // 清除预判对账（新回合权威值重新起算）
    pl.plane.group.position.copy(spawnPos(pl.team, pl.slot, ts));
    pl.plane.group.visible = true;
    if (pl.isBot && pl.bot) pl.bot.reset(pl.plane.group.position, pl.team === 0 ? 0 : Math.PI);
  }
  for (const id in aaguns) {
    const ag = aaguns[id];
    ag.hp = AAGUN_HP; ag.alive = true;
    ag.predTotal = 0; ag.lastAuth = undefined;   // 清除预判对账
    ag.aagun.group.position.copy(aagunSpawnPos(ag.slot, aaSpawns));
    ag.aagun.group.visible = true;
    ag.ent.turretYaw = (ag.team === 0) ? 0 : Math.PI; ag.ent.turretPitch = 0.35;
    ag.ent.bodyYaw = (ag.team === 0) ? 0 : Math.PI; ag.ent.speed = 0; ag.ent.targetSpeed = 0;
    if (ag.isBot && ag.bot) ag.bot.reset(ag.aagun.group.position);
    else { applyAAGun(ag.ent); }
  }
  for (const k in firePred) delete firePred[k];   // 清空开火对账记录
  for (const k in fireBullets) delete fireBullets[k];   // 清空房主 fid->子弹映射
  pendingRejects.length = 0;                      // 清空待否决队列
  rejectedFids.clear();                           // 清空已否决 fid 表
  if (me) { me.predTotal = 0; me.lastAuth = undefined; }
  if (meAAGun) { meAAGun.predTotal = 0; meAAGun.lastAuth = undefined; }
  for (const b of bullets) { b.active = false; b.mesh.visible = false; }
  roundLabelEl.textContent = '第 ' + STATE.roundNum + ' 回合';
  banner('第 ' + STATE.roundNum + ' 回合', '#dff1ff', 1.6);
}

function matchOver(iWon) {
  STATE.matchEnded = true;
  // 房主小世界：房主权威推送胜利判定，非房主端由 matchEnd 消息应用
  if (mode !== 'practice' && iAmHost) netBroadcast({ t: 'matchEnd', win: iWon, s0: STATE.s0, s1: STATE.s1 });
  applyMatchEnd(iWon);
}
// 非房主端应用房主权威的胜利判定
function applyMatchEnd(iWon) {
  STATE.matchEnded = true;
  matchTitle.textContent = iWon ? '最终胜利' : '惜败';
  matchTitle.style.color = iWon ? '#7CFC98' : '#ff7a6b';
  matchSub.textContent = '总比分 ' + STATE.myScore + ' : ' + STATE.foeScore + '（五局三胜）';
  $('btnRematch').classList.remove('hidden');
  matchPanel.classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
}
function lockPointer() { if (isTouch) return; try { canvas.requestPointerLock(); } catch (e) {} }
function applyRematch() {
  STATE.matchEnded = false; STATE.myScore = 0; STATE.foeScore = 0; STATE.s0 = 0; STATE.s1 = 0; STATE.roundNum = 0;
  killCount = 0; resetKillLedger();
  updateScore(); matchPanel.classList.add('hidden'); nextRound(); lockPointer();
}
// 是否有对方队伍玩家（决定能否重赛；队友不算对手）
function hasOpponent() {
  if (mode === 'practice') return true;
  for (const p of roster) if (p.peerId !== myPeerId && p.team !== myTeam) return true;
  return false;
}
$('btnRematch').onclick = () => {
  // 对手已全部离开（先退出后重赛）：拒绝重赛，避免进入空地图
  if (mode !== 'practice' && !hasOpponent()) {
    matchTitle.textContent = '对局结束';
    matchTitle.style.color = '#ffd27a';
    matchSub.textContent = '对手已离开，无法继续对战';
    $('btnRematch').classList.add('hidden');
    return;
  }
  if (mode !== 'practice') netBroadcast({ t: 'rematch' });
  applyRematch();
};
$('btnBackMenu').onclick = () => location.reload();

// 观战状态：必须声明在输入监听器之前——手机端初始化未完成时的合成 mousedown 会立刻触发
// 下面的监听器，若 spec 还在暂时性死区（TDZ）会抛 "Cannot access 'spec' before initialization"。
const spec = { active: false, yaw: 0.6, pitch: 0.32, dist: 30, targetId: null };
let specLabel = null;

/* ================= 键鼠/触屏输入 ================= */
window.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (!locked && STATE.started && !STATE.matchEnded && !isTouch) { pauseEl.classList.remove('hidden'); firing = false; zoom = false; }
  else pauseEl.classList.add('hidden');
});
pauseEl.addEventListener('click', () => { if (STATE.started && !STATE.matchEnded) lockPointer(); });
document.addEventListener('mousemove', (e) => { if (!locked) return; accX += e.movementX; accY += e.movementY; });
document.addEventListener('mousedown', (e) => { if (!locked) return; if (e.button === 0) firing = true; if (e.button === 2) zoom = true; });
// 观战交互：左键切换目标 / 滚轮缩放距离
document.addEventListener('mousedown', (e) => { if (typeof spec !== 'undefined' && spec.active && e.button === 0) specPick(true); });
document.addEventListener('wheel', (e) => {
  if (typeof spec === 'undefined' || !spec.active) return;
  spec.dist = THREE.MathUtils.clamp(spec.dist * Math.exp(e.deltaY * 0.0012), 12, 130);
}, { passive: true });
document.addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; if (e.button === 2) zoom = false; });
const keys = {};
document.addEventListener('keydown', (e) => { keys[e.code] = true; if (e.code === 'KeyM') audio.toggleMute(); if (e.code === 'KeyT' && !e.repeat) toggleMicSend(); if (e.code === 'KeyY' && !e.repeat) toggleVoiceRx(); });
document.addEventListener('keyup', (e) => { keys[e.code] = false; });

if (isTouch) {
  const steerZone = $('steerZone');
  let steerId = null, lastSX = 0, lastSY = 0;
  steerZone.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (steerId !== null) return;
    const t = e.changedTouches[0]; steerId = t.identifier; lastSX = t.clientX; lastSY = t.clientY;
  }, { passive: false });
  steerZone.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === steerId) { accX += (t.clientX - lastSX) * TOUCH_SENS; accY += (t.clientY - lastSY) * TOUCH_SENS; lastSX = t.clientX; lastSY = t.clientY; }
  }, { passive: false });
  const steerEnd = (e) => { for (const t of e.changedTouches) if (t.identifier === steerId) steerId = null; };
  steerZone.addEventListener('touchend', steerEnd); steerZone.addEventListener('touchcancel', steerEnd);

  const joyBase = $('joyBase'), joyKnob = $('joyKnob');
  let joyId = null;
  const setJoy = (dx, dy) => {
    const cx = THREE.MathUtils.clamp(dx, -46, 46);
    const cy = THREE.MathUtils.clamp(dy, -46, 46);
    joyKnob.style.transform = 'translate(-50%,-50%) translate(' + cx + 'px,' + cy + 'px)';
    if (STATE.started && !STATE.roundOver) {
      if (meIsAAGun && meAAGun && meAAGun.alive) {
        // 防空车：上下 = 前进/后退（上推 cy 为负 → 取负得正速度 = 前进）
        meAAGun.targetSpeed = THREE.MathUtils.clamp((-cy / 46) * 12, -6, 12);   // 履带车约 12 单位/s ≈ 43 km/h
      } else if (me && me.alive) {
        // 飞机：上下 = 加速/减速
        me.targetSpeed = THREE.MathUtils.clamp(107.5 - (cy / 46) * 62.5, SPEED_MIN, SPEED_MAX);
      }
    }
    // X轴：左右 = 转向（存值供 tick 持续应用）
    joySteerX = cx / 46;
  };
  joyBase.addEventListener('touchstart', (e) => { e.preventDefault(); const t = e.changedTouches[0]; joyId = t.identifier; const r = joyBase.getBoundingClientRect(); setJoy(t.clientX - (r.left + r.width / 2), t.clientY - (r.top + r.height / 2)); }, { passive: false });
  joyBase.addEventListener('touchmove', (e) => { e.preventDefault(); const r = joyBase.getBoundingClientRect(); for (const t of e.changedTouches) if (t.identifier === joyId) setJoy(t.clientX - (r.left + r.width / 2), t.clientY - (r.top + r.height / 2)); }, { passive: false });
  joyBase.addEventListener('touchend', (e) => { for (const t of e.changedTouches) if (t.identifier === joyId) { joyId = null; setJoy(0, 0); } });

  const btnFire = $('btnFire'), btnZoom = $('btnZoom');
  btnFire.addEventListener('touchstart', (e) => { e.preventDefault(); audio.resume(); firing = true; }, { passive: false });
  btnFire.addEventListener('touchend', (e) => { e.preventDefault(); firing = false; }, { passive: false });
  btnZoom.addEventListener('touchstart', (e) => { e.preventDefault(); zoom = true; }, { passive: false });
  btnZoom.addEventListener('touchend', (e) => { e.preventDefault(); zoom = false; }, { passive: false });
  // 语音：手机端没有 T/Y 键，用右上角两个触屏按钮
  const btnMic = $('btnMic'), btnRx = $('btnRx');
  if (btnMic) btnMic.addEventListener('touchstart', (e) => { e.preventDefault(); audio.resume(); toggleMicSend().then(syncVoiceBtn); }, { passive: false });
  if (btnRx) btnRx.addEventListener('touchstart', (e) => { e.preventDefault(); toggleVoiceRx(); syncVoiceBtn(); }, { passive: false });
  // 注意：这里不能立刻调用 syncVoiceBtn()——micOn/voiceRxOn 声明在文件后段，
  // 移动端在模块初始化期间执行本块会撞上 TDZ；改为开局时同步（见 beginMatch）
}

/* ================= 选阵营系统（3v3/5v5 开局前，1v1 跳过） ================= */
function countPickTeam(side) {
  let n = 0;
  for (const id in pickSelections) if (pickSelections[id] === side) n++;
  return n;
}
// 房主：开始选阵营
function startPickPhase() {
  pickPhase = true;
  pickRound++;                       // 表格编号递增（幂等：旧编号的重置/人数消息丢弃）
  pickSelections = {}; pickReadySet = new Set();
  pickWaitingReady = false;
  pickStartTs = performance.now();
  myPickSide = -1; pickListGot = null;
  // 房主端也要用真实容量与人数（否则界面显示默认的 0/2，且满员判断失效→可重复选）
  // 奇数人数（掉线后 5/7/9 人）：一队 floor 一队 ceil，否则总容量 < 人数 → 永远凑不齐 → 选阵营死锁
  pickTs0 = Math.max(1, Math.floor(netSize / 2));
  pickTs1 = Math.max(1, netSize - pickTs0);
  curPickC0 = 0; curPickC1 = 0;
  clearInterval(pickCountTimer);
  hideAllPanels();
  netBroadcast({ t: 'pickStart', round: pickRound });
  setupPickUI(); $('pickPanel').classList.remove('hidden');
  broadcastPickCount();
  pickCountTimer = setInterval(() => { if (pickPhase) broadcastPickCount(); }, 800);   // 固定频率广播人数
}
// 房主：广播两阵营人数（变化时 + 定时器）；全员选满则定向发放名单
function broadcastPickCount() {
  if (!pickPhase) return;
  // 选阵营超时（45s）：未选的玩家（挂机/失联）自动分配到人少的阵营，避免全员无限等待
  if (performance.now() - pickStartTs > 45000) {
    const candidates = [myPeerId, ...roster.map(p => p.peerId)];
    for (const id of candidates) {
      if (pickSelections[id] !== undefined) continue;
      const c0 = countPickTeam(0), c1 = countPickTeam(1);
      pickSelections[id] = (c0 <= c1 && c0 < pickTs0) ? 0 : (c1 < pickTs1 ? 1 : (c0 < pickTs0 ? 0 : 1));
      if (id === myPeerId) { myPickSide = pickSelections[id]; updatePickUI(); }
    }
  }
  const c0 = countPickTeam(0), c1 = countPickTeam(1);
  // 房主自己也更新界面（显示实时人数 + 正确容量）
  curPickC0 = c0; curPickC1 = c1;
  updatePickUI();
  netBroadcast({ t: 'pickCount', c0, c1, t0: pickTs0, t1: pickTs1, round: pickRound });
  if (c0 + c1 >= netSize && c0 <= pickTs0 && c1 <= pickTs1) completePickAndDeal();
}
// 房主：选阵营完成 → 应用名单并按"每人的队友/对手视角"定向发放；进入等待就绪阶段
// 房主：掉线导致人数下降后重算容量，并把"超额"留在一队的人移到另一队。
// 场景：10 人时 5 人都选了 A 队（当时容量 5，合法），掉到 3 人后 A 容量只剩 1 →
// 若不重平衡会出现 A 队 3 人、B 队 0 人，空队每回合立刻被判负（白送 3 个回合）。
// 只有房主执行；玩家端队伍信息完全来自 pickList，因此移动是安全的。
function rebalancePicks() {
  pickTs0 = Math.max(1, Math.floor(netSize / 2));
  pickTs1 = Math.max(1, netSize - pickTs0);
  const ids0 = [], ids1 = [];
  for (const id in pickSelections) (pickSelections[id] === 0 ? ids0 : ids1).push(id);
  ids0.sort(); ids1.sort();                 // 确定性顺序，便于复现
  while (ids0.length > pickTs0) { const id = ids0.pop(); pickSelections[id] = 1; ids1.push(id); }
  while (ids1.length > pickTs1) { const id = ids1.pop(); pickSelections[id] = 0; ids0.push(id); }
  curPickC0 = ids0.length; curPickC1 = ids1.length;
  updatePickUI();
}
function completePickAndDeal() {
  pickPhase = false;
  pickWaitingReady = true;   // ready 消息靠这个标志接收
  clearInterval(pickCountTimer);
  const teams = {};
  for (const id in pickSelections) teams[id] = pickSelections[id];
  applyPickTeams(teams);          // 房主端先应用（team/slot 落到 roster）
  for (const id in teams) {
    if (id === myPeerId) continue;
    const myT = teams[id];
    const myP = roster.find(x => x.peerId === id);
    const mates = [], foes = [];
    for (const oid in teams) {
      if (oid === id) continue;
      const osp = (roster.find(x => x.peerId === oid) || {}).slot || 0;
      (teams[oid] === myT ? mates : foes).push([oid, osp]);
    }
    netSendEventTo(id, { t: 'pickList', team: myT, slot: (myP || {}).slot || 0, m: mates, f: foes, round: pickRound });
  }
  pickListGot = true;   // 房主标记名单已发放
  hideAllPanels();
}
// 房主：就绪人数达标 → 广播 go 开局（ready 处理器与掉线强制完成路径共用）
function tryStartMatchFromReady() {
  if (!pickWaitingReady) return;
  if (pickReadySet.size >= Math.max(1, netSize - 1)) {   // 房主自己不需要 ready
    pickWaitingReady = false;
    netBroadcast({ t: 'go', map: STATE.mapType });
    beginMatch();
  }
}
// 玩家端/房主：阵营 UI
function setupPickUI() {
  const aavs = gamemode === 'aavs';
  $('pickName0').textContent = aavs ? '✈ 飞机' : '🔴 红队';
  $('pickName1').textContent = aavs ? '🛡 防空车' : '🔵 蓝队';
  if (!pickUIReady) {
    pickUIReady = true;
    $('pickSide0').onclick = () => selectPick(0);
    $('pickSide1').onclick = () => selectPick(1);
  }
  updatePickUI();
}
function selectPick(side) {
  if (myPickSide >= 0) { showPickStatus('已选择，不可更改', '#7ea7c8'); return; }
  const c = side === 0 ? curPickC0 : curPickC1;
  const cap = side === 0 ? pickTs0 : pickTs1;
  if (c >= cap) { showPickStatus('该阵营已满，请选择另一阵营', '#ffb3a0'); return; }
  myPickSide = side;
  if (iAmHost) { pickSelections[myPeerId] = side; broadcastPickCount(); }
  else netSendEventTo(hostPeerId, { t: 'pick', side });
  updatePickUI();
  showPickStatus('已选择，等待其他玩家…', '#7CFC98');
}
function showPickStatus(text, color) {
  $('pickStatus').textContent = text;
  $('pickStatus').style.color = color || '#7ea7c8';
}
function updatePickUI() {
  $('pickSide0').classList.toggle('sel', myPickSide === 0);
  $('pickSide1').classList.toggle('sel', myPickSide === 1);
  $('pickSide0').classList.toggle('full', curPickC0 >= pickTs0);
  $('pickSide1').classList.toggle('full', curPickC1 >= pickTs1);
  $('pickFill0').style.width = (Math.min(1, curPickC0 / Math.max(1, pickTs0)) * 100) + '%';
  $('pickFill1').style.width = (Math.min(1, curPickC1 / Math.max(1, pickTs1)) * 100) + '%';
  $('pickCount0').textContent = curPickC0 + ' / ' + pickTs0;
  $('pickCount1').textContent = curPickC1 + ' / ' + pickTs1;
}
// 房主端：应用完整名单（房主自己有权知道自己以外所有人的分配，用于小世界权威结算）
function applyPickTeams(teams) {
  for (const id in teams) {
    const p = roster.find(x => x.peerId === id);
    if (p) p.team = teams[id];
    else roster.push({ peerId: id, team: teams[id], slot: 0 });
  }
  const slots0 = [], slots1 = [];
  for (const id in teams) (teams[id] === 0 ? slots0 : slots1).push(id);
  slots0.forEach((id, i) => { const p = roster.find(x => x.peerId === id); if (p) p.slot = i; });
  slots1.forEach((id, i) => { const p = roster.find(x => x.peerId === id); if (p) p.slot = i; });
  const me = roster.find(x => x.peerId === myPeerId);
  if (me) { myTeam = me.team; mySlot = me.slot; }
}
// 玩家端：upsert 一条 roster 记录（定向分配消息的队友/对手落位）
function upsertRoster(id, team, slot) {
  let p = roster.find(x => x.peerId === id);
  if (!p) { p = { peerId: id, team, slot: 0 }; roster.push(p); }
  if (team >= 0) p.team = team;
  if (slot >= 0) p.slot = slot;
}

/* ================= 联机事件路由 ================= */
function onPeerState(peerId, d) {
  const rid = d.sender || peerId;
  if (d.t === 'voice') { onVoiceMsg(rid, d); return; }   // 语音包独立分发（房主转发+本地播放）
  if (d.t === 'upd') {
    // 非房主 → 房主：位置/朝向上报，房主小世界权威更新与死亡判定
    if (!iAmHost) return;
    if (d.seq !== undefined) { if (d.seq <= (lastUpdSeq[rid] || 0)) return; lastUpdSeq[rid] = d.seq; }
    const now = performance.now();
    const pl = planes[rid];
    if (pl) {
      pl.tPos.fromArray(d.p);
      if (d.q) pl.tQuat.set(d.q[0], d.q[1], d.q[2], d.q[3]);
      pl.lastState = now;
      // 撞地检测：房主权威判定非房主飞机坠毁
      if (pl.alive && !STATE.roundOver && d.p[1] <= 0.9) {
        pl.alive = false; pl.plane.group.visible = false;
        effects.explosion(pl.plane.group.position, 1.4); audio.explosion();
        checkRoundEnd();
      }
      return;
    }
    const ag = aaguns[rid];
    if (ag) {
      ag.tPos.fromArray(d.p);
      if (typeof d.ty === 'number') { ag.tTurretYaw = d.ty; ag.tTurretPitch = d.tp || 0; }
      if (typeof d.by === 'number') ag.tBodyYaw = d.by;
      ag.lastState = now;
      // 防空车出海（>430）房主权威判死
      if (ag.alive && !STATE.roundOver && Math.hypot(d.p[0], d.p[2]) > 430) {
        ag.alive = false; ag.aagun.group.visible = false;
        effects.explosion(ag.aagun.group.position, 1.6); audio.explosion();
        checkRoundEnd();
      }
    }
    return;
  }
  if (d.t === 'sync') {
    // 房主 → 所有人：小世界权威快照（位置/血量/存活/比分/局号）
    if (iAmHost) return;
    // 注意：sync 走 state 通道（stateSeq 计数），必须用独立 lastSyncSeq 去重。
    // 若与 event 通道的 lastEventSeq 混用，无序快照先到会把后续 event（blt/go/hitRep 等）全部压掉。
    if (d.seq !== undefined) { if (d.seq <= (lastSyncSeq[rid] || 0)) return; lastSyncSeq[rid] = d.seq; }
    const lst = d.lst || [];
    for (const it of lst) {
      if (it.id === myPeerId) {
        // 自己的血量/存活/位置以房主小世界为准（本地预判只做命中特效，不改变血量）
        if (meIsAAGun) {
          if (meAAGun) {
            // 被打预判对账：权威已下降部分 = 已确认预判 → 从未确认预判里扣除（防止旧快照"回满再扣回"）
            const lastA0 = (meAAGun.lastAuth === undefined) ? it.hp : meAAGun.lastAuth;
            meAAGun.predTotal = Math.max(0, (meAAGun.predTotal || 0) - Math.max(0, lastA0 - it.hp));
            meAAGun.lastAuth = it.hp;
            meAAGun.hp = it.hp - meAAGun.predTotal;
            if (!it.al && meAAGun.alive && !STATE.roundOver) { meAAGun.alive = false; deathPos.copy(myAAGun.group.position); deathPos.y += 2; effects.explosion(deathPos, 1.6); audio.explosion(); myAAGun.group.visible = false; }
          }
        } else if (me) {
          const lastA0 = (me.lastAuth === undefined) ? it.hp : me.lastAuth;
          me.predTotal = Math.max(0, (me.predTotal || 0) - Math.max(0, lastA0 - it.hp));
          me.lastAuth = it.hp;
          me.hp = it.hp - me.predTotal;
          if (!it.al && me.alive && !STATE.roundOver) { me.alive = false; deathPos.copy(myPlane.group.position); effects.explosion(deathPos, 1.4); audio.explosion(); myPlane.group.visible = false; }
        }
      } else {
        const pl = planes[it.id];
        if (pl) {
          pl.tPos.fromArray(it.p);
          if (it.q) pl.tQuat.set(it.q[0], it.q[1], it.q[2], it.q[3]);
          // 权威血量：sync 中已下降的部分 = 房主已确认结算的预判 → 从未确认预判里扣除；
          // 剩余未确认预判继续预挂（本地显示 = 权威 - 未确认预判），被否决时由 dmgReject 立即回溯
          const lastA = (pl.lastAuth === undefined) ? it.hp : pl.lastAuth;
          if (pl.predTotal) pl.predTotal = Math.max(0, pl.predTotal - Math.max(0, lastA - it.hp));
          pl.lastAuth = it.hp;
          pl.hp = it.hp - (pl.predTotal || 0);
          if (!it.al && pl.alive && !STATE.roundOver) { pl.alive = false; effects.explosion(pl.plane.group.position, 1.4); audio.explosion(); pl.plane.group.visible = false; }
          continue;
        }
        const ag = aaguns[it.id];
        if (ag) {
          ag.tPos.fromArray(it.p);
          if (typeof it.ty === 'number') { ag.tTurretYaw = it.ty; ag.tTurretPitch = it.tp || 0; }
          if (typeof it.by === 'number') ag.tBodyYaw = it.by;
          const lastA2 = (ag.lastAuth === undefined) ? it.hp : ag.lastAuth;
          if (ag.predTotal) ag.predTotal = Math.max(0, ag.predTotal - Math.max(0, lastA2 - it.hp));
          ag.lastAuth = it.hp;
          ag.hp = it.hp - (ag.predTotal || 0);
          if (!it.al && ag.alive && !STATE.roundOver) { ag.alive = false; effects.explosion(ag.aagun.group.position, 1.6); audio.explosion(); ag.aagun.group.visible = false; }
        }
      }
    }
    // 比分/局号/结束标志：state 通道乱序，旧回合的迟到大快照不得回退新状态。
    // （bug 推演：回合 R→R+1 刚重置后，在途旧 sync{rn:R, over:true, 旧比分} 落地 →
    //  roundNum 回退 + roundOver 翻回 true + 比分闪回；紧接着新 sync{rn:R+1} 因 rn 超前
    //  又二次触发 nextRound → 开局瞬间实体回出生点/子弹清空。故 rn 落后时整段跳过）
    const staleSnap = d.rn !== undefined && d.rn < STATE.roundNum;
    // 局号看门狗（自愈）：本端回合序号若真的超前房主，sync 会被上面这条 staleSnap 判定成"陈旧快照"
    // 而整段跳过（血量照常更新、比分/回合状态全冻结）。正常情况下陈旧快照只存在于"在途乱序"的一瞬间
    // （<1s），因此只要这种不一致**持续 1.5s 以上**，就一定是本端超前 → 以房主为准重新对齐，避免必须
    // 等到房主下一次推进回合才恢复。
    if (staleSnap) {
      const nowMs = performance.now();
      if (!rnMismatchT) rnMismatchT = nowMs;
      else if (nowMs - rnMismatchT > 1500) {
        rnMismatchT = 0;
        STATE.matchEnded = false;
        matchPanel.classList.add('hidden');
        STATE.myScore = 0; STATE.foeScore = 0;
        if (d.s0 !== undefined) { STATE.s0 = d.s0; STATE.s1 = d.s1; }
        nextRound(d.rn);
        return;
      }
    } else { rnMismatchT = 0; }
    if (!staleSnap) {
      if (d.s0 !== undefined) { STATE.s0 = d.s0; STATE.s1 = d.s1; }
      // 局号推进兜底：'round' 走 event 通道（可靠）一般先到；若丢包/晚到，sync 的 rn 超前同样触发回合重置（幂等）
      // 注意：只前进不回退（rn 相等时本地已是权威值，无需赋值）
      if (d.rn !== undefined && d.rn > STATE.roundNum) nextRound(d.rn);
      if (d.over !== undefined && d.over !== STATE.roundOver) { STATE.roundOver = d.over; if (d.over) firing = false; }
      syncScoreFromWorld();
    }
    return;
  }
}
function onPeerEvent(peerId, d) {
  const rid = d.sender || peerId;
  // 广播类消息（带 seq）去重：直连+转发双通道可能重复到达
  if (d.seq !== undefined) {
    if (d.seq <= (lastEventSeq[rid] || 0)) return;
    lastEventSeq[rid] = d.seq;
  }
  switch (d.t) {
    /* ---- 房主小世界：非房主上报开火，房主权威生成子弹并广播显示 ---- */
    case 'fire': {
      if (!iAmHost || STATE.roundOver) break;   // 回合已结束：不再生成权威子弹
      const o = new THREE.Vector3().fromArray(d.o);
      const dir = new THREE.Vector3().fromArray(d.d).normalize();
      // 按开火者的实际弹道参数重建（速度/伤害/溅射），保证权威判定与开火者本地弹道一致
      const b = spawnBullet(o, dir, d.s || 560, 'foeVis', d.dm || BASE_DMG, !!d.sl);
      if (b && d.fid) { b.fid = d.fid; b.fFrom = rid; b.fHit = false; fireBullets[rid + ':' + d.fid] = b; }   // 开火对账（复合键防跨玩家撞号）：等 hitRep 声称命中 / 未命中延迟否决
      netBroadcast({ t: 'blt', o: d.o, d: d.d, from: rid, s: d.s, dm: d.dm, sl: d.sl });   // 广播给其他非房主做本地显示/预判
      effects.muzzle(o);
      break;
    }
    case 'blt': {
      // 房主 → 非房主：新子弹（敌方），本地模拟显示 + 预判；开火者本人已有本地子弹，跳过防重复
      if (iAmHost || d.from === myPeerId) break;
      const o = new THREE.Vector3().fromArray(d.o);
      const dir = new THREE.Vector3().fromArray(d.d).normalize();
      spawnBullet(o, dir, d.s || 560, 'foeVis', d.dm || BASE_DMG, !!d.sl);
      effects.muzzle(o);
      if (myPlane) audio.enemyShoot(o.distanceTo(myPlane.group.position));
      else if (myAAGun) audio.enemyShoot(o.distanceTo(myAAGun.group.position));
      break;
    }
    case 'dmgReject': {
      // 房主权威否决：该子弹未命中任何目标 → 立即回溯本地预判扣掉的血量
      if (iAmHost) break;
      const rec = firePred[d.fid];
      if (rec) {
        delete firePred[d.fid];
        const pl = planes[rec.id];
        if (pl) { pl.predTotal = Math.max(0, (pl.predTotal || 0) - rec.dmg); if (pl.lastAuth !== undefined) pl.hp = pl.lastAuth - pl.predTotal; }
        const ag = aaguns[rec.id];
        if (ag) { ag.predTotal = Math.max(0, (ag.predTotal || 0) - rec.dmg); if (ag.lastAuth !== undefined) ag.hp = ag.lastAuth - ag.predTotal; }
        showPart('判定未命中 · 已回溯');
      }
      break;
    }
    case 'hitRep': {
      // 非房主命中上报：{fid, id(目标id), p(命中瞬间目标位置), dmg}；开火者自身 id 由 sendToAll 自动附带的 sender 字段携带（rid）
      if (!iAmHost || mode === 'practice' || STATE.roundOver) break;
      if (!d.fid || !d.id) break;
      const fkey = rid + ':' + d.fid;   // 复合键：fid 各玩家独立计数，跨玩家会撞号
      if (rejectedFids.has(fkey)) break;   // 该弹已被否决回溯 → 迟到的 hitRep 忽略（防双结算）
      const dmg = Math.max(1, Math.min(40, d.dmg | 0));
      const pi = pendingRejects.findIndex((x) => x.fid === d.fid && x.from === rid);
      if (pi >= 0) pendingRejects.splice(pi, 1);   // 撤销待否决（该弹已被开火者判定命中）
      const b2 = fireBullets[fkey];
      if (b2 && b2.active && !b2.fHit) {
        // 子弹仍在飞行：登记信任目标，子弹到达上报点附近时按上报结算
        b2.trust = { id: d.id, p: new THREE.Vector3().fromArray(d.p), dmg };
      } else if (!b2 || (!b2.active && !b2.fHit)) {
        // 子弹已消失且未真实命中（220ms 窗口内 hitRep 迟到）→ 直接宽容结算；已真实命中则忽略
        lastDmgFrom = rid; trustDamage(d.id, dmg); lastDmgFrom = null;   // 击杀归因=上报者
      }
      break;
    }
    case 'envDmg': {
      // 非房主环境伤害上报（撞地/出界），房主权威扣血（sync 确认后本地预判生效）
      if (!iAmHost || mode === 'practice') break;
      const dm = Math.max(1, Math.min(20, d.dmg | 0));
      if (rid && rid !== myPeerId) { lastDmgFrom = null; applyPeerDamage(rid, dm); }   // 环境伤害：无击杀者
      break;
    }
    case 'rEnd': {
      // 房主权威回合结果：比分/局号对齐（防止本地判定差异）
      if (iAmHost) break;
      if (d.rn !== undefined && d.rn >= STATE.roundNum) {
        STATE.roundNum = d.rn;
        if (d.s0 !== undefined) { STATE.s0 = d.s0; STATE.s1 = d.s1; }
        syncScoreFromWorld();
        // 回合结果提示：此前仅房主有横幅/音效，非房主静默无反馈（视觉缺口）
        if (d.w !== undefined && lastREndShown !== d.rn) {
          lastREndShown = d.rn;
          if (d.w === -1) { banner('双方同归于尽', '#ffe08a', 3); subBanner('平局 · 双方均不计分', 3); }
          else if (d.w === myTeam) { banner('回合胜利', '#7CFC98', 3); audio.roundWin(); }
          else { banner('回合失败', '#ff7a6b', 3); audio.roundLose(); }
        }
      }
      break;
    }
    case 'matchEnd': {
      // 房主权威胜利判定。win 是"房主视角"的胜负，不能直接使用：
      // 用房主推送的队伍比分 s0/s1 按本地阵营换算（比分缺失时兜底取反）
      if (iAmHost || STATE.matchEnded) break;
      let iWon;
      if (d.s0 !== undefined) {
        STATE.s0 = d.s0; STATE.s1 = d.s1;
        syncScoreFromWorld();
        iWon = (myTeam === 0 ? STATE.s0 > STATE.s1 : STATE.s1 > STATE.s0);
      } else {
        iWon = !d.win;
      }
      applyMatchEnd(iWon);
      break;
    }
    case 'round': {
      // 房主权威回合推进：非房主重置实体/血量/存活/位置进入下一回合
      // event 通道可靠且保序，因此这里可以安全地"双向对齐"：
      //   rn 更大 → 正常进入下一回合；
      //   rn 更小 → 房主开了新的一场（重赛）或本端局号曾超前 → 清掉上一场残留后按房主局号重来。
      // 旧实现只接受"更大的局号"，一旦本端超前就再也不会被纠正（永久卡死）。
      if (iAmHost || mode === 'practice') break;
      if (d.rn === undefined) break;
      if (d.rn < STATE.roundNum) {
        STATE.matchEnded = false;
        STATE.myScore = 0; STATE.foeScore = 0; STATE.s0 = 0; STATE.s1 = 0;
        matchPanel.classList.add('hidden');
        if (d.s0 !== undefined) { STATE.s0 = d.s0; STATE.s1 = d.s1; }
        updateScore();
      }
      if (d.rn !== STATE.roundNum) nextRound(d.rn);
      break;
    }
    /* ---- 选阵营 ---- */
    case 'pickStart': {
      if (iAmHost || STATE.started) break;
      pickRound = d.round || 0;
      myPickSide = -1; pickListGot = null;
      curPickC0 = 0; curPickC1 = 0;
      pickTs0 = Math.max(1, Math.floor(netSize / 2));
      pickTs1 = Math.max(1, netSize - pickTs0);
      clearInterval(mapLobbyTimerId);   // 进入选阵营：大厅"主机未响应"兜底计时器作废（选阵营最长 45s，25s/60s 兜底会提前抢跑开局）
      setupPickUI();
      hideAllPanels();
      $('pickPanel').classList.remove('hidden');
      showPickStatus('选择后不可更改 · 等待全员选择…');
      break;
    }
    case 'pickCount': {
      if (iAmHost) break;
      if (d.round !== undefined && d.round !== pickRound) break;   // 旧表格编号：丢弃
      curPickC0 = d.c0 || 0; curPickC1 = d.c1 || 0;
      if (d.t0) pickTs0 = d.t0;
      if (d.t1) pickTs1 = d.t1;
      updatePickUI();
      break;
    }
    case 'pick': {
      // 玩家 → 房主：选择阵营
      if (!iAmHost || !pickPhase) break;
      const side = d.side === 1 ? 1 : 0;
      const cap = side === 0 ? pickTs0 : pickTs1;
      const c = side === 0 ? countPickTeam(0) : countPickTeam(1);
      if (c >= cap) netSendEventTo(rid, { t: 'pickReject', to: rid });   // 满员回退
      else { pickSelections[rid] = side; broadcastPickCount(); }
      break;
    }
    case 'pickReject': {
      if (d.to && d.to !== myPeerId) break;
      myPickSide = -1;
      updatePickUI();
      showPickStatus('该阵营已满，请选择另一阵营', '#ffb3a0');
      break;
    }
    case 'pickList': {
      // 房主定向分配：对"我"的视角 —— 谁是队友、谁是对手（例：对玩家A → B是队友、C是对手）
      // 玩家端不持有完整名单，也无需队友互相校验；确认收到即就绪
      if (iAmHost || STATE.started) break;
      if (d.round !== undefined && d.round !== pickRound) break;   // 旧编号：丢弃
      pickRound = d.round !== undefined ? d.round : pickRound;
      pickListGot = true;
      myTeam = d.team === 1 ? 1 : 0;
      mySlot = d.slot || 0;
      upsertRoster(myPeerId, myTeam, mySlot);
      for (const m of (d.m || [])) upsertRoster(m[0], myTeam, m[1]);
      for (const f of (d.f || [])) upsertRoster(f[0], 1 - myTeam, f[1]);
      hideAllPanels();
      if (gamemode === 'aavs') rebuildWorld('base');
      netSendEventTo(hostPeerId, { t: 'ready' });   // 确认收到 → 就绪
      break;
    }
    case 'ready': {
      // 注意：不能判断 pickPhase——定向发放名单时已置 false，否则 ready 全被丢弃、永远开不了局
      if (!iAmHost || !pickWaitingReady) break;
      pickReadySet.add(rid);
      tryStartMatchFromReady();
      break;
    }
    case 'pickCancel': {
      // 房主取消选阵营（有人掉线）：回 lobby 等待
      if (iAmHost || STATE.started) break;
      myPickSide = -1; pickListGot = null;
      hideAllPanels();
      $('mapLobbyPanel').classList.remove('hidden');
      $('mapLobbyStatus').textContent = gamemode === 'aavs' ? '等待主机重新分配阵营…' : '等待主机重新选择…';
      break;
    }
    case 'go': {
      if (iAmHost || STATE.started) break;
      if (d.map) rebuildWorld(d.map);
      beginMatch();
      break;
    }
    case 'died': if (iAmHost && d.id && d.id !== myPeerId) { lastDmgFrom = null; peerDie(d.id); } break;   // 自毁/环境死上报：无击杀者
    case 'kstat':
      // 房主权威击杀台账（3s 定向下发）：覆盖本地预判计数——预判 +1 只做即时反馈，最终以台账为准
      // （本地子弹被 dmgReject 否决时，击杀数在 ≤3s 内自动纠正，不再只增不减）
      if (iAmHost || mode === 'practice') break;
      if (typeof d.k === 'number') killCount = Math.max(0, d.k | 0);
      break;
    case 'hello': {
      // 加入方上报真实 ID：主机把本地连接 key 迁移为真实 peerId 并分配阵营
      if (!iAmHost) break;
      const key = peerId;                 // 主机侧连接 key（如 'foe_0'）
      const realId = d.id;                // 加入方真实 peerId
      const entry = roster.find(p => p.peerId === key);
      if (entry && entry.team < 0) {
        const ts = netSize / 2;
        const c0 = roster.filter(p => p.team === 0 && p.peerId !== key).length;
        const c1 = roster.filter(p => p.team === 1 && p.peerId !== key).length;
        const can0 = c0 < ts, can1 = c1 < ts;
        let team;
        if (can0 && can1) team = Math.random() < 0.5 ? 0 : 1;
        else team = can0 ? 0 : 1;
        const slot = roster.filter(p => p.team === team).length;
        entry.peerId = realId; entry.team = team; entry.slot = slot;
        // nets 字典 key 从 'foe_N' 迁移为真实 ID，回调也同步
        if (nets[key] && key !== realId) { nets[realId] = nets[key]; nets[realId].peerKey = realId; delete nets[key]; }
        netSendEventTo(realId, { t: 'team', team, slot, hostTeam: myTeam, hostSlot: mySlot, myId: myPeerId, gamemode });
        broadcastRoster();
        updateHostStatus();
      }
      break;
    }
    case 'team': {
      // 主机分配阵营：设置自己的 team/slot，并记录主机(房主)的真实 ID 与阵营
      myTeam = d.team; mySlot = d.slot;
      // 同步主机的玩法（加入方可能以不同玩法的界面加入，一律以房主为准）
      if (d.gamemode) {
        const wasAavs = gamemode === 'aavs';
        gamemode = d.gamemode;
        // 已进 lobby 面板时修正文案（防空车 ↔ 空战双向）
        if (STATE.mapFinalized && !STATE.started && !iAmHost) {
          if (gamemode === 'aavs') {
            rebuildWorld('base');
            $('mapLobbyTitle').textContent = '军事基地 · 防空作战';
            $('mapLobbyStatus').textContent = '随机分配阵营中，等待主机开局…';
          } else if (wasAavs) {
            $('mapLobbyTitle').textContent = '等待主机选择空域';
            $('mapLobbyStatus').textContent = '正在等待主机选择地图…';
          }
          $('lobbyMapChoice').style.display = 'none';
        }
      }
      let self = roster.find(p => p.peerId === myPeerId);
      if (!self) { roster.push({ peerId: myPeerId, team: d.team, slot: d.slot }); }
      else { self.team = d.team; self.slot = d.slot; }
      const hostId = d.myId || rid;
      hostPeerId = hostId;   // 记录房主真实 ID（mesh 建连与定向路由需要）
      let host = roster.find(p => p.peerId === hostId);
      if (!host) { roster.push({ peerId: hostId, team: d.hostTeam, slot: d.hostSlot || 0 }); }
      else { host.team = d.hostTeam; host.slot = d.hostSlot || 0; }
      // 迁移直连 nets key：从自己的 myPeerId 改为房主真实 ID（定向消息才能路由）
      if (nets[myPeerId] && hostId && hostId !== myPeerId) {
        nets[hostId] = nets[myPeerId];
        nets[hostId].peerKey = hostId;
        delete nets[myPeerId];
      }
      if (gamemode === 'aavs') rebuildWorld('base');
      if (!STATE.started) startMapLobby();
      break;
    }
    case 'roster':
      roster = d.roster;
      netSize = roster.length;   // 非房主端同步队伍规模（出生点布局/选阵营容量依赖）
      break;
    case 'map':
      if (!STATE.started && !iAmHost) { clearInterval(mapLobbyTimerId); rebuildWorld(d.map); beginMatch(); }
      break;
    case 'ping':
      // 房主收到非房主探测 → 原样回 pong（对端用自己时钟算 RTT，避免时钟基准不一致）
      if (d.ts) netSendEventTo(rid, { t: 'pong', ts: d.ts });
      break;
    case 'pong':
      if (d.ts) pingMs = Math.max(0, Math.round(performance.now() - d.ts));
      break;
    case 'rematch': applyRematch(); break;
    case 'crash':
      // 碰撞权威结算（房主小世界）：非房主检测到碰撞后上报，房主统一裁决
      // dmg=友军轻撞（双方各扣）；fatal=同归于尽（敌机互撞 / 撞防空车）
      if (!iAmHost || !d.target) break;
      if (!markCrashPair(d.sender, d.target)) break;   // 双方各自检测并各自上报，只结算一次
      if (d.dmg) {
        // 轻撞互扣：击杀归因为对方（碰撞致死同样计入台账）
        if (d.sender && d.sender !== myPeerId) { lastDmgFrom = d.target; applyPeerDamage(d.sender, d.dmg); lastDmgFrom = null; }
        if (d.target === myPeerId) { lastDmgFrom = d.sender; if (meIsAAGun) applyMeAAGunDamage(d.dmg); else applyMeDamage(d.dmg); lastDmgFrom = null; }
        else { lastDmgFrom = d.sender; applyPeerDamage(d.target, d.dmg); lastDmgFrom = null; }
      } else if (d.fatal) {
        if (d.target === myPeerId) {
          lastDmgFrom = d.sender;   // 是对方撞的我
          if (meIsAAGun) { if (meAAGun && meAAGun.alive) selfDestructAAGun(); }
          else if (me && me.alive) selfDestruct();
          lastDmgFrom = null;
          if (d.sender && d.sender !== myPeerId) { lastDmgFrom = myPeerId; peerDie(d.sender); lastDmgFrom = null; }   // 同归于尽：我也撞死了对方
        } else {
          lastDmgFrom = d.sender; peerDie(d.target); lastDmgFrom = null;          // 上报者撞死了 target
          if (d.sender && d.sender !== myPeerId) { lastDmgFrom = d.target; peerDie(d.sender); lastDmgFrom = null; }   // target 撞死了上报者
        }
      }
      break;
    case 'peerGone':
      // 房主通知某玩家掉线：同步清理本地实体与 roster（避免幽灵实体）
      removePeerLocal(d.id);
      // 非房主对称感知：对手全掉线时房主端会就地结束比赛但不会广播 matchEnd，
      // 非房主须自行判定，否则只能干瞪空地图（roundOver 后无任何结算面板）
      if (wasInGameCheck()) endMatchIfFoesGone();
      break;
  }
}
function onPeerOpen() {
  // 星型架构：非房主只与房主直连，无 mesh 握手
}
// 对手断线：清理其实体与 roster，比赛进行中则视为阵亡（触发回合结算），避免对局卡死
function removePeerLocal(peerId) {
  if (planes[peerId]) { scene.remove(planes[peerId].plane.group); delete planes[peerId]; }
  else if (aaguns[peerId]) { scene.remove(aaguns[peerId].aagun.group); delete aaguns[peerId]; }
  const idx = roster.findIndex(p => p.peerId === peerId);
  if (idx >= 0) roster.splice(idx, 1);
  if (nets[peerId]) { delete nets[peerId]; }
  // 关键：必须同时清掉选阵营记录 —— 否则重发名单时他仍被算进队伍（applyPickTeams 会把他重新
  // 塞回 roster），在所有人眼里变成占位不动的幽灵单位：占出生位，且 teamAliveCount 永远把他
  // 算作存活，回合将永远无法靠"全灭"结束。
  if (pickSelections[peerId] !== undefined) delete pickSelections[peerId];
  pickReadySet.delete(peerId);
  delete voiceRx[peerId];    // 清理该玩家的语音抖动缓冲
  delete voiceTalk[peerId];  // 清理 HUD 讲话指示
}
// 断线文案：WebRTC onClose 是双向触发的（自己断网和对端离线都会触发），本端无法百分百归因。
// 唯一可靠判据：navigator.onLine / offline 事件（系统级断网时浏览器自己知道）。
// onLine=true 时也不能断定是对端的问题（路由波动等），文案必须中性提示两种可能，避免误导玩家怪罪对方。
function lostConnText(peer) {
  if (navigator.onLine === false) return '你的网络连接已断开';
  return peer === 'host'
    ? '与房主的连接已断开（可能是房主离线，也可能是你的网络波动）'
    : '与所有玩家的连接均已断开（可能是你的网络波动，也可能是所有玩家离线）';
}
// 系统级断网即时提示（offline 事件比 WebRTC onClose 更早更准）
window.addEventListener('offline', () => {
  if (mode === 'net') banner('你的网络连接已断开', '#ff7a6b', 3);
});
function onPeerClose(peerId) {
  const wasInGame = STATE.started && !STATE.matchEnded;
  // 房主掉线：star 拓扑的根断了，所有人无法再同步 → 直接结束比赛（判房主队伍负）
  if (!iAmHost && peerId === hostPeerId) {    const hostEntry = roster.find(p => p.peerId === hostPeerId);
    const hostTeam = hostEntry ? hostEntry.team : -1;
    removePeerLocal(peerId);
    if (wasInGame) {
      const iWon = hostTeam < 0 ? true : myTeam !== hostTeam;
      STATE.matchEnded = true; STATE.roundOver = true; firing = false;
      matchTitle.textContent = iWon ? '最终胜利' : '惜败';
      matchTitle.style.color = iWon ? '#7CFC98' : '#ff7a6b';
      // 中性归因：无法区分房主离线还是自己断网（详见 lostConnText 注释）
      matchSub.textContent = lostConnText('host') + ' · 比赛提前结束（' + STATE.myScore + ' : ' + STATE.foeScore + '）';
      $('btnRematch').classList.add('hidden');   // 房主离线无法重赛
      matchPanel.classList.remove('hidden');
      if (document.pointerLockElement) document.exitPointerLock();
    } else {
      // 凑人阶段连接断开：中性归因提示并返回菜单
      banner('连接已断开，即将返回菜单', '#ff7a6b', 3);
      subBanner(lostConnText('host'), 3);
      setTimeout(() => location.reload(), 2500);
    }
    return;
  }
  // 凑人阶段（非房主只与房主有一条直连，星型拓扑）：任何连接断开都等于房主掉线
  // （覆盖 corner case：team 消息未到、hostPeerId 尚未赋值时房主就掉线，否则非房主会永远卡在大厅）
  if (!iAmHost && !STATE.started) {
    banner('连接已断开，即将返回菜单', '#ff7a6b', 3);
    subBanner(lostConnText('host'), 3);
    setTimeout(() => location.reload(), 2500);
    return;
  }
  removePeerLocal(peerId);
  if (iAmHost && mode !== 'practice') {
    // 房主广播掉线通知，让其他非房主玩家同步清理（避免幽灵实体）；
    // 同步重算 netSize 并重发 roster（否则选阵营容量/ready 阈值仍按掉线前人数算，会卡死）
    netSize = Math.max(2, roster.length);
    if (!STATE.started) updateHostStatus();   // 凑人阶段刷新"已连接 x/y"提示
    broadcastRoster();
    netBroadcast({ t: 'peerGone', id: peerId });
    // 选阵营期间（选边 或 已发名单等就绪）有人掉线：本作无重连机制，等"重新连接"会永远卡死
    // → 市售做法：强制完成选阵营继续对局——已选的保留，未选的自动补到人少的队（允许 3v2 不对称）
    if (pickPhase || pickWaitingReady) {
      if (roster.length <= 1) {   // 只剩房主一人，无从开局
        banner('所有玩家已离开，返回主菜单', '#ff7a6b', 3);
        setTimeout(() => location.reload(), 2500);
        return;
      }
      rebalancePicks();           // 先按新人数重平衡容量，避免出现 0 人的空队
      const candidates = [myPeerId, ...roster.map(p => p.peerId)];
      for (const id of candidates) {
        if (pickSelections[id] !== undefined) continue;
        const c0 = countPickTeam(0), c1 = countPickTeam(1);
        pickSelections[id] = (c0 <= c1) ? 0 : 1;
      }
      completePickAndDeal();      // 重新定向发放名单（pickRound 未变，收到方幂等处理并重发 ready）
      tryStartMatchFromReady();   // 就绪人数已达标（按掉线后的 netSize 重算）则立即开局
    }
  }
  if (wasInGame) {
    if (endMatchIfFoesGone()) return;
    banner('对手已断线', '#ff7a6b', 3);
    checkRoundEnd();   // 断线方部分减员 → 正常回合结算
  } else if (iAmHost) {
    updateHostStatus();   // 凑人阶段刷新连接状态
  }
}
// 对局中某端掉线后：若对手队伍已无人（全部掉线）→ 直接结束整场比赛（双方各自独立判定，无需广播）
// 返回 true 表示已结束（调用方应停止后续处理）
function endMatchIfFoesGone() {
  if (!STATE.started || STATE.matchEnded) return false;
  const foeTeam = myTeam === 0 ? 1 : 0;
  if (teamAliveCount(foeTeam) > 0) return false;
  STATE.matchEnded = true; STATE.roundOver = true; firing = false;
  STATE.teamElimTimer = 0;
  matchTitle.textContent = '最终胜利';
  matchTitle.style.color = '#7CFC98';
  // 房主视角：若所有连接同时消失，无法区分"全员离线"与"自己断网" → 文案中性归因；
  // 非房主（经 peerGone 进入此处）与房主的连接仍健在，可断定是"对手已全部掉线"
  const allConnsLost = (mode !== 'practice' && iAmHost && Object.keys(nets).length === 0);
  matchSub.textContent = (allConnsLost ? lostConnText('all') : '对手已全部掉线') + ' · 比赛结束（' + STATE.myScore + ' : ' + STATE.foeScore + '）';
  $('btnRematch').classList.remove('hidden');
  matchPanel.classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
  return true;
}
// 是否处于"对局进行中"（peerGone 处理用，避免依赖 onClose 的局部变量）
function wasInGameCheck() { return STATE.started && !STATE.matchEnded; }

function wireNet(n, peerKey) {
  n.peerKey = peerKey;
  // 使用 n.peerKey 而非闭包变量：主机收到 hello 后会迁移 key（'foe_N' → 真实ID）
  n.onState = (d) => {
    onPeerState(n.peerKey, d);
    hostRelay(n.peerKey, d);
  };
  n.onEvent = (d) => {
    onPeerEvent(n.peerKey, d);
    hostRelay(n.peerKey, d);
  };
  n.onOpen = () => {
    // 加入 nets 字典和 roster
    if (!nets[peerKey]) {
      nets[peerKey] = n;
      if (iAmHost) {
        // 主机：先占位，等加入方的 hello 消息（含真实 ID）后分配阵营
        roster.push({ peerId: peerKey, team: -1, slot: 0 });
      } else {
        // 加入方：先占位，通知主机自己的真实 peerId
        roster.push({ peerId: myPeerId, team: -1, slot: 0 });
        // 注意：此时 roster 只有自己，netBroadcast(sendToAll) 遍历 roster 会发不出去，
        // 必须直接遍历 nets（当前唯一连接就是房主）发送 hello
        const helloMsg = { t: 'hello', id: myPeerId };
        for (const id in nets) if (nets[id].connected) nets[id].sendEvent(helloMsg);
      }
    }
    // 主机：检查是否人齐（hello 处理后再调用 updateHostStatus，这里不重复触发选图）
    // 加入方：进选图大厅等主机选图
    if (!iAmHost && !STATE.started) startMapLobby();
  };
  n.onClose = () => { delete nets[n.peerKey]; onPeerClose(n.peerKey); };
}
// ===== 网络发送层：mesh 直连为主 + 房主转发兜底（自适应） =====
// 所有消息带 sender 标识真实来源 + seq 序号（接收方去重）
function sendToAll(o, isState) {
  if (mode === 'practice') return;
  const msg = Object.assign({ sender: myPeerId, seq: isState ? ++stateSeq : ++eventSeq }, o);
  // 星型架构：所有消息直达房主（或房主直达所有玩家），无 mesh 直连
  for (const id in nets) {
    const n = nets[id];
    if (n && n.connected) { if (isState) n.sendState(msg); else n.sendEvent(msg); }
  }
}
function netBroadcast(o) { sendToAll(o, false); }
function netSendState(o) { sendToAll(o, true); }
// 定向消息（选阵营核对等）：直达目标（所有人只连房主，非房主经房主转发）
function netSendEventTo(peerId, o) {
  if (mode === 'practice') return;
  const msg = Object.assign({ sender: myPeerId }, o);
  if (nets[peerId] && nets[peerId].connected) { nets[peerId].sendEvent(msg); return; }
  msg.target = peerId;
  if (hostPeerId && nets[hostPeerId] && nets[hostPeerId].connected) nets[hostPeerId].sendEvent(msg);
  else for (const id in nets) if (nets[id] && nets[id].connected) nets[id].sendEvent(msg);
}
// 房主路由：星型架构下所有定向消息均直连可达（非房主只连房主），无消息需要转发。
// 校验转发链（checkReq/checkOk/checkBad）已随"定向分配阵营"删除——阵营由房主统一分配，无需玩家间核对。
function hostRelay(fromPeer, d) {
  if (!iAmHost || mode === 'practice') return;
  // 兼容处理：带 target 且目标是已连接玩家的消息尽力转发（防御性，正常流程不会走到）
  const dst = d.target || d.to;
  if (dst && dst !== myPeerId && nets[dst] && nets[dst].connected) nets[dst].sendEvent(d);
}

/* ================= 语音通话（T=开/关麦克风  Y=开/关收音） =================
   架构：星型经房主转发——非房主只把语音发给房主，房主转给其他所有人（不含发送者）并本地播放；
   房主自己的语音直接广播。发送是定向的，结构上保证永远听不到自己的声音。
   传输：state 通道（不可靠、不保序、零重传）——语音容忍丢包但要低延迟；自带 seq，
   接收端 80ms 重排窗 + 抖动缓冲（丢包跳过不阻塞，积压 >400ms 丢弃保时效）。
   采样：16kHz 单声道 Int16（40ms/包 640 采样），JSON 内 base64 携带（净荷 ~32KB/s，人声足够听清）。 */
const VOICE_RATE = 16000, VOICE_CHUNK = 640;
let micOn = false, voiceRxOn = true;
let voiceCtx = null, micStream = null, micSrc = null, micProc = null, micSink = null;
let micHP = null, micLP = null, micGateT = 0;   // 语音频带滤波 + 噪声门保持时间
let micArmT = 0;                                // 开麦后的预热截止时刻（AEC 收敛窗口）
let voiceSeq = 0;                       // 发送端语音包序号（会话内单调递增，麦克风重开不复位）
let micAcc = [];                        // 重采样后的样本累积（凑满 40ms 一包）
let voiceTalk = {};                     // 各端最近说话时间（HUD 讲话指示）
const voiceRx = {};                     // 接收端抖动缓冲：id -> {pending:Map, nextSeq, nextTime, firstT}
let voiceFlushTimer = null;

const voiceHud = document.createElement('div');
voiceHud.style.cssText = 'position:fixed;top:' + (isTouch ? '92px' : '12px') + ';right:14px;z-index:60;font:600 12px/1.4 "Noto Sans SC","PingFang SC",sans-serif;color:#1c2b3a;background:rgba(255,255,255,.8);backdrop-filter:blur(8px);border:1px solid rgba(28,43,58,.14);border-radius:999px;padding:6px 13px;display:none;box-shadow:0 2px 12px rgba(28,43,58,.10);pointer-events:none;';
document.body.appendChild(voiceHud);
setInterval(() => {
  if (mode !== 'net') { voiceHud.style.display = 'none'; return; }
  const now = performance.now();
  const talking = [];
  for (const id in voiceTalk) if (now - voiceTalk[id] < 500) talking.push(id);
  if (!micOn && voiceRxOn && !talking.length) { voiceHud.style.display = 'none'; return; }
  let names = '';
  if (talking.length) {
    names = ' · 🗣 ' + talking.map((id) => {
      const idx = roster.findIndex((p) => p.peerId === id);
      return '玩家' + String.fromCharCode(65 + Math.max(0, idx));
    }).join('、');
  }
  voiceHud.textContent = '🎤' + (micOn ? '开' : '关') + (isTouch ? '' : '(T)') + ' · 🔊' + (voiceRxOn ? '开' : '关') + (isTouch ? '' : '(Y)') + names;
  voiceHud.style.display = 'block';
}, 150);

function b64FromBytes(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToI16(s) {
  const bin = atob(s), out = new Int16Array(bin.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = (bin.charCodeAt(i * 2 + 1) << 8) | bin.charCodeAt(i * 2);   // 小端
  return out;
}
function ensureVoiceCtx() {
  if (!voiceCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    voiceCtx = new AC();
    voiceFlushTimer = setInterval(() => { for (const id in voiceRx) flushVoice(id, true); }, 50);   // 丢包跳进定时器
  }
  if (voiceCtx.state === 'suspended') voiceCtx.resume();
}
/* iOS/Android 浏览器要求 AudioContext 必须在「用户手势」里创建/恢复，
   否则会一直是 suspended —— 表现为手机上完全听不到队友语音（收包时才创建的上下文已经错过手势）。
   这里在联机模式下任意一次触摸/点击里预热上下文，并用一个静音 buffer 解锁 iOS 音频。 */
let voicePrimed = false;
function primeVoiceCtx() {
  if (mode !== 'net') return;
  ensureVoiceCtx();
  if (!voiceCtx) return;
  if (voiceCtx.state === 'suspended') voiceCtx.resume().catch(() => {});
  if (!voicePrimed) {
    try {   // iOS 解锁：手势内播放一个 1 采样静音源
      const buf = voiceCtx.createBuffer(1, 1, 22050);
      const src = voiceCtx.createBufferSource();
      src.buffer = buf; src.connect(voiceCtx.destination); src.start(0);
      voicePrimed = true;
    } catch (e) {}
  }
}
document.addEventListener('touchstart', primeVoiceCtx, { passive: true });
document.addEventListener('pointerdown', primeVoiceCtx, { passive: true });
// 线性插值重采样 → Int16（支持任意 ctx 采样率到 16k）
function resampleI16(f32, srcRate) {
  const ratio = srcRate / VOICE_RATE;
  const outLen = Math.floor(f32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio, i0 = pos | 0, i1 = Math.min(i0 + 1, f32.length - 1), fr = pos - i0;
    const s = f32[i0] * (1 - fr) + f32[i1] * fr;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  }
  return out;
}
async function toggleMicSend() {
  if (mode !== 'net') { banner('语音仅联机模式可用', '#ffd27a', 2); return; }
  if (micOn) { stopMicSend(); return; }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    ensureVoiceCtx();
    micSrc = voiceCtx.createMediaStreamSource(micStream);
    micProc = voiceCtx.createScriptProcessor(2048, 1, 1);
    micSink = voiceCtx.createGain(); micSink.gain.value = 0;   // 静音汇点：Processor 必须连到 destination 才工作，但绝不能外放（防啸叫）
    // 电话频带整形：高通 180Hz 砍掉引擎/爆炸的低频轰鸣（最容易糊成"杂音"的那部分），
    // 低通 3.4kHz 保住人声清晰度的同时削掉高频噪声
    micHP = voiceCtx.createBiquadFilter(); micHP.type = 'highpass'; micHP.frequency.value = 180;
    micLP = voiceCtx.createBiquadFilter(); micLP.type = 'lowpass'; micLP.frequency.value = 3400;
    micSrc.connect(micHP); micHP.connect(micLP); micLP.connect(micProc);
    micProc.connect(micSink); micSink.connect(voiceCtx.destination);
    micProc.onaudioprocess = (e) => {
      if (!micOn) return;
      if (performance.now() < micArmT) { micAcc.length = 0; return; }   // AEC 收敛窗口内不发包（见上）
      const inp = e.inputBuffer.getChannelData(0);
      // 噪声门：低电平（扬声器串音、被麦克风拾取的游戏音效）直接不发包；
      // 350ms 保持时间避免说话间隙被切断
      let sum = 0, n = 0;
      for (let i = 0; i < inp.length; i += 4) { sum += inp[i] * inp[i]; n++; }
      const rms = Math.sqrt(sum / Math.max(1, n));
      const now = performance.now();
      if (rms > 0.02) micGateT = now;
      if (now - micGateT > 350) { micAcc.length = 0; return; }
      const res = resampleI16(inp, voiceCtx.sampleRate);
      for (let i = 0; i < res.length; i++) micAcc.push(res[i]);
      while (micAcc.length >= VOICE_CHUNK) sendVoiceChunk(new Int16Array(micAcc.splice(0, VOICE_CHUNK)));
    };
    micOn = true;
    // 预热窗口：浏览器的回声消除（AEC）需要先用一段本机播放信号"学习"回声路径才能抑制，
    // 收敛前（约 0.3~1.5s）麦克风拾取到的本机游戏音效会原样传出去——这正是"刚开麦时一阵嘈杂、
    // 内容明显是自己游戏里的枪声/引擎声、过一会儿就消失"的原因。这里在收敛期内不发包。
    micArmT = performance.now() + 600;
    syncVoiceBtn();
    banner(isTouch ? '麦克风已开启 · 点右上角「麦克风」可关闭' : '麦克风已开启 · 按 T 关闭', '#7CFC98', 2);
  } catch (err) {
    syncVoiceBtn();
    banner('麦克风开启失败：' + (err.name === 'NotAllowedError' ? '未授权（请在浏览器允许麦克风权限）' : err.message), '#ff7a6b', 3.4);
  }
}
function stopMicSend() {
  micOn = false;
  if (micStream) { for (const t of micStream.getTracks()) t.stop(); micStream = null; }
  if (micProc) { micProc.onaudioprocess = null; try { micProc.disconnect(); } catch (e) {} micProc = null; }
  if (micSrc) { try { micSrc.disconnect(); } catch (e) {} micSrc = null; }
  if (micSink) { try { micSink.disconnect(); } catch (e) {} micSink = null; }
  if (micHP) { try { micHP.disconnect(); } catch (e) {} micHP = null; }
  if (micLP) { try { micLP.disconnect(); } catch (e) {} micLP = null; }
  micGateT = 0;
  micArmT = 0;
  micAcc.length = 0;
  syncVoiceBtn();
  banner(isTouch ? '麦克风已关闭' : '麦克风已关闭 · 按 T 开启', '#ffd27a', 2);
}
function toggleVoiceRx() {
  if (mode !== 'net') { banner('语音仅联机模式可用', '#ffd27a', 2); return; }
  voiceRxOn = !voiceRxOn;
  syncVoiceBtn();
  banner(voiceRxOn ? (isTouch ? '收音已开启' : '收音已开启 · 按 Y 关闭') : (isTouch ? '收音已关闭' : '收音已关闭 · 按 Y 开启'), voiceRxOn ? '#7CFC98' : '#ffd27a', 2);
}
// 手机端语音按钮显隐（练习模式没有联机语音，不应出现这两个按钮）
function setVoiceBtnsVisible(show) {
  const bm = $('btnMic'), br = $('btnRx');
  const v = show ? 'flex' : 'none';
  if (bm) bm.style.display = v;
  if (br) br.style.display = v;
}
// 手机端语音按钮状态同步（桌面端没有这两个按钮，元素不存在则跳过）
function syncVoiceBtn() {
  const bm = $('btnMic'), br = $('btnRx');
  if (!bm && !br) return;
  let m = false, r = true;
  try { m = !!micOn; r = !!voiceRxOn; } catch (e) { return; }   // 防御：极端情况下变量尚未初始化
  if (bm) { bm.classList.toggle('on', m); bm.textContent = m ? '麦克风 开' : '麦克风'; }
  if (br) { br.classList.toggle('on', r); br.textContent = r ? '收听 开' : '收听'; }
}
function sendVoiceChunk(i16) {
  if (!voiceCtx || Object.keys(nets).length === 0) return;
  // 非房主的 nets 只有房主一条 → 这行天然就是"定向发给房主"；房主的 nets 是所有玩家 → 天然广播
  const msg = { t: 'voice', from: myPeerId, seq: ++voiceSeq, v: b64FromBytes(new Uint8Array(i16.buffer)) };
  for (const id in nets) if (nets[id].connected) nets[id].sendState(msg);
}
// 收到语音包：房主转发给其他所有人（不含发送者，防回声）+ 本地播放；非房主只播放
function onVoiceMsg(rid, d) {
  const from = d.from || rid;
  if (from === myPeerId) return;   // 双保险：结构上已不会收到自己的声音
  if (iAmHost) {
    for (const id in nets) {
      if (id === from || !nets[id].connected) continue;
      nets[id].sendState({ t: 'voice', from, seq: d.seq, v: d.v });
    }
  }
  if (!voiceRxOn) return;          // 收音关：转发义务照尽，本地不播
  voiceTalk[from] = performance.now();
  playVoiceChunk(from, d.seq | 0, d.v);
}
function playVoiceChunk(from, seq, b64) {
  ensureVoiceCtx();
  let rx = voiceRx[from];
  if (!rx) rx = voiceRx[from] = { pending: new Map(), nextSeq: -1, nextTime: 0, firstT: 0 };
  if (rx.nextSeq < 0) rx.nextSeq = seq;   // 首包对齐序号
  if (seq < rx.nextSeq) return;           // 迟到包：丢
  if (!rx.pending.has(seq)) rx.pending.set(seq, b64);
  flushVoice(from, false);
}
function flushVoice(from, force) {
  const rx = voiceRx[from];
  if (!rx || !voiceCtx) return;
  if (force && !rx.pending.has(rx.nextSeq) && rx.pending.size) {
    // 丢包推进：下一包 80ms 内没到 → 跳到已收到的最早包继续播（跳过的那段静音）
    const now = performance.now();
    if (!rx.firstT) rx.firstT = now;
    if (now - rx.firstT > 80) { rx.nextSeq = Math.min(...rx.pending.keys()); rx.firstT = 0; }
  }
  while (rx.pending.has(rx.nextSeq)) {
    const b64 = rx.pending.get(rx.nextSeq);
    rx.pending.delete(rx.nextSeq);
    rx.nextSeq++;
    rx.firstT = 0;
    scheduleVoice(rx, b64);
  }
}
function scheduleVoice(rx, b64) {
  try {
    const i16 = b64ToI16(b64);
    const buf = voiceCtx.createBuffer(1, i16.length, VOICE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768;
    const now = voiceCtx.currentTime;
    if (rx.nextTime < now + 0.05) rx.nextTime = now + 0.05;   // 欠载：重新起步
    if (rx.nextTime > now + 0.4) rx.nextTime = now + 0.2;     // 积压过深：跳到较新位置（保时效）
    const src = voiceCtx.createBufferSource();
    src.buffer = buf; src.connect(voiceCtx.destination);
    src.start(rx.nextTime);
    rx.nextTime += i16.length / VOICE_RATE;
  } catch (e) {}
}
// 主机广播完整 roster（让所有玩家知道所有人的阵营与槽位）
function broadcastRoster() {
  if (mode !== 'practice') {
    netBroadcast({ t: 'roster', roster: roster.map(p => ({ peerId: p.peerId, team: p.team, slot: p.slot })) });
  }
}

// ===== 房主小世界架构：无 mesh 直连，所有玩家只与房主相连 =====

/* ================= 选图大厅（主机选图广播） ================= */
function hideAllPanels() {
  ['practicePanel', 'hostPanel', 'joinPanel', 'mapLobbyPanel'].forEach(id => { const el = $(id); if (el) el.classList.add('hidden'); });
  const mb = $('menuBoxBody'); if (mb) mb.style.display = 'none';   // 二级面板容器
  const hp = $('helpPanel'); if (hp) hp.classList.add('hidden');     // 帮助弹层
}
function showMenuBox() { const mb = $('menuBoxBody'); if (mb) mb.style.display = ''; }
function bindMapCards(containerId, onPick) {
  const cards = document.querySelectorAll('#' + containerId + ' .mapCard');
  cards.forEach(card => card.onclick = () => { cards.forEach(c => c.classList.remove('sel')); card.classList.add('sel'); onPick(card.dataset.map); });
}
// 联机模式：P2P 接通后主机选图、广播给对方
function startMapLobby() {
  if (mode !== 'net') return;
  if (STATE.mapFinalized) return;
  STATE.mapFinalized = true;     // 防止重复进入
  hideAllPanels();
  showMenuBox();                 // 关键：hideAllPanels 把 menuBoxBody 设成了 display:none，
                                 // 不恢复的话，下面的选图面板虽然解除了 hidden 也依然不可见
                                 // （曾导致「连接成功却没有进入游戏」：两端都卡在看不见的大厅）
  $('mapLobbyPanel').classList.remove('hidden');
  if (gamemode === 'aavs') {
    // 防空车玩法：固定军事基地图；所有规模（含 1v1 拼手速）都走选阵营
    $('mapLobbyTitle').textContent = '军事基地 · 防空作战';
    if (iAmHost) {
      rebuildWorld('base');
      $('mapLobbyStatus').textContent = netSize > 2 ? '等待玩家选择阵营后自动开局…' : '拼手速选阵营，先抢先得…';
      startPickPhase();
    } else {
      $('mapLobbyStatus').textContent = '等待主机分配阵营并开局…';
      // 兜底仅防主机"冻结失联"（正常掉线由 onClose 秒级处理）：选阵营最长 45s + 主机选图时间，
      // 兜底必须 > 45s 且不能抢跑自行开局（提前开局会丢弃 pickList/team → 阵营错乱、地图错乱）
      mapLobbyTimerId = setTimeout(() => { if (!STATE.started) { banner('主机长时间未响应，请重新加入', '#ff7a6b', 3); setTimeout(() => location.reload(), 2500); } }, 60000);
    }
    return;
  }
  if (iAmHost) {
    $('mapLobbyTitle').textContent = '你是主机 · 选择空域';
    $('mapLobbyStatus').textContent = netSize > 2 ? '选定后进入选阵营，随后自动开局。' : '选定后即开局，双方使用同一张图。';
    $('lobbyMapChoice').style.display = '';
    bindMapCards('lobbyMapChoice', (map) => {
      rebuildWorld(map);
      if (netSize > 2) {
        startPickPhase();   // 3v3/5v5：选阵营（go 带 map）
      } else {
        netBroadcast({ t: 'map', map });
        beginMatch();
      }
    });
  } else {
    $('mapLobbyTitle').textContent = '等待主机选择空域';
    $('mapLobbyStatus').textContent = '正在等待主机选择地图…';
    // 非房主：从一开始就完全隐藏地图选择卡片
    $('lobbyMapChoice').style.display = 'none';
    // 超时兜底：仅防主机冻结失联（不可提前开局，否则 3v3 选阵营 45s 窗口内会抢跑且地图错误）
    mapLobbyTimerId = setTimeout(() => { if (!STATE.started) { banner('主机长时间未响应，请重新加入', '#ff7a6b', 3); setTimeout(() => location.reload(), 2500); } }, 60000);
  }
}

/* ================= 主菜单按钮 ================= */
// 玩法切换（顶部药丸：空战对决 / 防空车突袭），切换同时切换 3D 展示场景
function setMenuGm(gm) {
  gamemode = gm;
  document.querySelectorAll('#menuGmTabs .gmPill').forEach(p => p.classList.toggle('on', p.dataset.gm === gm));
  showMenuScene(gm);   // 切换展示：飞机停跑道 / 防空车+天上飞机
}
document.querySelectorAll('#menuGmTabs .gmPill').forEach(pill => {
  pill.onclick = () => setMenuGm(pill.dataset.gm);
});

function refreshPracticePanel() {
  const isAavs = gamemode === 'aavs';
  $('aavsSideChoice').classList.toggle('hidden', !isAavs);
  $('practiceMapChoice').classList.toggle('hidden', isAavs);
  $('practiceStatus').textContent = isAavs ? '军事基地 · 防空作战（固定地图），选择阵营后开始' : '点击地图即可开始';
}
$('btnHelp').onclick = () => { hideAllPanels(); $('helpPanel').classList.remove('hidden'); };
$('btnCloseHelp').onclick = () => { hideAllPanels(); };
$('btnPractice').onclick = () => {
  audio.init(); audio.resume();
  hideAllPanels();
  showMenuBox();
  $('practicePanel').classList.remove('hidden');
  refreshPracticePanel();
  bindMapCards('practiceMapChoice', (map) => startPractice('dogfight', null, map));
  document.querySelectorAll('#aavsSideChoice .sideCard').forEach(card => {
    card.onclick = () => {
      document.querySelectorAll('#aavsSideChoice .sideCard').forEach(c => c.classList.remove('sel'));
      card.classList.add('sel');
      startPractice('aavs', card.dataset.side, 'base');
    };
  });
};
$('btnBackFromPractice').onclick = () => location.reload();

/* ================= 联机：手动 SDP 交换（mesh 多人） ================= */
// 主机：选规模 → 逐个为每个好友生成邀请码并连接
let hostConnIdx = 0;     // 当前连到第几个好友
let hostNet = null;      // 当前正在连接的 Net

$('btnHost').onclick = async () => {
  audio.init(); audio.resume();
  mode = 'net'; iAmHost = true;
  hideAllPanels();
  showMenuBox();
  $('hostPanel').classList.remove('hidden');
  $('hostSizeChoice').querySelectorAll('.sizeCard').forEach(c => c.classList.remove('sel'));
  $('hostOfferRow').classList.add('hidden');
  if (gamemode === 'aavs') {
    // 防空车模式：阵营在开局前选阵营系统里定（1v1 拼手速 / 3v3+ 自由选择），不预选
    myTeam = -1; mySlot = 0;
    $('hostPanelTitle').textContent = '创建房间 · 选择规模';
    $('hostSideChoice').classList.add('hidden');
    $('hostSizeChoice').classList.remove('hidden');
  } else {
    // 空战模式：随机分红蓝（无阵营差异，随机合理）
    myTeam = Math.random() < 0.5 ? 0 : 1; mySlot = 0;
    $('hostPanelTitle').textContent = '创建房间 · 选择规模';
    $('hostSideChoice').classList.add('hidden');
    $('hostSizeChoice').classList.remove('hidden');
  }
  document.querySelectorAll('#hostSizeChoice .sizeCard').forEach(card => {
    card.onclick = () => {
      document.querySelectorAll('#hostSizeChoice .sizeCard').forEach(c => c.classList.remove('sel'));
      card.classList.add('sel');
      netSize = (card.dataset.size === '3v3') ? 6 : (card.dataset.size === '5v5') ? 10 : 2;
      $('hostOfferRow').classList.remove('hidden');
      hostConnIdx = 0;
      roster = [{ peerId: myPeerId, team: myTeam, slot: 0 }];
      updateHostStatus();
    };
  });
};
$('btnBackFromHost').onclick = () => location.reload();

function updateHostStatus() {
  const need = netSize - 1;
  const connected = Object.keys(nets).length;
  if (connected >= need) {
    $('hostStatus').textContent = '已全部连接(' + connected + '/' + need + ')，准备开局！';
    startMapLobby();   // 星型架构：无 mesh 名单广播，人齐直接进入选图/选阵营
  } else {
    $('hostStatus').textContent = '已连接 ' + connected + '/' + need + ' 人，继续生成邀请码连接下一位好友';
  }
}

$('btnGenOffer').onclick = async () => {
  audio.resume();
  const need = netSize - 1;
  if (Object.keys(nets).length >= need) { $('hostStatus').textContent = '已全部连接，无需再生成！'; return; }
  $('hostStatus').textContent = '正在生成邀请码…';
  hostNet = new Net();
  const peerKey = 'foe_' + hostConnIdx++;
  wireNet(hostNet, peerKey);
  try {
    const offer = await hostNet.createOffer();
    $('taOffer').value = offer;
    $('taAnswerHost').value = '';
    $('hostStatus').textContent = '邀请码已生成！复制发给第 ' + (Object.keys(nets).length + 1) + ' 位好友，等他发回应答码';
  } catch (e) {
    $('hostStatus').textContent = '失败：' + e.message;
  }
};
$('copyOffer').onclick = () => {
  $('taOffer').select();
  document.execCommand('copy');
  $('hostStatus').textContent = '已复制到剪贴板！';
};
$('btnConnHost').onclick = async () => {
  const ans = $('taAnswerHost').value.trim();
  if (!ans) { $('hostStatus').textContent = '请先粘贴好友的应答码！'; return; }
  if (!hostNet) { $('hostStatus').textContent = '请先点「生成邀请码」！'; return; }
  $('hostStatus').textContent = '正在连接…';
  try {
    await hostNet.acceptAnswer(ans);
    $('hostStatus').textContent = '应答已接受，等待 P2P 接通…';
    // 连接成功后由 hello 处理更新为「已连接 N/need」或「准备开局」
  } catch (e) {
    $('hostStatus').textContent = '连接失败：' + e.message;
  }
};

// 加入方：粘贴邀请码，生成应答码（阵营由主机随机分配，通过 team 消息告知）
$('btnJoin').onclick = () => {
  audio.init(); audio.resume();
  mode = 'net'; iAmHost = false; myTeam = -1; mySlot = 0;
  hideAllPanels();
  showMenuBox();
  $('joinPanel').classList.remove('hidden');
  $('joinStatus').textContent = '';
};
$('btnBackFromJoin').onclick = () => location.reload();

$('btnGenAnswer').onclick = async () => {
  const offer = $('taOfferJoin').value.trim();
  if (!offer) { $('joinStatus').textContent = '请先粘贴好友的邀请码！'; return; }
  $('joinStatus').textContent = '正在生成应答码…';
  const n = new Net();
  wireNet(n, myPeerId);
  try {
    const answer = await n.join(offer);
    $('taAnswerJoin').value = answer;
    $('joinStatus').textContent = '应答码已生成！复制发给好友，好友粘贴后即可连上。';
    // roster 在 onPeerOpen 里加
  } catch (e) {
    $('joinStatus').textContent = '失败：' + e.message;
  }
};
$('copyAnswer').onclick = () => {
  $('taAnswerJoin').select();
  document.execCommand('copy');
  $('joinStatus').textContent = '已复制到剪贴板！';
};

function beginMatch() {
  clearInterval(mapLobbyTimerId);
  clearInterval(pickCountTimer);
  pickPhase = false; myPickSide = -1; pickListGot = null;
  $('pickPanel').classList.add('hidden');
  clearMenuProps();   // 清理菜单展示实体，进入对局
  STATE.started = true;
  menu.classList.add('hidden');
  hud.classList.remove('hidden');
  if (isTouch) { setVoiceBtnsVisible(mode === 'net'); $('touchUI').classList.add('on'); syncVoiceBtn(); }   // 练习模式不显示语音按钮
  STATE.myScore = 0; STATE.foeScore = 0; STATE.s0 = 0; STATE.s1 = 0; STATE.roundNum = 0; STATE.matchEnded = false;
  killCount = 0; resetKillLedger();
  if (mode !== 'practice') buildAllUnits();
  updateScore();
  nextRound();
  banner('对决开始 · 五局三胜', '#dff1ff', 2.4);
  lockPointer();
}

/* ================= 相机 ================= */
const _fwd = new THREE.Vector3(), _camPos = new THREE.Vector3(), _look = new THREE.Vector3();
const _viewE = new THREE.Euler(), _viewDir = new THREE.Vector3();
function updateCamera(dt) {
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
        {
          const cp2 = Math.cos(spec.pitch), sp2 = Math.sin(spec.pitch);
          const cy2 = Math.cos(spec.yaw), sy2 = Math.sin(spec.yaw);
          _camPos.set(st.position.x + cp2 * sy2 * spec.dist, st.position.y + sp2 * spec.dist, st.position.z + cp2 * cy2 * spec.dist);
          if (_camPos.y < 2.5) _camPos.y = 2.5;   // 防钻地
          camera.position.lerp(_camPos, 1 - Math.exp(-8 * dt));
          camera.lookAt(st.position);
        }
      } else {
        _look.copy(deathPos);
        camera.position.lerp(tmpA.copy(_look).add(new THREE.Vector3(0, 18, 42)), 1 - Math.exp(-3 * dt));
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
    _look.copy(myPlane.group.position).addScaledVector(_viewDir, 42); _look.y += h;
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
      camera.position.lerp(tmpA.copy(_look).add(new THREE.Vector3(0, 14, 36)), 1 - Math.exp(-3 * dt));
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

/* ================= 敌我标记池（DOM投影，复用foeMarker逻辑） ================= */
const _v4 = new THREE.Vector4();
function projectToScreen(pos3) {
  _v4.set(pos3.x, pos3.y, pos3.z, 1).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
  const w = _v4.w || 1;
  return { x: (_v4.x / w * 0.5 + 0.5) * window.innerWidth, y: (-_v4.y / w * 0.5 + 0.5) * window.innerHeight, z: _v4.z / w, w };
}
function updateMarkers() {
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
      const sx = projectToScreen(pl.plane.group.position);
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
      const sx = projectToScreen(ag.aagun.group.position);
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

/* ================= 死亡观战（多人模式：死亡后自由环视战场，敌我标记照常显示） =================
   激活：联机 + 已开局 + 我死亡 + 比赛未结束。轨道环绕存活单位（优先队友），
   鼠标增量=环视 / 滚轮=距离 / 左键=切换目标；目标阵亡自动换人；复活/终局自动退出。 */
function specTargets() {
  const list = [];
  for (const id in planes) {
    const pl = planes[id];
    if (pl.alive) list.push({ id, obj: pl.plane.group, team: pl.team, name: pl.isBot ? 'AI' : '玩家' + (pl.slot + 1) });
  }
  for (const id in aaguns) {
    const ag = aaguns[id];
    if (ag.alive) list.push({ id, obj: ag.aagun.group, team: ag.team, name: ag.isBot ? 'AI防空车' : '玩家' + (ag.slot + 1) });
  }
  list.sort((a, b) => ((a.team === myTeam ? 0 : 1) - (b.team === myTeam ? 0 : 1)));   // 队友优先
  return list;
}
function specPick(cycle) {
  const list = specTargets();
  if (!list.length) { spec.targetId = null; return null; }
  let i = list.findIndex((t) => t.id === spec.targetId);
  if (i < 0) i = 0;
  else if (cycle) i = (i + 1) % list.length;
  spec.targetId = list[i].id;
  if (specLabel) specLabel.textContent = '👁 观战中 · 跟随 ' + list[i].name + (list[i].team === myTeam ? '（队友）' : '（敌方）') + ' · 移动鼠标环视 · 滚轮缩放 · 左键切换目标';
  return list[i];
}
function specTargetObj() {
  if (!spec.active || !spec.targetId) return null;
  const t = specTargets().find((x) => x.id === spec.targetId);
  return t ? t.obj : null;
}
function specUpdateActive() {
  const dead = meIsAAGun ? (meAAGun ? !meAAGun.alive : false) : (me ? !me.alive : false);
  const on = mode === 'net' && STATE.started && !STATE.matchEnded && dead;
  if (on && !spec.active) {
    spec.active = true; spec.targetId = null;
    if (!specLabel) {
      specLabel = document.createElement('div');
      specLabel.style.cssText = 'position:fixed;left:50%;bottom:12%;transform:translateX(-50%);z-index:55;font:600 13px/1.5 "Noto Sans SC","PingFang SC",sans-serif;color:#dff1ff;background:rgba(8,18,32,.72);border:1px solid rgba(110,190,255,.3);border-radius:999px;padding:8px 18px;backdrop-filter:blur(6px);pointer-events:none;display:none;';
      document.body.appendChild(specLabel);
    }
    specLabel.style.display = 'block';
    specPick(false);
  } else if (!on && spec.active) {
    spec.active = false;
    if (specLabel) specLabel.style.display = 'none';
    spec.targetId = null;
  }
  if (spec.active && !specTargets().some((t) => t.id === spec.targetId)) specPick(false);   // 目标阵亡自动换人
}

/* ================= 多人状态栏（两队队员血量，死亡变灰） ================= */
function buildRosterRow(container, units, cls) {
  container.innerHTML = '';
  for (const u of units) {
    const el = document.createElement('span');
    el.className = 'rosterUnit ' + cls + (u.alive ? '' : ' dead');
    // 血条按各自最大血量归一化（飞机 100 / 防空车 120），否则防空车 >100% 被裁掉、最后 20 点血不可视
    const pct = Math.max(0, Math.round((u.hp / (u.max || 100)) * 100));
    el.innerHTML = '<span class="uName">' + u.name + '</span><span class="uBar"><span class="uFill" style="width:' + pct + '%"></span></span>';
    container.appendChild(el);
  }
}
function updateRoster() {
  if (mode === 'practice') { rosterPanel.classList.add('hidden'); return; }
  rosterPanel.classList.remove('hidden');
  const mine = [], foe = [];
  const pushUnit = (team, name, hp, alive, max) => (team === myTeam ? mine : foe).push({ name, hp, alive, max });
  if (meIsAAGun) pushUnit(myTeam, '我', meAAGun ? meAAGun.hp : 0, meAAGun ? meAAGun.alive : false, AAGUN_HP);
  else pushUnit(myTeam, '我', me ? me.hp : 0, me ? me.alive : false, 100);
  for (const id in planes) {
    const pl = planes[id];
    pushUnit(pl.team, pl.isBot ? 'AI' : 'P' + (pl.slot + 1), pl.hp, pl.alive, 100);
  }
  for (const id in aaguns) {
    const ag = aaguns[id];
    pushUnit(ag.team, ag.isBot ? 'AA' : 'AA' + (ag.slot + 1), ag.hp, ag.alive, AAGUN_HP);
  }
  buildRosterRow(rosterMineUnits, mine, 'mine');
  buildRosterRow(rosterFoeUnits, foe, 'foe');
}

/* ================= 主循环 ================= */
const clock = new THREE.Clock();

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  const now = performance.now();
  if (world) world.update(dt, now * 0.001);
  effects.update(dt);

  fpsCnt++;
  if (now - fpsT >= 500) { const f = Math.round(fpsCnt * 1000 / (now - fpsT)); fpsT = now; fpsCnt = 0; fpsValEl.textContent = f; }

  if (STATE.started) {
    specUpdateActive();   // 死亡观战状态机（复活/终局自动退出）
    const ctlActive = locked || isTouch;
    const rawAccX = accX, rawAccY = accY;
    accX = 0; accY = 0;   // 每帧消费一次，避免松手后残留转向
    if (spec.active) {    // 观战：鼠标增量 → 环绕视角
      spec.yaw -= rawAccX * 0.0035;
      spec.pitch = THREE.MathUtils.clamp(spec.pitch + rawAccY * 0.0025, -0.05, 1.25);
    }
    if (meIsAAGun) {
      // === 防空车玩家控制（坦克式移动 + 炮塔） ===
      // 出海保险：防空车 y 固定 0（沿地面移动，不会坠海），改用水平距离检测——出岛（>430）即报废
      if (meAAGun.alive && Math.hypot(myAAGun.group.position.x, myAAGun.group.position.z) > 430) selfDestructAAGun();
      if (meAAGun.alive && !STATE.roundOver) {
        // 鼠标/触屏滑动 → 炮塔旋转（1:1无延迟），俯仰向上为主
        meAAGun.turretYaw += (ctlActive ? -rawAccX * SENS : 0);
        meAAGun.turretPitch = THREE.MathUtils.clamp(meAAGun.turretPitch + (ctlActive ? -rawAccY * SENS : 0), -0.15, 1.35);
        // WASD 坦克式移动：W前进 S后退 A/D 转车体（履带车约 12 单位/s ≈ 43 km/h）
        let mv = 0;
        if (keys.KeyW) mv = 12;
        else if (keys.KeyS) mv = -6;
        // 触屏：targetSpeed 已由摇杆设置（setJoy），此处不覆盖，否则手机端无法移动
        if (!isTouch) meAAGun.targetSpeed = mv;
        meAAGun.speed += (meAAGun.targetSpeed - meAAGun.speed) * Math.min(1, dt * 2);
        if (keys.KeyA) meAAGun.bodyYaw += 1.05 * dt;
        if (keys.KeyD) meAAGun.bodyYaw -= 1.05 * dt;
        // 手机摇杆：X轴 = 车体转向
        if (isTouch && Math.abs(joySteerX) > 0.05) meAAGun.bodyYaw += -joySteerX * 1.2 * dt;
        if (Math.abs(meAAGun.speed) > 0.1) {
          const prev = _agPos.copy(myAAGun.group.position);
          forwardOfBody(meAAGun, _agDir);
          myAAGun.group.position.addScaledVector(_agDir, meAAGun.speed * dt);
          // 建筑/围栏碰撞回退 + 护栏径向阻挡（围栏是圆形，径向检测最贴合，防开出岛）
          const outR = Math.hypot(myAAGun.group.position.x, myAAGun.group.position.z);
          if (outR > 393 || collideTerrain({ group: myAAGun.group })) myAAGun.group.position.copy(prev);
        }
        applyAAGun(meAAGun);
        warnOn = false;
        // 高射机枪射击
        fireT -= dt;
        if (firing && fireT <= 0) {
          fireT = 0.08;
          const shot = fireGunAAGun(meAAGun, 'me');
          audio.shoot();
          if (mode !== 'practice') {
            if (iAmHost) netBroadcast({ t: 'blt', o: shot.origin.toArray(), d: shot.dir.toArray(), ...bulletNetParams(shot) });   // 房主开火：广播子弹供显示/预判（带实际弹道参数）
            else {
              const fid = ++myFireSeq;
              if (shot.bullet) shot.bullet.fid = fid;   // 本地预判命中时对账用
              netBroadcast({ t: 'fire', o: shot.origin.toArray(), d: shot.dir.toArray(), fid, ...bulletNetParams(shot) });
            }
          }
        }
      } else firing = false;
      warnEl.style.opacity = 0;
    } else if (me.alive && !STATE.roundOver) {
      // === 视角领先+飞机追赶操控（类似 Ace Combat / War Thunder） ===
      // 鼠标/触屏滑动 → 累积到 aimYaw/aimPitch（视角偏移，1:1无延迟）
      // 飞机以 TURN_RATE 追赶视角方向 → 慢移时几乎同步，快甩时视角先转飞机再追
      aimYaw = THREE.MathUtils.clamp(aimYaw + (ctlActive ? -rawAccX * SENS : 0), -MAX_AIM, MAX_AIM);
      aimPitch = THREE.MathUtils.clamp(aimPitch + (ctlActive ? -rawAccY * SENS : 0), -MAX_AIM, MAX_AIM);
      // 手机摇杆X轴：连续转向指令（左=aimYaw正=左转，右=aimYaw负=右转）
      if (isTouch && Math.abs(joySteerX) > 0.05) {
        aimYaw = THREE.MathUtils.clamp(aimYaw - joySteerX * 2.0 * dt, -MAX_AIM, MAX_AIM);
      }
      // 飞机追赶视角（aim 偏移驱动飞机转向，转向后 aim 减小 = 飞机追上了视角）
      const dyaw = aimYaw;
      const stepYaw = THREE.MathUtils.clamp(dyaw, -TURN_RATE * dt, TURN_RATE * dt);
      me.yaw += stepYaw; me.yawVel = stepYaw / Math.max(dt, 1e-4);
      aimYaw -= stepYaw;
      const dpitch = aimPitch;
      const stepPitch = THREE.MathUtils.clamp(dpitch, -PITCH_RATE * dt, PITCH_RATE * dt);
      me.pitch = THREE.MathUtils.clamp(me.pitch + stepPitch, -1.15, 1.15);
      aimPitch -= stepPitch;

      if (keys.KeyW) me.targetSpeed = Math.min(SPEED_MAX, me.targetSpeed + 70 * dt);
      if (keys.KeyS) me.targetSpeed = Math.max(SPEED_MIN, me.targetSpeed - 70 * dt);
      applyFlight(me, dt);

      const p = myPlane.group.position;
      const r = Math.hypot(p.x, p.z);
      warnOn = false;
      if (r > WORLD.BOUNDARY_WARN) { warnOn = true; warnEl.textContent = '警告：请返回战斗空域'; }
      if (p.y > WORLD.CEILING) { warnOn = true; warnEl.textContent = '警告：高度过高，立即下降'; }
      if (r > WORLD.BOUNDARY_HURT || p.y > WORLD.CEILING + 60) { dmgAcc += dt; if (dmgAcc > 0.5) { dmgAcc = 0; applyMeDamage(3); if (mode !== 'practice' && !iAmHost) netSendEventTo(hostPeerId, { t: 'envDmg', dmg: 3 }); } }
      if (warnOn) { beepT -= dt; if (beepT <= 0) { beepT = 0.7; audio.beep(); } }
      if (p.y < 3.5) selfDestruct();

      // 撞楼/撞山 = 瞬死（与撞地撞海同规则）；联机经 selfDestruct 内部上报房主权威判定
      if (collideTerrain(myPlane)) selfDestruct();

      fireT -= dt;
      if (firing && fireT <= 0) {
        fireT = 0.09;
        const shot = fireGun(me, 'me');
        audio.shoot();
        if (mode !== 'practice') {
          if (iAmHost) netBroadcast({ t: 'blt', o: shot.origin.toArray(), d: shot.dir.toArray(), ...bulletNetParams(shot) });   // 房主开火：广播子弹供显示/预判（带实际弹道参数）
          else {
            const fid = ++myFireSeq;
            if (shot.bullet) shot.bullet.fid = fid;   // 本地预判命中时对账用
            netBroadcast({ t: 'fire', o: shot.origin.toArray(), d: shot.dir.toArray(), fid, ...bulletNetParams(shot) });
          }
        }
      }
    } else firing = false;
    warnEl.style.opacity = warnOn ? 1 : 0;

    /* ---- 其他飞机更新 ---- */
    for (const id in planes) {
      const pl = planes[id];
      if (pl.isBot && pl.bot) {
        if (pl.alive && !STATE.roundOver) {
          // AI 目标选择：最近的敌方单位（飞机 或 防空车）
          let target = null, bestDist = Infinity;
          const ppos = pl.plane.group.position;
          const tryTarget = (t, tp) => {
            if (!t) return;
            const d = ppos.distanceTo(tp);
            if (d < bestDist) { bestDist = d; target = t; }
          };
          if (meIsAAGun) {
            if (meAAGun.alive && myTeam !== pl.team) tryTarget({ plane: { group: myAAGun.group }, speed: 0, alive: true }, myAAGun.group.position);
          } else if (me && me.alive && myTeam !== pl.team) {
            tryTarget(me, myPlane.group.position);
          }
          for (const oid in planes) { const o = planes[oid]; if (o.team !== pl.team && o.alive) tryTarget(o, o.plane.group.position); }
          for (const oid in aaguns) { const o = aaguns[oid]; if (o.team !== pl.team && o.alive) tryTarget({ plane: { group: o.aagun.group }, speed: 0, alive: true }, o.aagun.group.position); }
          if (target) {
            pl.bot.update(dt, target, (b) => {
              const shot = fireGun(b, id);
              const myPos = meIsAAGun ? myAAGun.group.position : (myPlane ? myPlane.group.position : shot.origin);
              audio.enemyShoot(shot.origin.distanceTo(myPos));
            });
          } else {
            // 目标全灭：巡航回中心
            const dummy = { plane: { group: { position: new THREE.Vector3(0, 300, 0) } }, speed: 0, alive: true };
            pl.bot.update(dt, dummy, () => {});
          }
          applyFlight(pl.bot, dt);
          // bot 撞楼/撞山 = 瞬死（与玩家同规则，房主/人机权威判定）
          if (collideTerrain(pl.plane)) peerDie(id);
        }
      } else if (pl.alive) {
        const k = 1 - Math.exp(-12 * dt);
        pl.plane.group.position.lerp(pl.tPos, k);
        pl.plane.group.quaternion.slerp(pl.tQuat, k);
        if (pl.plane.prop) pl.plane.prop.rotation.z -= dt * 40;
      }
    }

    /* ---- 防空车更新 ---- */
    for (const id in aaguns) {
      const ag = aaguns[id];
      // 出海保险：出岛（水平距离 >430）立即报废（防空车 y 固定 0，用水平距离判断）
      if (ag.alive && Math.hypot(ag.aagun.group.position.x, ag.aagun.group.position.z) > 430) { peerDie(id); continue; }
      if (ag.isBot && ag.bot) {
        if (ag.alive && !STATE.roundOver) {
          // 防空车AI：跟踪最近的敌方飞机
          let target = null, bestDist = Infinity;
          const gpos = ag.aagun.group.position;
          const tryT = (t, tp) => {
            if (!t) return;
            const d = gpos.distanceTo(tp);
            if (d < bestDist) { bestDist = d; target = t; }
          };
          if (!meIsAAGun && me && me.alive && myTeam !== ag.team) tryT(me, myPlane.group.position);
          for (const oid in planes) { const o = planes[oid]; if (o.team !== ag.team && o.alive) tryT(o, o.plane.group.position); }
          const agPrev = _agPos.copy(ag.aagun.group.position);
          if (target) {
            ag.bot.update(dt, target, (aa) => {
              const shot = fireGunAAGun(aa, 'bot');
              const myPos = meIsAAGun ? myAAGun.group.position : (myPlane ? myPlane.group.position : shot.origin);
              audio.enemyShoot(shot.origin.distanceTo(myPos));
            });
          }
          applyAAGun(ag.ent);
          // AI 巡逻移动的碰撞回退（建筑/围栏）+ 护栏径向阻挡
          if (Math.hypot(ag.aagun.group.position.x, ag.aagun.group.position.z) > 393 || collideTerrain({ group: ag.aagun.group })) ag.aagun.group.position.copy(agPrev);
        }
      } else if (ag.alive) {
        const k = 1 - Math.exp(-12 * dt);
        ag.aagun.group.position.lerp(ag.tPos, k);
        let dy = ag.tTurretYaw - ag.ent.turretYaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        ag.ent.turretYaw += dy * k;
        ag.ent.turretPitch += (ag.tTurretPitch - ag.ent.turretPitch) * k;
        let dby = ag.tBodyYaw - ag.ent.bodyYaw;
        while (dby > Math.PI) dby -= Math.PI * 2;
        while (dby < -Math.PI) dby += Math.PI * 2;
        ag.ent.bodyYaw += dby * k;
        applyAAGun(ag.ent);
      }
    }

    /* ---- 空中相撞 ---- */
    if (crashCd > 0) crashCd -= dt;
    if (!meIsAAGun && me.alive && !STATE.roundOver) {
      for (const id in planes) {
        const pl = planes[id];
        if (!pl.alive) continue;
        if (myPlane.group.position.distanceTo(pl.plane.group.position) < 7) {
          if (crashCd > 0) break;
          // 房主小世界去重：房主端结算过的碰撞，对方上报的同一条碰撞不再重复结算
          if (iAmHost && mode !== 'practice' && !markCrashPair(myPeerId, id)) break;
          if (pl.team === myTeam) {
            // 友军相撞：仅碰撞损伤，不致命（实时性强 → 本地预判扣血，房主权威结算后 sync 确认）
            crashCd = 0.8;
            effects.sparks(myPlane.group.position, 0xffcf6b); audio.damageTaken();
            applyMeDamage(12, true);   // 本地预判扣血（不判死）；房主端为权威扣血
            if (pl.isBot) { pl.hp = Math.max(1, pl.hp - 12); }
            else if (iAmHost) applyPeerDamage(id, 12);   // 房主权威：扣对方
            else if (mode === 'practice') pl.hp = Math.max(1, pl.hp - 12);
            else {
              // 非房主：预判扣对方血 + 上报房主权威（crash 必被结算，sync 会确认预判）
              pl.hp = Math.max(1, pl.hp - 12); pl.predTotal = (pl.predTotal || 0) + 12;
              netSendEventTo(hostPeerId, { t: 'crash', target: id, dmg: 12 });
            }
          } else {
            // 敌机相撞：同归于尽（平局）——人机/房主端双方都判死；非房主上报房主权威裁决
            crashCd = 0.8;
            if (iAmHost || mode === 'practice') {
              lastDmgFrom = myPeerId;
              if (pl.isBot) { pl.hp = 0; peerDie('bot'); }   // 人机：bot 权威判死
              else peerDie(id);                               // 房主小世界：对方权威判死
              lastDmgFrom = null;
              lastDmgFrom = id;
              selfDestruct();   // 自己同判 → 内部 checkRoundEnd：双方归零 → 立即平局
              lastDmgFrom = null;
            } else {
              netBroadcast({ t: 'crash', target: id, fatal: true });   // 上报房主：权威同归于尽（对方端若未检测到也强制）
            }
          }
          break;
        }
      }
    }

    /* ---- 飞机撞防空车：判定平局（双方同归于尽） ---- */
    const CRASH_R = 8.5;
    if (!meIsAAGun && me.alive && !STATE.roundOver) {
      // 玩家飞机撞防空车：同归于尽（平局）——死亡由权威裁决，非房主只上报
      for (const id in aaguns) {
        const ag = aaguns[id];
        if (!ag.alive) continue;
        if (myPlane.group.position.distanceTo(ag.aagun.group.position) < CRASH_R) {
          if (iAmHost && mode !== 'practice' && !markCrashPair(myPeerId, id)) break;
          // 同归于尽：人机/房主端双方都判死（bot 防空车也死）；非房主上报房主权威
          if (iAmHost || mode === 'practice') {
            lastDmgFrom = myPeerId;
            if (ag.isBot) { ag.hp = 0; peerDie('bot'); }   // 人机：bot 防空车权威判死
            else peerDie(id);                               // 房主小世界：对方权威判死
            lastDmgFrom = null;
            lastDmgFrom = id;
            selfDestruct();   // 自己同判 → 双方归零 → 立即平局
            lastDmgFrom = null;
          } else {
            netBroadcast({ t: 'crash', target: id, fatal: true });   // 上报房主：权威同归于尽
          }
          break;
        }
      }
    }
    if (meIsAAGun && meAAGun.alive && !STATE.roundOver) {
      // 玩家防空车被飞机撞：同归于尽（平局）——死亡由权威裁决，非房主只上报
      for (const id in planes) {
        const pl = planes[id];
        if (!pl.alive) continue;
        if (myAAGun.group.position.distanceTo(pl.plane.group.position) < CRASH_R) {
          if (iAmHost && mode !== 'practice' && !markCrashPair(myPeerId, id)) break;
          // 同归于尽：人机/房主端双方都判死（bot 飞机也死）；非房主上报房主权威
          if (iAmHost || mode === 'practice') {
            lastDmgFrom = myPeerId;
            if (pl.isBot) { pl.hp = 0; peerDie('bot'); }   // 人机：bot 飞机权威判死
            else peerDie(id);                               // 房主小世界：对方权威判死
            lastDmgFrom = null;
            lastDmgFrom = id;
            selfDestructAAGun();  // 自己同判 → 双方归零 → 立即平局
            lastDmgFrom = null;
          } else {
            netBroadcast({ t: 'crash', target: id, fatal: true });   // 上报房主：权威同归于尽
          }
          break;
        }
      }
    }
    // AI 飞机撞 AI/其他防空车（本地模拟）
    for (const id in planes) {
      const pl = planes[id];
      if (!pl.alive || !pl.isBot) continue;
      for (const oid in aaguns) {
        const ag = aaguns[oid];
        if (!ag.alive) continue;
        if (pl.plane.group.position.distanceTo(ag.aagun.group.position) < CRASH_R) {
          peerDie(id);
          peerDie(oid);
          break;
        }
      }
    }

    /* ---- 子弹 ---- */
    for (const b of bullets) {
      if (!b.active) continue;
      b.prev.copy(b.pos); b.pos.addScaledVector(b.vel, dt); b.life -= dt; b.mesh.position.copy(b.pos);
      if (b.life <= 0) { foeBulletMiss(b); b.active = false; b.mesh.visible = false; continue; }
      // 溅射子弹不因落地消失（由落地爆炸逻辑处理）；普通子弹落地即消失
      if (b.pos.y < 0 && !b.splash) { foeBulletMiss(b); b.active = false; b.mesh.visible = false; continue; }
      // 子弹撞楼/撞山：火花四溅即消失（foeBulletMiss 保持房主否决对账一致——该弹未命中任何目标）
      if ((b.src === 'me' || b.src === 'foeVis' || b.src === 'bot') && hitWorldAt(b.pos)) {
        effects.sparks(b.pos, 0xcfd6dd);
        b.active = false; b.mesh.visible = false;
        foeBulletMiss(b);
        continue;
      }
      if (b.src === 'me' || b.src === 'foeVis') {
        // 市售网游模式（服务器=房主）：实时性强的伤害本地预判（先扣血+上报），
        // 房主权威裁决——命中则 sync 确认；未命中则 dmgReject 立即回溯
        const nowMs = performance.now();
        // 信任命中检测（宽容延迟补偿）：开火者上报的命中点，子弹到达其 22m 内即按上报结算
        // （开火者看到的是 ~RTT/2 之前的敌人位置，与房主小世界位置存在固有偏差——用上报点兜底）
        if (iAmHost && b.trust && !b.fHit) {
          const tp = b.trust;
          let tgPos = null;
          if (tp.id === myPeerId) tgPos = meIsAAGun ? myAAGun.group.position : myPlane.group.position;
          else if (planes[tp.id] && planes[tp.id].alive) tgPos = planes[tp.id].plane.group.position;
          else if (aaguns[tp.id] && aaguns[tp.id].alive) tgPos = aaguns[tp.id].aagun.group.position;
          if (tgPos && tgPos.distanceTo(tp.p) < 60 && tgPos.distanceTo(b.pos) < 22) {
            b.fHit = true; b.active = false; b.mesh.visible = false;
            delete fireBullets[(b.fFrom || '') + ':' + b.fid];
            effects.sparks(b.pos, 0xffe08a); audio.hitConfirm();
            lastDmgFrom = b.fFrom || null; trustDamage(tp.id, tp.dmg); lastDmgFrom = null;   // 击杀归因=开火者
            continue;
          }
        }
        // 打所有非房主飞机
        for (const id in planes) {
          const pl = planes[id];
          if (!pl.alive) continue;
          if (mode === 'practice' && pl.team === myTeam) continue;
          // 延迟补偿限制：房主端命中时，若该玩家上报位置过旧（飞机 >350ms）则跳过（位置不可信）
          if (iAmHost && mode !== 'practice' && nowMs - (pl.lastState || 0) > 350) continue;
          const wp = checkBulletHit(b, pl.plane);
          if (wp) {
            b.active = false; b.mesh.visible = false;
            effects.sparks(b.pos, 0xffe08a); audio.hitConfirm();
            const dmg = Math.round(b.dmg * wp.mult);
            const isFriend = pl.team === myTeam;
            showHitmark(pl.hp - dmg <= 0);
            showPart((isFriend ? '误伤' : '命中') + wp.name + (wp.mult > 1 ? '  x' + wp.mult : ''));
            const bulletKiller = (b.src === 'me') ? myPeerId : (b.fFrom || null);   // 击杀归因：自己的弹=我；他人弹=开火者
            if (pl.hp - dmg <= 0 && !isFriend && b.src === 'me') killCount++;   // 预判击杀只认自己的子弹（权威结果由 kstat 台账对账）
            if (pl.isBot) { lastDmgFrom = bulletKiller; pl.hp -= dmg; if (pl.hp <= 0) peerDie('bot'); lastDmgFrom = null; }
            else if (iAmHost) { b.fHit = true; lastDmgFrom = bulletKiller; applyPeerDamage(id, dmg); lastDmgFrom = null; }   // 房主权威结算
            else if (mode !== 'practice') {
              // 非房主：本地预判扣血（立即反馈）+ 记录对账（房主否决 → dmgReject 回溯）
              pl.hp -= dmg; pl.predTotal = (pl.predTotal || 0) + dmg;
              recordFirePred(b.fid, id, dmg);
              // 命中上报：带命中瞬间目标位置（房主信任窗口判定 / 延迟补偿）
              if (b.fid) { const hp3 = pl.plane.group.position; netSendEventTo(hostPeerId, { t: 'hitRep', fid: b.fid, id, p: [hp3.x, hp3.y, hp3.z], dmg }); }
              break;
            }
            break;
          }
        }
        // 打所有防空车
        if (!b.active) { /* 已命中飞机 */ }
        else for (const id in aaguns) {
          const ag = aaguns[id];
          if (!ag.alive) continue;
          if (mode === 'practice' && ag.team === myTeam) continue;
          if (iAmHost && mode !== 'practice' && nowMs - (ag.lastState || 0) > 400) continue;   // 防空车上报过期限制
          const wp = checkAAGunHit(b, ag);
          if (wp) {
            b.active = false; b.mesh.visible = false;
            effects.sparks(b.pos, 0xffe08a); audio.hitConfirm(); effects.shake(0.2);
            const dmg = Math.round(b.dmg * wp.mult);
            const isFriend = ag.team === myTeam;
            showHitmark(ag.hp - dmg <= 0);
            showPart((isFriend ? '误伤' : '命中') + wp.name + (wp.mult > 1 ? '  x' + wp.mult : ''));
            const bulletKiller = (b.src === 'me') ? myPeerId : (b.fFrom || null);   // 击杀归因：自己的弹=我；他人弹=开火者
            if (ag.hp - dmg <= 0 && !isFriend && b.src === 'me') killCount++;   // 预判击杀只认自己的子弹（权威结果由 kstat 台账对账）
            if (ag.isBot) { lastDmgFrom = bulletKiller; ag.hp -= dmg; if (ag.hp <= 0) peerDie('bot'); lastDmgFrom = null; }
            else if (iAmHost) { b.fHit = true; lastDmgFrom = bulletKiller; applyPeerDamage(id, dmg); lastDmgFrom = null; }
            else if (mode !== 'practice') {
              // 非房主：本地预判扣血 + 记录对账（房主否决 → dmgReject 回溯）
              ag.hp -= dmg; ag.predTotal = (ag.predTotal || 0) + dmg;
              recordFirePred(b.fid, id, dmg);
              if (b.fid) { const hp3 = ag.aagun.group.position; netSendEventTo(hostPeerId, { t: 'hitRep', fid: b.fid, id, p: [hp3.x, hp3.y, hp3.z], dmg }); }
            }
            break;
          }
        }
        // 直击未命中 → 机炮溅射补偿（防空车玩法）：近车爆炸 / 落地爆炸
        if (b.active && b.splash) {
          for (const id in aaguns) {
            const ag = aaguns[id];
            if (!ag.alive) continue;
            if (mode === 'practice' && ag.team === myTeam) continue;
            if (iAmHost && mode !== 'practice' && nowMs - (ag.lastState || 0) > 400) continue;
            if (ag.aagun.group.position.distanceTo(b.pos) < SPLASH_R) {
              applySplashToAAGun(ag, b.pos, b);
              b.active = false; b.mesh.visible = false;
              effects.explosion(b.pos, 0.5); audio.hitConfirm();
              break;
            }
          }
          if (b.active && b.pos.y < 1.2) {
            // 打到地面/水面：爆炸溅射（范围伤害），提前触发避免垂直下落帧跨越被吞
            b.active = false; b.mesh.visible = false;
            const boom = tmpA.copy(b.pos); if (boom.y < 0.3) boom.y = 0.3;
            effects.sparks(boom, 0xffcf6b); effects.shake(0.12);
            for (const id in aaguns) {
              const ag = aaguns[id];
              if (!ag.alive) continue;
              if (mode === 'practice' && ag.team === myTeam) continue;
              if (iAmHost && mode !== 'practice' && nowMs - (ag.lastState || 0) > 400) continue;
              applySplashToAAGun(ag, b.pos, b);
            }
            foeBulletMiss(b);   // 溅射落地但未伤到任何车 → 视为未命中，否决开火者预判
          }
        }
        // 敌方子弹（非房主上报 / blt 收到）打自己：房主端权威扣血；非房主端本地预判扣血（不判死，sync 权威覆盖/回溯）
        if (b.src === 'foeVis' && !STATE.roundOver) {
          if (meIsAAGun) {
            if (meAAGun && meAAGun.alive) {
              const wp = checkAAGunHit(b, meAAGun);
              if (wp) {
                b.active = false; b.mesh.visible = false; b.fHit = true;
                effects.sparks(b.pos, 0xffb3a0); showPart('被击中' + wp.name);
                if (iAmHost) { lastDmgFrom = b.fFrom || null; applyMeAAGunDamage(Math.round(b.dmg * wp.mult)); lastDmgFrom = null; }
                else if (mode !== 'practice') applyMeAAGunDamage(Math.round(b.dmg * wp.mult), true);
              }
              else if (b.splash && b.active) {
                // 机炮溅射打玩家防空车
                if (myAAGun.group.position.distanceTo(b.pos) < SPLASH_R || b.pos.y < 1.2) {
                  const dmg = Math.max(2, Math.round(SPLASH_DMG * 0.8));
                  b.active = false; b.mesh.visible = false; b.fHit = true;
                  effects.sparks(b.pos, 0xffb3a0); showPart('溅射 ' + dmg);
                  if (iAmHost) { lastDmgFrom = b.fFrom || null; applyMeAAGunDamage(dmg); lastDmgFrom = null; }
                  else if (mode !== 'practice') applyMeAAGunDamage(dmg, true);
                }
              }
            }
          } else if (me && me.alive) {
            const wp = checkBulletHit(b, myPlane);
            if (wp) {
              b.active = false; b.mesh.visible = false; b.fHit = true;
              effects.sparks(b.pos, 0xffb3a0); showPart('被击中' + wp.name);
              if (iAmHost) { lastDmgFrom = b.fFrom || null; applyMeDamage(Math.round(b.dmg * wp.mult)); lastDmgFrom = null; }
              else if (mode !== 'practice') applyMeDamage(Math.round(b.dmg * wp.mult), true);
            }
          }
        }
      } else if (b.src === 'bot' && !STATE.roundOver) {
        // AI子弹：打玩家实体（飞机或防空车）——仅练习模式
        if (meIsAAGun) {
          if (!meAAGun.alive) continue;
          const wp = checkAAGunHit(b, meAAGun);
          if (wp) { b.active = false; b.mesh.visible = false; effects.sparks(b.pos, 0xffb3a0); showPart('被击中' + wp.name); applyMeAAGunDamage(Math.round(b.dmg * wp.mult)); }
          else if (b.splash && b.active) {
            // AI 机炮溅射打玩家防空车
            if (myAAGun.group.position.distanceTo(b.pos) < SPLASH_R || b.pos.y < 1.2) {
              const dmg = Math.max(2, Math.round(SPLASH_DMG * 0.8));
              b.active = false; b.mesh.visible = false;
              effects.sparks(b.pos, 0xffb3a0); showPart('溅射 ' + dmg);
              applyMeAAGunDamage(dmg);
            }
          }
        } else if (me.alive) {
          const wp = checkBulletHit(b, myPlane);
          if (wp) { b.active = false; b.mesh.visible = false; effects.sparks(b.pos, 0xffb3a0); showPart('被击中' + wp.name); applyMeDamage(Math.round(b.dmg * wp.mult)); }
        }
      }
    }

    /* ---- 队伍淘汰宽限期 ---- */
    if (STATE.teamElimTimer > 0) {
      STATE.teamElimTimer -= dt;
      if (STATE.teamElimTimer <= 0) {
        if (mode === 'practice' || iAmHost) settleRound(STATE.eliminatedTeam === myTeam ? 'foe' : 'me');
        else STATE.teamElimTimer = 0;   // 非房主端回合结算由房主 rEnd/sync 权威驱动
      }
    }

    /* ---- 状态同步（20Hz）：房主小世界 ---- */
    if (mode !== 'practice' && Object.keys(nets).length > 0) {
      stateT += dt;
      if (stateT >= 0.05) {
        stateT = 0;
        processNetReconcile();   // 网络对账杂项：否决队列过期下发 / 被打预判超时回滚
        if (iAmHost) {
          pushWorldSync();   // 房主：小世界权威快照推送给所有人
        } else {
          // 非房主：上报自己的位置/朝向/速度（房主小世界据此裁决）
          if (meIsAAGun) {
            netSendState({ t: 'upd', p: myAAGun.group.position.toArray(), ty: meAAGun.turretYaw, tp: meAAGun.turretPitch, by: meAAGun.bodyYaw, sp: Math.round(meAAGun.speed) });
          } else {
            const q = myPlane.group.quaternion;
            netSendState({ t: 'upd', p: myPlane.group.position.toArray(), q: [q.x, q.y, q.z, q.w], sp: Math.round(me.speed) });
          }
        }
      }
      pingT += dt;
      // 延迟测量（ping-pong）：两端 performance.now() 时钟基准不同，不能拿发送方的 ts 直接相减。
      // 非房主发 ping(本地ts) → 房主原样回 pong → 非房主用本地时钟算 RTT
      if (pingT >= 2) { pingT = 0; if (!iAmHost && hostPeerId) netSendEventTo(hostPeerId, { t: 'ping', ts: performance.now() }); }
    }

    /* ---- HUD ---- */
    // 自机血条：按血量百分比连续变色（100%→绿 hsl130，50%→黄绿，0%→红 hsl0），渐变过渡无跳变
    const hpHue = (pct) => Math.round(THREE.MathUtils.clamp(pct, 0, 100) * 1.3);
    const hpBarColor = (pct) => 'linear-gradient(90deg,hsl(' + Math.max(0, hpHue(pct) - 22) + ',78%,44%),hsl(' + hpHue(pct) + ',84%,54%))';
    if (meIsAAGun) {
      hpLabel.textContent = '车体装甲';
      const hpPct = Math.max(0, meAAGun.hp / AAGUN_HP * 100);   // 按最大血量归一化（120）
      hpFill.style.width = hpPct + '%';
      hpFill.style.background = hpBarColor(hpPct);
      speedVal.textContent = Math.round(meAAGun.speed * 3.6);
      altVal.textContent = '—';
    } else {
      hpLabel.textContent = '机体结构';
      const hpPct = Math.max(0, me.hp);
      hpFill.style.width = hpPct + '%';
      hpFill.style.background = hpBarColor(hpPct);
      speedVal.textContent = Math.round(me.speed * 3.6);
      altVal.textContent = Math.round(myPlane.group.position.y);
    }
    pingValTextEl.textContent = (mode !== 'practice' && pingMs >= 0) ? ('延迟 ' + pingMs + ' ms') : '';
    audio.setEngine(meIsAAGun ? 0 : THREE.MathUtils.clamp((me.speed - SPEED_MIN) / (SPEED_MAX - SPEED_MIN), 0, 1), !meIsAAGun && me.alive && !STATE.roundOver);

    // 大准星：飞机玩家 = 飞机朝向偏移；防空车玩家 = 炮塔对准指示（不偏移）
    if (meIsAAGun) {
      planeReticle.style.transform = 'translate(-50%,-50%)';
      planeReticle.style.opacity = '0.5';
    } else {
      const retScale = Math.min(window.innerWidth, window.innerHeight) * 0.22;
      planeReticle.style.transform = 'translate(-50%,-50%) translate(' + (aimYaw * retScale) + 'px,' + (aimPitch * retScale) + 'px)';
      planeReticle.style.opacity = (Math.abs(aimYaw) + Math.abs(aimPitch)) > 0.01 ? '0.8' : '0.3';
    }

    if (bannerTimer > 0) { bannerTimer -= dt; if (bannerTimer <= 0) bannerEl.style.opacity = 0; }
    if (partHitTimer > 0) { partHitTimer -= dt; if (partHitTimer <= 0) partHitEl.style.opacity = 0; }
    if (hitmarkTimer > 0) { hitmarkTimer -= dt; if (hitmarkTimer <= 0) hitmarkEl.style.opacity = 0; }
    dmgFlashEl.style.opacity = Math.max(0, parseFloat(dmgFlashEl.style.opacity || 0) - dt * 2.2);

    updateMarkers();
    updateRoster();
    killValEl.textContent = killCount;
  } else {
    updateMenuScene(dt);   // 菜单展示：飞机螺旋桨 / 防空车炮塔扫描 / 天上飞机盘旋
  }

  updateCamera(dt);
  renderer.render(scene, camera);
}
tick();