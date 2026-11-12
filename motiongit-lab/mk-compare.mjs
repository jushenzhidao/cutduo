// 四条管线同点对比图：film-kit / skia-kit / playwright+chromium / cinecode
// 用法：node mk-compare.mjs   （需要 /tmp/cmp/00..11.jpg，由 ffmpeg 在 2.8 / 19.5 / 43.5 秒各抽一帧）
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import fs from 'node:fs';

GlobalFonts.registerFromPath('/Library/Fonts/Arial Unicode.ttf', 'AU');

const rows = [
  { label: 'film-kit 官方模板', color: '#E0453C', base: 0 },
  { label: 'skia-kit · Skia 直出', color: '#2462EA', base: 3 },
  { label: '自有模板 + Playwright/Chromium', color: '#1F8A70', base: 9 },
  { label: 'cinecode', color: '#6B57C8', base: 6 },
];
const cols = ['2.8s', '19.5s', '43.5s'];
const CW = 600, CH = 450;

const W = CW * 3, H = CH * rows.length;
const canvas = createCanvas(W, H);
const g = canvas.getContext('2d');
g.fillStyle = '#101010'; g.fillRect(0, 0, W, H);

for (let r = 0; r < rows.length; r++) {
  for (let c = 0; c < 3; c++) {
    const img = await loadImage(`/tmp/cmp/${String(rows[r].base + c).padStart(2, '0')}.jpg`);
    const s = Math.min(CW / img.width, CH / img.height);
    const w = img.width * s, h = img.height * s;
    g.drawImage(img, c * CW + (CW - w) / 2, r * CH + (CH - h) / 2, w, h);
  }
}

for (let r = 0; r < rows.length; r++) {
  const { label, color } = rows[r];
  g.font = '600 26px AU';
  const tw = g.measureText(label).width;
  g.fillStyle = color;
  g.beginPath(); g.roundRect(14, r * CH + 12, tw + 26, 40, 7); g.fill();
  g.fillStyle = '#fff'; g.textBaseline = 'middle';
  g.fillText(label, 27, r * CH + 33);
}
for (let c = 0; c < 3; c++) {
  g.font = '500 22px AU';
  const tw = g.measureText(cols[c]).width;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.beginPath(); g.roundRect(c * CW + CW - tw - 30, 12, tw + 20, 34, 6); g.fill();
  g.fillStyle = '#fff'; g.textBaseline = 'middle';
  g.fillText(cols[c], c * CW + CW - tw - 20, 30);
}

fs.writeFileSync('/tmp/cmp/compare4.jpg', canvas.toBuffer('image/jpeg', 90));
console.log('ok /tmp/cmp/compare4.jpg');
