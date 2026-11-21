// js/match.js — 回合与比赛生命周期（v3.4.1 从 main.js 抽出）
// resetState（开局重置）/ startPractice（练习 1v1 构建）/ nextRound（回合复位与武器重置）/
// applyRematch（重赛）/ hasOpponent（能否重赛判定）。
import * as THREE from 'three';
import { modeDef, modeDefaultMap, modeField } from './mode.js?v=1572';
import {
  STATE, planes, aaguns, world, mode, gamemode, practiceSize, netSize, iAmHost, myPeerId, myTeam, mySlot,
  roster, me, myPlane, myAAGun, meAAGun, meIsAAGun, hitSettled,
  setMode, setPracticeSize, setGamemode, setMySlot, setMyTeam, setMeIsAAGun, setMyAAGun, setMeAAGun,
  setMyPlane, setMe, setAimYaw, setAimPitch, setKillCount, setSbRows,
  setAagunWeapon, setRocketAmmo, setPlaneWeapon, setHeAmmo, setMagAmmo, setMagReload, clearMagSwap,
} from './state.js?v=1572';
import { AAGUN_HP, HE_AMMO, ROCKETS_PER_AAGUN } from './config.js?v=1572';
import { scene, canvas, IS_ANDROID_APP } from './core.js?v=1572';
import { buildPlane, makeFighter } from './plane.js?v=1572';
import { buildAAGun, makeAAGun, applyAAGun } from './aagun.js?v=1572';
import { Bot, AAGunBot } from './ai.js?v=1572';
import { rebuildWorld, clearMenuProps } from './scene3d.js?v=1572';
import { spawnPos, aagunSpawnPos, clearUnits } from './units.js?v=1572';
import { rockets, bullets, updateWeaponHud, resetKillLedger, resetPartState } from './combat.js?v=1572';
import { clearRespawnTimers } from './combat.js?v=1572';   // 死斗：回大厅/重赛时清掉待执行的重生定时器
import { clearKillcam } from './killcam.js?v=1572';
import { $, banner, clearKillFeed, roundLabelEl, matchPanel, updateScore } from './hud.js?v=1572';
import { netBroadcast } from './netev.js?v=1572';
import { beginMatch } from './sdp.js?v=1572';
import { DM_KILL_TARGET } from './config.js?v=1572';

export function resetState() {
  STATE.started = false;
  STATE.roundOver = false;
  STATE.matchEnded = false;
  STATE.myScore = 0;
  STATE.foeScore = 0;
  STATE.s0 = 0; STATE.s1 = 0;   // 队伍视角比分（team0/team1 各赢几局，房主小世界权威）
  STATE.roundNum = 0;
  STATE.mapType = modeDefaultMap('island');   // 默认地图来自「游戏内」模式模块
  STATE.mapFinalized = false;
  STATE.eliminatedTeam = -1;
  STATE.teamElimTimer = 0;
  /* 死斗（v3.15）：matchType 是「本房间」的规则，回到大厅即失效（下次建房重新选）。
     不在这里清会让上一间死斗房的规则泄漏到下一间默认房。 */
  STATE.matchType = 'elim';
  STATE.killTarget = DM_KILL_TARGET;
  STATE.killcam = null;
  STATE.lastHit = null;
  STATE.respawnAt = 0;
  clearKillcam();
  clearRespawnTimers();
}

// 练习模式（人机对决）：固定 1v1
// side: 0 = 红队（空战）/ 飞机阵营（aavs），1 = 蓝队 / 防空车阵营；bot 自动站对面阵营

