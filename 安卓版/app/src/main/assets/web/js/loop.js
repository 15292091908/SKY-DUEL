// js/loop.js — 输入（键鼠/触屏）+ 主循环 tick + 调试钩子（v3.4.1 从 main.js 抽出）
// main.js 现在是纯入口：只负责 resetState() 与菜单展示场景的启动，本模块承载每帧逻辑与全部输入绑定。
import * as THREE from 'three';
import { AudioEngine } from './audio.js?v=1572';
import { modeField } from './mode.js?v=1572';   // 「游戏内」模式模块（武器/参数由模式描述符决定）
import { createWorld, WORLD } from './world/index.js?v=1572';
import { buildPlane, makeFighter, applyFlight, forwardOf } from './plane.js?v=1572';
import { buildAAGun, makeAAGun, forwardOfTurret, forwardOfBody, applyAAGun, updateWeakAAGun } from './aagun.js?v=1572';
import { Effects } from './effects.js?v=1572';
import { Net, makePeerId, cleanName } from './net.js?v=1572';
import { signalProbe, signalCreate, signalHostPoll, signalHostOffer, signalJoin, signalJoinPoll, signalJoinAnswer, signalBeaconRefresh, signalShutdown, makeRoomCode } from './signal.js?v=1572';
import { myPeerId, sbRows, setSbRows, STATE, planes, aaguns, nets, killLedger, pingProbe, crashPairs, hitSettled, markerPool, lastEventSeq, lastUpdSeq, lastSyncSeq, pickSelections, myTeam, mySlot, mode, practiceSize, netSize, hostPeerId, roster, iAmHost, myName, hostNameHint, pickDealPending, myPlane, me, myAAGun, meAAGun, meIsAAGun, bot, gamemode, world, fireT, killCount, aagunWeapon, rocketAmmo, planeWeapon, heAmmo, lastDmgFrom, pickPhase, pickRound, pickTimer, pickDrag, pickBtnsBound, myPickSide, pickStartTs, mapLobbyTimerId, lobbyPickedMap, myFireSeq, crashCd, aimYaw, aimPitch, zoom, setAimYaw, setAimPitch, setZoom, setMyTeam, setMySlot, setMode, setPracticeSize, setNetSize, setHostPeerId, setRoster, setIAmHost, setMyName, setHostNameHint, setPickDealPending, setMyPlane, setMe, setMyAAGun, setMeAAGun, setMeIsAAGun, setBot, setGamemode, setWorld, setFireT, setKillCount, setAagunWeapon, setRocketAmmo, setPlaneWeapon, setHeAmmo, setLastDmgFrom, setPickPhase, setPickRound, setPickTimer, setPickDrag, setPickBtnsBound, setMyPickSide, setPickStartTs, setMapLobbyTimerId, setLobbyPickedMap, setMyFireSeq, setCrashCd, magAmmo, magReload, setMagAmmo, setMagReload, magSwap } from './state.js?v=1572';
import { canvas, renderer, scene, camera, effects, audio, GFX, isTouch, IS_ANDROID_APP } from './core.js?v=1572';
import {
  $, hud, menu, pauseEl, hpFill, foeHpFill, hpLabel, speedVal, altVal, bannerEl, subBannerEl, warnEl,
  hitmarkEl, partHitEl, dmgFlashEl, pipsMeEl, pipsFoeEl, scoreTextEl, roundLabelEl, matchPanel, matchTitle, matchSub,
  fpsValEl, pingValTextEl, planeReticle, rosterPanel, rosterMineUnits, rosterFoeUnits, killValEl,
  banner, subBanner, menuToast, showPart, showHitmark, showFriendlyFire, updateScore, addKillFeed, clearKillFeed, nameOfPlayer, tickHudTimers
} from './hud.js?v=1572';
import { buildScoreRows, renderScoreboard, scoreboardText, downloadScoreboard } from './scores.js?v=1572';
import {
  Z_AXIS, ROCKET_NOSE_AXIS, _agDir, _agPos, _botAim, _fireDir, _rkDir, applyMatchEnd, applyMeAAGunDamage, applyMeDamage, applyPeerDamage, bullets, bulletNetParams, bulletDmgFactor, checkAAGunHit, checkBulletHit, checkRoundEnd, collideTerrain, detonateRocket, fireGun, fireGunAAGun, firePlaneRocket, fireRocket, hitWorldAt, hostSettleHit, lastRocketBlast, ledgerOf, markCrashPair, matchOver, peerDie, presentHit, processNetReconcile, rayHitWorld, resetKillLedger, rockets, selectWeapon, selfDestruct, selfDestructAAGun, settleRound, spawnBullet, spawnRocketFx, splashDamageAt, switchAAGunWeapon, syncScoreFromWorld, teamAliveCount, tmpHitPos, updateWeaponHud, partBlast
} from './combat.js?v=1572';
import { Bot, AAGunBot } from './ai.js?v=1572';
import { backToMenu } from './reset.js?v=1572';
import { toggleMicSend, toggleVoiceRx, syncVoiceBtn, setVoiceBtnsVisible, onVoiceMsg, voiceDropPeer } from './voice.js?v=1572';
import { rebuildWorld, showMenuScene, updateMenuScene, clearMenuProps, menuSceneType, menuCamOrbitYaw, menuCamOrbitPitch, menuCamDist } from './scene3d.js?v=1572';
import { spec, specPick, specTargetObj, specUpdateActive, updateRoster } from './spectate.js?v=1572';
import { spawnPos, aagunSpawnPos, clearUnits, makeAAGunUnit, buildAllUnits } from './units.js?v=1572';
import { updateMarkers } from './markers.js?v=1572';
import { updateLiveHud, toggleLiveStats } from './live.js?v=1572';   // 左上战术地图 + F 实时战绩（v3.22）
import { updateCamera } from './camera.js?v=1572';
import { updateKillcam } from './killcam.js?v=1572';
import { hideAllPanels, showMenuBox, renderMapCards, renderSideCards, startMapLobby, blockedByAAGun, setMenuGm, refreshPracticePanel } from './lobby.js?v=1572';
import { sideLabelOf, returnToLobby, setupPickUI, upsertRoster, resetPickCounts } from './pick.js?v=1572';
import { netBroadcast, netSendState, netSendEventTo, wireNet, broadcastRoster, onPeerClose, onPeerState, onPeerEvent } from './netev.js?v=1572';
import { beginMatch } from './sdp.js?v=1572';
import { resetState, applyRematch, hasOpponent, lockPointer } from './match.js?v=1572';
import { pushWorldSync } from './netev.js?v=1572';
import { GAME_VERSION, MODE_SIZE, SPAWN_Z, AAGUN_HP, ROCKET_AVG_SPEED, ROCKET_BOOST_ACCEL, ROCKET_FUEL_T, ROCKET_IGNITE_T, ROCKET_V_MAX, ROCKET_GRAVITY, ROCKET_LIFE, ROCKET_PROX_R, ROCKET_BLAST_R, ROCKET_DMG, ROCKETS_PER_AAGUN, ROCKET_HIT_R, BOMB_HIT_R, WHIZ_R, WHIZ_R_ROCKET, MAX_MARKERS, BASE_DMG, SPEED_MIN, SPEED_MAX, SENS, TOUCH_SENS, WIN_ROUNDS, MAX_AIM, TURN_RATE, PITCH_RATE, MENU_PITCH_MIN, MENU_PITCH_MAX, MENU_DIST_MIN, MENU_DIST_MAX, SPLASH_R, SPLASH_DMG, HE_AMMO, HE_DMG_MULT, HE_SPLASH_MULT, HIT_TOLERANCE, PING_KICK_MS, PING_SAMPLES, AAGUN_DMG, FUSE_R, KILL_FEED_MAX, KILL_FEED_TTL, VOICE_RATE, VOICE_CHUNK, AAGUN_BODY_R, BULLET_DRAG_Q, BULLET_GRAVITY, ROCKET_DRAG_Q } from './config.js?v=1572';

/* 版本标签 / 设备检测 / 渲染器 / 场景 / 相机 / 特效 / 音频 已移至 js/core.js（v3.4） */


/* ================= 玩家与飞机 ================= */


