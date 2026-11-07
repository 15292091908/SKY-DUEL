// 纯 Web Audio API 合成音效：引擎、风声、机炮、命中、受击、爆炸、告警、回合音乐
// [ANDROID] 音量补丁：默认音量读设置面板 localStorage('sd_settings').vol（0~1），未设置时与网页版一致 0.55
const VOL_DEFAULT = (() => { try { const s = JSON.parse(localStorage.getItem('sd_settings') || '{}'); const v = parseFloat(s.vol); return isNaN(v) ? 0.55 : Math.max(0, Math.min(1, v)); } catch (e) { return 0.55; } })();// v3.14：加入「声音传播」（按距离延迟，声速 343m/s）、多普勒音高、子弹/火箭擦身而过音效。
// v3.14.4：改成**声波球**模型 —— 以声源为球心、以 343m/s 膨胀的球面，听者碰到球面才播。
import { SPEED_OF_SOUND, SOUND_MAX_DIST, WHIZ_R, WHIZ_R_ROCKET } from './config.js?v=1543';

export class AudioEngine {
  constructor() {
    this.ready = false;
    this.muted = false;
    /* 待播的声波球：{ kind, x,y,z, t0, vel?, vol?, pitch?, big? }
       kind：'gun'（机炮/高射机枪）、'rocket'（火箭/炸弹出膛）、'boom'（爆炸）、'whizz'（擦身）
       —— 每种声音的合成参数完全不同，靠 kind 区分，互不串味。 */
    this.bubbles = [];
    this._lx = 0; this._ly = 0; this._lz = 0;
    this._rx = 1; this._ry = 0; this._rz = 0;
    this._hasListener = false;
  }

  init() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = VOL_DEFAULT;   // [ANDROID]
    this.master.connect(this.ctx.destination);
    this._nb = this._noiseBuffer(2);

    // 引擎轰鸣：锯齿波 + 方波 经低通
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 1.2;
    this.engOsc = this.ctx.createOscillator();
    this.engOsc.type = 'sawtooth'; this.engOsc.frequency.value = 58;
    this.engOsc2 = this.ctx.createOscillator();
    this.engOsc2.type = 'square'; this.engOsc2.frequency.value = 29;
    const g2 = this.ctx.createGain(); g2.gain.value = 0.4;
    this.engGain = this.ctx.createGain(); this.engGain.gain.value = 0;
    this.engOsc.connect(lp); this.engOsc2.connect(g2); g2.connect(lp);
    lp.connect(this.engGain); this.engGain.connect(this.master);
    this.engOsc.start(); this.engOsc2.start();

    // 风噪：循环噪声 经带通
    this.windSrc = this.ctx.createBufferSource();
    this.windSrc.buffer = this._nb; this.windSrc.loop = true;
    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass'; this.windFilter.frequency.value = 500; this.windFilter.Q.value = 0.6;
    this.windGain = this.ctx.createGain(); this.windGain.gain.value = 0;
    this.windSrc.connect(this.windFilter); this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    this.windSrc.start();

