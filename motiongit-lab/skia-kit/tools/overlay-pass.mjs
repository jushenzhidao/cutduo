#!/usr/bin/env node
/**
 * 信息层透明叠加：只画字幕条/时间码/头像卡，底透明，用于叠到生成素材上。
 *   node skia-kit/tools/overlay-pass.mjs --params <json> --frames 300 --fps 60 --out dir
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createPaperRenderer, registerFonts } from '../paper.mjs';

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PARAMS = path.resolve(get('params', 'overlay.json'));
const FRAMES = Number(get('frames', 300));
const FPS = Number(get('fps', 60));
const OUT = path.resolve(get('out', 'out/hybrid/ovl'));

registerFonts('assets/fonts');
const P = JSON.parse(fs.readFileSync(PARAMS, 'utf8'));
const avatar = fs.existsSync('edits/assets/avatar.png') ? await loadImage('edits/assets/avatar.png') : null;
fs.mkdirSync(OUT, { recursive: true });

const canvas = createCanvas(1920, 1080);
const r = createPaperRenderer({ ctx: canvas.getContext('2d'), transparentBg: true });
r.setContent({ scenes: P.scenes, captions: P.captions || [], avatar });
for (let f = 0; f < FRAMES; f++) {
  r.renderFrame(f / FPS);
  fs.writeFileSync(path.join(OUT, `${String(f).padStart(4, '0')}.png`), canvas.toBuffer('image/png'));
}
console.log(`✓ ${FRAMES} 帧 → ${OUT}`);
