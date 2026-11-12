/**
 * skia-kit · 纸面模板渲染器（无浏览器）
 *
 * 从 motion-kit《paper-perspective》成片逐像素反推出来的 8 个版式：
 *   hero / point / number / compare / steps / quote / checklist / outro
 *
 * 这里只负责“画”，不负责编码与时间轴。调用方给一个 2D context、一份 scenes/captions，
 * 就能逐帧取图；编码、混音、并发出片由 render.mjs 或任意流水线负责。
 *
 *   import { createPaperRenderer, registerFonts } from './paper.mjs';
 *   registerFonts('assets/fonts');
 *   const r = createPaperRenderer({ ctx });
 *   r.setContent({ scenes, captions, avatar });
 *   for (let f = 0; f < frames; f++) { r.renderFrame(f / fps); }
 */
import fs from 'node:fs';
import path from 'node:path';
import { GlobalFonts } from '@napi-rs/canvas';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const TOKENS_PATH = path.join(HERE, 'tokens.json');

export function loadTokens(p = TOKENS_PATH) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
export const DEFAULT_TOKENS = loadTokens();

/** 注册模板所需字重；找不到会告警并回退系统字体（视觉会退化）。 */
export function registerFonts(dir = path.join(HERE, '..', 'assets', 'fonts')) {
  let ok = 0;
  for (const [file, name] of [
    ['NotoSansSC-Black.otf', 'NotoSC Black'],
    ['NotoSansSC-Medium.otf', 'NotoSC Medium'],
    ['NotoSansSC-Regular.otf', 'NotoSC Regular'],
  ]) {
    const p = path.join(dir, file);
    try { if (fs.existsSync(p)) { GlobalFonts.registerFromPath(p, name); ok++; } } catch { /* ignore */ }
  }
  if (!ok) console.warn('  \u26a0 \u672a\u627e\u5230 Noto Sans SC\uff0c\u6807\u9898\u4f1a\u56de\u9000\u7cfb\u7edf\u5b57\u4f53\uff08\u89c6\u89c9\u76f8\u4f3c\u5ea6\u4e0b\u964d\uff09');
  return ok;
}

/**
 * @param {{ctx: CanvasRenderingContext2D, width?:number, height?:number,
 *          fonts?:object, palette?:object, avatarBox?:object, margin?:number,
 *          presenterLabel?:string}} opts
 */
export function createPaperRenderer(opts = {}) {
  const ctx = opts.ctx;
  if (!ctx) throw new Error('createPaperRenderer: ctx is required');
  const W = opts.width || 1920;
  const H = opts.height || 1080;
  const T = opts.tokens || DEFAULT_TOKENS;
  const fonts = opts.fonts || T.fonts;
  const palette = opts.palette || T.palette;
  const avatarBox = opts.avatarBox || T.avatarBox;
  const margin = opts.margin != null ? opts.margin : T.margin;
  const presenterLabel = opts.presenterLabel || T.presenterLabel;
  // 氛围层 / 信息层分工：
  //   bgImage    —— 生成式底图（纸纹、墨迹），只做背景，不参与排版
  //   bgWash     —— 纸色蒙版强度 0–1，越高文字越稳（默认 0.72）
  //   transparentBg —— 只画信息层、底透明，用于把文字叠到生成素材上（合成在 ffmpeg 侧做）
  const bgImage = opts.bgImage || null;
  const bgWash = opts.bgWash == null ? 0.72 : Number(opts.bgWash);
  const transparentBg = !!opts.transparentBg;
  // 转场：默认硬切。擦拭（wipe）做成可选项——实测溶解会把两张 126px 标题叠成一团，
  // 擦拭不叠字但会把字形切在边沿上，两种都不是这种排版型画面的默认最优解。
  const transition = opts.transition === 'wipe' ? 'wipe' : 'cut';
  const transitionDur = Number(opts.transitionDur || 0.26);

  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const pr = (t, a, b) => clamp((t - a) / (b - a));
  const eo = (x) => 1 - Math.pow(1 - x, 3);
  const eo4 = (x) => 1 - Math.pow(1 - clamp(x), 4);          // 更冲的 easeOutQuart，用于数字/弹出
  const eio = (x) => { const q = clamp(x); return q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2; };
  const lerp = (a, b, k) => a + (b - a) * k;
  /**
   * 入场包装：透明度 + 位移，内部照常按**最终坐标**画。
   * 保证 p=1 时 transform 归零、alpha=1 —— 落版几何与模板逐像素一致，verify.mjs 不受影响。
   */
  const enter = (p, fn, o = {}) => {
    const e = (o.ease || eo)(clamp(p));
    if (e <= 0) return;
    const dy = o.dy == null ? 12 : o.dy, dx = o.dx == null ? 0 : o.dx;
    ctx.save();
    ctx.globalAlpha *= e;
    if (dy || dx) ctx.translate(dx * (1 - e), dy * (1 - e));
    fn(e, 1 - e);
    ctx.restore();
  };

  let scenes = [];
  let skipBg = false;   // 转场时第二个场景不再铺底
  let captions = [];
  let avatarImg = null;
  let castFontSize = 132;

const PF = Object.assign({}, {
  black: '"NotoSC Black", "PingFang SC", "Hiragino Sans GB", sans-serif',
  med: '"NotoSC Medium", "PingFang SC", "Hiragino Sans GB", sans-serif',
  reg: '"NotoSC Regular", "PingFang SC", "Hiragino Sans GB", sans-serif',
  mono: '"Menlo", monospace',
}, fonts || {});
const PK = Object.assign({}, {
  bg: '#EFEFE5', ink: '#15231A', accent: '#1E8A66',
  body: '#5F6A5C', label: '#6E7869', bar: 'rgba(18,18,16,0.62)',
  ring: 'rgba(30,138,102,0.26)', hair: 'rgba(0,0,0,0.10)',
}, palette || {});
let BLUE = PK.accent;
let INK = PK.ink;
const PRESENTER_LABEL = presenterLabel || '\u6653\u6653 \u00b7 \u53e3\u64ad';
const PAPER_AVATAR = Object.assign({ x: 1264, y: 73, w: 473, h: 805, r: 24 }, avatarBox || {});
const PAPER_MARGIN = margin != null ? margin : 142;
const TEXT_CACHE = new Map();

function parseRichChars(text) {
  const out = [];
  let acc = false;
  for (const ch of String(text)) {
    if (ch === '*') { acc = !acc; continue; }
    out.push({ ch, acc });
  }
  return out;
}

function charW(ch, font) {
  const k = font + '\u0000' + ch;
  let w = TEXT_CACHE.get(k);
  if (w === undefined) { ctx.font = font; w = ctx.measureText(ch).width; TEXT_CACHE.set(k, w); }
  return w;
}

function charsWidth(chars, font) {
  let w = 0;
  for (const c of chars) w += charW(c.ch, font);
  return w;
}

const NO_LINE_START = /^[，。、；：！？）】」』”,.!?:;)\]]$/;