    this.ready = true;
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.55;
    return this.muted;
  }

  /* ================= 听者（每帧由主循环写入相机位置与右向量） ================= */
  setListener(pos, right) {
    if (!pos) return;
    this._lx = pos.x; this._ly = pos.y; this._lz = pos.z;
    if (right) { this._rx = right.x; this._ry = right.y; this._rz = right.z; }
    this._hasListener = true;
  }
  _distTo(p) {
    if (!p || !this._hasListener) return null;
    const dx = p.x - this._lx, dy = p.y - this._ly, dz = p.z - this._lz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  // 左右定位：声源相对"听者右向量"的横向分量（-1 左 ~ 1 右）
  _panXYZ(x, y, z) {
    if (!this._hasListener) return 0;
    const dx = x - this._lx, dy = y - this._ly, dz = z - this._lz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    return Math.max(-0.8, Math.min(0.8, (dx * this._rx + dy * this._ry + dz * this._rz) / d));
  }
  // 距离衰减：越远越轻，但留一点底（不做硬截断，免得远处爆炸完全没声反而怪）
  _falloff(d) { return d === null ? 1 : Math.max(0.12, Math.min(1, 1 - (d / SOUND_MAX_DIST) * 0.9)); }
  // 多普勒：用「此刻」听者相对弹丸速度的径向接近速度算音高（夹 ±18%）
  _pitchOf(b, d) {
    if (!b.vel) return 1;
    const dx = this._lx - b.x, dy = this._ly - b.y, dz = this._lz - b.z;
    const len = d || 1;
    const toward = (b.vel.x * dx + b.vel.y * dy + b.vel.z * dz) / len;   // >0 = 朝我飞来
    return 1 + 0.18 * Math.tanh(toward / 500);
  }

  /* ================= 声波球（v3.14.4） =================
     声音不再是"入队时算好一个固定延迟"，而是以声源为球心、以 343m/s 膨胀的球面：
     每帧检查听者是否已经进入这个球（或已经碰到球面），碰到才播。
     · 迎面飞向声源 → 球面朝你压过来，**更早**听到；背向飞走 → **更晚**；
     · 音量 / 左右 / 音高全部用"碰到的那一刻"的位置算，不会像固定延迟那样过期；
     · 每种声音带自己的 kind（gun / rocket / boom / whizz），合成参数互不干扰。 */
  _maxR(kind) {
    if (kind === 'boom') return 4000;                    // 4km 外的爆炸听不到（球面推到 4km 还没碰到就丢弃）
    if (kind === 'whizz') return 80;
    return 900;                                          // 枪声/火箭：900m 外音量已归零
  }
  _spawn(kind, pos, extra) {
    if (!this.ready || !pos) return;
    if (!this._hasListener) { if (kind === 'boom') this._explosionCore(1, 1, 0); return; }
    if (kind === 'boom' && this._distTo(pos) > 4000) return;   // 极远处不建球
    if (this.bubbles.length > 48) this.bubbles.shift();        // 极端连爆：丢最老的，防堆积
    this.bubbles.push(Object.assign({ kind, x: pos.x, y: pos.y, z: pos.z, t0: performance.now() }, extra));
  }
  update() {
    if (!this.bubbles.length) return;
    const now = performance.now();
    for (let i = 0; i < this.bubbles.length;) {
      const b = this.bubbles[i];
      const age = Math.max(0, (now - b.t0) / 1000);
      const r = age * SPEED_OF_SOUND;                    // 声波球半径
      const dx = b.x - this._lx, dy = b.y - this._ly, dz = b.z - this._lz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d <= r) {                                      // 球面已经扫到听者 → 播
        this.bubbles.splice(i, 1);
        try { this._hit(b, d); } catch (e) { /* 单个音效异常不影响其它 */ }
        continue;
      }
      // 球面推过最大可听半径还没碰到：这声音永远听不到了，丢弃（防长命球堆积）
      if (r > this._maxR(b.kind) || age > 20) { this.bubbles.splice(i, 1); continue; }
      i++;
    }
  }
  _hit(b, d) {
    const pan = this._panXYZ(b.x, b.y, b.z);
    if (b.kind === 'boom') {
      const vol = this._falloff(d);
      const bright = Math.max(0.35, Math.min(1, 1 - d / 2500));   // 远处高频被空气吸收 → 更闷
      this._explosionCore(vol, bright, pan);
      return;
    }
    if (b.kind === 'whizz') { this._whizzCore(b.vol, b.pitch || 1, pan, !!b.big); return; }
    const v = Math.max(0, 1 - d / 700);                  // 枪声/火箭：700m 外基本听不见
    if (v <= 0.02) return;
    const pitch = this._pitchOf(b, d);
    if (b.kind === 'rocket') {
      // 火箭/炸弹发射：低频"轰"的一下 + 气流，明显区别于机炮的脆响
      this._noise(0.26, 'lowpass', 1100, 0.32 * v, 160, pitch, pan);
      this._tone('sawtooth', 300, 95, 0.22, 0.16 * v, pitch, pan);
      return;
    }
    this._noise(0.08, 'highpass', 900, 0.25 * v, undefined, pitch, pan);
    this._tone('square', 520, 150, 0.07, 0.14 * v, pitch, pan);
  }

  // norm: 0~1 归一化速度
  setEngine(norm, alive) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const f = 50 + norm * 95;
    this.engOsc.frequency.setTargetAtTime(f, t, 0.1);
    this.engOsc2.frequency.setTargetAtTime(f / 2, t, 0.1);
    this.engGain.gain.setTargetAtTime(alive ? 0.05 + norm * 0.06 : 0, t, 0.15);
    this.windGain.gain.setTargetAtTime(alive ? 0.015 + norm * 0.11 : 0, t, 0.2);
    this.windFilter.frequency.setTargetAtTime(320 + norm * 1500, t, 0.2);
  }

  _noiseBuffer(sec) {
    const sr = this.ctx.sampleRate, len = Math.floor(sr * sec);
    const b = this.ctx.createBuffer(1, len, sr);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  // 输出节点：有左右定位时串一个 StereoPanner（播完自动断开，避免节点堆积）
  _out(pan, onEnd) {
    if (pan === undefined || pan === null || Math.abs(pan) < 0.03 || !this.ctx.createStereoPanner) return this.master;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(this.master);
    if (onEnd) onEnd.push(p);
    return p;
  }
  _release(nodes) {
    for (const n of nodes) { try { n.disconnect(); } catch (e) { /* 已断开 */ } }
  }

  _noise(dur, type, freq, gain, freqEnd, pitch, pan) {
    const t = this.ctx.currentTime;
    const nodes = [];
    const s = this.ctx.createBufferSource();
    s.buffer = this._nb; s.loop = true;
    if (pitch && pitch !== 1) s.playbackRate.value = pitch;
    const flt = this.ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.setValueAtTime(freq, t);
    if (freqEnd) flt.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const out = this._out(pan, nodes);
    s.connect(flt); flt.connect(g); g.connect(out);
    s.start(t); s.stop(t + dur + 0.05);
    if (nodes.length) s.onended = () => this._release(nodes);
  }

  _tone(type, f0, f1, dur, gain, pitch, pan) {
    const t = this.ctx.currentTime;
    const nodes = [];
    const p = pitch || 1;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0 * p, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1 * p), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    const out = this._out(pan, nodes);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(t + dur + 0.05);
    if (nodes.length) o.onended = () => this._release(nodes);
  }

  /* ================= 自己的声音（距离≈0，立即播） ================= */
  shoot() {
    if (!this.ready) return;
    this._noise(0.09, 'highpass', 900, 0.32);
    this._tone('square', 650, 160, 0.08, 0.2);
  }
  hitConfirm() { if (this.ready) this._tone('sine', 1500, 1100, 0.06, 0.25); }
  damageTaken() {
    if (!this.ready) return;
    this._tone('sine', 110, 45, 0.22, 0.5);
    this._noise(0.15, 'lowpass', 600, 0.3);
  }
  beep() { if (this.ready) this._tone('square', 880, 0, 0.09, 0.16); }
  roundWin() {
    if (!this.ready) return;
    [523, 659, 784, 1046].forEach((f, i) =>
      setTimeout(() => this._tone('triangle', f, 0, 0.18, 0.28), i * 110));
  }
  roundLose() {
    if (!this.ready) return;
    [392, 330, 262].forEach((f, i) =>
      setTimeout(() => this._tone('triangle', f, 0, 0.22, 0.28), i * 150));
  }
  // 无坐标的爆炸（UI/菜单等场合）：保持立即满音量
  explosion() { if (this.ready) this._explosionCore(1, 1, 0); }

  /* ================= 世界声音（声波球 + 衰减 + 左右定位） ================= */
  /* 爆炸：以爆炸点为球心向外膨胀，球面扫到听者才响 —— 站着不动≈距离/343 秒，
     迎面飞过去更早、掉头飞走更晚，且音色/音量按"听到那一刻"的距离算。 */
  explosionAt(pos) {
    if (!this.ready) return;
    this._spawn('boom', pos);
  }
  _explosionCore(vol, bright, pan) {
    this._noise(1.4, 'lowpass', 2600 * bright, 0.9 * vol, 80, 1, pan);
    this._tone('sine', 80, 24, 0.9, 0.75 * vol, 1, pan);
  }

  /* 敌方机炮/高射机枪：vel=弹丸速度矢量，只用来做多普勒音高。
     真实多普勒在 900m/s 子弹上会算出 4 倍音高（听着像 bug），所以一律夹在 ±18%。 */
  enemyShootAt(pos, vel) {
    if (!this.ready || !pos) return;
    this._spawn('gun', pos, vel ? { vel: { x: vel.x, y: vel.y, z: vel.z } } : null);
  }
  // 火箭弹/炸弹发射：音色与机炮明显区分（低频轰响 + 气流），其余规则完全一样
  enemyLaunchAt(pos, vel) {
    if (!this.ready || !pos) return;
    this._spawn('rocket', pos, vel ? { vel: { x: vel.x, y: vel.y, z: vel.z } } : null);
  }
  // 旧接口（只有距离的粗略版，保留给没有坐标的调用点）
  enemyShoot(dist) {
    if (!this.ready) return;
    const v = Math.max(0, 1 - dist / 700);
    if (v <= 0.02) return;
    this._noise(0.08, 'highpass', 900, 0.25 * v);
    this._tone('square', 520, 150, 0.07, 0.14 * v);
  }

  /* 子弹 / 火箭擦着机身而过：
     由 loop.js 在「弹道进入判定半径且仍在接近」时调一次。
     音高在触发瞬间定（弹已掠过，等球面到达时再算就没意义了），左右用听到时的方位；
     距离只有十几米，球面扫到时约 20~60ms，几乎察觉不到延迟。 */
  whizz(pos, vel, big, distToBody) {
    if (!this.ready || !pos) return;
    const dCam = this._distTo(pos);
    if (dCam === null) return;
    // 音量按"弹道离机身多近"算（第三人称相机在机身后十几米，用相机距离会把声音压没）
    const dBody = (typeof distToBody === 'number') ? distToBody : dCam;
    const r = big ? WHIZ_R_ROCKET : WHIZ_R;
    const vol = Math.max(0.035, Math.min(0.42, (big ? 0.5 : 0.42) * (1 - dBody / r)));
    let pitch = 1;
    if (vel) {
      const dx = this._lx - pos.x, dy = this._ly - pos.y, dz = this._lz - pos.z;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const toward = (vel.x * dx + vel.y * dy + vel.z * dz) / len;
      pitch = 1 + (big ? 0.16 : 0.22) * Math.tanh(toward / 500);
    }
    this._spawn('whizz', pos, { vol, pitch, big: !!big });
  }
  _whizzCore(vol, pitch, pan, big) {
    const t = this.ctx.currentTime;
    const nodes = [];
    const dur = big ? 0.34 : 0.2;
    const f0 = (big ? 1500 : 2700) * pitch;
    const f1 = (big ? 360 : 780) * pitch;
    const s = this.ctx.createBufferSource();
    s.buffer = this._nb; s.loop = true;
    const flt = this.ctx.createBiquadFilter();
    flt.type = 'bandpass'; flt.Q.value = big ? 1.1 : 1.9;
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(Math.max(80, f1), t + dur);   // 掠过 → 音高下滑
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t + 0.02);     // 快起音：像"撕"一下
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const out = this._out(pan, nodes);
    s.connect(flt); flt.connect(g); g.connect(out);
    s.start(t); s.stop(t + dur + 0.03);
    if (nodes.length) s.onended = () => this._release(nodes);
  }
}
