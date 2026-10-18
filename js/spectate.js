// js/spectate.js — 死亡观战 + 多人状态栏（v3.4 从 main.js 抽出）
/* 死亡观战：联机 + 已开局 + 我死亡 + 比赛未结束 → 轨道环绕存活单位（优先队友），
   鼠标增量=环视 / 滚轮=距离 / 左键=切换目标；目标阵亡自动换人；复活/终局自动退出。
   多人状态栏：两队队员血量，死亡变灰。 */
import { planes, aaguns, myTeam, me, meAAGun, meIsAAGun, mode, STATE } from './state.js?v=1516';
import { rosterPanel, rosterMineUnits, rosterFoeUnits } from './hud.js?v=1516';
import { AAGUN_HP } from './config.js?v=1516';

// 观战状态：模块先于 main.js 求值 → 天然避开输入监听器的 TDZ（原 main.js 顶部声明已迁移至此）
export const spec = { active: false, yaw: 0.6, pitch: 0.32, dist: 30, targetId: null };
let specLabel = null;

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
export function specPick(cycle) {
  const list = specTargets();
  if (!list.length) { spec.targetId = null; return null; }
  let i = list.findIndex((t) => t.id === spec.targetId);
  if (i < 0) i = 0;
  else if (cycle) i = (i + 1) % list.length;
  spec.targetId = list[i].id;
  if (specLabel) specLabel.textContent = '👁 观战中 · 跟随 ' + list[i].name + (list[i].team === myTeam ? '（队友）' : '（敌方）') + ' · 移动鼠标环视 · 滚轮缩放 · 左键切换目标';
  return list[i];
}
export function specTargetObj() {
  if (!spec.active || !spec.targetId) return null;
  const t = specTargets().find((x) => x.id === spec.targetId);
  return t ? t.obj : null;
}
export function specUpdateActive() {
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
export function updateRoster() {
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
