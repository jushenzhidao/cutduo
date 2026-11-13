/**
 * kits/collage/ui.mjs · Screen Collage 的绘制原语
 *
 * 设计令牌全部来自对参考片（refs/replicas/reference/motiongit-promo-main.mp4，
 * 1920×1080@60 / 57s）的逐帧采样，不是凭感觉调的：
 *   · 底色 `#000204`，中心一团 `rgb(13,24,49)` 的深蓝辉光，四角迅速压到全黑
 *   · 字标渐变的实测色阶（x=600 → 1500）：#C4DDF5 → #92C4FD → #C9C1FA → #CE91E4 → #F478B9 → #F2CEC4
 *   · HUD 单色灰是 #6E7590，正文纯白 #FFFFFF
 *
 * 所有函数只依赖 Canvas2D 子集（roundRect / letterSpacing / 渐变 / 阴影），
 * @napi-rs/canvas 与浏览器 chromium 都能跑，不必为两个宿主写两套。
 */

export const C = {
  bg: '#000204',
  ink: '#FFFFFF',
  dim: '#8E94AC',
  faint: '#5A6079',
  ghost: '#3A3F55',
  hair: 'rgba(255,255,255,0.10)',
  hairSoft: 'rgba(255,255,255,0.055)',
  panel: 'rgba(10,12,22,0.82)',
  panel2: 'rgba(255,255,255,0.035)',
  purple: '#7C5CFF',
  purpleDim: '#5B48C8',
  blue: '#5B8CFF',
  cyan: '#6FD3F7',
  pink: '#F56FB0',
  peach: '#F7A87D',
  green: '#5FD08A',
  orange: '#F7A44E',
  red: '#FF5C7A',
};

/** 字标渐变（实测色阶）。token 0→1 沿文字包围盒铺开。 */
export const WORD_STOPS = [
  [0.00, '#DCEBF8'],
  [0.16, '#9FC6FB'],
  [0.36, '#BFB3F9'],
  [0.56, '#CE8FE4'],
  [0.76, '#F472B4'],
  [1.00, '#F6CDBE'],
];

/** 强调文字渐变（"AI" / "one file" / "Same style." 这类短语）。 */
export const ACCENT_STOPS = [
  [0.00, '#7ED8F8'],
  [0.30, '#8FA0FA'],
  [0.60, '#C48BF2'],
  [0.82, '#F76FB2'],
  [1.00, '#F7A87D'],
];

export const FAM = {
  black: 'MonaBlack',
  bold: 'MonaBold',
  semi: 'MonaSemiBold',
  medium: 'MonaMedium',
  regular: 'MonaRegular',
  display: 'MonaDispBlack',
  expBlack: 'MonaExpBlack',
  expBold: 'MonaExpBold',
  expSemi: 'MonaExpSemi',
  mono: 'JBMono',
  monoBold: 'JBMonoBold',
  sc: 'NotoSC Medium',
  scBlack: 'NotoSC Black',
};

/* ---------- 数值 ---------- */

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOut = (t) => 1 - Math.pow(1 - clamp(t), 3);
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeBack = (t) => {
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};
/** 分段线性：把 [t0,t1] 映射到 0..1 */
export const seg = (t, t0, t1) => clamp((t - t0) / Math.max(1e-6, t1 - t0));
/** 错峰入场：第 i 个元素在 base + i*step 开始，持续 dur */
export const stagger = (t, i, base, step, dur) => seg(t, base + i * step, base + i * step + dur);
/** 只在 p>0 时执行，省掉大量无效绘制 */
export const when = (p, fn) => (p > 0 ? fn(clamp(p)) : null);

/* ---------- 颜色 ---------- */

export function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function makeGrad(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [p, c] of stops) g.addColorStop(p, c);
  return g;
}

/* ---------- 形状 ---------- */

export function rr(ctx, x, y, w, h, r) {
  const rad = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rad);
  return ctx;
}