function wrapChars(chars, font, maxWidth) {
  const lines = [];
  let cur = [], w = 0;
  for (const c of chars) {
    const cw = charW(c.ch, font);
    if (w + cw > maxWidth && cur.length && !NO_LINE_START.test(c.ch)) {
      lines.push({ chars: cur, w });
      cur = []; w = 0;
    }
    cur.push(c); w += cw;
  }
  if (cur.length) lines.push({ chars: cur, w });
  return lines;
}

function drawRun(text, x, y, font, color) {
  ctx.font = font; ctx.fillStyle = color; ctx.fillText(text, x, y);
}

function drawChars(line, x, y, font, color, accent, clipW, track = 0) {
  let px = x;
  let i = 0;
  const limit = clipW == null ? Infinity : clipW;
  while (i < line.chars.length) {
    const acc = line.chars[i].acc;
    let t = '';
    while (i < line.chars.length && line.chars[i].acc === acc) { t += line.chars[i].ch; i++; }
    if (px - x >= limit) break;
    const w = charsWidth([...t].map((ch) => ({ ch })), font);
    if (px - x + w <= limit) {
      if (!track) {
        drawRun(t, px, y, font, acc ? accent : color);
        px += w;
      } else {
        for (const ch of t) {
          drawRun(ch, px, y, font, acc ? accent : color);
          px += charW(ch, font) + track;
        }
      }
    } else {
      for (const ch of t) {
        const cw = charW(ch, font);
        if (px - x >= limit) break;
        const show = Math.min(cw, limit - (px - x));
        ctx.save();
        ctx.beginPath(); ctx.rect(px, y - 240, show, 480); ctx.clip();
        drawRun(ch, px, y, font, acc ? accent : color);
        ctx.restore();
        px += cw + track;
      }
      break;
    }
  }
  return px - x;
}

const ascentCache = new Map();
function refAscent(font) {
  let a = ascentCache.get(font);
  if (a === undefined) {
    ctx.font = font;
    const m = ctx.measureText('国');
    a = m.actualBoundingBoxAscent || 0.88 * parseFloat(font);
    ascentCache.set(font, a);
  }
  return a;
}

function fitSize(text, size, maxWidth, fontOf, min = 40) {
  const chars = parseRichChars(text);
  let s = size;
  while (s > min && charsWidth(chars, fontOf(s)) > maxWidth) s -= 2;
  return s;
}

