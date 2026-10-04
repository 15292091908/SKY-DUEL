// 苍穹对决 · 极简 MQTT 3.1.1 over WebSocket 客户端（无第三方依赖）
//
// 只实现信令需要的最小子集，跑在公共 MQTT broker 上做房间消息中转：
//   CONNECT / CONNACK、SUBSCRIBE / SUBACK、PUBLISH(QoS0, 收发)、PINGREQ / PINGRESP、DISCONNECT
// 不需要账号密码（公共 broker 允许匿名），不需要自己部署任何服务。
//
// 为什么不用 mqtt.js：项目要求零外部依赖、全部本地化，而这里只需要 ~150 行。
// 参考：MQTT 3.1.1 规范（OASIS）；WebSocket 子协议固定为 'mqtt'。

const enc = new TextEncoder();
const dec = new TextDecoder();

function u16(n) { return [(n >> 8) & 0xff, n & 0xff]; }
function str(s) { const b = enc.encode(s); return [...u16(b.length), ...b]; }
// MQTT 变长长度编码（Remaining Length）
function varint(n) { const out = []; do { let d = n % 128; n = Math.floor(n / 128); if (n > 0) d |= 0x80; out.push(d); } while (n > 0); return out; }
function pkt(type, flags, body) { return new Uint8Array([(type << 4) | flags, ...varint(body.length), ...body]); }

export class MqttMini {
  // url 形如 wss://broker.emqx.io:8084/mqtt
  constructor(url, opts = {}) {
    this.url = url;
    this.clientId = opts.clientId || ('sdx_' + Math.random().toString(36).slice(2, 12));
    this.keepAlive = opts.keepAlive || 30;
    this.connectTimeout = opts.connectTimeout || 10000;  // 单次连接超时。曾用 4.5s：低端机/页面主线程忙时
                                                         // WebSocket open 回调被推迟，会被误判成连接失败（实测踩过）
    this.ws = null;
    this.buf = new Uint8Array(0);
    this.subs = new Map();          // 已订阅的 topic（前缀匹配由 broker 负责）
    this.onMessage = null;          // (topic, payloadString) => void
    this.onClose = null;
    this._pingT = null;
    this._connected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (ok, err) => { if (!settled) { settled = true; ok ? resolve() : reject(err); } };
      let ws;
      try { ws = new WebSocket(this.url, 'mqtt'); } catch (e) { return done(false, e); }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      const timer = setTimeout(() => { try { ws.close(); } catch (e) {} done(false, new Error('连接超时')); }, this.connectTimeout);

      ws.onopen = () => {
        // CONNECT：clean session + 60s keepalive，匿名（无 username/password）
        const body = [...str('MQTT'), 4, 0x02, ...u16(Math.max(10, this.keepAlive)), ...str(this.clientId)];
        ws.send(pkt(1, 0, body));
      };
      ws.onmessage = (ev) => { try { this._feed(new Uint8Array(ev.data), (ok, err) => { clearTimeout(timer); this._connected = ok; done(ok, err); }); } catch (e) { /* 忽略解析异常 */ } };
      ws.onerror = () => { clearTimeout(timer); done(false, new Error('连接失败')); };
      ws.onclose = () => {
        clearTimeout(timer);
        this._connected = false;
        clearInterval(this._pingT); this._pingT = null;
        done(false, new Error('连接已关闭'));
        if (this.onClose) this.onClose();
      };
    });
  }

  _feed(bytes, onConnack) {
    const merged = new Uint8Array(this.buf.length + bytes.length);
    merged.set(this.buf, 0); merged.set(bytes, this.buf.length);
    this.buf = merged;
    for (;;) {
      if (this.buf.length < 2) return;
      // 解析变长长度
      let i = 1, mul = 1, len = 0, b;
      do {
        if (i >= this.buf.length) return;            // 长度字节还没到齐
        b = this.buf[i++]; len += (b & 0x7f) * mul; mul *= 128;
        if (mul > 128 * 128 * 128) return;
      } while (b & 0x80);
      if (this.buf.length < i + len) return;         // 包体还没到齐
      const type = this.buf[0] >> 4, flags = this.buf[0] & 0x0f;
      const body = this.buf.subarray(i, i + len);
      this.buf = this.buf.subarray(i + len);
      this._handle(type, flags, body, onConnack);
    }
  }

  _handle(type, flags, body, onConnack) {
    if (type === 2) {                                 // CONNACK
      const code = body[1];
      if (onConnack) onConnack(code === 0, code === 0 ? null : new Error('broker 拒绝连接（码 ' + code + '）'));
      if (code === 0) {
        clearInterval(this._pingT);
        this._pingT = setInterval(() => this._send(pkt(12, 0, [])), Math.max(10, this.keepAlive) * 1000);
      }
      return;
    }
    if (type === 3) {                                 // PUBLISH（我们只用 QoS0，故无 packet id）
      const tl = (body[0] << 8) | body[1];
      const topic = dec.decode(body.subarray(2, 2 + tl));
      const payload = dec.decode(body.subarray(2 + tl));
      if (this.onMessage) this.onMessage(topic, payload);
      return;
    }
    // SUBACK(9) / PINGRESP(13) / PUBACK(4) 等：无需处理
  }

  _send(p) { if (this.ws && this.ws.readyState === 1) this.ws.send(p); }

  subscribe(topic, qos = 0) {
    this.subs.set(topic, qos);
    const body = [...u16(++MqttMini._pid & 0xffff), ...str(topic), qos];
    this._send(pkt(8, 2, body));
  }

  publish(topic, payload, retain = false) { this._send(pkt(3, retain ? 1 : 0, [...str(topic), ...enc.encode(String(payload))])); }

  close() {
    clearInterval(this._pingT); this._pingT = null;
    try { this._send(pkt(14, 0, [])); } catch (e) { /* 忽略 */ }
    try { if (this.ws) this.ws.close(); } catch (e) { /* 忽略 */ }
  }
  get connected() { return !!this.ws && this.ws.readyState === 1; }
}
MqttMini._pid = 0;

// 公共 broker（免密钥）：按顺序尝试，第一个连通的使用。
// broker-cn（EMQX 中国区）放最前：国内网络更稳、延迟更低；其余作为降级备用。
// 实测：偶发限流时某个 broker 会连续失败几分钟，所以候选要多、且要优先复用上次连通的（见 signal.js）。
export const PUBLIC_BROKERS = [
  'wss://broker-cn.emqx.io:8084/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];
