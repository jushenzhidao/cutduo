#!/usr/bin/env node
/**
 * replica-compare.mjs — 复刻验收：参考片 ↔ 复刻片逐元素对照
 *
 * 只做三件事，全部给数字：
 *   1. 人物包围盒（按"橙色外套 / 深色头发"掩膜，避开米色底与文字）
 *   2. 字幕墨迹包围盒（底部字幕带）
 *   3. 全帧 MAE / 分区 MAE（左文区 / 右人区 / 字幕区），并输出并排图与差分图
 *
 *   node tools/replica-compare.mjs --ref /tmp/ref.mp4 --rep out/x.mp4 --times 4,10,30 \
 *        --out out/replica-science-vo/measure
 *
 * 两侧都先归一化到参考片尺寸（默认 568×320）再比，避免分辨率差污染结论。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const REF = arg('ref');
const REP = arg('rep');
const TIMES = String(arg('times', '2,10,30,40,50,55,63,70')).split(',').map(Number);
const OUT = path.resolve(arg('out', 'out/replica-measure'));
const W = Number(arg('w', 568));
const H = Number(arg('h', 320));
if (!REF || !REP) {
  console.error('用法: node tools/replica-compare.mjs --ref ref.mp4 --rep rep.mp4 [--times 4,10] [--out dir]');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

function grab(video, t, file) {
  execFileSync(FFMPEG, [
    '-v', 'error', '-ss', String(t), '-i', video, '-frames:v', '1',
    '-vf', `scale=${W}:${H}:flags=lanczos`, '-y', file,
  ]);
  return file;
}

function pixels(img) {
  const c = createCanvas(img.width, img.height);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, img.width, img.height).data;
}

/** 人物掩膜：橙外套（R-B 差距大且亮）或深发（亮度低）。排除底部字幕带。 */
function figureBox(px, w, h) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
  const yLimit = Math.round(h * 0.82);
  for (let y = 0; y < yLimit; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      const coat = r - b > 45 && r > 110 && g < r - 15;
      const hair = luma < 95;
      if (!(coat || hair)) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      n++;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, npix: n };
}

/** 字幕墨迹：底部 12% 带内，找"白字 + 深描边"的高对比像素包围盒。 */
function captionBox(px, w, h) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
  const ys = Math.round(h * 0.82);
  for (let y = ys; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      // 白字芯
      const white = luma > 232 && Math.max(r, g, b) - Math.min(r, g, b) < 26;
      if (!white) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      n++;
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, npix: n };
}

function regionMAE(a, b, w, h, box) {
  let sum = 0, n = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const i = (y * w + x) * 4;
      sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      n += 3;
    }
  }
  return sum / Math.max(1, n);
}

function diffCanvas(a, b, w, h) {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  const im = g.createImageData(w, h);
  for (let i = 0; i < w * h * 4; i += 4) {
    const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    const v = Math.min(255, d * 3);
    im.data[i] = v; im.data[i + 1] = v === 0 ? 0 : Math.round(v * 0.35); im.data[i + 2] = 0;
    im.data[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}

const rows = [];
for (const t of TIMES) {
  const tag = t.toFixed(2).replace('.', '_');
  const fRef = grab(REF, t, path.join(OUT, `ref_${tag}.png`));
  const fRep = grab(REP, t, path.join(OUT, `rep_${tag}.png`));
  const [iRef, iRep] = [await loadImage(fRef), await loadImage(fRep)];
  const pRef = pixels(iRef), pRep = pixels(iRep);
  const fbRef = figureBox(pRef, W, H), fbRep = figureBox(pRep, W, H);
  const cbRef = captionBox(pRef, W, H), cbRep = captionBox(pRep, W, H);
  const mae = regionMAE(pRef, pRep, W, H, { x0: 0, y0: 0, x1: W, y1: H });
  const maeFig = fbRef
    ? regionMAE(pRef, pRep, W, H, {
      x0: Math.max(0, Math.min(fbRef.x, fbRep ? fbRep.x : fbRef.x) - 10),
      y0: Math.max(0, Math.min(fbRef.y, fbRep ? fbRep.y : fbRef.y) - 10),
      x1: Math.min(W, Math.max(fbRef.x + fbRef.w, fbRep ? fbRep.x + fbRep.w : 0) + 10),
      y1: Math.min(H, Math.max(fbRef.y + fbRef.h, fbRep ? fbRep.y + fbRep.h : 0) + 10),
    })
    : null;

  // 并排 + 差分，便于人眼复核
  const pad = 6;
  const sheet = createCanvas(W * 3 + pad * 4, H + pad * 2);
  const sg = sheet.getContext('2d');
  sg.fillStyle = '#111'; sg.fillRect(0, 0, sheet.width, sheet.height);
  sg.drawImage(iRef, pad, pad, W, H);
  sg.drawImage(iRep, pad * 2 + W, pad, W, H);
  sg.drawImage(diffCanvas(pRef, pRep, W, H), pad * 3 + W * 2, pad, W, H);
  fs.writeFileSync(path.join(OUT, `cmp_${tag}.png`), sheet.toBuffer('image/png'));

  rows.push({
    t,
    mae: +mae.toFixed(2),
    maeFigure: maeFig === null ? null : +maeFig.toFixed(2),
    figure: fbRef, figureReplica: fbRep,
    caption: cbRef, captionReplica: cbRep,
  });
}

const report = {
  ref: REF, rep: REP, size: [W, H],
  summary: {
    maeAvg: +(rows.reduce((s, r) => s + r.mae, 0) / rows.length).toFixed(2),
    figureDx: rows.map((r) => (r.figure && r.figureReplica ? r.figureReplica.x - r.figure.x : null)),
    figureDy: rows.map((r) => (r.figure && r.figureReplica ? r.figureReplica.y - r.figure.y : null)),
    figureDw: rows.map((r) => (r.figure && r.figureReplica ? r.figureReplica.w - r.figure.w : null)),
    figureDh: rows.map((r) => (r.figure && r.figureReplica ? r.figureReplica.h - r.figure.h : null)),
  },
  rows,
};
fs.writeFileSync(path.join(OUT, 'measure.json'), JSON.stringify(report, null, 2));

console.log('时间   全帧MAE  人区MAE  参考人物(w×h)      复刻人物(w×h)      Δx  Δy  Δw  Δh');
for (const r of rows) {
  const f = r.figure, g = r.figureReplica;
  const fmt = (b) => (b ? `${b.w}×${b.h}@${b.x},${b.y}` : '—');
  const d = (k) => (f && g ? String(g[k] - f[k]).padStart(4) : '   —');
  console.log(
    String(r.t).padStart(5),
    String(r.mae).padStart(8),
    String(r.maeFigure ?? '—').padStart(8),
    fmt(f).padEnd(18),
    fmt(g).padEnd(18),
    d('x'), d('y'), d('w'), d('h'),
  );
}
console.log('明细 →', path.join(OUT, 'measure.json'));
