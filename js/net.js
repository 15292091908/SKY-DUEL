// 苍穹对决 · 联机层（纯 WebRTC 直连，无任何服务器）
// 玩家手动交换 SDP（邀请码/应答码）建立 P2P 连接
// iceServers 为空：纯直连，无 STUN/TURN/信令服务器

const RTC_CONFIG = { iceServers: [] };

// 名字清洗：去掉分隔符/控制字符，限长（名字会随邀请码/应答码一起走，所以要防注入）
export function cleanName(s) {
  return String(s == null ? '' : s)
    .replace(/[|\r\n\t\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12);
}
// UTF-8 安全的 base64：btoa 只能编码 Latin1，名字里有中文会直接抛
// "characters outside of the Latin1 range"，所以先过 TextEncoder 转字节串。
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b64decode(s) {
  const bin = atob(String(s).trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
// 邀请码/应答码 = base64(JSON{type,sdp,name})。name 是附加字段：
// 旧版解析会忽略它（仍能连上），新版解析旧码则拿不到名字 → 回退默认名，双向兼容。
function encodeDesc(d, name) {
  const n = cleanName(name);
  return b64encode(JSON.stringify(n ? { type: d.type, sdp: d.sdp, name: n } : { type: d.type, sdp: d.sdp }));
}
function decodeDesc(s) { return JSON.parse(b64decode(s)); }

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
    this.remoteName = '';    // 对端名字（从邀请码/应答码里解出）
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

  // 主机生成邀请码（myName：房主名字，随邀请码带给加入方；可空）
  async createOffer(myName) {
    this._mkpc();
    this.dcState = this.pc.createDataChannel('s', { ordered: false, maxRetransmits: 0 });
    this.dcEvent = this.pc.createDataChannel('e');
    this._bind(this.dcState, 'state');
    this._bind(this.dcEvent, 'event');
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this._waitIce();
    return encodeDesc(this.pc.localDescription, myName);
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
      const d = decodeDesc(str);
      await this.pc.setRemoteDescription({ type: d.type, sdp: d.sdp });
      this.remoteName = cleanName(d.name);   // 加入方名字（随应答码带过来）
    } catch (e) {
      throw new Error('应答码无法应用（可能不是这份邀请码的应答码）：' + e.message);
    }
  }

  // 加入方用邀请码生成应答码（myName：加入方名字，随应答码带给房主）
  async join(offerStr, myName) {
    this._mkpc();
    this.pc.ondatachannel = (e) => {
      if (e.channel.label === 's') { this.dcState = e.channel; this._bind(e.channel, 'state'); }
      else { this.dcEvent = e.channel; this._bind(e.channel, 'event'); }
    };
    const od = decodeDesc(offerStr);
    this.remoteName = cleanName(od.name);   // 房主名字（随邀请码带过来）
    await this.pc.setRemoteDescription({ type: od.type, sdp: od.sdp });
    const ans = await this.pc.createAnswer();
    await this.pc.setLocalDescription(ans);
    await this._waitIce();
    return encodeDesc(this.pc.localDescription, myName);
  }

  sendState(o) { if (this.dcState && this.dcState.readyState === 'open') this.dcState.send(JSON.stringify(o)); }
  sendEvent(o) { if (this.dcEvent && this.dcEvent.readyState === 'open') this.dcEvent.send(JSON.stringify(o)); }
}