function paperBg() {
  if (skipBg) return;
  if (transparentBg) { ctx.clearRect(0, 0, W, H); return; }
  ctx.fillStyle = PK.bg;
  ctx.fillRect(0, 0, W, H);
  if (!bgImage) return;
  const s = Math.max(W / bgImage.width, H / bgImage.height);
  const dw = bgImage.width * s, dh = bgImage.height * s;
  ctx.save();
  ctx.drawImage(bgImage, (W - dw) / 2, (H - dh) / 2, dw, dh);
  // 纸色蒙版：把纹理压回接近底色，保证正文/标题对比度不被吃掉
  ctx.globalAlpha = bgWash;
  ctx.fillStyle = PK.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function paperTimecode(t) {
  const mm = String(Math.floor(t / 60)).padStart(2, '0');
  const ss = String(Math.floor(t % 60)).padStart(2, '0');
  ctx.font = `400 20px ${PF.mono}`;
  ctx.fillStyle = '#5C5D5C';
  ctx.textAlign = 'right';
  ctx.fillText(`${mm}:${ss}`, 1860, 96);
  ctx.textAlign = 'left';
}

function paperAvatarCard(sc) {
  const { x, y, w, h, r } = PAPER_AVATAR;

  // 没有人物素材时，这一格改成「本章关键词卡」：
  // 既不放通用人脸素材（观感廉价），也不留一块空灰卡（右半画幅全废）。
  if (!avatarImg) {
    const cast = (sc && sc.args && (sc.args.cast || sc.args.title)) || (sc ? String(sc.type) : '');
    if (!cast) return;
    const idx = Math.max(0, scenes.indexOf(sc));
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.10)'; ctx.shadowBlur = 26; ctx.shadowOffsetY = 10;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = PK.accent; ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.clip();
    ctx.font = `400 20px ${PF.mono}`; ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.textAlign = 'left';
    ctx.fillText('CHAPTER', x + 48, y + 64);
    ctx.textAlign = 'right';
    ctx.fillText(`${String(idx + 1).padStart(2, '0')} / ${String(scenes.length).padStart(2, '0')}`, x + w - 48, y + 64);
    const chars = Array.from(cast);
    const rows = chars.length > 6 ? 2 : 1;
    const per = Math.ceil(chars.length / rows);
    const lines = [];
    for (let k = 0; k < chars.length; k += per) lines.push(chars.slice(k, k + per).join(''));
    // 字号全片统一（computeCastSize），换章不跳；4 个字的卡不会顶出 473px 边界。
    const size = rows > 1 ? Math.min(castFontSize, 104) : castFontSize;
    ctx.font = `400 ${size}px ${PF.black}`;
    ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'left';
    const baseY = y + h * 0.50 - (lines.length - 1) * size * 0.56;
    lines.forEach((ln, k) => ctx.fillText(ln, x + 48, baseY + k * size * 1.14));
    ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x + 48, y + h - 136); ctx.lineTo(x + 168, y + h - 136); ctx.stroke();
    ctx.font = `400 26px ${PF.med}`; ctx.fillStyle = 'rgba(255,255,255,0.86)';
    ctx.fillText('本章关键词', x + 48, y + h - 88);
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.12)';
  ctx.shadowBlur = 26; ctx.shadowOffsetY = 10;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = '#E4E4DC'; ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.clip();
  if (avatarImg) {
    const s = Math.max(w / avatarImg.width, h / avatarImg.height);
    const dw = avatarImg.width * s, dh = avatarImg.height * s;
    ctx.drawImage(avatarImg, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = '#D8D8CE'; ctx.fillRect(x, y, w, h);
  }
  // 左上角胶囊标签
  const label = PRESENTER_LABEL;
  ctx.font = `500 20px ${PF.med}`;
  const tw = ctx.measureText(label).width;
  ctx.beginPath(); ctx.roundRect(x + 26, y + 26, tw + 28, 40, 20);
  ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.fill();
  ctx.fillStyle = '#FFFFFF'; ctx.fillText(label, x + 40, y + 54);
  ctx.restore();
}

function paperCaption(t) {
  const c = captions.find((x) => t >= x.start && t < x.end);
  if (!c) return;
  const q = pr(t, c.start, c.start + 0.22);
  if (q <= 0) return;
  const font = `500 42px ${PF.med}`;
  const chars = parseRichChars(c.text);
  const w = charsWidth(chars, font);
  const boxW = Math.min(1700, w + 76);
  const x = (W - boxW) / 2, y = 930, h = 70;
  enter(q, () => {
    ctx.beginPath(); ctx.roundRect(x, y, boxW, h, 6);
    ctx.fillStyle = PK.bar; ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x + 38, y, boxW - 76, h, 0); ctx.clip();
    drawChars({ chars }, x + 38, 947 + inkAsc(c.text, font), font, '#FFFFFF', '#FFFFFF');
    ctx.restore();
  }, { dy: 9 });
}

/* ---------- 8 个版式 ---------- */

function inkAsc(text, font) {
  const k = font + '\u0000' + text;
  let a = TEXT_CACHE.get(k);
  if (a === undefined) { ctx.font = font; a = ctx.measureText(text).actualBoundingBoxAscent || refAscent(font); TEXT_CACHE.set(k, a); }
  return a;
}
function trackWidth(chars, font, track) {
  return charsWidth(chars, font) + track * Math.max(0, chars.length - 1);
}

function clampStart(at, t0, maxDelay = 0.06) {
  return Math.min(at, (t0 || 0) + maxDelay);
}

function pLabel(text, cx, inkTop, color = PK.label, track = 4.7) {
  const f = `500 22px ${PF.med}`;
  const chars = parseRichChars(text);
  const w = trackWidth(chars, f, track);
  drawChars({ chars }, cx - w / 2, inkTop + inkAsc(text, f), f, color, BLUE, null, track);
}

function pHero(t, a) {
  paperBg();
  const eyebrow = String(a.sub || '').replace(/^\/\/\s*/, '');
  if (eyebrow) {
    const ep = pr(t, 0.05, 0.45);
    if (ep > 0) {
      ctx.save(); ctx.globalAlpha = eo(ep);
      const f = `500 22px ${PF.med}`;
      drawChars({ chars: parseRichChars(eyebrow) }, PAPER_MARGIN, 285 + inkAsc(eyebrow, f), f, PK.label, BLUE, null, 4.7);
      ctx.restore();
    }
  }
  const lines = a.lines || [];
  const availW = PAPER_AVATAR.x - PAPER_MARGIN - 56;
  const size = Math.min(...lines.map(([s]) => fitSize(s, 126, availW, (v) => `900 ${v}px ${PF.black}`)));
  const font = `900 ${size}px ${PF.black}`;
  const pitch = 136;
  const t0 = a.t0 || 0;
  const shift = lines.length ? Math.max(0, lines[0][1] - clampStart(lines[0][1], t0)) : 0;
  lines.forEach(([text, at0], i) => {
    const at = at0 - shift;
    const p = pr(t, at, at + 0.52);
    if (p <= 0) return;
    const chars = parseRichChars(text);
    const w = charsWidth(chars, font);
    const baseline = 344 + i * pitch + inkAsc(text, font);
    enter(p, () => {
      drawChars({ chars }, PAPER_MARGIN, baseline, font, PK.ink, BLUE, w * eo(p));
      if (p < 0.995) {
        ctx.fillStyle = BLUE;
        ctx.fillRect(PAPER_MARGIN + w * eo(p) + 6, baseline - inkAsc(text, font), 5, inkAsc(text, font) * 1.04);
      }
    }, { dy: 18 });
    // 强调词下的手绘横线：本行揭示完成后从左往右画出来（easeInOut，收笔利落）
    const k0 = chars.findIndex((c) => c.acc);
    if (k0 >= 0) {
      let x0 = PAPER_MARGIN, aw = 0;
      chars.forEach((c, k) => {
        const cwid = charW(c.ch, font);
        if (k < k0) x0 += cwid; else if (c.acc) aw += cwid;
      });
      const up = pr(t, at + 0.5, at + 0.88);
      if (up > 0 && aw > 0) {
        ctx.save();
        ctx.globalAlpha = 0.8 * eo(up);
        ctx.fillStyle = BLUE;
        ctx.fillRect(x0, baseline + 10, aw * eio(up), 6);
        ctx.restore();
      }
    }
  });
}

