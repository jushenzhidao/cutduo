#!/usr/bin/env node
/**
 * 生成式底图的可用性测量：同一帧在多个 bgWash 下，量
 *   1) 文字区底色亮度 → 与墨色/正文字的 WCAG 对比度
 *   2) 该区域亮度标准差 → 纹理还剩多少（越低越平）
 * 用法：
 *   node skia-kit/tools/bg-probe.mjs --params edits/inputs-kit.json --bg out/hybrid/plate.png \
 *     --at 3.0 --patch 900,330,260,140
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createPaperRenderer, registerFonts } from '../paper.mjs';

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PARAMS = path.resolve(get('params', 'edits/inputs-kit.json'));
const BG = get('bg', null);
const AT = Number(get('at', 3.0));
const [px, py, pw, ph] = String(get('patch', '900,330,260,140')).split(',').map(Number);

registerFonts('assets/fonts');
const P = JSON.parse(fs.readFileSync(PARAMS, 'utf8'));
const bgImg = BG && fs.existsSync(BG) ? await loadImage(BG) : null;
const avatar = fs.existsSync('edits/assets/avatar.png') ? await loadImage('edits/assets/avatar.png') : null;

const relLum = (r, g, b) => {
  const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const contrast = (a, b) => { const [x, y] = [a, b].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

function measure(wash) {
  const canvas = createCanvas(1920, 1080);
  const r = createPaperRenderer({ ctx: canvas.getContext('2d'), bgImage: bgImg, bgWash: wash });
  r.setContent({ scenes: P.scenes, captions: [], avatar: null });
  r.renderFrame(AT);
  const d = canvas.getContext('2d').getImageData(px, py, pw, ph).data;
  let sum = 0, sum2 = 0, n = 0, lr = 0, lg = 0, lb = 0;
  for (let i = 0; i < d.length; i += 4) {
    const L = relLum(d[i], d[i + 1], d[i + 2]);
    sum += L; sum2 += L * L; lr += d[i]; lg += d[i + 1]; lb += d[i + 2]; n++;
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  return { mean, std, rgb: [lr / n, lg / n, lb / n], canvas };
}

const inkL = relLum(...hex('#15231A'));
const bodyL = relLum(...hex('#5F6A5C'));

console.log(`bg-probe · ${path.basename(PARAMS)} @ ${AT}s · patch ${px},${py} ${pw}×${ph}`);
console.log('wash'.padEnd(6), '底色亮度'.padEnd(10), '纹理σ'.padEnd(9), 'vs 标题'.padEnd(9), 'vs 正文');
const rows = [];
for (const wash of [0, 0.45, 0.6, 0.72, 0.82, 0.9]) {
  const m = measure(wash);
  rows.push({ wash, m });
  console.log(
    String(wash).padEnd(6),
    m.mean.toFixed(3).padEnd(10),
    m.std.toFixed(4).padEnd(9),
    contrast(inkL, m.mean).toFixed(2).padEnd(9),
    contrast(bodyL, m.mean).toFixed(2)
  );
}
const outDir = get('out', 'out/hybrid');
fs.mkdirSync(outDir, { recursive: true });
for (const r of rows) {
  fs.writeFileSync(path.join(outDir, `wash-${String(r.wash).replace('.', '')}.png`), r.m.canvas.toBuffer('image/png'));
}
console.log(`\n帧存到 ${outDir}/wash-*.png（对比度 ≥4.5 正文达标，≥3.0 大字达标）`);
