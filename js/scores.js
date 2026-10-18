// js/scores.js — 赛后战绩（v3.4 从 main.js 抽出）
// 房主用权威击杀台账构建排名并广播，两端渲染同一张表；支持导出为等宽 txt。
import { modeDef } from './mode.js?v=1516';
import { roster, myPeerId, myName, myTeam, gamemode, killLedger, sbRows, setSbRows, STATE } from './state.js?v=1516';
import { $, menuToast } from './hud.js?v=1516';
import { sideLabelOf } from './pick.js?v=1516';   // 阵营命名

/* ================= 赛后战绩 =================
   房主用权威击杀台账构建排名并广播，两端渲染同一张表，可导出 txt。 */
// 房主：按权威台账生成排名（净击杀 = 击杀 − 阵亡，可为负）
export function buildScoreRows() {
  const rows = roster.map(p => {
    const L = killLedger[p.peerId] || { k: 0, d: 0 };
    return {
      id: p.peerId,
      name: p.name || (p.peerId === myPeerId ? (myName || '房主') : '玩家'),
      team: p.team >= 0 ? p.team : 0,
      k: L.k | 0, d: L.d | 0, net: (L.k | 0) - (L.d | 0),
    };
  });
  rows.sort((a, b) => (b.net - a.net) || (b.k - a.k) || (a.d - b.d));
  return rows;
}
export function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
export function renderScoreboard(rows) {
  setSbRows(rows || []);
  const t = $('sbTable'); if (!t) return;
  if (!sbRows.length) { $('sbWrap').classList.add('hidden'); return; }
  let html = '<thead><tr><th>#</th><th>玩家</th><th>队伍</th><th>击杀</th><th>阵亡</th><th>净击杀</th></tr></thead><tbody>';
  sbRows.forEach((r, i) => {
    html += '<tr class="' + (r.id === myPeerId ? 'me' : '') + '">'
      + '<td>' + (i + 1) + '</td>'
      + '<td>' + escHtml(r.name) + '</td>'
      + '<td class="t' + (r.team === 1 ? 1 : 0) + '">' + sideLabelOf(r.team) + '</td>'
      + '<td>' + r.k + '</td><td>' + r.d + '</td>'
      + '<td class="' + (r.net >= 0 ? 'pos' : 'neg') + '">' + (r.net > 0 ? '+' + r.net : r.net) + '</td></tr>';
  });
  t.innerHTML = html + '</tbody>';
  $('sbWrap').classList.remove('hidden');
  $('btnSbTxt').classList.remove('hidden');
}
export function scoreboardText() {
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  const modeName = (modeDef() && modeDef().matchName) || '空战对决';   // 玩法名来自「游戏内」模式模块
  const myT = myTeam === 1 ? 1 : 0;
  const win = STATE.s0 === STATE.s1 ? '平局' : ((myT === 0 ? STATE.s0 : STATE.s1) > (myT === 0 ? STATE.s1 : STATE.s0) ? '本队胜利' : '本队落败');
  const L = [];
  L.push('苍穹对决 · 战后战绩');
  L.push('时间：' + stamp + '    模式：' + modeName + '    地图：' + (STATE.mapType || '-'));
  L.push('总比分：' + STATE.s0 + ' : ' + STATE.s1 + '（' + win + '）');
  L.push('');
  L.push('#   玩家          队伍      击杀   阵亡   净击杀');
  L.push('--- ------------ --------- ----- ----- ------');
  sbRows.forEach((r, i) => {
    L.push(String(i + 1).padStart(2) + '  '
      + (r.name + '            ').slice(0, 12) + '  '
      + (sideLabelOf(r.team) + '        ').slice(0, 8) + '  '
      + String(r.k).padStart(5) + ' ' + String(r.d).padStart(5) + ' '
      + String(r.net > 0 ? '+' + r.net : r.net).padStart(6));
  });
  L.push('');
  L.push('净击杀 = 击杀 − 阵亡；数据来源：房主权威击杀台账（比赛中每 3 秒同步，赛后以最终台账为准）');
  return L.join('\r\n');
}
export function fileStamp() {
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' + pad(d.getHours()) + pad(d.getMinutes());
}
// 下载：网页走 Blob；安卓走原生桥（分块写入下载目录，避免超大字符串卡顿）
export function downloadFile(name, text) {
  if (window.SkyDuelNative && window.SkyDuelNative.beginFile) {
    try {
      window.SkyDuelNative.beginFile(name);
      const CH = 262144;
      for (let i = 0; i < text.length; i += CH) window.SkyDuelNative.appendChunk(text.substr(i, CH));
      window.SkyDuelNative.endFile();
      return true;
    } catch (e) { /* 桥不可用则退回 Blob */ }
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
    return true;
  } catch (e) { return false; }
}
export function downloadScoreboard() {
  if (!sbRows.length) { menuToast('暂无战绩数据', '#ffd76b', 2.2); return; }
  const nm = '苍穹对决_战绩_' + fileStamp() + '.txt';
  if (downloadFile(nm, scoreboardText())) menuToast('已导出 ' + nm, '#7CFC98', 2.4);
  else menuToast('导出失败，请改用网页版', '#ff7a6b', 2.6);
}
