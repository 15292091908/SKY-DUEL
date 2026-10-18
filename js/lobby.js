// js/lobby.js — 选图大厅 + 主菜单按钮（v3.4.1 从 main.js 抽出）
// 地图卡/阵营卡动态渲染（名字与八字介绍来自 js/world/ 地图文件）、联机选图大厅、
// 主菜单玩法切换与练习模式面板。跨模块仅运行时函数调用（startPickPhase/startPractice 在 main.js）。
import {
  gamemode, setGamemode, mode, iAmHost, STATE, setLobbyPickedMap, setMapLobbyTimerId,
  meIsAAGun, myAAGun, meAAGun, aaguns,
} from './state.js?v=1516';
import { AAGUN_BODY_R } from './config.js?v=1516';
import { modeField, loadMode, modeList } from './mode.js?v=1516';   // 模式读取器/装载器
import { $, banner } from './hud.js?v=1516';
import { audio } from './core.js?v=1516';
import { clearMenuProps, showMenuScene } from './scene3d.js?v=1516';
import { startPractice } from './match.js?v=1516';
import { startPickPhase } from './pick.js?v=1516';

/* ================= 选图大厅（主机选图广播） ================= */
export function hideAllPanels() {
  ['practicePanel', 'hostPanel', 'joinPanel', 'mapLobbyPanel', 'pickPanel'].forEach(id => { const el = $(id); if (el) el.classList.add('hidden'); });
  const mb = $('menuBoxBody'); if (mb) mb.style.display = 'none';   // 二级面板容器
  const hp = $('helpPanel'); if (hp) hp.classList.add('hidden');     // 帮助弹层
}
export function showMenuBox() { const mb = $('menuBoxBody'); if (mb) mb.style.display = ''; }
// 地图卡片动态渲染：名字/介绍来自**当前模式包**的 maps.js（MODE.maps），
// 新增/删除地图只改 js/modes/<模式>/maps/ + maps.js，大厅无需改一行代码。
// （v2.4.1 修复：兜底分支原写成 $('#'+id)，$ 是 getElementById 不带 #，导致单层结构的
//   #lobbyMapChoice 两路都查空 → 选图大厅一张卡都不渲染）
export function renderMapCards(containerId, onPick) {
  const box = document.querySelector('#' + containerId + ' .mapChoice') || document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = '';
  for (const m of (modeField('maps', []) || [])) {
    const card = document.createElement('div');
    card.className = 'mapCard';
    card.dataset.map = m.id;
    const nm = document.createElement('div'); nm.className = 'mapName'; nm.textContent = m.name;
    const ds = document.createElement('div'); ds.className = 'mapDesc'; ds.textContent = m.desc;
    card.append(nm, ds);
    card.onclick = () => {
      box.querySelectorAll('.mapCard').forEach(c => c.classList.remove('sel'));
      card.classList.add('sel');
      onPick(m);
    };
    box.appendChild(card);
  }
}
// 阵营卡片动态渲染：空战 = 红队/蓝队（出生空域南北对换），防空车 = 飞机/防空车
export function renderSideCards(containerId, onPick) {
  const box = document.querySelector('#' + containerId + ' .sideChoice') || document.getElementById(containerId);
  if (!box) return;
  box.innerHTML = '';
  // 阵营卡片来自当前模式包（js/modes/<目录>/index.js 的 MODE.sides）；未加载时退回空战默认
  const sides = modeField('sides', [
    { side: 0, name: '🔴 红队', desc: '南侧空域\n向北突进' },
    { side: 1, name: '🔵 蓝队', desc: '北侧空域\n向南压制' }]);
  for (const s of sides) {
    const card = document.createElement('div');
    card.className = 'sideCard';
    card.dataset.side = s.side;
    const nm = document.createElement('div'); nm.className = 'sideName'; nm.textContent = s.name;
    const ds = document.createElement('div'); ds.className = 'sideDesc'; ds.innerHTML = s.desc.replace('\n', '<br>');
    card.append(nm, ds);
    card.onclick = () => {
      box.querySelectorAll('.sideCard').forEach(c => c.classList.remove('sel'));
      card.classList.add('sel');
      onPick(s.side);
    };
    box.appendChild(card);
  }
}
// 联机模式：P2P 接通后主机选图、广播给对方
// 统一流程（v2.4）：所有玩法、所有规模都先选图 → 再进选阵营 → 开局
export function startMapLobby() {
  if (mode !== 'net') return;
  if (STATE.mapFinalized) return;
  STATE.mapFinalized = true;     // 防止重复进入
  clearMenuProps();              // 进入正式流程：清掉菜单 3D 展示实体。否则房主选图 rebuildWorld
                                 // 换地图后，展示飞机仍挂在场景里的旧坐标（base 跑道）——
                                 // 空战选海岛/都市后那个点成了海面/街区，选阵营展示的 2.5s 空窗
                                 // 会看到"水上飘着的飞机"（防空车因唯一地图恰好还是 base 而未穿帮）
  hideAllPanels();
  showMenuBox();                 // 关键：hideAllPanels 把 menuBoxBody 设成了 display:none，
                                 // 不恢复的话，下面的选图面板虽然解除了 hidden 也依然不可见
                                 // （曾导致「连接成功却没有进入游戏」：两端都卡在看不见的大厅）
  $('mapLobbyPanel').classList.remove('hidden');
  if (iAmHost) {
    $('mapLobbyTitle').textContent = modeField('lobbyTitle', '你是主机 · 选择空域');
    $('mapLobbyStatus').textContent = '选定后进入选阵营，随后自动开局。';
    $('lobbyMapChoice').style.display = '';
    renderMapCards('lobbyMapChoice', (m) => {
      setLobbyPickedMap(m.id);     // 只记录：换图推迟到「完成阵营分配 → 开战瞬间」（与加入方对齐）
      startPickPhase();          // 所有玩法/规模都走选阵营（1v1 也分红蓝 / 飞机防空车）
    });
  } else {
    $('mapLobbyTitle').textContent = '等待主机选择地图';
    $('mapLobbyStatus').textContent = '正在等待主机选择地图…';
    // 非房主：从一开始就完全隐藏地图选择卡片
    $('lobbyMapChoice').style.display = 'none';
    // 超时兜底：仅防主机冻结失联（不可提前开局，否则选阵营 45s 窗口内会抢跑且地图错误）
    setMapLobbyTimerId(setTimeout(() => { if (!STATE.started) { banner('主机长时间未响应，请重新加入', '#ff7a6b', 3); setTimeout(() => location.reload(), 2500); } }, 60000));
  }
}

