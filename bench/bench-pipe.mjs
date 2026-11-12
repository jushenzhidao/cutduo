// 管道 A/B：JPEG 中间帧 vs 原始 RGBA 直供 ffmpeg
// 目的：定位 2783 帧里真正的成本，并选出最快的一条。
// 用法：node bench-pipe.mjs [frames]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCanvas } from '@napi-rs/canvas';
import { createPaperRenderer, registerFonts } from '../skia-kit/paper.mjs';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const ROOT = path.resolve('.');
const P = JSON.parse(fs.readFileSync(path.join(ROOT, 'edits/inputs-md.json'), 'utf8'));
const N = Number(process.argv[2] || 300);
const PALETTE = { bg: '#FAFAF7', ink: '#111214', accent: '#2462EA', body: '#4C5150', label: '#7A807C', bar: 'rgba(17,18,20,0.88)', ring: 'rgba(36,98,234,0.22)', hair: 'rgba(0,0,0,0.08)' };

registerFonts(path.join(ROOT, 'assets/fonts'));
const canvas = createCanvas(1920, 1080);
const r = createPaperRenderer({ ctx: canvas.getContext('2d'), palette: PALETTE });
r.setContent({ scenes: P.scenes, captions: P.captions, avatar: null });

const W = 1920, H = 1080, FPS = 60;

async function run(mode) {
  const out = `/tmp/pipe-${mode}.mp4`;
  const args = mode === 'jpeg'
    ? ['-f', 'image2pipe', '-framerate', String(FPS), '-vcodec', 'mjpeg', '-i', 'pipe:0']
    : ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-framerate', String(FPS), '-i', 'pipe:0'];
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out], { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = once(ff, 'close');
  const t0 = performance.now();
  for (let f = 0; f < N; f++) {
    r.renderFrame(f / FPS);
    const buf = mode === 'jpeg' ? canvas.toBuffer('image/jpeg', 92) : canvas.data();
    if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  const [code] = await done;
  const secs = (performance.now() - t0) / 1000;
  if (code !== 0) throw new Error(`ffmpeg ${mode} exit ${code}`);
  return { mode, frames: N, secs: +secs.toFixed(2), ms_per_frame: +((secs * 1000) / N).toFixed(2), fps: +(N / secs).toFixed(1), bytes: fs.statSync(out).size };
}

const results = [];
for (const m of ['jpeg', 'raw', 'jpeg', 'raw']) results.push(await run(m));
console.log(JSON.stringify(results, null, 2));
