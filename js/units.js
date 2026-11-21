// js/units.js — 单位（飞机/防空车）创建与清理（v3.4.1 从 main.js 抽出）
// 出生点计算、实体工厂、按 roster 批量构建、整场清理。纯工厂逻辑，不反向依赖 main.js。
import * as THREE from 'three';
import {
  planes, aaguns, myPlane, myAAGun, myPeerId, myTeam, mySlot, roster, gamemode, netSize, world,
  me, meAAGun, meIsAAGun,
  setMyPlane, setMe, setMyAAGun, setMeAAGun, setBot, setMyTeam, setMySlot, setMeIsAAGun,
} from './state.js?v=1572';
import { AAGUN_HP, SPAWN_Z } from './config.js?v=1572';
import { modeField } from './mode.js?v=1572';   // 「游戏内」模式模块（出生点/阵营载具由模式描述符决定）
import { scene } from './core.js?v=1572';
import { buildPlane, makeFighter } from './plane.js?v=1572';
import { buildAAGun, makeAAGun } from './aagun.js?v=1572';

export function spawnPos(team, slot, teamSize) {
  const x = (slot - (teamSize - 1) / 2) * 140;
  const sp = modeField('spawn', null) || { airY: 280, airZ: SPAWN_Z };   // 出生几何来自模式模块
  return new THREE.Vector3(x, sp.airY, team === 0 ? sp.airZ : -sp.airZ);
}
/* 地面载具出生点。
   · 旧地图的点位不带 team → 全部共用（防空车突袭的 7 个炮位）；
   · 坦克对决这种「两队都有地面载具」的地图给每个点位标了 team，按队伍过滤后再取模；
   · y 取地图地形高度（没有地形的地图 = 0，旧行为不变）。 */
export function aagunSpawnPos(slot, aaSpawns, team) {
  let list = (aaSpawns && aaSpawns.length) ? aaSpawns : [{ x: 0, z: 0 }];
  if (team !== undefined && team !== null && list.some((s) => s && s.team !== undefined)) {
    const f = list.filter((s) => s && s.team === team);
    if (f.length) list = f;
  }
  const s = list[slot % list.length] || { x: 0, z: 0 };
  const gy = (world && world.groundY) ? world.groundY(s.x, s.z) : 0;
  return new THREE.Vector3(s.x, gy, s.z);
}
/* 地面载具血量上限：坦克对决 100（一击必杀靠穿甲弹规则，不靠血厚），其它模式沿用 150 */
function groundHpOf() { return modeField('groundHp', AAGUN_HP); }

/* ================= 死斗重生点（v3.15）：不能在敌人旁边复活 =================
   蹲出生点是最容易被利用的规则漏洞：固定点复活 = 一睁眼就和对面对撞。
   做法是在一组候选点里挑「离最近敌人最远」的那个（水平距离，垂直差不算——同高度才算贴脸）。
   敌人位置的来源必须包含**本地玩家**：房主/客户端自己的实体不在 planes/aaguns 字典里。
   找不到敌人时天然返回第一个候选点（pickFarthest 的 bestD 初值 -Infinity）。 */
function enemyGroundPositions(team) {
  const out = [];
  if (myTeam !== team) {
    if (meIsAAGun) { if (myAAGun && meAAGun && meAAGun.alive) out.push(myAAGun.group.position); }
    else if (myPlane && me && me.alive) out.push(myPlane.group.position);
  }
  for (const id in planes) if (planes[id].alive && planes[id].team !== team) out.push(planes[id].plane.group.position);
  for (const id in aaguns) if (aaguns[id].alive && aaguns[id].team !== team) out.push(aaguns[id].aagun.group.position);
  return out;
}
function pickFarthest(cands, team) {
  const foes = enemyGroundPositions(team);
  let best = cands[0], bestD = -Infinity;
  for (const c of cands) {
    let d = Infinity;
    for (const f of foes) d = Math.min(d, Math.hypot(c.x - f.x, c.z - f.z));
    if (d > bestD) { bestD = d; best = c; }
  }
  return best;
}
// 空中单位（飞机 / 直升机）：在己方空域前后各拉开一档 + 左右错开，尽量远离所有敌人
export function safeSpawnPos(team, slot, teamSize) {
  const sp = modeField('spawn', null) || { airY: 280, airZ: SPAWN_Z };
  const baseZ = team === 0 ? sp.airZ : -sp.airZ;
  const cands = [];
  for (const f of [1, 0.85, 1.15]) {
    for (let k = -2; k <= 2; k++) {
      const x = (slot - (teamSize - 1) / 2) * 140 + k * 150;
      cands.push(new THREE.Vector3(x, sp.airY, baseZ * f));
    }
  }
  return pickFarthest(cands, team);
}
// 地面单位（防空车）：在预设炮位里挑离敌机最远的那个
export function safeAAGunSpawn(team, slot, aaSpawns) {
  let list = (aaSpawns && aaSpawns.length) ? aaSpawns : [{ x: 0, z: 0 }];
  /* 点位带 team 的地图（坦克对决）：先按队伍过滤，死斗重生不会落到对面出生区 */
  if (list.some((s) => s && s.team !== undefined)) {
    const f = list.filter((s) => s && s.team === team);
    if (f.length) list = f;
  }
  const cands = list.map((s) => new THREE.Vector3(s.x, (world && world.groundY) ? world.groundY(s.x, s.z) : 0, s.z));
  return pickFarthest(cands, team);
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
  const buildG = modeField('buildGround', null) || buildAAGun;
  const makeG = modeField('makeGround', null) || makeAAGun;
  const ag = buildG(color); scene.add(ag.group);
  const ent = makeG(ag);
  aaguns[peerId] = {
    id: peerId, aagun: ag, ent, team, slot,
    alive: true, hp: groundHpOf(),
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
  /* 地面载具模型/实体也交给模式：坦克对决用 buildTank，其它模式留空 = 防空车。
     groundBoth = 两队都开地面载具（坦克对决）；否则按 groundTeam 单边判定（防空车/直升机突袭）。 */
  const _buildGround = modeField('buildGround', null) || buildAAGun;
  const _makeGround = modeField('makeGround', null) || makeAAGun;
  const _groundBoth = !!modeField('groundBoth', false);
  if (_groundBoth || modeField('groundTeam', null) === myR.team) {   // 本模式里「开地面载具」的阵营
    // 玩家是地面载具阵营
    setMeIsAAGun(true);
    setMyAAGun(_buildGround(0x3fa7ff)); scene.add(myAAGun.group);
    setMeAAGun(_makeGround(myAAGun));
    myAAGun.group.position.copy(aagunSpawnPos(myR.slot, aaSpawns, myR.team));
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
    if (_groundBoth || modeField('groundTeam', null) === p.team) {
      const unit = makeAAGunUnit(p.peerId, p.team, p.slot, color);
      unit.aagun.group.position.copy(aagunSpawnPos(p.slot, aaSpawns, p.team));
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
