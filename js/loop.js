// js/loop.js — 输入（键鼠/触屏）+ 主循环 tick + 调试钩子（v3.4.1 从 main.js 抽出）
// main.js 现在是纯入口：只负责 resetState() 与菜单展示场景的启动，本模块承载每帧逻辑与全部输入绑定。
import * as THREE from 'three';
import { AudioEngine } from './audio.js?v=1516';
import { modeField } from './mode.js?v=1516';   // 「游戏内」模式模块（武器/参数由模式描述符决定）
import { createWorld, WORLD } from './world/index.js?v=1516';
import { buildPlane, makeFighter, applyFlight, forwardOf } from './plane.js?v=1516';
import { buildAAGun, makeAAGun, forwardOfTurret, forwardOfBody, applyAAGun, updateWeakAAGun } from './aagun.js?v=1516';
import { Effects } from './effects.js?v=1516';
import { Net, makePeerId, cleanName } from './net.js?v=1516';
import { signalProbe, signalCreate, signalHostPoll, signalHostOffer, signalJoin, signalJoinPoll, signalJoinAnswer, signalBeaconRefresh, signalShutdown, makeRoomCode } from './signal.js?v=1516';
import { myPeerId, sbRows, setSbRows, STATE, planes, aaguns, nets, killLedger, pingProbe, crashPairs, hitSettled, markerPool, lastEventSeq, lastUpdSeq, lastSyncSeq, pickSelections, myTeam, mySlot, mode, practiceSize, netSize, hostPeerId, roster, iAmHost, myName, hostNameHint, pickDealPending, myPlane, me, myAAGun, meAAGun, meIsAAGun, bot, gamemode, world, fireT, killCount, aagunWeapon, rocketAmmo, planeWeapon, heAmmo, lastDmgFrom, pickPhase, pickRound, pickTimer, pickDrag, pickBtnsBound, myPickSide, pickStartTs, mapLobbyTimerId, lobbyPickedMap, myFireSeq, crashCd, aimYaw, aimPitch, zoom, setAimYaw, setAimPitch, setZoom, setMyTeam, setMySlot, setMode, setPracticeSize, setNetSize, setHostPeerId, setRoster, setIAmHost, setMyName, setHostNameHint, setPickDealPending, setMyPlane, setMe, setMyAAGun, setMeAAGun, setMeIsAAGun, setBot, setGamemode, setWorld, setFireT, setKillCount, setAagunWeapon, setRocketAmmo, setPlaneWeapon, setHeAmmo, setLastDmgFrom, setPickPhase, setPickRound, setPickTimer, setPickDrag, setPickBtnsBound, setMyPickSide, setPickStartTs, setMapLobbyTimerId, setLobbyPickedMap, setMyFireSeq, setCrashCd } from './state.js?v=1516';
import { canvas, renderer, scene, camera, effects, audio, GFX, isTouch, IS_ANDROID_APP } from './core.js?v=1516';
import {
  $, hud, menu, pauseEl, hpFill, foeHpFill, hpLabel, speedVal, altVal, bannerEl, subBannerEl, warnEl,
  hitmarkEl, partHitEl, dmgFlashEl, pipsMeEl, pipsFoeEl, scoreTextEl, roundLabelEl, matchPanel, matchTitle, matchSub,
  fpsValEl, pingValTextEl, planeReticle, rosterPanel, rosterMineUnits, rosterFoeUnits, killValEl,
  banner, subBanner, menuToast, showPart, showHitmark, showFriendlyFire, updateScore, addKillFeed, clearKillFeed, nameOfPlayer, tickHudTimers
} from './hud.js?v=1516';
import { buildScoreRows, renderScoreboard, scoreboardText, downloadScoreboard } from './scores.js?v=1516';
import {
  Z_AXIS, _agDir, _agPos, _botAim, _fireDir, _rkDir, applyMatchEnd, applyMeAAGunDamage, applyMeDamage, applyPeerDamage, bullets, bulletNetParams, checkAAGunHit, checkBulletHit, checkRoundEnd, collideTerrain, detonateRocket, fireGun, fireGunAAGun, firePlaneRocket, fireRocket, hitWorldAt, hostSettleHit, lastRocketBlast, ledgerOf, markCrashPair, matchOver, peerDie, presentHit, processNetReconcile, rayHitWorld, resetKillLedger, rockets, selectWeapon, selfDestruct, selfDestructAAGun, settleRound, spawnBullet, spawnRocketFx, splashDamageAt, switchAAGunWeapon, syncScoreFromWorld, teamAliveCount, tmpHitPos, updateWeaponHud
} from './combat.js?v=1516';
import { Bot, AAGunBot } from './ai.js?v=1516';
import { toggleMicSend, toggleVoiceRx, syncVoiceBtn, setVoiceBtnsVisible, onVoiceMsg, voiceDropPeer } from './voice.js?v=1516';
import { rebuildWorld, showMenuScene, updateMenuScene, clearMenuProps, menuSceneType, menuCamOrbitYaw, menuCamOrbitPitch, menuCamDist } from './scene3d.js?v=1516';
import { spec, specPick, specTargetObj, specUpdateActive, updateRoster } from './spectate.js?v=1516';
import { spawnPos, aagunSpawnPos, clearUnits, makeAAGunUnit, buildAllUnits } from './units.js?v=1516';
import { updateMarkers } from './markers.js?v=1516';
import { updateCamera } from './camera.js?v=1516';
import { hideAllPanels, showMenuBox, renderMapCards, renderSideCards, startMapLobby, blockedByAAGun, setMenuGm, refreshPracticePanel } from './lobby.js?v=1516';
import { sideLabelOf, returnToLobby, setupPickUI, upsertRoster, resetPickCounts } from './pick.js?v=1516';
import { netBroadcast, netSendState, netSendEventTo, wireNet, broadcastRoster, onPeerClose, onPeerState, onPeerEvent } from './netev.js?v=1516';
import { beginMatch } from './sdp.js?v=1516';
import { resetState, applyRematch, hasOpponent, lockPointer } from './match.js?v=1516';
import { pushWorldSync } from './netev.js?v=1516';
import { GAME_VERSION, MODE_SIZE, SPAWN_Z, AAGUN_HP, ROCKET_SPEED, ROCKET_BOOST_RANGE, ROCKET_DRAG, ROCKET_GRAVITY, ROCKET_LIFE, ROCKET_PROX_R, ROCKET_BLAST_R, ROCKET_DMG, ROCKETS_PER_AAGUN, MAX_MARKERS, BASE_DMG, SPEED_MIN, SPEED_MAX, SENS, TOUCH_SENS, WIN_ROUNDS, MAX_AIM, TURN_RATE, PITCH_RATE, MENU_PITCH_MIN, MENU_PITCH_MAX, MENU_DIST_MIN, MENU_DIST_MAX, SPLASH_R, SPLASH_DMG, HE_AMMO, HE_DMG_MULT, HE_SPLASH_MULT, HIT_TOLERANCE, PING_KICK_MS, PING_SAMPLES, AAGUN_DMG, FUSE_R, KILL_FEED_MAX, KILL_FEED_TTL, VOICE_RATE, VOICE_CHUNK, AAGUN_BODY_R } from './config.js?v=1516';

/* 版本标签 / 设备检测 / 渲染器 / 场景 / 相机 / 特效 / 音频 已移至 js/core.js（v3.4） */


/* ================= 玩家与飞机 ================= */


