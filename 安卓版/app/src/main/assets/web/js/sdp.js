// js/sdp.js — 联机连接层（v3.4.1 从 main.js 抽出）
// 手动 SDP 交换（邀请码/应答码逐个连接）+ 信令房间码（并行，失败回退手动）+ 延迟门槛（80ms 踢出）+ beginMatch 开局。
import { modeField } from './mode.js?v=1516';   // 「游戏内」模式模块（建房时的阵营预分策略）
import {
  STATE, roster, nets, mode, gamemode, iAmHost, myPeerId, myTeam, netSize, pingProbe,
  setMode, setIAmHost, setMyTeam, setMySlot, setNetSize, setRoster, setMyName, setHostNameHint,
  hostNameHint, myName, mapLobbyTimerId, pickTimer, setPickTimer, setPickPhase, setMyPickSide, setPickDealPending, setKillCount,
} from './state.js?v=1516';
import { PING_SAMPLES, PING_KICK_MS } from './config.js?v=1516';
import { Net, cleanName } from './net.js?v=1516';
import {
  signalProbe, signalShutdown, signalCreate, makeRoomCode, signalHostPoll, signalHostOffer,
  signalBeaconRefresh, signalJoin, signalJoinPoll, signalJoinAnswer,
} from './signal.js?v=1516';
import { netSendEventTo, removePeerLocal, broadcastRoster, wireNet } from './netev.js?v=1516';
import { hideAllPanels, showMenuBox, startMapLobby } from './lobby.js?v=1516';
import { checkRoundEnd, resetKillLedger } from './combat.js?v=1516';
import { $, menuToast, clearKillFeed, hud, menu, banner, updateScore } from './hud.js?v=1516';
import { audio, IS_ANDROID_APP } from './core.js?v=1516';
import { clearMenuProps } from './scene3d.js?v=1516';
import { setVoiceBtnsVisible, syncVoiceBtn } from './voice.js?v=1516';
import { buildAllUnits } from './units.js?v=1516';
// main.js（循环依赖：仅运行时函数调用）
import { nextRound, lockPointer } from './match.js?v=1516';

/* ================= 联机：手动 SDP 交换（mesh 多人） ================= */
// 主机：选规模 → 逐个为每个好友生成邀请码并连接
let hostConnIdx = 0;     // 当前连到第几个好友
let hostNet = null;      // 当前正在连接的 Net

$('btnHost').onclick = async () => {
  audio.init(); audio.resume();
  setMode('net'); setIAmHost(true);
  hideAllPanels();
  showMenuBox();
  $('hostPanel').classList.remove('hidden');
  const hn = $('hostName');                                   // 名字记忆：上次填过的自动带回
  if (hn && !hn.value) hn.value = localStorage.getItem('sd_name') || '';
  stopSignalHost();                                           // 重进面板：清掉上一轮房间，重新探测信令
  signalHostStatus('');
  $('hostSignalRow').classList.add('hidden');                  // 未选规模前不显示房间码入口
  hostSizeChosen = false;
  signalHintOk('正在检查信令服务器…', true);
  for (const id of ['btnSignalHost', 'btnSignalJoin']) { const b = $(id); if (b) b.classList.add('hidden'); }
  waitSignal();
  $('hostSizeChoice').querySelectorAll('.sizeCard').forEach(c => c.classList.remove('sel'));
  $('hostOfferRow').classList.add('hidden');
  if (modeField('hostPrePick', 'random') === 'none') {
    // 本模式：阵营留到开局前的分配系统里定（1v1 拼手速 / 3v3+ 自由选择），建房时不预选
    setMyTeam(-1); setMySlot(0);
    $('hostPanelTitle').textContent = '创建房间 · 选择规模';
    $('hostSideChoice').classList.add('hidden');
    $('hostSizeChoice').classList.remove('hidden');
  } else {
    // 空战模式：随机分红蓝（无阵营差异，随机合理）
    setMyTeam(Math.random() < 0.5 ? 0 : 1); setMySlot(0);
    $('hostPanelTitle').textContent = '创建房间 · 选择规模';
    $('hostSideChoice').classList.add('hidden');
    $('hostSizeChoice').classList.remove('hidden');
  }
  document.querySelectorAll('#hostSizeChoice .sizeCard').forEach(card => {
    card.onclick = () => {
      document.querySelectorAll('#hostSizeChoice .sizeCard').forEach(c => c.classList.remove('sel'));
      card.classList.add('sel');
      setNetSize((card.dataset.size === '3v3') ? 6 : (card.dataset.size === '5v5') ? 10 : 2);
      $('hostOfferRow').classList.remove('hidden');
      $('hostSignalRow').classList.remove('hidden');   // 选完人数才放行房间码（need 才确定）
      hostSizeChosen = true;
      hostConnIdx = 0;
      setRoster([{ peerId: myPeerId, team: myTeam, slot: 0, name: myName || '' }]);
      updateHostStatus();
    };
  });
};
$('btnBackFromHost').onclick = () => location.reload();

