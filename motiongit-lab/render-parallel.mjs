#!/usr/bin/env node
/**
 * 并行分片渲染原型：把总帧切成 N 段，每段独立 Chromium + FFmpeg(MPEG-TS)，
 * 最后 concat 成一条 MP4。用于验证 Chrome 逐帧截图的并行收益。
 *
 * 用法: node render-parallel.mjs --package packages/editorial-sync.motion \
 *         --inputs edits/inputs-v5-xiaoxiao.json --out out/parallel.mp4 --jobs 4
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PKG = path.resolve(get('package', 'packages/editorial-sync.motion'));
const INPUTS = path.resolve(get('inputs', 'edits/inputs-v5-xiaoxiao.json'));
const OUT = path.resolve(get('out', 'out/parallel.mp4'));
const JOBS = Number(get('jobs', 4));
const FFMPEG = '/opt/homebrew/bin/ffmpeg';

const tmp = fs.mkdtempSync('/tmp/mg-par-');
execFileSync('python3', ['safe-unpack.py', PKG, tmp]);
const m = JSON.parse(fs.readFileSync(path.join(tmp, 'motion.json'), 'utf8'));
const inputs = JSON.parse(fs.readFileSync(INPUTS, 'utf8'));
const entry = path.join(tmp, m.runtime.entry);
const dir = path.dirname(entry);
let html = fs.readFileSync(entry, 'utf8');
html = html.replace(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (_, s) =>
  `<script>\n${fs.readFileSync(path.resolve(dir, s), 'utf8')}\n</script>`);
html = html.replace(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/gi, (_, h) =>
  `<style>\n${fs.readFileSync(path.resolve(dir, h), 'utf8')}\n</style>`);
html = html.replace(/<head[^>]*>/i, (h) =>
  h + `<script>window.MOTION_INPUTS=${JSON.stringify(inputs).replace(/</g, '\\u003c')};</script>`);

const W = m.output.width, H = m.output.height;
const NUM = m.output.fps.num, DEN = m.output.fps.den;
const TOTAL = Math.round((inputs.durationSeconds || m.output.durationSeconds) * NUM / DEN);
const clip = { x: 0, y: 0, width: W, height: H };
const t0 = Date.now();

function partPath(i) { return path.join(tmp, `part-${i}.ts`); }

async function renderSegment(i, start, end) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => (window.READY || Promise.resolve()).then(() => document.fonts.ready));
  const ff = spawn(FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe', '-framerate', `${NUM}/${DEN}`, '-vcodec', 'mjpeg', '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-f', 'mpegts', partPath(i),
  ], { stdio: ['pipe', 'ignore', 'inherit'] });
  const done = once(ff, 'close');
  for (let f = start; f < end; f++) {
    await page.evaluate((t) => window.seek(t), f * DEN / NUM);
    const buf = await page.screenshot({ type: 'jpeg', quality: 94, clip });
    if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
    if ((f - start) % 60 === 0) process.stdout.write(`\r  job ${i}: ${f - start + 1}/${end - start}`);
  }
  ff.stdin.end();
  const [code] = await done;
  await browser.close();
  if (code !== 0) throw new Error(`job ${i} ffmpeg exit ${code}`);
  process.stdout.write(`\r  job ${i}: ${end - start}/${end - start} done\n`);
}

const per = Math.ceil(TOTAL / JOBS);
const jobs = [];
for (let i = 0; i < JOBS; i++) {
  const start = i * per, end = Math.min(TOTAL, start + per);
  if (start < end) jobs.push(renderSegment(i, start, end));
}
await Promise.all(jobs);

const list = path.join(tmp, 'list.txt');
fs.writeFileSync(list, jobs.map((_, i) => `file '${partPath(i)}'`).join('\n'));
execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0',
  '-i', list, '-c', 'copy', '-movflags', '+faststart', OUT]);

console.log(`\n✓ ${OUT}  ${((Date.now() - t0) / 1000).toFixed(2)}s / ${TOTAL} 帧 / ${JOBS} 路`);
fs.rmSync(tmp, { recursive: true, force: true });
