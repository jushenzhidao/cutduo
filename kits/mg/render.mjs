#!/usr/bin/env node
/**
 * mg-kit · 一条命令出片（纯 Skia，无浏览器）
 *
 *   node kits/mg/render.mjs --params kits/mg/params.json --out kits/mg/out/mg-demo.mp4
 *   node kits/mg/render.mjs --params kits/mg/params.json --probe out/mg-t12.png --at 12.4
 *
 * 沿用 skia-kit 的并行分片：N 个 worker 各渲染一段帧区间 → image2pipe JPEG
 * → libx264 → mpegts → concat copy → mp4。scene 是纯函数，分片边界无接缝。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { planShards, partArgs, pumpFrames, spawnPart, concatParts, report } from '../../src/pipeline.mjs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createCanvas } from '@napi-rs/canvas';
import { registerFonts } from '../../src/fonts.mjs';
import { REPO_ROOT } from '../../src/root.mjs';
import { createMGRenderer } from './scenes.mjs';

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
/** 默认 worker 数：每 worker 约吃 2 核（node 进程 + ffmpeg 子进程），上限 32 下限 4。
 *  实测：30 核 M5 用 16 最快（5.6s vs 8 worker 6.7s）；64 核 Xeon 用 32 最快（19.4s vs 22.0s）。
 *  代价是分片变多、体积略增约 5%（mpegts 分片边界更多）。 */
function defaultWorkers() {
  return Math.min(32, Math.max(4, Math.floor(os.cpus().length / 2)));
}

function parseArgs(argv) {
  const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  return {
    params: resolveInput(get('params', 'kits/mg/params.json')),
    audio: resolveInput(get('audio', null), false),
    out: path.resolve(get('out', 'kits/mg/out/mg-demo.mp4')),
    workers: Math.max(1, Number(get('workers', defaultWorkers()))),
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
  const ff = spawnPart(partArgs({
    pipe: 'jpeg', fps: P.fps, width: W, height: H, crf, preset, jpeg, part,
  }));
  await pumpFrames({ renderer: r, canvas, fps: P.fps, start, end, ff, pipe: 'jpeg', jpeg });
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
  const segs = planShards(P.frames, A.workers, TMP);
  await Promise.all(segs.map((seg) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { start: seg.s, end: seg.e, part: seg.part, params: A.params, fps: P.fps,
        crf: A.crf, jpeg: A.jpeg, preset: A.preset },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    w.once('message', (m) => (m && m.ok ? resolve(m) : reject(new Error(m && m.error))));
    w.once('error', reject);
  })));

  concatParts({
    parts: segs.map((s) => s.part), tmpDir: TMP, out: A.out,
    audio: A.audio, fps: P.fps, frames: P.frames,
  });
  fs.rmSync(TMP, { recursive: true, force: true });
  report({ out: A.out, frames: P.frames, fps: P.fps, startedAt: t0, workers: A.workers });
}