// 已完成 hello 握手的加入方数（team 已分配 = hello 已到）。
// ⚠ 不能用 Object.keys(nets).length：wireNet 一建立就占位，房间码流程会因此提前判定"人齐"
// 而停掉轮询 → 应答码永远收不回来 → 玩家端"显示连接成功但进不了游戏"（实测踩过）。
function helloJoiners() { return roster.filter(p => p.peerId !== myPeerId && p.team >= 0).length; }
/* ===== v3.0 延迟门槛：连接建立后房主采样 RTT，超限直接移出房间 =====
   多次采样的原因：ICE 刚接通时首包受协商/抖动影响偏大，取多次最小值最接近真实 RTT。
   为什么要有门槛：本作把命中判定权交给开火者（房主只做位置校验），两端延迟越低，
   "开火者画面里的目标位置"与"房主权威位置"的偏差越小，判定越公平。 */
export function hostPingCheck(id) {
  if (!iAmHost || mode !== 'net') return;
  if (pingProbe[id]) return;                                  // 已在探测
  const pr = pingProbe[id] = { samples: [], sent: 0, timer: null };
  const step = () => {
    if (!nets[id]) { delete pingProbe[id]; return; }           // 已断开
    if (pr.sent >= PING_SAMPLES) {                             // 采样结束 → 判定
      clearTimeout(pr.timer);
      const best = pr.samples.length ? Math.min.apply(null, pr.samples) : 0;
      delete pingProbe[id];
      if (pr.samples.length && best >= PING_KICK_MS) kickPeer(id, best);
      return;
    }
    pr.sent++;
    netSendEventTo(id, { t: 'ping', ts: performance.now() });   // 复用 ping/pong：对端原样回 ts，房主自算 RTT
    pr.timer = setTimeout(step, 180);
  };
  step();
}
// 房主：延迟过高 → 移出房间（先通知本人，再断连/清名单/提示房主）
function kickPeer(id, ms) {
  const entry = roster.find((p) => p.peerId === id) || {};
  const nm = entry.name || '一名玩家';
  const inMatch = !!STATE.started;
  netSendEventTo(id, { t: 'kick', reason: 'ping', ms: ms | 0 });
  setTimeout(() => {
    if (nets[id]) { try { nets[id].close(); } catch (e) {} }
    removePeerLocal(id);
    broadcastRoster();
    updateHostStatus();
    menuToast(nm + ' 延迟过高（' + (ms | 0) + ' ms），已被移出房间', '#ff7a6b', 5);
    if (inMatch) checkRoundEnd();   // 对局中移除：复检人数（可能直接判胜/结束回合）
  }, 700);
}

