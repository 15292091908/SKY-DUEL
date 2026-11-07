// js/killcam.js — 死斗击杀镜头（v3.15）
/* 死斗没有歼灭模式的自由观战：阵亡后只做两件事 ——
   ① 相机短暂跟随击杀者（由 spectate.js 提供目标、camera.js 负责运镜）；
   ② 屏幕上方一张小卡显示「被谁击落 / 所属阵营 / 致命武器」+ 重生倒计时。
   状态统一放在 STATE.killcam，重生报文到达时由 combat.applyRespawnLocal 清掉。 */
import { STATE } from './state.js?v=1543';
import { DM_RESPAWN_MS, DM_KILLCAM_HARD_MS } from './config.js?v=1543';

let box = null, titleEl = null, metaEl = null, cdEl = null;

function ensureBox() {
  if (box) return;
  box = document.createElement('div');
  box.id = 'killcamBox';
  box.style.cssText = 'position:fixed;left:50%;top:13%;transform:translateX(-50%);z-index:58;min-width:250px;'
    + 'font:600 13px/1.6 "Noto Sans SC","PingFang SC",sans-serif;color:#1c2b3a;text-align:center;'
    + 'background:rgba(255,255,255,.86);-webkit-backdrop-filter:blur(14px) saturate(1.6);backdrop-filter:blur(14px) saturate(1.6);'
    + 'border:1px solid rgba(255,255,255,.95);border-radius:16px;padding:11px 22px;'
    + 'box-shadow:0 16px 40px rgba(20,40,70,.18);pointer-events:none;display:none;';
  box.innerHTML = '<div id="kcTitle" style="font-size:15px;font-weight:800;letter-spacing:1px"></div>'
    + '<div id="kcMeta" style="font-size:12.5px;color:#5b7691;margin-top:3px"></div>'
    + '<div id="kcCd" style="font-size:12px;color:#2563eb;margin-top:5px;letter-spacing:1px"></div>';
  document.body.appendChild(box);
  titleEl = box.querySelector('#kcTitle');
  metaEl = box.querySelector('#kcMeta');
  cdEl = box.querySelector('#kcCd');
}
/* info: { by, name, teamLabel, weapon } —— by 为空表示坠毁/出界（没有击杀者） */
export function showKillcam(info) {
  ensureBox();
  const o = info || {};
  if (o.by) {
    titleEl.textContent = '💥 被 ' + (o.name || '未知玩家') + ' 击落';
    metaEl.textContent = (o.teamLabel || '敌方') + ' · ' + (o.weapon || '机炮');
  } else {
    titleEl.textContent = '💥 你 坠毁了';
    metaEl.textContent = o.weapon || '撞地 / 出界';
  }
  box.style.display = 'block';
  const now = performance.now();
  STATE.killcam = { by: o.by || '', name: o.name || '', teamLabel: o.teamLabel || '', weapon: o.weapon || '', start: now, until: now + DM_RESPAWN_MS, hard: now + DM_KILLCAM_HARD_MS };
}
export function updateKillcam() {
  const k = STATE.killcam;
  if (!k) return;
  const now = performance.now();
  const left = Math.max(0, (k.until - now) / 1000);
  if (cdEl) cdEl.textContent = left > 0 ? left.toFixed(1) + 's 后重生' : '重生中…';
  // 兜底：房主的 respawn 报文若丢失，最多多等 3 秒就收回卡片（相机回到坠机点），
  // 避免玩家永远卡在击杀镜头里（下一帧 sync 仍会把他拉回权威状态）。
  if (now > k.hard) clearKillcam();
}
export function clearKillcam() {
  if (STATE.killcam) STATE.killcam = null;
  if (box) box.style.display = 'none';
}
