// js/units.js — 单位（飞机/防空车）创建与清理（v3.4.1 从 main.js 抽出）
// 出生点计算、实体工厂、按 roster 批量构建、整场清理。纯工厂逻辑，不反向依赖 main.js。
import * as THREE from 'three';
import {
  planes, aaguns, myPlane, myAAGun, myPeerId, myTeam, mySlot, roster, gamemode, netSize, world,
  setMyPlane, setMe, setMyAAGun, setMeAAGun, setBot, setMyTeam, setMySlot, setMeIsAAGun,
} from './state.js?v=1516';
import { AAGUN_HP, SPAWN_Z } from './config.js?v=1516';
import { modeField } from './mode.js?v=1516';   // 「游戏内」模式模块（出生点/阵营载具由模式描述符决定）
import { scene } from './core.js?v=1516';
import { buildPlane, makeFighter } from './plane.js?v=1516';
import { buildAAGun, makeAAGun } from './aagun.js?v=1516';

export function spawnPos(team, slot, teamSize) {
  const x = (slot - (teamSize - 1) / 2) * 140;
  const sp = modeField('spawn', null) || { airY: 280, airZ: SPAWN_Z };   // 出生几何来自模式模块
  return new THREE.Vector3(x, sp.airY, team === 0 ? sp.airZ : -sp.airZ);
}
// 防空车出生点（军事基地岛点位，防空车阵营 = team1）
export function aagunSpawnPos(slot, aaSpawns) {
  const s = aaSpawns ? aaSpawns[slot % aaSpawns.length] : { x: 0, z: 0 };
  return new THREE.Vector3(s.x, 0, s.z);
}

export function clearUnits() {
  if (myPlane) { scene.remove(myPlane.group); setMyPlane(null); setMe(null); }
  if (myAAGun) { scene.remove(myAAGun.group); setMyAAGun(null); setMeAAGun(null); }
  for (const id in planes) scene.remove(planes[id].plane.group);
  for (const k in planes) delete planes[k];
  for (const id in aaguns) scene.remove(aaguns[id].aagun.group);
  for (const k in aaguns) delete aaguns[k];
  setBot(null);
}

// 防空车实体工厂
export function makeAAGunUnit(peerId, team, slot, color) {
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
export function buildAllUnits() {
  clearUnits();
  const ts = netSize / 2;
  const aaSpawns = (world && world.aaSpawns) ? world.aaSpawns : null;

  // 玩家实体
  const myR = roster.find(p => p.peerId === myPeerId) || { peerId: myPeerId, team: myTeam, slot: mySlot };
  setMyTeam(myR.team); setMySlot(myR.slot);
  const _buildAir = modeField('buildAir', null) || buildPlane;   // 空中单位模型交给模式（直升机）
  const _makeAir = modeField('makeAir', null) || makeFighter;
  if (modeField('groundTeam', null) === myR.team) {   // 本模式里「开防空车」的阵营
    // 玩家是防空车阵营
    setMeIsAAGun(true);
    setMyAAGun(buildAAGun(0x3fa7ff)); scene.add(myAAGun.group);
    setMeAAGun(makeAAGun(myAAGun));
    myAAGun.group.position.copy(aagunSpawnPos(myR.slot, aaSpawns));
  } else {
    setMeIsAAGun(false);
    setMyPlane(_buildAir(0x3fa7ff)); scene.add(myPlane.group);
    setMe(_makeAir(myPlane));
  }

  // 其他玩家单位
  for (const p of roster) {
    if (p.peerId === myPeerId) continue;
    if (p.team < 0) continue;   // 尚未分配阵营的占位，跳过
    const isFoe = p.team !== myTeam;
    const color = isFoe ? 0xff5340 : 0x3fa7ff;
    if (modeField('groundTeam', null) === p.team) {
      const unit = makeAAGunUnit(p.peerId, p.team, p.slot, color);
      unit.aagun.group.position.copy(aagunSpawnPos(p.slot, aaSpawns));
    } else {
      const pl = _buildAir(color); scene.add(pl.group);
      planes[p.peerId] = {
        id: p.peerId, plane: pl, team: p.team, slot: p.slot,
        alive: true, hp: 100, tPos: new THREE.Vector3(), tQuat: new THREE.Quaternion(),
        lastState: 0, isBot: false
      };
    }
  }
}
