#!/usr/bin/env node
/**
 * text-bands.mjs — 量文字行带（复刻标定用）
 *
 * 对一帧图的一个矩形区域，按行统计"墨迹像素"（与区域主色差 > 阈值），
 * 输出每段连续墨迹的 top / height / 左右边界。用来把"看着偏了"变成 ±1px 的数字。
 *
 *   node tools/text-bands.mjs --img a.png --box 40,60,350,220 [--thr 40] [--json]
 *   node tools/text-bands.mjs --img a.png --img b.png --box ...   # 两图同框对比
 */
import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const imgs = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--img') imgs.push(process.argv[i + 1]);
}
const box = String(arg('box', '0,0,0,0')).split(',').map(Number);
const THR = Number(arg('thr', 40));
const MINH = Number(arg('minh', 3));
const ASJSON = process.argv.includes('--json');

async function bandsOf(file) {
  const img = await loadImage(file);
  const c = createCanvas(img.width, img.height);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const [x0, y0, w, h] = box[2] > 0 ? box : [0, 0, img.width, img.height];
  const d = g.getImageData(x0, y0, w, h).data;
  // 区域主色 = 众数（量化到 8 级）
  const hist = new Map();
  for (let i = 0; i < w * h; i++) {
    const k = ((d[i * 4] >> 5) << 6) | ((d[i * 4 + 1] >> 5) << 3) | (d[i * 4 + 2] >> 5);
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  let best = 0, bestN = -1;
  for (const [k, n] of hist) if (n > bestN) { bestN = n; best = k; }
  const bg = [((best >> 6) & 7) * 32 + 16, ((best >> 3) & 7) * 32 + 16, (best & 7) * 32 + 16];
  const rows = new Array(h).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dd = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
      if (dd > THR) rows[y]++;
    }
  }
  const out = [];
  let cur = null;
  for (let y = 0; y < h; y++) {
    const on = rows[y] > w * 0.004;
    if (on && !cur) cur = { top: y, bot: y };
    else if (on) cur.bot = y;
    else if (cur) { if (cur.bot - cur.top + 1 >= MINH) out.push(cur); cur = null; }
  }
  if (cur && cur.bot - cur.top + 1 >= MINH) out.push(cur);
  // 左右边界：整条带内的墨迹 x 范围
  return out.map((b) => {
    let xa = 1e9, xb = -1;
    for (let y = b.top; y <= b.bot; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const dd = Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]);
        if (dd > THR) { if (x < xa) xa = x; if (x > xb) xb = x; }
      }
    }
    return { y: y0 + b.top, h: b.bot - b.top + 1, x: x0 + xa, w: xb - xa + 1 };
  });
}

const res = [];
for (const f of imgs) res.push({ file: f, bands: await bandsOf(f) });
if (ASJSON) {
  console.log(JSON.stringify(res, null, 2));
} else {
  for (const r of res) {
    console.log(r.file.split('/').pop());
    for (const b of r.bands) console.log(`   y=${b.y}  h=${b.h}  x=${b.x}  w=${b.w}`);
  }
}