// 防空车血量（2026-10-06 用户上调 120 → 150：防空车面对飞机弱势，加血提升生存）
// ==== 防空车火箭炮（v3.1 新武器，1/2 键切换）====
// 每辆防空车固定 1 发；近炸引信：距最近敌机 ≤10m 起爆；主目标一击致命；爆炸波及主目标队友（按距离衰减）

/* IFF 标记池 + 敌我标记投影（updateMarkers）已移至 js/markers.js（v3.4.1） */
/* ================= 游戏状态 ================= */
// resetState() 由入口 main.js 调用（本模块不求值期初始化对局状态）
let firing = false;   // 开火（aimYaw/aimPitch/zoom 已迁 state.js —— 相机模块也要读）
// 供 combat.js 写（跨模块调用点：settleRound 中断开火）；ES module 循环依赖下函数级调用安全
export function setFiring(v) { firing = v; }


/* ================= 设置阵营状态（房主手动分配；3v3/5v5 与 aavs，空战 1v1 跳过） ================= */
                                // 键 "射手id:fid" 在两端都唯一（各自计数、跨玩家用复合键区分）
let accX = 0, accY = 0;
let locked = false;
let pingMs = -1;            // HUD 延迟显示（netev.js 的 pong 处理经 setPingMs 写入）
export function setPingMs(v) { pingMs = v; }
let stateT = 0, pingT = 0, fpsT = 0, fpsCnt = 0, beepT = 0, warnOn = false;
let dmgAcc = 0;
                                 // 与加入方对齐：双方都在「完成阵营分配 → 开战瞬间」才 rebuildWorld
                                 // （此前房主点图就换，选阵营 45s 期间背景已是所选地图，且
                                 //  菜单展示实体留在旧坐标会穿帮，如空战选海岛后"水上飘飞机"）
export const deathPos = new THREE.Vector3();   // combat.js 自毁爆炸点复用（跨模块只读共享）
const tmpA = new THREE.Vector3();

let joySteerX = 0;             // 手机摇杆X轴（-1左 ~ 1右）→ 飞机压杆转弯 / 防空车车体转向
let joyPitch = 0;              // 手机摇杆Y轴（-1上推 ~ 1下压）→ 飞机俯仰（皇牌空战式操控，v3.5.2）
let throttleHold = 0;          // 安卓加速/减速按钮按住状态（+1 加速 / -1 减速 / 0 松手）
// 上下推杆方向（安卓设置面板可切换）：默认「航空标准」= 上推俯冲（皇牌空战同款）；
// sd_settings.pitchInv === 1 时改为「街机」= 上推爬升。与 TOUCH_SENS 同样在模块加载期读一次。
const PITCH_UP_IS_CLIMB = (() => { try { return IS_ANDROID_APP && JSON.parse(localStorage.getItem('sd_settings') || '{}').pitchInv === 1; } catch (e) { return false; } })();

/* DOM 引用 / 提示层 / 比分圆点已移至 js/hud.js（v3.4） */


/* 地图重建 / 菜单 3D 展示场景 / 轨道相机 已移至 js/scene3d.js（v3.4）
   → rebuildWorld / showMenuScene / updateMenuScene / clearMenuProps / menuSceneType / menuCamOrbitYaw / menuCamOrbitPitch / menuCamDist */

/* 战斗核心（子弹/火箭/命中/伤害/回合/台账）已移至 js/combat.js（v3.4） */
/* 单位创建/清理（spawnPos/aagunSpawnPos/clearUnits/makeAAGunUnit/buildAllUnits）已移至 js/units.js（v3.4.1） */
/* 回合/比赛生命周期（resetState/startPractice/nextRound/applyRematch/hasOpponent）已移至 js/match.js（v3.4.1） */
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
$('btnSbTxt').onclick = () => downloadScoreboard();

// 观战状态（spec）/ 目标选择 / 多人状态栏 已移至 js/spectate.js（v3.4）
//   → 该模块先于本文件求值，spec 天然在输入监听器绑定前完成初始化（TDZ 已消除）

/* ================= 键鼠/触屏输入 ================= */
window.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (!locked && STATE.started && !STATE.matchEnded && !IS_ANDROID_APP) { pauseEl.classList.remove('hidden'); firing = false; setZoom(false); }
  else pauseEl.classList.add('hidden');
});
pauseEl.addEventListener('click', () => { if (STATE.started && !STATE.matchEnded) lockPointer(); });
document.addEventListener('mousemove', (e) => { if (!locked) return; accX += e.movementX; accY += e.movementY; });
document.addEventListener('mousedown', (e) => { if (!locked) return; if (e.button === 0) firing = true; if (e.button === 2) setZoom(true); });
// 观战交互：左键切换目标 / 滚轮缩放距离
document.addEventListener('mousedown', (e) => { if (typeof spec !== 'undefined' && spec.active && e.button === 0) specPick(true); });
document.addEventListener('wheel', (e) => {
  if (typeof spec === 'undefined' || !spec.active) return;
  spec.dist = THREE.MathUtils.clamp(spec.dist * Math.exp(e.deltaY * 0.0012), 12, 130);
}, { passive: true });
document.addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; if (e.button === 2) setZoom(false); });
// 子弹本帧线段（prev→pos）是否命中某点（半径 r）；防高速穿透（航空炸弹判定用）
export function bulletHitsPoint(b, p, r) {
  if (!b.prev) return b.pos.distanceTo(p) < r;
  const abx = b.pos.x - b.prev.x, aby = b.pos.y - b.prev.y, abz = b.pos.z - b.prev.z;
  const apx = p.x - b.prev.x, apy = p.y - b.prev.y, apz = p.z - b.prev.z;
  const l2 = abx * abx + aby * aby + abz * abz || 1e-6;
  let t = (apx * abx + apy * aby + apz * abz) / l2;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return (dx * dx + dy * dy + dz * dz) < r * r;
}

const keys = {};
document.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'KeyM') audio.toggleMute();
  if (e.code === 'KeyT' && !e.repeat) toggleMicSend();
  if (e.code === 'KeyY' && !e.repeat) toggleVoiceRx();
  // 武器切换（v3.1/v3.2）：1 = 主武器（高射机枪 / 机炮），2 = 副武器（火箭炮 / 高爆子弹）
  if (e.code === 'Digit1' && !e.repeat) selectWeapon(1);
  if (e.code === 'Digit2' && !e.repeat) selectWeapon(2);
});
document.addEventListener('keyup', (e) => { keys[e.code] = false; });