export function startPractice(gm, side, map) {
  // ★进对局前清掉菜单 3D 展示件（坦克/直升机），否则会留在场景里（用户反馈）
  clearMenuProps();   // ★进对局前清掉菜单 3D 展示件（坦克/直升机）
  setMode('practice');
  setPracticeSize(2);
  setGamemode(gm);
  STATE.matchType = 'elim';   // 练习模式固定按歼灭规则（五局三胜），死斗只在联机房间可选
  clearKillcam();
  clearRespawnTimers();
  setMySlot(0);
  rebuildWorld(map);
  clearUnits();
  const aaSpawns = (world && world.aaSpawns) ? world.aaSpawns : null;

  // 编成交给「游戏内」模式模块（新增玩法 = 自己写一个 spawnPractice，不用改本文件）
  modeDef().spawnPractice({
    THREE, scene, side, world, planes, aaguns,
    buildPlane, makeFighter, buildAAGun, makeAAGun, Bot, AAGunBot,
    buildAir: modeDef().buildAir || buildPlane,   // 空中单位模型交给模式（直升机=buildHeli）
    makeAir: modeDef().makeAir || makeFighter,
    /* 地面载具模型交给模式（坦克对决=buildTank；缺省 = 防空车）。
       groundSpawnPos 带 team：坦克对决的出生点分两队，防空车模式的地图点位不分队。 */
    buildGround: modeField('buildGround', null) || buildAAGun,
    makeGround: modeField('makeGround', null) || makeAAGun,
    groundHp: modeField('groundHp', AAGUN_HP),
    groundSpawnPos: (slot, team) => aagunSpawnPos(slot, aaSpawns, team),
    groundY: (x, z) => (world && world.groundY) ? world.groundY(x, z) : 0,
    spawnPos, aagunSpawnPos, aaSpawns, AAGUN_HP,
    color: { ally: 0x3fa7ff, foe: 0xff5340 },
    get myTeam() { return myTeam; },        // 实时读取：setter 之后必须拿到新值
    get myPlane() { return myPlane; },
    get myAAGun() { return myAAGun; },
    set: { myTeam: setMyTeam, meIsAAGun: setMeIsAAGun, myAAGun: setMyAAGun, meAAGun: setMeAAGun, myPlane: setMyPlane, me: setMe },
  });
  beginMatch();
}

