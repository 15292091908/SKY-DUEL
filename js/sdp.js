// js/sdp.js — 联机连接层（v3.4.1 从 main.js 抽出）
// 手动 SDP 交换（邀请码/应答码逐个连接）+ 信令房间码（并行，失败回退手动）+ 延迟门槛（80ms 踢出）+ beginMatch 开局。
import { modeField, modeMeta } from './mode.js?v=1543';   // 「游戏内」模式模块（阵营预分策略 / 模式名提示）
import { backToMenu } from './reset.js?v=1543';           // 软重置（返回菜单不刷新）
import {
  STATE, roster, nets, mode, gamemode, iAmHost, myPeerId, myTeam, netSize, pingProbe,
  setMode, setIAmHost, setMyTeam, setMySlot, setNetSize, setRoster, setMyName, setHostNameHint,
  hostNameHint, myName, mapLobbyTimerId, pickTimer, setPickTimer, setPickPhase, setMyPickSide, setPickDealPending, setKillCount,
} from './state.js?v=1543';
import { PING_SAMPLES, PING_KICK_MS, PING_RETRY_ROUNDS, DM_KILL_TARGET, DM_KILL_TARGET_MIN, DM_KILL_TARGET_MAX } from './config.js?v=1543';
import { Net, cleanName } from './net.js?v=1543';
import {
  signalProbe, signalShutdown, signalCreate, makeRoomCode, signalHostPoll, signalHostOffer,
  signalBeaconRefresh, signalJoin, signalJoinPoll, signalJoinAnswer, signalJoinDone,
} from './signal.js?v=1543';
import { netSendEventTo, removePeerLocal, broadcastRoster, wireNet, netBroadcast } from './netev.js?v=1543';
import { hideAllPanels, showMenuBox, startMapLobby } from './lobby.js?v=1543';
import { checkRoundEnd, resetKillLedger } from './combat.js?v=1543';
import { $, menuToast, clearKillFeed, hud, menu, banner, updateScore } from './hud.js?v=1543';
import { audio, IS_ANDROID_APP } from './core.js?v=1543';
import { clearMenuProps } from './scene3d.js?v=1543';
import { setVoiceBtnsVisible, syncVoiceBtn } from './voice.js?v=1543';
import { buildAllUnits } from './units.js?v=1543';
// main.js（循环依赖：仅运行时函数调用）
import { nextRound, lockPointer } from './match.js?v=1543';

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
  initHostRules();   // 对局模式卡（歼灭/死斗）按上次选择回显
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
$('btnBackFromHost').onclick = () => backToMenu();

/* ===== 对局模式（v3.15）：歼灭（五局三胜）/ 死斗（先到 N 杀，N 可自由调节） =====
   只改房主自己的 STATE；加入方在 team（首次分配阵营）与 cfg（改规则/开局对齐）报文里拿同一份。
   规则本身在 combat.js：死斗不走回合制，死亡 3 秒后重生、按队伍累计击杀判胜。 */
function clampKillTarget(v) {
  const n = Math.round(Number(v));
  if (!isFinite(n)) return DM_KILL_TARGET;
  return Math.max(DM_KILL_TARGET_MIN, Math.min(DM_KILL_TARGET_MAX, n));
}
function paintHostRules() {
  document.querySelectorAll('#hostMatchTypeChoice .sizeCard').forEach((c) => {
    c.classList.toggle('sel', (c.dataset.mt || 'elim') === STATE.matchType);
  });
  const v = clampKillTarget(STATE.killTarget || DM_KILL_TARGET);
  const num = $('hostKillTargetNum'), rng = $('hostKillTargetRange');
  if (num && document.activeElement !== num) num.value = String(v);   // 正在输入时不抢光标
  if (rng) rng.value = String(v);
  const row = $('hostKillTargetRow');
  if (row) row.classList.toggle('hidden', STATE.matchType !== 'dm');
}
function initHostRules() {
  if (STATE.matchType !== 'dm') STATE.matchType = 'elim';
  STATE.killTarget = clampKillTarget(STATE.killTarget || DM_KILL_TARGET);
  paintHostRules();
}
let cfgPushTimer = null;
function pushHostRules(immediate) {
  if (!(mode === 'net' && iAmHost)) return;
  STATE.killTarget = clampKillTarget(STATE.killTarget);   // 发出去之前夹紧，别把 999 这种手滑值传给全房
  const send = () => netBroadcast({ t: 'cfg', mt: STATE.matchType, kt: STATE.killTarget });
  if (immediate) { if (cfgPushTimer) { clearTimeout(cfgPushTimer); cfgPushTimer = null; } send(); return; }
  if (cfgPushTimer) clearTimeout(cfgPushTimer);       // 拖动滑杆时合并成一条，别刷屏
  cfgPushTimer = setTimeout(() => { cfgPushTimer = null; send(); }, 150);
}
document.querySelectorAll('#hostMatchTypeChoice .sizeCard').forEach((card) => {
  card.onclick = () => {
    STATE.matchType = card.dataset.mt === 'dm' ? 'dm' : 'elim';
    STATE.killTarget = clampKillTarget(STATE.killTarget || DM_KILL_TARGET);
    paintHostRules();
    pushHostRules(true);     // 已经连上好友时改规则也要立刻同步（虽然正常流程是选完再发邀请码）
  };
});
/* 击杀目标：数字输入 + 滑杆 + 加减按钮（1~100 自由调节）。
   三个控件共享同一份 STATE.killTarget，改任何一个另外两个跟着动。 */
