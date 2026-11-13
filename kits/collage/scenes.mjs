/**
 * kits/collage/scenes.mjs · Screen Collage 的 11 个场景
 *
 * 每个场景是一个纯函数 `(ctx, a, t, d) => void`：
 *   a = 该场景的 args（内容全在这里，渲染层不认识"产品"，只认识槽位）
 *   t = 场景内局部时间（秒）  d = 场景原长（秒）
 *
 * 时间轴硬约定（来自 guide.json 的 duration.rules，照抄不改）：
 *   hero 4.5 / recipe 6.5 / open 3.5 / pack 6.5 / flow 10 / adapt 4
 *   reuse 5.5 / spec 4 / share 4 / finale 4 / end 4.5  ⇒ 合计 57
 * 场景内动画一律按 t/d 归一，不写死绝对秒数，改时长不会错位。
 */
import {
  C, FAM, WORD_STOPS, ACCENT_STOPS, drawMedia,
  clamp, lerp, easeOut, easeInOut, easeBack, seg, stagger,
  hexA, makeGrad, rr, fillRR, strokeRR, glass,
  txt, gradText, tag, dot, chip, appIcon, bar, wipeIn, typed, measure, dottedLine,
} from './ui.mjs';
import { createCanvas } from '@napi-rs/canvas';

const W = 1920;
const H = 1080;

/* ---------- 场景内共用 ---------- */

/** 混合行：white / grad 片段拼成一行居中的标题 */
function mixed(ctx, parts, cx, y, o = {}) {
  const size = o.size ?? 62;
  const fam = o.fam ?? FAM.black;
  const gap = o.gap ?? 0;
  let total = 0;
  const widths = parts.map((p) => {
    const w = measure(ctx, p.s, { size, fam, tracking: o.tracking ?? 0 });
    total += w + gap;
    return w;
  });
  total -= gap;
  let x = cx - total / 2;
  parts.forEach((p, i) => {
    if (p.grad) {
      gradText(ctx, p.s, x, y, { size, fam, stops: p.stops ?? ACCENT_STOPS, alpha: p.alpha });
    } else {
      txt(ctx, p.s, x, y, { size, fam, color: p.color ?? C.ink, alpha: p.alpha });
    }
    x += widths[i] + gap;
  });
  return total;
}

/** 字标离屏精灵：渐变 + 全息条带只作用在字形 alpha 上（source-atop），
 *  否则条带会画在包围盒里、从字缝里漏出去。尺寸固定，缓存一张即可。 */
let _wmCache = null;
let _wmKey = '';
/** 横向拉伸系数：参考片字标的宽高比 4.88，介于 Mona Sans 常规（4.62）与 Expanded（5.63）之间。
 *  只做 6% 横向拉伸就能同时对上宽度与高度，比换字族更接近。 */
const WM_XSCALE = 1.06;

function wordmarkSprite(text, size) {
  const key = `${text}|${size}`;
  if (_wmCache && _wmKey === key) return _wmCache;
  const font = `${size}px ${FAM.black}`;
  const track = -size * 0.010;
  const probe = createCanvas(8, 8).getContext('2d');
  probe.font = font;
  probe.letterSpacing = `${track}px`;
  const tw0 = probe.measureText(text).width;
  const pad0 = size * 0.3;
  const w = Math.ceil((tw0 + pad0 * 2) * WM_XSCALE);
  const h = Math.ceil(size * 1.35);
  const cv = createCanvas(w, h);
  const c = cv.getContext('2d');
  c.setTransform(WM_XSCALE, 0, 0, 1, 0, 0);
  c.font = font;
  c.letterSpacing = `${track}px`;
  c.textBaseline = 'alphabetic';
  const baseline = h * 0.86;
  const tw = tw0 * WM_XSCALE;
  const g = makeGrad(c, pad0, baseline - size * 0.8, pad0 + tw0, baseline - size * 0.1, WORD_STOPS);
  c.fillStyle = g;
  c.fillText(text, pad0, baseline);
  // 全息条带：source-atop 只作用在字形 alpha 上
  c.globalCompositeOperation = 'source-atop';
  for (let i = 0; i < 9; i++) {
    const bx = pad0 - size * 0.3 + (i / 8) * (tw0 + size * 0.6);
    c.save();
    c.translate(bx, baseline);
    c.rotate(-0.34);
    c.fillStyle = 'rgba(255,255,255,0.34)';
    c.fillRect(0, -size, size * 0.026, size * 1.5);
    c.restore();
  }
  c.globalCompositeOperation = 'source-over';
  _wmCache = { cv, w, h, tw, pad: pad0 * WM_XSCALE, baseline, size };
  _wmKey = key;
  return _wmCache;
}

/**
 * 大字号字标。
 *
 * 两种点法，靠品牌字符串自己决定，不靠配置：
 *   · 字符串以 `.` 开头（如 `.cutduo`）→ 句点按**基线圆点**画，紧贴第一个字母，读起来是一个词；
 *   · 不带点配合 dotStyle:'floating' → 参考片那种悬浮紫点（只在复刻件里用）。
 * 两种都不带则只画字母。
 */
function wordmark(ctx, cx, baseline, size, p = 1, o = {}) {
  const e = easeOut(p);
  if (e <= 0) return;
  const raw = o.text || '.cutduo';
  const leading = raw.startsWith('.');
  const text = leading ? raw.slice(1) : raw;
  const sp = wordmarkSprite(text, size);

  // 句点：r 按字号定，底边压在基线上；悬浮点：更大、抬到 x-height 中部
  const periodR = size * 0.065;
  const floatR = size * 0.085;
  const showFloat = !leading && o.dotStyle === 'floating';
  const dotR = leading ? periodR : floatR;
  // 句点与首字母的视觉间距按实测调：c 的左 bearing ≈0.08em，这里多收 0.085em 才落在 7px 左右
  const gapw = leading ? -size * 0.085 : size * 0.09;
  const leadW = leading || showFloat ? dotR * 2 + gapw : 0;
  const totalW = sp.tw + leadW;
  // 悬浮点的视觉重心偏左，整组要右移约 0.096em 才看着居中（复刻件依赖这个偏移，别删）
  const optical = showFloat ? size * 0.0956 : 0;
  const startX = cx + optical - totalW / 2;
  const textX = startX + leadW;

  const dp = easeBack(seg(p, 0, 0.45));
  if (dp > 0 && (leading || showFloat)) {
    ctx.save();
    ctx.globalAlpha = clamp(dp) * (o.alpha ?? 1);
    ctx.shadowColor = 'rgba(124,92,255,0.9)';
    ctx.shadowBlur = size * (leading ? 0.14 : 0.26);
    const cy = leading ? baseline - dotR : baseline - size * 0.30;
    dot(ctx, startX + dotR, cy, dotR * clamp(dp), '#8B7BFF');
    ctx.restore();
  }

  const lp = easeOut(seg(p, 0.18, 0.9));
  if (lp <= 0) return;
  ctx.save();
  ctx.globalAlpha = o.alpha ?? 1;
  const half = (sp.tw / 2) * lp;
  ctx.beginPath();
  ctx.rect(textX + sp.tw / 2 - half - 2, baseline - size * 1.1, half * 2 + 4, size * 1.35);
  ctx.clip();
  ctx.shadowColor = 'rgba(120,110,255,0.40)';
  ctx.shadowBlur = size * 0.16;
  ctx.drawImage(sp.cv, textX - sp.pad, baseline - sp.baseline);
  ctx.restore();
}


/* =========================================================
 * 1 · hero — 点 → 字标 → 主张
 * ======================================================= */
