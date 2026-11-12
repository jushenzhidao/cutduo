// 单帧成本分解：绘制 / 取帧 / 编码器对比（单进程，反映 1 核能力）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { createDesktopRenderer } from '../desktop-kit/desktop.mjs';

// 本脚本在 motiongit-lab/bench/ 下 ⇒ ROOT 恒为本仓 motiongit-lab/，不写死绝对路径
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

const fontDir = `${ROOT}/assets/fonts`;
for (const f of fs.readdirSync(fontDir)) {
  if (/\.(otf|ttf)$/i.test(f)) GlobalFonts.registerFromPath(`${fontDir}/${f}`);
}

const P = JSON.parse(fs.readFileSync(`${ROOT}/content/hotpot.json`, 'utf8'));
const W = P.width || 1440, H = P.height || 1080;
const canvas = createCanvas(W, H);
const r = createDesktopRenderer({ ctx: canvas.getContext('2d') });
r.setContent({ shots: P.shots, captions: P.captions, chapters: P.chapters, brand: P.brand });

let t0 = performance.now();
const N_DRAW = 40;
for (let i = 0; i < N_DRAW; i++) r.renderFrame(5 + i * 0.016);
const drawMs = (performance.now() - t0) / N_DRAW;

// 必须预热：首次调用含 surface 分配，连续分配 6MB 会触发 GC 抖动
let buf;
for (let i = 0; i < 6; i++) buf = canvas.data();
t0 = performance.now();
for (let i = 0; i < 30; i++) buf = canvas.data();
const dataMs = (performance.now() - t0) / 30;
let gid;
for (let i = 0; i < 6; i++) gid = canvas.getContext('2d').getImageData(0, 0, W, H);
t0 = performance.now();
for (let i = 0; i < 30; i++) gid = canvas.getContext('2d').getImageData(0, 0, W, H);
const gidMs = (performance.now() - t0) / 30;

console.log(`画布 ${W}x${H}`);
console.log(`绘制        ${drawMs.toFixed(2)} ms/帧`);
console.log(`取帧 data() ${dataMs.toFixed(2)} ms/帧  (${(buf.length / 1048576).toFixed(2)} MB)`);
console.log(`取帧 gid()  ${gidMs.toFixed(2)} ms/帧`);
console.log('');

async function enc(label, args, N) {
  const out = `/tmp/enc-${label}.mp4`;
  const ff = spawn('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-framerate', '60', '-i', 'pipe:0',
    ...args, out], { stdio: ['pipe', 'ignore', 'inherit'] });
  const t = performance.now();
  for (let i = 0; i < N; i++) {
    if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  await once(ff, 'exit');
  const ms = (performance.now() - t) / N;
  const mb = fs.statSync(out).size / 1048576;
  console.log(`${label.padEnd(24)} ${ms.toFixed(2)} ms/帧  ${(1000 / ms).toFixed(1)} fps  ${mb.toFixed(2)} MB`);
  fs.rmSync(out, { force: true });
}

await enc('x264 vf 线程默认', ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'], 120);
await enc('x264 vf threads 1', ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-threads', '1'], 120);
await enc('x264 uf threads 1', ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-threads', '1'], 120);
await enc('videotoolbox h264 6M', ['-c:v', 'h264_videotoolbox', '-b:v', '6M', '-pix_fmt', 'yuv420p'], 120);
await enc('videotoolbox hevc 4M', ['-c:v', 'hevc_videotoolbox', '-b:v', '4M', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1'], 120);
