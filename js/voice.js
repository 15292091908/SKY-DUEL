// js/voice.js — 联机语音通话（v3.4 从 main.js 抽出）
/* 架构：星型经房主转发——非房主只把语音发给房主，房主转给其他所有人（不含发送者）并本地播放；
   房主自己的语音直接广播。发送是定向的，结构上保证永远听不到自己的声音。
   传输：state 通道（不可靠、不保序、零重传）——语音容忍丢包但要低延迟；自带 seq，
   接收端 80ms 重排窗 + 抖动缓冲（丢包跳过不阻塞，积压 >400ms 丢弃保时效）。
   采样：16kHz 单声道 Int16（40ms/包 640 采样），JSON 内 base64 携带（净荷 ~32KB/s，人声足够听清）。 */
import { mode, roster, myPeerId, iAmHost, nets } from './state.js?v=1516';
import { VOICE_RATE, VOICE_CHUNK } from './config.js?v=1516';
import { isTouch } from './core.js?v=1516';
import { $, banner } from './hud.js?v=1516';

let micOn = false, voiceRxOn = true;
let voiceCtx = null, micStream = null, micSrc = null, micProc = null, micSink = null;
let micHP = null, micLP = null, micGateT = 0;   // 语音频带滤波 + 噪声门保持时间
let micArmT = 0;                                // 开麦后的预热截止时刻（AEC 收敛窗口）
let voiceSeq = 0;                       // 发送端语音包序号（会话内单调递增，麦克风重开不复位）
let micAcc = [];                        // 重采样后的样本累积（凑满 40ms 一包）
let voiceTalk = {};                     // 各端最近说话时间（HUD 讲话指示）
const voiceRx = {};                     // 接收端抖动缓冲：id -> {pending:Map, nextSeq, nextTime, firstT}
let voiceFlushTimer = null;

const voiceHud = document.createElement('div');
voiceHud.style.cssText = 'position:fixed;top:' + (isTouch ? '92px' : '12px') + ';right:14px;z-index:60;font:600 12px/1.4 "Noto Sans SC","PingFang SC",sans-serif;color:#1c2b3a;background:rgba(255,255,255,.8);backdrop-filter:blur(8px);border:1px solid rgba(28,43,58,.14);border-radius:999px;padding:6px 13px;display:none;box-shadow:0 2px 12px rgba(28,43,58,.10);pointer-events:none;';
document.body.appendChild(voiceHud);
setInterval(() => {
  if (mode !== 'net') { voiceHud.style.display = 'none'; return; }
  const now = performance.now();
  const talking = [];
  for (const id in voiceTalk) if (now - voiceTalk[id] < 500) talking.push(id);
  if (!micOn && voiceRxOn && !talking.length) { voiceHud.style.display = 'none'; return; }
  let names = '';
  if (talking.length) {
    names = ' · 🗣 ' + talking.map((id) => {
      const idx = roster.findIndex((p) => p.peerId === id);
      return '玩家' + String.fromCharCode(65 + Math.max(0, idx));
    }).join('、');
  }
  voiceHud.textContent = '🎤' + (micOn ? '开' : '关') + (isTouch ? '' : '(T)') + ' · 🔊' + (voiceRxOn ? '开' : '关') + (isTouch ? '' : '(Y)') + names;
  voiceHud.style.display = 'block';
}, 150);

