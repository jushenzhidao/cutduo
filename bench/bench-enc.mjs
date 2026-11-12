// 只测编码器：同一帧重复推 300 次，排除绘制与 JPEG
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCanvas } from '@napi-rs/canvas';
import { createPaperRenderer, registerFonts } from '../skia-kit/paper.mjs';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const P = JSON.parse(fs.readFileSync('edits/inputs-md.json', 'utf8'));
registerFonts(path.join(process.cwd(), 'assets/fonts'));
const canvas = createCanvas(1920, 1080);
const r = createPaperRenderer({ ctx: canvas.getContext('2d') });
r.setContent({ scenes: P.scenes, captions: P.captions, avatar: null });
r.renderFrame(19.5);
const frame = canvas.data();
const N = Number(process.argv[2] || 300);

async function enc(label, codecArgs, outFile) {
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1920x1080', '-framerate', '60', '-i', 'pipe:0',
    ...codecArgs, outFile], { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = once(ff, 'close');
  const t0 = performance.now();
  for (let i = 0; i < N; i++) { if (!ff.stdin.write(frame)) await once(ff.stdin, 'drain'); }
  ff.stdin.end();
  const [code] = await done;
  const secs = (performance.now() - t0) / 1000;
  return { label, code, ms: +((secs * 1000) / N).toFixed(2), fps: +(N / secs).toFixed(1), mb: +(fs.statSync(outFile).size / 1048576).toFixed(2) };
}

const rows = [];
rows.push(await enc('x264 veryfast crf20', ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'], '/tmp/e1.mp4'));
rows.push(await enc('x264 ultrafast crf20', ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p'], '/tmp/e2.mp4'));
rows.push(await enc('x264 veryfast crf23', ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'], '/tmp/e3.mp4'));
rows.push(await enc('videotoolbox 6M', ['-c:v', 'h264_videotoolbox', '-b:v', '6M', '-pix_fmt', 'yuv420p'], '/tmp/e4.mp4'));
console.log(JSON.stringify(rows, null, 1));
