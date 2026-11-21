// js/live.js — 左上战术地图 + F 实时战绩面板（v3.22）
//
// 需求来源（用户）：联机模式按 F 显示实时战绩，版式参考局末结算面板；
// 原本钉在左上角的队伍血量收进这个面板，左上角改放战术地图。
//
// 设计要点：
//  · 面板数据 = 当前场上所有单位（自机 + 远端 / AI）的击杀台账 + 血量；
//    击杀台账房主权威：房主每 3s 广播一次全表（netev.js 的 'ks'），非房主只读。
//  · 面板不暂停、不抢鼠标（pointer-events:none），战斗中随时瞄一眼就关。
//  · 小地图只画轮廓级信息（建筑投影 + 敌我光点 + 自机朝向），不做地形高度着色 ——
//    152px 的方寸里，能分清"哪里有房子、队友在哪、敌人从哪个方向来"就够了。
import {
  STATE, planes, aaguns, roster, killLedger, myPeerId, myName, myTeam, mySlot,
  myPlane, me, myAAGun, meAAGun, meIsAAGun, mode, world,
} from './state.js?v=1572';
import { AAGUN_HP } from './config.js?v=1572';
import * as THREE from 'three';
import { modeField } from './mode.js?v=1572';
import { $ } from './hud.js?v=1572';

const _fwd = new THREE.Vector3();

const mmWrap = $('mmWrap');
const mmCanvas = $('mmCanvas');
const mmNameEl = $('mmMapName');
const mmScaleEl = $('mmScale');
const liveEl = $('liveStats');
const lsScoreEl = $('lsScore');
const lsHpFill = $('lsHpFill');
const lsHpLabel = $('lsHpLabel');
const lsHpNum = $('lsHpNum');
const lsTable = $('lsTable');

let liveOn = false;
let mmCtx = null;
let mmT = 0;
let lsT = 0;

/* ================= 通用 ================= */
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function sideName(t) {
  const f = modeField('sideLabel', null);
  return typeof f === 'function' ? f(t) : (t === 1 ? '蓝队' : '红队');
}
function hpBarColor(pct) {
  const hue = Math.round(Math.max(0, Math.min(100, pct)) * 1.3);
  return 'linear-gradient(90deg,hsl(' + Math.max(0, hue - 22) + ',78%,44%),hsl(' + hue + ',84%,54%))';
}

/* 自机血量（飞机 / 地面载具两套上限） */
function selfHp() {
  if (meIsAAGun) {
    return {
      hp: meAAGun ? meAAGun.hp : 0,
      max: modeField('groundHp', AAGUN_HP),
      alive: meAAGun ? meAAGun.alive : false,
      label: modeField('groundHpLabel', '车体装甲'),
    };
  }
  return { hp: me ? me.hp : 0, max: 100, alive: me ? me.alive : false, label: '机体结构' };
}

/* ================= 实时战绩面板 ================= */
export function liveStatsOpen() { return liveOn; }

export function hideLiveStats() {
  liveOn = false;
  if (liveEl) liveEl.classList.add('hidden');
}

export function toggleLiveStats() {
  // 只在有对手的对局里有意义：练习模式也能看（表格里是 AI），未开局 / 已结算则忽略
  if (!STATE.started || STATE.matchEnded) return false;
  liveOn = !liveOn;
  if (liveEl) liveEl.classList.toggle('hidden', !liveOn);
  if (liveOn) renderLiveTable();
  return liveOn;
}

