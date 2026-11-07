// 苍穹对决 · 信令 + 静态托管一体服务（零依赖，Node 18+）
//
// 用法：
//   node server/serve.js           → http://localhost:8406 托管仓库根目录，并在 /signal 提供信令
//   node server/serve.js 9000      → 换端口
//   node server/serve.js 8406 .    → 换端口 + 换静态目录
//
// 说明：游戏客户端默认请求同源 `signal`；若游戏托管在别处（如 Cloudflare Pages 静态），
// 可用 `?signal=https://你的域名/signal` 打开一次游戏（会记住），即可跨域使用本服务（已开 CORS）。
//
// 协议见 js/signal.js 顶部注释。房间为内存态，闲置 3 分钟自动回收；无任何持久化、无第三方依赖。

const http = require('http');
const fs = require('fs');
const path = require('path');
const { scan: scanModes } = require('./scan-modes.js');

const PORT = parseInt(process.argv[2] || process.env.PORT || '8406', 10);
const ROOT = path.resolve(process.argv[3] || path.join(__dirname, '..'));
const ROOM_TTL = 3 * 60 * 1000;      // 房间闲置回收
const MAX_BODY = 256 * 1024;         // SDP 约 1-2KB，256KB 足够

const rooms = new Map();             // code -> { name, cap, last, joins: [ {id, name, offer, answer, ansTaken} ] }
let joinSeq = 0;

setInterval(() => {
  const now = Date.now();
  let n = 0;
  for (const [code, r] of rooms) if (now - r.last > ROOM_TTL) { rooms.delete(code); n++; }
  if (n) console.log('[signal] 回收闲置房间', n, '当前', rooms.size);
}, 30000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive', '.woff2': 'font/woff2',
};

function json(res, obj, code) {
  res.writeHead(code || 200, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function handleSignal(req, res, body) {
  let d;
  try { d = JSON.parse(body || '{}'); } catch (e) { return json(res, { ok: false, err: 'bad-json' }, 400); }
  const code = String(d.code == null ? '' : d.code).replace(/\D/g, '').slice(0, 6);
  const now = Date.now();
  const r = rooms.get(code);

  switch (d.a) {
    case 'ping':
      return json(res, { ok: true, rooms: rooms.size });

    case 'host': {
      if (!code) return json(res, { ok: false, err: 'bad-code' });
      if (rooms.has(code)) return json(res, { ok: false, err: 'code-taken' });
      rooms.set(code, {
        name: String(d.name || '').slice(0, 12),
        cap: Math.max(1, Math.min(19, (d.cap | 0) || 1)),
        last: now,
        joins: [],
      });
      console.log('[signal] 建房', code, '容量', d.cap, 'IP', req.socket.remoteAddress);
      return json(res, { ok: true, code });
    }

    case 'hpoll': {
      if (!r) return json(res, { ok: false, err: 'no-room' });
      r.last = now;
      const joins = [];
      for (const j of r.joins) if (!j.hostGot) { j.hostGot = true; joins.push({ id: j.id, name: j.name }); }
      const answers = [];
      for (const j of r.joins) if (j.answer && !j.ansTaken) { j.ansTaken = true; answers.push({ id: j.id, answer: j.answer }); }
      return json(res, { ok: true, joins, answers, count: r.joins.length, cap: r.cap });
    }

    case 'offer': {
      if (!r) return json(res, { ok: false, err: 'no-room' });
      const j = r.joins.find(x => x.id === d.to);
      if (!j) return json(res, { ok: false, err: 'no-joiner' });
      j.offer = String(d.offer || '');
      r.last = now;
      return json(res, { ok: true });
    }

    case 'join': {
      if (!r) return json(res, { ok: false, err: 'no-room' });
      if (r.joins.length >= r.cap) return json(res, { ok: false, err: 'full' });
      const j = { id: 'j' + (++joinSeq) + '_' + Math.random().toString(36).slice(2, 7), name: String(d.name || '').slice(0, 12), offer: '', answer: '', hostGot: false, ansTaken: false };
      r.joins.push(j);
      r.last = now;
      console.log('[signal] 加入', code, j.name, '人数', r.joins.length + '/' + r.cap);
      return json(res, { ok: true, id: j.id, hostName: r.name });
    }

    case 'jpoll': {
      if (!r) return json(res, { ok: false, err: 'no-room' });
      const j = r.joins.find(x => x.id === d.id);
      if (!j) return json(res, { ok: false, err: 'no-joiner' });
      r.last = now;
      return json(res, { ok: true, offer: j.offer || null, hostName: r.name });
    }

    case 'answer': {
      if (!r) return json(res, { ok: false, err: 'no-room' });
      const j = r.joins.find(x => x.id === d.id);
      if (!j) return json(res, { ok: false, err: 'no-joiner' });
      j.answer = String(d.answer || '');
      j.ansTaken = false;
      r.last = now;
      return json(res, { ok: true });
    }

    default:
      return json(res, { ok: false, err: 'bad-action' }, 400);
  }
}

function serveStatic(req, res, pathname, retry) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const abs = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!abs.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }   // 防目录穿越
  fs.stat(abs, (err, st) => {
    if (!err && st.isDirectory() && !retry) return serveStatic(req, res, pathname.replace(/\/*$/, '/'), true);   // 目录 → 找 index.html
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache' });
    const rs = fs.createReadStream(abs);
    rs.on('error', () => { try { res.destroy(); } catch (e) { /* 客户端已断开 */ } });
    rs.pipe(res);
  });
}

http.createServer((req, res) => {
  // 连接级错误必须自己兜住：浏览器会中途取消请求（切页面/预检/多连接），
  // 未处理的 EPIPE/ECONNRESET 会直接崩掉整个进程（实测过：崩掉后探测全失败）。
  req.on('error', () => {});
  res.on('error', () => {});
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') return json(res, { ok: true });
  if (url.pathname === '/signal' || url.pathname === '/signal/') {
    if (req.method !== 'POST') return json(res, { ok: false, err: 'use-post' }, 405);
    let body = '', too = false;
    req.on('data', c => { body += c; if (body.length > MAX_BODY) { too = true; req.destroy(); } });
    req.on('end', () => { if (!too) { try { handleSignal(req, res, body); } catch (e) { console.error('[signal] 处理异常:', e.message); } } });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('method not allowed'); }
  // 模式清单：每次请求都重扫 js/modes/*/mode.json → 加/删模式文件夹立即生效（开发时无需重启）
  if (url.pathname === '/js/modes.json') {
    try {
      const { json, errors } = scanModes({ write: true });
      if (errors.length) console.warn('[scan-modes] ' + errors.join(' | '));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(json);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }
  serveStatic(req, res, url.pathname);
}).listen(PORT, () => {
  console.log('苍穹对决 服务已启动');
  console.log('  游戏    http://localhost:' + PORT + '/play/');
  console.log('  信令    http://localhost:' + PORT + '/signal   (房间码组队)');
  console.log('  静态目录 ' + ROOT);
});

// 兜底：任何未捕获异常都只记一行日志，绝不让服务退出
process.on('uncaughtException', (e) => console.error('[warn] 未捕获异常（服务继续）:', e && e.message));
process.on('unhandledRejection', (e) => console.error('[warn] 未处理 Promise（服务继续）:', e && e.message));
