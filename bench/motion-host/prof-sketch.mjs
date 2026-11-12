import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCanvas, GlobalFonts, Path2D, ImageData } from '@napi-rs/canvas';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(HERE, '../../templates/vendor/knowledge-explainer-sketchnote/package/content/engine');
const params = JSON.parse(fs.readFileSync('/tmp/ke-48s.json', 'utf8'));
const style = JSON.parse(fs.readFileSync(path.join(ENGINE, 'style.json'), 'utf8'));
const W = 1920, H = 1080;
const canvas = createCanvas(W, H);
const stats = new Map();
const WRAP = ['fillRect','fillText','stroke','fill','drawImage','beginPath','arc','moveTo','lineTo','save','restore','measureText','quadraticCurveTo','bezierCurveTo','ellipse','roundRect','clip','isPointInPath'];
function wrapCtx(c) {
  for (const m of WRAP) {
    const orig = c[m];
    if (typeof orig !== 'function') continue;
    c[m] = function (...a) {
      const t = performance.now();
      const r = orig.apply(this, a);
      const d = performance.now() - t;
      const s = stats.get(m) || { n: 0, ms: 0 };
      s.n++; s.ms += d; stats.set(m, s);
      return r;
    };
  }
  return c;
}
const origGet = canvas.getContext.bind(canvas);
canvas.getContext = (t, o) => wrapCtx(origGet(t, o));

const doc = {
  baseURI: pathToFileURL(path.join(ENGINE, 'runtime/index.html')).href,
  currentScript: { src: pathToFileURL(path.join(ENGINE, 'runtime/time-mark.js')).href },
  querySelector: (s) => (s === 'canvas' ? canvas : null),
  createElement: (t) => { if (t === 'canvas') { const cv = createCanvas(1, 1); const g = cv.getContext.bind(cv); cv.getContext = (a, b) => wrapCtx(g(a, b)); return cv; } throw new Error('NO_DOM:' + t); },
  body: { append() {} },
  fonts: { add() {}, ready: Promise.resolve(), check: () => true },
};
class FontFaceShim {
  constructor(f, s) { this.family = f; this.src = s; }
  async load() {
    const m = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(this.src);
    if (m) { const u = m[1]; const p = u.startsWith('file:') ? fileURLToPath(u) : path.resolve(ENGINE, 'runtime', u); GlobalFonts.registerFromPath(p, this.family); }
    return this;
  }
}
globalThis.window = globalThis;
globalThis.document = doc;
globalThis.FontFace = FontFaceShim;
globalThis.Path2D = Path2D; globalThis.ImageData = ImageData;
globalThis.fetch = async (u) => ({ ok: true, async json() { return {}; }, async text() { return ''; } });

for (const rel of ['../graphics/knowledge-icons.js', 'diagrams.js', '../native/native-sketchnote.js', 'presenter-framing.js', 'time-mark.js', 'film.js']) {
  vm.runInThisContext(fs.readFileSync(path.resolve(ENGINE, 'runtime', rel), 'utf8'), { filename: rel });
}
params.timeCorner = { enabled: false };
await window.KnowledgeFilm.initialize({ params, style, width: W, height: H });

await window.KnowledgeFilm.render(3);
stats.clear();
const t0 = performance.now();
await window.KnowledgeFilm.render(3);
await window.KnowledgeFilm.render(3.02);
const total = performance.now() - t0;
console.log('两帧总耗时', total.toFixed(1), 'ms');
const rows = [...stats.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12);
for (const [m, s] of rows) console.log(m.padEnd(16), 'n=' + String(s.n).padStart(7), (s.ms / 2).toFixed(2).padStart(8) + ' ms/帧', (s.ms / s.n).toFixed(3) + ' ms/次');
