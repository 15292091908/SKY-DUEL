/* 落地页交互 v4：粒子背景（呼吸闪烁 + 鼠标靠近轻推）/ 一次性 reveal / 数字滚动 / 视差 / 打字机 / 跳转 /play/ */
const $ = (s) => document.querySelector(s);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ================= 背景粒子：多彩光尘，缓慢漂浮 + 呼吸闪烁 + 鼠标轻推 ================= */
const cv = $('#pcv');
if (cv) {
  const ctx = cv.getContext('2d');
  const COLORS = ['124,180,255', '154,140,255', '255,200,120', '110,225,200', '255,150,190'];
  let W = 0, H = 0, DPR = 1, parts = [];
  const mouse = { x: -1e4, y: -1e4 };

  const resize = () => {
    DPR = Math.min(devicePixelRatio || 1, 2);
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = W * DPR; cv.height = H * DPR;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  };
  const spawn = () => {
    const n = Math.round(Math.min(70, (W * H) / 26000));
    parts = Array.from({ length: n }, () => {
      const bvx = (Math.random() - 0.5) * 0.16, bvy = -0.05 - Math.random() * 0.16;
      return {
        x: Math.random() * W, y: Math.random() * H,
        r: 1.2 + Math.random() * 2.6,
        vx: bvx, vy: bvy, bvx, bvy,              // b* = 基础漂移（被推动后回归，从哪来回哪去）
        c: COLORS[(Math.random() * COLORS.length) | 0],
        ph: Math.random() * Math.PI * 2,
        tw: 0.4 + Math.random() * 0.9,
      };
    });
  };

  const draw = (t) => {
    if (cv.offsetParent === null || cv.clientWidth === 0) {   // 画布不可见 → 挂起，不空转
      setTimeout(() => requestAnimationFrame(draw), 500);
      return;
    }
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      // 鼠标靠近时把光尘轻轻推开（背景"有反应"，但不做水波那种强效果）
      const dx = p.x - mouse.x, dy = p.y - mouse.y, d2 = dx * dx + dy * dy;
      if (d2 < 10000 && d2 > 0.01) {
        const d = Math.sqrt(d2), f = (1 - d / 100) * 0.16;
        p.vx += (dx / d) * f; p.vy += (dy / d) * f;
      }
      p.vx += (p.bvx - p.vx) * 0.04; p.vy += (p.bvy - p.vy) * 0.04;   // 回归基础漂移
      p.x += p.vx; p.y += p.vy;
      if (p.y < -8) { p.y = H + 8; p.x = Math.random() * W; }
      if (p.x < -8) p.x = W + 8;
      if (p.x > W + 8) p.x = -8;

      const a = 0.26 + 0.48 * (0.5 + 0.5 * Math.sin(t * 0.001 * p.tw + p.ph));
      const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 3.2);
      g.addColorStop(0, `rgba(${p.c},${a})`);
      g.addColorStop(1, `rgba(${p.c},0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 3.2, 0, Math.PI * 2); ctx.fill();
    }
    if (!document.hidden) requestAnimationFrame(draw);
    else setTimeout(() => requestAnimationFrame(draw), 600);
  };

  resize(); spawn();
  addEventListener('resize', () => { resize(); spawn(); }, { passive: true });
  addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });
  addEventListener('pointerleave', () => { mouse.x = -1e4; mouse.y = -1e4; }, { passive: true });

  if (!REDUCED) requestAnimationFrame(draw);
  else {   // 降级：静态一帧
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      ctx.fillStyle = `rgba(${p.c},.35)`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
  }
}

/* ================= 打字机标题：SKY DUEL ================= */
const title = $('#heroTitle');
const TEXT = 'SKY DUEL';
if (title) {
  const caret = title.querySelector('.caret');
  let i = 0;
  const tick = () => {
    if (i < TEXT.length) {
      const ch = document.createElement('span');
      ch.className = 'ch';
      ch.textContent = TEXT[i];
      if (TEXT[i] === ' ') ch.style.width = '.34em';
      title.insertBefore(ch, caret);
      i++;
      setTimeout(tick, TEXT[i - 1] === ' ' ? 420 : 150 + Math.random() * 90);
    }
  };
  setTimeout(tick, 500);
}

/* ================= reveal：进视口浮入一次，之后保持不变（避免抽搐） ================= */
const io = new IntersectionObserver((es) => {
  for (const e of es) {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }
}, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

/* ================= 数字滚动 ================= */
const nio = new IntersectionObserver((es) => {
  for (const e of es) {
    if (!e.isIntersecting) continue;
    nio.unobserve(e.target);
    const el = e.target, target = +el.dataset.count, suffix = el.dataset.suffix || '';
    const t0 = performance.now(), dur = 1100;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), ease = 1 - Math.pow(1 - k, 3);
      el.textContent = Math.round(target * ease) + suffix;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}, { threshold: 0.6 });
document.querySelectorAll('[data-count]').forEach((el) => nio.observe(el));

/* ================= 滚动视差：Hero 上移淡出 + 大图横移（进离视口对称） ================= */
const heroCopy = $('#heroCopy'), heroScene = $('.heroScene');
const parallaxEls = [...document.querySelectorAll('[data-px]')];
if (!REDUCED) {
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = scrollY, vh = innerHeight;
      if (heroCopy && y < 900) {
        heroCopy.style.transform = `translateY(${y * 0.3}px)`;
        heroCopy.style.opacity = Math.max(0, 1 - y / 560);
      }
      if (heroScene && y < 900) heroScene.style.transform = `translateY(${y * 0.12}px)`;
      for (const el of parallaxEls) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom < -80 || rect.top > vh + 80) continue;
        const p = (rect.top + rect.height / 2 - vh / 2) / vh;
        el.style.transform = `translateX(${(+el.dataset.px) * p}px)`;
      }
      ticking = false;
    });
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

/* ================= 开始游戏：过渡 → 跳转 /play/ ================= */
const btn = $('#btnStartGame');
if (btn) {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (document.body.classList.contains('leaving')) return;
    btn.textContent = '进入战场…';
    document.body.classList.add('leaving');
    setTimeout(() => { location.href = '/play/'; }, 640);
  });
}