function collectRows() {
  const rows = [];
  const seen = new Set();
  const rosterName = {};
  for (const p of roster) if (p && p.peerId) rosterName[p.peerId] = p.name || '';

  const push = (id, team, slot, isBot, hp, max, alive) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const L = killLedger[id] || { k: 0, d: 0 };
    let name = rosterName[id];
    if (!name) {
      if (id === myPeerId) name = myName || '你';
      else if (isBot) name = 'AI';
      else name = 'P' + ((slot | 0) + 1);
    }
    rows.push({
      id, name, team: team | 0,
      k: L.k | 0, d: L.d | 0, net: (L.k | 0) - (L.d | 0),
      hp: Math.max(0, Math.round(hp || 0)), max: max || 100, alive: !!alive,
    });
  };

  const ms = selfHp();
  push(myPeerId, myTeam, mySlot, false, ms.hp, ms.max, ms.alive);
  for (const id in planes) {
    const pl = planes[id];
    push(id, pl.team, pl.slot, pl.isBot, pl.hp, 100, pl.alive);
  }
  for (const id in aaguns) {
    const ag = aaguns[id];
    push(id, ag.team, ag.slot, ag.isBot, ag.hp, modeField('groundHp', AAGUN_HP), ag.alive);
  }
  // 名单里有、但此刻没有实体的（死亡观战窗口 / 刚掉线还没清）：血量按 0 显示，战绩仍保留
  for (const p of roster) {
    if (!p || !p.peerId || seen.has(p.peerId)) continue;
    push(p.peerId, p.team, p.slot, false, 0, 100, false);
  }

  rows.sort((a, b) => (b.net - a.net) || (b.k - a.k) || (a.d - b.d) || String(a.name).localeCompare(String(b.name)));
  return rows;
}

function renderLiveTable() {
  if (!lsTable) return;
  const rows = collectRows();
  let html = '<thead><tr><th>#</th><th>玩家</th><th>队伍</th><th>击杀</th><th>阵亡</th><th>净击杀</th><th>血量</th></tr></thead><tbody>';
  rows.forEach((r, i) => {
    const pct = Math.max(0, Math.min(100, (r.hp / (r.max || 100)) * 100));
    // 名字最长 12 字，5v5 时 7 列会把面板撑出横向滚动 —— 超过 8 字截断，完整名字放 title
    const nm = String(r.name || '');
    const nmShow = nm.length > 8 ? nm.slice(0, 8) + '…' : nm;
    html += '<tr class="' + (r.id === myPeerId ? 'me' : '') + '">'
      + '<td>' + (i + 1) + '</td>'
      + '<td title="' + escHtml(nm) + '">' + escHtml(nmShow) + '</td>'
      + '<td class="t' + (r.team === 1 ? 1 : 0) + '">' + escHtml(sideName(r.team)) + '</td>'
      + '<td>' + r.k + '</td><td>' + r.d + '</td>'
      + '<td class="' + (r.net >= 0 ? 'pos' : 'neg') + '">' + (r.net > 0 ? '+' + r.net : r.net) + '</td>'
      + '<td><span class="lsBarOuter"><span class="lsBarFill" style="width:' + pct.toFixed(0) + '%;background:' + hpBarColor(pct) + '"></span></span></td>'
      + '</tr>';
  });
  lsTable.innerHTML = html + '</tbody>';
  if (lsScoreEl) lsScoreEl.textContent = STATE.s0 + ' : ' + STATE.s1;
}

function tickLiveStats(dt) {
  if (!liveOn) return;
  // 结算 / 回菜单：面板自动收掉，避免盖住局末战绩
  if (!STATE.started || STATE.matchEnded) { hideLiveStats(); return; }
  // 自机血量条每帧走（开镜/挨打立刻可见）
  const ms = selfHp();
  const pct = Math.max(0, Math.min(100, (ms.hp / (ms.max || 100)) * 100));
  if (lsHpLabel) lsHpLabel.textContent = ms.label;
  if (lsHpNum) lsHpNum.textContent = Math.round(ms.hp);
  if (lsHpFill) { lsHpFill.style.width = pct + '%'; lsHpFill.style.background = hpBarColor(pct); }
  // 表格 0.4s 刷一次（DOM 重建比每帧画便宜得多）
  lsT -= dt;
  if (lsT <= 0) { lsT = 0.4; renderLiveTable(); }
}

