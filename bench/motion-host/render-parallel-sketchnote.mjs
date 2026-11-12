// knowledge-explainer-sketchnote 换宿主后整片并行出片（Skia + N worker + libx264 分片 concat）
//
//   node bench/motion-host/render-parallel-sketchnote.mjs --params /tmp/ke-48s.json --workers 8
//   node bench/motion-host/render-parallel-sketchnote.mjs --params ... --workers 12 --no-ledger
//   node ... --limit 600            # 只渲染前 600 帧
//
// 分片前提：render(t) 无状态（poc-sketchnote.mjs --check 验证）。
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const ENGINE = path.join(REPO, 'templates/vendor/knowledge-explainer-sketchnote/package/content/engine');
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

/* ───────────── child ───────────── */
if (argv.includes('--child')) {
  const { createHost } = await import('./sketchnote-host.mjs');
  const engine = get('engine', ENGINE);
  const width = Number(get('width', 1920));
  const height = Number(get('height', 1080));
  const fps = Number(get('fps', 60));
  const params = JSON.parse(fs.readFileSync(get('params'), 'utf8'));
  const style = JSON.parse(fs.readFileSync(path.join(engine, 'style.json'), 'utf8'));
  params.timeCorner = { ...(params.timeCorner || {}), enabled: false };

  const host = await createHost({ engine, params, style, width, height, noLedger: has('no-ledger'), cacheBg: has('cache-bg') });

  const start = Number(get('start'));
  const end = Number(get('end'));
  const part = get('part');

  const { spawn } = await import('node:child_process');
  const x264 = get('x264', 'veryfast');
  const crf = get('crf', '20');
  const tune = get('tune', '');
  const args = ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', x264, '-crf', crf];
  if (tune) args.push('-tune', tune);
  args.push('-pix_fmt', 'yuv420p', '-f', 'mpegts', part);
  const ff = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = once(ff, 'close');

  const { ctx } = host;
  const bytes = width * height * 4;
  for (let f = start; f < end; f++) {
    await host.render(f / fps);
    const buf = ctx.getImageData(0, 0, width, height).data;
    const chunk = Buffer.from(buf.buffer, buf.byteOffset, bytes);
    if (!ff.stdin.write(chunk)) await once(ff.stdin, 'drain');
  }
  ff.stdin.end();
  await done;
  process.exit(0);
}

/* ───────────── main ───────────── */
const paramsFile = get('params', path.join(ENGINE, 'presets/demo.json'));
const params = JSON.parse(fs.readFileSync(paramsFile, 'utf8'));
const width = Number(get('width', params.layout === 'portrait' ? 1080 : 1920));
const height = Number(get('height', params.layout === 'portrait' ? 1920 : 1080));
const fps = Number(get('fps', params.fps || 60));
const total = Math.min(Number(get('limit', Math.round(params.durationSeconds * fps))), Math.round(params.durationSeconds * fps));
const workers = Math.max(1, Number(get('workers', 8)));
const profile = get('profile', 'standard');
const enc = profile === 'quality'
  ? { x264: 'slower', crf: '15', tune: 'film' }
  : { x264: 'veryfast', crf: '20', tune: 'animation' };
const out = path.resolve(get('out', path.join(HERE, 'out', `sketchnote-${profile}.mp4`)));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sketch-par-'));
const per = Math.ceil(total / workers);
const segs = [];
for (let i = 0; i < workers; i++) {
  const s = i * per, e = Math.min(total, s + per);
  if (s >= e) break;
  segs.push({ s, e, part: path.join(TMP, `p${i}.ts`) });
}
console.log(`${total} 帧 / ${workers} worker / ${fps}fps / ${width}x${height} / ${profile} → ${out}`);

const t0 = Date.now();
await Promise.all(segs.map((seg) => new Promise((res, rej) => {
  const args = [new URL(import.meta.url).pathname, '--child', '--engine', ENGINE, '--params', paramsFile,
    '--start', String(seg.s), '--end', String(seg.e), '--part', seg.part,
    '--fps', String(fps), '--width', String(width), '--height', String(height),
    '--x264', enc.x264, '--crf', enc.crf, '--tune', enc.tune];
  if (has('no-ledger')) args.push('--no-ledger');
  if (has('cache-bg')) args.push('--cache-bg');
  const w = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  w.stderr.on('data', (d) => { err += d.toString(); });
  w.once('error', rej);
  w.once('exit', (c) => { if (c) rej(new Error('child exit ' + c + ' :: ' + err.slice(0, 400))); else res({ ok: true }); });
})));
const renderMs = Date.now() - t0;

const list = path.join(TMP, 'list.txt');
fs.writeFileSync(list, segs.map((s) => `file '${s.part}'`).join('\n'));
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
  '-c', 'copy', '-movflags', '+faststart', out]);

const sizeMB = fs.statSync(out).size / 1048576;
console.log(`✓ ${out}`);
console.log(`  ${total} 帧 / ${(total / fps).toFixed(2)}s 片 / ${sizeMB.toFixed(2)}MB / 渲染 ${(renderMs / 1000).toFixed(2)}s / ${(total / (renderMs / 1000)).toFixed(1)} fps / ${workers} workers`);
fs.rmSync(TMP, { recursive: true, force: true });
