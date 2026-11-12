// 单宿主测速入口（用 sketchnote-host.mjs，不含编码）
//
//   node bench/motion-host/bench-sketchnote.mjs --params /tmp/ke-48s.json --frames 240
//   node ... --no-ledger --cache-bg
import fs from 'node:fs';
import path from 'node:path';
import { createHost } from './sketchnote-host.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const ENGINE = path.join(REPO, 'templates/vendor/knowledge-explainer-sketchnote/package/content/engine');
const argv = process.argv.slice(2);
const get = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const has = (k) => argv.includes('--' + k);

const paramsFile = get('params', path.join(ENGINE, 'presets/demo.json'));
const params = JSON.parse(fs.readFileSync(paramsFile, 'utf8'));
const style = JSON.parse(fs.readFileSync(path.join(ENGINE, 'style.json'), 'utf8'));
params.timeCorner = { enabled: false };

const width = Number(get('width', params.layout === 'portrait' ? 1080 : 1920));
const height = Number(get('height', params.layout === 'portrait' ? 1920 : 1080));
const fps = Number(get('fps', params.fps || 60));
const N = Number(get('frames', 240));

const t0 = performance.now();
const host = await createHost({
  engine: ENGINE, params, style, width, height,
  noLedger: has('no-ledger'), cacheBg: has('cache-bg'),
});
const initMs = performance.now() - t0;

const dur = host.film.settings.duration;
const times = Array.from({ length: N }, (_, i) => 0.2 + (i / N) * (dur - 0.4));
await host.render(times[0]);
const b0 = performance.now();
for (const t of times) await host.render(t);
const ms = (performance.now() - b0) / N;

const flags = [has('no-ledger') ? 'no-ledger' : 'ledger', has('cache-bg') ? 'cache-bg' : 'bg-live'].join(' / ');
console.log(`${flags}: 初始化 ${initMs.toFixed(0)}ms / 单帧 ${ms.toFixed(2)}ms / ${(1000 / ms).toFixed(0)} fps / ${N} 帧 ${(dur * fps).toFixed(0)} 帧片`);
