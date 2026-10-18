// js/hud.js — HUD 与提示层（v3.4 从 main.js 抽出）
// 职责：DOM 元素引用、横幅/浮层提示（banner/subBanner/menuToast）、命中提示（showPart/showHitmark）、
//       比分圆点（updateScore）、击杀播报（addKillFeed/clearKillFeed）、提示计时器（tickHudTimers）
import { STATE, roster, myPeerId, myName } from './state.js?v=1516';
import { WIN_ROUNDS, KILL_FEED_MAX, KILL_FEED_TTL } from './config.js?v=1516';

/* ================= DOM ================= */
export const $ = (id) => document.getElementById(id);
export const hud = $('hud'), menu = $('menu'), pauseEl = $('pause');
export const hpFill = $('hpFill'), foeHpFill = $('foeHpFill'), hpLabel = $('hpLabel');
export const speedVal = $('speedVal'), altVal = $('altVal');
export const bannerEl = $('banner'), subBannerEl = $('subBanner'), warnEl = $('warn');
export const hitmarkEl = $('hitmark'), partHitEl = $('partHit'), dmgFlashEl = $('dmgFlash');
export const pipsMeEl = $('pipsMe'), pipsFoeEl = $('pipsFoe'), scoreTextEl = $('scoreText');
export const roundLabelEl = $('roundLabel');
export const matchPanel = $('matchPanel'), matchTitle = $('matchTitle'), matchSub = $('matchSub');
export const fpsValEl = $('fpsVal'), pingValTextEl = $('pingValText');
export const planeReticle = $('planeReticle');
export const rosterPanel = $('rosterPanel'), rosterMineUnits = $('rosterMineUnits'), rosterFoeUnits = $('rosterFoeUnits');
export const killValEl = $('killVal');

export let bannerTimer = 0, partHitTimer = 0, hitmarkTimer = 0;

export function banner(text, color = '#fff', dur = 2.2) {
  bannerEl.textContent = text; bannerEl.style.color = color; bannerEl.style.opacity = 1; bannerTimer = dur;
}
export function subBanner(text, dur = 2.2) {
  subBannerEl.textContent = text; subBannerEl.style.opacity = text ? 1 : 0;
  if (dur > 0) setTimeout(() => { subBannerEl.style.opacity = 0; }, dur * 1000);
}
// 菜单阶段也能看见的通知。banner/subBanner 都挂在 HUD 里，菜单打开时 HUD 整体隐藏
// → 「有人掉线」「你的阵营」这类大厅提示曾经完全不可见（实测踩过），所以走 body 级浮层。
export let menuToastEl = null, menuToastTimer = 0;
export function menuToast(text, color = '#ffd76b', dur = 3) {
  if (!menuToastEl) {
    menuToastEl = document.createElement('div');
    menuToastEl.style.cssText = 'position:fixed;left:50%;top:16%;transform:translateX(-50%);z-index:120;'
      + 'padding:10px 18px;border-radius:10px;background:rgba(10,22,38,.88);'
      + 'font:600 15px/1.5 "Noto Sans SC","PingFang SC",sans-serif;color:#fff;'
      + 'box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:none;transition:opacity .25s;text-align:center;max-width:86vw;';
    document.body.appendChild(menuToastEl);
  }
  menuToastEl.textContent = text;
  menuToastEl.style.color = color;
  menuToastEl.style.opacity = '1';
  clearTimeout(menuToastTimer);
  menuToastTimer = setTimeout(() => { menuToastEl.style.opacity = '0'; }, dur * 1000);
}
export function showPart(text) { partHitEl.textContent = text; partHitEl.style.opacity = 1; partHitTimer = 0.8; }
export function showHitmark(kill) { hitmarkEl.classList.toggle('kill', !!kill); hitmarkEl.style.opacity = 1; hitmarkTimer = 0.13; }
/* 误伤队友警示（v3.5.1）：只要对队友造成伤害就弹出，屏幕中下方醒目红字，1.4s 淡出。
   用 body 级浮层而不是写进 HUD DOM —— 网页版与安卓版 index.html 是两份独立副本，
   动态创建可让两端共用同一套逻辑（与 menuToast 同思路，但定位在下方）。 */
