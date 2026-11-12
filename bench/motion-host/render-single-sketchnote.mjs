// knowledge-explainer-sketchnote 单进程整片出片（Skia → ffmpeg 管道，不 fork）
//
//   node bench/motion-host/render-single-sketchnote.mjs --params /tmp/ke-48s.json
//   node ... --profile quality
//
// 为什么单独一个入口：本机沙箱对 fork 出的进程树记录会超限（Broker records exceeded），
// 8 worker 版本一跑就熔断 shell。单进程 + 一个 ffmpeg 是安全路径，用来测「整片墙钟」。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { createHost } from './sketchnote-host.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const ENGINE = path.join(REPO, 'templates/vendor/knowledge-explainer-sketchnote/package/content/engine');
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

const paramsFile = get('params', path.join(ENGINE, 'presets/demo.json'));
const params = JSON.parse(fs.readFileSync(paramsFile, 'utf8'));
const style = JSON.parse(fs.readFileSync(path.join(ENGINE, 'style.json'), 'utf8'));
params.timeCorner = { ...(params.timeCorner || {}), enabled: false };

const width = Number(get('width', params.layout === 'portrait' ? 1080 : 1920));
const height = Number(get('height', params.layout === 'portrait' ? 1920 : 1080));
const fps = Number(get('fps', params.fps || 60));
const total = Math.min(Number(get('limit', Math.round(params.durationSeconds * fps))), Math.round(params.durationSeconds * fps));
const profile = get('profile', 'standard');
const enc = profile === 'quality'
  ? { x264: 'slower', crf: '15', tune: 'film' }
  : { x264: 'veryfast', crf: '20', tune: 'animation' };
const out = path.resolve(get('out', path.join(HERE, 'out', `sketchnote-single-${profile}.mp4`)));

const t0 = Date.now();
const host = await createHost({ engine: ENGINE, params, style, width, height, noLedger: has('no-ledger'), cacheBg: has('cache-bg') });
const initMs = Date.now() - t0;

const args = ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0',
  '-c:v', 'libx264', '-preset', enc.x264, '-crf', enc.crf];
if (enc.tune) args.push('-tune', enc.tune);
args.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
const ff = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'inherit'] });
const done = once(ff, 'close');

const bytes = width * height * 4;
const r0 = Date.now();
for (let f = 0; f < total; f++) {
  await host.render(f / fps);
  const buf = host.ctx.getImageData(0, 0, width, height).data;
  if (!ff.stdin.write(Buffer.from(buf.buffer, buf.byteOffset, bytes))) await once(ff.stdin, 'drain');
}
ff.stdin.end();
await done;
const renderMs = Date.now() - r0;

const mb = fs.statSync(out).size / 1048576;
console.log(`✓ ${out}`);
console.log(`  ${total} 帧 / ${(total / fps).toFixed(2)}s 片 / ${mb.toFixed(2)}MB / 初始化 ${(initMs / 1000).toFixed(2)}s / 渲染+编码 ${(renderMs / 1000).toFixed(2)}s / ${(total / (renderMs / 1000)).toFixed(1)} fps`);