/* ================= 战术地图 ================= */
function mapHalfSize() {
  const b = world && world.map && world.map.bounds;
  const h = b && (b.hurt || b.warn);
  return h && h > 100 ? h : 900;
}

/* 可视范围：按"地图里真正有东西的范围"自适应，而不是整张地图边界。
   钻井平台只有 ~200m 见方，按 bounds（1550m）画就只剩几个像素，看着像"地图没显示"；
   乡村图按 900m 画，25 座房子也只占中间一小块。这里取所有碰撞体的包围盒 + 12% 边距，
   正方形化后作为半径（最小 260m），几张小图都能填满画布。 */
let mmBox = null, mmBoxWorld = null;
function contentBox() {
  if (mmBox && mmBoxWorld === world) return mmBox;
  mmBoxWorld = world;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const cs = (world && world.colliders) || [];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    if (c.__wreck) continue;
    if (c.s === 1 || c.s === 2) {
      if (!c.hx || !c.hz) continue;
      minX = Math.min(minX, c.x - c.hx); maxX = Math.max(maxX, c.x + c.hx);
      minZ = Math.min(minZ, c.z - c.hz); maxZ = Math.max(maxZ, c.z + c.hz);
    } else if (c.s === 0 && c.v && c.r >= 6) {
      minX = Math.min(minX, c.v.x - c.r); maxX = Math.max(maxX, c.v.x + c.r);
      minZ = Math.min(minZ, c.v.z - c.r); maxZ = Math.max(maxZ, c.v.z + c.r);
    }
  }
  const h0 = mapHalfSize();
  if (!Number.isFinite(minX)) { minX = -h0; maxX = h0; minZ = -h0; maxZ = h0; }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  let half = Math.max(maxX - minX, maxZ - minZ) / 2;
  half = Math.max(260, half * 1.12);
  mmBox = { cx, cz, half };
  return mmBox;
}

