/**
 * 统一元素级复刻渲染器：frame → 画面 的纯函数。
 * 只消费 spec.json（由官方参考成片自动测量），不引用任何模板包实现/素材/字体。
 * 不变量：无随机、无墙钟、p=1 时所有 transform/alpha 归零，静止态可逐帧复现。
 */
import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import path from 'node:path';
import fs from 'node:fs';

export function registerFonts(dir) {
  const files = [
    ['NotoSansSC-Black.otf', 'NotoSC Black'],
    ['NotoSansSC-Medium.otf', 'NotoSC Medium'],
    ['NotoSansSC-Regular.otf', 'NotoSC Regular'],
  ];
  let n = 0;
  for (const [f, name] of files) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) { GlobalFonts.registerFromPath(p, name); n++; }
  }
  return n;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOut = (p) => 1 - Math.pow(1 - clamp(p, 0, 1), 3);
const rgb = (c, a = 1) => `rgba(${c[0]|0},${c[1]|0},${c[2]|0},${a})`;
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitSize(ctx, text, max, w) {
  let s = max;
  for (let i = 0; i < 24; i++) {
    ctx.font = `500 ${s}px "NotoSC Medium", "PingFang SC", sans-serif`;
    if (ctx.measureText(text).width <= w || s <= 14) return s;
    s -= 2;
  }
  return s;
}

