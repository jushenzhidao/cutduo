#!/usr/bin/env node
/**
 * desktop-kit · 出片路径对比跑测（同内容 / 同规格 / 只换一段管线）
 *
 *   node desktop-kit/tools/render-bench.mjs --preset content/cmp.json \
 *     --bg static --pipe jpeg --workers 8 --out out/cmp-a.mp4 --json out/cmp-a.json
 *
 * 三条可换的轴：
 *   --bg   static | gpu | js    壁纸层用 Skia 渐变 / headless-gl / 纯 JS 逐像素
 *   --pipe jpeg  | raw          帧传给 ffmpeg 的方式
 *   --crf / --preset            x264 参数（编码蒸馏另用 ffmpeg 转码，不在此处）
 *
 * 并行用 child_process.fork（不是 worker_threads）：headless-gl 是原生模块，
 * 独立进程各持一个 GL 上下文最稳，也顺带隔离了 Skia 的内存。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fork, spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createDesktopRenderer, registerFonts, validateParams, DEFAULT_TOKENS } from '../desktop.mjs';
import { makeProvider } from './bg-providers.mjs';

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const W = DEFAULT_TOKENS.width, H = DEFAULT_TOKENS.height;

const argv = process.argv.slice(2);
const cliGet = (k) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined; };

// ── 超参预设：CLI 单项 > profile > 内置默认。预设表 desktop-kit/profiles.json ──
const PROFILE_PATH = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'profiles.json');
const PROFILES = JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8'));
const profileName = cliGet('profile') || PROFILES.default;
const PROFILE = PROFILES.profiles[profileName];
if (!PROFILE) {
  throw new Error(`未知 profile "${profileName}"，可选：${Object.keys(PROFILES.profiles).join(' / ')}`);
}
const get = (k, d) => {
  const v = cliGet(k);
  if (v !== undefined) return v;
  return PROFILE[k] !== undefined ? String(PROFILE[k]) : d;
};
const has = (k) => argv.includes('--' + k);
const effective = () => Object.fromEntries(
  ['bg', 'pipe', 'codec', 'x264', 'crf', 'tune', 'bitrate', 'jpeg'].map((k) => [k, get(k, null)]));
const resolveInput = (p, must = true) => {
  if (!p) return p;
  if (path.isAbsolute(p)) return p;
  const a = path.resolve(p);
  if (fs.existsSync(a)) return a;
  const b = path.join(ROOT, p);
  return fs.existsSync(b) || !must ? b : a;
};

function loadParams(file, fpsOverride) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  validateParams(d);
  const fps = Number(fpsOverride || d.fps || 60);
  const duration = d.durationSeconds || d.shots[d.shots.length - 1].t1;
  return { ...d, fps, durationSeconds: duration, frames: Math.round(duration * fps) };
}

/** 摄像头窗口的人像：给图就 cover 裁切，不给就画程序化占位（刻意不用他人肖像）。 */
async function loadPresenter(p) {
  if (!p || p === 'off') return null;
  const file = resolveInput(p, false);
  if (!file || !fs.existsSync(file)) return null;
  try { return await loadImage(file); } catch { return null; }
}

/** 载入分镜里引用的照片素材（preset.photos: key → 相对路径）。 */
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
    if (!f || !fs.existsSync(f)) { console.warn(`photo "${k}" 缺失: ${rel}`); continue; }
    try { out[k] = await loadImage(f); } catch { console.warn(`photo "${k}" 解码失败`); }
  }
  return out;
}