// 防空车之间的碰撞体积：不扣血、不判死，只挡路（用户 2026-09-29 定）。
// 实现要点：
//  · 半径取车体半长（与弱点盒「车体 r: 2.65」一致），两车阈值 = 2×2.65 ≈ 5.3m
//  · 只推「自己」这一台：远端车的坐标来自房主快照（20Hz），本地推它会被快照拉回去 → 抖动；
//    两端各自推自己 → 双方自然并排停住，且与现有地形碰撞一样是"回退到上一帧位置"的手感
//  · 只在本地车移动时调用（位置只有移动时才变），无伤害、无击杀、不参与任何权威结算
export function blockedByAAGun() {
  if (!meIsAAGun || !myAAGun || !meAAGun) return false;
  const p = myAAGun.group.position;
  const lim = (AAGUN_BODY_R * 2) * (AAGUN_BODY_R * 2);
  for (const id in aaguns) {
    const ag = aaguns[id];
    if (!ag || !ag.aagun || ag === meAAGun || !ag.alive) continue;
    const q = ag.aagun.group.position;
    const dx = p.x - q.x, dz = p.z - q.z;
    if (dx * dx + dz * dz < lim) return true;   // 只算水平距离：贴地行驶，高度差无意义
  }
  return false;
}

/* ================= 主菜单按钮 ================= */
// 玩法药丸：从 /js/modes.json 清单渲染（增删 js/modes/ 里的文件夹 → 大厅自动多/少一个药丸，
// 不需要改 HTML，也不需要改本文件）
export function renderModeTabs() {
  const bar = document.getElementById('menuGmTabs');
  if (!bar) return;
  bar.innerHTML = '';
  const list = modeList();
  for (const m of list) {
    const b = document.createElement('button');
    b.className = 'gmPill' + (m.id === gamemode ? ' on' : '');
    b.dataset.gm = m.id;
    b.textContent = m.name;
    b.title = m.name;
    b.onclick = () => setMenuGm(m.id);
    bar.appendChild(b);
  }
}
// 切换玩法：先清上一模式的展示件（归属正确），再按需加载新模式，最后切 3D 展示
let modeSwitch = null;                   // 当前切换的 Promise（大按钮在切换期间禁用）
let switchSeq = 0;                       // 切换序号：只让最后一次切换决定菜单 3D

export async function setMenuGm(gm) {
  const seq = ++switchSeq;
  setGamemode(gm);
  document.querySelectorAll('#menuGmTabs .gmPill').forEach(p => p.classList.toggle('on', p.dataset.gm === gm));
  const run = (async () => {
    const def = await loadMode(gm);      // 按需取用：切到该玩法才加载它的模式包
    if (seq !== switchSeq) return;       // 快速连点：已有更新的切换，别再改场景
    if (!def || def.id !== gm) return;
    // 不在加载前清场：旧展示件先留着，新模式就绪后 showMenuScene 内部按 menuPropOwner 一次性换场，
    // 避免慢网络下大厅出现 1~2 秒"空跑道"的空窗
    showMenuScene(def.menu.scene);       // 本模式自己的菜单 3D 展示（内部 clearMenuProps）
  })();
  modeSwitch = run;
  try { await run; } finally {
    if (modeSwitch === run) modeSwitch = null;
  }
}

// 练习模式（v2.4 与联机同流程）：先选地图、再选阵营，选齐后点「开始战斗」
let practiceSel = { map: null, side: -1 };
function updatePracticeStart() {
  const ok = !!practiceSel.map && practiceSel.side >= 0;
  const btn = $('btnPracticeStart');
  if (btn) btn.disabled = !ok;
  $('practiceStatus').textContent = ok ? '一切就绪，点「开始战斗」升空' : '选择地图与阵营后开始';
}
export function refreshPracticePanel() {
  practiceSel = { map: null, side: -1 };
  renderMapCards('practiceMapChoice', (m) => { practiceSel.map = m.id; updatePracticeStart(); });
  renderSideCards('practiceSideChoice', (side) => { practiceSel.side = side; updatePracticeStart(); });
  updatePracticeStart();
}
$('btnHelp').onclick = () => { hideAllPanels(); $('helpPanel').classList.remove('hidden'); };
$('btnCloseHelp').onclick = () => { hideAllPanels(); };
$('btnPractice').onclick = async () => {
  if (modeSwitch) { try { await modeSwitch; } catch (e) {} }   // 模式还没切完就点了练习：等它切完
  audio.init(); audio.resume();
  hideAllPanels();
  showMenuBox();
  $('practicePanel').classList.remove('hidden');
  refreshPracticePanel();
};
$('btnBackFromPractice').onclick = () => location.reload();
$('btnPracticeStart').onclick = () => {
  if (!practiceSel.map || practiceSel.side < 0) return;
  startPractice(gamemode, practiceSel.side, practiceSel.map);
};