if (IS_ANDROID_APP) {
  // 触屏操控（虚拟摇杆/开火/瞄准/语音按钮）只在安卓 App 激活；
  // 网页版已收窄为桌面游玩（手机浏览器被 mobile-gate 引导下载安卓版）
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
        // 防空车：上下 = 前进/后退（上推 cy 为负 → 取负得正速度 = 前进），左右 = 车体转向（见 tick）
        meAAGun.targetSpeed = THREE.MathUtils.clamp((-cy / 46) * 12, -6, 12);   // 履带车约 12 单位/s ≈ 43 km/h
      }
      // 飞机：上下不再控油门（v3.5.2 皇牌空战式操控，摇杆上下让给俯仰），油门交给加速/减速按钮
    }
    // X轴：左右 = 转向（存值供 tick 持续应用）
    joySteerX = cx / 46;
    joyPitch = cy / 46;          // Y轴：飞机俯仰（上推为负 → tick 内取负得到"上推俯冲"的航空标准）
  };
  joyBase.addEventListener('touchstart', (e) => { e.preventDefault(); const t = e.changedTouches[0]; joyId = t.identifier; const r = joyBase.getBoundingClientRect(); setJoy(t.clientX - (r.left + r.width / 2), t.clientY - (r.top + r.height / 2)); }, { passive: false });
  joyBase.addEventListener('touchmove', (e) => { e.preventDefault(); const r = joyBase.getBoundingClientRect(); for (const t of e.changedTouches) if (t.identifier === joyId) setJoy(t.clientX - (r.left + r.width / 2), t.clientY - (r.top + r.height / 2)); }, { passive: false });
  joyBase.addEventListener('touchend', (e) => { for (const t of e.changedTouches) if (t.identifier === joyId) { joyId = null; setJoy(0, 0); } });

  const btnFire = $('btnFire'), btnZoom = $('btnZoom');
  btnFire.addEventListener('touchstart', (e) => { e.preventDefault(); audio.resume(); firing = true; }, { passive: false });
  btnFire.addEventListener('touchend', (e) => { e.preventDefault(); firing = false; }, { passive: false });
  btnZoom.addEventListener('touchstart', (e) => { e.preventDefault(); setZoom(true); }, { passive: false });
  btnZoom.addEventListener('touchend', (e) => { e.preventDefault(); setZoom(false); }, { passive: false });
  // 武器切换（v3.1）：安卓端没有键盘 1/2，用触屏按钮轮换（机枪 ⇄ 火箭炮）
  const btnWeapon = $('btnWeapon');
  if (btnWeapon) btnWeapon.addEventListener('touchstart', (e) => {
    e.preventDefault(); audio.resume();
    if (meIsAAGun) switchAAGunWeapon(aagunWeapon === 'rocket' ? 'mg' : 'rocket');
    else selectWeapon(planeWeapon === 'gun' ? 2 : 1);
  }, { passive: false });
  // 油门（v3.5.2 皇牌空战式操控）：摇杆上下让给俯仰后，改用按住式加速/减速按钮
  const btnFast = $('btnFast'), btnSlow = $('btnSlow');
  const thrDown = (v) => (e) => { e.preventDefault(); audio.resume(); throttleHold = v; };
  const thrUp = () => { throttleHold = 0; };
  if (btnFast) { btnFast.addEventListener('touchstart', thrDown(1), { passive: false }); btnFast.addEventListener('touchend', thrUp); btnFast.addEventListener('touchcancel', thrUp); }
  if (btnSlow) { btnSlow.addEventListener('touchstart', thrDown(-1), { passive: false }); btnSlow.addEventListener('touchend', thrUp); btnSlow.addEventListener('touchcancel', thrUp); }
  // 语音：手机端没有 T/Y 键，用右上角两个触屏按钮
  const btnMic = $('btnMic'), btnRx = $('btnRx');
  if (btnMic) btnMic.addEventListener('touchstart', (e) => { e.preventDefault(); audio.resume(); toggleMicSend().then(syncVoiceBtn); }, { passive: false });
  if (btnRx) btnRx.addEventListener('touchstart', (e) => { e.preventDefault(); toggleVoiceRx(); syncVoiceBtn(); }, { passive: false });
  // 注意：这里不能立刻调用 syncVoiceBtn()——语音状态（micOn/voiceRxOn）在 voice.js 里，
  // 移动端在模块初始化期间执行本块会撞上 TDZ；改为开局时同步（见 beginMatch）
}

/* 设置阵营系统（startPickPhase/returnToLobby/completePickAndDeal/setupPickUI/applyPickTeams/upsertRoster/sideLabelOf 等）已移至 js/pick.js（v3.4.1） */
/* 联机事件路由 + 网络发送层（onPeerState/onPeerEvent/onPeerOpen/onPeerClose/removePeerLocal/lostConnText/
   endMatchIfFoesGone/wasInGameCheck/wireNet/hostRelay/broadcastRoster/sendToAll/netBroadcast/netSendState/netSendEventTo）
   已移至 js/netev.js（v3.4.1） */
/* 语音通话已移至 js/voice.js（v3.4）
   → toggleMicSend / stopMicSend / toggleVoiceRx / syncVoiceBtn / setVoiceBtnsVisible / onVoiceMsg / voiceDropPeer
   → 本文件仅保留调用点：KeyT/KeyY、#btnMic/#btnRx 触屏按钮、onPeerEvent 的 voice 分发、removePeerLocal 的清理 */

// ===== 房主小世界架构：无 mesh 直连，所有玩家只与房主相连 =====

/* 选图大厅（hideAllPanels/showMenuBox/renderMapCards/renderSideCards/startMapLobby/blockedByAAGun）已移至 js/lobby.js（v3.4.1） */
/* 赛后战绩已移至 js/scores.js（v3.4） */