export function nextRound(targetRn) {
  if (STATE.matchEnded) return;   // 比赛已结束（如房主掉线）不再开新回合
  if (!STATE.started) return;     // 尚未开局（beginMatch 前）：sync 兜底/乱序消息不得提前重置（me/myPlane 为空会空引用崩溃）
  clearKillFeed();                // 新回合一并清掉上一轮的击杀播报
  // 局号：房主本地自增；非房主由 'round' 消息 / sync 兜底指定（幂等：rn 不超前则被调用方过滤）
  STATE.roundNum = (targetRn !== undefined) ? targetRn : STATE.roundNum + 1;
  STATE.roundOver = false;
  STATE.eliminatedTeam = -1; STATE.teamElimTimer = 0;
  if (mode !== 'practice' && iAmHost) netBroadcast({ t: 'round', rn: STATE.roundNum });   // 房主权威推送局号
  const ts = (mode === 'practice') ? (practiceSize / 2) : (netSize / 2);
  const aaSpawns = (world && world.aaSpawns) ? world.aaSpawns : null;
  setAimYaw(0); setAimPitch(0);

  // 模式回合重置（直升机：航空炸弹每回合补满）
  const _rr = modeDef() && modeDef().roundReset;
  if (typeof _rr === 'function') _rr();

  // 玩家实体重置
  if (meIsAAGun) {
    const _ghp = modeField('groundHp', AAGUN_HP);
    const _grp = modeField('groundPitchRest', 0.35);
    meAAGun.hp = _ghp; meAAGun.alive = true;
    meAAGun.turretYaw = (myTeam === 0) ? 0 : Math.PI; meAAGun.turretPitch = _grp;
    meAAGun.bodyYaw = (myTeam === 0) ? 0 : Math.PI; meAAGun.speed = 0; meAAGun.targetSpeed = 0;
    myAAGun.group.position.copy(aagunSpawnPos(mySlot, aaSpawns, myTeam));
    myAAGun.group.visible = true;
    applyAAGun(meAAGun);
  } else {
    me.hp = 100; me.alive = true;
    const _sp0 = modeField('spawnSpeed', 95);
    me.speed = me.targetSpeed = _sp0;
    me.pitch = me.roll = me.yawVel = 0;
    me.yaw = (myTeam === 0) ? 0 : Math.PI;
    // ★视角必须跟着出生朝向一起复位：否则上一回合残留的视角会让机头"绕大圈"追赶
    //   （直升机症状：下一回合原地超快速旋转 / 小准星卡死）
    me.viewYaw = me.yaw; me.viewPitch = 0; me.mgYaw = 0; me.mgPitch = 0;
    if (me.vel && me.vel.set) me.vel.set(0, 0, 0);
    if (me.plane && me.plane.mgPod) me.plane.mgPod.rotation.set(0, 0, 0);
    setAimYaw(0); setAimPitch(0);
    myPlane.group.position.copy(spawnPos(myTeam, mySlot, ts));
    myPlane.group.visible = true;
    myPlane.group.quaternion.setFromEuler(new THREE.Euler(0, me.yaw, 0, 'YXZ'));
    /* v3.28.4：坠毁时的侧翻/俯仰是写在 mesh 子节点上的（helis 的滚转、悬停浮动），
       只复位 group 四元数不够 —— 上一回合的侧翻会原样带到下一回合。 */
    if (myPlane.mesh) myPlane.mesh.rotation.set(0, 0, 0);
  }

  for (const id in planes) {
    const pl = planes[id];
    pl.hp = 100; pl.alive = true;
    pl.rocketSide = 0;                              // v3.17：每回合从左侧第一个挂架重新开始
    pl.plane.group.position.copy(spawnPos(pl.team, pl.slot, ts));
    pl.plane.group.visible = true;
    const _pyaw = pl.team === 0 ? 0 : Math.PI;
    pl.plane.group.quaternion.setFromEuler(new THREE.Euler(0, _pyaw, 0, 'YXZ'));
    if (pl.plane.mesh) pl.plane.mesh.rotation.set(0, 0, 0);
    /* 远端实体：同步基准也一起复位，否则房主会在收到新状态前继续用上一回合的
       tQuat（侧翻/倒扣）插值，开局出现"对面还歪着"。 */
    pl.tPos.copy(pl.plane.group.position);
    pl.tQuat.copy(pl.plane.group.quaternion);
    if (pl.isBot && pl.bot) {
      pl.bot.reset(pl.plane.group.position, _pyaw);
      delete pl.__rocketUsed; pl.__heAmmo = modeField('heAmmo', HE_AMMO);   // v3.3：AI 2 号武器每回合重置（v3.22 按模式备弹）
    }
  }
  for (const id in aaguns) {
    const ag = aaguns[id];
    ag.hp = modeField('groundHp', AAGUN_HP); ag.alive = true;
    ag.rocketSide = 0;                              // v3.17：同上
    ag.aagun.group.position.copy(aagunSpawnPos(ag.slot, aaSpawns, ag.team));
    ag.aagun.group.visible = true;
    ag.ent.turretYaw = (ag.team === 0) ? 0 : Math.PI; ag.ent.turretPitch = modeField('groundPitchRest', 0.35);
    ag.ent.bodyYaw = (ag.team === 0) ? 0 : Math.PI; ag.ent.speed = 0; ag.ent.targetSpeed = 0;
    if (ag.isBot && ag.bot) ag.bot.reset(ag.aagun.group.position);
    else { applyAAGun(ag.ent); }
  }
  hitSettled.clear();                             // v3.0：清空"已结算命中"表（新回合重新计数）
  clearKillcam();                                 // 死斗：清掉上一场残留的击杀镜头
  // 新回合重置防空车武器与火箭弹（每回合 2 发，保证各回合起点公平）
  setAagunWeapon('mg'); setRocketAmmo(ROCKETS_PER_AAGUN);
  setPlaneWeapon('gun'); setHeAmmo(modeField('heAmmo', HE_AMMO));
  clearMagSwap();                                                            // v3.24：清空多武器弹夹分仓
  /* v3.28：新回合清空部位结构值与失效标志（发动机/机翼/尾梁/炮塔/弹药箱） */
  for (const id in planes) resetPartState(planes[id]);
  for (const id in aaguns) resetPartState(aaguns[id]);
  if (me) resetPartState(me);
  if (meAAGun) resetPartState(meAAGun);
  setMagAmmo(modeField('magSize', meIsAAGun ? 300 : 100)); setMagReload(0);   // v3.23 弹夹：每回合满夹
  for (const r of rockets) { r.active = false; r.mesh.visible = false; }
  for (const id in aaguns) delete aaguns[id].__rocketUsed;   // AI 防空车火箭：每回合重置
  updateWeaponHud();
  for (const b of bullets) { b.active = false; b.mesh.visible = false; }
  if (STATE.matchType === 'dm') {
    roundLabelEl.textContent = '死斗 · 先到 ' + (STATE.killTarget || DM_KILL_TARGET) + ' 杀';
    banner('死斗开始 · 先到 ' + (STATE.killTarget || DM_KILL_TARGET) + ' 杀', '#dff1ff', 2.4);
  } else {
    roundLabelEl.textContent = '第 ' + STATE.roundNum + ' 回合';
    banner('第 ' + STATE.roundNum + ' 回合', '#dff1ff', 1.6);
  }
}