// 防空车血量（2026-10-06 用户上调 120 → 150：防空车面对飞机弱势，加血提升生存）
// ==== 防空车火箭炮（v3.1 新武器，1/2 键切换）====
// 每辆防空车固定 1 发；近炸引信：距最近敌机 ≤10m 起爆；主目标一击致命；爆炸波及主目标队友（按距离衰减）

/* IFF 标记池 + 敌我标记投影（updateMarkers）已移至 js/markers.js（v3.4.1） */
/* ================= 游戏状态 ================= */
// resetState() 由入口 main.js 调用（本模块不求值期初始化对局状态）
let firing = false;   // 开火（aimYaw/aimPitch/zoom 已迁 state.js —— 相机模块也要读）

/* ================= 弹夹（v3.23 / v3.24） =================
   主武器走弹夹：飞机 / 直升机 100 发、防空车 300 发、坦克 1 发（由装填驱动），
   直升机对决的 2 号武器「双管霰弹」单独一个 6 发弹夹。
   备弹恒为无限（HUD 显示 ∞）；火箭弹 / 航空炸弹 / 高爆子弹是特殊弹，仍用各自的有限数量。
   打空自动换弹（v3.24 统一 5s），换弹期间不能开火。 */

/* 弹夹按「武器」分仓：机枪打剩 40 发时切到霰弹再切回来，仍然是 40 发 —— 不会靠切换白嫖满弹。
   换回合 / 重生时 clearMagSwap() 清空（state.js），新一局必定满夹。 */
let magWeaponCur = 'gun';
function magKeyNow() {
  if (meIsAAGun) return 'mg';
  return planeWeapon === 'shot' ? 'shot' : 'gun';
}
function magCapForKey(k) {
  if (k === 'shot') return modeField('shotMag', 6);          // 直升机对决：双管霰弹 6 发
  return modeField('magSize', meIsAAGun ? 300 : 100);
}
function syncMagWeapon() {
  const k = magKeyNow();
  if (k === magWeaponCur) return;
  magSwap[magWeaponCur] = magAmmo;                            // 存下刚离开的那门武器
  magWeaponCur = k;
  const keep = magSwap[k];
  setMagAmmo(keep !== undefined ? Math.min(keep, magCapForKey(k)) : magCapForKey(k));
  setMagReload(0);                                            // 换武器打断换弹
}
function magCapNow() { return magCapForKey(magKeyNow()); }
function magReloadTime() { return modeField('magReload', 5); }

function startMagReload() { if (magReload > 0) return; setMagReload(magReloadTime()); }
function magGate(on) {
  if (!on) return true;
  if (magReload > 0) return false;
  if (magAmmo > 0) return true;
  startMagReload();
  return false;
}
function consumeMag() {
  const n = Math.max(0, magAmmo - 1);
  setMagAmmo(n);
  if (n <= 0) startMagReload();
}
/* 左下角「可用 / 备弹」：坦克按装填状态给 1/0，特殊弹给 2/0、80/0。 */
function ammoInfo() {
  const tankGun = modeField('magSize', 0) === 1;
  if (meIsAAGun) {
    if (tankGun) {
      const t = (aagunWeapon === 'rocket' ? (meAAGun ? meAAGun.heatT : 0) : (meAAGun ? meAAGun.apT : 0)) || 0;
      return { cur: t > 0.05 ? 0 : 1, res: '∞' };
    }
    if (aagunWeapon === 'rocket') return { cur: rocketAmmo, res: 0 };
    return { cur: magAmmo, res: '∞' };
  }
  if (planeWeapon === 'rocket') return { cur: rocketAmmo, res: 0 };
  if (planeWeapon === 'he') return { cur: heAmmo, res: 0 };
  if (planeWeapon === 'bomb') {
    const b = (me && me.bombs) ? ((me.bombs.left ? 1 : 0) + (me.bombs.right ? 1 : 0)) : 0;
    return { cur: b, res: 0 };
  }
  return { cur: magAmmo, res: '∞' };
}
// 供 combat.js 写（跨模块调用点：settleRound 中断开火）；ES module 循环依赖下函数级调用安全
export function setFiring(v) { firing = v; }

/* AI 避障探针（v3.11.4）：沿机头方向的「航路走廊」找最近的高楼/山体，返回它的顶面高度。
   ★ 不能用单射线：楼只有 30~60m 宽，420m 外差 5° 就漏检（实测 AI 擦着楼过去）。改成锥形走廊扫。 */
function botProbe(from, to) {
  if (!world || !world.colliders) return null;
  const dx = to.x - from.x, dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  let best = null;
  for (const c of world.colliders) {
    if (c.s === 1 || c.s === 2) {
      /* s=1 楼体（顶面 c.h）；s=2 带上下界的平台甲板/井架（顶面 c.y1）——
         旧版只认 s=1，s=2 会掉进球体分支读 c.v.x → undefined 直接抛异常（AI 每帧崩）。 */
      const top = c.s === 2 ? c.y1 : c.h;
      const vx = c.x - from.x, vz = c.z - from.z;
      const along = vx * ux + vz * uz;
      if (along < 15 || along > len) continue;
      const lateral = Math.abs(vx * uz - vz * ux);
      if (lateral > c.hx + c.hz + 20) continue;     // 不在航路走廊里
      if (top < from.y + 18) continue;              // 已经在机腹以上，压不到
      if (!best || along < best.along) best = { along, top: top + 130, x: c.x, z: c.z };
    } else {
      const vx = c.v.x - from.x, vy = c.v.y - from.y, vz = c.v.z - from.z;
      const along = vx * ux + vz * uz;
      if (along < 15 || along > len) continue;
      const lateral = Math.abs(vx * uz - vz * ux);
      if (lateral > c.r + 20) continue;
      const top = c.v.y + c.r;
      if (top < from.y + 18) continue;
      if (!best || along < best.along) best = { along, top: top + 55, x: c.v.x, z: c.v.z };
    }
  }
  return best;
}


/* ================= 设置阵营状态（房主手动分配；3v3/5v5 与 aavs，空战 1v1 跳过） ================= */
                                // 键 "射手id:fid" 在两端都唯一（各自计数、跨玩家用复合键区分）
let accX = 0, accY = 0;
let locked = false;
/* ---- 指针锁失败兜底（v3.14.2）----
   Chrome/Edge 111+ 的 requestPointerLock() 返回 Promise，在"没有用户手势 / 窗口不在前台 /
   iframe 未授权 allow='pointer-lock'"时是异步 reject —— try/catch 抓不到。以前这里既不处理
   （顶部弹一条红色 error 条），后来改成 .catch(() => {}) 静默吞掉，结果是玩家**鼠标转不动、
   屏幕上却什么提示都没有**。现在分两级：
     ① 第一次失败 → 亮出「点击继续」遮罩（点击本身就是用户手势，点一下就能锁上）；
     ② 点过之后仍然失败（典型：iframe 没有 pointer-lock 权限）→ 降级「按住鼠标拖动转向」。
   pointerlockerror 与 Promise reject 会同时到达，用 400ms 去重，否则一次失败被记成两次、直接跳级。 */
let plFallback = false, plEverLocked = false, dragLook = false, plFailN = 0, plFailAt = 0;
const zoomTipEl = document.getElementById('zoomTip');
const zoomTipDefault = zoomTipEl ? zoomTipEl.innerHTML : '';   // 降级时被改写过，新一场要还原
function enablePLFallback() {
  if (plFallback || plEverLocked || locked) return;
  plFallback = true; dragLook = false;
  pauseEl.classList.add('hidden');
  if (zoomTipEl) zoomTipEl.innerHTML = '当前环境不支持鼠标锁定<br>按住鼠标拖动转向（左键同时开火）';
}
function plFail() {
  if (plEverLocked || locked) return;            // 锁上过又掉了：这是切窗口/按 Esc，交给 pointerlockchange
  const now = performance.now();
  if (now - plFailAt < 400) return;              // 同一次失败的两个信号只算一次
  plFailAt = now; plFailN++;
  if (plFailN >= 2) { enablePLFallback(); return; }
  if (STATE.started && !STATE.matchEnded && !IS_ANDROID_APP) pauseEl.classList.remove('hidden');
}
document.addEventListener('pointerlockerror', plFail);
window.addEventListener('sd-pl-fail', plFail);
/* v3.14.7：每场开始（beginMatch / 再来一局）都把降级状态清零。
   旧版 plFallback 一旦置位就永久为真 —— 上一局在"没锁上"的情况下打完，下一局
   plFail() 第一行就 return，pause 遮罩永远不出现，玩家鼠标转不动也没有任何提示。
   清零后：新一场仍会先尝试锁定 → 失败第 1 次弹「点击继续」→ 再失败才重新降级。 */