(function bindKillTargetControls() {
  const num = $('hostKillTargetNum'), rng = $('hostKillTargetRange');
  const minus = $('ktMinus'), plus = $('ktPlus');
  const set = (v, immediate) => {
    STATE.killTarget = clampKillTarget(v);
    if (num && document.activeElement !== num) num.value = String(STATE.killTarget);
    if (rng) rng.value = String(STATE.killTarget);
    pushHostRules(immediate);
  };
  if (num) {
    num.oninput = () => {                       // 输入过程允许暂时越界，不打断打字
      const v = parseInt(num.value, 10);
      if (isFinite(v)) { STATE.killTarget = v; if (rng) rng.value = String(Math.max(DM_KILL_TARGET_MIN, Math.min(DM_KILL_TARGET_MAX, v))); pushHostRules(false); }
    };
    num.onchange = () => set(num.value, true);  // 失焦/回车 → 夹紧并回显
    num.onblur = () => set(num.value, true);
  }
  if (rng) rng.oninput = () => set(rng.value, false);
  if (minus) minus.onclick = () => set((STATE.killTarget || DM_KILL_TARGET) - 1, true);
  if (plus) plus.onclick = () => set((STATE.killTarget || DM_KILL_TARGET) + 1, true);
})();

// 已完成 hello 握手的加入方数（team 已分配 = hello 已到）。
// ⚠ 不能用 Object.keys(nets).length：wireNet 一建立就占位，房间码流程会因此提前判定"人齐"
// 而停掉轮询 → 应答码永远收不回来 → 玩家端"显示连接成功但进不了游戏"（实测踩过）。
function helloJoiners() { return roster.filter(p => p.peerId !== myPeerId && p.team >= 0).length; }
/* v3.11.1：延迟检测通过才算「就绪」。
   ★ 必须等 ping 通过才允许进入选图/选阵营：否则最后一名玩家刚连上就开局，
     约 540ms 后延迟判定不通过把他踢掉，房主正选到一半会被 onPeerClose 的
     「有人掉线，全员回大厅」打回大厅（1v1 与 3v3/5v5 都会中招）。 */
const pingPass = {};       // 房主：已通过延迟检测的 peerId
const kickedPeers = {};    // 房主：主动踢出的 peerId（onPeerClose 据此不缩编，仍按原规模等替补）
function readyJoiners() { return roster.filter(p => p.peerId !== myPeerId && p.team >= 0 && pingPass[p.peerId]).length; }
export function isKickedPeer(id) { return !!kickedPeers[id]; }
/* ===== v3.0 延迟门槛：连接建立后房主采样 RTT，超限直接移出房间 =====
   多次采样的原因：ICE 刚接通时首包受协商/抖动影响偏大，取多次最小值最接近真实 RTT。
   为什么要有门槛：本作把命中判定权交给开火者（房主只做位置校验），两端延迟越低，
   "开火者画面里的目标位置"与"房主权威位置"的偏差越小，判定越公平。 */
