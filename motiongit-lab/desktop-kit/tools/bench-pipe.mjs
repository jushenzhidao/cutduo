#!/usr/bin/env node
/**
 * 端到端管道对照：JPEG image2pipe（现状） vs raw RGBA rawvideo。
 * 微基准显示 JPEG 28ms、raw 23.7ms，但 raw 每帧 6MB（21× 数据量）；
 * 只有端到端实测才能判断管道 I/O 会不会把省下的 4ms 吃掉。
 *
 *   node desktop-kit/tools/bench-pipe.mjs [--frames 300]
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCanvas } from '@napi-rs/canvas';
import { createDesktopRenderer, registerFonts, loadTokens } from '../desktop.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const KIT = path.resolve(HERE, '..');
const ROOT = path.resolve(KIT, '..');
const FFMPEG = '/opt/homebrew/bin/ffmpeg';
const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const N = Number(get('frames', 300));
const T = loadTokens(), W = T.width, H = T.height, FPS = 60;

registerFonts(path.join(ROOT, 'assets', 'fonts'));
const P = JSON.parse(fs.readFileSync(path.join(KIT, 'presets', 'md.json'), 'utf8'));

async function run(mode) {
  const out = path.join(ROOT, 'out', `bench-pipe-${mode}.mp4`);
  const ffArgs = mode === 'raw'
    ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-framerate', String(FPS), '-i', 'pipe:0']
    : ['-f', 'image2pipe', '-framerate', String(FPS), '-i', 'pipe:0'];
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...ffArgs,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', out],
    { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = once(ff, 'close');
  const canvas = createCanvas(W, H), g = canvas.getContext('2d');
  const r = createDesktopRenderer({ ctx: g });
  r.setContent(P);
  const t0 = performance.now();
  let bytes = 0, drawMs = 0, encMs = 0;
  for (let f = 0; f < N; f++) {
    const a = performance.now();
    r.renderFrame((f / FPS) % P.durationSeconds);
    const b = performance.now();
    let buf;
    if (mode === 'raw') {
      const d = g.getImageData(0, 0, W, H).data;   // 只取一次，避免 6MB 重复拷贝
      buf = Buffer.from(d.buffer, d.byteOffset, W * H * 4);
    } else {
      buf = canvas.toBuffer('image/jpeg', 94);
    }
    const c = performance.now();
    drawMs += b - a; encMs += c - b; bytes += buf.length;
    if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  const [code] = await done;
  if (code !== 0) throw new Error('ffmpeg exit ' + code);
  const wall = performance.now() - t0;
  const size = fs.statSync(out).size;
  return { mode, wall, drawMs, encMs, bytes, size, out,
    fps: N / (wall / 1000) };
}

const rows = [];
for (const m of ['jpeg', 'raw']) rows.push(await run(m));
console.log(`帧数 ${N}  ${W}x${H}@${FPS}`);
for (const r of rows) {
  console.log(`${r.mode.padEnd(5)} 墙钟 ${(r.wall / 1000).toFixed(2)}s  ${r.fps.toFixed(1)} fps  ` +
    `绘制 ${(r.drawMs / N).toFixed(2)}ms/帧  取帧 ${(r.encMs / N).toFixed(2)}ms/帧  ` +
    `管道 ${(r.bytes / 1048576).toFixed(1)}MB  成片 ${(r.size / 1048576).toFixed(2)}MB`);
}
const [a, b] = rows;
console.log(`\nraw 相对 jpeg：${(a.wall / b.wall).toFixed(2)}× 速度，管道数据量 ${(b.bytes / a.bytes).toFixed(1)}×`);
const json = get('json', null);
if (json) fs.writeFileSync(path.resolve(json), JSON.stringify({
  meta: { frames: N, width: W, height: H, fps: FPS },
  rows: rows.map((r) => ({ mode: r.mode, wallS: Number((r.wall / 1000).toFixed(2)),
    fps: Number(r.fps.toFixed(1)), drawMs: Number((r.drawMs / N).toFixed(2)),
    encodeMs: Number((r.encMs / N).toFixed(2)), pipeMB: Number((r.bytes / 1048576).toFixed(1)),
    sizeMB: Number((r.size / 1048576).toFixed(2)) })),
}, null, 2));
