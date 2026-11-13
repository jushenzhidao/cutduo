/**
 * bench/ink-scan.mjs · 逐帧统计"画面里有多少亮像素"，客观找空帧 / 近空帧
 *
 *   node bench/ink-scan.mjs 0 57 0.2
 *
 * 为什么需要它：`src/gate.mjs` 判的是**黑帧**（YMAX<24），而"几乎空的画面"
 * （只有背景辉光、元素还在淡入）不触发黑帧，却一样难看。这个用墨量阈值能抓到。
 * 与参考片无关，纯自家指标：< 0.35% 视为偏空。
 */
import { createCanvas } from '@napi-rs/canvas';
import { registerFonts } from '../src/fonts.mjs';
import { createCollageRenderer } from '../kits/collage/collage.mjs';
import fs from 'node:fs';
registerFonts();
const P = JSON.parse(fs.readFileSync('kits/collage/presets/cutduo.json', 'utf8'));
const cv = createCanvas(1920, 1080);
const ctx = cv.getContext('2d');
const r = createCollageRenderer({ canvas: cv, ctx, width: 1920, height: 1080, fps: 60 });
r.setContent({ scenes: P.scenes, brand: P.brand });
const t0 = Number(process.argv[2] || 0), t1 = Number(process.argv[3] || 8), step = Number(process.argv[4] || 0.1);
for (let t = t0; t <= t1; t += step) {
  r.renderFrame(t);
  const d = ctx.getImageData(0, 0, 1920, 1080).data;
  let ink = 0;
  for (let i = 0; i < d.length; i += 64) { // 每 16 像素抽样
    if ((d[i] + d[i+1] + d[i+2]) / 3 > 70) ink++;
  }
  const pct = (ink / (d.length / 64)) * 100;
  if (pct < 0.35) console.log(`t=${t.toFixed(2)} ink=${pct.toFixed(2)}%  ← 偏空`);
}
console.log('扫描完成', t0, '→', t1);