/* 主菜单按钮（setMenuGm/refreshPracticePanel/练习入口绑定）已移至 js/lobby.js（v3.4.1） */
/* 手动 SDP 交换 / 信令房间码 / 延迟门槛 / beginMatch 已移至 js/sdp.js（v3.4.1） */
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
    const ctlActive = locked || IS_ANDROID_APP;
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
        if (!IS_ANDROID_APP) meAAGun.targetSpeed = mv;
        meAAGun.speed += (meAAGun.targetSpeed - meAAGun.speed) * Math.min(1, dt * 2);
        if (keys.KeyA) meAAGun.bodyYaw += 1.05 * dt;
        if (keys.KeyD) meAAGun.bodyYaw -= 1.05 * dt;
        // 手机摇杆：X轴 = 车体转向
        if (IS_ANDROID_APP && Math.abs(joySteerX) > 0.05) meAAGun.bodyYaw += -joySteerX * 1.2 * dt;
        if (Math.abs(meAAGun.speed) > 0.1) {
          const prev = _agPos.copy(myAAGun.group.position);
          forwardOfBody(meAAGun, _agDir);
          myAAGun.group.position.addScaledVector(_agDir, meAAGun.speed * dt);
          // 建筑/围栏碰撞回退 + 护栏径向阻挡（围栏是圆形，径向检测最贴合，防开出岛）
          // + 防空车之间的碰撞体积（用户 2026-09-29 定：不扣血、只挡路）
          const outR = Math.hypot(myAAGun.group.position.x, myAAGun.group.position.z);
          if (outR > 393 || collideTerrain({ group: myAAGun.group }) || blockedByAAGun()) myAAGun.group.position.copy(prev);
        }
        applyAAGun(meAAGun);
        warnOn = false;
        setFireT(fireT - dt);
        if (firing && fireT <= 0) {
          if (aagunWeapon === 'rocket') {
            // === 火箭炮（v3.1）：单发 · 近炸引信 · 一击致命 ===
            if (rocketAmmo > 0) {
              const shot = fireRocket(meAAGun, 'me', myPeerId);
              if (shot) {
                setRocketAmmo(rocketAmmo - 1); setFireT(1.1);
                audio.shoot();
                if (mode !== 'practice') {
                  setMyFireSeq(myFireSeq + 1); const fid = myFireSeq;
                  if (shot.rocket) { shot.rocket.fid = fid; shot.rocket.fFrom = myPeerId; }
                  if (iAmHost) netBroadcast({ t: 'rkt', o: shot.origin.toArray(), d: shot.dir.toArray(), from: myPeerId, fid });
                  else netBroadcast({ t: 'fireRocket', o: shot.origin.toArray(), d: shot.dir.toArray(), fid });
                }
                if (rocketAmmo <= 0) { setAagunWeapon('mg'); showPart('火箭弹已用尽 · 自动切回机枪'); }
                updateWeaponHud();
              }
            } else { setFireT(0.5); switchAAGunWeapon('mg'); showPart('火箭弹已用尽'); }
          } else {
            // 高射机枪
            setFireT(0.08);
            const shot = fireGunAAGun(meAAGun, 'me');
            audio.shoot();
            if (mode !== 'practice') {
              setMyFireSeq(myFireSeq + 1); const fid = myFireSeq;
              if (shot.bullet) { shot.bullet.fid = fid; shot.bullet.fFrom = myPeerId; }   // v3.0：归属标记（命中广播据此定位/销毁弹道）
              if (iAmHost) netBroadcast({ t: 'blt', o: shot.origin.toArray(), d: shot.dir.toArray(), from: myPeerId, ...bulletNetParams(shot) });
              else netBroadcast({ t: 'fire', o: shot.origin.toArray(), d: shot.dir.toArray(), fid, ...bulletNetParams(shot) });
            }
          }
        }
      } else firing = false;
      warnEl.style.opacity = 0;
    } else if (me.alive && !STATE.roundOver) {
      const _aimFn = modeField('aim', null);
      if (_aimFn) {
        // 模式自管瞄准（直升机：鼠标转机枪炮塔，受转动限制）
        _aimFn(me, { dt, keys, rawAccX, rawAccY, ctlActive, isAndroid: IS_ANDROID_APP, joyX: joySteerX, joyY: joyPitch, setAim: (y, p) => { setAimYaw(y); setAimPitch(p); } });
      } else if (IS_ANDROID_APP) {
        // === 皇牌空战式触屏操控（v3.5.2）===
        // 与 PC 的"视角领先 + 飞机追赶"不同：触屏直接把摇杆当操纵杆，并把视角锁定机头（aim 恒 0）。
        // 关键收益：小准星=机头=弹道方向（子弹沿 forwardOf 射出）→ 把目标套进准星开火即命中，
        // 不再出现"看着瞄、但机头没跟上而打空"（用户反馈"摇杆反人类、打不中"的根因）。
        setAimYaw(0); setAimPitch(0);
        // 左右压杆 → 压坡度转弯：杆量线性映射转弯角速度（满舵 = TURN_RATE rad/s）
        const turnStep = -joySteerX * TURN_RATE * dt;
        me.yaw += turnStep; me.yawVel = turnStep / Math.max(dt, 1e-4);   // yawVel 驱动 applyFlight 的滚转视觉
        // 上下推杆 → 俯仰：默认航空标准（上推=机头下压/俯冲，下拉=拉起/爬升，皇牌空战同款）；
        // 设置面板可切换为街机式（上推=爬升）。满舵 = PITCH_RATE rad/s
        const pitchStep = (PITCH_UP_IS_CLIMB ? -joyPitch : joyPitch) * PITCH_RATE * dt;
        me.pitch = THREE.MathUtils.clamp(me.pitch + pitchStep, -1.15, 1.15);
      } else {
        // === 视角领先+飞机追赶操控（类似 Ace Combat / War Thunder） ===
        // 鼠标/触屏滑动 → 累积到 aimYaw/aimPitch（视角偏移，1:1无延迟）
        // 飞机以 TURN_RATE 追赶视角方向 → 慢移时几乎同步，快甩时视角先转飞机再追
        setAimYaw(THREE.MathUtils.clamp(aimYaw + (ctlActive ? -rawAccX * SENS : 0), -MAX_AIM, MAX_AIM));
        setAimPitch(THREE.MathUtils.clamp(aimPitch + (ctlActive ? -rawAccY * SENS : 0), -MAX_AIM, MAX_AIM));
        // 飞机追赶视角（aim 偏移驱动飞机转向，转向后 aim 减小 = 飞机追上了视角）
        const dyaw = aimYaw;
        const stepYaw = THREE.MathUtils.clamp(dyaw, -TURN_RATE * dt, TURN_RATE * dt);
        me.yaw += stepYaw; me.yawVel = stepYaw / Math.max(dt, 1e-4);
        setAimYaw(aimYaw - stepYaw);
        const dpitch = aimPitch;
        const stepPitch = THREE.MathUtils.clamp(dpitch, -PITCH_RATE * dt, PITCH_RATE * dt);
        me.pitch = THREE.MathUtils.clamp(me.pitch + stepPitch, -1.15, 1.15);
        setAimPitch(aimPitch - stepPitch);
      }

      const _fl = modeField('flight', null);
      if (!_fl) {
        // 油门：键盘 W/S，安卓另给「加速/减速」按住按钮（皇牌空战式操控下摇杆上下已让给俯仰）
        if (keys.KeyW || throttleHold > 0) me.targetSpeed = Math.min(SPEED_MAX, me.targetSpeed + 70 * dt);
        if (keys.KeyS || throttleHold < 0) me.targetSpeed = Math.max(SPEED_MIN, me.targetSpeed - 70 * dt);
      }
      // 飞行物理：模式可提供自己的 flight(f, dt, ctx)（直升机：坦克式操控），否则用默认飞机物理
      if (_fl) _fl(me, dt, { keys, dt, isBot: false, isAndroid: IS_ANDROID_APP, joyX: joySteerX, joyY: joyPitch, throttle: throttleHold }); else applyFlight(me, dt);

      const _updFn = modeField('update', null);
      if (_updFn) _updFn(dt, { weapon: planeWeapon, roundOver: STATE.roundOver, zoom, firing });   // 模式每帧（直升机：炸弹落点投影 / 枪镜 HUD）
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

      setFireT(fireT - dt);
      if (firing && fireT <= 0) {
        const _modeFire = modeField('fire', null);
        if (_modeFire) {
          _modeFire(planeWeapon === 'bomb' ? 'secondary' : 'primary', {
            dt, mode, iAmHost, myPeerId, myFireSeq, setMyFireSeq, netBroadcast, audio, setFireT,
            roundOver: STATE.roundOver, bullets, bulletNetParams,
          });
        } else if (planeWeapon === 'rocket') {
          // ---- 空战 2 号武器：机载火箭炮（每回合 1 发，机制/参数与防空车火箭完全相同）----
          if (rocketAmmo > 0) {
            const shot = firePlaneRocket(me, 'me', myPeerId);
            if (shot) {
              setRocketAmmo(rocketAmmo - 1); setFireT(1.1);
              audio.shoot();
              if (mode !== 'practice') {
                setMyFireSeq(myFireSeq + 1); const fid = myFireSeq;
                if (shot.rocket) { shot.rocket.fid = fid; shot.rocket.fFrom = myPeerId; }
                if (iAmHost) netBroadcast({ t: 'rkt', o: shot.origin.toArray(), d: shot.dir.toArray(), from: myPeerId, fid });
                else netBroadcast({ t: 'fireRocket', o: shot.origin.toArray(), d: shot.dir.toArray(), fid });
              }
              if (rocketAmmo <= 0) { setPlaneWeapon('gun'); showPart('火箭弹已用尽 · 自动切回机炮'); }
              updateWeaponHud();
            }
          } else { setFireT(0.5); setPlaneWeapon('gun'); showPart('火箭弹已用尽'); updateWeaponHud(); }
        } else {
          // ---- 1 号武器：机炮 / 高爆子弹（配高爆子弹的模式：伤害翻倍 + 溅射 ×1.2）----
          const he = planeWeapon === 'he' && modeField('planeLoadout', 'rocket') === 'he';
          setFireT(he ? 0.12 : 0.09);
          const shot = fireGun(me, 'me', he ? { he: true } : null);
          audio.shoot();
          if (he) {
            setHeAmmo(heAmmo - 1);
            if (heAmmo <= 0) { setPlaneWeapon('gun'); showPart('高爆子弹已用尽 · 自动切回机炮'); }
            updateWeaponHud();
          }
          if (mode !== 'practice') {
            setMyFireSeq(myFireSeq + 1); const fid = myFireSeq;
            if (shot.bullet) { shot.bullet.fid = fid; shot.bullet.fFrom = myPeerId; }   // v3.0：归属标记（命中广播据此定位/销毁弹道）
            if (iAmHost) netBroadcast({ t: 'blt', o: shot.origin.toArray(), d: shot.dir.toArray(), from: myPeerId, ...bulletNetParams(shot) });
            else netBroadcast({ t: 'fire', o: shot.origin.toArray(), d: shot.dir.toArray(), fid, ...bulletNetParams(shot) });
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
              // v3.3：AI 飞机也会用 2 号武器（空战=机载火箭炮；防空车模式=高爆子弹）
              let shot = null;
              const tgtPos = target.plane ? target.plane.group.position : null;
              if (tgtPos) {
                // 目标速度估计（帧间差分 + 平滑），火箭打提前量用
                if (!pl.__tgtPrev) { pl.__tgtPrev = tgtPos.clone(); pl.__tgtVel = new THREE.Vector3(); }
                else {
                  _botAim.copy(tgtPos).sub(pl.__tgtPrev).divideScalar(Math.max(dt, 1e-3));
                  if (_botAim.lengthSq() < 40000) pl.__tgtVel.lerp(_botAim, 0.35);
                  pl.__tgtPrev.copy(tgtPos);
                }
                const dist = pl.plane.group.position.distanceTo(tgtPos);
                if (modeField('planeLoadout', 'rocket') === 'he') {
                  // 本模式 AI 走对地攻击：高爆子弹（30 发，用完回普通机炮）
                  if (pl.__heAmmo === undefined) pl.__heAmmo = HE_AMMO;
                  if (pl.__heAmmo > 0 && dist < 1000) { pl.__heAmmo--; shot = fireGun(b, id, { he: true }); }
                } else if (!pl.__rocketUsed && dist >= 200 && dist <= 800) {
                  // 空战：机载火箭（每回合 1 发，打提前量；按预计脱靶量判定，连续 3 帧稳定才发射）
                  forwardOf(pl.bot, _fireDir);
                  _botAim.copy(tgtPos).addScaledVector(pl.__tgtVel, (dist / ROCKET_SPEED) * 0.9);
                  if (dist > 450) _botAim.y += (dist - 450) * 0.07;  // 补偿助推段后的重力下坠
                  _botAim.sub(pl.plane.group.position).normalize();
                  // 机鼻大致对准即可；弹道用前置解方向
                  if (_fireDir.dot(_botAim) > 0.98) {
                    pl.__rocketUsed = true;
                    const rk = firePlaneRocket(pl.bot, 'bot', id, _botAim);
                    if (rk) {
                      const mp = meIsAAGun ? myAAGun.group.position : (myPlane ? myPlane.group.position : rk.origin);
                      audio.enemyShoot(rk.origin.distanceTo(mp));
                    }
                    return;
                  }
                }
              }
              if (!shot) shot = fireGun(b, id);
              const myPos = meIsAAGun ? myAAGun.group.position : (myPlane ? myPlane.group.position : shot.origin);
              audio.enemyShoot(shot.origin.distanceTo(myPos));
            });
          } else {
            // 目标全灭：巡航回中心
            const dummy = { plane: { group: { position: new THREE.Vector3(0, 300, 0) } }, speed: 0, alive: true };
            pl.bot.update(dt, dummy, () => {});
          }
          const _flb = modeField('flight', null);
          if (_flb) {
            // ★ 把 ai.js 算出的目标角交给模式飞行（直升机用 targetYaw/targetPitch 转向），
            //   否则 AI 直升机永远朝 0° 飞、既打不中也不会用火箭
            pl.bot.targetYaw = pl.bot.yaw;
            pl.bot.targetPitch = pl.bot.pitch;
            _flb(pl.bot, dt, { keys: {}, dt, isBot: true });
          } else applyFlight(pl.bot, dt);
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
              // v3.2：防空车 AI 也会用火箭炮（每车每回合 1 发）——目标 60~800m 且炮塔对准度足够时发射。
              // 火箭无制导（直线+重力），必须打提前量：用帧间位置差估算目标速度并平滑，按火箭飞行时间外推。
              if (!ag.__rocketUsed && target && target.plane) {
                const tgtPos = target.plane.group.position;
                if (!ag.__tgtPrev) { ag.__tgtPrev = tgtPos.clone(); ag.__tgtVel = new THREE.Vector3(); }
                else {
                  _botAim.copy(tgtPos).sub(ag.__tgtPrev).divideScalar(Math.max(dt, 1e-3));
                  if (_botAim.lengthSq() < 40000) ag.__tgtVel.lerp(_botAim, 0.35);   // 平滑（>200m/s 视为噪声跳变）
                  ag.__tgtPrev.copy(tgtPos);
                }
                forwardOfTurret(ag.ent, _agDir);
                _botAim.copy(tgtPos).sub(ag.aagun.group.position);
                const d2 = _botAim.length();
                const lead = d2 / ROCKET_SPEED;                       // 火箭预计飞行时间
                _botAim.copy(tgtPos).addScaledVector(ag.__tgtVel, lead * 0.9);
                if (d2 > 450) _botAim.y += (d2 - 450) * 0.07;         // 助推段(500m)结束后会下坠，粗略抬高炮口补偿
                _botAim.sub(ag.aagun.group.position).normalize();
                // 炮塔大致朝向即可（限速转向永远差 1.6°~5°，长距离必脱靶）；
                // 弹道走"前置解"方向（fireRocket 的 aimDir 参数），火箭沿解算方向直飞 → 才能真正命中
                if (d2 >= 60 && d2 <= 800 && _agDir.dot(_botAim) > 0.9) {
                  ag.__rocketUsed = true;
                  const rk = fireRocket(ag.ent, 'bot', ag.id, _botAim);
                  if (rk) {
                    const mp = meIsAAGun ? myAAGun.group.position : (myPlane ? myPlane.group.position : rk.origin);
                    audio.enemyShoot(rk.origin.distanceTo(mp));
                  }
                  return;   // 本帧改用火箭
                }
              }
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
    if (crashCd > 0) setCrashCd(crashCd - dt);
    if (!meIsAAGun && me.alive && !STATE.roundOver) {
      for (const id in planes) {
        const pl = planes[id];
        if (!pl.alive) continue;
        if (myPlane.group.position.distanceTo(pl.plane.group.position) < 7) {
          if (crashCd > 0) break;
          // 房主小世界去重：房主端结算过的碰撞，对方上报的同一条碰撞不再重复结算
          if (iAmHost && mode !== 'practice' && !markCrashPair(myPeerId, id)) break;
          // 相撞一律同归于尽（2026-09-29 用户决定：友军与敌军同规则，不再区分队伍）。
          // 理由：碰撞本就是两端各自本地判定的，队友互撞也照瞬死，规则最简单；
          // 且与"飞机撞防空车一律同归于尽"保持一致，同时消除了"本地不致命 / 权威端致死"的不一致。
          setCrashCd(0.8);
          if (iAmHost || mode === 'practice') {
            setLastDmgFrom(myPeerId);
            if (pl.isBot) { pl.hp = 0; peerDie('bot'); }   // 人机：bot 权威判死
            else peerDie(id);                               // 房主小世界：对方权威判死
            setLastDmgFrom(null);
            setLastDmgFrom(id);
            selfDestruct();   // 自己同判 → 内部 checkRoundEnd：双方归零 → 立即平局
            setLastDmgFrom(null);
          } else {
            // 非房主：本地立即同判（与撞海/撞楼同一套语义，2026-09-29 用户定）。
            // 只上报的话，要等房主 20Hz 快照回来才知道自己死了——满速对撞实测要晚 0.3-0.8s，
            // 表现为"穿过对方之后再爆炸"。本地先判死后房主侧判死是幂等的（alive 检查 + 去重）。
            netBroadcast({ t: 'crash', target: id, fatal: true });   // 让房主把对方也判死（信任结算 + 1.5s 去重）
            setLastDmgFrom(id);      // 撞我的是他 → 击杀归因
            selfDestruct();        // 内部会自动给房主补发 died，与撞楼路径完全一致
            setLastDmgFrom(null);
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
            setLastDmgFrom(myPeerId);
            if (ag.isBot) { ag.hp = 0; peerDie('bot'); }   // 人机：bot 防空车权威判死
            else peerDie(id);                               // 房主小世界：对方权威判死
            setLastDmgFrom(null);
            setLastDmgFrom(id);
            selfDestruct();   // 自己同判 → 双方归零 → 立即平局
            setLastDmgFrom(null);
          } else {
            // 非房主：本地立即同判（同上，与撞海/撞楼同语义）
            netBroadcast({ t: 'crash', target: id, fatal: true });   // 上报房主：权威同归于尽
            setLastDmgFrom(id);
            selfDestruct();
            setLastDmgFrom(null);
          }
          break;
        }
      }
    }
    if (meIsAAGun && meAAGun.alive && !STATE.roundOver) {
      // 玩家防空车被飞机撞：同归于尽（平局）——死亡由权威裁决，非房主本地先判死再上报
      for (const id in planes) {
        const pl = planes[id];
        if (!pl.alive) continue;
        if (myAAGun.group.position.distanceTo(pl.plane.group.position) < CRASH_R) {
          if (iAmHost && mode !== 'practice' && !markCrashPair(myPeerId, id)) break;
          // 同归于尽：人机/房主端双方都判死（bot 飞机也死）；非房主上报房主权威
          if (iAmHost || mode === 'practice') {
            setLastDmgFrom(myPeerId);
            if (pl.isBot) { pl.hp = 0; peerDie('bot'); }   // 人机：bot 飞机权威判死
            else peerDie(id);                               // 房主小世界：对方权威判死
            setLastDmgFrom(null);
            setLastDmgFrom(id);
            selfDestructAAGun();  // 自己同判 → 双方归零 → 立即平局
            setLastDmgFrom(null);
          } else {
            // 非房主：本地立即同判（同上，与撞海/撞楼同语义）
            netBroadcast({ t: 'crash', target: id, fatal: true });   // 上报房主：权威同归于尽
            setLastDmgFrom(id);
            selfDestructAAGun();
            setLastDmgFrom(null);
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

    /* ---- 子弹（v3.0：命中判定权在开火者本地；其他端一律只是特效） ----
       ・b.src === 'me'：我开的火 → 由我做命中判定（打飞机/打防空车/溅射），
         房主本地即权威（直接结算 + 广播 hit）；非房主只上报 hitRep（不扣血，等房主广播）。
       ・b.src === 'foeVis'：别人（含房主）的子弹 → 纯特效，飞完自然消失；
         伤害/受击/死亡全部由房主 'hit' 广播驱动（presentHit），本端不做任何判定。
       ・b.src === 'bot'：练习模式 AI 子弹 → 本地判定（练习无网络，见下）。 */
    for (const b of bullets) {
      if (!b.active) continue;
      b.prev.copy(b.pos); b.pos.addScaledVector(b.vel, dt); b.life -= dt; b.mesh.position.copy(b.pos);
      if (b.life <= 0) { b.active = false; b.mesh.visible = false; continue; }
      // 溅射子弹不因落地消失（由落地爆炸逻辑处理）；普通子弹落地即消失
      if (b.pos.y < 0 && !b.splashR) { b.active = false; b.mesh.visible = false; continue; }
      // 撞楼/撞山/撞海：火花即消失
      if (hitWorldAt(b.pos)) { effects.sparks(b.pos, 0xcfd6dd); b.active = false; b.mesh.visible = false; continue; }

      if (b.src === 'me' && !STATE.roundOver) {
        const isPractice = mode === 'practice';
        // ---- 打飞机 ----
        for (const id in planes) {
          const pl = planes[id];
          if (!pl.alive) continue;
          if (isPractice && pl.team === myTeam) continue;
          const wp = checkBulletHit(b, pl.plane);
          if (!wp) continue;
          b.active = false; b.mesh.visible = false;
          const isFriend = pl.team === myTeam;
          const dmg = Math.round(b.dmg * wp.mult);
          effects.sparks(b.pos, 0xffe08a); audio.hitConfirm();
          showHitmark(pl.hp - dmg <= 0);
          showPart((isFriend ? '误伤' : '命中') + wp.name + (wp.mult > 1 ? ' ×' + wp.mult : ''));
          if (isFriend) showFriendlyFire();   // v3.5.1：打中队友 → 中下方「误伤队友」警示
          if (isPractice) {
            // 练习模式：本地即权威（含 bot 判死与播报）
            setLastDmgFrom(myPeerId);
            pl.hp -= dmg; if (pl.hp <= 0) peerDie(pl.isBot ? 'bot' : id);
            setLastDmgFrom(null);
          } else if (iAmHost) {
            // 房主：本地即权威 → 结算 + 广播 hit（所有端据此放特效/更新血量）
            const p = pl.plane.group.position;
            hostSettleHit(myPeerId, id, wp.name, false, 0, [p.x, p.y, p.z], b.fid);
          } else {
            // 非房主：只上报"我打中了谁 / 部位 / 我看到的他当时的位置"（不做任何本地扣血）
            const p = pl.plane.group.position;
            if (b.fid) netSendEventTo(hostPeerId, { t: 'hitRep', fid: b.fid, id, part: wp.name, p: [p.x, p.y, p.z] });
          }
          break;
        }
        // ---- 打防空车 ----
        if (b.active) for (const id in aaguns) {
          const ag = aaguns[id];
          if (!ag.alive) continue;
          if (isPractice && ag.team === myTeam) continue;
          // 航空炸弹：下坠中被子弹打中立即引爆（直升机模式；排除投弹者自己的子弹）
          let _bombHit = false;
          for (const rb of rockets) {
            if (!rb.active || !rb.isBomb || rb.fFrom === b.fFrom) continue;
            if (bulletHitsPoint(b, rb.pos, 3.4)) { detonateRocket(rb, null, rb.pos); _bombHit = true; break; }
          }
          if (_bombHit) { b.active = false; b.mesh.visible = false; continue; }
          const wp = checkAAGunHit(b, ag);
          if (!wp) continue;
          b.active = false; b.mesh.visible = false;
          const isFriend = ag.team === myTeam;
          const dmg = Math.round(b.dmg * wp.mult);
          effects.sparks(b.pos, 0xffe08a); audio.hitConfirm(); effects.shake(0.2);
          showHitmark(ag.hp - dmg <= 0);
          showPart((isFriend ? '误伤' : '命中') + wp.name + (wp.mult > 1 ? ' ×' + wp.mult : ''));
          if (isFriend) showFriendlyFire();
          if (isPractice) {
            setLastDmgFrom(myPeerId);
            ag.hp -= dmg; if (ag.hp <= 0) peerDie(ag.isBot ? 'bot' : id);
            setLastDmgFrom(null);
          } else if (iAmHost) {
            const p = ag.aagun.group.position;
            hostSettleHit(myPeerId, id, wp.name, false, 0, [p.x, p.y, p.z], b.fid);
          } else {
            const p = ag.aagun.group.position;
            if (b.fid) netSendEventTo(hostPeerId, { t: 'hitRep', fid: b.fid, id, part: wp.name, p: [p.x, p.y, p.z] });
          }
          break;
        }
        // ---- 机炮溅射（防空车玩法）：近车爆炸 / 落地爆炸，同样由开火者判定后上报 ----
        if (b.active && b.splashR > 0) {
          for (const id in aaguns) {
            const ag = aaguns[id];
            if (!ag.alive) continue;
            if (isPractice && ag.team === myTeam) continue;
            const dmg = splashDamageAt(ag, b.pos, b.splashR, b.dmg);
            if (dmg <= 0) continue;
            b.active = false; b.mesh.visible = false;
            effects.explosion(b.pos, 0.5); audio.hitConfirm(); showPart('溅射 ' + dmg);
            if (ag.team === myTeam) showFriendlyFire();
            if (isPractice) { ag.hp -= dmg; if (ag.hp <= 0) peerDie('bot'); }
            else if (iAmHost) hostSettleHit(myPeerId, id, '溅射', true, dmg, [b.pos.x, b.pos.y, b.pos.z], b.fid);
            else if (b.fid) netSendEventTo(hostPeerId, { t: 'hitRep', fid: b.fid, id, part: '溅射', splash: 1, dmg, p: [b.pos.x, b.pos.y, b.pos.z] });
            break;
          }
          if (b.active && b.pos.y < 1.2) {
            // 打到地面/水面：爆炸溅射（对范围内每辆车各上报/结算一次；键含目标，互不压制）
            b.active = false; b.mesh.visible = false;
            const boom = tmpA.copy(b.pos); if (boom.y < 0.3) boom.y = 0.3;
            effects.sparks(boom, 0xffcf6b); effects.shake(0.12);
            for (const id in aaguns) {
              const ag = aaguns[id];
              if (!ag.alive) continue;
              if (isPractice && ag.team === myTeam) continue;
              const dmg = splashDamageAt(ag, b.pos, b.splashR, b.dmg);
              if (dmg <= 0) continue;
              if (ag.team === myTeam) showFriendlyFire();
              if (isPractice) { ag.hp -= dmg; if (ag.hp <= 0) peerDie('bot'); }
              else if (iAmHost) hostSettleHit(myPeerId, id, '溅射', true, dmg, [b.pos.x, b.pos.y, b.pos.z], b.fid);
              else if (b.fid) netSendEventTo(hostPeerId, { t: 'hitRep', fid: b.fid, id, part: '溅射', splash: 1, dmg, p: [b.pos.x, b.pos.y, b.pos.z] });
            }
          }
        }
      } else if (b.src === 'bot' && !STATE.roundOver) {
        // AI子弹：打玩家实体（飞机或防空车）——仅练习模式
        // 击杀归因 lastDmgFrom='bot'：三处伤害结算都必须先设置再清空，
        // 否则死亡播报走"无击杀者"分支 → 显示「你 坠毁」而不是「练习对手 击败 你」（v2.3.8 修复）
        if (meIsAAGun) {
          if (!meAAGun.alive) continue;
          const wp = checkAAGunHit(b, meAAGun);
          if (wp) { b.active = false; b.mesh.visible = false; effects.sparks(b.pos, 0xffb3a0); showPart('被击中' + wp.name + (wp.mult > 1 ? ' ×' + wp.mult : '')); setLastDmgFrom('bot'); applyMeAAGunDamage(Math.round(b.dmg * wp.mult)); setLastDmgFrom(null); }
          else if (b.splashR > 0 && b.active) {
            // AI 机炮溅射打玩家防空车（按溅射半径与距离衰减）
            const dmg = splashDamageAt(meAAGun, b.pos, b.splashR, b.dmg);
            if (dmg > 0) {
              b.active = false; b.mesh.visible = false;
              effects.explosion(b.pos, 0.5); showPart('溅射 ' + dmg);
              setLastDmgFrom('bot'); applyMeAAGunDamage(dmg); setLastDmgFrom(null);
            }
          }
        } else if (me.alive) {
          const wp = checkBulletHit(b, myPlane);
          if (wp) { b.active = false; b.mesh.visible = false; effects.sparks(b.pos, 0xffb3a0); showPart('被击中' + wp.name + (wp.mult > 1 ? ' ×' + wp.mult : '')); setLastDmgFrom('bot'); applyMeDamage(Math.round(b.dmg * wp.mult)); setLastDmgFrom(null); }
        }
      }
    }

    /* ---- 防空车火箭弹（v3.1）：飞行 + 近炸引信 ---- */
    for (const r of rockets) {
      if (!r.active) continue;
      r.prev.copy(r.pos);
      // 动力段（v3.4）：出膛后先沿发射方向"平飞" ROCKET_BOOST_RANGE 米 —— 无重力、不减速；
      // 之后进入无动力段：动能衰减 + 重力下坠（越飞越慢，最终落海）
      r.traveled += r.vel.length() * dt;
      if (r.traveled >= ROCKET_BOOST_RANGE) {
        r.vel.multiplyScalar(Math.max(0, 1 - (r.drag !== undefined ? r.drag : ROCKET_DRAG) * dt));
        r.vel.y -= (r.grav !== undefined ? r.grav : ROCKET_GRAVITY) * dt;
      }
      r.pos.addScaledVector(r.vel, dt);
      r.life -= dt;
      r.mesh.position.copy(r.pos);
      if (r.vel.lengthSq() > 1e-4) r.mesh.quaternion.setFromUnitVectors(Z_AXIS, _rkDir.copy(r.vel).normalize());
      // 撞楼/撞障碍（v3.5.1）：与城市楼群、基地建筑、山体等世界碰撞体接触即起爆。
      // 此前只判海平面 y<0.6，火箭会直接穿过楼宇；改用 prev→pos 线段检测，避免高速穿模。
      // 出膛首帧（frame 0）跳过：仅防枪口/机翼**贴着脸**的自家几何在原地自爆（不是距离豁免）。
      // v3.10.6：**无论飞了多远，碰到障碍物一律起爆**（用户要求；删掉 v3.10.2/v3.10.5 的距离豁免——
      // 旧豁免曾让空战都市图火箭全程穿楼）。
      if (r.frame++ > 0) {
        const hitW = rayHitWorld(r.prev, r.pos);
        if (hitW) {
          if (r.src === 'me' || r.src === 'bot') detonateRocket(r, null, hitW.pos);
          else { effects.explosion(hitW.pos, 1.6); audio.explosion(); r.active = false; r.mesh.visible = false; }
          continue;
        }
      }
      if (r.life <= 0 || r.pos.y < 0.6) {
        // 触地/耗尽：v3.3 打地板也会爆炸结算（发射者判定；观察者端只放爆炸特效保持视觉一致）
        if (r.src === 'me' || r.src === 'bot') detonateRocket(r, null, r.pos);
        else { effects.explosion(r.pos, 1.6); audio.explosion(); r.active = false; r.mesh.visible = false; }
        continue;
      }
      // 近炸引信（v3.3）：检测最近的**存活单位**（飞机 + 防空车，敌我不分，含队友与敌方的车）；
      // 排除发射者自身（发射点距自己仅数米，否则一出膛就自爆）。只有发射者判定，其他端纯特效。
      // v3.10.2：改用 prev→pos 线段最近距离判定 —— 低帧率时火箭一帧能飞 15m+，
      // 旧版只查当前点位会"穿"过近炸球（练习对手的火箭永远不引爆，用户实测报告）。
      if ((r.src === 'me' || r.src === 'bot') && !STATE.roundOver) {
        const segDist = (pPos) => {
          const ax = r.prev.x, ay = r.prev.y, az = r.prev.z;
          const bx = r.pos.x - ax, by = r.pos.y - ay, bz = r.pos.z - az;
          const px = pPos.x - ax, py = pPos.y - ay, pz = pPos.z - az;
          const len2 = bx * bx + by * by + bz * bz || 1e-6;
          let t = (px * bx + py * by + pz * bz) / len2;
          t = t < 0 ? 0 : (t > 1 ? 1 : t);
          const dx = px - bx * t, dy = py - by * t, dz = pz - bz * t;
          return Math.sqrt(dx * dx + dy * dy + dz * dz);
        };
        let tgt = null, best = ROCKET_PROX_R;
        for (const id in planes) {
          if (id === r.owner) continue;
          const pl = planes[id];
          if (!pl.alive) continue;
          const d = segDist(pl.plane.group.position);
          if (d <= best) { best = d; tgt = pl; }
        }
        for (const id in aaguns) {
          if (id === r.owner) continue;
          const ag = aaguns[id];
          if (!ag.alive) continue;
          const d = segDist(ag.aagun.group.position);
          if (d <= best) { best = d; tgt = ag; }
        }
        // ★ 本机玩家不在 planes/aaguns 字典里：AI 火箭必须单独把它算进近炸目标，
        //   否则练习对手的火箭从玩家身边飞过永远不引爆（v3.9.0 修复"AI 火箭没伤害"）
        if (r.src === 'bot') {
          const selfAlive = meIsAAGun ? !!(meAAGun && meAAGun.alive) : !!(me && me.alive);
          const selfPos = meIsAAGun ? (myAAGun ? myAAGun.group.position : null) : (myPlane ? myPlane.group.position : null);
          if (selfAlive && selfPos) {
            const d = segDist(selfPos);
            if (d <= best) { best = d; tgt = { id: myPeerId, alive: true, plane: { group: { position: selfPos } } }; }
          }
        }
        if (tgt) detonateRocket(r, tgt, r.pos);
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
        processNetReconcile();   // 网络簿记：清理已结算命中表（v3.0 无预判回溯，仅防表无限增长）
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
      const hpPct = Math.max(0, meAAGun.hp / AAGUN_HP * 100);   // 按最大血量归一化（150）
      hpFill.style.width = hpPct + '%';
      hpFill.style.background = hpBarColor(hpPct);
      speedVal.textContent = Math.round(meAAGun.speed * 3.6);
      altVal.textContent = '—';
      updateWeaponHud();   // 武器/火箭弹余量（v3.1）
    } else {
      hpLabel.textContent = '机体结构';
      const hpPct = Math.max(0, me.hp);
      hpFill.style.width = hpPct + '%';
      hpFill.style.background = hpBarColor(hpPct);
      speedVal.textContent = Math.round(me.speed * 3.6);
      altVal.textContent = Math.round(myPlane.group.position.y);
      updateWeaponHud();   // 武器/弹药（v3.2 飞机：机炮 / 火箭炮 / 高爆子弹）
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

    tickHudTimers(dt);   // 横幅/命中提示淡出（js/hud.js）
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
/* ================= 调试钩子（仅 ?debug=1 时暴露；供端到端自动化测试，正常游玩无副作用） =================
   headless 环境下 pointer-lock 无法获得（开火需要 locked），因此提供最小状态读写接口，
   让测试脚本能驱动开火并读取各实体血量/存活，从而覆盖 v3.0「客户端判定 → 房主校验 → 广播」全链路。 */
if (/[?&]debug=1/.test(location.search)) {
  window.__sd = {
    fire: (v) => { firing = !!v; },
    zoom: (v) => { setZoom(!!v); },
    weapon: (w) => {   // 'mg'/'gun' → 1 号武器；'rocket'/'he' → 2 号武器
      if (meIsAAGun) switchAAGunWeapon(w === 'rocket' ? 'rocket' : 'mg');
      else selectWeapon((w === 'rocket' || w === 'he') ? 2 : 1);
    },
    rocketsActive: () => rockets.filter((r) => r.active).length,
    rocketPos: () => { const r = rockets.find((x) => x.active); return r ? r.pos.toArray().map((n) => Math.round(n)) : null; },
    rocketBlastPos: () => lastRocketBlast.toArray().map((n) => Math.round(n)),   // 最近一次火箭起爆点
    // 世界碰撞体清单（测试用）：楼房=AABB(s=1, x/z/hx/hz/h)，山体/障碍=球(s=0, x/y/z/r)
    worldColliders: () => (world && world.colliders) ? world.colliders.map((c) => c.s === 1
      ? { s: 1, x: Math.round(c.x), z: Math.round(c.z), hx: Math.round(c.hx), hz: Math.round(c.hz), h: Math.round(c.h) }
      : { s: 0, x: Math.round(c.v.x), y: Math.round(c.v.y), z: Math.round(c.v.z), r: Math.round(c.r) }) : [],
    state: () => {
      const meHp = meIsAAGun ? (meAAGun ? meAAGun.hp : -1) : (me ? me.hp : -1);
      const meAlive = meIsAAGun ? !!(meAAGun && meAAGun.alive) : !!(me && me.alive);
      const units = {};
      for (const id in planes) units[id] = { hp: planes[id].hp, alive: planes[id].alive, team: planes[id].team, pos: planes[id].plane.group.position.toArray().map((n) => Math.round(n)) };
      for (const id in aaguns) units[id] = { hp: aaguns[id].hp, alive: aaguns[id].alive, team: aaguns[id].team, pos: aaguns[id].aagun.group.position.toArray().map((n) => Math.round(n)) };
      return {
        iAmHost, mode, started: STATE.started, roundOver: STATE.roundOver, myTeam, myPeerId, hostPeerId,
        meIsAAGun, meHp, meAlive, aagunWeapon, rocketAmmo, planeWeapon, heAmmo, gamemode, killCount,
        myPos: meIsAAGun ? (myAAGun ? myAAGun.group.position.toArray().map((n) => Math.round(n)) : null)
                         : (myPlane ? myPlane.group.position.toArray().map((n) => Math.round(n)) : null),
        myYaw: me ? me.yaw : null,
        activeBullets: bullets.filter((b) => b.active).length,
        killFeed: [...document.querySelectorAll('#killFeed .kfItem')].map((e) => e.textContent),
        units,
      };
    },
    // 瞄准辅助（测试用）：飞机=对准机头；防空车=对准炮塔（火箭/机枪都按炮塔朝向发射）
    aimAt: (x, y, z) => {
      if (meIsAAGun) {
        if (!meAAGun || !myAAGun) return;
        const p = myAAGun.group.position;
        const dx = x - p.x, dz = z - p.z;
        meAAGun.turretYaw = Math.atan2(-dx, -dz);           // turretYaw 为世界角（同 forwardOfTurret 约定）
        meAAGun.turretPitch = THREE.MathUtils.clamp(Math.atan2(y - p.y, Math.hypot(dx, dz)), -0.15, 1.35);
        return;
      }
      if (!me || !myPlane) return;
      const p = myPlane.group.position;
      const dx = x - p.x, dz = z - p.z;
      me.yaw = Math.atan2(-dx, -dz);
      const flat = Math.hypot(dx, dz);
      me.pitch = Math.atan2(y - p.y, flat);
      me.roll = 0; me.yawVel = 0;
    },
  };
}