/* ───────────────────────────── 子进程：渲一段 ───────────────────────────── */async function childMain() {
  const start = Number(get('start', 0)), end = Number(get('end', 0));
  const part = get('part'), preset = resolveInput(get('preset')), bg = get('bg', 'static');
  const pipe = get('pipe', 'jpeg'), fpsArg = get('fps', null);
  const crf = String(get('crf', 20)), x264 = get('x264', 'veryfast'), jpegQ = Number(get('jpeg', 94));

  registerFonts(path.join(ROOT, 'assets/fonts'));
  const P = loadParams(preset, fpsArg);

  const provider = bg === 'static' ? null : makeProvider(bg, { width: W, height: H });
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const r = createDesktopRenderer({
    ctx,
    wallpaper: provider ? (g, theme, m) => provider.paint(g, theme, m.t) : undefined,
  });
  r.setContent({
    shots: P.shots, captions: P.captions, chapters: P.chapters, brand: P.brand,
    presenter: await loadPresenter(get('presenter', null)),
    photos: await loadPhotos(P),
    clips: await loadClips(P, start / P.fps, end / P.fps),
  });

  const input = pipe === 'raw'
    ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-framerate', String(P.fps), '-i', 'pipe:0']
    : ['-f', 'image2pipe', '-framerate', String(P.fps), '-i', 'pipe:0'];
  // --codec：libx264（CRF 控质）| vt264 / vthevc（VideoToolbox，码率控质，不占 CPU）
  const codec = get('codec', 'libx264');
  const vArgs = codec === 'vt264'
    ? ['-c:v', 'h264_videotoolbox', '-b:v', get('bitrate', '6M'), '-pix_fmt', 'yuv420p']
    : codec === 'vthevc'
      ? ['-c:v', 'hevc_videotoolbox', '-b:v', get('bitrate', '4M'), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1']
      : codec === 'libx265'
        ? ['-c:v', 'libx265', '-preset', x264, '-crf', crf, '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1',
           ...(get('tune', null) ? ['-tune', get('tune')] : [])]
      : ['-c:v', 'libx264', '-preset', x264, '-crf', crf, '-pix_fmt', 'yuv420p',
         ...(get('tune', null) ? ['-tune', get('tune')] : [])];
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...input,
    ...vArgs, '-f', 'mpegts', part],
  { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = once(ff, 'close');

  const frameMs = [], writeMs = [];
  for (let f = start; f < end; f++) {
    const a = performance.now();
    r.renderFrame(f / P.fps);
    const b = performance.now();
    let buf;
    if (pipe === 'raw') {
      const d = ctx.getImageData(0, 0, W, H).data;
      buf = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
    } else {
      buf = canvas.toBuffer('image/jpeg', jpegQ);
    }
    if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
    writeMs.push(performance.now() - b);
    frameMs.push(b - a);
  }
  ff.stdin.end();
  const [code] = await done;
  if (code !== 0) throw new Error('ffmpeg exit ' + code);
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  process.send({
    ok: true,
    frames: end - start,
    frameMs: mean(frameMs),
    writeMs: mean(writeMs),
    bg: provider ? provider.stats() : null,
  });
  setTimeout(() => process.exit(0), 30);
}

/* ───────────────────────────── 主进程 ───────────────────────────── */
async function main() {
  const preset = resolveInput(get('preset', 'content/cmp.json'));
  const out = path.resolve(get('out', 'out/cmp.mp4'));
  const jsonOut = get('json', null);
  const audio = resolveInput(get('audio', null), false);
  const bg = get('bg', 'static'), pipe = get('pipe', 'jpeg');
  const workers = Math.max(1, Number(get('workers', Math.min(8, os.cpus().length))));
  const P = loadParams(preset, get('fps', null));
  const limit = Number(get('limit', 0));
  if (limit > 0) P.frames = Math.min(P.frames, limit);   // 只跑前 N 帧，用于快速测速
  if (has('probe')) {
    // 单帧探针：只渲染一张 PNG，用于快速看画面
    registerFonts(path.join(ROOT, 'assets/fonts'));
    const provider = bg === 'static' ? null : makeProvider(bg, { width: W, height: H });
    const canvas = createCanvas(W, H);
    const r = createDesktopRenderer({
      ctx: canvas.getContext('2d'),
      wallpaper: provider ? (g, theme, m) => provider.paint(g, theme, m.t) : undefined,
    });
    r.setContent({
      shots: P.shots, captions: P.captions, chapters: P.chapters, brand: P.brand,
      presenter: await loadPresenter(get('presenter', null)),
      photos: await loadPhotos(P),
      clips: await loadClips(P, Number(get('at', 1.0)) - 0.01, Number(get('at', 1.0)) + 0.01),
    });
    r.renderFrame(Number(get('at', 1.0)));
    const p = path.resolve(get('probe'));
    fs.writeFileSync(p, canvas.toBuffer('image/png'));
    console.log(`probe → ${p}  ${bg}/${pipe}`);
    return;
  }

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-bench-'));
  const per = Math.ceil(P.frames / workers);
  const segs = [];
  for (let i = 0; i < workers; i++) {
    const s = i * per, e = Math.min(P.frames, s + per);
    if (s < e) segs.push({ i, s, e, part: path.join(TMP, `seg-${i}.ts`) });
  }
  const t0 = Date.now();
  const stats = await Promise.all(segs.map((seg) => new Promise((res, rej) => {
    const w = fork(new URL(import.meta.url), ['--child',
      '--start', String(seg.s), '--end', String(seg.e), '--part', seg.part,
      '--preset', preset, '--bg', bg, '--pipe', pipe,
      '--crf', String(get('crf', 20)), '--x264', get('x264', 'veryfast'), '--jpeg', String(get('jpeg', 94)),
      '--profile', profileName,
      '--codec', get('codec', 'libx264'), '--bitrate', get('bitrate', '6M'),
      ...(get('tune', null) ? ['--tune', get('tune')] : []),
      ...(get('presenter', null) ? ['--presenter', resolveInput(get('presenter'))] : []),
    ], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    w.once('message', (m) => (m && m.ok ? res(m) : rej(new Error('child failed'))));
    w.once('error', rej);
    w.once('exit', (c) => { if (c) rej(new Error('child exit ' + c)); });
  })));
  const renderMs = Date.now() - t0;

  const list = path.join(TMP, 'list.txt');
  fs.writeFileSync(list, segs.map((s) => `file '${s.part}'`).join('\n'));
  const silent = path.join(TMP, 'silent.mp4');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent]);
  const dur = (P.frames / P.fps).toFixed(3);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // HEVC 必须在最终 mp4 上重新打 hvc1 标：分片 mpegts 里的 tag 在 concat 后会丢成 hev1，
  // 而 Safari / QuickTime 只认 hvc1。
  const tagArgs = ['libx265', 'vthevc'].includes(get('codec', 'libx264')) ? ['-tag:v', 'hvc1'] : [];
  if (audio && fs.existsSync(audio)) {
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent, '-i', audio,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'copy', ...tagArgs, '-t', dur, '-movflags', '+faststart', out]);
  } else {
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', silent, '-c', 'copy', ...tagArgs, '-t', dur, out]);
  }
  fs.rmSync(TMP, { recursive: true, force: true });

  const mean = (k) => stats.reduce((a, s) => a + (s[k] || 0) * s.frames, 0) / P.frames;
  const bgStats = stats.find((s) => s.bg)?.bg || null;
  const sizeMB = fs.statSync(out).size / 1048576;
  const wall = (Date.now() - t0) / 1000;
  const rec = {
    pipeline: `${bg}/${pipe}`, bg, pipe, workers,
    frames: P.frames, fps: P.fps, seconds: Number(dur),
    out, sizeMB: Number(sizeMB.toFixed(2)),
    wallSeconds: Number(wall.toFixed(2)),
    renderSeconds: Number((renderMs / 1000).toFixed(2)),
    throughputFps: Number((P.frames / wall).toFixed(1)),
    frameMs: Number(mean('frameMs').toFixed(2)),
    writeMs: Number(mean('writeMs').toFixed(2)),
    budgetMs: Number((mean('frameMs') + mean('writeMs')).toFixed(2)),
    bgLayer: bgStats ? {
      drawsPerProcess: Math.round(bgStats.draws / workers),
      drawMs: Number((bgStats.drawMs || 0).toFixed(2)),
      readMs: Number((bgStats.readMs || 0).toFixed(2)),
      totalMs: Number((bgStats.totalMs || 0).toFixed(2)),
    } : null,
  };
  if (jsonOut) { fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true }); fs.writeFileSync(path.resolve(jsonOut), JSON.stringify(rec, null, 2)); }
  console.log(`✓ ${out}`);
  console.log(`  ${rec.pipeline}  ${rec.frames} 帧 / ${dur}s / ${rec.sizeMB}MB / 墙钟 ${rec.wallSeconds}s / ${rec.throughputFps} fps / ${workers} workers`);
  console.log(`  profile：${profileName}（${PROFILE.label || ''}）`);
  console.log(`  超参：${JSON.stringify(effective())}`);
  console.log(`  单帧：绘制 ${rec.frameMs}ms + 传帧 ${rec.writeMs}ms${rec.bgLayer ? `  （其中壁纸层 ${rec.bgLayer.totalMs}ms）` : ''}`);
}

if (has('child')) {
  childMain().catch((e) => { console.error(e); process.exit(1); });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}
