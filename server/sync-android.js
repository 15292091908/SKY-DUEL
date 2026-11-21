// 把网页版 js/ 同步到安卓 assets/web/js/（覆盖式），并清理安卓侧多余的旧文件
// 用法（仓库根目录）：node server/sync-android.js
const fs = require('fs');
const path = require('path');
const SRC = path.join(__dirname, '..', 'js');
const DST = path.join(__dirname, '..', '安卓版', 'app', 'src', 'main', 'assets', 'web', 'js');

function listAll(dir, base = '') {
  const out = [];
  for (const n of fs.readdirSync(dir)) {
    const s = path.join(dir, n), rel = path.join(base, n);
    if (fs.statSync(s).isDirectory()) { if (n === '_template') continue; out.push(...listAll(s, rel)); }
    else if (!n.endsWith('.md')) out.push(rel);
  }
  return out;
}
const srcFiles = listAll(SRC);
let n = 0;
for (const rel of srcFiles) {
  const d = path.join(DST, rel);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.copyFileSync(path.join(SRC, rel), d);
  n++;
}
console.log('复制 ' + n + ' 个文件');
const keep = new Set(srcFiles);
let rm = 0;
try { for (const rel of listAll(DST)) if (!keep.has(rel)) { fs.unlinkSync(path.join(DST, rel)); console.log('  删除多余: ' + rel); rm++; } }
catch (e) { console.log('  ⚠ 旧文件清理跳过: ' + e.message.slice(0, 40)); }
function prune(dir) {
  for (const n of fs.readdirSync(dir)) {
    const s = path.join(dir, n);
    if (fs.statSync(s).isDirectory()) { prune(s); if (!fs.readdirSync(s).length) fs.rmdirSync(s); }
  }
}
try { prune(DST); } catch (e) {}
console.log('删除 ' + rm + ' 个旧文件');
