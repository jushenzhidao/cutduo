#!/usr/bin/env node
/**
 * skia-kit · 一条命令出片（无浏览器）
 *
 *   node skia-kit/render.mjs --params skia-kit/presets/v8t.json \
 *     --audio edits/audio-v8t.m4a --out out/kit.mp4
 *
 * 只依赖 @napi-rs/canvas + ffmpeg：把 params 里的 8 个分镜逐帧画成 JPEG，
 * 管道喂给 libx264，最后与音轨合成。默认 8 个 worker 分片并行。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createPaperRenderer, registerFonts, loadTokens } from './paper.mjs';
import { createScienceRenderer } from './science.mjs';

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** 相对路径解析：先按 cwd，再按仓库根。这样从工作区根或 motiongit-lab 里跑都对。 */
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
    kit: get('kit', 'paper'),
    params: resolveInput(get('params', 'skia-kit/presets/v8t.json')),
    audio: resolveInput(get('audio', null), false),
    out: path.resolve(get('out', 'out/kit.mp4')),
    workers: Math.max(1, Number(get('workers', Math.min(8, os.cpus().length)))),
    fps: get('fps', null),
    crf: String(get('crf', 20)),
    jpeg: Number(get('jpeg', 94)),
    preset: get('preset', 'veryfast'),
    avatar: resolveInput(get('avatar', 'edits/assets/avatar.png'), false),
    theme: get('theme', null),
    transition: get('transition', 'cut'),
    transitionDur: Number(get('transition-dur', 0.26)),
    // 默认 raw：中间不再出 JPEG（少一次有损编码，同等 CRF 下体积小 6%），实测也略快。
    // --pipe jpeg 保留给需要"中间帧可回放/体积小"的场合。
    pipe: get('pipe', 'raw'),
    x264Threads: get('x264-threads', '1'),   // 每个 worker 一个编码线程：8 路时避免线程超订
    probe: get('probe', null),
    at: Number(get('at', 2.5)),
  };
}

const A = parseArgs(process.argv.slice(2));

/**
 * 主题：只换 palette（色），不动任何几何——几何是 paper-perspective 的测量值，改了就不是复刻了。
 * clean 是给"知识口播"调的一版：底色更白、正文更中性、字幕条更实，靠近现代排版而不是牛皮纸。
 */
const THEMES = {
  clean: {
    bg: '#FAFAF7', ink: '#111214', accent: '#2462EA', body: '#4C5150', label: '#7A807C',
    bar: 'rgba(17,18,20,0.88)', ring: 'rgba(36,98,234,0.22)', hair: 'rgba(0,0,0,0.08)',
  },
};
const PALETTE = A.theme ? THEMES[A.theme] : null;
if (A.theme && !PALETTE) throw new Error(`unknown --theme ${A.theme}（可选：${Object.keys(THEMES).join(' / ')}）`);

/** segments（科普版式：每段 dur）→ 统一场景轴（t0/t1） */
function normalizeSegments(segs) {
  let acc = 0;
  return segs.map((s) => { const t0 = acc; acc += Number(s.dur || 3); return { type: s.type, t0, t1: acc, args: s.args || {} }; });
}

function loadParams(file, fpsOverride) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const scenes = d.scenes || (Array.isArray(d.segments) ? normalizeSegments(d.segments) : []);
  if (!scenes.length) throw new Error('params 里没有 scenes / segments');
  const fps = Number(fpsOverride || d.fps || 60);
  const duration = d.durationSeconds || scenes[scenes.length - 1].t1;
  return { ...d, scenes, captions: d.captions || [], fps, durationSeconds: duration, frames: Math.round(duration * fps) };
}

async function loadAvatar(p) {
  if (!p || p === 'off') return null;
  const abs = path.isAbsolute(p) ? p : path.resolve(p);
  if (!fs.existsSync(abs)) return null;
  try { return await loadImage(abs); } catch { return null; }
}