function pPoint(t, a) {
  paperBg();
  // 大弧从左往右长出来，0.9s 画完（之后保持整条不动）
  const ap = eio(pr(t, (a.t0 || 0) + 0.04, (a.t0 || 0) + 0.94));
  if (ap > 0) {
    ctx.save();
    ctx.strokeStyle = PK.ring; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(668, 872, 757, Math.PI * 1.292, Math.PI * (1.292 + 0.416 * ap));
    ctx.stroke();
    ctx.restore();
  }

  const words = a.words || [];
  const title = words.map(([s]) => s).join('');
  const size = fitSize(title, 116, 916, (v) => `900 ${v}px ${PF.black}`);
  const font = `900 ${size}px ${PF.black}`;
  const chars = parseRichChars(title);
  const tw = charsWidth(chars, font);
  const cx = 668;

  const lp = pr(t, 0.05, 0.4);
  if (lp > 0) { ctx.save(); ctx.globalAlpha = eo(lp); pLabel('重点', cx, 257); ctx.restore(); }

  const startAt = words.length ? clampStart(words[0][1], a.t0) : (a.t0 || 0);
  const tp = pr(t, startAt, startAt + 0.6);
  if (tp > 0) {
    const e = eo(tp);
    const baseline = 305 + inkAsc(title, font);
    let accW = 0, accX = 0, cursor = cx - tw / 2;
    chars.forEach((c) => {
      const w = charW(c.ch, font);
      if (c.acc) { if (!accW) accX = cursor; accW += w; }
      cursor += w;
    });
    ctx.save();
    ctx.globalAlpha *= e;
    ctx.translate(0, (1 - e) * 14);
    if (accW > 0) {
      const hp = eo(pr(t, startAt + 0.45, startAt + 0.9));
      if (hp > 0) {
        ctx.save(); ctx.globalAlpha *= 0.9 * hp;
        ctx.fillStyle = 'rgba(30,138,102,0.16)';
        ctx.fillRect(accX - 6, baseline - inkAsc(title, font) * 0.98, (accW + 12) * hp, inkAsc(title, font) * 1.16);
        ctx.restore();
      }
    }
    drawChars({ chars }, cx - tw / 2, baseline, font, PK.ink, BLUE, tw * eo(tp));
    const up = pr(t, startAt + 0.5, startAt + 0.9);
    if (up > 0 && accW > 0) {
      ctx.save(); ctx.globalAlpha *= 0.55 * eo(up);
      ctx.fillStyle = BLUE;
      ctx.fillRect(accX, 444, accW * eo(up), 4);
      ctx.restore();
    }
    ctx.restore();
  }
  const cards = a.cards || [];
  const bf = `500 40px ${PF.med}`;
  cards.forEach(([text, at], i) => {
    const p = pr(t, at, at + 0.4);
    if (p <= 0) return;
    ctx.save(); ctx.globalAlpha = eo(p);
    const bchars = parseRichChars(text);
    const bw = charsWidth(bchars, bf);
    drawChars({ chars: bchars }, cx - bw / 2, 491 + i * 62 + inkAsc(text, bf) + (1 - eo(p)) * 10, bf, PK.body, BLUE);
    ctx.restore();
  });
}