export function hostPingCheck(id) {
  if (!iAmHost || mode !== 'net') return;
  if (pingProbe[id] || pingPass[id]) return;                  // 已在探测 / 已通过
  const pr = pingProbe[id] = { samples: [], sent: 0, timer: null, round: 0 };
  const step = () => {
    if (!nets[id]) { delete pingProbe[id]; return; }           // 已断开
    if (pr.sent >= PING_SAMPLES) {                             // 采样结束 → 判定
      clearTimeout(pr.timer);
      const best = pr.samples.length ? Math.min.apply(null, pr.samples) : 0;
      // ★ v3.12：不达标不立刻踢，先补采一轮。
      //   连接刚建立时对端可能正在做首帧渲染 / GC / 加载模式包，pong 被主线程卡住 →
      //   RTT 采样虚高（这不是网络问题）。一轮 540ms 的窗口太短，必须给第二次机会；
      //   两轮都不达标才判定为真实网络问题（此时踢人不会冤枉人）。
      if (pr.samples.length && best >= PING_KICK_MS && pr.round < PING_RETRY_ROUNDS) {
        pr.round++; pr.samples = []; pr.sent = 0;
        pr.timer = setTimeout(step, 1000);
        return;
      }
      delete pingProbe[id];
      if (pr.samples.length && best >= PING_KICK_MS) { kickPeer(id, best); return; }
      pingPass[id] = true;
      updateHostStatus();   // ★ 通过后才可能「人齐」→ 这时才进选图/选阵营
      return;
    }
    pr.sent++;
    netSendEventTo(id, { t: 'ping', ts: performance.now() });   // 复用 ping/pong：对端原样回 ts，房主自算 RTT
    pr.timer = setTimeout(step, 180);
  };
  step();
}
/* 软重置时清掉探测/踢人/通过记录（v3.12）：这些都是「本次房间」的临时状态，
   不清会跨房间残留（同页重开房时把上一轮通过/被踢的人当成已就绪）。 */
