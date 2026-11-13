#!/usr/bin/env node
/**
 * bench/bbox-compare.mjs · 量两张同尺寸截图里「高亮内容」的包围盒，用来对版式
 *
 *   node bench/bbox-compare.mjs <参考.png> <复刻.png> [x0 x1 y0 y1] [亮度阈值]
 *
 * 为什么需要它：版式对不对不能靠肉眼。把字标/标题的包围盒量出来，
 * 宽高差几个像素是客观的；顺带能看到「同宽但更高」这类字号错配（说明字族不对，不是字号不对）。
 */
import { loadImage, createCanvas } from '@napi-rs/canvas';

async function bbox(file, box, thr) {
  const img = await loadImage(file);
  const c = createCanvas(img.width, img.height);
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, img.width, img.height).data;
  const [x0, x1, y0, y1] = box;
  let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
  for (let yy = y0; yy < Math.min(y1, img.height); yy++) {
    for (let xx = x0; xx < Math.min(x1, img.width); xx++) {
      const i = (yy * img.width + xx) * 4;
      if ((d[i] + d[i + 1] + d[i + 2]) / 3 > thr) {
        if (xx < minX) minX = xx;
        if (xx > maxX) maxX = xx;
        if (yy < minY) minY = yy;
        if (yy > maxY) maxY = yy;
      }
    }
  }
  return { x: [minX, maxX], y: [minY, maxY], w: maxX - minX, h: maxY - minY };
}

const [a, b, ...rest] = process.argv.slice(2);
if (!a || !b) {
  console.error('用法：node bench/bbox-compare.mjs <参考.png> <复刻.png> [x0 x1 y0 y1] [阈值]');
  process.exit(1);
}
const nums = rest.map(Number);
const box = nums.length >= 4 ? nums.slice(0, 4) : [0, 1920, 0, 1080];
const thr = nums.length >= 5 ? nums[4] : 90;

const A = await bbox(a, box, thr);
const B = await bbox(b, box, thr);
console.log('参考 ', JSON.stringify(A));
console.log('复刻 ', JSON.stringify(B));
console.log(`差   w ${B.w - A.w}px  h ${B.h - A.h}px  x0 ${B.x[0] - A.x[0]}px  y0 ${B.y[0] - A.y[0]}px`);