function pNumber(t, a) {
  paperBg();
  const cx = 670, cy = 418;
  const t0 = a.t0 ?? 0;
  const at = a.at ?? t0, dur = a.dur || 1.4;
  const p = pr(t, at, at + dur);
  const rp = eo(pr(t, t0 + 0.04, t0 + 0.5));      // 环入场：0.9 倍半径扩到实际大小
  const R = 265, Rr = R * lerp(0.9, 1, rp);
  ctx.save();
  ctx.globalAlpha *= 0.15 + 0.85 * rp;
  ctx.strokeStyle = PK.ring; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, Rr, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.arc(cx, cy, Rr - 28, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();

  const prog = eo(p);
  // 36 条刻度：走过的点亮成强调色，未到的留极淡底纹
  for (let i = 0; i < 36; i++) {
    const ang = -Math.PI / 2 + (i / 36) * Math.PI * 2;
    const on = i / 36 <= prog;
    ctx.save();
    ctx.globalAlpha = (on ? 0.9 : 0.16) * rp;
    ctx.strokeStyle = on ? BLUE : '#8A9386';
    ctx.lineWidth = on ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * (Rr - 20), cy + Math.sin(ang) * (Rr - 20));
    ctx.lineTo(cx + Math.cos(ang) * (Rr - 8), cy + Math.sin(ang) * (Rr - 8));
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 6; ctx.lineCap = 'round';
  ctx.globalAlpha *= rp;
  ctx.beginPath(); ctx.arc(cx, cy, 237, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog); ctx.stroke();
  ctx.restore();

  pLabel(a.label || '', cx, 236);

  // 数字滚动用 easeOutQuart：前段冲、末段收，比三次方更有「停稳」的手感
  const val = String(Math.round((a.from || 0) + ((a.value ?? 0) - (a.from || 0)) * eo4(p)));
  const nf = `900 172px ${PF.black}`;
  const uf = `900 66px ${PF.black}`;
  const vw = charsWidth(parseRichChars(val), nf);
  const uw = a.unit ? charsWidth(parseRichChars(a.unit), uf) : 0;
  const nx = cx - (vw + 10 + uw) / 2;
  drawChars({ chars: parseRichChars(val) }, nx, 352 + inkAsc(val, nf), nf, PK.ink, BLUE);
  if (a.unit) drawChars({ chars: parseRichChars(a.unit) }, nx + vw + 10, 424 + inkAsc(a.unit, uf), uf, BLUE, BLUE);

  if (a.sub) {
    const q = pr(t, at + dur * 0.85, at + dur * 0.85 + 0.35);
    if (q > 0) enter(q, () => {
      const sf = `500 42px ${PF.med}`;
      const sw = charsWidth(parseRichChars(a.sub), sf);
      drawChars({ chars: parseRichChars(a.sub) }, cx - sw / 2, 693 + inkAsc(a.sub, sf), sf, PK.body, BLUE);
    }, { dy: 8 });
  }
}

function pCompare(t, a) {
  paperBg();
  const colW = 360;
  const LX = 141, RX = 1198;
  // 左右大标题同号：逐栏 fitSize 会让两栏字数不同时差一到两号，成对出现时一眼能看出不齐
  const bigSize = Math.min(...[a.left, a.right].map(
    (s) => fitSize((((s || {}).items) || [])[0] || '', 92, colW, (v) => `900 ${v}px ${PF.black}`)));
  const drawCol = (side, right, accentColor, p, base) => {
    if (p <= 0) return;
    const lf = `500 22px ${PF.med}`;
    const bf = `500 38px ${PF.med}`;
    const items = side.items || [];
    const big = items[0] || '';
    const bs = bigSize;
    const tf = `900 ${bs}px ${PF.black}`;
    const place = (text, font, x, inkTop, color, track = 0) => {
      const w = trackWidth(parseRichChars(text), font, track);
      const px = right ? x - w : x;
      drawChars({ chars: parseRichChars(text) }, px, inkTop + inkAsc(text, font), font, color, BLUE, null, track);
    };
    ctx.save();
    // 两栏各自从外侧滑进来：左栏从 -26、右栏从 +26，落位后偏移归零
    ctx.globalAlpha *= eo(p);
    ctx.translate((right ? 26 : -26) * (1 - eo(p)), 0);
    place(side.title || '', lf, right ? RX : LX, 259, right ? BLUE : PK.label, 4.7);
    place(big, tf, right ? RX : LX, 317, PK.ink);
    items.slice(1).forEach((s, i) => {
      const q = pr(t, base + 0.25 + i * 0.18, base + 0.55 + i * 0.18);
      if (q <= 0) return;
      ctx.save(); ctx.globalAlpha = eo(p) * eo(q);
      place(s, bf, right ? RX : LX, 427 + i * 63, PK.body);
      ctx.restore();
    });
    ctx.restore();
  };
  const lAt = clampStart(a.leftAt, a.t0, 0.05);
  const rAt = Math.min(a.rightAt, lAt + 0.45);
  drawCol(a.left || {}, false, '#000', pr(t, lAt, lAt + 0.4), lAt);
  drawCol(a.right || {}, true, BLUE, pr(t, rAt, rAt + 0.4), rAt);

  const dp = pr(t, rAt, rAt + 0.4);
  if (dp > 0) {
    ctx.save(); ctx.globalAlpha *= eo(dp);
    ctx.strokeStyle = PK.hair; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(670.5, 252); ctx.lineTo(670.5, 572); ctx.stroke();
    const vf = `500 50px ${PF.med}`;
    const vw = charsWidth(parseRichChars('VS'), vf);
    // VS 从 0.86 倍弹到 1 倍（围绕自身中心缩放）
    const s = lerp(0.86, 1, eo(dp));
    const vy = 326 + inkAsc('VS', vf);
    ctx.translate(666, vy - inkAsc('VS', vf) / 2);
    ctx.scale(s, s);
    ctx.translate(-666, -(vy - inkAsc('VS', vf) / 2));
    drawChars({ chars: parseRichChars('VS') }, 666 - vw / 2, vy, vf, PK.label, BLUE);
    ctx.restore();
  }

  // 旧做法被划掉：一条横线从左往右扫过左栏大标题（strikeAt，缺省 = leftAt + 1.4s）
  const sAt = a.strikeAt != null ? a.strikeAt : (a.leftAt || 0) + 1.4;
  const sp = pr(t, sAt, sAt + 0.34);
  const lTitle = ((a.left || {}).items || [])[0] || '';
  if (sp > 0 && lTitle) {
    const tf = `900 ${bigSize}px ${PF.black}`;
    const lw = charsWidth(parseRichChars(lTitle), tf);
    const ly = 317 + inkAsc(lTitle, tf) * 0.55;
    ctx.save();
    ctx.globalAlpha *= 0.95 * eo(sp);
    // 用强调色而不是墨色：墨色横线穿过墨色字会糊成一片，看不出「划掉」
    ctx.fillStyle = BLUE;
    ctx.fillRect(LX, ly, lw * eio(sp) + 4, 7);
    ctx.restore();
  }
}

function pSteps(t, a) {
  paperBg();
  const steps = a.steps || [];
  const tf = `900 86px ${PF.black}`;
  drawChars({ chars: parseRichChars(a.title || '') }, PAPER_MARGIN, 187 + inkAsc(a.title || '', tf), tf, PK.ink, BLUE);

  const X0 = 246, X1 = 1093, N = Math.max(1, steps.length);
  const gx = N > 1 ? (X1 - X0) / (N - 1) : 0;
  const Y = 470;
  let prog = 0;
  steps.forEach(([, at], i) => { if (i > 0) prog = Math.max(prog, (i - 1 + eo(pr(t, at - 0.45, at))) / (N - 1)); });
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.16)'; ctx.lineWidth = 2;
  ctx.setLineDash([6, 8]);
  ctx.beginPath(); ctx.moveTo(X0 + (X1 - X0) * prog, Y); ctx.lineTo(X1, Y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = BLUE; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(X0, Y); ctx.lineTo(X0 + (X1 - X0) * prog, Y); ctx.stroke();
  ctx.restore();

  // 一行同号同基线：字号取所有卡片里最紧的那个，基线取全部墨迹上沿的最大值。
  // 逐卡 fitSize 会让「3 字 44px / 4 字 38px」，且各卡按自身 inkAsc 上沿对齐 ⇒ 基线错位、字没对上。
  // 卡片挂在各自节点正下方：节点由 X0/gx 在整条轨道上均分，卡片按 200 宽居中。
  // 原来卡片是「从 147 起、每张 +207」左对齐硬排的，只有 N=5 时才碰巧与节点重合；
  // N=3 时第三张卡会落到第二个节点下面（错位约 200px）——文字与图形对不上。
  const CARD_W = 200, CARD_ROOM = CARD_W - 48;
  const stepSize = steps.length
    ? Math.min(...steps.map(([tx]) => fitSize(tx, 44, CARD_ROOM, (v) => `900 ${v}px ${PF.black}`, 24)))
    : 44;
  const stepFont = `900 ${stepSize}px ${PF.black}`;
  const stepBase = 604 + (steps.length ? Math.max(...steps.map(([tx]) => inkAsc(tx, stepFont))) : 0);

  steps.forEach(([text, at], i) => {
    const p = pr(t, at, at + 0.4);
    const x = X0 + gx * i;
    ctx.save();
    ctx.strokeStyle = p > 0 ? BLUE : 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, Y, 23, 0, Math.PI * 2);
    ctx.fillStyle = PK.bg; ctx.fill(); ctx.stroke();
    if (p > 0) { ctx.beginPath(); ctx.arc(x, Y, 6, 0, Math.PI * 2); ctx.fillStyle = BLUE; ctx.fill(); }
    ctx.restore();

    // 节点激活时外扩一圈涟漪（0.4s 消隐）
    if (p > 0 && p < 1) {
      ctx.save();
      ctx.globalAlpha = 0.45 * (1 - p);
      ctx.strokeStyle = BLUE; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, Y, 23 + 18 * eio(p), 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }

    const cw = CARD_W, chh = 126, cy = 526;
    const cx = x - cw / 2;   // 与节点 x 同轴
    const e = p > 0 ? eo(p) : 0;
    const alpha = p > 0 ? e : 0.42;
    // 卡片弹出：0.94 → 1 倍，围绕自身中心缩放；未到场的幽灵卡保持原样
    const pop = p > 0 ? lerp(0.94, 1, e) : 1;
    const mx = cx + cw / 2, my = cy + chh / 2;
    ctx.save();
    ctx.translate(mx, my); ctx.scale(pop, pop); ctx.translate(-mx, -my);

    ctx.save(); ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(0,0,0,0.10)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 6;
    ctx.beginPath(); ctx.roundRect(cx, cy + (p > 0 ? (1 - e) * 12 : 0), cw, chh, 4);
    ctx.fillStyle = '#FFFFFF'; ctx.fill();
    ctx.restore();

    ctx.save(); ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.roundRect(cx + 2, cy, cw - 4, chh, 4); ctx.clip();
    const nf = `500 20px ${PF.med}`;
    drawChars({ chars: parseRichChars(String(i + 1).padStart(2, '0')) }, cx + 16, 560 + inkAsc('0', nf), nf, '#8A9386', BLUE);
    // 整行同号同基线，只做水平居中；纵向不再逐卡浮动
    const chars = parseRichChars(text);
    const tw = charsWidth(chars, stepFont);
    drawChars({ chars }, cx + (cw - tw) / 2, stepBase, stepFont, PK.ink, BLUE);
    ctx.restore();
    ctx.restore();   // 结束卡片缩放
  });
}

