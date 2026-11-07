// server/mirror-github.js —— 把当前代码镜像到 github/ 仓库目录
//
// 用法（仓库根目录）：node server/mirror-github.js
//
// 做的事：
//   1. 覆盖复制 网页（index.html / play / js / vendor / articles / server / docs / 部署说明.md）
//   2. 覆盖复制 安卓版/ 源码（排除 .gradle / build / .idea / local.properties / native-backup）
//   3. 删除 github/ 里源中已不存在的文件与文件夹（旧代码痕迹一并清除）
//   4. 保留 github/README.md 与 github/.gitignore（不覆盖）
//
// README 单独维护：github/README.md 是全项目唯一的说明文档（通信/联机架构优先）。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DST = path.join(ROOT, 'github');
const SKIP_DIRS = new Set(['.gradle', 'build', '.idea', 'native-backup', 'node_modules']);
const SKIP_FILES = new Set(['local.properties', 'README.md']);
const TOP_FILES = ['index.html', 'favicon.svg', 'robots.txt', 'sitemap.xml', 'host-mini-world-arch.html', '部署说明.md'];
const TOP_DIRS = ['play', 'js', 'vendor', 'articles', 'server', 'docs'];

function mirror(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  const names = new Set(fs.readdirSync(src));
  for (const n of names) {
    const s = path.join(src, n), d = path.join(dst, n);
    if (fs.statSync(s).isDirectory()) {
      if (SKIP_DIRS.has(n)) continue;
      mirror(s, d);
    } else {
      if (SKIP_FILES.has(n)) continue;
      fs.copyFileSync(s, d);
    }
  }
  for (const n of fs.readdirSync(dst)) {
    if (names.has(n)) continue;
    const p = path.join(dst, n);
    if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  }
}

for (const f of TOP_FILES) {
  const s = path.join(ROOT, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(DST, f));
}
for (const d of TOP_DIRS) mirror(path.join(ROOT, d), path.join(DST, d));
mirror(path.join(ROOT, '安卓版'), path.join(DST, '安卓版'));

console.log('github/ 已镜像到当前代码（README 与 .gitignore 保留不动）');
