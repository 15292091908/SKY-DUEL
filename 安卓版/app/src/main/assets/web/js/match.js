// js/match.js — 回合与比赛生命周期（v3.4.1 从 main.js 抽出）
// resetState（开局重置）/ startPractice（练习 1v1 构建）/ nextRound（回合复位与武器重置）/
// applyRematch（重赛）/ hasOpponent（能否重赛判定）。
import * as THREE from 'three';
import { modeDef, modeDefaultMap, modeField } from './mode.js?v=1516';
import {
  STATE, planes, aaguns, world, mode, gamemode, practiceSize, netSize, iAmHost, myPeerId, myTeam, mySlot,
  roster, me, myPlane, myAAGun, meAAGun, meIsAAGun, hitSettled,
  setMode, setPracticeSize, setGamemode, setMySlot, setMyTeam, setMeIsAAGun, setMyAAGun, setMeAAGun,
  setMyPlane, setMe, setAimYaw, setAimPitch, setKillCount, setSbRows,
  setAagunWeapon, setRocketAmmo, setPlaneWeapon, setHeAmmo,
} from './state.js?v=1516';
import { AAGUN_HP, HE_AMMO, ROCKETS_PER_AAGUN } from './config.js?v=1516';
import { scene, canvas, IS_ANDROID_APP } from './core.js?v=1516';
import { buildPlane, makeFighter } from './plane.js?v=1516';
import { buildAAGun, makeAAGun, applyAAGun } from './aagun.js?v=1516';
import { Bot, AAGunBot } from './ai.js?v=1516';
import { rebuildWorld, clearMenuProps } from './scene3d.js?v=1516';
import { spawnPos, aagunSpawnPos, clearUnits } from './units.js?v=1516';
import { rockets, bullets, updateWeaponHud, resetKillLedger } from './combat.js?v=1516';
import { $, banner, clearKillFeed, roundLabelEl, matchPanel, updateScore } from './hud.js?v=1516';
import { netBroadcast } from './netev.js?v=1516';
import { beginMatch } from './sdp.js?v=1516';

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
}

// 练习模式（人机对决）：固定 1v1
// side: 0 = 红队（空战）/ 飞机阵营（aavs），1 = 蓝队 / 防空车阵营；bot 自动站对面阵营

export function startPractice(gm, side, map) {
  // ★进对局前清掉菜单 3D 展示件（坦克/直升机），否则会留在场景里（用户反馈）
  clearMenuProps();   // ★进对局前清掉菜单 3D 展示件（坦克/直升机）
  setMode('practice');
  setPracticeSize(2);
  setGamemode(gm);
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
    meAAGun.hp = AAGUN_HP; meAAGun.alive = true;
    meAAGun.turretYaw = (myTeam === 0) ? 0 : Math.PI; meAAGun.turretPitch = 0.35;
    meAAGun.bodyYaw = (myTeam === 0) ? 0 : Math.PI; meAAGun.speed = 0; meAAGun.targetSpeed = 0;
    myAAGun.group.position.copy(aagunSpawnPos(mySlot, aaSpawns));
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
  }

  for (const id in planes) {
    const pl = planes[id];
    pl.hp = 100; pl.alive = true;
    pl.plane.group.position.copy(spawnPos(pl.team, pl.slot, ts));
    pl.plane.group.visible = true;
    if (pl.isBot && pl.bot) {
      pl.bot.reset(pl.plane.group.position, pl.team === 0 ? 0 : Math.PI);
      delete pl.__rocketUsed; pl.__heAmmo = HE_AMMO;   // v3.3：AI 2 号武器每回合重置
    }
  }
  for (const id in aaguns) {
    const ag = aaguns[id];
    ag.hp = AAGUN_HP; ag.alive = true;
    ag.aagun.group.position.copy(aagunSpawnPos(ag.slot, aaSpawns));
    ag.aagun.group.visible = true;
    ag.ent.turretYaw = (ag.team === 0) ? 0 : Math.PI; ag.ent.turretPitch = 0.35;
    ag.ent.bodyYaw = (ag.team === 0) ? 0 : Math.PI; ag.ent.speed = 0; ag.ent.targetSpeed = 0;
    if (ag.isBot && ag.bot) ag.bot.reset(ag.aagun.group.position);
    else { applyAAGun(ag.ent); }
  }
  hitSettled.clear();                             // v3.0：清空"已结算命中"表（新回合重新计数）
  // 新回合重置防空车武器与火箭弹（每回合 1 发，保证各回合起点公平）
  setAagunWeapon('mg'); setRocketAmmo(ROCKETS_PER_AAGUN);
  setPlaneWeapon('gun'); setHeAmmo(HE_AMMO);
  for (const r of rockets) { r.active = false; r.mesh.visible = false; }
  for (const id in aaguns) delete aaguns[id].__rocketUsed;   // AI 防空车火箭：每回合重置
  updateWeaponHud();
  for (const b of bullets) { b.active = false; b.mesh.visible = false; }
  roundLabelEl.textContent = '第 ' + STATE.roundNum + ' 回合';
  banner('第 ' + STATE.roundNum + ' 回合', '#dff1ff', 1.6);
}

/* matchOver/applyMatchEnd 已移至 js/combat.js（v3.4）
   → 注意 matchOver 由 settleRound 调用、applyMatchEnd 由 matchEnd 消息处理调用 */
export function lockPointer() {
  if (IS_ANDROID_APP) return;
  try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
}
export function applyRematch() {
  STATE.matchEnded = false; STATE.myScore = 0; STATE.foeScore = 0; STATE.s0 = 0; STATE.s1 = 0; STATE.roundNum = 0;
  setKillCount(0); resetKillLedger();
  setSbRows([]);
  $('sbWrap').classList.add('hidden');
  $('btnSbTxt').classList.add('hidden');
  updateScore(); matchPanel.classList.add('hidden'); nextRound(); lockPointer();
}
// 是否有对方队伍玩家（决定能否重赛；队友不算对手）
export function hasOpponent() {
  if (mode === 'practice') return true;
  for (const p of roster) if (p.peerId !== myPeerId && p.team !== myTeam) return true;
  return false;
}