export function hero(ctx, a, t, d) {
  const p = t / d;
  wordmark(ctx, W / 2, 504, 272, clamp(t / 1.35), { text: a.wordmark || '.cutduo', dotStyle: a.dotStyle });

  // 上方胶囊
  const cp = easeOut(seg(t, 0.95, 1.45));
  if (cp > 0 && a.chip) {
    ctx.save();
    ctx.globalAlpha = cp;
    chip(ctx, a.chip, W / 2, 226 - (1 - cp) * 10, {
      size: 15, align: 'center',
      dotColor: a.chipDot === false ? null : C.green,
      fill: 'rgba(8,12,18,0.8)',
    });
    ctx.restore();
  }

  // 主张
  const sp = easeOut(seg(t, 1.45, 2.05));
  if (sp > 0 && a.kline) {
    ctx.save();
    ctx.globalAlpha = sp;
    const y = 712 + (1 - sp) * 22;
    if (a.klineGrad) {
      // "Video templates for the AI era" —— 前后白、中间渐变
      const i = a.kline.indexOf(a.klineGrad);
      if (i > 0) {
        mixed(ctx, [
          { s: a.kline.slice(0, i) },
          { s: a.klineGrad, grad: true },
          { s: a.kline.slice(i + a.klineGrad.length) },
        ], W / 2, y, { size: 62, fam: FAM.expBold });
      } else {
        txt(ctx, a.kline, W / 2, y, { size: 62, fam: FAM.expBold, align: 'center' });
      }
    } else {
      txt(ctx, a.kline, W / 2, y, { size: 62, fam: FAM.expBold, align: 'center' });
    }
    ctx.restore();
  }

  // 下方 mono 注脚
  const dp = easeOut(seg(t, 1.85, 2.4));
  if (dp > 0 && a.decode) {
    ctx.save();
    ctx.globalAlpha = dp;
    tag(ctx, a.decode, W / 2, 788, { size: 15, tracking: 4.2, align: 'center', color: '#6E7590' });
    ctx.restore();
  }

  // 背景里的大圆环（参考片 hero 有一颗缓慢扩张的环）
  const rp = seg(t, 0, 3.4);
  if (rp > 0) {
    ctx.save();
    ctx.globalAlpha = (1 - rp) * 0.35;
    ctx.strokeStyle = 'rgba(140,150,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(W / 2, 430, 90 + rp * 260, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/* =========================================================
 * 2 · recipe — 格式卡片掠过 → .mp4 / .json 对照
 * ======================================================= */
const PIX = [
  ['y', 'y', '.', '.', 'g', 'g', '.', '.'],
  ['.', '.', '.', 'b', 'b', '.', '.', '.'],
  ['.', 'd', 'd', '.', '.', 'r', '.', '.'],
  ['.', '.', '.', '.', '.', '.', 'g', '.'],
];
const PIXC = { y: '#F2C14E', b: '#2A2A2E', d: '#3A3430', r: '#C4553F', g: '#C9CCD2', '.': '#E7E8EB' };

/** 掠过的"格式样张"卡片 */
function formatCard(ctx, x, y, w, h, rot, a, p) {
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate(rot);
  ctx.translate(-w / 2, -h / 2);
  ctx.globalAlpha = p;

  glass(ctx, 0, 0, w, h, { r: 14, fill: 'rgba(226,229,234,0.97)', stroke: 'rgba(255,255,255,0.5)', shadowBlur: 60, shadowColor: 'rgba(0,0,0,0.65)' });

  // 顶栏
  tag(ctx, a.cardTag || '05 · HANDOFF', 24, 30, { size: 11, color: '#6B6F7A', tracking: 1.6 });
  if (a.cardBadge) {
    fillRR(ctx, 22, 40, 116, 26, 5, '#F2C14E');
    txt(ctx, a.cardBadge, 30, 58, { size: 16, fam: FAM.bold, color: '#141414' });
  }
  tag(ctx, a.cardChips || '• SCRIPT   • MEDIA   (READY)', 22, 92, { size: 11, color: '#4A4E58', tracking: 0.6 });

  // 中间：抽象"人 + 载体"
  ctx.save();
  ctx.fillStyle = '#2B2B30';
  ctx.beginPath();
  ctx.arc(w * 0.30, h * 0.52, 34, 0, Math.PI * 2);
  ctx.fill();
  fillRR(ctx, w * 0.30 - 30, h * 0.52 + 26, 60, 70, 12, '#2B2B30');
  ctx.restore();

  // 大格式字
  gradText(ctx, a.cardFormat || '.mxf', w * 0.52, h * 0.60, {
    size: 88, fam: FAM.black, stops: [[0, '#7B4BFF'], [1, '#A07BFF']],
  });
  dot(ctx, w * 0.44, h * 0.53, 9, '#7B4BFF');

  // 底栏
  ctx.fillStyle = 'rgba(0,0,0,0.06)';
  ctx.fillRect(16, h - 66, w - 32, 50);
  tag(ctx, a.cardMeta || 'MXF · OP1a · DNxHD', 26, h - 34, { size: 12, color: '#3E424C', tracking: 0.4 });
  tag(ctx, a.cardSub || 'show how ideas connect', 26, h - 18, { size: 11, color: '#71757E', tracking: 0.2 });
  ctx.restore();
}

function pixelCard(ctx, x, y, w, h, p) {
  ctx.save();
  ctx.globalAlpha = p;
  glass(ctx, x, y, w, h, { r: 10, fill: '#F0F1F3', stroke: 'rgba(255,255,255,0.65)', shadowBlur: 34, shadowY: 14 });

  const pad = 12;
  const cols = 8;
  const rows = 4;
  const cw = (w - pad * 2 - (cols - 1) * 3) / cols;
  const chh = (h - pad * 2 - (rows - 1) * 3) / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = (PIX[r] && PIX[r][c]) || '.';
      ctx.fillStyle = PIXC[k];
      ctx.fillRect(x + pad + c * (cw + 3), y + pad + r * (chh + 3), cw, chh);
    }
  }
  // 右上角黑胶囊
  const label = '▨  PIXELS · BASED';
  ctx.font = `12px ${FAM.mono}`;
  const tw = ctx.measureText(label).width;
  const pw = tw + 28;
  fillRR(ctx, x + w - pw - 10, y - 14, pw, 28, 14, '#141417');
  txt(ctx, label, x + w - pw / 2 - 10, y + 5, { size: 12, fam: FAM.mono, color: '#EDEFF3', align: 'center', tracking: 1.2 });
  ctx.restore();
}

