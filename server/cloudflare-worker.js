// 苍穹对决 · 信令服务（Cloudflare Worker + Durable Object 版）
//
// 为什么用 Durable Object：每个 6 位房间码对应一个 DO 实例，做房间内的消息中转，
// 状态写进 DO storage（内存态会被回收，storage 不会），无需数据库/KV、无第三方依赖。
//
// 部署（免费版即可）：
//   1) npm i -g wrangler && wrangler login
//   2) 本目录下执行：wrangler deploy
//   3) 记下形如 https://skyduel-signal.<你的子域>.workers.dev 的地址
//   4) 游戏侧任选其一：
//      · 打开一次 https://你的游戏地址/play/?signal=https://skyduel-signal.xxx.workers.dev/signal （会记住）
//      · 或把游戏与 Worker 放在同域（Pages Functions 路由 /signal → Worker）
//   探测不通时游戏会自动回退「手动交换邀请码」，不影响任何现有玩法。
//
// 协议：与 js/signal.js、server/serve.js 完全一致（POST JSON {a:动作,...}）

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
};
const j = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== '/signal' && url.pathname !== '/signal/') return new Response('not found', { status: 404, headers: CORS });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (req.method !== 'POST') return j({ ok: false, err: 'use-post' }, 405);
    let d;
    try { d = await req.json(); } catch (e) { return j({ ok: false, err: 'bad-json' }, 400); }
    if (d.a === 'ping') return j({ ok: true });
    const code = String(d.code == null ? '' : d.code).replace(/\D/g, '').slice(0, 6);
    if (!code) return j({ ok: false, err: 'bad-code' });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));       // 一个房间码 = 一个 DO
    const r = await stub.fetch('https://room/', { method: 'POST', body: JSON.stringify({ ...d, code }) });
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS } });
  },
};

export class Room {
  constructor(state) { this.state = state; }

  async _get() {
    this.room = this.room || (await this.state.storage.get('room')) || null;
    return this.room;
  }
  async _put() { if (this.room) await this.state.storage.put('room', this.room); }

  async fetch(req) {
    const d = await req.json();
    const code = d.code;
    const now = Date.now();
    let r = await this._get();

    if (d.a === 'host') {
      if (r && now - r.last < 3 * 60 * 1000) return j({ ok: false, err: 'code-taken' });
      this.room = { name: String(d.name || '').slice(0, 12), cap: Math.max(1, Math.min(19, (d.cap | 0) || 1)), last: now, joins: [] };
      await this._put();
      return j({ ok: true, code });
    }
    if (!r || now - r.last > 3 * 60 * 1000) { this.room = null; return j({ ok: false, err: 'no-room' }); }
    r.last = now;

    switch (d.a) {
      case 'hpoll': {
        const joins = [];
        for (const x of r.joins) if (!x.hostGot) { x.hostGot = true; joins.push({ id: x.id, name: x.name }); }
        const answers = [];
        for (const x of r.joins) if (x.answer && !x.ansTaken) { x.ansTaken = true; answers.push({ id: x.id, answer: x.answer }); }
        await this._put();
        return j({ ok: true, joins, answers, count: r.joins.length, cap: r.cap });
      }
      case 'offer': {
        const x = r.joins.find(v => v.id === d.to);
        if (!x) return j({ ok: false, err: 'no-joiner' });
        x.offer = String(d.offer || '');
        await this._put();
        return j({ ok: true });
      }
      case 'join': {
        if (r.joins.length >= r.cap) return j({ ok: false, err: 'full' });
        const id = 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        r.joins.push({ id, name: String(d.name || '').slice(0, 12), offer: '', answer: '', hostGot: false, ansTaken: false });
        await this._put();
        return j({ ok: true, id, hostName: r.name });
      }
      case 'jpoll': {
        const x = r.joins.find(v => v.id === d.id);
        if (!x) return j({ ok: false, err: 'no-joiner' });
        await this._put();
        return j({ ok: true, offer: x.offer || null, hostName: r.name });
      }
      case 'answer': {
        const x = r.joins.find(v => v.id === d.id);
        if (!x) return j({ ok: false, err: 'no-joiner' });
        x.answer = String(d.answer || '');
        x.ansTaken = false;
        await this._put();
        return j({ ok: true });
      }
      default:
        return j({ ok: false, err: 'bad-action' }, 400);
    }
  }
}