export let ffWarnEl = null, ffWarnTimer = 0;
export function showFriendlyFire() {
  if (!ffWarnEl) {
    ffWarnEl = document.createElement('div');
    ffWarnEl.style.cssText = 'position:fixed;left:50%;bottom:17%;transform:translateX(-50%);z-index:60;'
      + 'padding:8px 22px;border-radius:999px;background:rgba(122,22,16,.84);border:1px solid rgba(255,124,96,.6);'
      + 'font:700 17px/1.4 "Noto Sans SC","PingFang SC",sans-serif;color:#ffdcd6;letter-spacing:3px;'
      + 'text-shadow:0 0 10px rgba(255,80,60,.85);box-shadow:0 6px 22px rgba(0,0,0,.4);'
      + 'pointer-events:none;opacity:0;transition:opacity .18s;';
    document.body.appendChild(ffWarnEl);
  }
  ffWarnEl.textContent = '误伤队友';
  ffWarnEl.style.opacity = '1';
  clearTimeout(ffWarnTimer);
  ffWarnTimer = setTimeout(() => { if (ffWarnEl) ffWarnEl.style.opacity = '0'; }, 1400);
}
export function updateScore() {
  scoreTextEl.textContent = STATE.myScore + ' : ' + STATE.foeScore;
  const build = (el, n, cls) => {
    el.innerHTML = '';
    for (let i = 0; i < WIN_ROUNDS; i++) { const d = document.createElement('span'); d.className = 'pip' + (i < n ? ' on ' + cls : ''); el.appendChild(d); }
  };
  build(pipsMeEl, STATE.myScore, 'me');
  build(pipsFoeEl, STATE.foeScore, 'foe');
}

/* ================= 击杀播报（右上角白字，自动淡出） =================
   权威来源是房主的 recordAuthKill（"谁击杀了谁"只在那里成立）：
   房主记台账 + 本地播报 + 广播 kill 事件；非房主收到事件后播报。练习模式纯本地播报。
   击杀者可能为空（环境伤害/自毁/撞海）→ 播报「X 坠毁」。 */
export const killFeedEl = document.getElementById('killFeed');
export const killFeedRows = [];                 // [{ el, t }] 按加入顺序
// 玩家 id → 显示名（roster 里的真名；自己/人机各给固定文案）
export function nameOfPlayer(id) {
  if (!id) return '';
  if (id === myPeerId) return myName || '你';
  if (id === 'bot') return '练习对手';
  const p = roster.find(x => x.peerId === id);
  return (p && p.name) || '未知玩家';
}
// ff = true 表示"误杀队友"（击杀者与受害者同阵营）→ 播报用「误杀」而不是「击败」
export function addKillFeed(killer, victim, kn, vn, ff, sk) {
  if (!killFeedEl) return;
  const el = document.createElement('div');
  el.className = 'kfItem';
  // 误杀队友 / 自炸（自己误伤自己）都染成红橙色（不用额外 CSS 类，避免动两份 index.html）
  if (ff || sk) el.style.color = '#ff9d86';
  const a = document.createElement('b');
  // 名字优先用事件里带的（房主解析好的）：玩家端 roster 可能还没同步全，避免显示"未知玩家"
  const killerName = kn !== undefined ? kn : nameOfPlayer(killer);
  const victimName = vn !== undefined ? vn : nameOfPlayer(victim);
  if (killer) {
    a.textContent = killerName;
    const mid = document.createElement('span');
    // sk(自炸)：自己发射的火箭/溅射炸到自己 → 「X 误伤 X」；ff(误杀队友) → 「X 误杀 Y」；常规 → 「X 击败 Y」
    mid.textContent = sk ? ' 误伤 ' : (ff ? ' 误杀 ' : ' 击败 ');
    const b = document.createElement('b'); b.textContent = victimName;
    el.append(a, mid, b);
  } else {
    a.textContent = victimName;
    const mid = document.createElement('span'); mid.textContent = ' 坠毁';   // killer 为空 = 撞海/撞楼/出界等环境死亡
    el.append(a, mid);
  }
  killFeedEl.appendChild(el);
  requestAnimationFrame(() => el.classList.add('on'));
  killFeedRows.push({ el, t: performance.now() });
  while (killFeedRows.length > KILL_FEED_MAX) { const r = killFeedRows.shift(); r.el.remove(); }
  setTimeout(() => {                       // 到点淡出并移除（最多 5 条，超出即踢最早的）
    el.classList.remove('on');
    setTimeout(() => {
      el.remove();
      const i = killFeedRows.findIndex(r => r.el === el);
      if (i >= 0) killFeedRows.splice(i, 1);
    }, 400);
  }, KILL_FEED_TTL);
}
export function clearKillFeed() { for (const r of killFeedRows) r.el.remove(); killFeedRows.length = 0; }

// 提示层计时器（每帧由主循环调用）：横幅/命中提示/部位提示的淡出
export function tickHudTimers(dt) {
  if (bannerTimer > 0) { bannerTimer -= dt; if (bannerTimer <= 0) bannerEl.style.opacity = 0; }
  if (partHitTimer > 0) { partHitTimer -= dt; if (partHitTimer <= 0) partHitEl.style.opacity = 0; }
  if (hitmarkTimer > 0) { hitmarkTimer -= dt; if (hitmarkTimer <= 0) hitmarkEl.style.opacity = 0; }
}
