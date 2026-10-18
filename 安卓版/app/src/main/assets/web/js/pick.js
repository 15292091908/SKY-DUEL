// js/pick.js — 设置阵营系统（v3.4.1 从 main.js 抽出）
/* 房主手动拖拽分配；3v3/5v5 与 aavs 开局前，空战 1v1 跳过。
   流程：房主把 roster 里的玩家卡片拖进两个阵营框 → 全部落位后点「完成」→ 定向发名单 → 全员短暂
   看到自己的阵营后自动开战。玩家端没有选择权（只显示等待页），队伍信息完全来自 pickList。
   异常：房主 45s 未完成 / 设置期间有人掉线 → 广播 pickCancel，全员提示后回大厅重来。 */
import {
  pickSelections, pickPhase, pickRound, pickTimer, pickDrag, pickBtnsBound, pickDealPending,
  roster, myTeam, myPeerId, mySlot, gamemode, iAmHost, STATE, lobbyPickedMap,
  setPickPhase, setPickRound, setPickTimer, setPickDrag, setPickBtnsBound,
  setMyPickSide, setPickStartTs, setPickDealPending, setMyTeam, setMySlot, setLobbyPickedMap,
} from './state.js?v=1516';
import { modeDef, modeField } from './mode.js?v=1516';   // 「游戏内」模式模块
import { $, menuToast } from './hud.js?v=1516';
import { hideAllPanels, showMenuBox, renderMapCards } from './lobby.js?v=1516';
import { rebuildWorld } from './scene3d.js?v=1516';
import { netBroadcast, netSendEventTo } from './netev.js?v=1516';
import { beginMatch } from './sdp.js?v=1516';

// 房主：两阵营已分配人数 / 容量上限（奇数时不对称）
let curPickC0 = 0, curPickC1 = 0, pickTs0 = 1, pickTs1 = 1;
// 玩家端收到 pickStart 时同步清零（保持原 main.js 行为；计数仅房主端渲染使用）
export function resetPickCounts() { curPickC0 = 0; curPickC1 = 0; }