window.addEventListener('sd-match-start', () => {
  plFallback = false; plEverLocked = false; plFailN = 0; plFailAt = 0; dragLook = false;
  if (zoomTipEl) zoomTipEl.innerHTML = zoomTipDefault;   // 降级文案也还原（新一场不能还写着"不支持鼠标锁定"）
});
let pingMs = -1;            // HUD 延迟显示（netev.js 的 pong 处理经 setPingMs 写入）
export function setPingMs(v) { pingMs = v; }
let stateT = 0, pingT = 0, fpsT = 0, fpsCnt = 0, beepT = 0, warnOn = false;
let dmgAcc = 0;
                                 // 与加入方对齐：双方都在「完成阵营分配 → 开战瞬间」才 rebuildWorld
                                 // （此前房主点图就换，选阵营 45s 期间背景已是所选地图，且
                                 //  菜单展示实体留在旧坐标会穿帮，如空战选海岛后"水上飘飞机"）
export const deathPos = new THREE.Vector3();   // combat.js 自毁爆炸点复用（跨模块只读共享）
const tmpA = new THREE.Vector3();
const _bwTmp = new THREE.Vector3();    // 子弹撞世界采样
const _sndRight = new THREE.Vector3(); // 相机右向量（声音左右定位）
let whizT = 0;                         // "擦身而过"音效的全局节流（秒）


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
$('btnBackMenu').onclick = () => { setFiring(false); backToMenu(); };   // v3.11.2：软重置，不再刷新页面
$('btnSbTxt').onclick = () => downloadScoreboard();

// 观战状态（spec）/ 目标选择 / 多人状态栏 已移至 js/spectate.js（v3.4）
//   → 该模块先于本文件求值，spec 天然在输入监听器绑定前完成初始化（TDZ 已消除）

/* ================= 键鼠输入（v3.25 起三端统一，不再有触屏分支） ================= */
window.addEventListener('contextmenu', (e) => e.preventDefault());

/* 安卓 WebView 会把触摸"合成"成 mouse 事件（sourceCapabilities.firesTouchEvents = true）。
   触屏控件已经删掉，但如果不拦这一层，手指拖拽依旧会开火、转视角 —— 等于没删。
   真鼠标 / 触控板的事件不带这个标记，照常放行。 */
function touchSynth(e) {
  return !!(e && e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents);
}
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  if (locked) { plEverLocked = true; plFallback = false; plFailN = 0; }   // 一旦锁定成功，回到正常路径
  if (!locked && STATE.started && !STATE.matchEnded && !IS_ANDROID_APP && !plFallback) { pauseEl.classList.remove('hidden'); firing = false; setZoom(false); }
  else pauseEl.classList.add('hidden');
});
pauseEl.addEventListener('click', () => { if (STATE.started && !STATE.matchEnded) lockPointer(); });
document.addEventListener('mousemove', (e) => {
  if (touchSynth(e)) return;
  if (locked || (plFallback && dragLook)) { accX += e.movementX; accY += e.movementY; }
});
document.addEventListener('mousedown', (e) => {
  if (touchSynth(e)) return;
  if (locked) { if (e.button === 0) firing = true; if (e.button === 2) setZoom(true); return; }
  if (!plFallback) return;
  dragLook = true;
  if (e.button === 0) firing = true;
  if (e.button === 2) setZoom(true);
});
// 观战交互：左键切换目标 / 滚轮缩放距离
document.addEventListener('mousedown', (e) => { if (touchSynth(e)) return; if (typeof spec !== 'undefined' && spec.active && e.button === 0) specPick(true); });
document.addEventListener('wheel', (e) => {
  if (touchSynth(e)) return;
  if (typeof spec === 'undefined' || !spec.active) return;
  spec.dist = THREE.MathUtils.clamp(spec.dist * Math.exp(e.deltaY * 0.0012), 12, 130);
}, { passive: true });
document.addEventListener('mouseup', (e) => {
  if (touchSynth(e)) return;
  if (e.buttons === 0) dragLook = false;
  if (e.button === 0) firing = false;
  if (e.button === 2) setZoom(false);
});
window.addEventListener('blur', () => { dragLook = false; firing = false; setZoom(false); });

// 线段 a→b 到某点的最近距离（擦身判定用）
function segPointDist(a, b, p) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz || 1e-6;
  let t = (apx * abx + apy * aby + apz * abz) / l2;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function bulletPointDist(b, p) { return segPointDist(b.prev, b.pos, p); }
/* 子弹撞世界（v3.14）：枪口初速 880 后，一帧位移能到 15~50m，原来的单点检测会直接"穿楼"。
   沿本帧线段按 ≤10m 采样；再用 world.maxTop 做一次快速剔除 —— 整段都在最高碰撞体之上的
   空中弹（绝大多数）连一次检测都不用做，避免每帧几千次碰撞遍历。 */
function bulletHitWorld(b) {
  if (!world) return false;
  const top = world.maxTop || 0;
  if (b.prev.y > top && b.pos.y > top) return false;
  const dx = b.pos.x - b.prev.x, dy = b.pos.y - b.prev.y, dz = b.pos.z - b.prev.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const n = Math.min(8, Math.max(2, Math.ceil(dist / 10)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    _bwTmp.set(b.prev.x + dx * t, b.prev.y + dy * t, b.prev.z + dz * t);
    if (hitWorldAt(_bwTmp)) return true;
  }
  return false;
}

const keys = {};
/* 输入框里打字时一个键都不当操控键（v3.14.8）：
   建房/加入面板的「你的名字」是 <input>，旧版把 T/Y 当全局快捷键 ——
   名字里敲一个 T 就会申请麦克风、敲 Y 就切收音，在还没连上任何人的大厅里尤其莫名其妙。 */
function isTypingTarget(t) {
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
}
document.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target)) return;
  keys[e.code] = true;
  if (e.code === 'KeyM') audio.toggleMute();
  if (e.code === 'KeyF' && !e.repeat) toggleLiveStats();   // v3.22：实时战绩面板
  if (e.code === 'KeyT' && !e.repeat) toggleMicSend();
  if (e.code === 'KeyY' && !e.repeat) toggleVoiceRx();
  // 武器切换（v3.1/v3.2）：1 = 主武器（高射机枪 / 机炮），2 = 副武器（火箭炮 / 高爆子弹）
  if (e.code === 'Digit1' && !e.repeat) selectWeapon(1);
  if (e.code === 'Digit2' && !e.repeat) selectWeapon(2);
});
document.addEventListener('keyup', (e) => { keys[e.code] = false; });

/* v3.25：安卓版**移除全部触屏操控**（摇杆 / 开火 / 瞄准 / 武器 / 加减速 / 语音按钮）。
   三端现在只有一套控制方案：键盘 + 鼠标。安卓 App 仍可进菜单调设置、看更新日志、甚至进对局，
   但不再接受任何触摸操作（触屏拖拽不会误触发开火或转向）。 */

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

/* v3.31：部位伤害走当前模式文件夹里的 damage.js（air / aavs / heli / heli2 各自拥有倍率表）；
   坦克模式没有这个钩子，退回基础伤害（坦克炮弹走自己的装甲结算，不走这里）。 */
