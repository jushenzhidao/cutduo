#!/usr/bin/env node
/**
 * mg-kit · 一条命令出片（纯 Skia，无浏览器）
 *
 *   node mg-kit/render.mjs --params mg-kit/params.json --out mg-kit/out/mg-demo.mp4
 *   node mg-kit/render.mjs --params mg-kit/params.json --probe mg-kit/out/frames/t12.png --at 12.4
 *
 * 沿用 skia-kit 的并行分片：N 个 worker 各渲染一段帧区间 → image2pipe JPEG
 * → libx264 → mpegts → concat copy → mp4。scene 是纯函数，分片边界无接缝。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createCanvas } from '@napi-rs/canvas';
import { registerFonts } from '../../src/fonts.mjs';
import { REPO_ROOT } from '../../src/root.mjs';
import { createMGRenderer } from './scenes.mjs';

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = REPO_ROOT;
const FONTS = path.join(ROOT, 'assets', 'fonts');
const W = 1920, H = 1080;

function resolveInput(p, mustExist = true) {
  if (!p) return p;
  if (path.isAbsolute(p)) return p;
  const byCwd = path.resolve(p);
  if (fs.existsSync(byCwd)) return byCwd;
  const byRoot = path.join(ROOT, p);
  if (fs.existsSync(byRoot) || !mustExist) return byRoot;
  return byCwd;
}
function parseArgs(argv) {
  const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  return {
    params: resolveInput(get('params', 'mg-kit/params.json')),
    audio: resolveInput(get('audio', null), false),
    out: path.resolve(get('out', 'mg-kit/out/mg-demo.mp4')),
    workers: Math.max(1, Number(get('workers', Math.min(8, os.cpus().length)))),
    fps: get('fps', null),
    crf: String(get('crf', 20)),
    jpeg: Number(get('jpeg', 94)),
    preset: get('preset', 'veryfast'),
    probe: get('probe', null),
    at: Number(get('at', 2.5)),
  };
}
const A = parseArgs(process.argv.slice(2));

function loadParams(file, fpsOverride) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!d.scenes || !d.scenes.length) throw new Error('params 里没有 scenes');
  const fps = Number(fpsOverride || d.fps || 60);
  const duration = d.durationSeconds || d.scenes[d.scenes.length - 1].t1;
  return { ...d, fps, durationSeconds: duration, frames: Math.round(duration * fps) };
}
function renderer(params, fps) {
  const P = loadParams(params, fps);
  const canvas = createCanvas(W, H);
  const r = createMGRenderer({ ctx: canvas.getContext('2d') });
  r.setContent({ scenes: P.scenes });
  return { P, canvas, r };
}

if (!isMainThread) {
  const { start, end, part, params, crf, jpeg, preset, fps } = workerData;
  registerFonts(FONTS);
  const { P, canvas, r } = renderer(params, fps);
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(P.fps), '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', preset, '-crf', crf, '-pix_fmt', 'yuv420p',
    '-f', 'mpegts', part], { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = once(ff, 'close');
  for (let f = start; f < end; f++) {
    r.renderFrame(f / P.fps);
    const buf = canvas.toBuffer('image/jpeg', jpeg);
    if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  const [code] = await done;
  if (code !== 0) throw new Error('ffmpeg exit ' + code);
  parentPort.postMessage({ ok: true, frames: end - start });
} else {
  const t0 = Date.now();
  registerFonts(FONTS);
  const { P, canvas, r } = renderer(A.params, A.fps);

  if (A.probe) {
    r.renderFrame(A.at);
    fs.mkdirSync(path.dirname(path.resolve(A.probe)), { recursive: true });
    fs.writeFileSync(path.resolve(A.probe), canvas.toBuffer('image/png'));
    console.log('probe →', A.probe, `${P.frames} 帧计划`, `t=${A.at}s`);
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(A.out), { recursive: true });
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-kit-'));
  const per = Math.ceil(P.frames / A.workers);
  const segs = [];
  for (let i = 0; i < A.workers; i++) {
    const s = i * per, e = Math.min(P.frames, s + per);
    if (s < e) segs.push({ i, s, e, part: path.join(TMP, `seg-${i}.ts`) });
  }
  await Promise.all(segs.map((seg) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { start: seg.s, end: seg.e, part: seg.part, params: A.params, fps: P.fps,
        crf: A.crf, jpeg: A.jpeg, preset: A.preset },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    w.once('message', (m) => (m && m.ok ? resolve(m) : reject(new Error(m && m.error))));
    w.once('error', reject);
  })));

  const list = path.join(TMP, 'list.txt');
  fs.writeFileSync(list, segs.map((s) => `file '${s.part}'`).join('\n'));
  const silent = path.join(TMP, 'silent.mp4');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent]);
  const dur = (P.frames / P.fps).toFixed(3);
  if (A.audio && fs.existsSync(A.audio)) {
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-i', silent, '-i', A.audio, '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'copy', '-t', dur, '-movflags', '+faststart', A.out]);
  } else {
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
      '-i', silent, '-c', 'copy', '-t', dur, '-movflags', '+faststart', A.out]);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  const size = (fs.statSync(A.out).size / 1048576).toFixed(2);
  console.log(`✓ ${A.out}`);
  console.log(`  ${P.frames} 帧 / ${dur}s / ${P.fps}fps / ${size}MB / ${((Date.now() - t0) / 1000).toFixed(1)}s / ${A.workers} workers`);
}
