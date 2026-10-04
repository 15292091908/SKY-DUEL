// 苍穹对决 · 信令层（房间码组队）
//
// 三种联机方式并存：
//   ① 信令房间码（本文件）——默认走**公共 MQTT broker**（WSS，免密钥免部署），
//      若用 `?signal=<url>` / localStorage('sd_signal') 指定了自部署地址，则改走 HTTP 版（server/serve.js）。
//   ② 手动交换邀请码/应答码（js/net.js + main.js）——完全不依赖任何服务器，永远保底。
//   ③ 人机练习（不需要联机）。
//
// 对外 API 与传输无关（main.js 不感知用的是 MQTT 还是 HTTP）：
//   signalProbe() signalCreate() signalHostPoll() signalHostOffer()
//   signalJoin() signalJoinPoll() signalJoinAnswer() makeRoomCode() signalShutdown()
//
// 信令协议（两种传输语义一致）：
//   host   : 建房（订阅房间主题）
//   join   : 加入方登记 {id,name}
//   offer  : 房主 → 该加入方（带房主名字）
//   answer : 加入方 → 房主
// MQTT 侧主题： skyduel/<APP_KEY>/v1/<房间码>/join | /to/<id> | /answer
//
// 隐私提示：公共 broker 是第三方基础设施，SDP（含内网 IP）会经过它；
// 房间主题含固定应用前缀 + 6 位码，理论上可被猜到。介意的话用自部署 HTTP 版或手动交换。

import { MqttMini, PUBLIC_BROKERS } from './mqttmini.js?v=1459';

const APP_KEY = 'sd7f3a9q';                       // 应用命名空间（降低被无关方扫到的概率）
const ROOM = (code) => 'skyduel/' + APP_KEY + '/v1/' + code;   // 无尾斜杠
const T = (code, sub) => ROOM(code) + '/' + sub;
const HTTP_PROBE_MS = 4000;                       // 自部署 HTTP 版探测超时
const MQTT_PROBE_MS = 15000;                      // 公共 broker 探测整体上限（单 broker 4.5s × 3 个候选，留足余量）
const PROBE_TRIES = 2;
const POLL_MS = 6000;

// ================= 传输选择 =================
// 指定了自部署地址 → 用 HTTP；否则默认公共 MQTT（免部署）。
export function signalUrl() {
  try {
    const q = new URLSearchParams(location.search).get('signal');
    if (q) { localStorage.setItem('sd_signal', q); return q; }
    const s = localStorage.getItem('sd_signal');
    if (s) return s;
  } catch (e) { /* 隐私模式 */ }
  return null;                                    // null = 走公共 MQTT
}

