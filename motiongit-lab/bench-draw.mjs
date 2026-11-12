import { createCanvas } from '@napi-rs/canvas';
import { createPaperRenderer, registerFonts } from '/Users/macstudio/WorkBuddy/2026-11-08-21-08-09/skia-kit/paper.mjs';
import fs from 'node:fs';
const P = JSON.parse(fs.readFileSync('/Users/macstudio/WorkBuddy/2026-11-08-21-08-09/motiongit-lab/edits/inputs-md.json','utf8'));
registerFonts('/Users/macstudio/WorkBuddy/2026-11-08-21-08-09/motiongit-lab/assets/fonts');
const canvas = createCanvas(1920,1080);
const r = createPaperRenderer({ ctx: canvas.getContext('2d'), palette: { bg:'#FAFAF7', ink:'#111214', accent:'#2462EA', body:'#4C5150', label:'#7A807C', bar:'rgba(17,18,20,0.88)', ring:'rgba(36,98,234,0.22)', hair:'rgba(0,0,0,0.08)' } });
r.setContent({ scenes: P.scenes, captions: P.captions, avatar: null });
const N = 400;
// 1) 只画
let t0 = performance.now();
for (let i=0;i<N;i++) r.renderFrame(i/60);
let t1 = performance.now();
// 2) 画 + JPEG
for (let i=0;i<N;i++){ r.renderFrame(i/60); canvas.toBuffer('image/jpeg', 94); }
let t2 = performance.now();
// 3) 画 + PNG
for (let i=0;i<N;i++){ r.renderFrame(i/60); canvas.toBuffer('image/png'); }
let t3 = performance.now();
console.log(JSON.stringify({
  draw_ms:(t1-t0)/N, jpeg_ms:(t2-t1)/N, png_ms:(t3-t2)/N,
}, null, 1));