if (!isMainThread) {
  const { start, end, part, params, crf, jpeg, preset, tokensPath, fps, transition, transitionDur, palette, pipe, x264Threads, kit, brand, subtitle, theme, fadeOutSeconds } = workerData;
  registerFonts(path.join(ROOT, 'assets/fonts'));
  // fps 必须由主线程显式传入：params 里常是 24，CLI 的 --fps 60 只改主线程会导致
  // worker 按 24fps 计时（帧号/时间轴错位、成片被截短）。
  const P = loadParams(params, fps);
  const avatar = await loadAvatar(workerData.avatar);
  const canvas = createCanvas(1920, 1080);
  const ctx = canvas.getContext('2d');
  const r = kit === 'science'
    ? createScienceRenderer({ canvas, ctx, width: 1920, height: 1080, fps: P.fps, brand, subtitle, theme, fadeOutSeconds })
    : createPaperRenderer({ ctx, tokens: tokensPath ? loadTokens(tokensPath) : undefined, palette, transition, transitionDur });
  r.setContent(kit === 'science'
    ? { scenes: P.scenes, captions: P.captions, brand, subtitle, theme, fadeOutSeconds }
    : { scenes: P.scenes, captions: P.captions, avatar });
  if (kit === 'science') await r.ready();

  const inputArgs = pipe === 'raw'
    ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1920x1080', '-framerate', String(P.fps), '-i', 'pipe:0']
    : ['-f', 'image2pipe', '-framerate', String(P.fps), '-vcodec', 'mjpeg', '-i', 'pipe:0'];
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...inputArgs,
    '-c:v', 'libx264', '-preset', preset, '-crf', crf, '-pix_fmt', 'yuv420p',
    ...(x264Threads ? ['-threads', String(x264Threads)] : []),
    '-f', 'mpegts', part], { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = once(ff, 'close');
  for (let f = start; f < end; f++) {
    r.renderFrame(f / P.fps);
    const buf = pipe === 'raw' ? canvas.data() : canvas.toBuffer('image/jpeg', jpeg);
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
    const avatar = await loadAvatar(A.avatar);
    const canvas = createCanvas(1920, 1080);
    const r0 = canvas.getContext('2d');
    const r = A.kit === 'science'
      ? createScienceRenderer({ canvas, ctx: r0, brand: P.brand, subtitle: P.subtitle, theme: P.theme, fadeOutSeconds: P.fadeOutSeconds })
      : createPaperRenderer({ ctx: r0, palette: PALETTE });
    r.setContent(A.kit === 'science'
      ? { scenes: P.scenes, captions: P.captions, brand: P.brand, subtitle: P.subtitle, theme: P.theme, fadeOutSeconds: P.fadeOutSeconds }
      : { scenes: P.scenes, captions: P.captions, avatar });
    if (A.kit === 'science') await r.ready();
    r.renderFrame(A.at);
    fs.writeFileSync(A.probe, canvas.toBuffer('image/png'));
    console.log('probe →', A.probe, `${P.frames} 帧计划`);
    process.exit(0);
  }

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'skia-kit-'));
  const per = Math.ceil(P.frames / A.workers);
  const segs = [];
  for (let i = 0; i < A.workers; i++) {
    const s = i * per, e = Math.min(P.frames, s + per);
    if (s < e) segs.push({ i, s, e, part: path.join(TMP, `seg-${i}.ts`) });
  }
  await Promise.all(segs.map((seg) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), {
      workerData: { start: seg.s, end: seg.e, part: seg.part, params: A.params, fps: P.fps,
        transition: A.transition, transitionDur: A.transitionDur,
        avatar: A.avatar, crf: A.crf, jpeg: A.jpeg, preset: A.preset, palette: PALETTE,
        pipe: A.pipe, x264Threads: A.x264Threads, kit: A.kit,
        brand: P.brand || null, subtitle: P.subtitle || null, theme: P.theme || null,
        fadeOutSeconds: P.fadeOutSeconds },
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
      '-i', silent, '-i', A.audio,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'copy',
      '-t', dur, '-movflags', '+faststart', A.out]);
  } else {
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent, '-c', 'copy', '-t', dur, A.out]);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  const size = (fs.statSync(A.out).size / 1048576).toFixed(2);
  console.log(`✓ ${A.out}`);
  console.log(`  ${P.frames} 帧 / ${dur}s / ${P.fps}fps / ${size}MB / ${((Date.now() - t0) / 1000).toFixed(1)}s / ${A.workers} workers`);
}