// ================= HTTP 传输（自部署：server/serve.js） =================
async function post(body, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || POLL_MS);
  try {
    const r = await fetch(signalUrl(), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: ctl.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
const httpProbe = async () => { try { const d = await post({ a: 'ping' }, HTTP_PROBE_MS); return !!(d && d.ok); } catch (e) { return false; } };
const httpCreate = (code, name, cap) => post({ a: 'host', code, name, cap }, HTTP_PROBE_MS * 2);
const httpHostPoll = (code) => post({ a: 'hpoll', code });
const httpOffer = (code, to, offer) => post({ a: 'offer', code, to, offer }, HTTP_PROBE_MS * 2);
const httpJoin = (code, name) => post({ a: 'join', code, name }, HTTP_PROBE_MS * 2);
const httpJoinPoll = (code, id) => post({ a: 'jpoll', code, id });
const httpAnswer = (code, id, answer) => post({ a: 'answer', code, id, answer }, HTTP_PROBE_MS * 2);

// ================= MQTT 传输（默认：公共 broker，免部署） =================
const mq = {
  cli: null, broker: null, code: null, cap: 1,
  joins: [], answers: [], offer: null, hostName: '',
  pending: {},          // joinerId -> { offer, at, tries }（offer 未收到 answer 时重发）
  joinTries: 0, lastJoinAt: 0, beaconTs: 0, lastBeaconAt: 0,
};

// broker 尝试顺序：上次连通过的排最前（公共 broker 偶发限流，反复重连会加剧被限流）
function brokerOrder() {
  let last = null;
  try { last = localStorage.getItem('sd_broker'); } catch (e) { /* 隐私模式 */ }
  const list = PUBLIC_BROKERS.slice();
  if (last && list.indexOf(last) >= 0) { list.splice(list.indexOf(last), 1); list.unshift(last); }
  return list;
}
function rememberBroker(url) { try { localStorage.setItem('sd_broker', url); } catch (e) { /* 忽略 */ } }

async function mqttEnsure() {
  if (mq.cli && mq.cli.connected) return mq.cli;
  for (const url of brokerOrder()) {
    const c = new MqttMini(url, { clientId: 'sd_' + Math.random().toString(36).slice(2, 12), connectTimeout: 9000 });
    try { await c.connect(); mq.cli = c; mq.broker = url; rememberBroker(url); return c; } catch (e) { /* 试下一个 */ }
  }
  return null;
}
function mqttOnMessage(topic, payload) {
  let d = null; try { d = JSON.parse(payload); } catch (e) { return; }
  if (d.a === 'beacon') { mq.beaconTs = d.ts || 0; mq.hostName = d.name || ''; return; }
  if (d.a === 'join') { if (!mq.joins.some(x => x.id === d.id)) mq.joins.push({ id: d.id, name: d.name || '' }); return; }
  if (d.a === 'offer') { mq.offer = d.offer; mq.hostName = d.hostName || ''; return; }
  if (d.a === 'answer') { mq.answers.push({ id: d.id, answer: d.answer }); return; }
}

// ================= 对外 API =================
// 探测：true = 房间码可用（自部署 HTTP 或公共 broker 至少一个通）
export async function signalProbe() {
  if (signalUrl()) {                                  // 指定了自部署 → 只看它
    for (let i = 0; i < PROBE_TRIES; i++) if (await httpProbe()) return true;
    return false;
  }
  // 公共 broker：多 broker 依次尝试，整体不超过 MQTT_PROBE_MS（避免三个都超时拖太久）
  const cap = new Promise(r => setTimeout(() => r(null), MQTT_PROBE_MS));
  for (let i = 0; i < PROBE_TRIES; i++) {
    const c = await Promise.race([mqttEnsure(), cap]);
    if (c) return true;
    if (c === null && i === 0) { /* 整体超时，直接判定 */ break; }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// 房主：建房（订阅房间主题 + 发保留信标，让加入方能找到自己所在的 broker）
export async function signalCreate(code, name, cap) {
  mq.code = code; mq.cap = cap || 1;
  if (signalUrl()) return httpCreate(code, name, cap);
  mq.joins.length = 0; mq.answers.length = 0; mq.pending = {};
  const c = await mqttEnsure();
  if (!c) return { ok: false, err: 'no-broker' };
  c.onMessage = mqttOnMessage;
  c.subscribe(ROOM(code) + '/#');
  await new Promise(r => setTimeout(r, 500));          // 等 SUBACK 生效再开始宣传
  // 保留信标（retained）：加入方逐个 broker 探测"房主在哪个"，确保双方汇到同一个 broker
  // （公共 broker 抖动时两端若各自"连第一个连上的"，会各连各的永远碰不上——实测踩过）
  c.publish(T(code, 'beacon'), JSON.stringify({ a: 'beacon', name, ts: Date.now() }), true);
  mq.lastBeaconAt = Date.now();
  return { ok: true, code };
}

// 房主：刷新保留信标（main.js 每 tick 调用，内部 5s 节流；ts 供加入方拒绝陈旧房间）
export function signalBeaconRefresh(code, name) {
  if (signalUrl() || !mq.cli || !mq.cli.connected) return;
  const now = Date.now();
  if (now - mq.lastBeaconAt < 5000) return;
  mq.cli.publish(T(code, 'beacon'), JSON.stringify({ a: 'beacon', name: name || '', ts: now }), true);
  mq.lastBeaconAt = now;
}

// 房主：取出新加入者 / 新应答；顺带重发未被应答的 offer（QoS0 会丢包）
export async function signalHostPoll(code) {
  if (signalUrl()) return httpHostPoll(code);
  if (!mq.cli) return { ok: false, err: 'no-broker' };
  const now = Date.now();
  for (const id in mq.pending) {
    const p = mq.pending[id];
    if (now - p.at > 2500 && p.tries < 6) {            // 2.5s 没收到 answer → 重发 offer
      mq.cli.publish(T(code, 'to/' + id), JSON.stringify({ a: 'offer', offer: p.offer, hostName: p.hostName }));
      p.at = now;
      p.tries++;
    }
  }
  const joins = mq.joins.splice(0, mq.joins.length);
  const answers = mq.answers.splice(0, mq.answers.length);
  return { ok: true, joins, answers, count: joins.length, cap: mq.cap };
}

// 房主：给某加入者发 offer
export async function signalHostOffer(code, to, offer, hostName) {
  if (signalUrl()) return httpOffer(code, to, offer);
  if (!mq.cli) return { ok: false, err: 'no-broker' };
  mq.cli.publish(T(code, 'to/' + to), JSON.stringify({ a: 'offer', offer, hostName: hostName || '' }));
  mq.pending[to] = { offer, hostName: hostName || '', at: Date.now(), tries: 0 };
  return { ok: true };
}

// 加入方：逐个 broker 找房主的保留信标 → 与房主汇到同一个 broker → 订阅收件主题 → 发布 join
export async function signalJoin(code, name) {
  if (signalUrl()) return httpJoin(code, name);
  mq.offer = null; mq.hostName = ''; mq.joinTries = 0; mq.beaconTs = 0;
  let reached = 0;
  for (const url of brokerOrder()) {
    const c = new MqttMini(url, { clientId: 'sd_' + Math.random().toString(36).slice(2, 12), connectTimeout: 9000 });
    try { await c.connect(); } catch (e) { continue; }
    reached++;
    c.onMessage = mqttOnMessage;
    mq.beaconTs = 0;
    c.subscribe(T(code, 'beacon'));
    await new Promise(r => setTimeout(r, 1200));     // retained 信标订阅即达，稍等即可判定
    if (!mq.beaconTs || Date.now() - mq.beaconTs > 60000) {   // 此 broker 上没有新鲜信标 → 换下一个
      c.close(); continue;
    }
    mq.cli = c; mq.broker = url; mq.code = code; rememberBroker(url);
    const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    c.subscribe(T(code, 'to/' + id));
    await new Promise(r => setTimeout(r, 400));
    c.publish(T(code, 'join'), JSON.stringify({ a: 'join', id, name }));
    mq.lastJoinAt = Date.now(); mq.joinStartAt = Date.now();
    return { ok: true, id, hostName: mq.hostName };
  }
  return { ok: false, err: reached ? 'no-room' : 'no-broker' };
}

// 加入方：等 offer（没等到就重发 join，最多 12 次）
export async function signalJoinPoll(code, id) {
  if (signalUrl()) return httpJoinPoll(code, id);
  if (!mq.cli) return { ok: false, err: 'no-broker' };
  if (!mq.offer) {
    if (Date.now() - (mq.joinStartAt || 0) > 25000) return { ok: false, err: 'dead' };   // 房主始终没发 offer：房间多半已关
    if (Date.now() - mq.lastJoinAt > 1600 && mq.joinTries < 12) {   // 房主可能还没订阅好 → 重发
      mq.cli.publish(T(code, 'join'), JSON.stringify({ a: 'join', id, name: '' }));
      mq.lastJoinAt = Date.now();
      mq.joinTries++;
    }
    return { ok: true, offer: null, hostName: '' };
  }
  return { ok: true, offer: mq.offer, hostName: mq.hostName };
}

// 加入方：回传 answer
export async function signalJoinAnswer(code, id, answer) {
  if (signalUrl()) return httpAnswer(code, id, answer);
  if (!mq.cli) return { ok: false, err: 'no-broker' };
  mq.cli.publish(T(code, 'answer'), JSON.stringify({ a: 'answer', id, answer }));
  return { ok: true };
}

// 收尾：离开面板/进对局时调用（清掉保留信标 + 断开 broker，释放连接）
export function signalShutdown() {
  try { if (mq.cli && mq.code) mq.cli.publish(T(mq.code, 'beacon'), '', true); } catch (e) { /* 忽略 */ }   // 空保留载荷 = 删除信标
  try { if (mq.cli) mq.cli.close(); } catch (e) { /* 忽略 */ }
  mq.cli = null; mq.code = null; mq.offer = null; mq.hostName = '';
  mq.joins.length = 0; mq.answers.length = 0;
  for (const k in mq.pending) delete mq.pending[k];
}

// 6 位数字房间码（纯数字，手机输入法最省事）
export function makeRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}