export function updateHostStatus() {
  const need = netSize - 1;
  const connected = helloJoiners();
  if (connected >= need) {
    $('hostStatus').textContent = '已全部连接(' + connected + '/' + need + ')，准备开局！';
    startMapLobby();   // 星型架构：无 mesh 名单广播，人齐直接进入选图/选阵营
  } else {
    $('hostStatus').textContent = '已连接 ' + connected + '/' + need + ' 人，继续生成邀请码连接下一位好友';
  }
}

/* ================= 信令房间码（与手动交换并行；失败自动回退手动） =================
   服务可用：房主「生成房间码」→ 好友输码即自动完成 SDP 交换（内部仍走同一套
   createOffer / acceptAnswer，手动交换代码路径完全不变）。
   服务不可用（探测失败 / 请求出错）：隐藏房间码入口，提示改用手动交换，手动流程照常可用。 */
let signalAvailable = null;      // null 未探测 / true 可用 / false 不可用
let signalRoom = null;           // 房主：当前房间码
let hostSizeChosen = false;      // 是否已点过规模卡（没选人数不允许生成房间码，否则 need 不确定）
let signalHostTimer = null;      // 房主：轮询定时器
let signalJoinTimer = null;      // 加入方：轮询定时器
let signalJoinCode = null, signalJoinId = null;
const signalPend = {};           // joinerId -> { peerKey, net }（net 必须存创建时的引用：nets[] 要到 P2P 接通才填充，而接通正需要这份应答）

