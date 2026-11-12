#!/usr/bin/env node
/**
 * v2 出片 CLI：颜色场 + OCR 文字层 → 与参考片等时长/等画幅/等帧率的 MP4。
 *   node replicas/engine/v2/render2.mjs --slug motiongit-promo-ink \
 *     --out replicas/out/<slug>/replica-v2.mp4 [--workers 8] [--probe <png> --at 3.0]
 *
 * 注意：worker 线程的 process.argv 不含主进程 CLI 参数，slug 必须经 workerData 传递。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createCanvas } from '@napi-rs/canvas';
import { createV2Renderer, registerV2Fonts } from './replica2.mjs';

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const MGLAB = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..');
const FONTDIR = path.join(MGLAB, 'assets', 'fonts');
const SPECS2 = path.join(MGLAB, 'replicas', 'specs2');

function get(k, d) { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; }

function load(slug) {
  const dir = path.join(SPECS2, slug);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const keys = JSON.parse(fs.readFileSync(path.join(dir, 'keyframes.json'), 'utf8'));
  meta.frames = Math.round(meta.duration * meta.fps);
  return { meta, keys, fieldDir: path.join(dir, 'field') };
}

if (!isMainThread) {
  const { start, end, part, crf, jpeg, preset, fps, slug } = workerData;
  const { meta, keys, fieldDir } = load(slug);
  registerV2Fonts(FONTDIR);
  const canvas = createCanvas(meta.width, meta.height);
  const r = await createV2Renderer({ ctx: canvas.getContext('2d'), meta, keys, fieldDir });
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
  parentPort.postMessage({ ok: true, frames: end - start, fields: r.fieldCount });
} else {
  const A = {
    slug: get('slug', ''),
    out: path.resolve(get('out', '')),
    workers: Math.max(1, Number(get('workers', Math.min(8, os.cpus().length)))),
    crf: String(get('crf', 20)),
    jpeg: Number(get('jpeg', 92)),
    preset: get('preset', 'veryfast'),
    probe: get('probe', null),
    at: Number(get('at', 3.0)),
  };
  if (!A.slug) { console.error('需要 --slug'); process.exit(2); }
  const { meta, keys, fieldDir } = load(A.slug);
  const t0 = Date.now();
  registerV2Fonts(FONTDIR);
  const W = meta.width, H = meta.height, FPS = meta.fps;

  if (A.probe) {
    const canvas = createCanvas(W, H);
    const r = await createV2Renderer({ ctx: canvas.getContext('2d'), meta, keys, fieldDir });
    r.renderFrame(Math.round(A.at * FPS));
    fs.mkdirSync(path.dirname(path.resolve(A.probe)), { recursive: true });
    fs.writeFileSync(path.resolve(A.probe), canvas.toBuffer('image/png'));
    console.log(`probe → ${A.probe}  ${meta.frames} 帧 / ${W}x${H} @${FPS}fps / 场 ${r.fieldCount}`);
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(A.out), { recursive: true });
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'replica-v2-'));
  const per = Math.ceil(meta.frames / A.workers);
  const segs = [];
  for (let i = 0; i < A.workers; i++) {
    const s = i * per, e = Math.min(meta.frames, s + per);
    if (s < e) segs.push({ s, e, part: path.join(TMP, `seg-${i}.ts`) });
  }
  const reports = await Promise.all(segs.map((seg) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { start: seg.s, end: seg.e, part: seg.part, slug: A.slug,
        fps: FPS, crf: A.crf, jpeg: A.jpeg, preset: A.preset },
      resourceLimits: { maxOldGenerationSizeMb: 1024 },
    });
    w.once('message', (m) => (m && m.ok ? resolve(m) : reject(new Error(m && m.error))));
    w.once('error', reject);
    w.once('exit', (c) => { if (c !== 0) reject(new Error('worker exit ' + c)); });
  })));
  const list = path.join(TMP, 'list.txt');
  fs.writeFileSync(list, segs.map((s) => `file '${s.part}'`).join('\n'));
  const silent = path.join(TMP, 'silent.mp4');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent]);
  const dur = (meta.frames / FPS).toFixed(3);
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent,
    '-c', 'copy', '-t', dur, '-movflags', '+faststart', A.out]);
  fs.rmSync(TMP, { recursive: true, force: true });
  const size = (fs.statSync(A.out).size / 1048576).toFixed(2);
  console.log(`✓ ${A.out}  ${meta.frames} 帧 / ${dur}s / ${W}x${H} / ${size}MB / ` +
    `${((Date.now() - t0) / 1000).toFixed(1)}s / 场${reports[0].fields}`);
}
