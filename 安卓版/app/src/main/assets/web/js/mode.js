// js/mode.js —— 模式读取器 + 装载器（v3.10.0）
//
// 目录结构（每个模式 = 一个自包含的文件夹）：
//   js/
//     lobby.js          大厅外壳：只负责渲染，不写死任何玩法
//     mode.js           本文件：读取模式清单 + 按需加载模式包
//     modes.json        自动生成的清单（不要手改）
//     modes/
//       air/            mode.json / index.js / net.js / maps.js / maps/ / lobby.css
//       aavs/           （同上）
//       heli/           （同上）
//
// 清单怎么来：浏览器无法列目录，所以由 server/scan-modes.js 扫描 js/modes/*/mode.json 生成
// js/modes.json。开发时 `node server/serve.js` 会在每次请求清单时实时重扫（加/删文件夹立即生效）；
// 上线前 `node server/pack.js` 会自动重扫并带上清单。全程不需要改 HTML / 本文件 / lobby.js。
//
// 加载：loadMode(id) → 清单里按 id 找到目录 → 并行 import index.js / maps.js / net.js
//       → 与 mode.json 合并成一个 MODE 描述符（meta 优先）→ 注入该模式的大厅皮肤 lobby.css。
import { gamemode } from './state.js?v=1516';
import { registerMap } from './world/index.js?v=1516';

const V = new URL(import.meta.url).search;          // 与静态 import 共用同一个 ?v=
let manifestPromise = null;
let manifest = [];
let current = null;
let loading = null;      // 串行化：并发切模式时排队，避免互相把 current 置空/覆盖

/* ---------- 清单读取（带缓存；失败可重试） ---------- */
export function readModes() {
  if (!manifestPromise) {
    const url = new URL('./modes.json' + V, import.meta.url);
    manifestPromise = fetch(url, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((data) => {
        const list = Array.isArray(data) ? data : (data && data.modes) || [];
        manifest = list.filter((m) => m && m.id && m.dir && m.name)
          .sort((a, b) => (a.order || 0) - (b.order || 0) || String(a.dir).localeCompare(String(b.dir)));
        if (!manifest.length) throw new Error('模式清单为空');
        return manifest;
      })
      .catch((e) => {
        manifestPromise = null;                       // 允许下次重试
        console.error('[mode] 读取 js/modes.json 失败：', e);
        throw e;
      });
  }
  return manifestPromise;
}

/* ---------- 查询 ---------- */
export function modeList() { return manifest; }
export function modeMeta(id) { return manifest.find((m) => m.id === id) || null; }
export function modeDef() { return current; }
export function modeField(key, fallback) {
  const m = current;
  return (m && m[key] !== undefined) ? m[key] : fallback;
}
export function modeDefaultMap(fallback) { return modeField('defaultMap', fallback); }

/* ---------- 大厅皮肤：只切换当前模式自己的 lobby.css ---------- */
function applyLobbyCss(meta, base) {
  let link = document.getElementById('modeLobbyCss');
  if (!meta || !meta.lobbyCss) { if (link) link.remove(); return; }
  if (!link) {
    link = document.createElement('link');
    link.id = 'modeLobbyCss';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
  const href = new URL(base + meta.lobbyCss + V, import.meta.url).href;
  if (link.href !== href) link.href = href;
  const menu = document.getElementById('menu');
  if (menu) menu.dataset.mode = meta.id;             // CSS 作用域：#menu[data-mode="heli"]
  // 安卓：记住当前玩法 → 键位编辑器按 飞机/防空车/直升机 三套分别读写；切模式立即换键位
  try { localStorage.setItem('sd_mode', meta.id); } catch (e) {}
  if (typeof window !== 'undefined' && typeof window.__sdApplyLayout === 'function') window.__sdApplyLayout();
}

/* ---------- 加载模式包 ---------- */
export async function loadMode(id) {
  if (loading) { try { await loading; } catch (e) {} }   // 等上一次切换完成（快速连点/启动竞态）
  const list = await readModes();
  const meta = list.find((m) => m.id === (id || gamemode)) || list[0];
  if (!meta) throw new Error('没有可用的模式包');
  const base = './modes/' + meta.dir + '/';
  if (current && current.id === meta.id) { applyLobbyCss(meta, base); return current; }

  loading = (async () => {
    const [mod, mapsMod, netMod] = await Promise.all([
      import(base + 'index.js' + V),
      import(base + 'maps.js' + V).catch((e) => { console.error('[mode] ' + meta.id + ' 缺少 maps.js：', e); return { MAPS: [] }; }),
      import(base + 'net.js' + V).catch((e) => { console.error('[mode] ' + meta.id + ' 缺少 net.js：', e); return { NET: {} }; }),
    ]);
    current = Object.assign({}, mod.MODE, meta, (netMod && netMod.NET) || {}, {
      maps: (mapsMod && mapsMod.MAPS) || [],
    });
    // 重新登记本模式的地图：同名地图（如 aavs / heli 各有一份 base）以"当前模式的那份"为准
    for (const m of current.maps) registerMap(m);
    applyLobbyCss(meta, base);
    return current;
  })();
  try { return await loading; } finally { loading = null; }
}
