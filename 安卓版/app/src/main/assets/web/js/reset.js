// js/reset.js — 软重置：回到主菜单，不刷新页面（v3.11.2）
//
// 为什么需要：之前「返回菜单 / 练习返回 / 建房返回 / 被踢 / 房主掉线 / 超时」全部走
// location.reload()。刷新会白屏、重新下载全部模块、丢掉已加载的模式包，观感像网页崩了。
// 这里按「停输入 → 断连 → 清实体 → 清状态 → 清 UI → 重建菜单 3D」的顺序就地复位。
//
// 注意：
//  · 必须在清实体前断连，否则对端 onClose 会触发又一轮处理；
//  · clearUnits() 负责从 scene 移除并清空 planes/aaguns 字典（含 bot）；
//  · showMenuScene() 内部会 clearMenuProps + rebuildWorld，不要再手动 rebuild 一次。
import {
  STATE, planes, aaguns, nets, roster, pingProbe, pickSelections,
  mapLobbyTimerId, pickTimer, setHostPeerId, setIAmHost, setMode, setMyTeam, setMySlot,
  setKillCount, setSbRows, setPickPhase, setMyPickSide, setPickDealPending, setPickTimer,
  setMapLobbyTimerId, setLobbyPickedMap, setAimYaw, setAimPitch, setZoom, setFireT, setMyName,
} from './state.js?v=1543';
import { clearUnits } from './units.js?v=1543';
import { resetState } from './match.js?v=1543';
import { rockets, bullets, resetKillLedger } from './combat.js?v=1543';
import { resetNetState } from './netev.js?v=1543';   // 联机簿记（seq 表/碰撞去重/延迟探测标记）
import { $, hud, menu, matchPanel, clearKillFeed, bannerEl, subBannerEl } from './hud.js?v=1543';
import { hideAllPanels } from './lobby.js?v=1543';
import { showMenuScene } from './scene3d.js?v=1543';
import { stopMicSend } from './voice.js?v=1543';

/* 回到主菜单。opts.silent = 不弹提示（调用方自己已经提示过） */
export function backToMenu(opts) {
  const o = opts || {};

  // 1) 输入/视角：先松手，避免松开鼠标时还在开火
  setFireT(0); setAimYaw(0); setAimPitch(0); setZoom(false);
  if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (e) {} }
  try { stopMicSend(); } catch (e) { /* 语音未初始化 */ }

  // 2) 断连（对端 onClose 会各自走软重置）
  for (const id in nets) { try { nets[id].close(); } catch (e) {} delete nets[id]; }

  // 3) 实体与弹道
  clearUnits();
  for (const r of rockets) { r.active = false; if (r.mesh) r.mesh.visible = false; }
  for (const b of bullets) { b.active = false; if (b.mesh) b.mesh.visible = false; }

  // 4) 定时器（选图超时 / 选人 / 延迟探测）
  if (mapLobbyTimerId) { clearTimeout(mapLobbyTimerId); setMapLobbyTimerId(null); }
  if (pickTimer) { clearTimeout(pickTimer); setPickTimer(null); }
  for (const k in pingProbe) { if (pingProbe[k] && pingProbe[k].timer) clearTimeout(pingProbe[k].timer); delete pingProbe[k]; }

  // 5) 对局与网络状态
  resetState();
  roster.length = 0;
  resetNetState();     // v3.12：清 seq 去重表 / 碰撞去重 / 命中结算表 / 延迟探测与踢人标记 / 开战兜底定时器
  for (const k in pickSelections) delete pickSelections[k];
  setMode(null); setIAmHost(false); setHostPeerId(null);
  /* 名字也一起清（v3.15）：建房时 myName 会被设成「房主」并一直留着，
     回菜单后进练习模式，击杀播报就会把本地玩家叫成「房主」。留空 → nameOfPlayer 兜底成「你」。 */
  setMyName('');
  setMyTeam(0); setMySlot(0);
  setPickPhase(false); setMyPickSide(-1); setPickDealPending(false);
  setLobbyPickedMap(null);
  setKillCount(0); setSbRows([]); resetKillLedger();
  STATE.matchEnded = false;

  // 6) UI
  clearKillFeed();
  hud.classList.add('hidden');
  if (matchPanel) matchPanel.classList.add('hidden');
  ['pickPanel', 'mapLobbyPanel', 'sbWrap', 'btnSbTxt'].forEach((id) => { const el = $(id); if (el) el.classList.add('hidden'); });
  /* ★ body 级浮层必须逐个收：它们不在 #hud 容器里，hide 掉 hud 对它们无效 ——
     实测返回菜单后直升机枪镜的四角框（#heliCamUi.on）和武器条（#weaponHud）会留在屏幕上。 */
  const hcu = $('heliCamUi'); if (hcu) hcu.classList.remove('on', 'bomb');
  const wh = $('weaponHud'); if (wh) wh.style.display = 'none';
  /* ★ 暂停遮罩 #pause 也必须在这里收掉（v3.14.8）：它同样不在 #hud 里，hideAllPanels 也不管它。
     复现：第二个窗口从头到尾没拿到指针锁 → plFail 亮了「已暂停」，打完这局点「回到大厅」后，
     这层 z-index:30 的半透明遮罩仍盖在菜单上；它的 click 只在 STATE.started 时才去锁鼠标，
     菜单状态下点了毫无反应 → 看上去"暂停消不掉，只能刷新页面"。 */
  const pz = $('pause'); if (pz) pz.classList.add('hidden');
  const df = $('dmgFlash'); if (df) df.style.opacity = 0;
  const hk = $('hitmark'); if (hk) hk.style.opacity = 0;
  const ph = $('partHit'); if (ph) ph.style.opacity = 0;
  if (bannerEl) bannerEl.style.opacity = 0;
  if (subBannerEl) subBannerEl.style.opacity = 0;
  const ghost = document.querySelector('.pickGhost'); if (ghost) ghost.remove();
  const touch = $('touchUI'); if (touch) touch.classList.remove('on');
  menu.classList.remove('hidden');
  document.body.classList.remove('playing');

  // 7) 主菜单（含 3D 展示场景）
  /* ★ 只能 hideAllPanels，不能再 showMenuBox（v3.11.5）：
     #menuBoxBody 自己就带 .menuBox 玻璃样式（渐变+描边+圆角+padding），不是透明的纯容器。
     hideAllPanels 把它 display:none 后，若再 showMenuBox 恢复显示，而里面的二级面板全是 hidden，
     屏幕上就只剩一条 640×62 的空玻璃条 —— 就是"销不掉的框"。
     正常主菜单（首次进页面）它本来就是 display:none，回菜单应与之一致。 */
  hideAllPanels();
  try { showMenuScene(); } catch (e) { /* 模式包未就绪时保持现有场景 */ }

  if (!o.silent) { /* 提示由调用方负责，避免重复 toast */ }
  return true;
}
