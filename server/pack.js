// 打包"要上线的静态站点"到 发布/ 目录
//   node server/pack.js
// 只复制静态资源：不含安卓工程（安卓版/，含大量构建产物）、不含服务器代码（server/）、
// 不含 .workbuddy/ 记忆 —— 这些都不该上传到 Cloudflare Pages。
//
// 会额外做三件事（版本号单一来源 = 安卓版/app/build.gradle 的 versionName）：
//   ① 把 苍穹对决.apk 复制成 发布/苍穹对决v<版本>.apk（下载地址文件名带版本号）
//   ② 生成 发布/version.json（安卓端启动校验版本用；缺失时安卓端退化为解析首页 HTML）
//   ③ 把 发布/index.html 与 发布/play/index.html 里的下载链接、显示版本按标记自动改写
//
// 注意 1：Cloudflare Pages 拒收 wrangler.toml（保留文件名），所以 server/ 不进发布目录。
// 注意 2：不要用"先删光再复制"的重建方式 —— 本机删除会被安全删除机制（回收站助手）接管，
//         偶发超时会让打包中途失败、留下残缺目录（实测踩过）。这里改成覆盖式复制：
//         每次把清单内文件全部覆盖写入，再尽力清掉清单外的残留（清不掉只提示，不报错）。

const fs = require('fs');
const path = require('path');
const { scan: scanModes } = require('./scan-modes.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '发布');
const FILES = ['index.html', 'favicon.svg', 'robots.txt', 'sitemap.xml', 'host-mini-world-arch.html'];
const DIRS = ['play', 'js', 'vendor', 'articles'];
const SKIP = new Set(['node_modules', '.git', '__pycache__']);
const APK_SRC = path.join(ROOT, '苍穹对决.apk');
const APK_HOST = 'https://game.4365754.xyz/';

// 打包前重扫模式清单（新增/删除 js/modes/* 文件夹 → 这里自动更新 js/modes.json）
const _scan = scanModes({ write: true });
console.log('[pack] 模式清单：' + _scan.modes.map((m) => m.id + '(' + m.dir + ')').join(' / '));

function copyDir(src, dst, manifest) {          // 手写递归复制：不依赖 fs.cpSync / readdirSync 的递归选项
  let n = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (SKIP.has(name)) continue;
    const s = path.join(src, name), d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) n += copyDir(s, d, manifest);
    else { fs.copyFileSync(s, d); manifest.push(path.relative(OUT, d)); n++; }
  }
  return n;
}

function safeRm(p) { try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch (e) { return false; } }

// 版本号唯一来源：安卓工程 build.gradle 的 versionName
function readVersion() {
  try {
    const g = fs.readFileSync(path.join(ROOT, '安卓版', 'app', 'build.gradle'), 'utf8');
    const m = g.match(/versionName\s+'([^']+)'/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

// 按标记改写 HTML：①所有 苍穹对决vX.Y.Z.apk 链接 ②data-apk-ver 显示的版本
function injectVersion(file, ver, apkName) {
  if (!fs.existsSync(file)) return 0;
  const before = fs.readFileSync(file, 'utf8');
  let after = before
    .replace(/苍穹对决v?[0-9]+\.[0-9]+\.[0-9]+\.apk/g, apkName)
    .replace(/(data-apk-ver>)\s*v?[0-9]+\.[0-9]+\.[0-9]+\s*(<)/g, '$1v' + ver + '$2');
  if (after !== before) fs.writeFileSync(file, after, 'utf8');
  return after === before ? 0 : 1;
}

try {
  fs.mkdirSync(OUT, { recursive: true });
  const manifest = [];
  let n = 0;
  for (const f of FILES) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(OUT, f)); manifest.push(f); n++; }
  }
  for (const d of DIRS) {
    const src = path.join(ROOT, d);
    if (fs.existsSync(src)) n += copyDir(src, path.join(OUT, d), manifest);
  }

  // ---- 版本号相关产物 ----
  const ver = readVersion();
  let apkInfo = '';
  if (ver) {
    const apkName = '苍穹对决v' + ver + '.apk';
    let size = 0;
    if (fs.existsSync(APK_SRC)) {
      fs.copyFileSync(APK_SRC, path.join(OUT, apkName));
      size = fs.statSync(APK_SRC).size;
      manifest.push(apkName); n++;
      apkInfo = apkName + ' (' + (size / 1024).toFixed(0) + ' KB)';
    } else {
      apkInfo = '⚠ 未找到 ' + APK_SRC + '，跳过 APK 复制（先编译安卓版）';
    }
    const vjson = {
      version: ver,
      apk: apkName,
      url: APK_HOST + encodeURIComponent(apkName),
      size: size,
      builtAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(OUT, 'version.json'), JSON.stringify(vjson, null, 2) + '\n', 'utf8');
    manifest.push('version.json'); n++;
    const hit1 = injectVersion(path.join(OUT, 'index.html'), ver, apkName);
    const hit2 = injectVersion(path.join(OUT, 'play', 'index.html'), ver, apkName);
    apkInfo += ' · 下载入口注入：落地页 ' + (hit1 ? '✓' : '已是最新') + ' / 游戏页 ' + (hit2 ? '✓' : '已是最新');
  } else {
    apkInfo = '⚠ 未能从 安卓版/app/build.gradle 读到 versionName，跳过版本号相关产物';
  }

  // 清理清单外的残留文件（上次打包后被删掉的源文件、临时文件等）；清不掉只提示
  const inManifest = new Set(manifest.map(p => p.toLowerCase()));
  const stale = [];
  for (const entry of fs.readdirSync(OUT, { recursive: true })) {
    const rel = path.relative(OUT, path.join(OUT, entry));
    if (fs.statSync(path.join(OUT, entry)).isFile() && !inManifest.has(rel.toLowerCase())) stale.push(rel);
  }
  const notRemoved = [];
  for (const s of stale) if (!safeRm(path.join(OUT, s))) notRemoved.push(s);

  // 清理空目录（源里删掉的文件夹会在发布目录留下空壳，如旧的 js/ingame、js/world/空战对决）
  function pruneEmpty(dir) {
    let empty = true;
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      if (fs.statSync(p).isDirectory()) { if (pruneEmpty(p)) fs.rmdirSync(p); else empty = false; }
      else empty = false;
    }
    return empty;
  }
  try { pruneEmpty(OUT); } catch (e) {}

  console.log('已更新发布目录：' + OUT);
  console.log('本次写入 ' + n + ' 个文件');
  console.log('版本 ' + (ver || '?') + ' · ' + apkInfo);
  if (notRemoved.length) {
    console.log('⚠ 以下残留文件删除失败（可能被占用），请手动删除后再上传：');
    for (const s of notRemoved) console.log('  - ' + s);
  }
  console.log('');
  console.log('上传：把「发布」文件夹整体拖进 Cloudflare Pages（站点根目录即含 APK 与 version.json）。');
  console.log('不要上传：安卓版/（构建产物）、server/（含保留名 wrangler.toml）、.workbuddy/');
} catch (e) {
  console.error('打包失败：' + (e && e.message));
  process.exitCode = 1;
}
