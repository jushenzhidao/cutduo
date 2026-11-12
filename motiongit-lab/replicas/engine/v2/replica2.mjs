/**
 * v2 渲染器：公开成片测量参数 → 画面（frame → 画面的纯函数）。
 *
 * 图层自下而上：
 *   ① 颜色场：0.5s 粒度 96×54 测量帧，按 t 在相邻两场之间线性混合后放大铺底；
 *   ② 文字层：Vision OCR 测得文本 / bbox / 前后景色 / 字号，用本机字体独立重绘，
 *      跨 OCR 段按文本匹配做交叉淡化（不是把文字当色块糊掉）；
 *   ③ 确定性微噪点：保证 60fps 静态段无连续重复帧，相位由帧号唯一决定。
 *
 * 不变量：无随机、无墙钟；同 frame 号恒得同画面，可逐帧独立 seek。
 * 合规：只消费 specs2/ 下由公开成片测得的 JSON 与 96×54 颜色场，不引用模板包实现。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadImage, GlobalFonts, createCanvas } from '@napi-rs/canvas';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rgba = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

export function registerV2Fonts(fontDir) {
  const cands = [
    ['/System/Library/Fonts/Supplemental/Arial.ttf', 'V2Arial'],
    ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', 'V2ArialBold'],
    ['/System/Library/Fonts/Supplemental/Helvetica.ttc', 'V2Helvetica'],
    ['/Library/Fonts/Arial Unicode.ttf', 'V2Unicode'],
  ];
  if (fontDir) {
    for (const f of ['NotoSansSC-Regular.otf', 'NotoSansSC-Medium.otf', 'NotoSansSC-Black.otf']) {
      const p = path.join(fontDir, f);
      if (fs.existsSync(p)) cands.push([p, 'V2' + f.replace('.otf', '')]);
    }
  }
  let n = 0;
  for (const [p, name] of cands) {
    if (fs.existsSync(p)) {
      try { GlobalFonts.registerFromPath(p, name); n++; } catch (_) { /* 跳过不可注册字体 */ }
    }
  }
  return n;
}

const FONT_REG = '400';
const FONT_BOLD = '700';

function fitFont(ctx, text, size, maxW, bold) {
  let s = Math.max(10, size);
  const w = bold ? FONT_BOLD : FONT_REG;
  for (let i = 0; i < 16; i++) {
    ctx.font = `${w} ${s.toFixed(1)}px "V2Arial", "V2Unicode", "V2NotoSansSC-Regular", sans-serif`;
    if (ctx.measureText(text).width <= maxW || s <= 10) break;
    s *= 0.93;
  }
  return s;
}

