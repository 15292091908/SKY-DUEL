// 安卓 assets 补丁重打（每次 sync-android.js 覆盖后必须执行）
// 用法（仓库根目录）：node server/apply-android-patches.js [安卓版本号]
// 8 处 [ANDROID] 补丁；脚本幂等（已打过会跳过），结束时校验标记数 = 8
const fs = require('fs');
const path = require('path');
const V = process.argv[2] || 'v1.6.1 安卓版';
const D = path.join(__dirname, '..', '安卓版', 'app', 'src', 'main', 'assets', 'web', 'js');
const VFULL = V;
const read = (f) => fs.readFileSync(path.join(D, f), 'utf8').replace(/\r\n/g, '\n');   // 统一 LF（Windows 写回的文件可能是 CRLF，导致 find 串匹配失败）
const write = (f, s) => fs.writeFileSync(path.join(D, f), s);
let ok = 0, skip = 0;
const patch = (file, find, repl, note) => {
  let s = read(file);
  if (s.includes(repl.slice(0, 60)) && s.includes('[ANDROID]')) { console.log('  跳过（已打）: ' + note); skip++; return; }
  if (!s.includes(find)) { console.error('  ✗ 未匹配: ' + note + ' @ ' + file); process.exitCode = 1; return; }
  write(file, s.replace(find, repl));
  console.log('  ✓ ' + note); ok++;
};

// ① audio.js 音量（读 sd_settings.vol）
patch('audio.js',
  '// 纯 Web Audio API 合成音效：引擎、风声、机炮、命中、受击、爆炸、告警、回合音乐\n',
  '// 纯 Web Audio API 合成音效：引擎、风声、机炮、命中、受击、爆炸、告警、回合音乐\n'
  + '// [ANDROID] 音量补丁：默认音量读设置面板 localStorage(\'sd_settings\').vol（0~1），未设置时与网页版一致 0.55\n'
  + 'const VOL_DEFAULT = (() => { try { const s = JSON.parse(localStorage.getItem(\'sd_settings\') || \'{}\'); const v = parseFloat(s.vol); return isNaN(v) ? 0.55 : Math.max(0, Math.min(1, v)); } catch (e) { return 0.55; } })();',
  'audio.js 音量默认值');
patch('audio.js', '    this.master.gain.value = 0.55;', '    this.master.gain.value = VOL_DEFAULT;   // [ANDROID]', 'audio.js gain 取值');

// ② config.js 版本号（安卓独立版本号；注释里的"底层快照"自动读网页版 GAME_VERSION，避免写死过期）
(function patchVer() {
  let snap = 'v?';
  try {
    const web = fs.readFileSync(path.join(__dirname, '..', 'js', 'config.js'), 'utf8');
    const m = web.match(/export const GAME_VERSION = '([^']+)'/);
    if (m) snap = m[1];
  } catch (e) { /* 忽略：保持占位 */ }
  let s = read('config.js');
  if (s.includes("GAME_VERSION = '" + VFULL + "'")) { console.log('  跳过（已打）: config.js GAME_VERSION = ' + VFULL); skip++; return; }
  const before = s;
  s = s.replace(/export const GAME_VERSION = '[^']*(安卓版)?';(\s*\/\/ \[ANDROID\][^\n]*)?/,
    "export const GAME_VERSION = '" + VFULL + "';   // [ANDROID] 安卓版独立版本号（底层游戏快照 " + snap + "）");
  if (s === before) { console.error('  ✗ 未匹配: config.js GAME_VERSION'); process.exitCode = 1; return; }
  write('config.js', s);
  console.log('  ✓ config.js GAME_VERSION = ' + VFULL + '（快照 ' + snap + '）'); ok++;
})();

// ③ config.js 触屏灵敏度
patch('config.js', 'export const TOUCH_SENS = 1.7;',
  '// [ANDROID] 触屏灵敏度补丁：读设置面板 localStorage(\'sd_settings\').touchSens（默认 1.7 与网页版一致）\n'
  + 'const _sdCfg = (() => { try { return JSON.parse(localStorage.getItem(\'sd_settings\') || \'{}\'); } catch (e) { return {}; } })();\n'
  + 'export const TOUCH_SENS = _sdCfg.touchSens === undefined ? 1.7 : parseFloat(_sdCfg.touchSens);',
  'config.js TOUCH_SENS');

// ④ core.js 画质
patch('core.js',
  'export const GFX = {\n  shadows: !isTouch,\n  shadowSize: 2048,\n  pixelCap: isTouch ? 1.25 : 2\n};',
  '// [ANDROID] 设置面板补丁：画质/阴影存于 localStorage(\'sd_settings\')，默认值与网页版一致\n'
  + 'const _sdSet = (() => { try { return JSON.parse(localStorage.getItem(\'sd_settings\') || \'{}\'); } catch (e) { return {}; } })();\n'
  + 'export const GFX = {\n  shadows: _sdSet.shadows === undefined ? !isTouch : !!_sdSet.shadows,\n  shadowSize: 2048,\n  pixelCap: _sdSet.pixel === undefined ? (isTouch ? 1.25 : 2) : parseFloat(_sdSet.pixel)\n};',
  'core.js GFX 画质');

