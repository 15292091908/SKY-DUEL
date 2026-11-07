// js/netev.js — 联机事件路由 + 网络发送层（v3.4.1 从 main.js 抽出）
// 星型「房主小世界」：所有消息直达房主（或房主直达所有人）；state 通道 20Hz 快照、event 通道可靠有序。
// 房主权威结算（血量/死亡/回合/比分）也在这两个路由里完成。
import * as THREE from 'three';
import { modeDefaultMap, modeField, modeMeta } from './mode.js?v=1543';   // 「游戏内」模式模块（默认地图 / 模式钩子）
import {
  STATE, planes, aaguns, nets, roster, mode, gamemode, iAmHost, myPeerId, myTeam, mySlot,
  me, myPlane, myAAGun, meAAGun, meIsAAGun, hostPeerId, hitSettled, pingProbe,
  lastEventSeq, lastUpdSeq, lastSyncSeq, pickSelections, pickPhase, pickRound, pickDealPending,
  mapLobbyTimerId, sbRows, setSbRows, setKillCount, setLastDmgFrom, setHostPeerId, setRoster,
  setNetSize, setGamemode, setPickPhase, setPickRound, setMyPickSide, setMapLobbyTimerId,
  setMyTeam, setMySlot, netSize, myName, hostNameHint, crashPairs,
} from './state.js?v=1543';
import { BASE_DMG, HIT_TOLERANCE, PING_SAMPLES, BULLET_MUZZLE, ROCKET_AVG_SPEED, DM_KILL_TARGET_MIN as DM_KT_MIN, DM_KILL_TARGET_MAX as DM_KT_MAX } from './config.js?v=1543';
import { cleanName } from './net.js?v=1543';   // 加入方名字清洗（hello 自带名字，防止只靠 SDP 名字时丢失）
import { effects, audio, scene } from './core.js?v=1543';
import { $, banner, subBanner, menuToast, showPart, matchPanel, matchTitle, matchSub, updateScore, addKillFeed } from './hud.js?v=1543';
import {
  checkRoundEnd, syncScoreFromWorld, spawnBullet, spawnRocketFx, presentHit, tmpHitPos, hostSettleHit,
  applyPeerDamage, applyMatchEnd, teamAliveCount, markCrashPair, applyMeAAGunDamage, applyMeDamage,
  selfDestruct, selfDestructAAGun, peerDie, applyRespawnLocal, teamOf,
} from './combat.js?v=1543';
import { hideAllPanels, showMenuBox, startMapLobby } from './lobby.js?v=1543';
import { ledgerOf } from './combat.js?v=1543';
import { sideLabelOf, upsertRoster, setupPickUI, returnToLobby, resetPickCounts } from './pick.js?v=1543';
import { onVoiceMsg, voiceDropPeer } from './voice.js?v=1543';
import { clearKillcam } from './killcam.js?v=1543';
import { renderScoreboard } from './scores.js?v=1543';
import { rebuildWorld } from './scene3d.js?v=1543';
// ---- 本模块私有状态（原 main.js 顶部声明） ----
let stateSeq = 0, eventSeq = 0;   // 广播消息序号（接收方去重）
let lastREndShown = -1;           // 非房主：已提示过回合结果的局号（防 rEnd 重放导致重复横幅）
let rnMismatchT = 0;              // 非房主：房主快照回合序号持续落后本端的起始时刻（看门狗自愈用）

/* v3.12：加入方「等房主开战」兜底定时器。
   事件通道本身是可靠有序的（SCTP 重传，等价 TCP），消息不会丢；
   真正会卡死的是「处理函数抛异常」——例如 go 分支里 rebuildWorld/buildAllUnits 抛错，
   beginMatch 就没执行，而事件通道还活着、onPeerClose 永远不触发 → 本端永久停在无提示界面。
   所以这里补一条时间轴兜底：到点还没开局就提示并回菜单（不再需要刷新页面）。 */
function armGoWatchdog(ms, text) {
  clearTimeout(mapLobbyTimerId);
  setMapLobbyTimerId(setTimeout(() => {
    if (STATE.started) return;
    menuToast(text || '等待房主开战超时，请重新加入房间', '#ff7a6b', 4);
    setTimeout(() => backToMenu(), 1800);
  }, ms));
}
function clearGoWatchdog() { clearTimeout(mapLobbyTimerId); setMapLobbyTimerId(null); }

// main.js（循环依赖：仅运行时函数调用 / 只读共享）
import { deathPos, setFiring, setPingMs } from './loop.js?v=1543';
import { nextRound, applyRematch } from './match.js?v=1543';
import { beginMatch, updateHostStatus, hostPingCheck, isKickedPeer, resetSdpState } from './sdp.js?v=1543';
import { backToMenu } from './reset.js?v=1543';   // 软重置（回菜单不刷新）

/* ================= 联机事件路由 ================= */
/* 远程火箭 / 炸弹重建（房主转发与客户端接收共用）：
   炸弹（d.bomb）交给当前模式包的 spawnRemoteBomb —— 它的物理与本机投弹一致（继承速度/重力/半径）；
   模式包没提供时退化为普通火箭特效，至少不会消失。 */
function spawnRemoteProjectile(d, src) {
  if (d.bomb) {
    const spawnBomb = modeField('spawnRemoteBomb', null);
    if (spawnBomb) return spawnBomb(d.o, d.d, d.v, d.g, d.br, d.lr, d.life);
  }
  return spawnRocketFx(new THREE.Vector3().fromArray(d.o), new THREE.Vector3().fromArray(d.d).normalize(), src);
}