export function fillRR(ctx, x, y, w, h, r, fill) {
  rr(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

export function strokeRR(ctx, x, y, w, h, r, stroke, lw = 1) {
  rr(ctx, x, y, w, h, r);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  ctx.stroke();
}

/** 玻璃面板：底色 + 内高光 + 1px 边框，是全片所有卡片/面板的统一外观 */
export function glass(ctx, x, y, w, h, o = {}) {
  const r = o.r ?? 18;
  ctx.save();
  if (o.shadow !== false) {
    ctx.shadowColor = o.shadowColor ?? 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = o.shadowBlur ?? 40;
    ctx.shadowOffsetY = o.shadowY ?? 18;
  }
  fillRR(ctx, x, y, w, h, r, o.fill ?? C.panel);
  ctx.restore();

  ctx.save();
  rr(ctx, x, y, w, h, r);
  ctx.clip();
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, 'rgba(255,255,255,0.07)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.015)');
  g.addColorStop(1, 'rgba(255,255,255,0.03)');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.restore();

  strokeRR(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r, o.stroke ?? 'rgba(255,255,255,0.10)', 1);
}

/* ---------- 文本 ---------- */

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;

/** 含中日韩字符时换 Noto，Mona Sans 没有中文字形（会渲染成空白，不是方框） */
export function familyFor(str, fam) {
  if (CJK.test(str)) {
    if (fam === FAM.mono || fam === FAM.monoBold) return 'NotoSC Medium';
    return fam === FAM.black || fam === FAM.display ? FAM.scBlack : FAM.sc;
  }
  return fam;
}

export function fontOf(size, fam, weight) {
  return `${weight ? weight + ' ' : ''}${Math.round(size)}px ${fam}`;
}

/** 量宽（带 letterSpacing 时 Skia 会把间距算进 advance，直接量即可） */
export function measure(ctx, str, { size, fam = FAM.semi, tracking = 0 } = {}) {
  ctx.save();
  ctx.font = fontOf(size, familyFor(str, fam));
  if (tracking) ctx.letterSpacing = `${tracking}px`;
  const w = ctx.measureText(str).width;
  ctx.restore();
  return w;
}

/**
 * 画文本。baseline 默认 alphabetic；align 支持 left/center/right。
 * tracking 用 px（Canvas2D letterSpacing，Skia 与 chromium 都支持）。
 */
export function txt(ctx, str, x, y, o = {}) {
  if (str === undefined || str === null || str === '') return 0;
  const size = o.size ?? 24;
  const fam = familyFor(str, o.fam ?? FAM.semi);
  ctx.save();
  ctx.font = fontOf(size, fam, o.weight);
  ctx.letterSpacing = `${o.tracking ?? 0}px`;
  ctx.textAlign = o.align ?? 'left';
  ctx.textBaseline = o.baseline ?? 'alphabetic';
  ctx.fillStyle = o.color ?? C.ink;
  if (o.alpha !== undefined) ctx.globalAlpha = clamp(o.alpha);
  if (o.shadow) {
    ctx.shadowColor = o.shadow;
    ctx.shadowBlur = o.shadowBlur ?? 24;
  }
  ctx.fillText(str, x, y);
  ctx.restore();
  return 0;
}

/** 渐变填充的文字：渐变横跨文字自身宽度（不是整屏），所以每处颜色都对得上 */
export function gradText(ctx, str, x, y, o = {}) {
  if (!str) return 0;
  const size = o.size ?? 24;
  const fam = familyFor(str, o.fam ?? FAM.black);
  ctx.save();
  ctx.font = fontOf(size, fam, o.weight);
  ctx.letterSpacing = `${o.tracking ?? 0}px`;
  ctx.textAlign = o.align ?? 'left';
  ctx.textBaseline = o.baseline ?? 'alphabetic';
  const w = ctx.measureText(str).width;
  const x0 = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
  const g = makeGrad(ctx, x0, y - size * 0.8, x0 + w, y - size * 0.1, o.stops ?? WORD_STOPS);
  ctx.fillStyle = g;
  if (o.alpha !== undefined) ctx.globalAlpha = clamp(o.alpha);
  if (o.shadow) {
    ctx.shadowColor = o.shadow;
    ctx.shadowBlur = o.shadowBlur ?? 30;
  }
  ctx.fillText(str, x, y);
  ctx.restore();
  return w;
}

/** 单色小标签（mono + 字距），HUD / 图注 / 单位统一走这里 */
export function tag(ctx, str, x, y, o = {}) {
  return txt(ctx, str, x, y, {
    size: o.size ?? 13,
    fam: FAM.mono,
    color: o.color ?? C.dim,
    tracking: o.tracking ?? 2,
    align: o.align ?? 'left',
    baseline: o.baseline,
    alpha: o.alpha,
  });
}

/* ---------- 组件 ---------- */

/** 圆点（字标前那个紫点、绿色在线点、时间轴节点都用它） */
export function dot(ctx, x, y, r, color, glow = 0) {
  ctx.save();
  if (glow) {
    ctx.shadowColor = color;
    ctx.shadowBlur = glow;
  }
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/** 胶囊标签：可选前置圆点，自动按文字宽度定宽 */
export function chip(ctx, str, x, y, o = {}) {
  const size = o.size ?? 15;
  const h = o.h ?? size * 2.1;
  const padX = o.padX ?? size * 0.95;
  const dotR = o.dotR ?? (o.dotColor ? 3.2 : 0);
  const fam = familyFor(str, o.fam ?? FAM.medium);
  ctx.save();
  ctx.font = fontOf(size, fam);
  const tw = ctx.measureText(str).width;
  ctx.restore();
  const w = tw + padX * 2 + (dotR ? dotR * 2 + size * 0.42 : 0);
  const left = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
  glass(ctx, left, y - h / 2, w, h, {
    r: h / 2,
    fill: o.fill ?? 'rgba(10,12,20,0.72)',
    stroke: o.stroke ?? 'rgba(255,255,255,0.14)',
    shadow: false,
  });
  let tx = left + padX;
  if (dotR) {
    dot(ctx, tx + dotR, y, dotR, o.dotColor);
    tx += dotR * 2 + size * 0.42;
  }
  txt(ctx, str, tx, y + size * 0.35, { size, fam: o.fam ?? FAM.medium, color: o.color ?? C.ink });
  return w;
}

/** "m" 应用图标：深色玻璃圆角方块 + 白色 m + 左下小紫点 */
export function appIcon(ctx, x, y, size, o = {}) {
  const r = o.r ?? size * 0.27;
  const letter = o.letter || 'm';
  ctx.save();
  if (o.glow !== false) {
    ctx.shadowColor = 'rgba(124,92,255,0.55)';
    ctx.shadowBlur = size * 0.42;
  }
  fillRR(ctx, x, y, size, size, r, '#0B0C14');
  ctx.restore();

  ctx.save();
  rr(ctx, x, y, size, size, r);
  ctx.clip();
  const g = ctx.createLinearGradient(x, y, x + size * 0.5, y + size);
  g.addColorStop(0, 'rgba(255,255,255,0.14)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.03)');
  g.addColorStop(1, 'rgba(255,255,255,0.09)');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, size, size);
  ctx.restore();

  strokeRR(ctx, x + 0.5, y + 0.5, size - 1, size - 1, r, 'rgba(255,255,255,0.18)', 1);

  const ms = size * 0.62;
  txt(ctx, letter, x + size * 0.52, y + size * 0.78, {
    size: ms,
    fam: FAM.black,
    color: '#FFFFFF',
    align: 'center',
  });
  dot(ctx, x + size * 0.26, y + size * 0.72, size * 0.045, C.purple);
}

/**
 * 画媒体。cover = 按焦点裁切铺满；contain = 完整放进框内、余量补源深色底。
 * 语义照抄上游 media 契约（fit / focusX / focusY 0–1），不自己发明。
 */
export function drawMedia(ctx, m, x, y, w, h, r = 10) {
  if (!m || !m.img) return false;
  const { img } = m;
  const iw = img.width;
  const ih = img.height;
  ctx.save();
  rr(ctx, x, y, w, h, r);
  ctx.clip();
  if (m.fit === 'contain') {
    ctx.fillStyle = 'rgba(6,8,14,1)';
    ctx.fillRect(x, y, w, h);
    const s = Math.min(w / iw, h / ih);
    const dw = iw * s;
    const dh = ih * s;
    ctx.drawImage(img, x + (w - dw) * m.focusX, y + (h - dh) * m.focusY, dw, dh);
  } else {
    const s = Math.max(w / iw, h / ih);
    const dw = iw * s;
    const dh = ih * s;
    ctx.drawImage(img, x - (dw - w) * m.focusX, y - (dh - h) * m.focusY, dw, dh);
  }
  ctx.restore();
  return true;
}

/** 四角括线（全片固定装饰） */
export function brackets(ctx, W, H, inset = 16, len = 22, alpha = 0.16) {
  ctx.save();
  ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
  ctx.lineWidth = 1;
  const pts = [
    [inset, inset, 1, 1],
    [W - inset, inset, -1, 1],
    [inset, H - inset, 1, -1],
    [W - inset, H - inset, -1, -1],
  ];
  for (const [x, y, sx, sy] of pts) {
    ctx.beginPath();
    ctx.moveTo(x + sx * len, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + sy * len);
    ctx.stroke();
  }
  ctx.restore();
}

/** 虚线 / 点线连接（spec 场景的连接线） */
export function dottedLine(ctx, x0, y0, x1, y1, color = 'rgba(150,160,200,0.30)', dash = [2, 6]) {
  ctx.save();
  ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.restore();
}

/** 进度小条（flow 的渐变条 / end 的下划线） */
export function bar(ctx, x, y, w, h, stops = ACCENT_STOPS, r = null) {
  const g = makeGrad(ctx, x, y, x + w, y, stops);
  if (r === null) {
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  } else {
    fillRR(ctx, x, y, w, h, r, g);
  }
}

/** 带裁切的出现动画：dir = up / left / center */
export function wipeIn(ctx, x, y, w, h, p, dir = 'up') {
  const e = easeOut(p);
  ctx.save();
  if (dir === 'center') {
    const cw = w * e;
    ctx.beginPath();
    ctx.rect(x + (w - cw) / 2, y - 4, cw, h + 8);
  } else if (dir === 'left') {
    ctx.beginPath();
    ctx.rect(x - 4, y - 4, w * e + 8, h + 8);
  } else {
    ctx.beginPath();
    ctx.rect(x - 4, y + h * (1 - e), w + 8, h * e + 4);
  }
  ctx.clip();
  return () => ctx.restore();
}

/** 打字机：p 为 0..1，返回应显示的字符数（含光标位） */
export function typed(str, p) {
  const n = Math.round(clamp(p) * str.length);
  return str.slice(0, n);
}