export function resetSdpState() {
  for (const k in pingProbe) { if (pingProbe[k] && pingProbe[k].timer) clearTimeout(pingProbe[k].timer); delete pingProbe[k]; }
  for (const k in pingPass) delete pingPass[k];
  for (const k in kickedPeers) delete kickedPeers[k];
}
// 房主：延迟过高 → 移出房间（先通知本人，再断连/清名单/提示房主）
function kickPeer(id, ms) {
  const entry = roster.find((p) => p.peerId === id) || {};
  const nm = entry.name || '一名玩家';
  const inMatch = !!STATE.started;
  kickedPeers[id] = true;                                   // 标记为「主动踢出」：onPeerClose 不再缩编
  netSendEventTo(id, { t: 'kick', reason: 'ping', ms: ms | 0 });
  setTimeout(() => {
    if (nets[id]) { try { nets[id].close(); } catch (e) {} }
    delete pingPass[id];
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
  const ready = readyJoiners();
  if (ready >= need) {
    $('hostStatus').textContent = '已全部连接(' + connected + '/' + need + ')，准备开局！';
    startMapLobby();   // 星型架构：无 mesh 名单广播，人齐且延迟达标才进入选图/选阵营
  } else if (connected >= need) {
    // ★ 人都连上了、但延迟检测还没结束：先别进选图/选阵营，
    //   否则检测不通过被踢会把房主从选人界面打回大厅（v3.11.1）
    $('hostStatus').textContent = '正在检测网络延迟…（' + ready + '/' + need + ' 已通过）';
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
/* HTML 转义（v3.12 安全修复）：房主状态栏要显示 <b>房间码</b>，所以走 innerHTML；
   但同一行里还拼了「加入者名字」——它来自公共 MQTT broker 的 join 报文，
   是**完全不可信输入**（任何人知道 6 位房间码就能往该房间主题发 join）。不转义就是 XSS。
   其它用到玩家名字的地方（击杀播报/头顶标记/选人卡片/战绩表）都走 textContent 或已转义。 */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
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
    signalHostStatus('房间码 <b>' + signalRoom + '</b> · 正在为「' + esc(cleanName(j.name) || '玩家') + '」建立连接…');
    try { await signalHostOffer(signalRoom, j.id, await net.createOffer(myName, gamemode), myName); }
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
  const need = netSize - 1, conn = helloJoiners(), ready = readyJoiners();
  if (ready >= need) { stopSignalHost(); return; }                           // 人齐且延迟达标：后续由 hello/updateHostStatus 接管
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
    const answer = await n.join(d.offer, myName, gamemode);
    await signalJoinAnswer(signalJoinCode, signalJoinId, answer);
    signalJoinDone();                      // v3.12：应答已送达 → 释放 broker 长连接（别再整局挂着）
    $('taAnswerJoin').value = answer;      // 同步填进手动框，便于排查
    st.textContent = '应答已回传，正在建立 P2P 连接…';
  } catch (e) {
    if (e.code === 'mode-mismatch') {
      const h = modeMeta(e.remoteGm), m = modeMeta(gamemode);
      st.textContent = '玩法不一致：房主开的是「' + (h ? h.name : e.remoteGm) + '」，你选的是「'
        + (m ? m.name : gamemode) + '」——请把模式切到一致后再加入。';
      return;
    }
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
    const offer = await hostNet.createOffer(myName, gamemode);
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
  const netRef = hostNet;   // ★ 捕获当前这条连接：多人时 btnGenOffer 会覆盖 hostNet，
                            //   下面 await 回来若读全局变量，会读到下一条新连接的状态
  try {
    await netRef.acceptAnswer(ans);
    // ★ 只在还没接通时写这句：acceptAnswer 内部要等 ICE 收集（最多 3.5s），
    //   如果 P2P 已经通了，hello → updateHostStatus 早就写出了更准确的状态
    //   （「已连接 N/need」「正在检测延迟…」「准备开局」），这里再写会把它们盖掉。
    // 只在「这条连接仍然有效、且还没接通」时写：被踢/取消后 nets 里已经没有它（或已 close），
    // 迟到的 await 不能把「已连接 N/need」「延迟过高已移出」这些新状态盖掉。
    const stillActive = !netRef.closed && nets[netRef.peerKey] === netRef;
    if (stillActive && !netRef.connected) {
      const nm = netRef.remoteName ? '「' + netRef.remoteName + '」' : '';
      $('hostStatus').textContent = '应答已接受' + (nm ? '（对方：' + nm + '）' : '') + '，等待 P2P 接通…';
    }
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
$('btnBackFromJoin').onclick = () => backToMenu();

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
    const answer = await n.join(offer, nm, gamemode);
    setHostNameHint(n.remoteName || '');   // 从邀请码里解出的房主名字
    $('taAnswerJoin').value = answer;
    $('joinStatus').textContent = '应答码已生成！' + (hostNameHint ? '（房主：' + hostNameHint + '）' : '')
      + ' 复制发给好友，好友粘贴后即可连上。';
    // roster 在 onPeerOpen 里加
  } catch (e) {
    if (e.code === 'mode-mismatch') {
      const h = modeMeta(e.remoteGm), m = modeMeta(gamemode);
      $('joinStatus').textContent = '玩法不一致：房主开的是「' + (h ? h.name : e.remoteGm) + '」，你选的是「'
        + (m ? m.name : gamemode) + '」——请先切到一致的模式再生成应答码。';
      return;
    }
    $('joinStatus').textContent = '失败：' + e.message;
  }
};
$('copyAnswer').onclick = () => {
  $('taAnswerJoin').select();
  document.execCommand('copy');
  $('joinStatus').textContent = '已复制到剪贴板！';
};

export function beginMatch() {
  // 新一场开始：清掉上一场遗留的指针锁降级状态（否则上一场降级过，本场再也不会弹「点击继续」）
  window.dispatchEvent(new Event('sd-match-start'));
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
  // 规则对齐（v3.15）：加入方最初那次 team 报文若丢了 mt/kt，这里再补一遍（team 与 round 都在事件通道上，顺序可靠）
  if (mode !== 'practice' && iAmHost) netBroadcast({ t: 'cfg', mt: STATE.matchType, kt: STATE.killTarget });
  updateScore();
  nextRound();
  banner(STATE.matchType === 'dm'
    ? '死斗开始 · 先到 ' + (STATE.killTarget || DM_KILL_TARGET) + ' 杀'
    : '对决开始 · 五局三胜', '#dff1ff', 2.4);
  lockPointer();
}

/* 相机（updateCamera）已移至 js/camera.js（v3.4.1）；aimYaw/aimPitch/zoom 迁入 state.js（输入层写 / 相机读） */