// ⑤ scene3d.js 菜单触屏手势
patch('scene3d.js',
  "  updateMenuZoomLabel();\n}, { passive: true });\nexport function clearMenuProps() {",
  "  updateMenuZoomLabel();\n}, { passive: true });\n"
  + "// [ANDROID] 菜单 3D 展示触屏：单指拖拽旋转 + 双指捏合缩放（面板/按钮区域除外）\n"
  + "let menuPinchD = 0;\n"
  + "document.addEventListener('touchstart', (e) => {\n"
  + "  if (STATE.started) return;\n"
  + "  if (e.target && e.target.closest && e.target.closest('button, textarea, .menuBox, .glassPanel')) return;\n"
  + "  if (e.touches.length === 1) {\n"
  + "    menuDragging = true; menuDragX = e.touches[0].clientX; menuDragY = e.touches[0].clientY; menuPinchD = 0;\n"
  + "  } else if (e.touches.length === 2) {\n"
  + "    menuDragging = false;\n"
  + "    menuPinchD = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);\n"
  + "  }\n"
  + "}, { passive: true });\n"
  + "document.addEventListener('touchmove', (e) => {\n"
  + "  if (STATE.started) return;\n"
  + "  if (e.touches.length === 1 && menuDragging) {\n"
  + "    const t = e.touches[0];\n"
  + "    menuCamOrbitYaw -= (t.clientX - menuDragX) * 0.005;\n"
  + "    menuCamOrbitPitch = THREE.MathUtils.clamp(menuCamOrbitPitch + (t.clientY - menuDragY) * 0.005, MENU_PITCH_MIN, MENU_PITCH_MAX);\n"
  + "    menuDragX = t.clientX; menuDragY = t.clientY;\n"
  + "  } else if (e.touches.length === 2 && menuPinchD > 0) {\n"
  + "    const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);\n"
  + "    if (d > 0) {\n"
  + "      menuCamDist = THREE.MathUtils.clamp(menuCamDist * menuPinchD / d, MENU_DIST_MIN, MENU_DIST_MAX);\n"
  + "      menuPinchD = d; updateMenuZoomLabel();\n"
  + "    }\n"
  + "  }\n"
  + "}, { passive: true });\n"
  + "document.addEventListener('touchend', (e) => {\n"
  + "  if (e.touches.length === 0) { menuDragging = false; menuPinchD = 0; }\n"
  + "}, { passive: true });\n"
  + "export function clearMenuProps() {",
  'scene3d.js 菜单触屏手势');

// ⑥ combat.js 辅助瞄准删除说明
patch('combat.js',
  '/* ================= 地图碰撞 ================= */\nconst _tmpA = new THREE.Vector3();   // 本地临时向量（原 main.js 的 tmpA 拆分后自带）',
  '/* [ANDROID] v0.3.4：辅助瞄准已整体删除。\n'
  + '   v0.3.3 锁机制的实际缺陷：它把机头收敛到「相机→目标」连线，而子弹从机翼枪位（比相机低 ~3.6m、\n'
  + '   靠前 13.5m）射出，弹道与目标线平行偏低 ~2-2.5m——准星看着咬死目标、子弹却始终从下方擦过，\n'
  + '   结构性视差无法自愈，反而劣于手动瞄准，故删除，恢复与网页版完全一致的手动弹道。 */\n\n'
  + '/* ================= 地图碰撞 ================= */\nconst _tmpA = new THREE.Vector3();   // 本地临时向量（原 main.js 的 tmpA 拆分后自带）',
  'combat.js 辅助瞄准说明');

// ⑦ camera.js 准星校真
patch('camera.js',
  '    _look.copy(myPlane.group.position).addScaledVector(_viewDir, 42); _look.y += 2;',
  '    // [ANDROID] v0.3.4 准星校真：lookAt 点与相机同高（原 +2 与相机 +3.6 不等高，光轴比机头低倾\n'
  + '    // ~1.65°，非开镜远距离子弹偏高 20-48m——网页版用户靠开镜狙远，安卓版触屏不开镜就打不到）。\n'
  + '    // 改为 look.y += h 后光轴与机头线严格平行：小准星=弹道方向，开镜/非开镜、近距/远距全部命中一致。\n'
  + '    // 注：v3.4.1 起该段代码从 main.js 迁入 camera.js（拆分），补丁随之迁移。\n'
  + '    _look.copy(myPlane.group.position).addScaledVector(_viewDir, 42); _look.y += h;',
  'camera.js 准星校真');

// 校验
let total = 0;
for (const f of fs.readdirSync(D)) if (f.endsWith('.js')) total += (read(f).match(/\[ANDROID\]/g) || []).length;
console.log('\n补丁计数: ' + total + ' 处（应为 8）· 本次新打 ' + ok + ' 处 / 跳过 ' + skip + ' 处');
if (total !== 8) process.exitCode = 1;