export function onPeerState(peerId, d) {
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
      // ★ v3.12：必须走 peerDie 统一死亡出口。旧版直接置 alive=false + checkRoundEnd，
      //   绕过了 recordAuthKill —— 等对方的 'died' 到达时，peerDie 因 alive 已是 false 直接 return，
      //   于是这条死亡不进台账（阵亡少算）、也不广播「X 坠毁」。
      if (pl.alive && !STATE.roundOver && d.p[1] <= 0.9) {
        setLastDmgFrom(null);   // 环境死亡：无击杀者
        peerDie(rid);
        setLastDmgFrom(null);
      }
      return;
    }
    const ag = aaguns[rid];
    if (ag) {
      ag.tPos.fromArray(d.p);
      if (typeof d.ty === 'number') { ag.tTurretYaw = d.ty; ag.tTurretPitch = d.tp || 0; }
      if (typeof d.by === 'number') ag.tBodyYaw = d.by;
      ag.lastState = now;
      // 防空车出海（>430）房主权威判死（同上：走 peerDie 才能记账/播报）
      if (ag.alive && !STATE.roundOver && Math.hypot(d.p[0], d.p[2]) > 430) {
        setLastDmgFrom(null);
        peerDie(rid);
        setLastDmgFrom(null);
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
    const nowSync = performance.now();
    for (const it of lst) {
      if (it.id === myPeerId) {
        /* 死斗重生宽限（v3.15）：重生那一刻，state 通道里可能还有"死亡瞬间"的旧快照在途
           （state 通道不可靠、不保序）。旧版会据此立刻再判我一次死亡 → 刚复活就原地爆炸。
           重生后 1.2 秒内整条跳过（位置本来就是我们刚设的，血量下一帧就会被新快照拉满）。 */
        if (nowSync - (STATE.respawnAt || 0) < 1200) continue;
        // 自己的血量/存活/位置以房主小世界为准（v3.0：直接采用权威值，客户端不做本地预判，
        // 血量另有 'hit' 事件即时下发，sync 只做丢包兜底）
        if (meIsAAGun) {
          if (meAAGun) {
            meAAGun.hp = it.hp;
            if (!it.al && meAAGun.alive && !STATE.roundOver) { meAAGun.alive = false; deathPos.copy(myAAGun.group.position); deathPos.y += 2; effects.explosion(deathPos, 1.6); audio.explosionAt(deathPos); myAAGun.group.visible = false; }
          }
        } else if (me) {
          me.hp = it.hp;
          if (!it.al && me.alive && !STATE.roundOver) { me.alive = false; deathPos.copy(myPlane.group.position); effects.explosion(deathPos, 1.4); audio.explosionAt(deathPos); myPlane.group.visible = false; }
        }
      } else {
        const pl = planes[it.id];
        if (pl) {
          if (nowSync - (pl.respawnAt || 0) < 1200) continue;   // 死斗重生宽限（同上，远端实体版本）
          pl.tPos.fromArray(it.p);
          if (it.q) pl.tQuat.set(it.q[0], it.q[1], it.q[2], it.q[3]);
          pl.hp = it.hp;   // v3.0：权威血量直接覆盖（无预判挂账）
          if (!it.al && pl.alive && !STATE.roundOver) { pl.alive = false; effects.explosion(pl.plane.group.position, 1.4); audio.explosionAt(pl.plane.group.position); pl.plane.group.visible = false; }
          continue;
        }
        const ag = aaguns[it.id];
        if (ag) {
          if (nowSync - (ag.respawnAt || 0) < 1200) continue;   // 死斗重生宽限（地面单位版本）
          ag.tPos.fromArray(it.p);
          if (typeof it.ty === 'number') { ag.tTurretYaw = it.ty; ag.tTurretPitch = it.tp || 0; }
          if (typeof it.by === 'number') ag.tBodyYaw = it.by;
          ag.hp = it.hp;   // v3.0：同上
          if (!it.al && ag.alive && !STATE.roundOver) { ag.alive = false; effects.explosion(ag.aagun.group.position, 1.6); audio.explosionAt(ag.aagun.group.position); ag.aagun.group.visible = false; }
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
      if (d.over !== undefined && d.over !== STATE.roundOver) { STATE.roundOver = d.over; if (d.over) setFiring(false); }
      syncScoreFromWorld();
    }
    return;
  }
}
/* 载具速度（v3.18 统一模型）：报文里是可选的 iv=[x,y,z]，即发射瞬间载具的**完整**世界速度。
   接收端 v(0) = dir·s + iv，与射手端逐帧一致；静止发射时为 0 → 报文不带这个字段。
   非法值一律当 0 处理；范围夹紧在 spawnBullet 里（BULLET_INHERIT_MAX=200）。 */
const _ivTmp = new THREE.Vector3();
function inheritVec(d) {
  const a = d && d.iv;
  if (!a || a.length < 3) return null;
  const x = +a[0], y = +a[1], z = +a[2];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  if (x === 0 && y === 0 && z === 0) return null;
  return _ivTmp.set(x, y, z);
}
export function onPeerEvent(peerId, d) {
  const rid = d.sender || peerId;
  // 广播类消息（带 seq）去重：直连+转发双通道可能重复到达
  if (d.seq !== undefined) {
    if (d.seq <= (lastEventSeq[rid] || 0)) return;
    lastEventSeq[rid] = d.seq;
  }
  switch (d.t) {
    /* ---- 房主：非房主开火 → 重建子弹特效并广播（v3.0：子弹只是特效，房主不判定伤害） ---- */
    case 'fire': {
      if (!iAmHost || STATE.roundOver) break;   // 回合已结束：不再生成子弹特效
      const o = new THREE.Vector3().fromArray(d.o);
      const dir = new THREE.Vector3().fromArray(d.d).normalize();
      const cv = inheritVec(d);
      const b = spawnBullet(o, dir, d.s || BULLET_MUZZLE, 'foeVis', d.dm || BASE_DMG, d.sl || 0, cv);
      // 记下归属（射手 + fid）：命中广播到达时各端据此移除对应弹道特效
      if (b) { b.fid = d.fid || 0; b.fFrom = rid; }
      netBroadcast({ t: 'blt', o: d.o, d: d.d, from: rid, fid: d.fid, s: d.s, dm: d.dm, sl: d.sl, iv: d.iv });
      effects.muzzle(o);
      // 他方开火声（v3.14.1）：用合速度算多普勒，与真实弹道一致
      { const sp = d.s || BULLET_MUZZLE; audio.enemyShootAt(o, { x: dir.x * sp + (cv ? cv.x : 0), y: dir.y * sp + (cv ? cv.y : 0), z: dir.z * sp + (cv ? cv.z : 0) }); }
      break;
    }
    case 'fireRocket': {
      // 房主：非房主发射火箭/投弹 → 重建弹道特效并广播（命中由发射者判定，房主只做位置校验）
      if (!iAmHost || STATE.roundOver) break;
      const r = spawnRemoteProjectile(d, 'foeVis');
      if (r) { r.fid = d.fid || 0; r.fFrom = rid; }
      netBroadcast(d.bomb
        ? { t: 'rkt', o: d.o, d: d.d, from: rid, fid: d.fid, bomb: 1, v: d.v, g: d.g, br: d.br, lr: d.lr, life: d.life }
        : { t: 'rkt', o: d.o, d: d.d, from: rid, fid: d.fid });
      if (!d.bomb) {
        const o0 = new THREE.Vector3().fromArray(d.o);
        const d0 = new THREE.Vector3().fromArray(d.d).normalize();
        effects.muzzle(o0);
        audio.enemyLaunchAt(o0, { x: d0.x * ROCKET_AVG_SPEED, y: d0.y * ROCKET_AVG_SPEED, z: d0.z * ROCKET_AVG_SPEED });
      }
      break;
    }
    case 'rkt': {
      // 房主广播的火箭/炸弹（含房主自己的）：本地只显示弹道特效；发射者本人已有本地实体，跳过
      if (iAmHost || d.from === myPeerId) break;
      const r = spawnRemoteProjectile(d, 'foeVis');
      if (r) { r.fid = d.fid || 0; r.fFrom = d.from || null; }
      if (!d.bomb) {
        const o0 = new THREE.Vector3().fromArray(d.o);
        const d0 = new THREE.Vector3().fromArray(d.d).normalize();
        effects.muzzle(o0);
        audio.enemyLaunchAt(o0, { x: d0.x * ROCKET_AVG_SPEED, y: d0.y * ROCKET_AVG_SPEED, z: d0.z * ROCKET_AVG_SPEED });
      }
      break;
    }
    case 'blt': {
      // 房主广播的子弹（含房主自己的）：本地只做特效显示（v3.0 不判定伤害）；开火者本人已有本地子弹，跳过
      if (iAmHost || d.from === myPeerId) break;
      const o = new THREE.Vector3().fromArray(d.o);
      const dir = new THREE.Vector3().fromArray(d.d).normalize();
      const cv = inheritVec(d);
      const b = spawnBullet(o, dir, d.s || BULLET_MUZZLE, 'foeVis', d.dm || BASE_DMG, d.sl || 0, cv);
      if (b) { b.fid = d.fid || 0; b.fFrom = d.from || null; }
      effects.muzzle(o);
      // 敌方开火（v3.14）：传世界坐标 + 弹丸合速度矢量 → 按声速延迟 + 多普勒音高
      { const sp = d.s || BULLET_MUZZLE; audio.enemyShootAt(o, { x: dir.x * sp + (cv ? cv.x : 0), y: dir.y * sp + (cv ? cv.y : 0), z: dir.z * sp + (cv ? cv.z : 0) }); }
      break;
    }
    case 'hitReject': {
      // 房主拒绝本次上报。两种情况分开说：目标已被击毁（同时抢人头输了）/ 位置校验不通过。
      if (iAmHost) break;
      showPart(d.dead ? '目标已被击毁 · 未造成伤害' : '位置校验未通过 · 未造成伤害');
      break;
    }
    case 'hit': {
      // 房主权威命中：所有端据此放命中/受击特效、更新血量、处理死亡（含被打者的受击扣血）
      if (iAmHost) break;   // 房主本地结算时已自行处理（射手/目标/旁观三种角色都在 hostSettleHit 内覆盖）
      presentHit(d);
      break;
    }
    case 'kick': {
      // 被房主移出房间（v3.0 延迟门槛）：提示后回主菜单
      if (iAmHost) break;
      const why = d.reason === 'ping' ? ('网络延迟过高（' + (d.ms | 0) + ' ms），已被移出房间') : '已被移出房间';
      menuToast(why + '，请检查网络后重新加入', '#ff7a6b', 5);
      STATE.matchEnded = true;   // 冻结对局逻辑，避免继续上报
      setTimeout(() => backToMenu(), 2600);   // v3.11.2：软重置回菜单（不再刷新页面）
      break;
    }
    case 'modeMismatch': {
      // 房主拒绝：两端玩法不一致（房主模式 ≠ 加入方模式），不允许进入对局
      if (iAmHost) break;
      const nm = (id) => { const m = modeMeta(id); return m ? m.name : (id || '未知玩法'); };
      menuToast('玩法不一致：房主开的是「' + nm(d.host) + '」，你选的是「' + nm(d.mine) + '」，无法进入房间', '#ff7a6b', 7);
      STATE.matchEnded = true;   // 冻结对局逻辑，避免继续上报
      setTimeout(() => backToMenu(), 3200);   // v3.11.2：软重置回菜单
      break;
    }
    case 'hitRep': {
      // v3.0 客户端判定：开火者上报"我打中了谁 / 部位 / 目标当时的位置"。
      // 房主只做位置合理性校验（HIT_TOLERANCE 内即采信）→ 权威扣血 → 广播 hit。
      if (!iAmHost || mode === 'practice' || STATE.roundOver) break;
      if (!d.fid || !d.id) break;
      const fkey = rid + ':' + d.fid + ':' + d.id;   // 复合键：fid 各玩家独立计数；尾缀目标 → 溅射可命中多辆车
      if (hitSettled.has(fkey)) break;  // 同一发子弹对同一目标只结算一次（防重复上报/重发）
      // 目标权威位置（房主小世界）；目标已死/不存在 → 拒绝
      let tgtPos = null;
      if (d.id === myPeerId) {
        if (meIsAAGun) { if (meAAGun && meAAGun.alive) tgtPos = myAAGun.group.position; }
        else if (me && me.alive) tgtPos = myPlane.group.position;
      } else if (planes[d.id] && planes[d.id].alive) tgtPos = planes[d.id].plane.group.position;
      else if (aaguns[d.id] && aaguns[d.id].alive) tgtPos = aaguns[d.id].aagun.group.position;
      if (!tgtPos) { netSendEventTo(rid, { t: 'hitReject', fid: d.fid, dead: 1 }); break; }   // 目标已被别人打死：不是位置问题
      const pRep = tmpHitPos.fromArray(d.p || [0, 0, 0]);
      if (tgtPos.distanceTo(pRep) > HIT_TOLERANCE) {   // 位置严重不符（错目标/瞬移/改包）→ 拒绝本次命中
        netSendEventTo(rid, { t: 'hitReject', fid: d.fid, far: 1 });
        break;
      }
      hitSettled.set(fkey, performance.now());
      hostSettleHit(rid, d.id, d.part, !!d.splash, d.dmg, d.p, d.fid, d.df);
      break;
    }
    case 'envDmg': {
      // 非房主环境伤害上报（撞地/出界），房主权威扣血（sync 确认后本地预判生效）
      if (!iAmHost || mode === 'practice') break;
      const dm = Math.max(1, Math.min(20, d.dmg | 0));
      if (rid && rid !== myPeerId) { setLastDmgFrom(null); applyPeerDamage(rid, dm); }   // 环境伤害：无击杀者
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
    /* ---- 设置阵营（房主手动分配；玩家端只等待） ---- */
    case 'pickStart': {
      if (iAmHost || STATE.started) break;
      setPickRound(d.round || 0);
      setMyPickSide(-1);
      resetPickCounts();                // 玩家端计数清零（原 curPickC0/1 复位，计数已迁 pick.js）
      // 进入设置阵营：大厅那条「主机未响应」兜底作废（房主端另有 45s 主动取消），
      // 但必须重新挂一条更长的兜底 —— 旧版只 clear 不重挂，房主此时冻住/掉线就永久卡在等待页。
      armGoWatchdog(60000, '房主长时间未开战，请重新加入房间');
      setupPickUI();                    // 玩家端只显示"等待房主设置阵营…"
      hideAllPanels();
      $('pickPanel').classList.remove('hidden');
      break;
    }
    case 'pickList': {
      // 房主定向分配结果：对"我"的视角 —— 谁是队友、谁是对手（玩家端不持有完整名单）
      if (iAmHost || STATE.started) break;
      if (d.round !== undefined && d.round !== pickRound) break;   // 旧编号：丢弃
      setPickRound(d.round !== undefined ? d.round : pickRound);
      setMyTeam(d.team === 1 ? 1 : 0);
      setMyPickSide(myTeam);
      setMySlot(d.slot || 0);
      upsertRoster(myPeerId, myTeam, mySlot);
      for (const m of (d.m || [])) upsertRoster(m[0], myTeam, m[1]);
      for (const f of (d.f || [])) upsertRoster(f[0], 1 - myTeam, f[1]);
      hideAllPanels();
      menuToast('你的阵营：' + sideLabelOf(myTeam), '#ffd76b', 2.6);   // 菜单阶段可见（banner 在隐藏的 HUD 里）
      /* ★ v3.12 延迟与渲染分离的唯一渲染点：
         走到这里说明房主已经「人齐 + 全员延迟达标」（房主要先 startMapLobby 才能进选阵营），
         所以此刻建世界不会污染任何人的延迟采样。
         3v3/5v5 凑人途中连上的人只测延迟、不建世界；最后一人没过延迟测试就永远走不到这里。 */
      rebuildWorld(modeDefaultMap('base'));   // 本模式默认地图（来自模式模块）
      armGoWatchdog(15000, '开战超时，请重新加入房间');   // 房主 2.5s 后发 go；15s 还没开局就兜底回菜单
      break;
    }
    case 'pickCancel': {
      // 房主放弃本轮设置（有人掉线 / 45s 未完成）：提示后全员回大厅
      if (iAmHost || STATE.started) break;
      setPickPhase(false); for (const k in pickSelections) delete pickSelections[k]; setMyPickSide(-1);
      menuToast(d.msg || '有人掉线，全员回大厅', '#ffd76b', 3.2);   // 菜单阶段 HUD 隐藏，banner 看不见
      hideAllPanels();
      showMenuBox();                                   // 大厅面板在 menuBoxBody 内，必须恢复容器才可见
      $('mapLobbyPanel').classList.remove('hidden');
      $('lobbyRePickRow').classList.add('hidden');
      $('mapLobbyStatus').textContent = '等待主机重新开始…';
      // 回大厅后同样要兜底：主机若一直不动作，提示重连（否则玩家永久停在等待页）
      armGoWatchdog(60000, '主机长时间未响应，请重新加入');
      break;
    }
    case 'go': {
      if (iAmHost || STATE.started) break;
      /* v3.12：整段包 try/catch。
         事件通道是可靠有序的（不会丢包），但处理函数抛异常一样会让逻辑停在半路：
         旧版 rebuildWorld 找不到地图（模式包没加载完 / 两端版本不一致）就直接抛出，
         beginMatch 不执行 → 本端永久停在无提示界面，而房主那边已经开局（1v0 空房间）。
         现在：抛错就提示并软重置回菜单（顺带断开连接，房主看到掉落会正常结束这局）。 */
      try {
        clearGoWatchdog();
        if (d.map) rebuildWorld(d.map);
        beginMatch();
      } catch (e) {
        console.error('[net] 开战失败：', e);
        menuToast('开战失败：' + (e && e.message ? e.message : e) + '，已返回菜单', '#ff7a6b', 5);
        setTimeout(() => backToMenu(), 1600);
      }
      break;
    }
    case 'died': if (iAmHost && d.id && d.id !== myPeerId) { setLastDmgFrom(null); peerDie(d.id); } break;   // 自毁/环境死上报：无击杀者
    case 'kill':
      // 房主权威击杀播报（右上角白字）：谁击败了谁（名字由房主解析好直接带上）
      if (iAmHost || mode === 'practice') break;
      addKillFeed(d.k || null, d.v, d.kn, d.vn, !!d.ff, !!d.sk);   // v3.5.1：误杀队友「误杀」；v3.5.4：自炸「误伤」（sk）
      /* 死斗比分（v3.15）：房主在 recordAuthKill 里已经加过分，这里同步跟上做即时反馈；
         下一次 sync 会用权威 s0/s1 覆盖，所以丢包/重复都不会把比分带偏。 */
      if (STATE.matchType === 'dm' && d.k && !d.ff && !d.sk) {
        const kt = teamOf(d.k);
        if (kt === 0) STATE.s0++; else if (kt === 1) STATE.s1++;
        syncScoreFromWorld();
      }
      break;
    case 'feed':
      // 房主广播的系统播报（v3.14.3：xxx 离开了房间）——复用击杀播报区，房主本地已播过
      if (iAmHost || mode === 'practice') break;
      if (d.kind === 'left') addKillFeed(null, null, undefined, d.name || '一名玩家', false, false, '离开了房间');
      break;
    case 'kstat':
      // 房主权威击杀台账（3s 定向下发）：覆盖本地预判计数——预判 +1 只做即时反馈，最终以台账为准
      // （本地子弹被 dmgReject 否决时，击杀数在 ≤3s 内自动纠正，不再只增不减）
      if (iAmHost || mode === 'practice') break;
      if (typeof d.k === 'number') setKillCount(Math.max(0, d.k | 0));
      break;
    case 'hello': {
      // 加入方上报真实 ID：主机把本地连接 key 迁移为真实 peerId 并分配阵营
      if (!iAmHost) break;
      const key = peerId;                 // 主机侧连接 key（如 'foe_0'）
      const realId = d.id;                // 加入方真实 peerId
      // ★ 玩法一致性（v3.11.0）：air / aavs / heli 是三个独立模式包（实体、钩子、地图、弱点全不同），
      //   两端不一致时继续进房会出现实体对不上/钩子缺失的诡异错误 —— 直接拒绝，不进 roster。
      if (d.gm && d.gm !== gamemode) {
        const n = nets[key];
        if (n && n.connected) n.sendEvent({ t: 'modeMismatch', host: gamemode, mine: d.gm, sender: myPeerId });
        const nm = (id) => { const m = modeMeta(id); return m ? m.name : (id || '未知玩法'); };
        menuToast('已拒绝一名玩家：他玩的是「' + nm(d.gm) + '」，本房间是「' + nm(gamemode) + '」', '#ffd76b', 4);
        setTimeout(() => { try { if (n && n.pc) n.pc.close(); } catch (e) {} }, 600);
        break;
      }
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
        /* 加入方名字（v3.14.3）：三条来源依次兜底 ——
           ① hello 报文里自带的 name（最可靠：信令/手动交换任何一条链路出问题都不影响）；
           ② 应答码里解出的 remoteName（旧版代码只有这条）；
           ③ 空串（后续 roster 广播会把它显示成「未知玩家」）。
           此前只靠 ②：公共 MQTT 的 join 报文是 QoS0，首发丢包后 signal.js 的重发
           用的是空名字 → 房主只收到空名 → 全场都显示「未知玩家」。 */
        entry.name = cleanName(d.name) || (nets[key] && nets[key].remoteName) || '';
        // nets 字典 key 从 'foe_N' 迁移为真实 ID，回调也同步
        if (nets[key] && key !== realId) { nets[realId] = nets[key]; nets[realId].peerKey = realId; delete nets[key]; }
        netSendEventTo(realId, { t: 'team', team, slot, hostTeam: myTeam, hostSlot: mySlot, myId: myPeerId, gamemode, hn: myName || '', mt: STATE.matchType, kt: STATE.killTarget });
        broadcastRoster();
        updateHostStatus();
        hostPingCheck(realId);   // v3.0 延迟门槛：连接建立后立刻采样 RTT，超限直接移出房间
      }
      break;
    }
    case 'team': {
      // 主机分配阵营：设置自己的 team/slot，并记录主机(房主)的真实 ID 与阵营
      setMyTeam(d.team); setMySlot(d.slot);
      // 对局规则（v3.15）：歼灭 / 死斗 + 死斗击杀目标，以房主为准
      if (d.mt) STATE.matchType = d.mt === 'dm' ? 'dm' : 'elim';
      if (d.kt) STATE.killTarget = Math.max(DM_KT_MIN, Math.min(DM_KT_MAX, d.kt | 0));
      // 同步主机的玩法（加入方可能以不同玩法的界面加入，一律以房主为准）
      if (d.gamemode) {
        setGamemode(d.gamemode);
        // 已进 lobby 面板时修正文案（防空车 ↔ 空战双向）
        if (STATE.mapFinalized && !STATE.started && !iAmHost) {
          // ★ v3.12 延迟与渲染分离：这里**不再 rebuildWorld**。
          //   房主紧接着就会对本端做延迟采样（hostPingCheck 紧跟 team 发出），
          //   而 rebuildWorld 单次实测阻塞主线程 120~230ms（手机更久）→ pong 被卡住 → RTT 虚高 → 被误踢。
          //   世界统一推迟到「全员延迟达标」之后的第一帧（pickList）再建，见下面 pickList 分支。
          $('mapLobbyTitle').textContent = '等待主机选择地图';
          $('mapLobbyStatus').textContent = '正在等待主机选择地图…';
          $('lobbyMapChoice').style.display = 'none';
        }
      }
      let self = roster.find(p => p.peerId === myPeerId);
      if (!self) { roster.push({ peerId: myPeerId, team: d.team, slot: d.slot, name: myName || '' }); }
      else { self.team = d.team; self.slot = d.slot; self.name = myName || self.name || ''; }
      const hostId = d.myId || rid;
      setHostPeerId(hostId);   // 记录房主真实 ID（mesh 建连与定向路由需要）
      let host = roster.find(p => p.peerId === hostId);
      // 房主名字（v3.14.3）：team 报文里的 hn 最可靠；其次信令信标带回的 hostNameHint；
      // 最后退回连接层从邀请码里解出的 remoteName —— 三条都没有才是空名。
      const hostNm = (d.hn && String(d.hn)) || hostNameHint || (nets[myPeerId] && nets[myPeerId].remoteName) || '';
      if (!host) { roster.push({ peerId: hostId, team: d.hostTeam, slot: d.hostSlot || 0, name: hostNm }); }
      else { host.team = d.hostTeam; host.slot = d.hostSlot || 0; if (!host.name) host.name = hostNm; }
      // 迁移直连 nets key：从自己的 myPeerId 改为房主真实 ID（定向消息才能路由）
      if (nets[myPeerId] && hostId && hostId !== myPeerId) {
        nets[hostId] = nets[myPeerId];
        nets[hostId].peerKey = hostId;
        delete nets[myPeerId];
      }
      // ★ v3.12 延迟与渲染分离：这里原来会 rebuildWorld(默认地图) 当大厅背景。
      //   但这条消息紧跟着就是房主的延迟采样（team → hostPingCheck 同帧发出），
      //   在世界里建几百个网格会把 pong 卡住几百毫秒 → RTT 采样虚高 → 好友被误判「延迟过高」踢掉。
      //   大厅背景本来就有（进页面时 showMenuScene 已建好世界），完全不需要在这里重建。
      if (!STATE.started) startMapLobby();
      break;
    }
    case 'cfg': {
      // 房主改对局规则 / 开局前再对齐一次（v3.15）：team 报文丢包时靠这条兜底
      if (iAmHost) break;
      STATE.matchType = d.mt === 'dm' ? 'dm' : 'elim';
      if (d.kt) STATE.killTarget = Math.max(DM_KT_MIN, Math.min(DM_KT_MAX, d.kt | 0));
      break;
    }
    case 'respawn': {
      // 死斗：房主调度重生（重生点已由房主按"远离敌人"选好）→ 复原自己或远端副本
      if (iAmHost) break;
      if (!d.id || !d.p) break;
      applyRespawnLocal(d.id, d.p, typeof d.y === 'number' ? d.y : 0);
      break;
    }
    case 'roster':
      setRoster(d.roster);
      /* v3.12：房间规模以房主为权威（d.ns），不要用 roster.length 反推。
         掉线后房主会 setNetSize(roster.length) 并重发名单，加入方必须拿到同一个数，
         否则 nextRound 里 spawnPos(team, slot, netSize/2) 两端算出的出生点不一致（开局位置跳变）。 */
      setNetSize(typeof d.ns === 'number' ? d.ns : roster.length);
      break;
    case 'ping':
      // 收到探测（房主发起测延迟 / 非房主周期测延迟）→ 原样回 pong（对端用自己时钟算 RTT）
      if (d.ts) netSendEventTo(rid, { t: 'pong', ts: d.ts });
      break;
    case 'pong':
      if (d.ts) {
        const rtt = Math.max(0, Math.round(performance.now() - d.ts));
        if (iAmHost) {                       // 房主：延迟门槛探测采样（连接建立后 3 次，取最小值）
          const pr = pingProbe[rid];
          if (pr && pr.samples.length < PING_SAMPLES) pr.samples.push(rtt);
        } else setPingMs(rtt);               // 非房主：HUD 延迟显示
      }
      break;
    case 'rematch': applyRematch(); break;
    case 'scoreboard':
      // 房主权威战绩表（比赛结束广播）：全队同表，按净击杀排名
      if (iAmHost) break;
      setSbRows(d.rows || []);
      renderScoreboard(sbRows);
      break;
    case 'crash':
      // 碰撞权威结算（房主小世界）：非房主检测到碰撞后上报，房主统一裁决（不复核距离——碰撞是各端本地判定）
      // fatal=同归于尽（现在是唯一路径：飞机互撞不分敌我 / 撞防空车）；
      // dmg 分支保留仅为兼容旧版本客户端（v0.3.14 起友军相撞也走 fatal）
      if (!iAmHost || !d.target) break;
      if (!markCrashPair(d.sender, d.target)) break;   // 双方各自检测并各自上报，只结算一次
      if (d.dmg) {
        // 轻撞互扣：击杀归因为对方（碰撞致死同样计入台账）
        if (d.sender && d.sender !== myPeerId) { setLastDmgFrom(d.target); applyPeerDamage(d.sender, d.dmg); setLastDmgFrom(null); }
        if (d.target === myPeerId) { setLastDmgFrom(d.sender); if (meIsAAGun) applyMeAAGunDamage(d.dmg); else applyMeDamage(d.dmg); setLastDmgFrom(null); }
        else { setLastDmgFrom(d.sender); applyPeerDamage(d.target, d.dmg); setLastDmgFrom(null); }
      } else if (d.fatal) {
        if (d.target === myPeerId) {
          setLastDmgFrom(d.sender);   // 是对方撞的我
          if (meIsAAGun) { if (meAAGun && meAAGun.alive) selfDestructAAGun(); }
          else if (me && me.alive) selfDestruct();
          setLastDmgFrom(null);
          if (d.sender && d.sender !== myPeerId) { setLastDmgFrom(myPeerId); peerDie(d.sender); setLastDmgFrom(null); }   // 同归于尽：我也撞死了对方
        } else {
          setLastDmgFrom(d.sender); peerDie(d.target); setLastDmgFrom(null);          // 上报者撞死了 target
          if (d.sender && d.sender !== myPeerId) { setLastDmgFrom(d.target); peerDie(d.sender); setLastDmgFrom(null); }   // target 撞死了上报者
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
export function onPeerOpen() {
  // 星型架构：非房主只与房主直连，无 mesh 握手
}
// 对手断线：清理其实体与 roster，比赛进行中则视为阵亡（触发回合结算），避免对局卡死
export function removePeerLocal(peerId) {
  if (planes[peerId]) { scene.remove(planes[peerId].plane.group); delete planes[peerId]; }
  else if (aaguns[peerId]) { scene.remove(aaguns[peerId].aagun.group); delete aaguns[peerId]; }
  const idx = roster.findIndex(p => p.peerId === peerId);
  if (idx >= 0) roster.splice(idx, 1);
  if (nets[peerId]) { delete nets[peerId]; }
  // 关键：必须同时清掉分配记录 —— 否则发名单时他仍被算进队伍（applyPickTeams 会把他重新
  // 塞回 roster），在所有人眼里变成占位不动的幽灵单位：占出生位，且 teamAliveCount 永远把他
  // 算作存活，回合将永远无法靠"全灭"结束。
  if (pickSelections[peerId] !== undefined) delete pickSelections[peerId];
  voiceDropPeer(peerId);     // 清理该玩家的语音抖动缓冲 + HUD 讲话指示（voice.js）
}
// 断线文案：WebRTC onClose 是双向触发的（自己断网和对端离线都会触发），本端无法百分百归因。
// 唯一可靠判据：navigator.onLine / offline 事件（系统级断网时浏览器自己知道）。
// onLine=true 时也不能断定是对端的问题（路由波动等），文案必须中性提示两种可能，避免误导玩家怪罪对方。
export function lostConnText(peer) {
  if (navigator.onLine === false) return '你的网络连接已断开';
  return peer === 'host'
    ? '与房主的连接已断开（可能是房主离线，也可能是你的网络波动）'
    : '与所有玩家的连接均已断开（可能是你的网络波动，也可能是所有玩家离线）';
}
// 系统级断网即时提示（offline 事件比 WebRTC onClose 更早更准）
window.addEventListener('offline', () => {
  if (mode === 'net') banner('你的网络连接已断开', '#ff7a6b', 3);
});
export function onPeerClose(peerId) {
  const wasInGame = STATE.started && !STATE.matchEnded;
  // 离开播报要在 removePeerLocal 之前取名字 —— 它会把该玩家从 roster 里删掉
  const leftEntry = roster.find(p => p.peerId === peerId);
  const leftName = (leftEntry && leftEntry.name) || '';
  // 房主掉线：star 拓扑的根断了，所有人无法再同步 → 直接结束比赛（判房主队伍负）
  if (!iAmHost && peerId === hostPeerId) {    const hostEntry = roster.find(p => p.peerId === hostPeerId);
    const hostTeam = hostEntry ? hostEntry.team : -1;
    removePeerLocal(peerId);
    if (wasInGame) {
      const iWon = hostTeam < 0 ? true : myTeam !== hostTeam;
      STATE.matchEnded = true; STATE.roundOver = true; setFiring(false);
      matchTitle.textContent = iWon ? '最终胜利' : '惜败';
      matchTitle.style.color = iWon ? '#7CFC98' : '#ff7a6b';
      // 中性归因：无法区分房主离线还是自己断网（详见 lostConnText 注释）
      matchSub.textContent = lostConnText('host') + ' · 比赛提前结束（' + STATE.myScore + ' : ' + STATE.foeScore + '）';
      clearKillcam();   // 死斗：击杀镜头卡片不能压在结算面板上
      $('btnRematch').classList.add('hidden');   // 房主离线无法重赛
      matchPanel.classList.remove('hidden');
      if (document.pointerLockElement) document.exitPointerLock();
    } else {
      // 凑人阶段连接断开：中性归因提示并返回菜单
      banner('连接已断开，即将返回菜单', '#ff7a6b', 3);
      subBanner(lostConnText('host'), 3);
      setTimeout(() => backToMenu(), 2000);
    }
    return;
  }
  // 凑人阶段（非房主只与房主有一条直连，星型拓扑）：任何连接断开都等于房主掉线
  // （覆盖 corner case：team 消息未到、hostPeerId 尚未赋值时房主就掉线，否则非房主会永远卡在大厅）
  if (!iAmHost && !STATE.started) {
    banner('连接已断开，即将返回菜单', '#ff7a6b', 3);
    subBanner(lostConnText('host'), 3);
    setTimeout(() => backToMenu(), 2000);
    return;
  }
  removePeerLocal(peerId);
  if (iAmHost && mode !== 'practice') {
    // 房主广播掉线通知，让其他非房主玩家同步清理（避免幽灵实体）；
    // 同步重算 netSize 并重发 roster（否则选阵营容量/ready 阈值仍按掉线前人数算，会卡死）
    // ★ v3.11.1：主动踢出（延迟不达标）不算掉线 —— 不缩编，房主仍按原定规模等替补；
    //   否则 3v3 少一个人会被压成 2v2 并立刻开局（玩家视角就是「我明明开的 3v3」）
    if (!isKickedPeer(peerId)) setNetSize(Math.max(2, roster.length));
    if (!STATE.started) updateHostStatus();   // 凑人阶段刷新"已连接 x/y"提示
    broadcastRoster();
    netBroadcast({ t: 'peerGone', id: peerId });
    /* v3.14.3：对局中「非房主玩家」掉线 → 击杀播报里播一条「xxx 离开了房间」，并广播给所有人。
       · 房主掉线不走这里（下面 / 上面的非房主分支保持原样）；
       · 主动踢出（延迟不达标）不播 —— 那是房主请人走，sdp.js 已有专属提示；
       · 只在比赛进行中播（大厅里 killFeed 不可见，赛后播报也没有意义）。 */
    if (wasInGame && !isKickedPeer(peerId)) {
      const nm = leftName || '一名玩家';
      addKillFeed(null, null, undefined, nm, false, false, '离开了房间');
      netBroadcast({ t: 'feed', kind: 'left', name: nm });
    }
    // 设置阵营期间有人掉线：本作无重连机制，硬撑下去只会卡住 → 直接提示后全员回大厅重来
    if (pickPhase) {
      // 主动踢出（延迟不达标）不推翻流程：他还没进选人表，移除即可
      if (isKickedPeer(peerId)) { menuToast('一名玩家延迟不达标，已被移出房间', '#ff7a6b', 4); return; }
      if (roster.length <= 1) {   // 只剩房主一人，无从开局
        menuToast('所有玩家已离开，返回主菜单', '#ff7a6b', 3);
        setTimeout(() => backToMenu(), 2000);
        return;
      }
      returnToLobby('有人掉线，全员回大厅');
    } else if (pickDealPending && !STATE.started) {
      // 名单已发、开战倒计时（1.2s）内掉线：不推翻已定名单，只提示人数不足
      banner('有人掉线，本局人数不足，仍照常开始', '#ffd76b', 3);
    } else if (!STATE.started && roster.length <= 1 && !isKickedPeer(peerId)) {
      // 凑人/选图大厅阶段人全走光：不拦住的话房主一点地图就开出 1v0 空局（实测踩过）
      // ★ 主动踢出例外：房主踢掉唯一的测试玩家后应留在「继续邀请」界面，而不是被踢回主菜单
      menuToast('所有玩家已离开，返回主菜单', '#ff7a6b', 3);
      setTimeout(() => backToMenu(), 2000);
      return;
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
export function endMatchIfFoesGone() {
  if (!STATE.started || STATE.matchEnded) return false;
  const foeTeam = myTeam === 0 ? 1 : 0;
  /* 死斗（v3.15）：阵亡只是等 3 秒重生，"全队阵亡"绝不等于输 —— 必须按**名单**里还有没有对手来判。
     歼灭模式仍按存活单位判定（原逻辑）。 */
  const foesLeft = STATE.matchType === 'dm'
    ? roster.filter((p) => p.team === foeTeam && p.peerId !== myPeerId).length
    : teamAliveCount(foeTeam);
  if (foesLeft > 0) return false;
  STATE.matchEnded = true; STATE.roundOver = true; setFiring(false);
  STATE.teamElimTimer = 0;
  matchTitle.textContent = '最终胜利';
  matchTitle.style.color = '#7CFC98';
  // 房主视角：若所有连接同时消失，无法区分"全员离线"与"自己断网" → 文案中性归因；
  // 非房主（经 peerGone 进入此处）与房主的连接仍健在，可断定是"对手已全部掉线"
  const allConnsLost = (mode !== 'practice' && iAmHost && Object.keys(nets).length === 0);
  matchSub.textContent = (allConnsLost ? lostConnText('all') : '对手已全部掉线') + ' · 比赛结束（' + STATE.myScore + ' : ' + STATE.foeScore + '）';
  clearKillcam();   // 死斗：结算面板不能被击杀镜头小卡压住
  $('btnRematch').classList.remove('hidden');
  matchPanel.classList.remove('hidden');
  if (document.pointerLockElement) document.exitPointerLock();
  return true;
}
// 是否处于"对局进行中"（peerGone 处理用，避免依赖 onClose 的局部变量）
export function wasInGameCheck() { return STATE.started && !STATE.matchEnded; }

export function wireNet(n, peerKey) {
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
        // name：加入方名字（房主据此写 roster）。以前只靠应答码里的名字，
        // 信令链路一旦丢包（MQTT 是 QoS0）房主就只能拿到空名 → 全场显示「未知玩家」。
        const helloMsg = { t: 'hello', id: myPeerId, gm: gamemode, name: myName || '' };   // gm：让房主校验玩法是否一致
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
// 导出给 combat.js 等子模块使用（ES module 循环依赖，函数声明提升 → 加载期即可用）
export function netBroadcast(o) { sendToAll(o, false); }
export function netSendState(o) { sendToAll(o, true); }
// 定向消息（选阵营核对等）：直达目标（所有人只连房主，非房主经房主转发）
export function netSendEventTo(peerId, o) {
  if (mode === 'practice') return;
  const msg = Object.assign({ sender: myPeerId }, o);
  if (nets[peerId] && nets[peerId].connected) { nets[peerId].sendEvent(msg); return; }
  msg.target = peerId;
  if (hostPeerId && nets[hostPeerId] && nets[hostPeerId].connected) nets[hostPeerId].sendEvent(msg);
  else for (const id in nets) if (nets[id] && nets[id].connected) nets[id].sendEvent(msg);
}
// 房主路由：星型架构下所有定向消息均直连可达（非房主只连房主），无消息需要转发。
// 校验转发链（checkReq/checkOk/checkBad）已随"定向分配阵营"删除——阵营由房主统一分配，无需玩家间核对。
export function hostRelay(fromPeer, d) {
  if (!iAmHost || mode === 'practice') return;
  // 兼容处理：带 target 且目标是已连接玩家的消息尽力转发（防御性，正常流程不会走到）
  const dst = d.target || d.to;
  if (dst && dst !== myPeerId && nets[dst] && nets[dst].connected) nets[dst].sendEvent(d);
}


// 主机广播完整 roster（让所有玩家知道所有人的阵营与槽位）
// ns = 房间规模（netSize）随名单一起下发：加入方不能再用 roster.length 反推（掉线后会算错出生点）
export function broadcastRoster() {
  if (mode !== 'practice') {
    netBroadcast({ t: 'roster', ns: netSize, roster: roster.map(p => ({ peerId: p.peerId, team: p.team, slot: p.slot, name: p.name || '' })) });
  }
}

/* v3.12：软重置时清联机簿记。
   · lastEventSeq/lastUpdSeq/lastSyncSeq/crashPairs/hitSettled 都是按 peerId 做键的临时表，
     跨房间不清会一直涨，还可能命中上一轮同 id 的旧记录；
   · 序号计数器 stateSeq/eventSeq **故意不归零**：它们单调递增，对端按「发送者+序号」去重，
     归零反而可能与对端残留的 lastEventSeq 撞车（自己的消息被对端当旧包丢掉）。 */
export function resetNetState() {
  for (const k in lastEventSeq) delete lastEventSeq[k];
  for (const k in lastUpdSeq) delete lastUpdSeq[k];
  for (const k in lastSyncSeq) delete lastSyncSeq[k];
  crashPairs.clear();
  hitSettled.clear();
  lastREndShown = -1;
  rnMismatchT = 0;
  clearGoWatchdog();
  resetSdpState();     // 延迟探测 / 已通过 / 已踢出 标记（房主端）
}

let lastKstatPush = 0;   // 击杀台账推送节流（同步层，随 pushWorldSync 留在主文件）


// 房主端：20Hz 推送小世界权威快照（所有玩家位置/血量/存活 + 队伍比分 + 局号）
export function pushWorldSync() {
  if (mode === 'practice' || Object.keys(nets).length === 0) return;
  const lst = [];
  if (meIsAAGun) lst.push({ id: myPeerId, p: myAAGun.group.position.toArray(), hp: Math.max(0, Math.round(meAAGun.hp)), al: meAAGun.alive, ty: meAAGun.turretYaw, tp: meAAGun.turretPitch, by: meAAGun.bodyYaw });
  else { const q = myPlane.group.quaternion; lst.push({ id: myPeerId, p: myPlane.group.position.toArray(), q: [q.x, q.y, q.z, q.w], hp: Math.max(0, Math.round(me.hp)), al: me.alive }); }
  for (const id in planes) {
    const pl = planes[id]; const q = pl.tQuat;
    const o = { id, p: pl.tPos.toArray(), q: [q.x, q.y, q.z, q.w], hp: Math.max(0, Math.round(pl.hp)), al: pl.alive };
    lst.push(o);
  }
  for (const id in aaguns) {
    const ag = aaguns[id];
    const o = { id, p: ag.tPos.toArray(), hp: Math.max(0, Math.round(ag.hp)), al: ag.alive, ty: ag.tTurretYaw, tp: ag.tTurretPitch, by: ag.tBodyYaw };
    lst.push(o);
  }
  netSendState({ t: 'sync', lst, s0: STATE.s0, s1: STATE.s1, rn: STATE.roundNum, over: STATE.roundOver });
  // 击杀台账定向下发（3s 一次）：每人只收到自己的权威 {击杀 k, 阵亡 d}；房主自己的显示同样以台账为准
  const nowK = performance.now();
  if (nowK - lastKstatPush > 3000) {
    lastKstatPush = nowK;
    setKillCount(ledgerOf(myPeerId).k);
    for (const p of roster) {
      if (p.peerId === myPeerId || !nets[p.peerId] || !nets[p.peerId].connected) continue;
      const ke = ledgerOf(p.peerId);
      netSendEventTo(p.peerId, { t: 'kstat', k: ke.k, d: ke.d });
    }
  }
}