function drawMinimap() {
  if (!mmCanvas) return;
  if (!mmCtx) {
    mmCtx = mmCanvas.getContext('2d');
    if (!mmCtx) return;
  }
  const ctx = mmCtx;
  const W = mmCanvas.width, H = mmCanvas.height;
  const box = contentBox();
  const B = box.half;
  const k = W / (B * 2);
  const X = (x) => W / 2 + (x - box.cx) * k;
  const Z = (z) => H / 2 + (z - box.cz) * k;

  // 底
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0b1b2b');
  bg.addColorStop(1, '#07131f');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 地形块：s=0 的大球（海岛图由一圈岛块组成、山包也是球）—— 先铺一层暗色，
  // 空战图才有"岛屿轮廓"，否则只有几个光点飘在空画布上
  if (world && world.colliders) {
    ctx.fillStyle = 'rgba(96,148,198,.34)';
    const cs = world.colliders;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (c.s !== 0 || !c.v || c.r < 6) continue;
      if (c.__wreck) continue;
      ctx.beginPath();
      ctx.arc(X(c.v.x), Z(c.v.z), Math.max(1.6, c.r * k), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 建筑投影：s=1（地面长到 h 的盒子）与 s=2（带 y0/y1 的盒体，钻井平台的甲板/舱室）
  // —— 只画够大的，栅栏与草垛不画
  if (world && world.colliders) {
    const cs = world.colliders;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (c.__wreck) continue;   // 坦克残骸不当地标
      let col = null, minS = 0;
      if (c.s === 1) { col = 'rgba(172,216,255,.52)'; minS = 2.4; }
      else if (c.s === 2) { col = 'rgba(158,180,200,.46)'; minS = 1.0; }
      else continue;
      if (!c.hx || !c.hz || c.hx < minS || c.hz < minS) continue;
      ctx.fillStyle = col;
      const bw = Math.max(3.4, c.hx * 2 * k), bh = Math.max(3.4, c.hz * 2 * k);
      ctx.fillRect(X(c.x) - bw / 2, Z(c.z) - bh / 2, bw, bh);
    }
  }

  // 网格 + 边界
  ctx.strokeStyle = 'rgba(110,190,255,.14)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const p = (W * i) / 4;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(W, p); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(110,190,255,.28)';
  ctx.strokeRect(1.5, 1.5, W - 3, H - 3);

  // 单位点
  const selfTeam = myTeam | 0;
  const plot = (x, z, team) => {
    let px = X(x), pz = Z(z);
    const out = px < 2 || px > W - 2 || pz < 2 || pz > H - 2;
    px = Math.max(3, Math.min(W - 3, px));
    pz = Math.max(3, Math.min(H - 3, pz));
    ctx.beginPath();
    ctx.arc(px, pz, out ? 2.6 : 4.0, 0, Math.PI * 2);
    ctx.fillStyle = team === selfTeam ? 'rgba(96,190,255,.95)' : 'rgba(255,92,74,.95)';
    ctx.fill();
    if (!out) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,.45)';
      ctx.stroke();
    }
  };
  for (const id in planes) {
    const pl = planes[id];
    if (!pl || !pl.plane || !pl.plane.group || !pl.alive) continue;
    const p = pl.plane.group.position;
    plot(p.x, p.z, pl.team);
  }
  for (const id in aaguns) {
    const ag = aaguns[id];
    if (!ag || !ag.aagun || !ag.aagun.group || !ag.alive) continue;
    const p = ag.aagun.group.position;
    plot(p.x, p.z, ag.team);
  }

  // 自机：带朝向的箭头（存活判定在 meAAGun/me 上 —— myAAGun 只是模型，没有 alive 字段）
  let selfPos = null, selfYaw = 0;
  if (meIsAAGun) {
    if (meAAGun && meAAGun.alive && myAAGun) {
      selfPos = myAAGun.group.position;
      selfYaw = meAAGun.bodyYaw || 0;
    }
  } else if (me && me.alive && myPlane) {
    selfPos = myPlane.group.position;
    _fwd.set(0, 0, -1).applyQuaternion(myPlane.group.quaternion);
    selfYaw = Math.atan2(_fwd.x, -_fwd.z);
  }
  if (selfPos) {
    let px = X(selfPos.x), pz = Z(selfPos.z);
    const out = px < 4 || px > W - 4 || pz < 4 || pz > H - 4;
    px = Math.max(5, Math.min(W - 5, px));
    pz = Math.max(5, Math.min(H - 5, pz));
    ctx.save();
    ctx.translate(px, pz);
    ctx.rotate(selfYaw);
    ctx.beginPath();
    ctx.moveTo(0, -9); ctx.lineTo(6.5, 7); ctx.lineTo(0, 3.5); ctx.lineTo(-6.5, 7);
    ctx.closePath();
    ctx.fillStyle = out ? 'rgba(74,222,128,.55)' : '#4ade80';
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(4,16,10,.85)';
    ctx.stroke();
    ctx.restore();
  }

  // 地图名 / 比例
  const nm = (world && world.map && world.map.name) || '—';
  if (mmNameEl && mmNameEl.textContent !== nm) mmNameEl.textContent = nm;
  const scaleTxt = 'R ' + Math.round(B) + 'm';
  if (mmScaleEl && mmScaleEl.textContent !== scaleTxt) mmScaleEl.textContent = scaleTxt;
}

/* ================= 每帧入口（loop.js 调用） ================= */
export function updateLiveHud(dt) {
  // 战术地图：对局中常驻左上角；菜单 / 结算隐藏
  const mmOn = !!(STATE.started && STATE.roundNum >= 1 && !STATE.matchEnded);
  if (mmWrap) {
    mmWrap.classList.toggle('hidden', !mmOn);
  }
  if (mmOn) {
    mmT -= dt;
    if (mmT <= 0) { mmT = 0.12; drawMinimap(); }
  }
  tickLiveStats(dt);
}
