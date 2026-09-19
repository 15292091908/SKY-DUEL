// [ANDROID] 设置面板补丁：主音量存于 localStorage('sd_settings')，默认 0.55 与网页版一致
const VOL_DEFAULT = (() => { try { const s = JSON.parse(localStorage.getItem('sd_settings') || '{}'); const v = parseFloat(s.vol); return isNaN(v) ? 0.55 : Math.max(0, Math.min(1, v)); } catch (e) { return 0.55; } })();

// 纯 Web Audio API 合成音效：引擎、风声、机炮、命中、受击、爆炸、告警、回合音乐
export class AudioEngine {
  constructor() {
    this.ready = false;
    this.muted = false;
  }

  init() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
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
    if (this.master) this.master.gain.value = this.muted ? 0 : VOL_DEFAULT;
    return this.muted;
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

  _noise(dur, type, freq, gain, freqEnd) {
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this._nb; s.loop = true;
    const flt = this.ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.setValueAtTime(freq, t);
    if (freqEnd) flt.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(flt); flt.connect(g); g.connect(this.master);
    s.start(t); s.stop(t + dur + 0.05);
  }

  _tone(type, f0, f1, dur, gain) {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  shoot() {
    if (!this.ready) return;
    this._noise(0.09, 'highpass', 900, 0.32);
    this._tone('square', 650, 160, 0.08, 0.2);
  }

  enemyShoot(dist) {
    if (!this.ready) return;
    const v = Math.max(0, 1 - dist / 700);
    if (v <= 0.02) return;
    this._noise(0.08, 'highpass', 900, 0.25 * v);
    this._tone('square', 520, 150, 0.07, 0.14 * v);
  }

  hitConfirm() { if (this.ready) this._tone('sine', 1500, 1100, 0.06, 0.25); }

  damageTaken() {
    if (!this.ready) return;
    this._tone('sine', 110, 45, 0.22, 0.5);
    this._noise(0.15, 'lowpass', 600, 0.3);
  }

  explosion() {
    if (!this.ready) return;
    this._noise(1.4, 'lowpass', 2600, 0.9, 80);
    this._tone('sine', 80, 24, 0.9, 0.75);
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
}
