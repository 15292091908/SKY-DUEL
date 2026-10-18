// server/scan-modes.js —— 扫描 js/modes/*/mode.json，生成 js/modes.json（模式清单）
//
// 为什么需要清单：浏览器出于安全限制**不能列目录**，静态站点也没有目录索引。
// 所以由这个脚本在"文件系统侧"扫描模式文件夹，把结果写成 JSON；客户端的
// js/mode.js / lobby.js 只读清单（不写死任何玩法名）。
//
// 用法：
//   node server/scan-modes.js          → 扫描并写入 js/modes.json
//   node server/serve.js               → 开发服务器：每次请求 /js/modes.json 都实时重扫
//   node server/pack.js                → 打包前自动重扫
//
// 新增模式：在 js/modes/ 下新建文件夹（含 mode.json + index.js 即可出现在大厅；
// 再补 net.js / maps.js / maps/ / lobby.css 就是完整模式包）。不用改 HTML / lobby.js / mode.js。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MODES_DIR = path.join(ROOT, 'js', 'modes');
const OUT = path.join(ROOT, 'js', 'modes.json');

function scan(opts) {
  const write = !opts || opts.write !== false;
  const modes = [];
  const errors = [];

  let entries = [];
  try { entries = fs.readdirSync(MODES_DIR, { withFileTypes: true }); }
  catch (e) { errors.push('无法读取 js/modes：' + e.message); }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = ent.name;
    if (dir.startsWith('_') || dir.startsWith('.')) continue;   // _template / 隐藏目录不参与
    const base = path.join(MODES_DIR, dir);
    const metaPath = path.join(base, 'mode.json');
    if (!fs.existsSync(metaPath)) { errors.push(dir + '：缺少 mode.json，已跳过'); continue; }
    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); }
    catch (e) { errors.push(dir + '/mode.json 解析失败：' + e.message); continue; }
    if (!meta.id || !meta.name) { errors.push(dir + '/mode.json 缺少 id 或 name，已跳过'); continue; }
    if (!fs.existsSync(path.join(base, 'index.js'))) { errors.push(dir + '：缺少 index.js，已跳过'); continue; }
    modes.push({
      dir,
      id: String(meta.id),
      name: String(meta.name),
      order: Number(meta.order) || 0,
      accent: meta.accent || '#2563eb',
      lobbyCss: meta.lobbyCss || '',
      defaultMap: meta.defaultMap || '',
      hasNet: fs.existsSync(path.join(base, 'net.js')),
      hasMaps: fs.existsSync(path.join(base, 'maps.js')),
    });
  }

  // id 去重（同 id 只保留排序靠前的一个）
  const seen = new Set();
  const list = modes.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  list.sort((a, b) => (a.order - b.order) || a.dir.localeCompare(b.dir));

  const json = JSON.stringify({ generatedAt: new Date().toISOString(), modes: list }, null, 2) + '\n';
  if (write) fs.writeFileSync(OUT, json, 'utf8');
  for (const e of errors) console.warn('[scan-modes] ' + e);
  return { json, modes: list, errors };
}

module.exports = { scan };

if (require.main === module) {
  const r = scan();
  console.log('[scan-modes] ' + r.modes.length + ' 个模式 → js/modes.json');
  for (const m of r.modes) console.log('  #' + m.order + '  ' + m.dir + ' → ' + m.id + '  ' + m.name);
  if (r.errors.length) process.exitCode = 1;
}