function recipePanelStack(ctx, cx, cy, p, opt = {}) {
  const w = 620;
  const h = 340;
  const layers = [
    { dx: -64, dy: -62, rot: -0.20, a: 0.26 },
    { dx: -30, dy: -28, rot: -0.13, a: 0.52 },
    { dx: 0, dy: 0, rot: -0.055, a: 1 },
  ];
  layers.forEach((L, i) => {
    const lp = easeOut(seg(p, i * 0.10, 0.55 + i * 0.10));
    if (lp <= 0) return;
    ctx.save();
    ctx.translate(cx + L.dx, cy + L.dy);
    ctx.rotate(L.rot);
    ctx.globalAlpha = L.a * lp;
    glass(ctx, -w / 2, -h / 2, w, h, {
      r: 16,
      fill: i === 2 ? 'rgba(16,18,30,0.72)' : 'rgba(30,34,52,0.55)',
      stroke: i === 2 ? 'rgba(150,160,220,0.35)' : 'rgba(170,185,240,0.30)',
      shadowBlur: 50,
      shadowColor: 'rgba(0,0,0,0.6)',
    });
    if (i === 2) {
      // 前景层：标题 + JSON 片段 + 弧线
      const pTitle = opt.title || 'Hello Motion';
      txt(ctx, pTitle, 34, -46, { size: 34, fam: FAM.bold, color: '#F2F4F8' });
      const lines = opt.lines || [
        ['"title"', `: "${pTitle}",`],
        ['"duration"', ': 4.6,'],
        ['"in"', ': "0.4s",'],
      ];
      lines.forEach(([k, v], li) => {
        const y = 6 + li * 26;
        txt(ctx, k, 96, y, { size: 15, fam: FAM.mono, color: '#8FD7F5' });
        txt(ctx, v, 96 + measure(ctx, k, { size: 15, fam: FAM.mono }) + 6, y, { size: 15, fam: FAM.mono, color: '#A8AEC4' });
      });
      ctx.save();
      ctx.strokeStyle = 'rgba(150,200,255,0.75)';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(40, 60, 34, -0.4, 1.9);
      ctx.stroke();
      ctx.restore();
      tag(ctx, 'Recipe', 34, 108, { size: 11, color: '#6E7590', tracking: 1.6 });
    } else if (i === 1) {
      ctx.save();
      ctx.strokeStyle = 'rgba(160,180,255,0.30)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 120, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  });
  // "Editable" 标签
  const ep = easeOut(seg(p, 0.55, 0.9));
  if (ep > 0) {
    ctx.save();
    ctx.globalAlpha = ep;
    tag(ctx, 'Editable', cx + 190, cy + 176, { size: 12, color: '#8E94AC', tracking: 1.8 });
    ctx.restore();
  }
}

export function recipe(ctx, a, t, d) {
  // 阶段 A：一张样张**停在原地**，只让格式名在卡里换。
  //
  // 前两版都错在"让卡片横穿画面"：先是 2876 px/s 连滚，后降到 2200 px/s 逐张进停出。
  // 用 bench/motion-scan.mjs 量参考片才发现根本方向错了 ——
  // 参考片 4.4–7.6s 有 26/31 帧横向位移为 0，全片 P90 只有 720 px/s：
  // 它是"卡片不动、内容原地变"（.avi → .webm → .mp4），最后才缩放平移成对照的左块。
  // 我们复刻的应该是这个语法，而不是自己发明一条滚动带。
  const cards = a.cards || [];
  const A_HOLD = 0.30;   // 首张淡入
  const A_STEP = 0.60;   // 每个格式停留
  const A_CROSS = 0.18;  // 原地交叉淡入
  const B0 = 0.30 + Math.max(1, cards.length) * A_STEP; // 收缩起点（默认 2.1）
  const CARD = { cx: 880, cy: 470, w: 820, h: 438 };
  const SLOT = { cx: 542, cy: 493, w: 535, h: 310 };   // 对照段左块的位置

  // 原地换字的样张
  const shown = cards.length
    ? cards.map((card, i) => {
        const s0 = A_HOLD + i * A_STEP;
        const last = i === cards.length - 1;
        // 最后一张不按时间淡出：它要活到被收缩交接走，否则 B 段起点（2.1s）留一个空档
        const alpha = clamp(seg(t, s0 - A_CROSS, s0)) *
          (last ? 1 : clamp(1 - seg(t, s0 + A_STEP - A_CROSS, s0 + A_STEP)));
        return { card, alpha, i };
      })
    : [];

  // B 段：整张卡缩到左槽位（参考片是缩放 + 轻微左移，位移只有 338px）
  const bp = t - B0;
  // smoothstep 而不是 easeOut：easeOut 起步就是峰值速度，实测把 338px 的位移压出 1800 px/s，
  // 超过参考片全片 P90（720 px/s）。smoothstep 的峰值只有均值的 1.5 倍。
  const sp = clamp(seg(bp, 0, 0.75));
  const shrink = sp * sp * (3 - 2 * sp);
  const gx = lerp(CARD.cx, SLOT.cx, shrink);
  const gy = lerp(CARD.cy, SLOT.cy, shrink);
  const gw = lerp(CARD.w, SLOT.w, shrink);
  const gh = lerp(CARD.h, SLOT.h, shrink);

  for (const { card, alpha } of shown) {
    if (alpha <= 0) continue;
    const a2 = alpha * (1 - clamp(seg(bp, 0.30, 0.70)));  // 收缩末期让位给像素卡
    if (a2 <= 0) continue;
    formatCard(ctx, gx - gw / 2, gy - gh / 2, gw, gh, -0.02, card, a2);
  }

  if (bp < -0.1) return;
  const inP = (at) => easeOut(seg(bp, at, at + 0.55));

  // 左块：像素卡在原位淡入，接替样张
  const lp = inP(0.30);
  if (lp > 0) {
    ctx.save();
    ctx.globalAlpha = lp;
    gradText(ctx, '.mp4', 450, 258, {
      size: 92, fam: FAM.black,
      stops: [[0, '#EEF2F7'], [1, '#98A1B4']],
    });
    pixelCard(ctx, SLOT.cx - SLOT.w / 2, SLOT.cy - SLOT.h / 2, SLOT.w, SLOT.h, lp);
    txt(ctx, a.subMp4 || 'Finished video · Ready to play', SLOT.cx, 690, {
      size: 21, fam: FAM.medium, align: 'center', color: '#D7DBE6',
    });
    ctx.restore();
  }

  const rp = inP(0.42);
  if (rp > 0) {
    ctx.save();
    ctx.globalAlpha = rp;
    gradText(ctx, a.rightFormat || '.json', 1325, 258, { size: 92, fam: FAM.black, align: 'center', stops: WORD_STOPS });
    recipePanelStack(ctx, 1200, 577, seg(bp, 0.45, 1.3), { title: a.panelTitle, lines: a.panelLines });
    ctx.restore();
  }

  // 底部论点
  const kp = easeOut(seg(bp, 1.05, 1.6));
  if (kp > 0 && a.kline) {
    ctx.save();
    ctx.globalAlpha = kp;
    const y = 912 - (1 - kp) * 18;
    const i = a.kline.indexOf(a.klineGrad || '.json');
    if (i >= 0) {
      mixed(ctx, [
        { s: a.kline.slice(0, i) },
        { s: a.klineGrad || '.json', grad: true },
        { s: a.kline.slice(i + (a.klineGrad || '.json').length) },
      ], W / 2, y, { size: 34, fam: FAM.semi });
    } else {
      txt(ctx, a.kline, W / 2, y, { size: 34, fam: FAM.semi, align: 'center' });
    }
    ctx.restore();
  }
}

/* =========================================================
 * 3 · open — 开场承诺
 * ======================================================= */
export function open(ctx, a, t, d) {
  const ip = easeBack(seg(t, 0.05, 0.65));
  if (ip > 0) {
    ctx.save();
    ctx.globalAlpha = clamp(ip);
    const size = 200 * lerp(0.86, 1, clamp(ip));
    appIcon(ctx, W / 2 - size / 2, 340 - size / 2 + 20, size, { r: size * 0.28, letter: (a.__brand && a.__brand.initial) || 'm' });
    ctx.restore();
  }

  // 呼吸环
  const rp = seg(t, 0.4, 3.2);
  if (rp > 0) {
    ctx.save();
    ctx.globalAlpha = (1 - rp) * 0.32;
    ctx.strokeStyle = 'rgba(140,150,255,0.6)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(W / 2, 360, 140 + rp * 300, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  const p1 = easeOut(seg(t, 0.55, 1.0));
  if (p1 > 0) {
    ctx.save();
    ctx.globalAlpha = p1;
    txt(ctx, a.byline || 'cutduo', W / 2, 640 + (1 - p1) * 14, {
      size: 34, fam: FAM.semi, align: 'center', color: '#D3D8E6',
    });
    ctx.restore();
  }
  const p2 = easeOut(seg(t, 0.75, 1.25));
  if (p2 > 0) {
    ctx.save();
    ctx.globalAlpha = p2;
    const y = 726 + (1 - p2) * 18;
    if (a.klineGrad) {
      const i = a.kline.indexOf(a.klineGrad);
      mixed(ctx, [
        { s: a.kline.slice(0, i) },
        { s: a.klineGrad, grad: true },
        { s: a.kline.slice(i + a.klineGrad.length) },
      ], W / 2, y, { size: 56, fam: FAM.black });
    } else {
      txt(ctx, a.kline, W / 2, y, { size: 56, fam: FAM.black, align: 'center' });
    }
    ctx.restore();
  }
  const p3 = easeOut(seg(t, 1.15, 1.6));
  if (p3 > 0 && a.decode) {
    ctx.save();
    ctx.globalAlpha = p3;
    tag(ctx, a.decode, W / 2, 790, { size: 14, tracking: 3, align: 'center', color: '#6E7590' });
    ctx.restore();
  }
}

/* =========================================================
 * 4 · pack — 一个文件装下全部
 * ======================================================= */
export function pack(ctx, a, t, d) {
  const cx = W / 2;
  const cy = 560;

  // 雷达环
  const rp = easeOut(seg(t, 0, 2.2));
  for (let i = 0; i < 5; i++) {
    const r = 200 + i * 118 + rp * 60;
    ctx.save();
    ctx.globalAlpha = 0.10 * (1 - i * 0.12) * clamp(rp);
    ctx.strokeStyle = 'rgba(140,160,255,1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // 标题（最后一个词用打字机）
  const tp = easeOut(seg(t, 0.10, 0.60));
  if (tp > 0 && a.kline) {
    ctx.save();
    ctx.globalAlpha = tp;
    const y = 250 + (1 - tp) * 14;
    const head = a.kline;
    const gradWord = a.klineGrad || 'one file';
    const i = head.indexOf(gradWord);
    if (i >= 0) {
      const pre = head.slice(0, i);
      const post = head.slice(i + gradWord.length);
      const typedWord = a.typed ? typed(gradWord, seg(t, 0.55, 1.35)) : gradWord;
      const size = 62;
      const wPre = measure(ctx, pre, { size, fam: FAM.black });
      const wGrad = measure(ctx, gradWord, { size, fam: FAM.black });
      const wPost = measure(ctx, post, { size, fam: FAM.black });
      const total = wPre + wGrad + wPost;
      let x = cx - total / 2;
      txt(ctx, pre, x, y, { size, fam: FAM.black });
      x += wPre;
      gradText(ctx, typedWord, x, y, { size, fam: FAM.black });
      if (a.typed && typedWord.length < gradWord.length) {
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.fillRect(x + measure(ctx, typedWord, { size, fam: FAM.black }) + 3, y - size * 0.72, 4, size * 0.78);
      }
      txt(ctx, post, x + wGrad, y, { size, fam: FAM.black });
    } else {
      txt(ctx, head, cx, y, { size: 62, fam: FAM.black, align: 'center' });
    }
    ctx.restore();
  }

  // 文件图标
  const fp = easeBack(seg(t, 0.25, 0.85));
  if (fp > 0) {
    const iw = 270;
    const ih = 330;
    const x = cx - iw / 2;
    const y = 320 + (1 - clamp(fp)) * 40;
    ctx.save();
    ctx.globalAlpha = clamp(fp);
    ctx.shadowColor = 'rgba(124,92,255,0.45)';
    ctx.shadowBlur = 70;
    fillRR(ctx, x, y, iw, ih, 26, '#0C0E18');
    ctx.restore();

    ctx.save();
    rr(ctx, x, y, iw, ih, 26);
    ctx.clip();
    const g = ctx.createLinearGradient(x, y, x + iw, y + ih);
    g.addColorStop(0, 'rgba(90,110,255,0.20)');
    g.addColorStop(1, 'rgba(180,90,255,0.10)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, iw, ih);
    // 折角
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.moveTo(x + iw - 66, y);
    ctx.lineTo(x + iw, y + 66);
    ctx.lineTo(x + iw - 66, y + 66);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    strokeRR(ctx, x + 0.5, y + 0.5, iw - 1, ih - 1, 26, 'rgba(180,190,255,0.35)', 1.4);

    txt(ctx, (a.__brand && a.__brand.initial) || 'm', x + iw / 2, y + 168, { size: 118, fam: FAM.black, color: '#FFFFFF', align: 'center' });
    dot(ctx, x + 52, y + 150, 8, C.purple, 18);
    gradText(ctx, a.fileExt || '.json', x + iw / 2, y + 214, { size: 30, fam: FAM.semi, align: 'center', stops: WORD_STOPS });

    // 四条资源条：代码 / 参数 / 素材 / 说明
    const bars = [
      ['#6FD3F7', 0.74],
      ['#5B8CFF', 0.88],
      ['#A07BFF', 0.62],
      ['#5FD08A', 0.80],
    ];
    bars.forEach(([col, wf], i) => {
      fillRR(ctx, x + 44, y + 244 + i * 17, (iw - 88) * wf, 7, 3.5, col);
    });
  }

  // 文件名与说明
  const np = easeOut(seg(t, 1.15, 1.6));
  if (np > 0) {
    ctx.save();
    ctx.globalAlpha = np;
    txt(ctx, a.fileName || 'cutduo.json', cx, 706, { size: 26, fam: FAM.monoBold, align: 'center', color: '#EDEFF6' });
    tag(ctx, a.meta || 'Code · Parameters · Assets · Instructions → One file', cx, 746, {
      size: 13, tracking: 1.4, align: 'center', color: '#8E94AC',
    });
    ctx.restore();
  }

  // 终端
  const cp = easeOut(seg(t, 1.75, 2.25));
  if (cp > 0) {
    const tw = 840;
    const th = 78;
    const tx0 = cx - tw / 2;
    const ty0 = 806;
    ctx.save();
    ctx.globalAlpha = cp;
    glass(ctx, tx0, ty0, tw, th, { r: 10, fill: 'rgba(8,9,14,0.92)', stroke: 'rgba(150,160,200,0.22)', shadowBlur: 30 });
    const cmd = a.cmd || 'motion inspect template';
    const shown = '  $ ' + typed(cmd, seg(t, 2.0, 2.8));
    txt(ctx, shown, tx0 + 26, ty0 + 48, { size: 19, fam: FAM.mono, color: '#D7DBE6' });
    if (Math.floor(t * 2.4) % 2 === 0) {
      const w = measure(ctx, shown, { size: 19, fam: FAM.mono });
      ctx.fillStyle = '#8FE0FA';
      ctx.fillRect(tx0 + 28 + w, ty0 + 30, 9, 22);
    }
    ctx.restore();
  }
}

/* =========================================================
 * 5 · flow — 四步流水线
 * ======================================================= */
export function flow(ctx, a, t, d) {
  const steps = a.steps || [];
  const railY = 178;
  const xs = [348, 750, 1182, 1571];
  const active = Math.min(steps.length - 1, Math.floor(clamp((t - 0.4) / (d - 1.2)) * steps.length));

  // 轨
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(xs[0], railY);
  ctx.lineTo(xs[3], railY);
  ctx.stroke();
  const prog = easeInOut(seg(t, 0.08, 1.1));
  if (prog > 0) {
    const g = makeGrad(ctx, xs[0], railY, xs[3], railY, ACCENT_STOPS);
    ctx.strokeStyle = g;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xs[0], railY);
    ctx.lineTo(lerp(xs[0], xs[3], prog), railY);
    ctx.stroke();
  }
  ctx.restore();

  steps.forEach((s, i) => {
    const p = easeBack(seg(t, 0.02 + i * 0.06, 0.34 + i * 0.06));
    if (p <= 0) return;
    const x = xs[i] ?? 348 + i * 400;
    const isActive = i <= active;
    ctx.save();
    ctx.globalAlpha = clamp(p);
    if (isActive) {
      ctx.shadowColor = 'rgba(124,92,255,0.7)';
      ctx.shadowBlur = 22;
    }
    ctx.beginPath();
    ctx.arc(x, railY, 14, 0, Math.PI * 2);
    ctx.fillStyle = isActive ? '#0B0D16' : '#07080D';
    ctx.fill();
    ctx.restore();
    strokeRR(ctx, x - 14, railY - 14, 28, 28, 14, isActive ? 'rgba(160,150,255,0.85)' : 'rgba(255,255,255,0.18)', 1.4);
    txt(ctx, s.num || String(i + 1).padStart(2, '0'), x, railY + 5, {
      size: 12, fam: FAM.mono, align: 'center', color: isActive ? '#DCE0FF' : '#767C93',
    });
    txt(ctx, s.label || '', x, railY + 44, {
      size: 23, fam: FAM.semi, align: 'center', color: isActive ? '#FFFFFF' : '#767C93',
    });
  });

  // 左：AI 助手会话
  const lx = 201, ly = 300, lw = 709, lh = 556;
  const lp = easeOut(seg(t, 0.16, 0.62));
  if (lp > 0) {
    ctx.save();
    ctx.globalAlpha = lp;
    ctx.translate(0, (1 - lp) * 24);
    glass(ctx, lx, ly, lw, lh, { r: 20 });
    txt(ctx, '◉', lx + 30, ly + 44, { size: 22, color: '#C9CDDD' });
    txt(ctx, a.panelTitle || 'Your AI assistant', lx + 62, ly + 46, { size: 23, fam: FAM.semi });
    tag(ctx, a.panelTag || 'Template-aware assistant', lx + lw - 28, ly + 44, { size: 12, align: 'right', color: '#6E7590', tracking: 0.8 });

    const bubbles = a.messages || [];
    let by = ly + 92;
    bubbles.forEach((b, i) => {
      const bp2 = easeOut(seg(t, 0.32 + i * 0.42, 0.75 + i * 0.42));
      if (bp2 <= 0) return;
      ctx.save();
      ctx.globalAlpha = bp2;
      ctx.translate(0, (1 - bp2) * 14);
      const bw = b.w || lw - 150;
      const bh = b.h || (b.sub ? 92 : 58);
      const bx = b.right ? lx + lw - 44 - bw : lx + 44;
      glass(ctx, bx, by, bw, bh, { r: 14, fill: 'rgba(255,255,255,0.045)', stroke: 'rgba(255,255,255,0.10)', shadow: false });
      if (b.file) {
        // 文件气泡：小圆角方块 + 文件名
        fillRR(ctx, bx + 18, by + 16, 30, 30, 8, '#12141F');
        txt(ctx, 'm', bx + 33, by + 38, { size: 19, fam: FAM.black, align: 'center' });
        txt(ctx, b.file, bx + 60, by + 37, { size: 17, fam: FAM.mono, color: '#E6E9F2' });
        txt(ctx, b.text || '', bx + 18, by + 76, { size: 18, fam: FAM.medium, color: '#D3D8E6' });
      } else {
        txt(ctx, b.text || '', bx + 18, by + 36, { size: 18, fam: FAM.medium, color: '#D3D8E6' });
        if (b.sub) txt(ctx, b.sub, bx + 18, by + 64, { size: 16, fam: FAM.medium, color: '#98A0B6' });
        if (b.check) {
          ctx.beginPath();
          ctx.arc(bx + bw - 26, by + bh / 2, 12, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(95,208,138,0.18)';
          ctx.fill();
          txt(ctx, '✓', bx + bw - 26, by + bh / 2 + 5, { size: 14, align: 'center', color: C.green });
        }
      }
      ctx.restore();
      by += bh + 26;
    });
    ctx.restore();
  }

  // 右：模板预览
  const rx = 978, ry = 300, rw = 755, rh = 556;
  const rp = easeOut(seg(t, 0.26, 0.72));
  if (rp > 0) {
    ctx.save();
    ctx.globalAlpha = rp;
    ctx.translate(0, (1 - rp) * 24);
    glass(ctx, rx, ry, rw, rh, { r: 20 });
    txt(ctx, a.previewTitle || 'Template 01 · Modern Graphic', rx + 26, ry + 44, { size: 22, fam: FAM.semi });
    tag(ctx, a.previewVer || 'v1.1.4', rx + rw - 26, ry + 42, { size: 12, align: 'right', color: '#6E7590', tracking: 0.8 });

    const ix = rx + 24, iy = ry + 66, iw = rw - 48, ih = 380;
    fillRR(ctx, ix, iy, iw, ih, 12, '#0A0B12');
    strokeRR(ctx, ix, iy, iw, ih, 12, 'rgba(255,255,255,0.08)', 1);
    // 内部：一张别的模板的截帧（暖色、人物、条形图）
    ctx.save();
    rr(ctx, ix, iy, iw, ih, 12);
    ctx.clip();
    const g2 = ctx.createLinearGradient(ix, iy, ix + iw, iy + ih);
    g2.addColorStop(0, '#1B1206');
    g2.addColorStop(0.55, '#2A1B08');
    g2.addColorStop(1, '#1A1208');
    ctx.fillStyle = g2;
    ctx.fillRect(ix, iy, iw, ih);
    txt(ctx, 'Consider', ix + 46, iy + 96, { size: 40, fam: FAM.bold, color: '#F6EFE2' });
    txt(ctx, 'The inputs', ix + 46, iy + 142, { size: 40, fam: FAM.bold, color: '#F2B45C' });
    const statsRow = [['INPUTS', 8], ['WORK', 16], ['EFFORT', 18], ['MEDIA', 39]];
    statsRow.forEach(([lab, val], i2) => {
      const yy = iy + 196 + i2 * 40;
      tag(ctx, lab, ix + 46, yy, { size: 11, color: '#C9A46A', tracking: 1.6 });
      fillRR(ctx, ix + 150, yy - 9, 210, 8, 4, 'rgba(255,255,255,0.10)');
      fillRR(ctx, ix + 150, yy - 9, 210 * (val / 45), 8, 4, '#F2B45C');
      txt(ctx, `${val}%`, ix + 380, yy, { size: 13, fam: FAM.mono, color: '#F6E3C4' });
    });
    // 右侧人像
    const px = ix + iw - 210, py = iy + 40, pw = 180, ph = 220;
    fillRR(ctx, px, py, pw, ph, 12, '#3A2A16');
    ctx.beginPath();
    ctx.arc(px + pw / 2, py + ph * 0.42, 44, 0, Math.PI * 2);
    ctx.fillStyle = '#8A6A45';
    ctx.fill();
    fillRR(ctx, px + pw / 2 - 62, py + ph * 0.62, 124, 120, 40, '#5C4529');
    ctx.restore();

    bar(ctx, rx + 24, ry + 470, rw - 48, 5, ACCENT_STOPS, 2.5);
    txt(ctx, a.previewNote || 'Actual finished template excerpt', rx + 26, ry + 508, { size: 16, fam: FAM.medium, color: '#D3D8E6' });
    tag(ctx, a.previewMeta || '1920 × 1080 · 60 fps', rx + rw - 26, ry + 506, { size: 13, align: 'right', color: '#8E94AC', tracking: 0.6 });
    ctx.restore();
  }

  // 底部论点
  const kp = easeOut(seg(t, 1.15, 1.65));
  if (kp > 0 && a.kline) {
    ctx.save();
    ctx.globalAlpha = kp;
    const y = 968 - (1 - kp) * 16;
    const gw = a.klineGrad || 'your next video';
    const i = a.kline.indexOf(gw);
    mixed(ctx, [
      { s: a.kline.slice(0, i) },
      { s: gw, grad: true },
      { s: a.kline.slice(i + gw.length) },
    ], W / 2, y, { size: 46, fam: FAM.black });
    ctx.restore();
  }
}

/* =========================================================
 * 6 · adapt — 同设计换画幅
 * ======================================================= */
function miniGrid(ctx, x, y, w, h, p) {
  // 3×3 选项卡：每张是一个 mini 画面 + 勾选
  const cols = 3;
  const rows = 3;
  const gx = 10;
  const cw = (w - gx * (cols - 1)) / cols;
  const chh = (h - gx * (rows - 1)) / rows;
  const variants = [
    { bg: '#0E1220', art: 'blob', col: '#7C8CFF' },
    { bg: '#0E1220', art: 'bars', col: '#6FD3F7' },
    { bg: '#F4F1EA', art: 'rows', col: '#C08B5C' },
    { bg: '#0E1220', art: 'blob', col: '#B98CF3' },
    { bg: '#0E1220', art: 'bars', col: '#5FD08A' },
    { bg: '#F4F1EA', art: 'rows', col: '#D06A6A' },
    { bg: '#0E1220', art: 'blob', col: '#7C8CFF' },
    { bg: '#0E1220', art: 'bars', col: '#F2C14E' },
    { bg: '#F4F1EA', art: 'rows', col: '#6A8FD0' },
  ];
  variants.forEach((v, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const vx = x + c * (cw + gx);
    const vy = y + r * (chh + gx);
    const ap = easeOut(seg(p, i * 0.045, i * 0.045 + 0.4));
    if (ap <= 0) return;
    ctx.save();
    ctx.globalAlpha = ap;
    fillRR(ctx, vx, vy, cw, chh, 7, v.bg);
    strokeRR(ctx, vx, vy, cw, chh, 7, 'rgba(255,255,255,0.12)', 1);
    ctx.save();
    rr(ctx, vx, vy, cw, chh, 7);
    ctx.clip();
    if (v.art === 'blob') {
      ctx.fillStyle = hexA(v.col, 0.85);
      ctx.beginPath();
      ctx.arc(vx + cw * 0.36, vy + chh * 0.56, cw * 0.16, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(vx + cw * 0.60, vy + chh * 0.44, cw * 0.09, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.35 * ap;
      ctx.strokeStyle = hexA(v.col, 0.9);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(vx + cw * 0.5, vy + chh * 0.5, cw * 0.30, 0, Math.PI * 2);
      ctx.stroke();
    } else if (v.art === 'bars') {
      for (let b = 0; b < 4; b++) {
        const bh = chh * (0.16 + b * 0.10);
        fillRR(ctx, vx + cw * 0.18 + b * cw * 0.17, vy + chh * 0.74 - bh, cw * 0.10, bh, 2, hexA(v.col, 0.9));
      }
    } else {
      for (let b = 0; b < 3; b++) {
        fillRR(ctx, vx + cw * 0.12, vy + chh * 0.22 + b * chh * 0.20, cw * (0.6 - b * 0.12), chh * 0.09, 2, hexA(v.col, 0.7));
      }
    }
    ctx.restore();
    tag(ctx, `OPTION ${'ABCDEFGHI'[i]}`, vx + 7, vy + chh - 7, { size: 8, color: 'rgba(255,255,255,0.45)', tracking: 0.8 });
    // 勾
    if (i === 0 || i === 4 || i === 8) {
      const gp = easeBack(seg(p, 0.5 + i * 0.04, 0.75 + i * 0.04));
      if (gp > 0) {
        ctx.beginPath();
        ctx.arc(vx + cw - 13, vy + 13, 8 * clamp(gp), 0, Math.PI * 2);
        ctx.fillStyle = '#2FB463';
        ctx.fill();
        txt(ctx, '✓', vx + cw - 13, vy + 17, { size: 10, align: 'center', color: '#FFFFFF' });
      }
    }
    ctx.restore();
  });
}

export function adapt(ctx, a, t, d) {
  // 标题
  const tp = easeOut(seg(t, 0.1, 0.55));
  if (tp > 0 && a.kline) {
    ctx.save();
    ctx.globalAlpha = tp;
    const gw = a.klineGrad || 'Same style.';
    const i = a.kline.indexOf(gw);
    mixed(ctx, [
      { s: a.kline.slice(0, i) },
      { s: gw, grad: true },
      { s: a.kline.slice(i + gw.length) },
    ], W / 2, 200, { size: 62, fam: FAM.black });
    ctx.restore();
  }

  // 16:9 窗
  const lp = easeOut(seg(t, 0.3, 0.95));
  if (lp > 0) {
    const x = 231, y = 300, w = 1024, h = 560;
    ctx.save();
    ctx.globalAlpha = lp;
    ctx.translate(0, (1 - lp) * 22);
    glass(ctx, x, y, w, h, { r: 14, fill: 'rgba(8,9,14,0.9)' });
    tag(ctx, a.leftTag || '03 · NINE SCREENS', x + 22, y + 30, { size: 11, color: '#8E94AC', tracking: 1.4 });
    tag(ctx, '00:19', x + w - 22, y + 30, { size: 11, align: 'right', color: '#8E94AC', tracking: 1.4 });
    const demoImg = a.__media && a.__media.get('demo');
    if (demoImg) {
      // 载体是 16:9 窗，素材就按 16:9 的框铺，不要塞进原来给九宫格留的方格
      drawMedia(ctx, demoImg, x + 22, y + 64, 688, 387, 8);
    } else {
      miniGrid(ctx, x + 22, y + 48, 560, 470, seg(t, 0.45, 1.6));
    }

    // 右侧控制区
    const cx0 = x + w - 300;
    tag(ctx, 'Nine authorized screens', cx0, y + 60, { size: 10, color: '#8E94AC', tracking: 1.2 });
    // 头像圆
    ctx.beginPath();
    ctx.arc(cx0 + 240, y + 46, 26, 0, Math.PI * 2);
    ctx.fillStyle = '#2B3348';
    ctx.fill();
    txt(ctx, 'A', cx0 + 240, y + 54, { size: 20, fam: FAM.bold, align: 'center', color: '#C9D2E8' });
    const btns = [['Group B', false], ['Group A', true], ['Draft', false], ['Edit', false], ['Review', false], ['Final', false]];
    btns.forEach(([lab, on], i) => {
      const bx = cx0 + (i % 2) * 108;
      const by = y + 88 + Math.floor(i / 2) * 52;
      fillRR(ctx, bx, by, 96, 38, 19, on ? '#2F5BE8' : 'rgba(255,255,255,0.07)');
      strokeRR(ctx, bx, by, 96, 38, 19, on ? 'rgba(120,160,255,0.9)' : 'rgba(255,255,255,0.12)', 1);
      txt(ctx, lab, bx + 48, by + 25, { size: 14, fam: FAM.medium, align: 'center', color: on ? '#FFFFFF' : '#C6CBDA' });
    });
    txt(ctx, '✓  Nine screens', cx0 + 6, y + 300, { size: 15, fam: FAM.medium, color: '#8FB4FF' });
    ctx.restore();
  }

  // 9:16 窗
  const rp = easeOut(seg(t, 0.5, 1.15));
  if (rp > 0) {
    const x = 1348, y = 270, w = 366, h = 620;
    ctx.save();
    ctx.globalAlpha = rp;
    ctx.translate(0, (1 - rp) * 22);
    glass(ctx, x, y, w, h, { r: 22, fill: 'rgba(8,9,14,0.9)' });
    tag(ctx, a.rightTag || '03 · NINE SCREENS', x + 20, y + 28, { size: 10, color: '#8E94AC', tracking: 1.2 });
    tag(ctx, '00:19', x + w - 20, y + 28, { size: 10, align: 'right', color: '#8E94AC', tracking: 1.2 });
    // 头像
    ctx.beginPath();
    ctx.arc(x + w - 46, y + 60, 22, 0, Math.PI * 2);
    ctx.fillStyle = '#2B3348';
    ctx.fill();
    txt(ctx, 'A', x + w - 46, y + 67, { size: 17, fam: FAM.bold, align: 'center', color: '#C9D2E8' });
    // 竖排选项
    const vw = (w - 56) / 2;
    const vh = 96;
    const portraitImg = a.__media && a.__media.get('portrait');
    if (portraitImg) {
      drawMedia(ctx, portraitImg, x + 20, y + 92, w - 40, 320, 8);
    }
    for (let i = 0; i < 6 && !portraitImg; i++) {
      const vx = x + 20 + (i % 2) * (vw + 16);
      const vy = y + 92 + Math.floor(i / 2) * (vh + 12);
      const ap = easeOut(seg(t, 0.7 + i * 0.05, 0.95 + i * 0.05));
      if (ap <= 0) continue;
      ctx.save();
      ctx.globalAlpha = ap;
      fillRR(ctx, vx, vy, vw, vh, 8, i % 3 === 2 ? '#F4F1EA' : '#0E1220');
      strokeRR(ctx, vx, vy, vw, vh, 8, 'rgba(255,255,255,0.10)', 1);
      // 竖版里也放同构的小元素，不然六个格子全是空块
      if (i % 3 === 2) {
        for (let b = 0; b < 3; b++) fillRR(ctx, vx + 12, vy + 22 + b * 22, vw * (0.62 - b * 0.12), 8, 3, 'rgba(190,140,90,0.55)');
      } else if (i % 3 === 1) {
        for (let b = 0; b < 3; b++) fillRR(ctx, vx + 16 + b * 22, vy + vh - 16 - (18 + b * 14), 12, 18 + b * 14, 2, 'rgba(111,211,247,0.8)');
      } else {
        ctx.fillStyle = 'rgba(140,150,255,0.85)';
        ctx.beginPath();
        ctx.arc(vx + vw * 0.5, vy + vh * 0.45, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(vx + vw * 0.66, vy + vh * 0.66, 9, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    const btnsY = y + 424;
    ['Draft', 'Edit', 'Review', 'Final'].forEach((lab, i) => {
      const bx = x + 20 + (i % 2) * (vw + 16);
      const by = btnsY + Math.floor(i / 2) * 46;
      fillRR(ctx, bx, by, vw, 36, 18, i === 1 ? '#2F5BE8' : 'rgba(255,255,255,0.07)');
      txt(ctx, lab, bx + vw / 2, by + 24, { size: 13, fam: FAM.medium, align: 'center', color: '#D6DAE8' });
    });
    txt(ctx, '✓  Nine screens', x + 22, y + h - 26, { size: 14, fam: FAM.medium, color: '#8FB4FF' });
    ctx.restore();
  }

  // 画幅标注
  const cp = easeOut(seg(t, 0.9, 1.35));
  if (cp > 0) {
    ctx.save();
    ctx.globalAlpha = cp;
    tag(ctx, a.leftCaption || '16:9 · Landscape', 743, 930, { size: 15, align: 'center', color: '#B9BFD4', tracking: 1.6 });
    tag(ctx, a.rightCaption || '9:16 · Portrait', 1531, 930, { size: 15, align: 'center', color: '#B9BFD4', tracking: 1.6 });
    ctx.restore();
  }
}

/* =========================================================
 * 7 · reuse — 12 格作品墙
 * ======================================================= */
function wallTile(ctx, x, y, w, h, i, p, media) {
  const ap = easeOut(seg(p, i * 0.055, i * 0.055 + 0.45));
  if (ap <= 0) return;
  const dark = i % 5 !== 3;
  const bg = dark ? '#0B0D15' : '#EDEAE2';
  const ink = dark ? 'rgba(255,255,255,0.90)' : 'rgba(20,22,28,0.88)';
  const mut = dark ? 'rgba(255,255,255,0.34)' : 'rgba(20,22,28,0.34)';
  const acc = ['#7C8CFF', '#6FD3F7', '#5FD08A', '#F2B45C', '#F56FB0', '#B98CF3'][i % 6];

  ctx.save();
  ctx.globalAlpha = ap;
  ctx.translate(0, (1 - ap) * 18);
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 12;
  fillRR(ctx, x, y, w, h, 10, bg);
  ctx.restore();

  // 有真图就直接铺（cover + 焦点），没有才走程序化缩略
  const img = media && media.get(`wall${String(i).padStart(2, '0')}`);
  if (img) {
    ctx.save();
    ctx.globalAlpha = 1;
    drawMedia(ctx, img, x, y, w, h, 10);
    ctx.restore();
    strokeRR(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 10, 'rgba(255,255,255,0.12)', 1);
    return;
  }

  ctx.save();
  rr(ctx, x, y, w, h, 10);
  ctx.clip();

  // 顶部窗口条：三个小点 + 标题块
  ctx.fillStyle = mut;
  for (let k = 0; k < 3; k++) {
    ctx.beginPath();
    ctx.arc(x + 14 + k * 7, y + 13, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = ap * 0.55;
  fillRR(ctx, x + 40, y + 10, w * 0.22, 5, 2.5, mut);
  ctx.globalAlpha = ap;

  // 主体：6 种版式的抽象缩略
  const kind = i % 6;
  const ax = x + 22;
  const ay = y + 34;
  const aw = w - 44;
  const ah = h - 62;
  if (kind === 0) {
    // 折线图
    ctx.strokeStyle = hexA(acc, 0.9);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let k = 0; k < 7; k++) {
      const px = ax + (k / 6) * aw;
      const py = ay + ah * (0.62 - Math.sin(k * 1.1) * 0.22);
      k === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();
    for (let k = 0; k < 7; k++) {
      dot(ctx, ax + (k / 6) * aw, ay + ah * (0.62 - Math.sin(k * 1.1) * 0.22), 2.6, acc);
    }
  } else if (kind === 1) {
    // 环形节点图
    ctx.strokeStyle = mut;
    ctx.lineWidth = 1;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.arc(ax + aw * 0.3, ay + ah * 0.5, ah * (0.16 + k * 0.11), 0, Math.PI * 2);
      ctx.stroke();
    }
    dot(ctx, ax + aw * 0.3, ay + ah * 0.5, 4.5, acc);
    ctx.beginPath();
    ctx.moveTo(ax + aw * 0.3, ay + ah * 0.5);
    ctx.lineTo(ax + aw * 0.62, ay + ah * 0.34);
    ctx.strokeStyle = mut;
    ctx.stroke();
    dot(ctx, ax + aw * 0.62, ay + ah * 0.34, 3, acc);
    // 右侧说明行
    for (let k = 0; k < 3; k++) fillRR(ctx, ax + aw * 0.7, ay + ah * 0.3 + k * 10, aw * (0.22 - k * 0.04), 3, 1.5, mut);
  } else if (kind === 2) {
    // 文档 / 卡片版式
    fillRR(ctx, ax + aw * 0.10, ay + ah * 0.08, aw * 0.34, ah * 0.84, 3, dark ? '#E8E6DF' : '#1D2029');
    fillRR(ctx, ax + aw * 0.14, ay + ah * 0.16, aw * 0.26, ah * 0.07, 2, acc);
    for (let k = 0; k < 4; k++) fillRR(ctx, ax + aw * 0.14, ay + ah * 0.32 + k * ah * 0.13, aw * (0.24 - (k % 2) * 0.07), 3, 1.5, mut);
    for (let k = 0; k < 2; k++) fillRR(ctx, ax + aw * 0.52, ay + ah * 0.16 + k * ah * 0.22, aw * 0.3, ah * 0.14, 2, hexA(acc, 0.35));
  } else if (kind === 3) {
    // 阵列 / 辐射
    const cx0 = ax + aw * 0.5;
    const cy0 = ay + ah * 0.5;
    ctx.fillStyle = hexA(acc, 0.75);
    for (let k = 0; k < 18; k++) {
      const a = (k / 18) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx0 + Math.cos(a) * ah * 0.36, cy0 + Math.sin(a) * ah * 0.36, 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
    dot(ctx, cx0, cy0, 5, acc);
    ctx.strokeStyle = hexA(acc, 0.35);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx0, cy0, ah * 0.22, 0, Math.PI * 2);
    ctx.stroke();
  } else if (kind === 4) {
    // 条形 + 说明
    for (let k = 0; k < 4; k++) {
      fillRR(ctx, ax, ay + ah * 0.16 + k * ah * 0.19, aw * (0.82 - k * 0.13), ah * 0.09, 2, k === 0 ? acc : mut);
    }
    fillRR(ctx, ax, ay + ah * 0.88, aw * 0.4, 3, 1.5, mut);
  } else {
    // 同心圆 / 焦点
    ctx.strokeStyle = hexA(acc, 0.6);
    ctx.lineWidth = 1.2;
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      ctx.arc(ax + aw * 0.46, ay + ah * 0.5, ah * (0.12 + k * 0.10), 0, Math.PI * 2);
      ctx.stroke();
    }
    dot(ctx, ax + aw * 0.46, ay + ah * 0.5, 3.4, acc);
    for (let k = 0; k < 2; k++) fillRR(ctx, ax + aw * 0.78, ay + ah * 0.4 + k * 12, aw * 0.16, 3, 1.5, mut);
  }

  // 底部说明条
  ctx.fillStyle = mut;
  ctx.fillRect(x + 14, y + h - 16, Math.min(w * 0.34, 120), 3);
  ctx.restore();
  strokeRR(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 10, 'rgba(255,255,255,0.10)', 1);
}

export function reuse(ctx, a, t, d) {
  const tp = easeOut(seg(t, 0.1, 0.55));
  if (tp > 0 && a.kline) {
    ctx.save();
    ctx.globalAlpha = tp;
    const gw = a.klineGrad || 'be reused';
    const i = a.kline.indexOf(gw);
    mixed(ctx, [
      { s: a.kline.slice(0, i) },
      { s: gw, grad: true },
      { s: a.kline.slice(i + gw.length) },
    ], W / 2, 200, { size: 58, fam: FAM.black });
    ctx.restore();
  }

  const cols = 4;
  const rows = 3;
  const x0 = 200;
  const y0 = 250;
  const gap = 14;
  const w = (1520 - gap * (cols - 1)) / cols;
  const h = 222;
  for (let i = 0; i < cols * rows; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    wallTile(ctx, x0 + c * (w + gap), y0 + r * (h + gap * 1.4), w, h, i, seg(t, 0.2, 1.9), a.__media);
  }

  const cp = easeOut(seg(t, 1.6, 2.1));
  if (cp > 0 && a.decode) {
    ctx.save();
    ctx.globalAlpha = cp;
    tag(ctx, a.decode, W / 2, 992, { size: 15, tracking: 3.6, align: 'center', color: '#8E94AC' });
    ctx.restore();
  }
}

/* =========================================================
 * 8 · spec — 开放规格
 * ======================================================= */
const CODE = (a) => [
  { t: '{', c: 'p' },
  { t: '  "$schema"', c: 'k', v: ': ', s: a.schemaUrl || '"./params.schema.json"' },
  { t: '  "runtime"', c: 'k', v: ': { ', s: a.runtime || '"engine": "skia", "browser": false' },
  { t: '  "params"', c: 'k', v: ': { ', s: a.params || '"title": { "type": "string" }' },
  { t: '  "guide"', c: 'k', v: ': ', s: a.guide || '"guide.json"' },
  { t: '}', c: 'p' },
];
const CODE_COL = { k: '#7ED8F8', s: '#9FE0A8', p: '#8E94AC', v: '#8E94AC' };

export function spec(ctx, a, t, d) {
  const tp = easeOut(seg(t, 0.1, 0.55));
  if (tp > 0 && a.kline) {
    ctx.save();
    ctx.globalAlpha = tp;
    const gw = a.klineGrad || 'AI models and tools';
    const i = a.kline.indexOf(gw);
    mixed(ctx, [
      { s: a.kline.slice(0, i) },
      { s: gw, grad: true },
      { s: a.kline.slice(i + gw.length) },
    ], W / 2, 200, { size: 52, fam: FAM.black });
    ctx.restore();
  }

  const x = 604, y = 340, w = 738, h = 330;
  const cp = easeOut(seg(t, 0.25, 0.8));
  if (cp > 0) {
    ctx.save();
    ctx.globalAlpha = cp;
    ctx.translate(0, (1 - cp) * 18);
    glass(ctx, x, y, w, h, { r: 12, fill: 'rgba(8,9,14,0.94)', stroke: 'rgba(160,150,255,0.35)' });
    tag(ctx, a.fileName || 'motion.json', x + 22, y + 30, { size: 12, color: '#D3D8E6', tracking: 0.4 });
    tag(ctx, a.version || 'Motion Open Spec v0.1 Draft', x + w - 22, y + 30, { size: 11, align: 'right', color: '#6E7590', tracking: 0.4 });
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(x, y + 46);
    ctx.lineTo(x + w, y + 46);
    ctx.stroke();

    let cy = y + 84;
    const shown = Math.round(clamp(seg(t, 0.45, 1.25)) * CODE(a).length);
    // 行宽自适应：代码是可换的（不同工程的 schema 路径长度差别很大），
    // 超宽就整行缩字号，不做裁切——裁掉的是 JSON 的关键字段，比字小更难发现。
    const AVAIL = w - 52;
    CODE(a).forEach((ln, i) => {
      if (i >= shown) return;
      const full = ln.s === undefined ? ln.t : ln.t + ln.v + ln.s;
      let size = 17;
      const wFull = measure(ctx, full, { size, fam: FAM.mono });
      if (wFull > AVAIL) size = Math.max(12, Math.floor((size * AVAIL) / wFull));
      if (ln.s === undefined) {
        txt(ctx, ln.t, x + 26, cy, { size, fam: FAM.mono, color: CODE_COL[ln.c] });
      } else {
        txt(ctx, ln.t, x + 26, cy, { size, fam: FAM.mono, color: CODE_COL[ln.c] });
        const wl = measure(ctx, ln.t, { size, fam: FAM.mono });
        txt(ctx, ln.v, x + 26 + wl, cy, { size, fam: FAM.mono, color: '#6E7590' });
        const wv = measure(ctx, ln.v, { size, fam: FAM.mono });
        txt(ctx, ln.s, x + 26 + wl + wv, cy, { size, fam: FAM.mono, color: CODE_COL.s });
      }
      cy += 34;
    });

    // 状态条
    if (seg(t, 1.1, 1.5) > 0) {
      const sp = easeOut(seg(t, 1.1, 1.5));
      ctx.globalAlpha = cp * sp;
      fillRR(ctx, x, y + h - 46, w, 46, 0, 'rgba(95,208,138,0.10)');
      txt(ctx, '✓', x + 24, y + h - 17, { size: 16, color: C.green });
      txt(ctx, a.status || 'Open specification · Connect compatible models and tools', x + 46, y + h - 17, {
        size: 15, fam: FAM.medium, color: '#B9E8C9',
      });
    }
    ctx.restore();
  }

  // 外围工具胶囊 + 点线
  const chips = a.tools || [];
  chips.forEach((c, i) => {
    const p = easeBack(seg(t, 0.55 + i * 0.075, 0.9 + i * 0.075));
    if (p <= 0) return;
    const pos = c.pos || [0, 0];
    ctx.save();
    ctx.globalAlpha = clamp(p);
    // 连线：左右两列接到卡片侧边，底排接到卡片下沿（参考片是两种走法，不能混用）
    if (!c.noLink) {
      const anchor = c.side === 'bottom'
        ? [pos[0], y + h]
        : [x + (c.side === 'right' ? w : 0), pos[1]];
      const from = c.side === 'bottom' ? [pos[0], pos[1] - 16] : [pos[0] + (c.side === 'right' ? -100 : 100), pos[1]];
      dottedLine(ctx, from[0], from[1], anchor[0], anchor[1]);
      dot(ctx, anchor[0], anchor[1], 3, c.color || C.purple, 10);
    }
    chip(ctx, c.label, pos[0], pos[1], { size: 17, align: c.align || 'center', padX: 22, dotColor: null });
    ctx.restore();
  });
}

/* =========================================================
 * 9 · share — 分支图
 * ======================================================= */
function branchPath(ctx, pts, color, p) {
  // pts: [[x,y], ...]；先画平滑曲线，再按 p 截断（用 dash 偏移做"生长"）
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
  const len = ctx.measureText ? 4000 : 4000;
  ctx.setLineDash([len * clamp(p), len]);
  ctx.stroke();
  ctx.restore();
}

function graphNode(ctx, x, y, label, color, p) {
  const e = easeBack(clamp(p));
  if (e <= 0) return;
  ctx.save();
  ctx.globalAlpha = clamp(e);
  ctx.shadowColor = color;
  ctx.shadowBlur = 20;
  ctx.beginPath();
  ctx.arc(x, y, 14 * clamp(e), 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
  txt(ctx, label, x, y + 5, { size: 11, fam: FAM.bold, align: 'center', color: '#0A0B12' });
}

function pill(ctx, str, x, y, color) {
  const size = 11;
  ctx.save();
  ctx.font = `10px ${FAM.mono}`;
  const tw = ctx.measureText(str).width;
  ctx.restore();
  const w = tw + 26;
  fillRR(ctx, x - w / 2, y - 11, w, 22, 11, 'rgba(10,12,18,0.9)');
  strokeRR(ctx, x - w / 2, y - 11, w, 22, 11, hexA(color, 0.45), 1);
  txt(ctx, str, x, y + 4, { size: 10, fam: FAM.mono, align: 'center', color, tracking: 0.6 });
}

export function share(ctx, a, t, d) {
  const tp = easeOut(seg(t, 0.1, 0.55));
  if (tp > 0) {
    ctx.save();
    ctx.globalAlpha = tp;
    txt(ctx, a.title || 'Made for more creators', 640, 180, { size: 26, fam: FAM.semi, color: '#E6E9F2' });
    tag(ctx, a.stats || '19 commits  ·  5 creators  ·  4 forks', 1748, 178, { size: 13, align: 'right', color: '#8E94AC', tracking: 1.2 });
    ctx.restore();
  }

  const g = seg(t, 0.04, 1.32);
  const baseY = 560;
  const main = [[180, baseY], [1740, baseY]];
  branchPath(ctx, main, 'rgba(200,205,220,0.55)', seg(g, 0, 0.5));

  // 主line 节点
  const mainNodes = a.mainNodes || [];
  mainNodes.forEach((n, i) => {
    const p = seg(g, 0.15 + i * 0.05, 0.35 + i * 0.05);
    graphNode(ctx, n.x ?? 260 + i * 300, baseY, n.l || 'm', '#B98CF3', p);
  });

  // 分支
  const branches = a.branches || [];
  branches.forEach((b, i) => {
    const bp = seg(g, 0.35 + i * 0.10, 1 + i * 0.10);
    if (bp <= 0) return;
    branchPath(ctx, b.path, b.color, bp);
    const np = seg(g, 0.55 + i * 0.10, 0.8 + i * 0.10);
    (b.nodes || []).forEach((n) => graphNode(ctx, n[0], n[1], n[2] || 'L', b.color, np));
    if (b.label) {
      const lp = easeOut(seg(g, 0.6 + i * 0.1, 0.85 + i * 0.1));
      if (lp > 0) {
        ctx.save();
        ctx.globalAlpha = lp;
        pill(ctx, b.label, b.labelAt[0], b.labelAt[1], b.color);
        ctx.restore();
      }
    }
  });

  const kp = easeOut(seg(t, 1.25, 1.75));
  if (kp > 0 && a.kline) {
    ctx.save();
    ctx.globalAlpha = kp;
    const gw = a.klineGrad || 'Shared and refined.';
    const i = a.kline.indexOf(gw);
    mixed(ctx, [
      { s: a.kline.slice(0, i) },
      { s: gw, grad: true },
      { s: a.kline.slice(i + gw.length) },
    ], W / 2, 960, { size: 62, fam: FAM.black });
    ctx.restore();
  }
}

/* =========================================================
 * 10 · finale — 回到字标
 * ======================================================= */
export function finale(ctx, a, t, d) {
  wordmark(ctx, W / 2, 512, 272, clamp(t / 1.1), { text: a.wordmark || '.cutduo', dotStyle: a.dotStyle });
  const sp = easeOut(seg(t, 0.9, 1.5));
  if (sp > 0 && a.kline) {
    ctx.save();
    ctx.globalAlpha = sp;
    const gw = a.klineGrad || 'great design';
    const i = a.kline.indexOf(gw);
    mixed(ctx, [
      { s: a.kline.slice(0, i) },
      { s: gw, grad: true },
      { s: a.kline.slice(i + gw.length) },
    ], W / 2, 748 + (1 - sp) * 18, { size: 62, fam: FAM.expBold });
    ctx.restore();
  }
  const rp = seg(t, 0, 4);
  if (rp > 0) {
    ctx.save();
    ctx.globalAlpha = Math.sin(rp * Math.PI) * 0.30;
    ctx.strokeStyle = 'rgba(150,160,255,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(W / 2, 430, 300 + rp * 240, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/* =========================================================
 * 11 · end — 落款
 * ======================================================= */
export function end(ctx, a, t, d) {
  const ip = easeBack(seg(t, 0.1, 0.7));
  const size = 178;
  const cx = W / 2;
  const lockY = 435;

  if (ip > 0) {
    ctx.save();
    ctx.globalAlpha = clamp(ip);
    appIcon(ctx, cx - 470, lockY + 52 - size * 0.78, size, { r: size * 0.27, letter: (a.__brand && a.__brand.initial) || 'm' });
    ctx.restore();
  }
  const tp = easeOut(seg(t, 0.25, 0.85));
  if (tp > 0) {
    ctx.save();
    ctx.globalAlpha = tp;
    // 落款是「图标 + 名字」，句点只活在字标里（hero/finale）。否则会读成 "c .cutduo"，两个标记打架。
    const lockup = String(a.brand || 'cutduo').replace(/^\./, '');
    txt(ctx, lockup, cx - 262, lockY + 52, { size: 146, fam: FAM.black, color: '#F4F6FA' });
    ctx.restore();
  }
  const up = easeOut(seg(t, 0.6, 1.1));
  if (up > 0 && a.domain) {
    ctx.save();
    ctx.globalAlpha = up;
    tag(ctx, a.domain, cx, 726, { size: 28, tracking: 1.0, align: 'center', color: '#C9CDDD' });
    const w = measure(ctx, a.domain, { size: 28, fam: FAM.mono });
    bar(ctx, cx - w / 2, 750, w, 2.5);
    ctx.restore();
  }
}

export { wordmarkSprite as __wmSprite };