function pQuote(t, a) {
  paperBg();
  // 大引号从 0.88 倍放大淡入
  const mp = eo(pr(t, (a.t0 || 0) + 0.02, (a.t0 || 0) + 0.5));
  if (mp > 0) {
    ctx.save();
    ctx.globalAlpha *= mp;
    ctx.font = `900 210px ${PF.black}`;
    ctx.fillStyle = 'rgba(30,138,102,0.20)';
    const s = lerp(0.88, 1, mp);
    ctx.translate(158, 362); ctx.scale(s, s); ctx.translate(-158, -362);
    ctx.fillText('\u201C', 158, 362);
    ctx.restore();
  }
  const lines = (a.lines || []).map((l, i, arr) => (
    i < arr.length - 1 && !/[，。、；：！？,.;:!?]$/.test(l.replace(/\*/g, '')) ? l + '，' : l
  ));
  const qsize = Math.min(...lines.map((l) => fitSize(l, 83, 780, (v) => `900 ${v}px ${PF.black}`)));
  const font = `900 ${qsize}px ${PF.black}`;
  const totalChars = lines.reduce((n, s) => n + parseRichChars(s).length, 0);
  const p = pr(t, a.at, a.at + 1.1);
  let budget = Math.round(totalChars * eo(p));
  lines.forEach((line, i) => {
    if (budget <= 0) return;
    const chars = parseRichChars(line);
    const shown = chars.slice(0, budget);
    const baseline = 328 + i * 119 + inkAsc(line, font);
    drawChars({ chars: shown }, 247, baseline, font, PK.ink, BLUE);
    // 打字机光标：只画在「正在打」的那一行（budget < 本行字数），末字后 5px。
    // 用柔和脉动而不是硬开关：视频里硬闪像丢帧。
    if (p > 0 && p < 0.999 && budget < chars.length) {
      const typed = charsWidth(shown, font);
      const blinkA = 0.2 + 0.7 * (0.5 + 0.5 * Math.sin(t * 10.8));
      ctx.save();
      ctx.globalAlpha *= blinkA;
      ctx.fillStyle = BLUE;
      ctx.fillRect(247 + typed + 5, baseline - inkAsc(line, font) + 4, 5, inkAsc(line, font) * 0.92);
      ctx.restore();
    }
    budget -= chars.length;
  });
  if (a.by) {
    const q = pr(t, a.at + 0.9, a.at + 1.3);
    if (q > 0) enter(q, () => {
      const bf = `500 31px ${PF.med}`;
      drawChars({ chars: parseRichChars(a.by) }, 248, 716 + inkAsc(a.by, bf), bf, PK.label, BLUE, null, 7);
    }, { dy: 8 });
  }
}

