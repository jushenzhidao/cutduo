// film-kit 模板「换宿主 + 并行」渲染：N 个 worker 各渲一段 → 各自 libx264 → concat
//
//   node bench/motion-host/render-parallel.mjs                 # 8 worker，整片
//   node bench/motion-host/render-parallel.mjs --workers 4 --limit 600
//
// 前提已验证：frame(t) 无状态（--check 逐字节一致），所以分片不会错位。
// 每个 worker 独立初始化（解包共享、buildScenes 各自跑一遍），互不干扰。
import { execFileSync, fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const TPL = path.join(REPO, 'templates/vendor/mac-desktop');
const PKG = path.join(TPL, 'package/content/release.bin');
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

/* ───────────────── child：渲染一段并编码 ───────────────── */
if (argv.includes('--child')) {
  const engine = get('engine');
  const start = Number(get('start'));
  const end = Number(get('end'));
  const part = get('part');
  const fps = Number(get('fps', 60));

  const canvas = createCanvas(1440, 1080);
  globalThis.window = globalThis;
  globalThis.window.FILMKIT = { version: 1, warnings: [] };
  globalThis.document = {
    getElementById: (id) => (id === 'cv' ? canvas : null),
    createElement: (t) => (t === 'canvas' ? createCanvas(1, 1) : {}),
    fonts: { load: () => Promise.resolve(), ready: Promise.resolve() },
    title: '',
  };
  const CJK = path.join(REPO, 'assets/fonts');
  GlobalFonts.registerFromPath(path.join(CJK, 'NotoSansSC-Medium.otf'), 'PingFang SC');
  GlobalFonts.registerFromPath(path.join(CJK, 'NotoSansSC-Black.otf'), 'PingFang SC Black');

  await import(pathToFileURL(path.join(engine, 'src/main.js')).href);
  for (let i = 0; i < 400; i++) {
    if (document.title === 'done' || String(document.title).startsWith('error')) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  if (document.title !== 'done') { console.error('init failed:', document.title); process.exit(1); }

  const { spawn } = await import('node:child_process');
  const ff = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1440x1080', '-framerate', String(fps), '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', get('x264', 'veryfast'), '-crf', get('crf', '20'),
    '-pix_fmt', 'yuv420p', '-f', 'mpegts', part], { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = once(ff, 'close');

  const ctx = canvas.getContext('2d');
  for (let f = start; f < end; f++) {
    await window.renderAt(f / fps);
    const buf = ctx.getImageData(0, 0, 1440, 1080).data;
    if (!ff.stdin.write(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  await done;
  process.send?.({ ok: true, frames: end - start });
  process.exit(0);
}

/* ───────────────── main：解包 → 分片 → concat ───────────────── */
if (!fs.existsSync(PKG)) { console.error(`模板包不存在：${PKG}`); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-par-'));
execFileSync('unzip', ['-q', PKG, '-d', TMP], { stdio: 'inherit' });
const ENGINE = path.join(TMP, 'engine');

const planFile = fs.readdirSync(path.join(TPL, 'instance')).filter((f) => /^plan-.*\.json$/.test(f)).sort().pop();
const plan = JSON.parse(fs.readFileSync(path.join(TPL, 'instance', planFile), 'utf8'));
fs.mkdirSync(path.join(ENGINE, 'data'), { recursive: true });
fs.writeFileSync(path.join(ENGINE, 'data', 'film.js'), `export const FILM = ${JSON.stringify(plan.FILM)};\n`);
fs.writeFileSync(path.join(ENGINE, 'data', 'venv.js'), 'export const VENV = { fps: 30, v: [] };\n');
fs.writeFileSync(path.join(ENGINE, 'data', 'face.js'), 'export const FACE = { n: 0 };\n');
fs.writeFileSync(path.join(ENGINE, 'data', 'subs.js'), 'export const SUBS = [];\n');

const fps = plan.FILM.fps || 60;
const total = Math.min(Number(get('limit', Math.round(plan.FILM.end * fps))), Math.round(plan.FILM.end * fps));
const workers = Math.max(1, Number(get('workers', 8)));
const out = path.resolve(get('out', path.join(HERE, 'out', 'motion-parallel.mp4')));

const per = Math.ceil(total / workers);
const segs = [];
for (let i = 0; i < workers; i++) {
  const s = i * per, e = Math.min(total, s + per);
  if (s >= e) break;
  segs.push({ s, e, part: path.join(TMP, `p${i}.ts`) });
}
console.log(`${total} 帧 / ${workers} worker / ${fps}fps → ${out}`);

const t0 = Date.now();
await Promise.all(segs.map((seg) => new Promise((res, rej) => {
  const w = fork(new URL(import.meta.url), ['--child', '--engine', ENGINE,
    '--start', String(seg.s), '--end', String(seg.e), '--part', seg.part, '--fps', String(fps),
    '--crf', get('crf', '20'), '--x264', get('x264', 'veryfast')],
  { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  w.once('message', (m) => (m && m.ok ? res(m) : rej(new Error('child failed'))));
  w.once('error', rej);
  w.once('exit', (c) => { if (c) rej(new Error('child exit ' + c)); });
})));
const renderMs = Date.now() - t0;

const list = path.join(TMP, 'list.txt');
fs.writeFileSync(list, segs.map((s) => `file '${s.part}'`).join('\n'));
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
  '-c', 'copy', '-movflags', '+faststart', out]);

const sizeMB = fs.statSync(out).size / 1048576;
const sec = (renderMs / 1000).toFixed(2);
console.log(`✓ ${out}`);
console.log(`  ${total} 帧 / ${(total / fps).toFixed(3)}s / ${sizeMB.toFixed(2)}MB / ${sec}s / ${(total / (renderMs / 1000)).toFixed(1)} fps / ${workers} workers`);
fs.rmSync(TMP, { recursive: true, force: true });