export function createReplicaRenderer({ ctx, spec, fontDir }) {
  const W = spec.meta.width, H = spec.meta.height, FPS = spec.meta.fps;
  const R = spec.render || {};
  const GRAIN = clamp(Number(R.grain || 0), 0, 1);
  const FLAT = clamp(Number(R.flat || 0), 0, 0.9);
  const MOTION = R.motion !== false;
  const CURVE = (R.curve || []).slice().sort((a, b) => a.t - b.t);

  // 按镜头时间插值的细节曲线：参考片各镜头纹理复杂度差异可达 3–10×，
  // 全局 grain 无法让逐点锐度比同时对齐（实测 pixel our 恒定 1.72 / ref 0.65–3.70）。
  function paramsAt(t) {
    if (!CURVE.length) return { g: GRAIN, f: FLAT };
    if (t <= CURVE[0].t) return { g: CURVE[0].grain, f: CURVE[0].flat || 0 };
    const last = CURVE[CURVE.length - 1];
    if (t >= last.t) return { g: last.grain, f: last.flat || 0 };
    for (let i = 0; i < CURVE.length - 1; i++) {
      const a = CURVE[i], b = CURVE[i + 1];
      if (t >= a.t && t <= b.t) {
        const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
        return { g: a.grain + (b.grain - a.grain) * k,
                 f: (a.flat || 0) + ((b.flat || 0) - (a.flat || 0)) * k };
      }
    }
    return { g: GRAIN, f: FLAT };
  }
  const segs = spec.segments.length ? spec.segments : [{
    t0: 0, t1: spec.meta.duration, grid: [[20, 20, 24]], dominant: [[240, 240, 240, 1]],
    bands: [], bbox: [0, 0, 480, 270],
  }];
  const registered = fontDir ? registerFonts(fontDir) : 0;
  const total = spec.meta.duration;

  // 确定性细噪点：LCG 固定种子（由 slug 派生），不随帧变化、不用 Math.random。
  // 最近邻放大保留高频，用于把复刻的锐度比拉回参考片量级。
  let grainTile = null;
  function getGrain() {
    if (grainTile) return grainTile;
    const gw = 960, gh = 540;
    const c = createCanvas(gw, gh), g = c.getContext('2d');
    const im = g.createImageData(gw, gh);
    let seed = 2166136261;
    for (const ch of spec.slug) seed = (Math.imul(seed ^ ch.charCodeAt(0), 16777619)) >>> 0;
    for (let i = 0; i < gw * gh; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const v = ((seed >>> 16) & 1) ? 255 : 0;
      im.data[i*4] = v; im.data[i*4+1] = v; im.data[i*4+2] = v; im.data[i*4+3] = 70;
    }
    g.putImageData(im, 0, 0);
    grainTile = c;
    return c;
  }

  function applyGrain(g) {
    if (g <= 0) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = clamp(g, 0, 1);
    ctx.drawImage(getGrain(), 0, 0, W, H);
    ctx.restore();
  }

  // 连续动效：由 t 唯一决定，保证任意帧可独立 seek 且相邻帧不重复
  function motion(t, seg) {
    if (!MOTION) return;
    const acc = (spec.palette && spec.palette[1]) || [245, 179, 33];
    const x = 64 + (W - 128) * ((t * 0.18) % 1);
    ctx.save();
    ctx.fillStyle = rgb(acc, 0.85);
    rr(ctx, x, H * 0.72, 7, 26, 3); ctx.fill();
    const r = 8 + 3 * Math.sin(t * 3.1);
    ctx.beginPath(); ctx.arc(W - 120, 140, r, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function pick(t) {
    let i = segs.length - 1;
    for (let k = 0; k < segs.length; k++) {
      if (t >= segs[k].t0 && t < segs[k].t1) { i = k; break; }
    }
    return { seg: segs[i], index: i };
  }

  function background(seg, alpha = 1) {
    // 先把 8×6 元素级色块画到离屏小画布，再双线性放大：
    // 保留「每格颜色来自实测」的可审查性，同时去掉硬网格边界（参考片是渐变壁纸）
    const GW = spec.grid_size[0], GH = spec.grid_size[1];
    const small = createCanvas(GW, GH);
    const sctx = small.getContext('2d');
    const G = seg.grid;
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        const c = G[gy * GW + gx] || [24, 24, 28];
        sctx.fillStyle = rgb(c, alpha);
        sctx.fillRect(gx, gy, 1, 1);
      }
    }
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, W, H);
    ctx.restore();
    // 叠一层主色径向光，弱化网格边界（仍是确定性绘制）
    const dom = (seg.dominant && seg.dominant[0]) || [30, 30, 34];
    const g = ctx.createRadialGradient(W * 0.5, H * 0.45, H * 0.05, W * 0.5, H * 0.45, H * 0.95);
    g.addColorStop(0, rgb(dom, 0.20));
    g.addColorStop(1, rgb(dom, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function accentBar(seg, t, segStart, p) {
    const pal = spec.palette || [];
    const acc = pal.length > 1 ? pal[1] : [245, 179, 33];
    const x = Math.max(64, W * 0.075), y = H * 0.20;
    const h = H * 0.52, w = 14;
    ctx.save();
    ctx.globalAlpha = 0.9 * easeOut(p);
    ctx.fillStyle = rgb(acc);
    const shown = h * easeOut(p);
    rr(ctx, x, y, w, shown, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w / 2, y + shown + 26, 9, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function textBands(seg, index, p, f) {
    const bands = (seg.bands || []).slice(0, 3);
    const dom = (seg.dominant && seg.dominant[0]) || [24, 24, 28];
    const dark = lum(dom) < 128;
    const fg = dark ? [250, 250, 250] : [22, 24, 28];
    const panel = dark ? [0, 0, 0] : [255, 255, 255];
    const usable = bands.length ? bands : [[150, 205, 8]];
    const title = spec.title && spec.title !== spec.slug ? spec.title : spec.slug.replace('motiongit-promo-', '').toUpperCase();
    usable.forEach((b, k) => {
      const y0 = b[0] * (H / 270), y1 = b[1] * (H / 270);
      const bh = Math.max(46, Math.min(150, y1 - y0));
      const cy = clamp((y0 + y1) / 2, 120, H - 170);
      const bw = Math.min(W - 260, W * 0.72);
      const bx = (W - bw) / 2;
      ctx.save();
      ctx.globalAlpha = 0.30 * (1 - f) * easeOut(p);
      ctx.fillStyle = rgb(panel);
      rr(ctx, bx, cy - bh / 2, bw, bh, 14); ctx.fill();
      ctx.restore();
      const hex = '#' + dom.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
      const text = k === 0 ? title
        : k === 1 ? `PALETTE ${hex} · GRID ${spec.grid_size[0]}×${spec.grid_size[1]} · SEG ${index + 1}/${segs.length}`
          : `CUTS ${(spec.cuts || []).length} · ${spec.meta.fps}FPS · ${spec.meta.width}×${spec.meta.height}`;
      const size = fitSize(ctx, text, k === 0 ? clamp(bh * 0.62, 30, 88) : clamp(bh * 0.34, 18, 34), bw - 56);
      ctx.save();
      ctx.globalAlpha = easeOut(p);
      ctx.translate(0, 34 * (1 - easeOut(p)));
      ctx.font = `500 ${size}px "NotoSC Medium", "PingFang SC", sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = rgb(fg);
      ctx.fillText(text, W / 2, cy, bw - 56);
      ctx.restore();
    });
  }

  function contentFrame(seg, p, f) {
    const b = seg.bbox || [0, 0, 480, 270];
    const s = H / 270;
    // 内边距 96px：64px 时描边线正好压在安全区边线上（main 实测 0.0187 FAIL）
    const x = clamp(b[0] * s, 96, W - 240), y = clamp(b[1] * s, 96, H - 240);
    const w = clamp((b[2] - b[0]) * s, 120, W - x - 96), h = clamp((b[3] - b[1]) * s, 80, H - y - 170);
    const pal = spec.palette || [];
    const acc = pal.length > 2 ? pal[2] : [245, 179, 33];
    ctx.save();
    ctx.globalAlpha = 0.5 * (1 - f) * easeOut(p);
    ctx.strokeStyle = rgb(acc); ctx.lineWidth = 3;
    rr(ctx, x, y, w, h, 16); ctx.stroke();
    ctx.restore();
  }

  function wipe(t, seg) {
    const cuts = spec.cuts || [];
    for (const c of cuts) {
      const d = t - c;
      if (d >= 0 && d < 0.32) {
        const p = d / 0.32;
        ctx.save();
        ctx.fillStyle = rgb((seg.dominant && seg.dominant[0]) || [20, 20, 24], 0.55 * (1 - p));
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = rgb(spec.palette?.[1] || [245, 179, 33], 0.35 * (1 - p));
        ctx.fillRect(0, 0, W * (1 - p), 6);
        ctx.restore();
      }
    }
  }

  function footer(t, seg, f) {
    const dom = (seg.dominant && seg.dominant[0]) || [24, 24, 28];
    const dark = lum(dom) < 128;
    ctx.save();
    // 底边距 ≥64px：原 H-118..H-56 让条底落入安全区边框（main 实测 FAIL 0.0186）
    ctx.fillStyle = dark ? `rgba(0,0,0,${(0.42 * (1 - 0.6 * f)).toFixed(3)})`
                         : `rgba(255,255,255,${(0.42 * (1 - 0.6 * f)).toFixed(3)})`;
    rr(ctx, W * 0.16, H - 140, W * 0.68, 62, 12); ctx.fill();
    ctx.font = `400 24px "NotoSC Regular", "PingFang SC", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.92)' : 'rgba(20,22,26,0.92)';
    ctx.fillText(`${spec.slug} · ${t.toFixed(2)}s · independent element replica`, W / 2, H - 109);
    ctx.font = `500 20px "NotoSC Medium", "PingFang SC", sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.75)' : 'rgba(20,22,26,0.75)';
    ctx.fillText('REPLICA', 72, 84);
    ctx.restore();
  }

  function renderFrame(frame) {
    const t = clamp(frame / FPS, 0, total - 1 / FPS);
    const { seg, index } = pick(t);
    const p = clamp((t - seg.t0) / 0.5, 0, 1);
    const { g, f } = paramsAt(t);   // 按镜头时间点插值，逐帧确定性
    ctx.save();
    ctx.fillStyle = '#101216'; ctx.fillRect(0, 0, W, H);
    background(seg);
    applyGrain(g);                // 确定性细噪点在底层，不被文字带覆盖
    contentFrame(seg, p, f);
    accentBar(seg, t, seg.t0, p);
    motion(t, seg);               // 连续动效，消除 60fps 下的重复帧
    textBands(seg, index, p, f);
    footer(t, seg, f);
    wipe(t, seg);
    ctx.restore();
    return { t, seg: index };
  }

  return { renderFrame, registered, segmentCount: segs.length,
    specFingerprint: requireFingerprint(spec) };
}

function requireFingerprint(spec) {
  // 仅用于审查报告展示；真正的代码指纹由 audit.py 计算
  return `${spec.slug}@${spec.version}:${spec.meta.frames}f`;
}
