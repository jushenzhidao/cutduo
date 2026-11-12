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
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createDesktopRenderer, registerFonts, validateParams, DEFAULT_TOKENS } from './desktop.mjs';

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
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

function parseArgs(argv) {
  const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  return {
    params: resolveInput(get('params', 'content/demo.json')),
    audio: resolveInput(get('audio', null), false),
    out: path.resolve(get('out', 'out/desktop.mp4')),
    workers: Math.max(1, Number(get('workers', Math.min(8, os.cpus().length)))),
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

async function makeRenderer(P, presenter) {
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
  const { canvas, r } = await makeRenderer(P, await loadPresenter(presenter));
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
  const per = Math.ceil(P.frames / A.workers);
  const segs = [];
  for (let i = 0; i < A.workers; i++) {
    const s = i * per, e = Math.min(P.frames, s + per);
    if (s < e) segs.push({ i, s, e, part: path.join(TMP, `seg-${i}.ts`) });
  }
  await Promise.all(segs.map((seg) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { start: seg.s, end: seg.e, part: seg.part, params: A.params, fps: P.fps,
        presenter: A.presenter, crf: A.crf, jpeg: A.jpeg, preset: A.preset },
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
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent,
      '-c', 'copy', '-t', dur, A.out]);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  const size = (fs.statSync(A.out).size / 1048576).toFixed(2);
  console.log(`✓ ${A.out}`);
  console.log(`  ${P.frames} 帧 / ${dur}s / ${P.fps}fps / ${W}x${H} / ${size}MB / ${((Date.now() - t0) / 1000).toFixed(1)}s / ${A.workers} workers`);
}
