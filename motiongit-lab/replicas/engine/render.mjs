#!/usr/bin/env node
/**
 * 统一复刻出片 CLI（Skia + worker 并行 + mpegts concat，无浏览器）
 *
 *   node replicas/engine/render.mjs --spec replicas/specs/<slug>.spec.json \
 *     --out replicas/out/<slug>/replica.mp4 [--workers 8] [--probe <png> --at 3.0]
 *
 * 与参考片等时长 / 等画幅 / 等帧率，便于同一时间点一一对比。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createCanvas } from '@napi-rs/canvas';
import { createReplicaRenderer, registerFonts } from './replica.mjs';

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const MGLAB = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const FONTDIR = path.join(MGLAB, 'assets', 'fonts');

function get(k, d) { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }
const A = {
  spec: path.resolve(get('spec', '')),
  out: path.resolve(get('out', 'replicas/out/replica.mp4')),
  workers: Math.max(1, Number(get('workers', Math.min(8, os.cpus().length)))),
  crf: String(get('crf', 20)),
  jpeg: Number(get('jpeg', 92)),
  preset: get('preset', 'veryfast'),
  probe: get('probe', null),
  at: Number(get('at', 3.0)),
};

function loadSpec(p) {
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  s.meta.frames = Math.round(s.meta.duration * s.meta.fps);
  return s;
}

if (!isMainThread) {
  const { start, end, part, specPath, crf, jpeg, preset, fps } = workerData;
  const spec = loadSpec(specPath);
  const canvas = createCanvas(spec.meta.width, spec.meta.height);
  const r = createReplicaRenderer({ ctx: canvas.getContext('2d'), spec, fontDir: FONTDIR });
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', preset, '-crf', crf, '-pix_fmt', 'yuv420p',
    '-f', 'mpegts', part], { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = once(ff, 'close');
  for (let f = start; f < end; f++) {
    r.renderFrame(f);
    const buf = canvas.toBuffer('image/jpeg', jpeg);
    if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  const [code] = await done;
  if (code !== 0) throw new Error('ffmpeg exit ' + code);
  parentPort.postMessage({ ok: true, frames: end - start, fonts: r.registered,
    segments: r.segmentCount, fingerprint: r.specFingerprint });
} else {
  const t0 = Date.now();
  const spec = loadSpec(A.spec);
  registerFonts(FONTDIR);
  const W = spec.meta.width, H = spec.meta.height, FPS = spec.meta.fps;

  if (A.probe) {
    const canvas = createCanvas(W, H);
    const r = createReplicaRenderer({ ctx: canvas.getContext('2d'), spec, fontDir: FONTDIR });
    r.renderFrame(Math.round(A.at * FPS));
    fs.mkdirSync(path.dirname(path.resolve(A.probe)), { recursive: true });
    fs.writeFileSync(path.resolve(A.probe), canvas.toBuffer('image/png'));
    console.log(`probe → ${A.probe}  ${spec.meta.frames} 帧 / ${W}x${H} @${FPS}fps / 段 ${r.segmentCount} / 字体 ${r.registered}`);
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(A.out), { recursive: true });
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'replica-kit-'));
  const per = Math.ceil(spec.meta.frames / A.workers);
  const segs = [];
  for (let i = 0; i < A.workers; i++) {
    const s = i * per, e = Math.min(spec.meta.frames, s + per);
    if (s < e) segs.push({ s, e, part: path.join(TMP, `seg-${i}.ts`) });
  }
  const reports = await Promise.all(segs.map((seg) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { start: seg.s, end: seg.e, part: seg.part, specPath: A.spec,
        fps: FPS, crf: A.crf, jpeg: A.jpeg, preset: A.preset },
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
  const dur = (spec.meta.frames / FPS).toFixed(3);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent,
    '-c', 'copy', '-t', dur, '-movflags', '+faststart', A.out]);
  fs.rmSync(TMP, { recursive: true, force: true });
  const size = (fs.statSync(A.out).size / 1048576).toFixed(2);
  console.log(`✓ ${A.out}`);
  console.log(`  ${spec.meta.frames} 帧 / ${dur}s / ${FPS}fps / ${W}x${H} / ${size}MB / ${((Date.now() - t0) / 1000).toFixed(1)}s / ${A.workers} workers / 段${reports[0].segments} / 字体${reports[0].fonts}`);
}