function countPickTeam(side) {
  let n = 0;
  for (const id in pickSelections) if (pickSelections[id] === side) n++;
  return n;
}
// 阵营名称：空战 = 红队/蓝队；防空作战 = 飞机/防空车
// 阵营命名（供 scores.js 等模块复用；导出即公共 API）
export function sideLabelOf(t) {
  const f = modeDef() && modeDef().sideLabel;
  return f ? f(t) : (t === 1 ? '蓝队' : '红队');   // 阵营名来自「游戏内」模式模块
}
// 房主：进入设置阵营阶段
export function startPickPhase() {
  setPickPhase(true);
  setPickRound(pickRound + 1);                        // 表格编号递增（幂等：旧编号消息丢弃）
  for (const k in pickSelections) delete pickSelections[k];
  setPickStartTs(performance.now());
  setMyPickSide(-1);
  const n = Math.max(1, roster.length);       // 容量按实际连接人数（含房主）算 → 总容量 = 人数
  pickTs0 = Math.max(1, Math.floor(n / 2));   // 奇数人数：一队 floor 一队 ceil
  pickTs1 = Math.max(1, n - pickTs0);
  curPickC0 = 0; curPickC1 = 0;
  hideAllPanels();
  setupPickUI();
  $('pickPanel').classList.remove('hidden');
  netBroadcast({ t: 'pickStart', round: pickRound });
  clearTimeout(pickTimer);
  setPickTimer(setTimeout(() => {      // 房主挂机不分配 → 全员回大厅（不做强制分配，免得"莫名被分队"）
    if (pickPhase) returnToLobby('房主长时间未完成分配，已返回大厅');
  }, 45000));
}
// 房主：45s 超时 / 有人掉线 共用的"回大厅"（广播 + 本地，双方都提示）
export function returnToLobby(msg) {
  const text = msg || '有人掉线，全员回大厅';
  setPickPhase(false);
  clearTimeout(pickTimer); setPickTimer(null);
  for (const k in pickSelections) delete pickSelections[k];
  setMyPickSide(-1);
  setPickDealPending(false);
  const g = document.querySelector('.pickGhost'); if (g) g.remove();
  setPickDrag(null);
  netBroadcast({ t: 'pickCancel', msg: text });
  menuToast(text, '#ffd76b', 3.2);                  // 菜单阶段 HUD 隐藏，banner 看不见 → 用 body 级浮层
  hideAllPanels();
  showMenuBox();                                    // 大厅面板在 menuBoxBody 内，必须恢复容器才可见
  $('mapLobbyPanel').classList.remove('hidden');   // 房主端停在选图大厅，手动决定下一步
  $('mapLobbyTitle').textContent = modeField('lobbyTitle', '你是主机 · 选择空域');
  $('lobbyMapChoice').style.display = '';
  renderMapCards('lobbyMapChoice', lobbyRePick);
  $('lobbyRePickRow').classList.remove('hidden');
  $('mapLobbyStatus').textContent = '上轮阵营设置已取消，可重新选图重来';
}
// 选图回调（大厅/回大厅共用）：只记录所选地图，开战瞬间才换图
function lobbyRePick(m) {
  setLobbyPickedMap(m.id);
  startPickPhase();
}
// 房主：点「完成」→ 应用分配 + 定向发名单 → 全员短暂看到自己的阵营后自动开战
function completePickAndDeal() {
  if (!iAmHost) return;
  setPickPhase(false);
  clearTimeout(pickTimer); setPickTimer(null);
  setPickDrag(null);
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
  hideAllPanels();
  menuToast('你的阵营：' + sideLabelOf(myTeam), '#ffd76b', 2.6);   // 菜单阶段可见（banner 在隐藏的 HUD 里）
  // 留 2.5s 让所有人看清自己的阵营，再统一开战（房主本地同帧进游戏）。
  // 这段窗口内掉线由 onPeerClose 提示「人数不足仍照常开始」，不推翻已定名单。
  setPickDealPending(true);
  setTimeout(() => {
    setPickDealPending(false);
    if (STATE.started || STATE.matchEnded) return;
    if (roster.length <= 1) {          // 全员跑光：不开 1v0，提示回主菜单
      menuToast('所有玩家已离开，返回主菜单', '#ff7a6b', 3);
      setTimeout(() => location.reload(), 2500);
      return;
    }
    const m = lobbyPickedMap || STATE.mapType;   // 开战瞬间才切换到所选地图（与加入方收到 go 换图同一时刻）
    netBroadcast({ t: 'go', map: m });
    rebuildWorld(m);
    beginMatch();
  }, 2500);
}
// 房主：卡片池 + 两个投放框 + 完成按钮（玩家端只显示等待页）
export function setupPickUI() {
  const dl = modeField('dropLabels', ['🔴 红队', '🔵 蓝队']);   // 阵营投放框标题来自模式模块
  $('dropName0').textContent = dl[0];
  $('dropName1').textContent = dl[1];
  $('pickHostArea').classList.toggle('hidden', !iAmHost);
  $('pickGuestArea').classList.toggle('hidden', !!iAmHost);
  if (!iAmHost) { showPickStatus(''); return; }
  if (!pickBtnsBound) {
    setPickBtnsBound(true);
    $('btnPickDone').onclick = () => {
      if (!pickPhase || Object.keys(pickSelections).length < roster.length) return;
      completePickAndDeal();
    };
    $('btnLobbyRePick').onclick = () => { if (iAmHost && !pickPhase) startPickPhase(); };
  }
  renderPickHost();
}
// 房主：渲染卡片池 + 两个阵营框（roster 顺序 = 连接顺序，房主第一）
function renderPickHost() {
  const pool = $('pickPool'), b0 = $('dropBody0'), b1 = $('dropBody1');
  pool.innerHTML = ''; b0.innerHTML = ''; b1.innerHTML = '';
  let idx = 0, left = 0;
  for (const p of roster) {
    idx++;
    const side = pickSelections[p.peerId];
    const card = makePickCard(p, idx, side);
    if (side === 0) b0.appendChild(card);
    else if (side === 1) b1.appendChild(card);
    else { pool.appendChild(card); left++; }
  }
  curPickC0 = countPickTeam(0); curPickC1 = countPickTeam(1);
  $('dropCount0').textContent = curPickC0 + ' / ' + pickTs0;
  $('dropCount1').textContent = curPickC1 + ' / ' + pickTs1;
  $('pickDrop0').classList.toggle('full', curPickC0 >= pickTs0);
  $('pickDrop1').classList.toggle('full', curPickC1 >= pickTs1);
  const all = left === 0 && roster.length > 0;
  const btn = $('btnPickDone');
  btn.disabled = !all;
  btn.textContent = all ? '完成 · 开始对战' : '完成（还剩 ' + left + ' 人未分配）';
  showPickStatus(all ? '全部就位，点「完成」开始' : '把每张卡片拖进阵营框；点击卡片＝放入人少的队',
    all ? '#7CFC98' : '#7ea7c8');
}
// 房主：一张玩家卡片（有名字显名字，没有退回「玩家 N」；id 短码保留，重名时仍可区分）
function makePickCard(p, idx, side) {
  const el = document.createElement('div');
  el.className = 'pickCard';
  const name = document.createElement('span');
  name.textContent = (p.name || ('玩家 ' + idx)) + (p.peerId === myPeerId ? '（你）' : '');
  el.appendChild(name);
  const tag = document.createElement('span');
  tag.className = 'pcTag';
  tag.textContent = p.peerId.slice(0, 4);
  el.appendChild(tag);
  if (side === 0 || side === 1) {
    const x = document.createElement('button');
    x.className = 'pcX'; x.textContent = '×'; x.title = '移回未分配';
    x.addEventListener('pointerdown', (ev) => ev.stopPropagation());   // 点×不要触发拖拽
    x.onclick = (ev) => { ev.stopPropagation(); unassignPick(p.peerId); };
    el.appendChild(x);
  }
  bindCardDrag(el, p.peerId, side);
  return el;
}
// 房主：拖拽（pointer 事件：鼠标 / 触摸通用）+ 点击快捷
function bindCardDrag(el, id, side) {
  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== undefined && ev.button !== 0) return;
    setPickDrag({ id, side, moved: false, sx: ev.clientX, sy: ev.clientY, ghost: null, el });
    try { el.setPointerCapture(ev.pointerId); } catch (err) { /* 合成事件无真实指针：忽略即可 */ }
    ev.preventDefault();
  });
  el.addEventListener('pointermove', (ev) => {
    const d = pickDrag;
    if (!d || d.id !== id) return;
    if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 8) return;   // 小位移仍算点击
    if (!d.moved) {
      d.moved = true;
      el.classList.add('dragging');
      d.ghost = el.cloneNode(true);
      d.ghost.classList.add('pickGhost');
      d.ghost.classList.remove('dragging');
      document.body.appendChild(d.ghost);
    }
    d.ghost.style.left = ev.clientX + 'px';
    d.ghost.style.top = ev.clientY + 'px';
    hotDropAt(ev.clientX, ev.clientY);
  });
  el.addEventListener('pointerup', (ev) => {
    const d = pickDrag;
    if (!d || d.id !== id) return;
    el.classList.remove('dragging');
    if (d.ghost) { d.ghost.remove(); d.ghost = null; }
    setPickDrag(null);
    hotDropAt(-1, -1);
    if (d.moved) {
      const zone = dropZoneAt(ev.clientX, ev.clientY);
      if (zone === 'pool') unassignPick(id);
      else if (zone === '0') assignPick(id, 0);
      else if (zone === '1') assignPick(id, 1);
      // 落在无效区域：不动，回到原来位置
    } else {           // 点击：池中 → 放入人少的队；已分配 → 移回池子
      if (side === 0 || side === 1) unassignPick(id);
      else assignPick(id, curPickC0 <= curPickC1 ? 0 : 1);
    }
  });
  el.addEventListener('pointercancel', () => {
    if (!pickDrag || pickDrag.id !== id) return;
    if (pickDrag.ghost) pickDrag.ghost.remove();
    el.classList.remove('dragging');
    setPickDrag(null);
    hotDropAt(-1, -1);
  });
}
function dropZoneAt(x, y) {
  if (x < 0 || y < 0) return null;
  const el = document.elementFromPoint(x, y);
  const z = el && el.closest ? el.closest('[data-drop]') : null;   // ghost 已设 pointer-events:none
  return z ? z.dataset.drop : null;
}
function hotDropAt(x, y) {
  const zone = dropZoneAt(x, y);
  $('pickDrop0').classList.toggle('hot', zone === '0');
  $('pickDrop1').classList.toggle('hot', zone === '1');
  $('pickPool').classList.toggle('hot', zone === 'pool');
}
// 房主：放入阵营（容量上限 = floor/ceil，超了拒绝 → 天然避免空队与极端不平衡）
function assignPick(id, side) {
  if (!pickPhase) return;
  const cap = side === 0 ? pickTs0 : pickTs1;
  if (pickSelections[id] !== side && countPickTeam(side) >= cap) {
    showPickStatus(sideLabelOf(side) + '已满（上限 ' + cap + ' 人），请放到另一阵营', '#ffb3a0');
    return;
  }
  pickSelections[id] = side;
  renderPickHost();
}
function unassignPick(id) {
  if (!pickPhase) return;
  delete pickSelections[id];
  renderPickHost();
}
function showPickStatus(text, color) {
  $('pickStatus').textContent = text || '';
  $('pickStatus').style.color = color || '#7ea7c8';
}
// 房主端：应用完整名单（房主自己有权知道自己以外所有人的分配，用于小世界权威结算）
export function applyPickTeams(teams) {
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
  if (me) { setMyTeam(me.team); setMySlot(me.slot); }
}
// 玩家端：upsert 一条 roster 记录（定向分配消息的队友/对手落位）
export function upsertRoster(id, team, slot) {
  let p = roster.find(x => x.peerId === id);
  if (!p) { p = { peerId: id, team, slot: 0 }; roster.push(p); }
  if (team >= 0) p.team = team;
  if (slot >= 0) p.slot = slot;
}