/* matchOver/applyMatchEnd 已移至 js/combat.js（v3.4）
   → 注意 matchOver 由 settleRound 调用、applyMatchEnd 由 matchEnd 消息处理调用 */
export function lockPointer() {
  if (IS_ANDROID_APP) return;
  // v3.14.2：锁失败**不能静默**。Chrome/Edge 111+ 的 requestPointerLock() 返回 Promise，
  // 在"没有用户手势 / 窗口不在前台 / iframe 未授权 pointer-lock"时是异步 reject ——
  // try/catch 抓不到，只挂 .catch(() => {}) 又会让玩家"鼠标转不动但没有提示"。
  // 统一派发 sd-pl-fail，由 loop.js 的输入层决定：先提示点击，仍失败再降级拖动转向。
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => { window.dispatchEvent(new Event('sd-pl-fail')); });
  } catch (e) { window.dispatchEvent(new Event('sd-pl-fail')); }
}
export function applyRematch() {
  /* v3.22：房主断开与「点重赛」的竞态兜底 —— 名单里已经没有对手时不允许重置对局。
     否则会先把结算面板收掉、比分清零，紧随其后的掉线回调再判一次负，观感是"闪一下又变了"。 */
  if (mode !== 'practice' && !hasOpponent()) {
    const b = $('btnRematch'); if (b) b.classList.add('hidden');
    return false;
  }
  STATE.matchEnded = false; STATE.myScore = 0; STATE.foeScore = 0; STATE.s0 = 0; STATE.s1 = 0; STATE.roundNum = 0;
  setKillCount(0); resetKillLedger();
  clearKillcam(); clearRespawnTimers();   // 死斗：重赛要把击杀镜头/待重生全部清干净
  setSbRows([]);
  $('sbWrap').classList.add('hidden');
  $('btnSbTxt').classList.add('hidden');
  // 新一场开始：让 loop.js 把指针锁降级状态清零 —— 上一局降级过，本局也要重新给一次「点击继续」
  window.dispatchEvent(new Event('sd-match-start'));
  updateScore(); matchPanel.classList.add('hidden'); nextRound(); lockPointer();
}
// 是否有对方队伍玩家（决定能否重赛；队友不算对手）
export function hasOpponent() {
  if (mode === 'practice') return true;
  for (const p of roster) if (p.peerId !== myPeerId && p.team !== myTeam) return true;
  return false;
}
