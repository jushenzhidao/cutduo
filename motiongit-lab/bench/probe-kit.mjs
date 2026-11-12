// 抽帧检查：把 inputs-<prefix>.json 里每个分镜的中点渲成 PNG
import fs from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createPaperRenderer, registerFonts } from '../skia-kit/paper.mjs';

const params = process.argv[2] || 'edits/inputs-kit.json';
const outDir = process.argv[3] || 'out/probe-kit';
const P = JSON.parse(fs.readFileSync(params, 'utf8'));
registerFonts('assets/fonts');
const avatar = fs.existsSync('edits/assets/avatar.png') ? await loadImage('edits/assets/avatar.png') : null;
fs.mkdirSync(outDir, { recursive: true });
const canvas = createCanvas(1920, 1080);
const r = createPaperRenderer({ ctx: canvas.getContext('2d') });
r.setContent({ scenes: P.scenes, captions: P.captions, avatar });
P.scenes.forEach((s, i) => {
  const t = s.t0 + (s.t1 - s.t0) * 0.62;
  r.renderFrame(t);
  const f = `${outDir}/${String(i + 1).padStart(2, '0')}-${s.type}.png`;
  fs.writeFileSync(f, canvas.toBuffer('image/png'));
  console.log(f, t.toFixed(2) + 's');
});
