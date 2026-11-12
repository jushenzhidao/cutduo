import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import fs from 'node:fs';
GlobalFonts.registerFromPath('assets/fonts/NotoSansSC-Medium.otf','NotoSC Medium');
const jobs = [
  ['Skia 复刻 · 8.6s 出片', 'out/final9/lab-a.png'],
  ['motion-kit 原片 · 274s 出片', 'out/final9/lab-b.png'],
];
for (const [text, out] of jobs) {
  const c = createCanvas(600, 70), g = c.getContext('2d');
  g.font = '500 26px "NotoSC Medium"';
  const w = g.measureText(text).width + 28;
  g.beginPath(); g.roundRect(0, 0, w, 46, 8); g.fillStyle = 'rgba(0,0,0,0.58)'; g.fill();
  g.fillStyle = '#FFFFFF'; g.fillText(text, 14, 33);
  fs.writeFileSync(out, c.toBuffer('image/png'));
  console.log(out, Math.round(w));
}
