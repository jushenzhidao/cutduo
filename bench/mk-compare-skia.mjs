// 三版对比：skia v1（纸色+头像卡） / skia v2（白底无出镜） / editorial（Playwright）
// 每行两帧：2.8s 开场、19.5s 对比版式
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
import fs from 'node:fs';

GlobalFonts.registerFromPath('/Library/Fonts/Arial Unicode.ttf', 'AU');

const rows = [
  { label: 'skia-kit v1 · 纸色 + 头像卡（复刻原样）', color: '#B4553F', files: ['/tmp/skia-028.jpg', '/tmp/skia-195.jpg'] },
  { label: 'skia-kit v2 · 白底 + 本章关键词卡（--theme clean --avatar off）', color: '#2462EA', files: ['/tmp/nc-2.8.jpg', '/tmp/nc-19.5.jpg'] },
  { label: '自有 editorial 模板 · Playwright/Chromium', color: '#1F8A70', files: ['/tmp/cmp/09.jpg', '/tmp/cmp/10.jpg'] },
];
const cols = ['2.8s', '19.5s'];

const CW = 760, CH = 428;
const canvas = createCanvas(CW * 2, CH * rows.length);
const g = canvas.getContext('2d');
g.fillStyle = '#101010'; g.fillRect(0, 0, CW * 2, CH * rows.length);

for (let r = 0; r < rows.length; r++) {
  for (let c = 0; c < 2; c++) {
    const img = await loadImage(rows[r].files[c]);
    const s = Math.min(CW / img.width, CH / img.height);
    g.drawImage(img, c * CW + (CW - img.width * s) / 2, r * CH + (CH - img.height * s) / 2, img.width * s, img.height * s);
  }
}

for (let r = 0; r < rows.length; r++) {
  const { label, color } = rows[r];
  g.font = '600 24px AU';
  const tw = g.measureText(label).width;
  g.fillStyle = color;
  g.beginPath(); g.roundRect(14, r * CH + 12, tw + 24, 38, 7); g.fill();
  g.fillStyle = '#fff'; g.textBaseline = 'middle';
  g.fillText(label, 26, r * CH + 32);
}
for (let c = 0; c < 2; c++) {
  g.font = '500 21px AU';
  const tw = g.measureText(cols[c]).width;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.beginPath(); g.roundRect(c * CW + CW - tw - 28, 12, tw + 18, 32, 6); g.fill();
  g.fillStyle = '#fff'; g.textBaseline = 'middle';
  g.fillText(cols[c], c * CW + CW - tw - 19, 29);
}

fs.writeFileSync('/tmp/skia-v1v2.jpg', canvas.toBuffer('image/jpeg', 90));
console.log('ok');
