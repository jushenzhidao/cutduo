#!/usr/bin/env node
/**
 * desktop-kit · 一条命令出片（Skia，无浏览器）
 *
 *   node desktop-kit/render.mjs --params content/demo.json \
 *     --audio edits/audio-desktop.m4a --out out/desktop.mp4
 *
 * 只依赖 @napi-rs/canvas + ffmpeg。分片并行 + mpegts concat + 音轨封装。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { planShards, partArgs, pumpFrames, spawnPart, concatParts } from '../../src/pipeline.mjs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createDesktopRenderer, registerFonts, validateParams, DEFAULT_TOKENS } from './desktop.mjs';
import { REPO_ROOT } from '../../src/root.mjs';

const ROOT = REPO_ROOT;
const W = DEFAULT_TOKENS.width, H = DEFAULT_TOKENS.height;

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
    params: resolveInput(get('params', 'content/demo.json')),
    audio: resolveInput(get('audio', null), false),
    out: path.resolve(get('out', 'out/desktop.mp4')),
    workers: Math.max(1, Number(get('workers', defaultWorkers()))),
    fps: get('fps', null),
    crf: String(get('crf', 20)),
    jpeg: Number(get('jpeg', 94)),
    preset: get('preset', 'veryfast'),
    presenter: resolveInput(get('presenter', null), false),
    probe: get('probe', null),
    at: Number(get('at', 2.5)),
  };
}
const A = parseArgs(process.argv.slice(2));

function loadParams(file, fpsOverride) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateParams(d);   // 主线程与 worker 共用同一份判据，非法时间轴在出片前就失败
  const fps = Number(fpsOverride || d.fps || 60);
  const duration = d.durationSeconds || d.shots[d.shots.length - 1].t1;
  return { ...d, fps, durationSeconds: duration, frames: Math.round(duration * fps) };
}

/** 载入视频片段的预抽帧（preset.clips: key → { dir, fps }）。 */
async function loadClips(P, t0 = -1e9, t1 = 1e9) {
  const out = {};
  for (const [k, c] of Object.entries(P.clips || {})) {
    // 只加载落在本进程负责区间内的片段：每段 50 帧 × 3.7MB，8 兄弟全载会撑爆内存
    const used = (P.shots || []).some((sh) => sh.type === 'clip' && (sh.args || {}).key === k
      && sh.t1 > t0 && sh.t0 < t1);
    if (!used) continue;
    const dir = resolveInput(c.dir, false);
    if (!dir || !fs.existsSync(dir)) { console.warn(`clip "${k}" 目录缺失: ${c.dir}`); continue; }
    const files = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
    out[k] = await Promise.all(files.map((f) => loadImage(path.join(dir, f))));
  }
  return out;
}

async function loadPhotos(P) {
  const out = {};
  for (const [k, rel] of Object.entries(P.photos || {})) {
    const f = resolveInput(rel, false);
    if (f && fs.existsSync(f)) { try { out[k] = await loadImage(f); } catch { /* skip */ } }
  }
  return out;
}

async function loadPresenter(p) {
  if (!p || p === 'off' || !fs.existsSync(p)) return null;
  try { return await loadImage(p); } catch { return null; }
}

async function makeRenderer(P, presenter, start = 0, end = P.frames) {
  const canvas = createCanvas(W, H);
  const r = createDesktopRenderer({ ctx: canvas.getContext('2d') });
  r.setContent({ shots: P.shots, captions: P.captions, chapters: P.chapters, brand: P.brand, presenter,
    photos: await loadPhotos(P), clips: await loadClips(P, start / P.fps, end / P.fps) });
  return { canvas, r };
}

if (!isMainThread) {
  const { start, end, part, params, crf, jpeg, preset, fps, presenter } = workerData;
  registerFonts(path.join(ROOT, 'assets/fonts'));
  const P = loadParams(params, fps);
  const { canvas, r } = await makeRenderer(P, await loadPresenter(presenter), start, end);
  const ff = spawnPart(partArgs({
    pipe: 'jpeg', fps: P.fps, width: W, height: H, crf, preset, jpeg, part,
  }));
  await pumpFrames({ renderer: r, canvas, fps: P.fps, start, end, ff, pipe: 'jpeg', jpeg });
  parentPort.postMessage({ ok: true, frames: end - start });
} else {
  const t0 = Date.now();
  registerFonts(path.join(ROOT, 'assets/fonts'));
  const P = loadParams(A.params, A.fps);

  if (A.probe) {
    const { canvas, r } = await makeRenderer(P, await loadPresenter(A.presenter));
    r.renderFrame(A.at);
    fs.writeFileSync(path.resolve(A.probe), canvas.toBuffer('image/png'));
    console.log(`probe → ${A.probe}  ${P.frames} 帧计划 / ${W}x${H} @${P.fps}fps`);
    process.exit(0);
  }

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-kit-'));
  const segs = planShards(P.frames, A.workers, TMP);
  await Promise.all(segs.map((seg) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { start: seg.s, end: seg.e, part: seg.part, params: A.params, fps: P.fps,
        presenter: A.presenter, crf: A.crf, jpeg: A.jpeg, preset: A.preset },
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
    w.once('message', (m) => (m && m.ok ? resolve(m) : reject(new Error(m && m.error))));
    w.once('error', reject);
  })));

  concatParts({
    parts: segs.map((s) => s.part), tmpDir: TMP, out: A.out,
    audio: A.audio, fps: P.fps, frames: P.frames,
  });
  const dur = (P.frames / P.fps).toFixed(3);
  fs.rmSync(TMP, { recursive: true, force: true });
  const size = (fs.statSync(A.out).size / 1048576).toFixed(2);
  console.log(`✓ ${A.out}`);
  console.log(`  ${P.frames} 帧 / ${dur}s / ${P.fps}fps / ${W}x${H} / ${size}MB / ${((Date.now() - t0) / 1000).toFixed(1)}s / ${A.workers} workers`);
}