function signalHintOk(text, host) { const el = $(host ? 'signalHintHost' : 'signalHintJoin'); if (el) el.textContent = text || ''; }
function applySignalAvailability(ok, host) {
  signalAvailable = ok;
  for (const id of ['btnSignalHost', 'btnSignalJoin']) { const b = $(id); if (b) b.classList.toggle('hidden', !ok); }
  if (host) signalHintOk(ok ? '房间码组队：走公共信令服务器（免部署），好友输入 6 位码即可自动连上'
    : '信令不可用 → 请用下方「手动交换邀请码」（不依赖任何服务器）', true);
  else signalHintOk(ok ? '房间码组队：走公共信令服务器，输入房主给的 6 位码即可自动连上'
    : '信令不可用 → 请用下方「手动交换」（不依赖任何服务器）', false);
}
async function waitSignal() {
  // 公共 broker 偶发慢/抖动（实测同一天一次 2s 连上、一次 9s 探测期内没连上），
  // 所以面板开着期间持续重试，一旦连上立刻放出房间码入口；全程失败才提示改用手动交换。
  for (let i = 0; i < 3 && !signalAvailable; i++) {
    if (i > 0) signalHintOk('信令服务器连接慢，继续尝试中…（手动交换随时可用）', iAmHost);
    const ok = await signalProbe();
    applySignalAvailability(ok, iAmHost);
    if (ok) return true;
    await new Promise(r => setTimeout(r, 2500));
  }
  return !!signalAvailable;
}
function stopSignalHost() {
  clearInterval(signalHostTimer); signalHostTimer = null;
  for (const k in signalPend) delete signalPend[k];
  signalRoom = null;
  try { signalShutdown(); } catch (e) { /* 断开公共 broker */ }
}
function signalHostStatus(html) { const el = $('signalHostStatus'); if (el) el.innerHTML = html; }
// 房主：建房 + 开始轮询（每个加入者自动生成 offer / 回收 answer）
async function signalHostStart() {
  if (signalRoom) return;
  if (!hostSizeChosen) { signalHostStatus('请先点击上方规模卡选择对战人数'); return; }   // 没选人数 need 不确定
  const hn = $('hostName');
  setMyName(cleanName(hn && hn.value) || '房主');
  if (hn) localStorage.setItem('sd_name', myName);
  { const me = roster.find(p => p.peerId === myPeerId); if (me) me.name = myName; }   // roster 里自己的名字同步
  signalHostStatus('正在创建房间…');
  let r = null;
  try { r = await signalCreate(makeRoomCode(), myName, Math.max(1, netSize - 1)); } catch (e) { r = null; }
  if (r && !r.ok && r.err === 'code-taken') { try { r = await signalCreate(makeRoomCode(), myName, Math.max(1, netSize - 1)); } catch (e) { r = null; } }
  if (!r || !r.ok) {
    applySignalAvailability(false, true);
    signalHostStatus('创建房间失败，请改用手动交换');
    return;
  }
  signalRoom = r.code;
  signalHostStatus('房间码 <b>' + signalRoom + '</b> · 等待好友加入…');
  await signalHostTick();
  clearInterval(signalHostTimer);
  signalHostTimer = setInterval(signalHostTick, 900);
}
async function signalHostTick() {
  if (!signalRoom) return;
  let d = null;
  try { d = await signalHostPoll(signalRoom); } catch (e) { return; }        // 网络抖动：下次再试
  if (!d || !d.ok) { if (d && d.err === 'no-room') { stopSignalHost(); signalHostStatus('房间已回收，请重新生成房间码'); } return; }
  for (const j of (d.joins || [])) {
    if (signalPend[j.id]) continue;
    const net = new Net();                       // 与手动交换同一条路径：新建 Net + wireNet + createOffer
    const peerKey = 'foe_' + hostConnIdx++;
    wireNet(net, peerKey);
    signalPend[j.id] = { peerKey, net };         // ⚠ 存 net 本体：此时 nets[peerKey] 还不存在（P2P 未接通）
    signalHostStatus('房间码 <b>' + signalRoom + '</b> · 正在为「' + (j.name || '玩家') + '」建立连接…');
    try { await signalHostOffer(signalRoom, j.id, await net.createOffer(myName), myName); }
    catch (e) { delete signalPend[j.id]; }
  }
  for (const a of (d.answers || [])) {
    const p = signalPend[a.id];
    if (!p) continue;
    delete signalPend[a.id];
    // ⚠ 必须用 p.net（创建时的引用）。用 nets[p.peerKey] 会取到 undefined——
    // nets[] 要等 P2P 接通才填充，而接通恰恰依赖这次 acceptAnswer（曾导致"应答已回传但永远连不上"）
    if (p.net) { try { await p.net.acceptAnswer(a.answer); } catch (e) { /* 应答失效：忽略 */ } }
  }
  const need = netSize - 1, conn = helloJoiners();   // 只认完成 hello 握手的（见 helloJoiners 注释）
  if (conn >= need) { stopSignalHost(); return; }                            // 人齐：后续由 hello/updateHostStatus 接管
  signalBeaconRefresh(signalRoom, myName);           // 刷新保留信标（内部 5s 节流），加入方据此找到本房间所在的 broker
  signalHostStatus('房间码 <b>' + signalRoom + '</b> · 已连接 ' + conn + '/' + need
    + (d.count > conn ? ' · 还有 ' + (d.count - conn) + ' 人正在加入…' : ''));
}
// 加入方：输入房间码 → 拿 offer → 生成 answer 回传
async function signalJoinStart() {
  const code = String(($('joinCode') && $('joinCode').value) || '').replace(/\D/g, '');
  const nm = cleanName($('joinName') && $('joinName').value);
  const st = $('signalJoinStatus');
  if (!nm) { st.textContent = '请先填写你的名字（房主据此分配阵营）'; const el = $('joinName'); if (el) el.focus(); return; }
  if (code.length !== 6) { st.textContent = '请输入房主给的 6 位数字房间码'; return; }
  setMyName(nm);
  localStorage.setItem('sd_name', nm);
  st.textContent = '正在加入房间…';
  let r = null;
  try { r = await signalJoin(code, nm); } catch (e) { r = null; }
  if (!r || !r.ok) {
    if (r && (r.err === 'no-room' || r.err === 'full')) {
      st.textContent = r.err === 'full' ? '房间已满' : '房间不存在（码错了，或房主还没建好）';
    } else { applySignalAvailability(false, false); st.textContent = '信令服务连接失败，请改用手动交换'; }
    return;
  }
  signalJoinCode = code; signalJoinId = r.id;
  setHostNameHint(r.hostName || '');
  st.textContent = '已进入房间' + (hostNameHint ? '（房主：' + hostNameHint + '）' : '') + '，等待房主建立连接…';
  clearInterval(signalJoinTimer);
  signalJoinTimer = setInterval(signalJoinTick, 900);
}
async function signalJoinTick() {
  if (!signalJoinCode) return;
  let d = null;
  try { d = await signalJoinPoll(signalJoinCode, signalJoinId); } catch (e) { return; }
  const st = $('signalJoinStatus');
  if (!d || !d.ok) { clearInterval(signalJoinTimer); signalJoinTimer = null; st.textContent = '房间已关闭，请让房主重新生成房间码'; return; }
  if (!d.offer) return;
  clearInterval(signalJoinTimer); signalJoinTimer = null;
  if (d.hostName) setHostNameHint(d.hostName);
  st.textContent = '正在建立 P2P 连接…';
  const n = new Net();
  wireNet(n, myPeerId);
  try {
    const answer = await n.join(d.offer, myName);
    await signalJoinAnswer(signalJoinCode, signalJoinId, answer);
    $('taAnswerJoin').value = answer;      // 同步填进手动框，便于排查
    st.textContent = '应答已回传，正在建立 P2P 连接…';
  } catch (e) {
    st.textContent = '连接失败：' + e.message + '（可改用下方手动交换）';
  }
}

