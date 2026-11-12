#!/usr/bin/env node
/**
 * 口型层最小样片：把嘴部贴片按 preset 里的 mouthCurve 逐帧换掉，出 1080p 对比片。
 * 只证明「在成片尺寸下能不能读作说话」，不参与模板合成（不动 layouts.js）。
 *
 *   node tools/mouth-demo.mjs --preset templates/own/science-explainer/presets/demo.edge.json \
 *     --out out/mouth-demo-lip.mp4 --at 8 --sec 5
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCanvas, loadImage, GlobalFonts } from '@napi-rs/canvas';
GlobalFonts.registerFromPath('assets/fonts/NotoSansSC-Medium.otf', 'NotoSC');

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PRESET = get('preset', 'templates/own/science-explainer/presets/demo.edge.json');
const OUT = get('out', 'out/mouth-demo-lip.mp4');
const AT = Number(get('at', 8));
const SEC = Number(get('sec', 5));
const FPS = Number(get('fps', 30));
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';

const P = JSON.parse(fs.readFileSync(PRESET, 'utf8'));
const curve = P.mouthCurve || [];
const FIG = await loadImage('/tmp/fig_raw_rgba.png');
const PATCH = [0, 1, 2, 3].map((i) => null);
for (let i = 0; i < 4; i++) PATCH[i] = await loadImage('templates/own/science-explainer/assets/figures/mouth' + i + '.png');

// raw 空间：人物 alpha bbox 565×995，按 bbox 高放到 994（≈1:1），右侧站位，底部沉出 92px
const BB = { x: 161, y: 133, w: 565, h: 995 };          // alpha 包围盒
const FH = 994, SC = FH / BB.h;
const FY = 1080 + 92 - FH;                              // 头顶位置
const FX = 1382 - (BB.x + BB.w / 2) * SC;               // 人物中心落在 0.72W
const MOUTH = { x: 345, y: 423, w: 132, h: 90 };    // raw 坐标：唇部 + 留边

const canvas = createCanvas(1920, 1080);
const ctx = canvas.getContext('2d');
const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'image2pipe', '-framerate', String(FPS), '-i', 'pipe:0',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', OUT], { stdio: ['pipe', 'ignore', 'inherit'] });
const done = once(ff, 'close');

const n = Math.round(SEC * FPS);
let last = 0;
for (let f = 0; f < n; f++) {
  const gi = Math.round(AT * FPS) + f;                  // 曲线索引（30fps）
  const v = curve[gi] ?? 0;
  const lvl = Math.min(3, Math.round(v * 3.2));         // 0 闭 .. 3 大张
  last = lvl;
  ctx.fillStyle = '#E9F3EE';
  ctx.fillRect(0, 0, 1920, 1080);
  ctx.drawImage(FIG, FX, FY - BB.y * SC, FIG.width * SC, FIG.height * SC);
  const p = PATCH[lvl];
  // 与人物同一起点：人物按 bbox 顶部对齐，贴片也要减掉 BB.y*SC
  ctx.drawImage(p, FX + MOUTH.x * SC, FY - BB.y * SC + MOUTH.y * SC, MOUTH.w * SC, MOUTH.h * SC);
  // 左上角显示当前开口级，便于核对驱动是否正确
  ctx.font = '500 34px NotoSC, sans-serif';
  ctx.fillStyle = 'rgba(20,40,30,0.55)';
  ctx.fillText(`口型级 ${lvl} / 3   曲线 ${v.toFixed(2)}`, 80, 90);
  if (!ff.stdin.write(canvas.toBuffer('image/jpeg', 92))) await once(ff.stdin, 'drain');
}
ff.stdin.end();
const [code] = await done;
if (code !== 0) throw new Error('ffmpeg exit ' + code);
console.log(`✓ ${OUT}  ${n} 帧 / ${SEC}s / ${FPS}fps  末级 ${last}`);
