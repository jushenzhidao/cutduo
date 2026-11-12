// SkSL 的正确用法：shader 只用来"烘"一张颗粒 tile（一次 48ms），逐帧用原生 drawImage 平铺。
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createPaperRenderer, registerFonts } from '../skia-kit/paper.mjs';

const P = JSON.parse(fs.readFileSync('edits/inputs-md.json', 'utf8'));
registerFonts(path.join(process.cwd(), 'assets/fonts'));
const canvas = createCanvas(1920, 1080);
const ctx = canvas.getContext('2d');
const r = createPaperRenderer({ ctx, palette: { bg:'#FAFAF7', ink:'#111214', accent:'#2462EA', body:'#4C5150', label:'#7A807C', bar:'rgba(17,18,20,0.88)', ring:'rgba(36,98,234,0.22)', hair:'rgba(0,0,0,0.08)' } });
r.setContent({ scenes: P.scenes, captions: P.captions, avatar: null });

const tile = await loadImage('/tmp/grain-tile.png');
const TS = 512;
function grain() {
  ctx.save(); ctx.globalAlpha = 0.5;
  for (let y = 0; y < 1080; y += TS) for (let x = 0; x < 1920; x += TS) ctx.drawImage(tile, x, y, TS, TS);
  ctx.restore();
}
const N = 200;
r.renderFrame(19.5); ctx.getImageData(0,0,1,1);
let t0 = performance.now(); for (let i=0;i<N;i++) r.renderFrame(19.5); const base=(performance.now()-t0)/N;
t0 = performance.now(); for (let i=0;i<N;i++) { r.renderFrame(19.5); grain(); } const withG=(performance.now()-t0)/N;
console.log(JSON.stringify({ base_ms:+base.toFixed(3), with_grain_ms:+withG.toFixed(3), grain_ms:+(withG-base).toFixed(3) },null,1));
r.renderFrame(19.5); fs.writeFileSync('/tmp/grain-off.png', canvas.toBuffer('image/png'));
r.renderFrame(19.5); grain(); fs.writeFileSync('/tmp/grain-on.png', canvas.toBuffer('image/png'));