function partDmg(part, base, df) {
  const fn = modeField('partDamage', null);
  return fn ? fn(part, base, df) : Math.max(1, Math.round(base * df));
}

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
    syncMagWeapon();      // 换武器 → 换用该武器自己的弹夹（直升机对决：机炮 100 / 霰弹 6）
    if (whizT > 0) whizT -= dt;   // 擦身音效节流（v3.14）
    const ctlActive = locked || plFallback;   // v3.25：安卓不再有触屏，输入只来自键鼠
    const rawAccX = accX, rawAccY = accY;
    accX = 0; accY = 0;   // 每帧消费一次，避免松手后残留转向
    if (spec.active) {    // 观战：鼠标增量 → 环绕视角
      spec.yaw -= rawAccX * 0.0035;
      spec.pitch = THREE.MathUtils.clamp(spec.pitch + rawAccY * 0.0025, -0.05, 1.25);
    }
    if (meIsAAGun) {
      // === 防空车玩家控制（坦克式移动 + 炮塔） ===
      // 出海保险：防空车 y 固定 0（沿地面移动，不会坠海），改用水平距离检测——出岛（>430）即报废
      const _gb = modeField('groundBounds', 430);   // 坦克地图更大（乡村 780），防空车沿用 430
      if (meAAGun.alive && Math.hypot(myAAGun.group.position.x, myAAGun.group.position.z) > _gb) selfDestructAAGun();
      if (meAAGun.alive && !STATE.roundOver) {
        // 鼠标/触屏滑动 → 炮塔旋转（1:1无延迟），俯仰向上为主
        /* v3.31：炮塔卡死后停止旋转/俯仰（仍可朝当前方向开火） */
        if (!meAAGun.turretJammed) {
          meAAGun.turretYaw += (ctlActive ? -rawAccX * SENS : 0);
          /* 炮塔俯仰限位由模式给（防空车 -0.15~1.35 高射；坦克 -0.10~0.36 平射） */
          const _gp = modeField('groundPitch', null) || [-0.15, 1.35];
          meAAGun.turretPitch = THREE.MathUtils.clamp(meAAGun.turretPitch + (ctlActive ? -rawAccY * SENS : 0), _gp[0], _gp[1]);
        }
        // WASD 坦克式移动：W前进 S后退 A/D 转车体（速度/转向由模式给，缺省同防空车）
        const _gm = modeField('groundMove', null) || { fwd: 12, back: 6, turn: 1.05 };
        /* v3.30：坦克装甲损伤 —— 断一条履带 = 速度减半 + 不能朝断带一侧转；
           发动机损毁 / 两条履带全断 = 完全不能移动（immobilized）。其他模式没有这个钩子。 */
        const _mobFn = modeField('groundMobility', null);
        const _mob = _mobFn ? _mobFn(meAAGun) : null;
        let mv = 0;
        if (keys.KeyW) mv = _gm.fwd;
        else if (keys.KeyS) mv = -_gm.back;
        meAAGun.targetSpeed = meAAGun.immobilized ? 0 : mv * (_mob ? _mob.speedK : 1);
        meAAGun.speed += (meAAGun.targetSpeed - meAAGun.speed) * Math.min(1, dt * 2);
        if (!meAAGun.immobilized) {
          if (keys.KeyA && (!_mob || _mob.turnL)) meAAGun.bodyYaw += _gm.turn * dt;
          if (keys.KeyD && (!_mob || _mob.turnR)) meAAGun.bodyYaw -= _gm.turn * dt;
        }
        if (Math.abs(meAAGun.speed) > 0.1) {
          const prev = _agPos.copy(myAAGun.group.position);
          forwardOfBody(meAAGun, _agDir);
          myAAGun.group.position.addScaledVector(_agDir, meAAGun.speed * dt);
          // 建筑/围栏碰撞回退 + 护栏径向阻挡（围栏是圆形，径向检测最贴合，防开出岛）
          // + 防空车之间的碰撞体积（用户 2026-09-29 定：不扣血、只挡路）
          /* ★ 出界半径必须跟模式走：防空车地图是 430，坦克乡村地图是 780。
             旧版这里写死 393 —— 坦克的出生点在 z=330，往两侧开 60m 就被"回退"，
             780 的地图实际只能用到半径 393，一半战场进不去。 */
          const outR = Math.hypot(myAAGun.group.position.x, myAAGun.group.position.z);
          if (outR > modeField('groundBounds', 430) - 37 || collideTerrain({ group: myAAGun.group }) || blockedByAAGun()) myAAGun.group.position.copy(prev);
        }
        /* 地形高度（乡村图）：每帧把车贴到地面 —— 包括被炮弹炸出来的坑，
           所以坦克开进弹坑会真的往下沉一点。没有地形的地图保持 y=0 不变。 */
        if (world && world.groundY) {
          myAAGun.group.position.y = world.groundY(myAAGun.group.position.x, myAAGun.group.position.z);
        }
        applyAAGun(meAAGun);
        warnOn = false;
        setFireT(fireT - dt);
        const _mgGround = aagunWeapon === 'mg' && !modeField('fireGround', null);   // 只有高射机枪走弹夹（坦克炮由装填驱动）
        if (firing && fireT <= 0 && magGate(_mgGround)) {
          const _fg = modeField('fireGround', null);
          if (_fg) {
            /* 模式自定义地面武器（坦克：穿甲弹 / 燃烧弹，自己管装填与网络报文） */
            _fg(meAAGun, aagunWeapon, {
              dt, setFireT, audio, mode, iAmHost, myPeerId,
              myFireSeq, setMyFireSeq, netBroadcast, updateWeaponHud,
            });
          } else if (aagunWeapon === 'rocket') {
            // === 火箭炮（v3.1）：单发 · 近炸引信 · 一击致命 ===
            if (rocketAmmo > 0) {
              const shot = fireRocket(meAAGun, 'me', myPeerId);
              if (shot) {
                setRocketAmmo(rocketAmmo - 1); setFireT(1.1);
                audio.shoot();
                if (mode !== 'practice') {
                  setMyFireSeq(myFireSeq + 1); const fid = myFireSeq;
                  if (shot.rocket) { shot.rocket.fid = fid; shot.rocket.fFrom = myPeerId; }
                  if (iAmHost) netBroadcast({ t: 'rkt', o: shot.origin.toArray(), d: shot.dir.toArray(), from: myPeerId, fid, cv: shot.rocket.carrier.toArray() });
                  else netBroadcast({ t: 'fireRocket', o: shot.origin.toArray(), d: shot.dir.toArray(), fid, cv: shot.rocket.carrier.toArray() });
                }
                if (rocketAmmo <= 0) { setAagunWeapon('mg'); showPart('火箭弹已用尽'); }
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
            if (_mgGround) consumeMag();
          }
        }
      } else firing = false;
      warnEl.style.opacity = 0;
    } else if (me.alive && !STATE.roundOver) {
      const _aimFn = modeField('aim', null);
      if (_aimFn) {
        // 模式自管瞄准（直升机：鼠标转机枪炮塔，受转动限制）
        _aimFn(me, { dt, keys, rawAccX, rawAccY, ctlActive, isAndroid: false, setAim: (y, p) => { setAimYaw(y); setAimPitch(p); } });
      } else {
        // === 视角领先+飞机追赶操控（类似 Ace Combat / War Thunder） ===
        // 鼠标 → 累积到 aimYaw/aimPitch（视角偏移，1:1无延迟）
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
        // 油门：键盘 W/S
        if (keys.KeyW) me.targetSpeed = Math.min(SPEED_MAX, me.targetSpeed + 70 * dt);
        if (keys.KeyS) me.targetSpeed = Math.max(SPEED_MIN, me.targetSpeed - 70 * dt);
      }
      // 飞行物理：模式可提供自己的 flight(f, dt, ctx)（直升机：坦克式操控），否则用默认飞机物理
      /* v3.25：三端统一键鼠 —— 不传 isAndroid，直升机按 W/S/A/D/Q/E 飞 */
      if (_fl) _fl(me, dt, { keys, dt, isBot: false, isAndroid: false }); else applyFlight(me, dt);

      const _updFn = modeField('update', null);
      if (_updFn) _updFn(dt, { weapon: planeWeapon, roundOver: STATE.roundOver, zoom, firing });   // 模式每帧（直升机：炸弹落点投影 / 枪镜 HUD）
      const p = myPlane.group.position;
      const r = Math.hypot(p.x, p.z);
      warnOn = false;
      if (r > WORLD.BOUNDARY_WARN) { warnOn = true; warnEl.textContent = '警告：请返回战斗空域'; }
      if (p.y > WORLD.CEILING) { warnOn = true; warnEl.textContent = '警告：高度过高，立即下降'; }
      if (r > WORLD.BOUNDARY_HURT || p.y > WORLD.CEILING + 60) { dmgAcc += dt; if (dmgAcc > 0.5) { dmgAcc = 0; applyMeDamage(3); if (mode !== 'practice' && !iAmHost) netSendEventTo(hostPeerId, { t: 'envDmg', dmg: 3 }); } }
      if (warnOn) { beepT -= dt; if (beepT <= 0) { beepT = 0.7; audio.beep(); } }
      if (p.y < 3.5) {
        selfDestruct();
      }

      // 撞楼/撞山 = 瞬死（与撞地撞海同规则）；联机经 selfDestruct 内部上报房主权威判定
      if (collideTerrain(myPlane)) selfDestruct();

      setFireT(fireT - dt);
      /* 除火箭 / 高爆 / 炸弹这三类"有独立备弹"的特殊弹外，其余都是弹夹武器（机炮、霰弹，
         以及直升机突袭历史遗留的 'mg'）—— 用白名单写法会把 'mg' 漏掉：枪照打、弹不掉。 */
      const _mgAir = !(planeWeapon === 'rocket' || planeWeapon === 'he' || planeWeapon === 'bomb');
      if (firing && fireT <= 0 && magGate(_mgAir)) {
        const _modeFire = modeField('fire', null);
        if (_modeFire) {
          /* 副武器：航空炸弹(bomb) 与双管霰弹(shot) 都走 secondary 分支；
             weapon 一并透传，模式内部再按具体武器细分。 */
          _modeFire((planeWeapon === 'bomb' || planeWeapon === 'shot') ? 'secondary' : 'primary', {
            dt, weapon: planeWeapon, mode, iAmHost, myPeerId, myFireSeq, setMyFireSeq, netBroadcast, audio, setFireT,
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
                if (iAmHost) netBroadcast({ t: 'rkt', o: shot.origin.toArray(), d: shot.dir.toArray(), from: myPeerId, fid, cv: shot.rocket.carrier.toArray() });
                else netBroadcast({ t: 'fireRocket', o: shot.origin.toArray(), d: shot.dir.toArray(), fid, cv: shot.rocket.carrier.toArray() });
              }
              if (rocketAmmo <= 0) { setPlaneWeapon('gun'); showPart('火箭弹已用尽'); }
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
            if (heAmmo <= 0) { setPlaneWeapon('gun'); showPart('高爆子弹已用尽'); }
            updateWeaponHud();
          }
          if (mode !== 'practice') {
            setMyFireSeq(myFireSeq + 1); const fid = myFireSeq;
            if (shot.bullet) { shot.bullet.fid = fid; shot.bullet.fFrom = myPeerId; }   // v3.0：归属标记（命中广播据此定位/销毁弹道）
            if (iAmHost) netBroadcast({ t: 'blt', o: shot.origin.toArray(), d: shot.dir.toArray(), from: myPeerId, ...bulletNetParams(shot) });
            else netBroadcast({ t: 'fire', o: shot.origin.toArray(), d: shot.dir.toArray(), fid, ...bulletNetParams(shot) });
          }
        }
        /* 扣弹放在整个 if/else 之后：机炮走 else、直升机走模式 fire 钩子，
           两条路的“主武器”都要吃一发弹夹（v3.23 修正：原来只在 else 里扣，heli 永远不掉弹）。 */
        if (_mgAir) consumeMag();
      }
    } else firing = false;
    warnEl.style.opacity = warnOn ? 1 : 0;

    /* ---- 其他飞机更新 ---- */
    for (const id in planes) {
      const pl = planes[id];
      if (pl.isBot && pl.bot) {
        if (!pl.bot.probe) pl.bot.probe = botProbe;   // 避障探针（注入一次即可，内部实时读 world）
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
                const bombMode = modeField('planeLoadout', 'rocket') === 'bomb';
                if (modeField('planeLoadout', 'rocket') === 'he') {
                  // 本模式 AI 走对地攻击：高爆子弹（备弹按模式，aavs 为 80 发；用完回普通机炮）
                  if (pl.__heAmmo === undefined) pl.__heAmmo = modeField('heAmmo', HE_AMMO);
                  if (pl.__heAmmo > 0 && dist < 1000) { pl.__heAmmo--; shot = fireGun(b, id, { he: true }); }
                } else if (!modeField('aiNoRocket', false) && !pl.__rocketUsed && dist >= (bombMode ? 150 : 200) && dist <= 800) {
                  /* ★ aiNoRocket：本模式的 AI 没有二号火箭弹（heli2 只有机炮 + 霰弹）。
                     没有这个开关时，planeLoadout='shot' 会掉进这条分支，AI 在 200~800m
                     就会发射机载火箭 —— 玩家看到的是"人机凭什么有火箭弹"。 */
                  // 空战：机载火箭（每回合 1 发，打提前量）
                  // ★ v3.11.3 直升机模式（planeLoadout='bomb'）：AI 这发对地武器不再开局秒人 ——
                  //   ① 开局 9s 内不投，给玩家反应窗口；② 落点带随机偏差：多数只吃溅射，小概率才准。
                  if (!bombMode || (pl.bot.age || 0) > 9) {
                    forwardOf(pl.bot, _fireDir);
                    _botAim.copy(tgtPos).addScaledVector(pl.__tgtVel, (dist / ROCKET_AVG_SPEED) * 0.9);
                    if (dist > 450) _botAim.y += (dist - 450) * 0.02;  // 补偿燃料耗尽后的下坠（v3.19 弹道更平，系数从 0.07 降到 0.02）
                    _botAim.sub(pl.plane.group.position).normalize();
                    let needDot = 0.98;
                    if (bombMode) {
                      // 18% 概率瞄得准（小概率一击致命），其余明显打偏 → 只有爆炸半径内的衰减伤害
                      const spread = Math.random() < 0.18 ? 0.012 : 0.055;
                      _botAim.x += (Math.random() - 0.5) * spread * 2;
                      _botAim.y += (Math.random() - 0.5) * spread;
                      _botAim.z += (Math.random() - 0.5) * spread * 2;
                      _botAim.normalize();
                      needDot = 0.85;  // 既然要打偏，就不要求机头精确对准（太低会让 AI 整局都不敢投）
                    }
                    // 机鼻大致对准即可；弹道用前置解方向
                    if (_fireDir.dot(_botAim) > needDot) {
                      pl.__rocketUsed = true;
                      const rk = firePlaneRocket(pl.bot, 'bot', id, _botAim);
                      if (rk) {
                        const mp = meIsAAGun ? myAAGun.group.position : (myPlane ? myPlane.group.position : rk.origin);
                        audio.enemyLaunchAt(rk.origin, rk.dir);
                      }
                      return;
                    }
                  }
                }
              }
              /* 模式专属 AI 副武器（heli2：AI 也会用双管霰弹，练习才有意义）。
                 返回 { origin, dir } 表示本帧已经用副武器开火；返回 null 则回落到机炮。 */
              if (!shot) {
                const _bf = modeField('botFire', null);
                if (_bf) {
                  const _bd = target.plane ? pl.plane.group.position.distanceTo(target.plane.group.position) : 1e9;
                  shot = _bf(b, id, _bd);
                }
              }
              if (!shot) shot = fireGun(b, id);
              const myPos = meIsAAGun ? myAAGun.group.position : (myPlane ? myPlane.group.position : shot.origin);
              audio.enemyShootAt(shot.origin, shot.dir);
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
          } else {
            applyFlight(pl.bot, dt);
          }
          // bot 撞楼/撞山 = 瞬死（与玩家同规则，房主/人机权威判定）
          if (collideTerrain(pl.plane)) {
            peerDie(id);
            setLastDmgFrom(null);
          }
        }
      } else if (pl.alive) {
        const k = 1 - Math.exp(-12 * dt);
        pl.plane.group.position.lerp(pl.tPos, k);
        pl.plane.group.quaternion.slerp(pl.tQuat, k);
        // 远端飞机的旋翼/螺旋桨：按模型自带的轴与转速转（v3.14.7）
        //   螺旋桨（plane.js）绕 z，直升机主旋翼（heli.js）绕 y。旧版一律绕 z，直升机旋翼会翻滚。
        if (pl.plane.prop) {
          const axis = pl.plane.propAxis || 'z';
          pl.plane.prop.rotation[axis] += dt * (pl.plane.propSpeed !== undefined ? pl.plane.propSpeed : -40);
        }
        if (pl.plane.tail) pl.plane.tail.rotation.x += dt * (pl.plane.tailSpeed !== undefined ? pl.plane.tailSpeed : 62);
      }
    }

    /* ---- 防空车更新 ---- */
    for (const id in aaguns) {
      const ag = aaguns[id];
      // 出界报废（半径由模式给：防空车地图 430，坦克乡村 780）
      if (ag.alive && Math.hypot(ag.aagun.group.position.x, ag.aagun.group.position.z) > modeField('groundBounds', 430)) { peerDie(id); continue; }
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
          /* 玩家自己不在 planes/aaguns 字典里，必须单独喂给 AI —— 否则坦克对坦克时
             敌方 AI 完全看不见玩家（旧代码只处理了"玩家开飞机"的情况）。 */
          if (meIsAAGun && meAAGun && meAAGun.alive && myTeam !== ag.team) {
            tryT({ plane: { group: myAAGun.group }, speed: 0, alive: true }, myAAGun.group.position);
          } else if (!meIsAAGun && me && me.alive && myTeam !== ag.team) tryT(me, myPlane.group.position);
          for (const oid in planes) { const o = planes[oid]; if (o.team !== ag.team && o.alive) tryT(o, o.plane.group.position); }
          const agPrev = _agPos.copy(ag.aagun.group.position);
          if (target) {
            ag.bot.update(dt, target, (aa) => {
              /* 模式自定义地面 AI 武器（坦克：装填好后打穿甲弹/燃烧弹）。
                 返回 true = 本帧已经开火，不再走下面的机炮/火箭分支。 */
              const _bgf = modeField('botFireGround', null);
              if (_bgf && _bgf(ag, target, aa)) return;
              // v3.2：防空车 AI 也会用火箭炮（每车每回合 1 发）——目标 60~800m 且炮塔对准度足够时发射。
              // ★ aiNoRocket：坦克模式没有火箭，不能掉进这条分支。
              // 火箭无制导（直线+重力），必须打提前量：用帧间位置差估算目标速度并平滑，按火箭飞行时间外推。
              if (!modeField('aiNoRocket', false) && !ag.__rocketUsed && target && target.plane) {
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
                const lead = d2 / ROCKET_AVG_SPEED;                   // 火箭预计飞行时间（燃料段平均速度）
                _botAim.copy(tgtPos).addScaledVector(ag.__tgtVel, lead * 0.9);
                if (d2 > 450) _botAim.y += (d2 - 450) * 0.02;         // 燃料耗尽后会下坠，粗略抬高炮口补偿（v3.19 弹道更平）
                _botAim.sub(ag.aagun.group.position).normalize();
                // 炮塔大致朝向即可（限速转向永远差 1.6°~5°，长距离必脱靶）；
                // 弹道走"前置解"方向（fireRocket 的 aimDir 参数），火箭沿解算方向直飞 → 才能真正命中
                if (d2 >= 60 && d2 <= 800 && _agDir.dot(_botAim) > 0.9) {
                  ag.__rocketUsed = true;
                  const rk = fireRocket(ag.ent, 'bot', ag.id, _botAim);
                  if (rk) {
                    const mp = meIsAAGun ? myAAGun.group.position : (myPlane ? myPlane.group.position : rk.origin);
                    audio.enemyLaunchAt(rk.origin, rk.dir);
                  }
                  return;   // 本帧改用火箭
                }
              }
              const shot = fireGunAAGun(aa, 'bot');
              const myPos = meIsAAGun ? myAAGun.group.position : (myPlane ? myPlane.group.position : shot.origin);
              audio.enemyShootAt(shot.origin, shot.dir);
            });
          }
          if (world && world.groundY) ag.aagun.group.position.y = world.groundY(ag.aagun.group.position.x, ag.aagun.group.position.z);
          applyAAGun(ag.ent);
          // AI 巡逻移动的碰撞回退（建筑/围栏）+ 护栏径向阻挡
          if (Math.hypot(ag.aagun.group.position.x, ag.aagun.group.position.z) > modeField('groundBounds', 430) - 37 || collideTerrain({ group: ag.aagun.group })) ag.aagun.group.position.copy(agPrev);
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
    /* ===== 统一弹道积分（v3.18）=====
       每颗子弹只有 b.vel 一条速度矢量，v(0) = 枪口初速 + 载具速度（spawnBullet 里算好）。
       每帧三条公式，不按载具、不按发射角、不按前进/后退分支：
         pos += v·dt                         位置
         v   *= 1/(1 + c·|v|·dt)            真实二次阻力（作用于整条矢量）
         v.y -= g·dt                        重力
       前进下射、后退前射、侧飞爬升、任意组合都只是 v(0) 不同，积分完全相同。 */
    /* 模式专属的可破坏物（如钻井平台）：每帧取一次，别在几千颗子弹的循环里反复查表 */
    const _bHitFn = modeField('bulletHit', null);
    for (const b of bullets) {
      if (!b.active) continue;
      b.prev.copy(b.pos);
      b.pos.addScaledVector(b.vel, dt);
      const sp = b.vel.length();
      if (sp > 0.01) b.vel.multiplyScalar(1 / (1 + BULLET_DRAG_Q * sp * dt));
      b.vel.y -= BULLET_GRAVITY * dt;
      b.life -= dt; b.mesh.position.copy(b.pos);
      if (b.life <= 0) { b.active = false; b.mesh.visible = false; continue; }
      // 溅射子弹不因落地消失（由落地爆炸逻辑处理）；普通子弹落地即消失
      if (b.pos.y < 0 && !b.splashR) { b.active = false; b.mesh.visible = false; continue; }
      // 模式专属可破坏物（钻井平台）：先于通用世界碰撞判定，命中后由模式结算伤害
      if (_bHitFn && _bHitFn(b)) { b.active = false; b.mesh.visible = false; continue; }
      // 撞楼/撞山/撞海：火花即消失
      // ★ v3.14：初速提到 880 后一帧能走 15~50m，原来的单点检测会"穿楼" → 改沿线段采样
      if (bulletHitWorld(b)) { effects.sparks(b.pos, 0xcfd6dd); b.active = false; b.mesh.visible = false; continue; }

      // ---- 擦身而过（v3.14）：别人的弹道从机身附近掠过 → 撕裂声 + 多普勒 ----
      // 只判一次（b._whiz），且要求"还在朝我接近"（掠过后再触发会晚一拍、听感错位）
      if (b.src !== 'me' && !b._whiz && !spec.active && whizT <= 0) {
        const mp = meIsAAGun ? (myAAGun && myAAGun.group.position) : (myPlane && myPlane.group.position);
        if (mp) {
          const dBody = bulletPointDist(b, mp);
          if (dBody < WHIZ_R) {
            const toward = (mp.x - b.pos.x) * b.vel.x + (mp.y - b.pos.y) * b.vel.y + (mp.z - b.pos.z) * b.vel.z;
            if (toward > 0) {
              b._whiz = 1;
              whizT = 0.11;                                  // 全局节流：密集弹幕只留最近的一两发
              audio.whizz(b.pos, b.vel, false, dBody);
            }
          }
        }
      }

      if (b.src === 'me' && !STATE.roundOver) {
        const isPractice = mode === 'practice';
        /* v3.14.5：**删掉「子弹打爆飞行中的火箭/炸弹」机制**。
           它会让同一发弹在两台机器上各自"引爆"（射手看到近炸、被打方看到被子弹打爆），
           房主按「发送者+fid」去重根本拦不住 → 同一发弹结算两次、人头还可能算给打爆的一方。
           现在弹药只能由引信/撞地/超时起爆，谁发射的谁结算，冲突从根上不存在。 */
        // ---- 打飞机 ----
        for (const id in planes) {
          const pl = planes[id];
          if (!pl.alive) continue;
          if (isPractice && pl.team === myTeam) continue;
          const wp = checkBulletHit(b, pl.plane);
          if (!wp) continue;
          b.active = false; b.mesh.visible = false;
          const isFriend = pl.team === myTeam;
          /* v3.30：部位只提供伤害倍率；血量归零统一直接爆炸。
             联机时本地不结算，交给房主 hostSettleHit 统一裁决。 */
          const _df = bulletDmgFactor(b);
          const dmg = partDmg(wp.name, b.dmg, _df);
          const _fatal = pl.hp - dmg <= 0;
          effects.sparks(b.pos, 0xffe08a); audio.hitConfirm();
          showHitmark(_fatal);
          showPart((isFriend ? '误伤' : '命中') + wp.name);
          if (isFriend) showFriendlyFire();   // v3.5.1：打中队友 → 中下方「误伤队友」警示
          if (isPractice) {
            // 练习模式：本地即权威（含 bot 判死与播报）
            setLastDmgFrom(myPeerId);
            pl.hp = Math.max(0, pl.hp - dmg);
            if (pl.hp <= 0) peerDie(pl.isBot ? 'bot' : id);
            setLastDmgFrom(null);
          } else if (iAmHost) {
            // 房主：本地即权威 → 结算 + 广播 hit（所有端据此放特效/更新血量）
            const p = pl.plane.group.position;
            hostSettleHit(myPeerId, id, wp.name, false, 0, [p.x, p.y, p.z], b.fid, _df, b.dmg);
          } else {
            // 非房主：只上报"我打中了谁 / 部位 / 我看到的他当时的位置"（不做任何本地扣血）
            const p = pl.plane.group.position;
            if (b.fid) netSendEventTo(hostPeerId, { t: 'hitRep', fid: b.fid, id, part: wp.name, df: +_df.toFixed(3), p: [p.x, p.y, p.z] });
          }
          break;
        }
        // ---- 打防空车 ----
        if (b.active) for (const id in aaguns) {
          const ag = aaguns[id];
          if (!ag.alive) continue;
          if (isPractice && ag.team === myTeam) continue;
          const wp = checkAAGunHit(b, ag);
          if (!wp) continue;
          b.active = false; b.mesh.visible = false;
          const isFriend = ag.team === myTeam;
          const _df = bulletDmgFactor(b);
          const dmg = partDmg(wp.name, b.dmg, _df);
          const _fatal = ag.hp - dmg <= 0;
          effects.sparks(b.pos, 0xffe08a); audio.hitConfirm(); effects.shake(0.2);
          showHitmark(_fatal);
          showPart((isFriend ? '误伤' : '命中') + wp.name);
          if (isFriend) showFriendlyFire();
          if (isPractice) {
            /* 练习模式：弹药箱只有致命那一发才殉爆；平时只按模式倍率掉血（防空车 2×） */
            setLastDmgFrom(myPeerId);
            const _ammoBlow = _fatal && wp.name === '弹药箱';
            ag.hp = _ammoBlow ? 0 : Math.max(0, ag.hp - dmg);
            if (ag.ent) ag.ent.hp = ag.hp;
            if (ag.hp <= 0) peerDie(ag.isBot ? 'bot' : id);
            setLastDmgFrom(null);
            if (_ammoBlow) {
              const gp = ag.aagun.group.position;
              partBlast([gp.x, gp.y + 1.2, gp.z], myPeerId, id);
            }
          } else if (iAmHost) {
            const p = ag.aagun.group.position;
            hostSettleHit(myPeerId, id, wp.name, false, 0, [p.x, p.y, p.z], b.fid, _df, b.dmg);
          } else {
            const p = ag.aagun.group.position;
            if (b.fid) netSendEventTo(hostPeerId, { t: 'hitRep', fid: b.fid, id, part: wp.name, df: +_df.toFixed(3), p: [p.x, p.y, p.z] });
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
            if (isPractice) { setLastDmgFrom(myPeerId); ag.hp -= dmg; if (ag.hp <= 0) peerDie(ag.isBot ? 'bot' : id); setLastDmgFrom(null); }
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
              if (isPractice) { setLastDmgFrom(myPeerId); ag.hp -= dmg; if (ag.hp <= 0) peerDie(ag.isBot ? 'bot' : id); setLastDmgFrom(null); }
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
          if (wp) {
            b.active = false; b.mesh.visible = false;
            const _df = bulletDmgFactor(b);
            const _dmg = partDmg(wp.name, b.dmg, _df);
            const _ammoBlow = wp.name === '弹药箱' && (meAAGun.hp - _dmg <= 0);
            effects.sparks(b.pos, 0xffb3a0);
            showPart('被击中' + wp.name);
            setLastDmgFrom('bot');
            applyMeAAGunDamage(_ammoBlow ? 9999 : _dmg);
            setLastDmgFrom(null);
            if (_ammoBlow) {
              const gp = myAAGun.group.position;
              partBlast([gp.x, gp.y + 1.2, gp.z], 'bot', myPeerId);
            }
          }
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
          if (wp) {
            b.active = false; b.mesh.visible = false;
            const _df = bulletDmgFactor(b);
            const _dmg = partDmg(wp.name, b.dmg, _df);
            effects.sparks(b.pos, 0xffb3a0);
            showPart('被击中' + wp.name);
            setLastDmgFrom('bot'); applyMeDamage(_dmg); setLastDmgFrom(null);
          }
        }
      }
    }

    /* ---- 防空车火箭弹（v3.1）：飞行 + 近炸引信 ---- */
    for (const r of rockets) {
      if (!r.active) continue;
      r.prev.copy(r.pos);
      /* 火箭推进三状态（v3.19）：点火加速 → 巡航维持 → 无动力减速下坠。
         · 点火（burnT < IGNITE_T）：推力沿弹轴，速度 0 → V_MAX，同时受重力（弹道略微下弯）
         · 巡航（燃料还在烧）：推力矢量配平阻力与重力 → 速度大小、方向都不变（弹道笔直）
         · 无动力（燃料耗尽）：二次阻力减速 + 重力下坠，越飞越慢、越飞越低
         这样"一出膛就往下掉"的观感就没了：下坠从整段的十几米收敛到点火段那几米，
         真正看得出的抛物线出现在燃料烧完之后。 */
      if (r.fuelT > 0) {
        r.fuelT -= dt;
        r.burnT = (r.burnT || 0) + dt;
        if (r.burnT < ROCKET_IGNITE_T) {
          r.vel.addScaledVector(r.axis || _rkDir.copy(r.vel).normalize(), ROCKET_BOOST_ACCEL * dt);
          r.vel.y -= (r.grav !== undefined ? r.grav : ROCKET_GRAVITY) * dt;
        } else if (!r.cruise) {
          r.cruise = true;
          /* 精确到达最大速度：**相对弹轴**的增量是 V_MAX，再叠回发射瞬间的载具速度。
             不能直接 setLength(V_MAX) —— 那会把飞机/车体那 100 多 m/s 一起抹掉，
             表现为火箭刚出管就"急刹车"。 */
          r.vel.copy(r.axis).multiplyScalar(ROCKET_V_MAX).add(r.carrier);
        }
        if (r.fuelT <= 0 && r.mesh.userData.flame) r.mesh.userData.flame.visible = false;   // 燃料耗尽 → 尾焰消失
      } else {
        const rq = r.dragQ !== undefined ? r.dragQ : ROCKET_DRAG_Q;
        const rs = r.vel.length();
        if (rq > 0 && rs > 0.01) r.vel.multiplyScalar(1 / (1 + rq * rs * dt));   // 真实二次阻力
        r.vel.y -= (r.grav !== undefined ? r.grav : ROCKET_GRAVITY) * dt;
      }
      r.pos.addScaledVector(r.vel, dt);
      r.life -= dt;
      r.mesh.position.copy(r.pos);
      if (r.vel.lengthSq() > 1e-4) r.mesh.quaternion.setFromUnitVectors(ROCKET_NOSE_AXIS, _rkDir.copy(r.vel).normalize());
      // 撞楼/撞障碍（v3.5.1）：与城市楼群、基地建筑、山体等世界碰撞体接触即起爆。
      // 此前只判海平面 y<0.6，火箭会直接穿过楼宇；改用 prev→pos 线段检测，避免高速穿模。
      // 出膛首帧（frame 0）跳过：仅防枪口/机翼**贴着脸**的自家几何在原地自爆（不是距离豁免）。
      // v3.10.6：**无论飞了多远，碰到障碍物一律起爆**（用户要求；删掉 v3.10.2/v3.10.5 的距离豁免——
      // 旧豁免曾让空战都市图火箭全程穿楼）。
      if (r.frame++ > 0) {
        const hitW = rayHitWorld(r.prev, r.pos);
        if (hitW) {
          if (r.src === 'me' || r.src === 'bot') detonateRocket(r, null, hitW.pos);
          else { effects.explosion(hitW.pos, 1.6); audio.explosionAt(hitW.pos); r.active = false; r.mesh.visible = false; }
          continue;
        }
      }
      if (r.life <= 0 || r.pos.y < 0.6) {
        // 触地/耗尽：v3.3 打地板也会爆炸结算（发射者判定；观察者端只放爆炸特效保持视觉一致）
        if (r.src === 'me' || r.src === 'bot') detonateRocket(r, null, r.pos);
        else { effects.explosion(r.pos, 1.6); audio.explosionAt(r.pos); r.active = false; r.mesh.visible = false; }
        continue;
      }
      // ---- 火箭弹掠过（v3.14）：判定半径更大、声音更低沉；同样按多普勒改音高 ----
      if (r.src !== 'me' && !r._whiz && !spec.active && whizT <= 0) {
        const mp = meIsAAGun ? (myAAGun && myAAGun.group.position) : (myPlane && myPlane.group.position);
        if (mp) {
          const dBody = segPointDist(r.prev, r.pos, mp);
          if (dBody < WHIZ_R_ROCKET) {
            const toward = (mp.x - r.pos.x) * r.vel.x + (mp.y - r.pos.y) * r.vel.y + (mp.z - r.pos.z) * r.vel.z;
            if (toward > 0) { r._whiz = 1; whizT = 0.16; audio.whizz(r.pos, r.vel, true, dBody); }
          }
        }
      }
      /* ---- 引信规则（v3.13，用户明确规定）----
         · 航空炸弹：**完全没有近炸引信** —— 只认"实碰"（BOMB_HIT_R），敌我都不分（队友接住也炸）；
         · 火箭弹：对**敌方**保留 ROCKET_PROX_R 近炸（一击致命）；对**队友**必须实碰（ROCKET_HIT_R）。
         只有发射/投弹者那台机器判定（其他端是 foeVis 纯特效）；发射者自身永远排除。 */
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
        /* v3.14.5：**删掉「火箭弹撞航空炸弹 / 火箭撞火箭」的对撞机制**（与"子弹打爆弹药"同一类问题：
           由非归属者的机器去引爆别人的弹，会造成同一发弹两处结算）。弹药之间不再互相拦截。 */
        // 发射方阵营：本机发射 = myTeam；AI 发射 = 该 AI 实体所在阵营（练习模式可被测试改成同队）
        let shooterTeam = myTeam;
        if (r.src === 'bot') {
          const be = planes[r.owner] || aaguns[r.owner];
          shooterTeam = be ? be.team : (1 - myTeam);
        }
        // 选"主目标"：决定在哪起爆、谁吃满伤害。
        //   炸弹：只有实碰（BOMB_HIT_R），敌我不分。
        //   火箭：**先找敌方**（近炸 ROCKET_PROX_R，照常生效）；敌方都没触发，才找队友（实碰 ROCKET_HIT_R）。
        //   ★ 必须两轮筛选：队友只是"自己不吃近炸"，不能因为队友站在旁边就把敌人的近炸吞掉
        //     —— 否则会出现"我瞄着敌人、结果炸了旁边的队友"这种误解。
        const pickTarget = () => {
          let t = null, bd = Infinity;
          const visit = (obj, pPos, team, radiusOf) => {
            const R = radiusOf(team);
            if (R <= 0) return;
            const d = segDist(pPos);
            if (d <= R && d < bd) { bd = d; t = obj; }
          };
          const scan = (radiusOf) => {
            for (const id in planes) {
              if (id === r.owner) continue;
              const pl = planes[id];
              if (!pl.alive) continue;
              visit(pl, pl.plane.group.position, pl.team, radiusOf);
            }
            for (const id in aaguns) {
              if (id === r.owner) continue;
              const ag = aaguns[id];
              if (!ag.alive) continue;
              visit(ag, ag.aagun.group.position, ag.team, radiusOf);
            }
            // ★ 本机玩家不在 planes/aaguns 字典里：AI 弹药必须单独把它算进来
            //   （v3.9.0 修过"练习对手的火箭从玩家身边飞过永远不引爆"）。自己的弹药不会炸自己。
            if (r.src === 'bot') {
              const selfAlive = meIsAAGun ? !!(meAAGun && meAAGun.alive) : !!(me && me.alive);
              const selfPos = meIsAAGun ? (myAAGun ? myAAGun.group.position : null) : (myPlane ? myPlane.group.position : null);
              if (selfAlive && selfPos) visit({ id: myPeerId, alive: true, plane: { group: { position: selfPos } } }, selfPos, myTeam, radiusOf);
            }
          };
          if (r.isBomb) scan(() => BOMB_HIT_R);
          else {
            scan((team) => (team === shooterTeam ? 0 : ROCKET_PROX_R));            // ① 敌方近炸优先
            if (!t) scan((team) => (team === shooterTeam ? ROCKET_HIT_R : 0));     // ② 队友实碰
          }
          return t;
        };
        const tgt = pickTarget();
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
      hpLabel.textContent = modeField('groundHpLabel', '车体装甲');
      const hpPct = Math.max(0, meAAGun.hp / modeField('groundHp', AAGUN_HP) * 100);   // 按模式上限归一化
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
    /* 弹夹：换弹读条（备弹无限，打空自动补满） + 左下角「可用 / 备弹」 */
    if (magReload > 0) {
      setMagReload(magReload - dt);
      if (magReload <= 0) setMagAmmo(magCapNow());
    }
    {
      const _am = ammoInfo();
      const _av = $('ammoVal');
      if (_av) {
        _av.textContent = _am.cur + ' / ' + _am.res;
        _av.style.color = magReload > 0 ? '#ffd27a' : '#9fd8ff';
      }
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
    updateLiveHud(dt);   // 左上战术地图 + F 实时战绩（js/live.js，v3.22）
    updateKillcam();     // 死斗击杀镜头：倒计时 + 兜底收回（重生报文到达时由 combat 清掉）
    dmgFlashEl.style.opacity = Math.max(0, parseFloat(dmgFlashEl.style.opacity || 0) - dt * 2.2);

    /* 模式全局每帧钩子：与玩家开什么载具无关，且放在物理更新之后（模型与弹道同帧）。
       直升机模式的炸弹视觉同步挂在这里 —— 原来挂在 updateHeli（只在玩家开直升机时跑），
       房主开防空车时别人的炸弹会停在投弹点悬浮。 */
    const _tickFn = modeField('tick', null);
    if (_tickFn) _tickFn(dt);
    updateMarkers();
    updateRoster();
    killValEl.textContent = killCount;
  } else {
    updateMenuScene(dt);   // 菜单展示：飞机螺旋桨 / 防空车炮塔扫描 / 天上飞机盘旋
  }

  updateCamera(dt);
  /* 声音（v3.14）：听者跟随相机；把"声波已经到达"的世界音效排出去。
     必须放在 updateCamera 之后 —— 这一帧相机的位置/朝向才是听者的准确位姿。 */
  audio.setListener(camera.position, _sndRight.set(1, 0, 0).applyQuaternion(camera.quaternion));
  audio.update();
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
        matchType: STATE.matchType || 'elim', killTarget: STATE.killTarget | 0,
        teamKills: [STATE.s0 | 0, STATE.s1 | 0],
        killcam: STATE.killcam ? { by: STATE.killcam.by, weapon: STATE.killcam.weapon, name: STATE.killcam.name } : null,
        myPos: meIsAAGun ? (myAAGun ? myAAGun.group.position.toArray().map((n) => Math.round(n)) : null)
                         : (myPlane ? myPlane.group.position.toArray().map((n) => Math.round(n)) : null),
        myYaw: me ? me.yaw : null,
        meParts: meIsAAGun
          ? (meAAGun ? { immobilized: meAAGun.immobilized || null, trackL: !!meAAGun.trackL, trackR: !!meAAGun.trackR, engOut: !!meAAGun.engOut, turretJammed: !!meAAGun.turretJammed } : null)
          : null,
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
        const _gpd = modeField('groundPitch', null) || [-0.15, 1.35];
        meAAGun.turretPitch = THREE.MathUtils.clamp(Math.atan2(y - p.y, Math.hypot(dx, dz)), _gpd[0], _gpd[1]);
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

