// 苍穹对决 · 联机层（纯 WebRTC 直连，无任何服务器）
// 玩家手动交换 SDP（邀请码/应答码）建立 P2P 连接
// iceServers 为空：纯直连，无 STUN/TURN/信令服务器

const RTC_CONFIG = { iceServers: [] };

function encodeDesc(d) { return btoa(JSON.stringify({ type: d.type, sdp: d.sdp })); }
function decodeDesc(s) { return JSON.parse(atob(s.trim())); }

export function makePeerId() {
  return Math.random().toString(36).slice(2, 12);
}

/* ================= 单条 WebRTC 连接 ================= */
export class Net {
  constructor() {
    this.pc = null;
    this.dcState = null;
    this.dcEvent = null;
    this.connected = false;
    this.onState = null;
    this.onEvent = null;
    this.onOpen = null;
    this.onClose = null;
  }

  _mkpc() {
    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      if (st === 'disconnected' || st === 'failed' || st === 'closed') {
        if (this.connected && this.onClose) { this.connected = false; this.onClose(); }
      }
    };
  }

  _bind(ch, kind) {
    ch.onopen = () => { if (kind === 'event') { this.connected = true; if (this.onOpen) this.onOpen(); } };
    ch.onclose = () => { if (kind === 'event') { if (this.connected && this.onClose) { this.connected = false; this.onClose(); } } };
    ch.onmessage = (m) => {
      let d; try { d = JSON.parse(m.data); } catch (e) { return; }
      if (kind === 'state') { if (this.onState) this.onState(d); }
      else { if (this.onEvent) this.onEvent(d); }
    };
  }

  _waitIce() {
    return new Promise((res) => {
      if (this.pc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, 3500);
      this.pc.addEventListener('icegatheringstatechange', () => {
        if (this.pc.iceGatheringState === 'complete') { clearTimeout(t); res(); }
      });
    });
  }

  // 主机生成邀请码
  async createOffer() {
    this._mkpc();
    this.dcState = this.pc.createDataChannel('s', { ordered: false, maxRetransmits: 0 });
    this.dcEvent = this.pc.createDataChannel('e');
    this._bind(this.dcState, 'state');
    this._bind(this.dcEvent, 'event');
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this._waitIce();
    return encodeDesc(this.pc.localDescription);
  }

  // 主机粘贴好友的应答码
  // 状态校验：应答码只能应用于「已发出邀请码、等待应答」的连接。
  // 重复点击「连接此人」或拿旧应答码对新邀请码使用时，pc 处于 stable，
  // 浏览器会抛 "Called in wrong state: stable" —— 这里转成可读提示，避免糊用户脸上。
  async acceptAnswer(str) {
    if (!this.pc) throw new Error('请先点「生成邀请码」，再把好友的应答码粘进来');
    const st = this.pc.signalingState;
    if (st !== 'have-local-offer') {
      throw new Error(st === 'stable'
        ? '这条连接已经建立或已失效了。请重新点「生成邀请码」，再把新应答码粘进来'
        : '连接状态为 ' + st + '，暂时无法接收应答码，请重新生成邀请码');
    }
    try {
      await this.pc.setRemoteDescription(decodeDesc(str));
    } catch (e) {
      throw new Error('应答码无法应用（可能不是这份邀请码的应答码）：' + e.message);
    }
  }

  // 加入方用邀请码生成应答码
  async join(offerStr) {
    this._mkpc();
    this.pc.ondatachannel = (e) => {
      if (e.channel.label === 's') { this.dcState = e.channel; this._bind(e.channel, 'state'); }
      else { this.dcEvent = e.channel; this._bind(e.channel, 'event'); }
    };
    await this.pc.setRemoteDescription(decodeDesc(offerStr));
    const ans = await this.pc.createAnswer();
    await this.pc.setLocalDescription(ans);
    await this._waitIce();
    return encodeDesc(this.pc.localDescription);
  }

  sendState(o) { if (this.dcState && this.dcState.readyState === 'open') this.dcState.send(JSON.stringify(o)); }
  sendEvent(o) { if (this.dcEvent && this.dcEvent.readyState === 'open') this.dcEvent.send(JSON.stringify(o)); }
}
