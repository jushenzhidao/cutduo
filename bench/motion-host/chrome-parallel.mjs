// Chrome 多实例并行出片（对照 Skia 多进程）：N 个独立浏览器实例各渲一段 → concat
//
//   node bench/motion-host/chrome-parallel.mjs --params /tmp/ke-48s.json --instances 2
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const ENGINE = path.join(REPO, 'templates/vendor/knowledge-explainer-sketchnote/package/content/engine');
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

const paramsFile = get('params', path.join(ENGINE, 'presets/demo.json'));
const params = JSON.parse(fs.readFileSync(paramsFile, 'utf8'));
const fps = Number(get('fps', params.fps || 60));
const total = Math.round(params.durationSeconds * fps);
const n = Math.max(1, Number(get('instances', 2)));
const out = path.resolve(get('out', path.join(HERE, 'out', 'chrome-parallel.mp4')));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-par-'));
const per = Math.ceil(total / n / fps) * fps; // 按整秒对齐，避免奇偶段
const segs = [];
for (let i = 0; i < n; i++) {
  const s = i * per;
  const e = Math.min(total, s + per);
  if (s >= e) break;
  segs.push({ s, e, file: path.join(TMP, `seg-${i}.mp4`) });
}

const t0 = Date.now();
await Promise.all(segs.map((seg) => new Promise((res, rej) => {
  const args = [path.join(HERE, 'chrome-render-full.mjs'), '--params', paramsFile,
    '--start', String(seg.s), '--limit', String(seg.e - seg.s), '--out', seg.file];
  const w = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  w.stderr.on('data', (d) => { err += d.toString(); });
  w.once('error', rej);
  w.once('exit', (c) => (c ? rej(new Error('chrome seg exit ' + c + ' :: ' + err.slice(0, 300))) : res()));
})));
const wall = Date.now() - t0;

const list = path.join(TMP, 'list.txt');
fs.writeFileSync(list, segs.map((s) => `file '${s.file}'`).join('\n'));
execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
  '-c', 'copy', '-movflags', '+faststart', out]);
const mb = fs.statSync(out).size / 1048576;
console.log(`✓ ${out}`);
console.log(`  ${total} 帧 / ${(total / fps).toFixed(2)}s 片 / ${mb.toFixed(2)}MB / 墙钟 ${(wall / 1000).toFixed(2)}s / ${(total / (wall / 1000)).toFixed(1)} fps / ${segs.length} Chrome 实例`);
fs.rmSync(TMP, { recursive: true, force: true });