$('btnSignalHost').onclick = () => { audio.resume(); signalHostStart(); };
$('btnSignalJoin').onclick = () => { audio.resume(); signalJoinStart(); };
$('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') signalJoinStart(); });   // 输完码回车即加入

$('btnGenOffer').onclick = async () => {
  audio.resume();
  const need = netSize - 1;
  if (Object.keys(nets).length >= need) { $('hostStatus').textContent = '已全部连接，无需再生成！'; return; }
  const hn = $('hostName');
  setMyName(cleanName(hn && hn.value) || '房主');       // 房主名字（可空 → 默认「房主」），随邀请码带给加入方
  if (hn) localStorage.setItem('sd_name', myName);
  { const me = roster.find(p => p.peerId === myPeerId); if (me) me.name = myName; }   // roster 里自己的名字同步（击杀播报用）
  $('hostStatus').textContent = '正在生成邀请码…';
  hostNet = new Net();
  const peerKey = 'foe_' + hostConnIdx++;
  wireNet(hostNet, peerKey);
  try {
    const offer = await hostNet.createOffer(myName);
    $('taOffer').value = offer;
    $('taAnswerHost').value = '';
    $('hostStatus').textContent = '邀请码已生成！复制发给第 ' + (Object.keys(nets).length + 1) + ' 位好友，等他发回应答码';
  } catch (e) {
    $('hostStatus').textContent = '失败：' + e.message;
  }
};
$('copyOffer').onclick = () => {
  $('taOffer').select();
  document.execCommand('copy');
  $('hostStatus').textContent = '已复制到剪贴板！';
};
$('btnConnHost').onclick = async () => {
  const ans = $('taAnswerHost').value.trim();
  if (!ans) { $('hostStatus').textContent = '请先粘贴好友的应答码！'; return; }
  if (!hostNet) { $('hostStatus').textContent = '请先点「生成邀请码」！'; return; }
  $('hostStatus').textContent = '正在连接…';
  try {
    await hostNet.acceptAnswer(ans);
    const nm = hostNet.remoteName ? '「' + hostNet.remoteName + '」' : '';
    $('hostStatus').textContent = '应答已接受' + (nm ? '（对方：' + nm + '）' : '') + '，等待 P2P 接通…';
    // 连接成功后由 hello 处理更新为「已连接 N/need」或「准备开局」
  } catch (e) {
    $('hostStatus').textContent = '连接失败：' + e.message;
  }
};