function pChecklist(t, a) {
  paperBg();
  const cx = 669, cy = 595, R = 330;
  const items = a.items || [];
  const total = Math.max(1, items.length);
  let done = 0;
  items.forEach(([, at], i) => { if (t >= at) done = i + 1; });
  const sweep = pr(t, a.t0 + 0.1, a.t1 - 0.2);
  const prog = done === 0 ? 0 : Math.min(1, 0.28 + 0.62 * eo(sweep));

  ctx.save();
  ctx.strokeStyle = PK.ring; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, R, Math.PI, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 13; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(cx, cy, R - 2, Math.PI, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 13;
  if (prog > 0.001) { ctx.beginPath(); ctx.arc(cx, cy, R - 2, Math.PI, Math.PI + Math.PI * prog); ctx.stroke(); }
  const ang = Math.PI + Math.PI * prog;
  ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(ang) * (R - 90), cy + Math.sin(ang) * (R - 90)); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  ctx.fillStyle = PK.bg; ctx.fill(); ctx.stroke();
  ctx.restore();

  // 刻度：25 条，随指针扫过逐条点亮（未到的留极淡），让扫动有「尺子」参照
  for (let i = 0; i <= 24; i++) {
    const aa = Math.PI + (i / 24) * Math.PI;
    const on = i / 24 <= prog;
    ctx.save();
    ctx.globalAlpha = on ? 0.5 : 0.12;
    ctx.strokeStyle = on ? BLUE : '#8A9386';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(aa) * (R - 24), cy + Math.sin(aa) * (R - 24));
    ctx.lineTo(cx + Math.cos(aa) * (R - 13), cy + Math.sin(aa) * (R - 13));
    ctx.stroke();
    ctx.restore();
  }

  pLabel(a.title || '', cx, 218);

  const nf = `500 180px ${PF.med}`, uf = `900 60px ${PF.black}`;
  const vw = charsWidth(parseRichChars(String(total)), nf);
  const uw = charsWidth(parseRichChars('\u6761'), uf);
  const nx = cx - (vw + 12 + uw) / 2 + 18;
  drawChars({ chars: parseRichChars(String(total)) }, nx, 427 + inkAsc(String(total), nf), nf, PK.ink, BLUE);
  drawChars({ chars: parseRichChars('\u6761') }, nx + vw + 12, 485 + inkAsc('\u6761', uf), uf, BLUE, BLUE);

  const cur = items[Math.min(items.length - 1, Math.max(0, done - 1))];
  if (cur) {
    const q = pr(t, cur[1], cur[1] + 0.3);
    if (q > 0) {
      const sf = `500 42px ${PF.med}`;
      const sw = charsWidth(parseRichChars(cur[0]), sf);
      enter(q, () => {
        drawChars({ chars: parseRichChars(cur[0]) }, cx - sw / 2, 637 + inkAsc(cur[0], sf), sf, PK.body, BLUE);
      }, { dy: 10 });
    }
  }
}