function b64FromBytes(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToI16(s) {
  const bin = atob(s), out = new Int16Array(bin.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = (bin.charCodeAt(i * 2 + 1) << 8) | bin.charCodeAt(i * 2);   // 小端
  return out;
}
function ensureVoiceCtx() {
  if (!voiceCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    voiceCtx = new AC();
    voiceFlushTimer = setInterval(() => { for (const id in voiceRx) flushVoice(id, true); }, 50);   // 丢包跳进定时器
  }
  if (voiceCtx.state === 'suspended') voiceCtx.resume();
}
/* iOS/Android 浏览器要求 AudioContext 必须在「用户手势」里创建/恢复，
   否则会一直是 suspended —— 表现为手机上完全听不到队友语音（收包时才创建的上下文已经错过手势）。
   这里在联机模式下任意一次触摸/点击里预热上下文，并用一个静音 buffer 解锁 iOS 音频。 */
let voicePrimed = false;
function primeVoiceCtx() {
  if (mode !== 'net') return;
  ensureVoiceCtx();
  if (!voiceCtx) return;
  if (voiceCtx.state === 'suspended') voiceCtx.resume().catch(() => {});
  if (!voicePrimed) {
    try {   // iOS 解锁：手势内播放一个 1 采样静音源
      const buf = voiceCtx.createBuffer(1, 1, 22050);
      const src = voiceCtx.createBufferSource();
      src.buffer = buf; src.connect(voiceCtx.destination); src.start(0);
      voicePrimed = true;
    } catch (e) {}
  }
}
document.addEventListener('touchstart', primeVoiceCtx, { passive: true });
document.addEventListener('pointerdown', primeVoiceCtx, { passive: true });
// 线性插值重采样 → Int16（支持任意 ctx 采样率到 16k）
function resampleI16(f32, srcRate) {
  const ratio = srcRate / VOICE_RATE;
  const outLen = Math.floor(f32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio, i0 = pos | 0, i1 = Math.min(i0 + 1, f32.length - 1), fr = pos - i0;
    const s = f32[i0] * (1 - fr) + f32[i1] * fr;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  }
  return out;
}
export async function toggleMicSend() {
  if (mode !== 'net') { banner('语音仅联机模式可用', '#ffd27a', 2); return; }
  if (micOn) { stopMicSend(); return; }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    ensureVoiceCtx();
    micSrc = voiceCtx.createMediaStreamSource(micStream);
    micProc = voiceCtx.createScriptProcessor(2048, 1, 1);
    micSink = voiceCtx.createGain(); micSink.gain.value = 0;   // 静音汇点：Processor 必须连到 destination 才工作，但绝不能外放（防啸叫）
    // 电话频带整形：高通 180Hz 砍掉引擎/爆炸的低频轰鸣（最容易糊成"杂音"的那部分），
    // 低通 3.4kHz 保住人声清晰度的同时削掉高频噪声
    micHP = voiceCtx.createBiquadFilter(); micHP.type = 'highpass'; micHP.frequency.value = 180;
    micLP = voiceCtx.createBiquadFilter(); micLP.type = 'lowpass'; micLP.frequency.value = 3400;
    micSrc.connect(micHP); micHP.connect(micLP); micLP.connect(micProc);
    micProc.connect(micSink); micSink.connect(voiceCtx.destination);
    micProc.onaudioprocess = (e) => {
      if (!micOn) return;
      if (performance.now() < micArmT) { micAcc.length = 0; return; }   // AEC 收敛窗口内不发包（见上）
      const inp = e.inputBuffer.getChannelData(0);
      // 噪声门：低电平（扬声器串音、被麦克风拾取的游戏音效）直接不发包；
      // 350ms 保持时间避免说话间隙被切断
      let sum = 0, n = 0;
      for (let i = 0; i < inp.length; i += 4) { sum += inp[i] * inp[i]; n++; }
      const rms = Math.sqrt(sum / Math.max(1, n));
      const now = performance.now();
      if (rms > 0.02) micGateT = now;
      if (now - micGateT > 350) { micAcc.length = 0; return; }
      const res = resampleI16(inp, voiceCtx.sampleRate);
      for (let i = 0; i < res.length; i++) micAcc.push(res[i]);
      while (micAcc.length >= VOICE_CHUNK) sendVoiceChunk(new Int16Array(micAcc.splice(0, VOICE_CHUNK)));
    };
    micOn = true;
    // 预热窗口：浏览器的回声消除（AEC）需要先用一段本机播放信号"学习"回声路径才能抑制，
    // 收敛前（约 0.3~1.5s）麦克风拾取到的本机游戏音效会原样传出去——这正是"刚开麦时一阵嘈杂、
    // 内容明显是自己游戏里的枪声/引擎声、过一会儿就消失"的原因。这里在收敛期内不发包。
    micArmT = performance.now() + 600;
    syncVoiceBtn();
    banner(isTouch ? '麦克风已开启 · 点右上角「麦克风」可关闭' : '麦克风已开启 · 按 T 关闭', '#7CFC98', 2);
  } catch (err) {
    syncVoiceBtn();
    banner('麦克风开启失败：' + (err.name === 'NotAllowedError' ? '未授权（请在浏览器允许麦克风权限）' : err.message), '#ff7a6b', 3.4);
  }
}
export function stopMicSend() {
  micOn = false;
  if (micStream) { for (const t of micStream.getTracks()) t.stop(); micStream = null; }
  if (micProc) { micProc.onaudioprocess = null; try { micProc.disconnect(); } catch (e) {} micProc = null; }
  if (micSrc) { try { micSrc.disconnect(); } catch (e) {} micSrc = null; }
  if (micSink) { try { micSink.disconnect(); } catch (e) {} micSink = null; }
  if (micHP) { try { micHP.disconnect(); } catch (e) {} micHP = null; }
  if (micLP) { try { micLP.disconnect(); } catch (e) {} micLP = null; }
  micGateT = 0;
  micArmT = 0;
  micAcc.length = 0;
  syncVoiceBtn();
  banner(isTouch ? '麦克风已关闭' : '麦克风已关闭 · 按 T 开启', '#ffd27a', 2);
}
export function toggleVoiceRx() {
  if (mode !== 'net') { banner('语音仅联机模式可用', '#ffd27a', 2); return; }
  voiceRxOn = !voiceRxOn;
  syncVoiceBtn();
  banner(voiceRxOn ? (isTouch ? '收音已开启' : '收音已开启 · 按 Y 关闭') : (isTouch ? '收音已关闭' : '收音已关闭 · 按 Y 开启'), voiceRxOn ? '#7CFC98' : '#ffd27a', 2);
}
// 手机端语音按钮显隐（练习模式没有联机语音，不应出现这两个按钮）
export function setVoiceBtnsVisible(show) {
  const bm = $('btnMic'), br = $('btnRx');
  const v = show ? 'flex' : 'none';
  if (bm) bm.style.display = v;
  if (br) br.style.display = v;
}
// 手机端语音按钮状态同步（桌面端没有这两个按钮，元素不存在则跳过）
export function syncVoiceBtn() {
  const bm = $('btnMic'), br = $('btnRx');
  if (!bm && !br) return;
  const m = !!micOn, r = !!voiceRxOn;
  if (bm) { bm.classList.toggle('on', m); bm.textContent = m ? '麦克风 开' : '麦克风'; }
  if (br) { br.classList.toggle('on', r); br.textContent = r ? '收听 开' : '收听'; }
}
function sendVoiceChunk(i16) {
  if (!voiceCtx || Object.keys(nets).length === 0) return;
  // 非房主的 nets 只有房主一条 → 这行天然就是"定向发给房主"；房主的 nets 是所有玩家 → 天然广播
  const msg = { t: 'voice', from: myPeerId, seq: ++voiceSeq, v: b64FromBytes(new Uint8Array(i16.buffer)) };
  for (const id in nets) if (nets[id].connected) nets[id].sendState(msg);
}
// 收到语音包：房主转发给其他所有人（不含发送者，防回声）+ 本地播放；非房主只播放
export function onVoiceMsg(rid, d) {
  const from = d.from || rid;
  if (from === myPeerId) return;   // 双保险：结构上已不会收到自己的声音
  if (iAmHost) {
    for (const id in nets) {
      if (id === from || !nets[id].connected) continue;
      nets[id].sendState({ t: 'voice', from, seq: d.seq, v: d.v });
    }
  }
  if (!voiceRxOn) return;          // 收音关：转发义务照尽，本地不播
  voiceTalk[from] = performance.now();
  playVoiceChunk(from, d.seq | 0, d.v);
}
// 玩家掉线清理：丢弃该端的抖动缓冲与讲话指示（原 main.js removePeerLocal 里的两行 delete）
export function voiceDropPeer(peerId) {
  delete voiceRx[peerId];
  delete voiceTalk[peerId];
}
function playVoiceChunk(from, seq, b64) {
  ensureVoiceCtx();
  let rx = voiceRx[from];
  if (!rx) rx = voiceRx[from] = { pending: new Map(), nextSeq: -1, nextTime: 0, firstT: 0 };
  if (rx.nextSeq < 0) rx.nextSeq = seq;   // 首包对齐序号
  if (seq < rx.nextSeq) return;           // 迟到包：丢
  if (!rx.pending.has(seq)) rx.pending.set(seq, b64);
  flushVoice(from, false);
}
function flushVoice(from, force) {
  const rx = voiceRx[from];
  if (!rx || !voiceCtx) return;
  if (force && !rx.pending.has(rx.nextSeq) && rx.pending.size) {
    // 丢包推进：下一包 80ms 内没到 → 跳到已收到的最早包继续播（跳过的那段静音）
    const now = performance.now();
    if (!rx.firstT) rx.firstT = now;
    if (now - rx.firstT > 80) { rx.nextSeq = Math.min(...rx.pending.keys()); rx.firstT = 0; }
  }
  while (rx.pending.has(rx.nextSeq)) {
    const b64 = rx.pending.get(rx.nextSeq);
    rx.pending.delete(rx.nextSeq);
    rx.nextSeq++;
    rx.firstT = 0;
    scheduleVoice(rx, b64);
  }
}
function scheduleVoice(rx, b64) {
  try {
    const i16 = b64ToI16(b64);
    const buf = voiceCtx.createBuffer(1, i16.length, VOICE_RATE);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768;
    const now = voiceCtx.currentTime;
    if (rx.nextTime < now + 0.05) rx.nextTime = now + 0.05;   // 欠载：重新起步
    if (rx.nextTime > now + 0.4) rx.nextTime = now + 0.2;     // 积压过深：跳到较新位置（保时效）
    const src = voiceCtx.createBufferSource();
    src.buffer = buf; src.connect(voiceCtx.destination);
    src.start(rx.nextTime);
    rx.nextTime += i16.length / VOICE_RATE;
  } catch (e) {}
}