// 加入方：粘贴邀请码，生成应答码（阵营由主机随机分配，通过 team 消息告知）
$('btnJoin').onclick = () => {
  audio.init(); audio.resume();
  setMode('net'); setIAmHost(false); setMyTeam(-1); setMySlot(0);
  hideAllPanels();
  showMenuBox();
  $('joinPanel').classList.remove('hidden');
  const jn = $('joinName');                                   // 名字记忆：上次填过的自动带回
  if (jn && !jn.value) jn.value = localStorage.getItem('sd_name') || '';
  const jst = $('signalJoinStatus'); if (jst) jst.textContent = '';
  signalHintOk('正在检查信令服务器…', false);
  for (const id of ['btnSignalHost', 'btnSignalJoin']) { const b = $(id); if (b) b.classList.add('hidden'); }
  waitSignal();
  $('joinStatus').textContent = '';
};
$('btnBackFromJoin').onclick = () => location.reload();

$('btnGenAnswer').onclick = async () => {
  // 名字必填：房主靠它辨认谁是谁（分配阵营、今后的击杀提示都要用）
  const nm = cleanName($('joinName') && $('joinName').value);
  if (!nm) {
    $('joinStatus').textContent = '请先填写你的名字（房主据此分配阵营，名字会随应答码一起发送）';
    const el = $('joinName'); if (el) el.focus();
    return;
  }
  const offer = $('taOfferJoin').value.trim();
  if (!offer) { $('joinStatus').textContent = '请先粘贴好友的邀请码！'; return; }
  setMyName(nm);
  localStorage.setItem('sd_name', nm);   // 记住名字，下次自动带回
  $('joinStatus').textContent = '正在生成应答码…';
  const n = new Net();
  wireNet(n, myPeerId);
  try {
    const answer = await n.join(offer, nm);
    setHostNameHint(n.remoteName || '');   // 从邀请码里解出的房主名字
    $('taAnswerJoin').value = answer;
    $('joinStatus').textContent = '应答码已生成！' + (hostNameHint ? '（房主：' + hostNameHint + '）' : '')
      + ' 复制发给好友，好友粘贴后即可连上。';
    // roster 在 onPeerOpen 里加
  } catch (e) {
    $('joinStatus').textContent = '失败：' + e.message;
  }
};
$('copyAnswer').onclick = () => {
  $('taAnswerJoin').select();
  document.execCommand('copy');
  $('joinStatus').textContent = '已复制到剪贴板！';
};

export function beginMatch() {
  clearInterval(mapLobbyTimerId);
  clearTimeout(pickTimer); setPickTimer(null);
  setPickPhase(false); setMyPickSide(-1); setPickDealPending(false);
  clearKillFeed();
  $('pickPanel').classList.add('hidden');
  clearMenuProps();   // 清理菜单展示实体，进入对局
  STATE.started = true;
  menu.classList.add('hidden');
  hud.classList.remove('hidden');
  if (IS_ANDROID_APP) { setVoiceBtnsVisible(mode === 'net'); $('touchUI').classList.add('on'); syncVoiceBtn(); }   // 练习模式不显示语音按钮；触屏 UI 仅安卓 App
  STATE.myScore = 0; STATE.foeScore = 0; STATE.s0 = 0; STATE.s1 = 0; STATE.roundNum = 0; STATE.matchEnded = false;
  setKillCount(0); resetKillLedger();
  if (mode !== 'practice') buildAllUnits();
  updateScore();
  nextRound();
  banner('对决开始 · 五局三胜', '#dff1ff', 2.4);
  lockPointer();
}

/* 相机（updateCamera）已移至 js/camera.js（v3.4.1）；aimYaw/aimPitch/zoom 迁入 state.js（输入层写 / 相机读） */
