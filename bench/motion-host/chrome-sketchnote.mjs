// knowledge-explainer-sketchnote 的「浏览器档」基准：用模板自带 adapter/browser.mjs（CDP 管道）
//   node bench/motion-host/chrome-sketchnote.mjs --params /tmp/ke-48s.json --frames 240
//
// 与 poc-sketchnote.mjs（Skia 宿主）用同一份 params/style、同一分辨率，只换宿主。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const ENGINE = path.join(REPO, 'templates/vendor/knowledge-explainer-sketchnote/package/content/engine');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const paramsFile = arg('params', path.join(ENGINE, 'presets/demo.json'));
const N = Number(arg('frames', 240));
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });

process.env.CHROME = process.env.CHROME || path.join(process.env.HOME, '.local/bin/mg-chrome');

const params = JSON.parse(fs.readFileSync(paramsFile, 'utf8'));
const style = JSON.parse(fs.readFileSync(path.join(ENGINE, 'style.json'), 'utf8'));
params.timeCorner = { ...(params.timeCorner || {}), enabled: false };

const mod = await import(pathToFileURL(path.join(ENGINE, 'adapter/browser.mjs')).href);
const W = Number(arg('width', params.layout === 'portrait' ? 1080 : 1920));
const H = Number(arg('height', params.layout === 'portrait' ? 1920 : 1080));

const t0 = performance.now();
const page = await mod.openBrowser({ core: ENGINE, settings: { params, style }, width: W, height: H, fixedRaster: true });
console.log(`openBrowser + initialize: ${((performance.now() - t0) / 1000).toFixed(2)}s`);

const dur = await page.evaluate('KnowledgeFilm.settings.duration');
console.log(`duration ${dur}s`);

// 单帧绘制成本（不含 PNG 编码，不含传输）
const times = Array.from({ length: N }, (_, i) => 0.2 + (i / N) * (dur - 0.4));
const drawMs = await page.evaluate(`(async()=>{
  const ts=${JSON.stringify(times)};
  await KnowledgeFilm.render(ts[0]);
  const t0=performance.now();
  for(const t of ts) await KnowledgeFilm.render(t);
  return (performance.now()-t0)/ts.length;
})()`);
console.log(`浏览器 单帧绘制 ${drawMs.toFixed(2)} ms → 单页 ${(1000 / drawMs).toFixed(0)} fps`);

// 实际出片路径：render + canvas.toDataURL('image/png')
const fullMs = await page.evaluate(`(async()=>{
  const ts=${JSON.stringify(times.slice(0, 60))};
  const c=document.querySelector('canvas');
  const t0=performance.now();
  for(const t of ts){await KnowledgeFilm.render(t);c.toDataURL('image/png')}
  return (performance.now()-t0)/ts.length;
})()`);
console.log(`浏览器 绘制+PNG ${fullMs.toFixed(2)} ms → 单页 ${(1000 / fullMs).toFixed(0)} fps`);

// 出一帧对照
const [png] = await page.frames([Number(arg('shot', 3))]);
fs.writeFileSync(path.join(OUT, 'chrome-3.png'), png);
console.log('wrote', path.join(OUT, 'chrome-3.png'), png.length, 'B');

await page.close();
