// knowledge-explainer-sketchnote 的 Chrome 端到端出片（模板自带 CDP 管道 → PNG → ffmpeg）
//
//   node bench/motion-host/chrome-render-full.mjs --params /tmp/ke-48s.json --limit 480
//
// 与 render-single-sketchnote.mjs（Skia → raw RGBA → ffmpeg）严格同链路同参数，
// 差别只有「像素怎么从宿主搬到编码器」：PNG+base64 还是裸 RGBA。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const ENGINE = path.join(REPO, 'templates/vendor/knowledge-explainer-sketchnote/package/content/engine');
const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

process.env.CHROME = process.env.CHROME || path.join(process.env.HOME, '.local/bin/mg-chrome');

const paramsFile = get('params', path.join(ENGINE, 'presets/demo.json'));
const params = JSON.parse(fs.readFileSync(paramsFile, 'utf8'));
const style = JSON.parse(fs.readFileSync(path.join(ENGINE, 'style.json'), 'utf8'));
params.timeCorner = { ...(params.timeCorner || {}), enabled: false };

const width = Number(get('width', params.layout === 'portrait' ? 1080 : 1920));
const height = Number(get('height', params.layout === 'portrait' ? 1920 : 1080));
const fps = Number(get('fps', params.fps || 60));
const START = Number(get('start', 0));
const total = Math.min(Number(get('limit', Math.round(params.durationSeconds * fps))), Math.round(params.durationSeconds * fps));
const profile = get('profile', 'standard');
const enc = profile === 'quality'
  ? { x264: 'slower', crf: '15', tune: 'film' }
  : { x264: 'veryfast', crf: '20', tune: 'animation' };
const out = path.resolve(get('out', path.join(HERE, 'out', `chrome-full-${profile}-${START}.mp4`)));

const t0 = Date.now();
const mod = await import(pathToFileURL(path.join(ENGINE, 'adapter/browser.mjs')).href);
const page = await mod.openBrowser({ core: ENGINE, settings: { params, style }, width, height, fixedRaster: true });
const initMs = Date.now() - t0;

const args = ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'image2pipe', '-framerate', String(fps), '-i', 'pipe:0',
  '-c:v', 'libx264', '-preset', enc.x264, '-crf', enc.crf];
if (enc.tune) args.push('-tune', enc.tune);
args.push('-pix_fmt', 'yuv420p', '-movflags', '+faststart', out);
const ff = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'inherit'] });
const done = once(ff, 'close');

const r0 = Date.now();
const CHUNK = 24;
for (let f = START; f < START + total; f += CHUNK) {
  const times = [];
  for (let i = f; i < Math.min(START + total, f + CHUNK); i++) times.push(i / fps);
  const pngs = await page.frames(times);
  for (const png of pngs) {
    if (!ff.stdin.write(png)) await once(ff.stdin, 'drain');
  }
}
ff.stdin.end();
await done;
const renderMs = Date.now() - r0;

const mb = fs.statSync(out).size / 1048576;
console.log(`✓ ${out}`);
console.log(`  ${total} 帧 / ${(total / fps).toFixed(2)}s 片 / ${mb.toFixed(2)}MB / 启动 ${(initMs / 1000).toFixed(2)}s / 出片 ${(renderMs / 1000).toFixed(2)}s / ${(total / (renderMs / 1000)).toFixed(1)} fps`);
await page.close();
