// js/main.js — 《苍穹对决》入口（纯装配文件）
//
// 启动顺序：
//   ① 读取 js/modes.json（由 server/scan-modes.js 扫描 js/modes/*/mode.json 自动生成）
//   ② 加载清单里的第一个模式包（默认排序最靠前的那个）
//   ③ 复位对局状态 → 用清单渲染大厅玩法药丸 → 切到该模式（菜单 3D 展示 + 大厅皮肤）
//
// 新增玩法：在 js/modes/ 下加一个文件夹（mode.json + index.js + net.js + maps.js + maps/ + lobby.css），
// 开发服务器 / 打包脚本会自动把它写进清单 —— 不用改本文件、lobby.js 或任何 HTML。
import { resetState } from './match.js?v=1516';
import { readModes, loadMode } from './mode.js?v=1516';
import { renderModeTabs, setMenuGm } from './lobby.js?v=1516';
import { setGamemode } from './state.js?v=1516';

let modes = [];
try {
  modes = await readModes();
} catch (e) {
  const tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:999;'
    + 'padding:18px 24px;border-radius:14px;background:rgba(255,255,255,.94);color:#7f1d1d;'
    + 'font:500 14px/1.7 "Noto Sans SC",sans-serif;box-shadow:0 18px 50px rgba(0,0,0,.18);text-align:center';
  tip.innerHTML = '模式清单读取失败<br><span style="font-weight:400;color:#475569">请确认 js/modes.json 存在（运行 node server/scan-modes.js 或 node server/pack.js）</span>';
  document.body.appendChild(tip);
  throw e;
}

const first = modes[0];
setGamemode(first.id);
await loadMode(first.id);          // 加载模式包（index.js / maps.js / net.js）
resetState();                      // 默认地图来自刚加载的 mode.json
// ★ 先完成首个模式的切换（展示件 + 菜单 3D + lobby.css），再渲染药丸：
//   否则药丸先出现，玩家在启动切换还没完成时点别的玩法会产生竞态
await setMenuGm(first.id);
renderModeTabs();                  // 大厅药丸由清单渲染（HTML 里不再写死）
