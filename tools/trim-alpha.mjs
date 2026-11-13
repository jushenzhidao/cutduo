#!/usr/bin/env node
/**
 * trim-alpha.mjs — 把"纯底图"变成"透明底方形素材"
 *
 * 用途：文生图（flux 等）只出 RGB，没有 alpha；而版式里的 MK.prop 是叠加在
 * 白色圆盘上的，带白底的方图会露出边角。这里做三步：
 *   1. 从四边泛洪，抠掉与纯白差 < tol 的连通区域（不会吃掉被深色描边包住的奶油色高光）
 *   2. 按不透明像素裁边，留 margin 白边
 *   3. 居中装进正方形（透明填充），尺寸统一，方便 MK.prop 按 size 等比绘制
 *
 *   node tools/trim-alpha.mjs --in raw.png --out hip-joint.png --size 900 --tol 20
 *   node tools/trim-alpha.mjs --in raw.png --out fig.png --size 0     # 0 = 不补成方形，只裁到内容
 */
import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const IN = arg('in');
const OUT = arg('out');
const SIZE = Number(arg('size', 900));
const TOL = Number(arg('tol', 20));
const MARGIN = Number(arg('margin', 0.05));
if (!IN || !OUT) { console.error('用法: node tools/trim-alpha.mjs --in raw.png --out out.png'); process.exit(2); }

const img = await loadImage(IN);
const W = img.width, H = img.height;
const c = createCanvas(W, H);
const g = c.getContext('2d');
g.drawImage(img, 0, 0);
const im = g.getImageData(0, 0, W, H);
const d = im.data;

const isWhite = (i) => d[i] > 255 - TOL && d[i + 1] > 255 - TOL && d[i + 2] > 255 - TOL;

// 1) 四边泛洪
const seen = new Uint8Array(W * H);
const stack = [];
for (let x = 0; x < W; x++) { stack.push(x, (H - 1) * W + x); }
for (let y = 0; y < H; y++) { stack.push(y * W, y * W + W - 1); }
while (stack.length) {
  const p = stack.pop();
  if (seen[p]) continue;
  const i = p * 4;
  if (!isWhite(i)) continue;
  seen[p] = 1;
  d[i + 3] = 0;
  const x = p % W, y = (p / W) | 0;
  if (x > 0) stack.push(p - 1);
  if (x < W - 1) stack.push(p + 1);
  if (y > 0) stack.push(p - W);
  if (y < H - 1) stack.push(p + W);
}

// 2) 边缘羽化：不透明且紧邻全透明的像素，把 alpha 打到 55%（去锯齿）
const alpha0 = new Uint8Array(W * H);
for (let p = 0; p < W * H; p++) alpha0[p] = d[p * 4 + 3];
for (let y = 1; y < H - 1; y++) {
  for (let x = 1; x < W - 1; x++) {
    const p = y * W + x;
    if (!alpha0[p]) continue;
    const nearEmpty = !alpha0[p - 1] || !alpha0[p + 1] || !alpha0[p - W] || !alpha0[p + W];
    if (nearEmpty) d[p * 4 + 3] = 145;
  }
}

// 关键：改的是 ImageData 数组，必须写回 canvas；漏这一步等于什么都没做
// （症状是"裁了边但白底还在"——因为 drawImage 拿到的还是原图）
g.putImageData(im, 0, 0);

// 3) 裁到不透明包围盒
let x0 = W, y0 = H, x1 = -1, y1 = -1;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (d[(y * W + x) * 4 + 3] > 8) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
}
if (x1 < 0) { console.error('整张图都是背景色，没东西可裁'); process.exit(1); }
const bw = x1 - x0 + 1, bh = y1 - y0 + 1;

// size=0：只裁到内容，不补方形（人物这类长宽比有意义，硬补方形会让它变小）
if (SIZE <= 0) {
  const out0 = createCanvas(bw, bh);
  out0.getContext('2d').drawImage(c, x0, y0, bw, bh, 0, 0, bw, bh);
  fs.writeFileSync(OUT, out0.toBuffer('image/png'));
  console.log(`${IN} ${W}x${H} → ${OUT} ${bw}x${bh}（只裁内容，未补方形，裁掉白底 ${(100 * (1 - (bw * bh) / (W * H))).toFixed(0)}% 面积）`);
  process.exit(0);
}

const out = createCanvas(SIZE, SIZE);
const og = out.getContext('2d');
const inner = SIZE * (1 - MARGIN * 2);
const sc = Math.min(inner / bw, inner / bh);
const ow = bw * sc, oh = bh * sc;
og.drawImage(c, x0, y0, bw, bh, (SIZE - ow) / 2, (SIZE - oh) / 2, ow, oh);
fs.writeFileSync(OUT, out.toBuffer('image/png'));
console.log(`${IN} ${W}x${H} → ${OUT} ${SIZE}x${SIZE}（内容 ${Math.round(ow)}x${Math.round(oh)}，裁掉白底 ${(100 * (1 - (bw * bh) / (W * H))).toFixed(0)}% 面积）`);