function pOutro(t, a) {
  paperBg();
  const title = a.title || '\u4e0b\u4e00\u671f';
  const tsize = fitSize(title, 230, 760, (v) => `900 ${v}px ${PF.black}`);
  const tf = `900 ${tsize}px ${PF.black}`;
  const tp = pr(t, a.t0 + 0.05, a.t0 + 0.55);
  if (tp > 0) {
    const base = 283 + inkAsc(title, tf) * 1.19;
    ctx.save();
    ctx.translate(0, base); ctx.scale(1, 1.19); ctx.translate(0, -base);
    const chars = parseRichChars(title);
    const tw = charsWidth(chars, tf);
    drawChars({ chars }, 324, base, tf, PK.ink, BLUE, tw * eo(tp));
    ctx.restore();
  }

  const sub = (a.lines || [])[0];
  if (sub) {
    const q = pr(t, a.t0 + 0.45, a.t0 + 0.85);
    if (q > 0) enter(q, () => {
      const sf = `500 34px ${PF.med}`;
      drawChars({ chars: parseRichChars(sub) }, 397, 585 + inkAsc(sub, sf), sf, PK.body, BLUE);
    }, { dy: 8 });
  }
  const cta = a.prompt || '';
  if (cta) {
    const q = pr(t, a.t0 + 0.75, a.t0 + 1.15);
    if (q > 0) {
      ctx.save(); ctx.globalAlpha = eo(q);
      const cf = `500 34px ${PF.med}`;
      const tw = charsWidth(parseRichChars(cta), cf);
      const pillW = Math.max(tw + 132, 420), pillH = 71, px = 397, py = 630;
      ctx.beginPath(); ctx.roundRect(px, py + (1 - eo(q)) * 10, pillW, pillH, pillH / 2);
      ctx.fillStyle = '#3B3B38'; ctx.fill();
      ctx.strokeStyle = '#7BD3AE'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      // 落位后箭头每 2 秒轻轻往前推 3px，暗示「可以点」
      const nudge = q >= 0.995 ? 3 * (0.5 + 0.5 * Math.sin((t - (a.t0 + 1.15)) * 3.1)) : 0;
      const ax = px + nudge;
      ctx.beginPath();
      ctx.moveTo(ax + 34, py + pillH / 2); ctx.lineTo(ax + 60, py + pillH / 2);
      ctx.moveTo(ax + 52, py + pillH / 2 - 8); ctx.lineTo(ax + 60, py + pillH / 2);
      ctx.lineTo(ax + 52, py + pillH / 2 + 8);
      ctx.stroke();
      drawChars({ chars: parseRichChars(cta) }, px + 82, py + 47, cf, '#FFFFFF', '#FFFFFF');
      ctx.restore();
    }
  }
}


function drawContent(sc, t) {
  const a = { ...sc.args, t0: sc.t0, t1: sc.t1 };
  switch (sc.type) {
    case 'hero': pHero(t, a); break;
    case 'point': pPoint(t, a); break;
    case 'number': pNumber(t, a); break;
    case 'compare': pCompare(t, a); break;
    case 'steps': pSteps(t, a); break;
    case 'quote': pQuote(t, a); break;
    case 'checklist': pChecklist(t, a); break;
    case 'outro': pOutro(t, a); break;
    // 空镜：不画正文，只出字幕条/时间码/头像卡；画面由生成素材提供（配 transparentBg 叠加）
    case 'broll': paperBg(); break;
    default: paperBg();
  }
}

function renderPaper(t, sc) {
  const idx = scenes.indexOf(sc);
  const prev = transition === 'wipe' && idx > 0 ? scenes[idx - 1] : null;
  const p = prev ? clamp((t - sc.t0) / transitionDur) : 1;
  if (p >= 1) {
    drawContent(sc, t);
  } else {
    // 竖向擦除（不是溶解）：任一时刻每个像素只属于一个镜头，两行大标题不会叠在一起。
    // 溶解在本模板上试过——两张 126px 标题在同一位置交叠，中段读不出字。
    paperBg();                                       // 底只铺一次
    skipBg = true;
    const edge = W * eio(p);
    ctx.save();                                      // 新镜：从左露出
    ctx.beginPath(); ctx.rect(0, 0, edge, H); ctx.clip();
    drawContent(sc, t);
    ctx.restore();
    ctx.save();                                      // 旧镜：留在右侧
    ctx.beginPath(); ctx.rect(edge, 0, W - edge, H); ctx.clip();
    drawContent(prev, t);
    ctx.restore();
    skipBg = false;
  }
  paperTimecode(t);
  paperAvatarCard(sc);
  paperCaption(t);
}

  /** 换内容：scenes 必须是已排好时间轴的分镜（t0/t1/args）。 */
  function setContent({ scenes: sc = [], captions: cp = [], avatar = null } = {}) {
    scenes = sc;
    captions = cp;
    avatarImg = avatar;
    castFontSize = computeCastSize(sc);
  }

  /**
   * 关键词卡字号在整片里统一：每章各自 fit 会让 2 字卡 132px、4 字卡 94px，
   * 一切换就跳字号。取所有章节里最小的那个可用字号，全片一个号。
   */
  function computeCastSize(sc) {
    const avail = PAPER_AVATAR.w - 96;
    let best = 132;
    for (const s of sc) {
      const t = (s && s.args && (s.args.cast || s.args.title)) || '';
      if (!t) continue;
      const cs = Array.from(String(t));
      const rows = cs.length > 6 ? 2 : 1;
      const per = Math.ceil(cs.length / rows);
      for (let k = 0; k < cs.length; k += per) {
        const line = cs.slice(k, k + per).join('');
        ctx.font = `400 100px ${PF.black}`;
        const w100 = ctx.measureText(line).width || 1;
        best = Math.min(best, (100 * avail) / w100);
      }
    }
    return Math.max(56, Math.floor(best));
  }

  /** 只换头像（例如换主播）。 */
  function setAvatar(img) { avatarImg = img; }

  /** 当前时间该画哪一镜 + 时间码 + 头像 + 字幕。 */
  function renderFrame(t) {
    const sc = scenes.find((s) => t >= s.t0 && t < s.t1) || scenes[scenes.length - 1];
    if (!sc) { paperBg(); return; }
    renderPaper(t, sc);
  }

  /** 单独画某一镜（预览/对比用）。 */
  function renderScene(t, sc) { renderPaper(t, sc); }

  return { setContent, setAvatar, renderFrame, renderScene, palette: PK, fonts: PF };
}