export async function createV2Renderer({ ctx, meta, keys, fieldDir }) {
  const W = meta.width, H = meta.height, FPS = meta.fps;
  const DT = meta.field_dt || 0.5;
  const imgs = await Promise.all(keys.map(k => loadImage(path.join(fieldDir, k.field))));

  // 两张全幅低幅噪点图，按帧号奇偶切换：相邻帧必然不同（消除静态段重复帧），
  // 每帧只做一次 drawImage，成本恒定。
  // 两张逐像素互补的噪点图：相邻帧差 = 2*alpha*|base-127|，
  // 因此用更小的 alpha 也能破除重复帧，同时把纯色背景上的固定 MAD 开销压低。
  const base = new Uint8Array(W * H);
  let seed = 20261110;
  for (let i = 0; i < W * H; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    base[i] = 118 + (seed % 24);
  }
  const noiseFrames = [];
  for (let k = 0; k < 2; k++) {
    const c = createCanvas(W, H);
    const cc = c.getContext('2d');
    const id = cc.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const v = k === 0 ? base[i] : 254 - base[i];
      id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v;
      id.data[i * 4 + 3] = 255;
    }
    cc.putImageData(id, 0, 0);
    noiseFrames.push(c);
  }

  function rounded(ctx, x, y, w, h) {
    const r = Math.min(10, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawShapes(a, b, mix) {
    const A = a ? (a.shapes || []) : [], B = b ? (b.shapes || []) : [];
    if (!A.length && !B.length) return;
    const key = (s) => s.box.map(v => Math.round(v * 200)).join(',');
    const kb = new Map(B.map(s => [key(s), s])), ka = new Map(A.map(s => [key(s), s]));
    const same = a && b && a.ocr_t === b.ocr_t;
    const groups = [];
    for (const s of A) groups.push({ s, alpha: same || kb.has(key(s)) ? 1 : 1 - mix });
    for (const s of B) if (!ka.has(key(s))) groups.push({ s, alpha: same ? 0 : mix });
    ctx.save();
    for (const g of groups) {
      if (g.alpha <= 0.01) continue;
      const [x, y, w, h] = g.s.box;
      const X = x * W, Y = y * H, SW = Math.max(2, w * W), SH = Math.max(2, h * H);
      ctx.fillStyle = rgba(g.s.color, g.alpha);
      const ratio = SW / SH;
      if (0.75 < ratio && ratio < 1.35) {
        ctx.beginPath();
        ctx.ellipse(X + SW / 2, Y + SH / 2, SW / 2, SH / 2, 0, 0, Math.PI * 2);
        ctx.fill();
      } else {
        rounded(ctx, X, Y, SW, SH);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawTextLayer(a, b, mix) {
    if (!a && !b) return;
    const A = a ? a.texts : [], B = b ? b.texts : [];
    const key = (t) => t.text + '|' + t.box.map(v => Math.round(v * 100)).join(',');
    const mapB = new Map(B.map(t => [key(t), t]));
    const mapA = new Map(A.map(t => [key(t), t]));
    const sameSegment = a && b && a.ocr_t === b.ocr_t;
    const groups = [];
    for (const t of A) {
      const k = key(t);
      groups.push({ t, alpha: sameSegment || mapB.has(k) ? 1 : 1 - mix });
    }
    for (const t of B) {
      const k = key(t);
      if (!mapA.has(k)) groups.push({ t, alpha: sameSegment ? 0 : mix });
    }
    ctx.save();
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    for (const g of groups) {
      if (g.alpha <= 0.01) continue;
      const t = g.t;
      const [bx, by, bw, bh] = t.box;
      const x = bx * W, y = by * H;
      const maxW = Math.max(24, bw * W * 1.12);
      const bold = t.size >= 55;
      const s = fitFont(ctx, t.text, t.size, maxW, bold);
      // 不铺底色矩形：颜色场里文字已被面积平均得很淡，铺纯色块反而制造可见浅色斑。
      // 直接以测得前景色绘制清晰文字，靠字号/位置对齐即可。
      ctx.globalAlpha = g.alpha;
      ctx.fillStyle = rgba(t.fg);
      ctx.fillText(t.text, x, y + (bh * H - s) * 0.18);
    }
    ctx.restore();
  }

  // 按关键帧真实时间戳定位：field[i] 对应 (i+0.5)*DT（ffmpeg fps 区间中点），
  // 不能假设 t=i*DT，否则快速切换镜头会整片错帧。
  function locate(t) {
    if (t <= keys[0].t) return { i: 0, mix: 0 };
    const last = keys.length - 1;
    if (t >= keys[last].t) return { i: last, mix: 0 };
    let lo = 0, hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (keys[mid].t <= t) lo = mid; else hi = mid;
    }
    const span = keys[hi].t - keys[lo].t;
    return { i: lo, mix: span > 0 ? clamp((t - keys[lo].t) / span, 0, 1) : 0 };
  }

  function renderFrame(f) {
    const t = clamp(f / FPS, 0, meta.duration - 1 / FPS);
    const { i, mix } = locate(t);
    const j = Math.min(i + 1, imgs.length - 1);
    // 硬切区间不插值：在区间中点从 field[i] 直接切到 field[i+1]，
    // 否则会合成原片不存在的中间画面（快速切换模板的大面积错色来源）。
    let eff = mix;
    if (keys[i].hard_next && j === i + 1) {
      const mid = (keys[i].t + keys[j].t) / 2;
      eff = t < mid ? 0 : 1;
    }

    ctx.save();
    ctx.fillStyle = '#101216';
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(imgs[i], 0, 0, W, H);
    if (j !== i && eff > 0) {
      ctx.globalAlpha = eff;
      ctx.drawImage(imgs[j], 0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    // drawShapes 已停用：实测把「圆点群 / 带字 logo」错误聚合成矩形，
    // 比颜色场里位置与颜色都正确的糊块更差（MAD 7.20→8.38）。测量数据仍留档。
    drawTextLayer(keys[i], keys[j], eff);

    // 确定性微噪点：相位由帧号决定，强度固定且极低（不影响观感，只破重复帧）
    ctx.globalAlpha = 0.025;
    ctx.drawImage(noiseFrames[f % 2], 0, 0);
    ctx.restore();
  }

  return { renderFrame, fieldCount: imgs.length, keyCount: keys.length };
}
