#!/usr/bin/env node
/**
 * circle-prop.mjs — 把方图裁切成"圆形视窗"道具
 *
 * 为什么需要：`diagram` 版式把道具画在一个白色圆盘里（MK.prop 只做等比绘制，不裁剪）。
 * 方图塞进圆盘会有两个后果：内容按方形包围盒缩放 ⇒ 视觉上偏小；素材本身的裁切边
 * （例如股骨被原图下边缘切掉）会停在圆盘中央，读作"骨头断了"而不是"延伸出画面"。
 * 这里先把白底泛洪掉，再用抗锯齿圆形 alpha 收边：构图从"方形"变"视窗"。
 *
 *   node tools/circle-prop.mjs --in raw.png --out prop.png --size 900 --tol 22
 */
import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const IN = arg('in'), OUT = arg('out');
const SIZE = Number(arg('size', 900)), TOL = Number(arg('tol', 22));
if (!IN || !OUT) { console.error('用法: node tools/circle-prop.mjs --in raw.png --out prop.png [--size 900] [--tol 22]'); process.exit(2); }

const img = await loadImage(IN);
const W = img.width, H = img.height;
const c = createCanvas(W, H); const g = c.getContext('2d');
g.drawImage(img, 0, 0);
const im = g.getImageData(0, 0, W, H); const d = im.data;
const isWhite = (i) => d[i] > 255 - TOL && d[i + 1] > 255 - TOL && d[i + 2] > 255 - TOL;

// 1) 四边泛洪去白底：只吃与画布边缘连通的背景，被深色描边包住的奶油高光保留
const seen = new Uint8Array(W * H); const stack = [];
for (let x = 0; x < W; x++) stack.push(x, 0, x, H - 1);
for (let y = 0; y < H; y++) stack.push(0, y, W - 1, y);
while (stack.length) {
  const y = stack.pop(), x = stack.pop();
  if (x < 0 || y < 0 || x >= W || y >= H) continue;
  const p = y * W + x;
  if (seen[p] || !isWhite(p * 4)) continue;
  seen[p] = 1;
  d[p * 4 + 3] = 0;
  stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
}
g.putImageData(im, 0, 0);

// 2) 缩到方形 + 圆形 alpha（1.2px 过渡带抗锯齿）
const out = createCanvas(SIZE, SIZE); const o = out.getContext('2d');
o.imageSmoothingQuality = 'high';
o.drawImage(c, 0, 0, SIZE, SIZE);
o.globalCompositeOperation = 'destination-in';
const grad = o.createRadialGradient(SIZE / 2, SIZE / 2, SIZE / 2 - 1.2, SIZE / 2, SIZE / 2, SIZE / 2);
grad.addColorStop(0, 'rgba(0,0,0,1)');
grad.addColorStop(1, 'rgba(0,0,0,0)');
o.fillStyle = grad;
o.beginPath(); o.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2); o.fill();
o.globalCompositeOperation = 'source-over';

fs.writeFileSync(OUT, out.toBuffer('image/png'));
console.log(`→ ${OUT} ${SIZE}x${SIZE}`);
