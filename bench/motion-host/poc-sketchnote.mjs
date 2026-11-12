// knowledge-explainer-sketchnote 换宿主 PoC：用 Skia（@napi-rs/canvas）跑模板自带的 Canvas2D 引擎
//
//   node bench/motion-host/poc-sketchnote.mjs                 # 渲染 4 个时间点 + 测速
//   node bench/motion-host/poc-sketchnote.mjs --bench 240     # 连续渲染 240 帧测单核成本
//   node bench/motion-host/poc-sketchnote.mjs --shot 3.2      # 只出某个时间点
//
// 模板结构：runtime/index.html 只挂一个 <canvas>，渲染全在 film.js + native-sketchnote.js（纯 Canvas2D）。
// DOM 依赖只有 querySelector('canvas') / createElement('canvas') / document.fonts / baseURI / currentScript，
// 全部可 shim；没有 div、没有 CSS 布局、没有 iframe（除非启用 sourcePerformance 绑定）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCanvas, GlobalFonts, Path2D, ImageData, DOMMatrix, DOMPoint, DOMRect } from '@napi-rs/canvas';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const TPL = path.join(REPO, 'templates/vendor/knowledge-explainer-sketchnote');
const ENGINE = path.join(TPL, 'package/content/engine');

if (!fs.existsSync(path.join(ENGINE, 'runtime/film.js'))) {
  console.error(`引擎不存在：${ENGINE}\n先解包 template.motion 的 content/release.bin`);
  process.exit(1);
}

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes('--' + k);

const paramsFile = arg('params', path.join(ENGINE, 'presets/demo.json'));
const params = JSON.parse(fs.readFileSync(paramsFile, 'utf8'));
const style = JSON.parse(fs.readFileSync(path.join(ENGINE, 'style.json'), 'utf8'));

const W = Number(arg('width', params.layout === 'portrait' ? 1080 : 1920));
const H = Number(arg('height', params.layout === 'portrait' ? 1920 : 1080));
const FPS = Number(arg('fps', params.fps || 60));

const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d', { willReadFrequently: true });

// Skia 不做字重合成：家族只有 500 的 face 时，请求 700 会整体 fallback 到系统黑体
// （表现为标题变黑体、measure 与 draw 不一致导致右侧裁字）。这里把字重吸附到已注册的 face。
const WEIGHTS = { 'SK-Kai': [500], 'SK-Brush': [400], 'SK-Num': [400], 'SK-Mono': [400] };
const normFont = (f) => {
  const m = /^(?:(italic|oblique)\s+)?(\d{3})\s+([\d.]+px)\s+(.+)$/.exec(String(f).trim());
  if (!m) return f;
  const [, style, weight, size, family] = m;
  const fam = family.trim().replace(/^["']|["']$/g, '');
  const avail = WEIGHTS[fam];
  if (!avail) return f;
  const w = Number(weight);
  if (avail.includes(w)) return f;
  const near = avail.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));
  return `${style ? style + ' ' : ''}${near} ${size} ${family}`.trim();
};
function wrapCtx(c) {
  if (!c || c.__fontPatched) return c;
  if (process.argv.includes('--no-ledger')) c.__knowledgeInstrumented = true;
  // ① 拆掉 @napi-rs/canvas 的 Chrome 参数个数检查 wrapper：每帧上万次绘制调用，
  //    这层 JS wrapper 占 34% 帧时间。直接拿到原生方法绑回实例（参数由模板保证正确）。
  const CTX = Object.getPrototypeOf(c);
  const nativeSym = Object.getOwnPropertySymbols(CTX).find((s) => {
    const v = CTX[s];
    return v && typeof v === 'object' && !Array.isArray(v);
  });
  if (nativeSym) {
    const stash = CTX[nativeSym];
    let n = 0;
    for (const k of Object.keys(stash)) {
      if (typeof stash[k] === 'function') { c[k] = stash[k]; n++; }
    }
    if (n) c.__nativeMethods = n;
  }
  // ② getTransform 缓存：模板的 instrument 把每个绘制调用都包一层 project()，
  //    每帧上万次 ctx.getTransform()。@napi-rs/canvas 每次都新建 DOMMatrix（占 63% 帧时间）。
  //    这里缓存成普通对象 {a..f}，仅在 transform 变更后重取。
  const gt = c.getTransform;
  if (typeof gt === 'function') {
    const cache = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    let dirty = true;
    const refresh = () => {
      const m = gt.call(c);
      cache.a = m.a; cache.b = m.b; cache.c = m.c; cache.d = m.d; cache.e = m.e; cache.f = m.f;
      dirty = false;
    };
    c.getTransform = function () { if (dirty) refresh(); return cache; };
    for (const name of ['setTransform', 'translate', 'rotate', 'scale', 'transform', 'resetTransform', 'restore']) {
      const orig = c[name];
      if (typeof orig !== 'function') continue;
      c[name] = function (...a) { const r = orig.apply(this, a); dirty = true; return r; };
    }
  }
  // ② 字重归一化
  const proto = Object.getPrototypeOf(c);
  const d = Object.getOwnPropertyDescriptor(proto, 'font');
  if (!d || !d.set) return c;
  let last = '';
  Object.defineProperty(c, 'font', {
    configurable: true,
    get: () => last,
    set: (v) => { last = v; (globalThis.__fontLog ||= new Set()).add(String(v)); d.set.call(c, normFont(v)); },
  });
  c.__fontPatched = true;
  return c;
}
function wrapCanvas(cv) {
  const orig = cv.getContext.bind(cv);
  cv.getContext = (type, opts) => wrapCtx(orig(type, opts));
  return cv;
}
wrapCanvas(canvas);
// --no-ledger：跳过模板的 instrument()（每次绘制都记 ledger，单核占 ~55% 帧时间）
// 代价是失去 F.audit() 与 presenter 碰撞检测，画面不变。


// ── 宿主 shim ────────────────────────────────────────────────────────────────
const INDEX = path.join(ENGINE, 'runtime/index.html');
const DOC_BASE = pathToFileURL(INDEX).href;
const SCRIPT_SRC = pathToFileURL(path.join(ENGINE, 'runtime/time-mark.js')).href;

const fontsAdded = [];
class FontFaceShim {
  constructor(family, src, descriptors = {}) {
    this.family = family; this.src = String(src); this.descriptors = descriptors; this.status = 'unloaded';
  }
  async load() {
    const m = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(this.src);
    if (m) {
      const u = m[1];
      const p = u.startsWith('file:') ? fileURLToPath(u) : path.resolve(ENGINE, 'runtime', u);
      if (!fs.existsSync(p)) throw new Error('FONT_MISSING: ' + p);
      const ok = GlobalFonts.registerFromPath(p, this.family);
      if (!ok) throw new Error('FONT_REGISTER_FAILED: ' + p);
    }
    this.status = 'loaded';
    return this;
  }
}

const documentShim = {
  baseURI: DOC_BASE,
  title: '',
  currentScript: { src: SCRIPT_SRC },
  querySelector(sel) { return sel === 'canvas' ? canvas : null; },
  querySelectorAll() { return []; },
  getElementById() { return null; },
  createElement(tag) {
    if (tag === 'canvas') return wrapCanvas(createCanvas(1, 1));
    throw new Error('NO_DOM_ELEMENT: ' + tag);
  },
  body: { append() {}, appendChild() {}, removeChild() {} },
  fonts: {
    add(f) { fontsAdded.push(f && f.family); },
    ready: Promise.resolve(),
    status: 'loaded',
    check: () => true,
    load: () => Promise.resolve([]),
  },
};

class ImageShim {
  constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0; }
  set src(v) {
    this._src = v;
    this._ready = (async () => {
      const { loadImage } = await import('@napi-rs/canvas');
      const p = String(v).startsWith('file:') ? fileURLToPath(String(v)) : path.resolve(ENGINE, String(v));
      const img = await loadImage(p);
      this._img = img; this.naturalWidth = this.width = img.width; this.naturalHeight = this.height = img.height;
    })();
  }
  get src() { return this._src; }
  async decode() { await this._ready; }
}

const fetchShim = async (input) => {
  const u = typeof input === 'string' ? input : input.url;
  const p = String(u).startsWith('file:') ? fileURLToPath(String(u)) : path.resolve(ENGINE, 'runtime', String(u));
  if (!fs.existsSync(p)) return { ok: false, status: 404, async text() { return ''; }, async json() { throw new Error('404 ' + p); } };
  const buf = fs.readFileSync(p);
  return {
    ok: true, status: 200, headers: { get: () => null },
    async text() { return buf.toString('utf8'); },
    async json() { return JSON.parse(buf.toString('utf8')); },
    async arrayBuffer() { return buf; },
  };
};

globalThis.window = globalThis;
globalThis.document = documentShim;
globalThis.FontFace = FontFaceShim;
globalThis.Image = ImageShim;
globalThis.Path2D = Path2D;
globalThis.ImageData = ImageData;
globalThis.DOMMatrix = DOMMatrix;
globalThis.DOMPoint = DOMPoint;
globalThis.DOMRect = DOMRect;
globalThis.fetch = fetchShim;
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'skia-host' }, configurable: true }); } catch { /* Node 自带 navigator 只读，忽略 */ }
globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

// ── 按 index.html 的顺序加载脚本（普通 script，非 module） ─────────────────────
const SCRIPTS = [
  '../graphics/knowledge-icons.js',
  'diagrams.js',
  '../native/native-sketchnote.js',
  'presenter-framing.js',
  'time-mark.js',
  'film.js',
];
for (const rel of SCRIPTS) {
  const p = path.resolve(ENGINE, 'runtime', rel);
  const code = fs.readFileSync(p, 'utf8');
  try {
    vm.runInThisContext(code, { filename: p });
  } catch (e) {
    console.error('脚本加载失败:', rel, e.message);
    throw e;
  }
}
console.log('脚本加载完成，字体注册:', fontsAdded);

const KF = window.KnowledgeFilm;
if (!KF) { console.error('KnowledgeFilm 未挂载'); process.exit(1); }

// 关掉角落时间标（需要品牌 webm），避免拉媒体
params.timeCorner = { ...(params.timeCorner || {}), enabled: false };

const t0 = performance.now();
const ready = await KF.initialize({ params, style, width: W, height: H });
console.log(`initialize ${(performance.now() - t0).toFixed(0)} ms →`, JSON.stringify(ready));
console.log(`FILM ${W}x${H}@${FPS} / duration ${KF.settings.duration}s / ${KF.settings.segments.length} 段`);

// ── 出几张静帧 ──────────────────────────────────────────────────────────────
const outDir = path.join(HERE, 'out');
fs.mkdirSync(outDir, { recursive: true });
const dur = KF.settings.duration;
const shots = has('shot') ? [Number(arg('shot', 1))] : [0.4, dur * 0.3, dur * 0.6, dur - 0.2];
for (const t of shots) {
  await KF.render(Math.max(0, Math.min(dur - 1e-3, t)));
  const p = path.join(outDir, `sketchnote-${String(t).replace('.', '_')}.png`);
  fs.writeFileSync(p, canvas.toBuffer('image/png'));
  console.log('wrote', p);
}

console.log('font 设置值样本:', [...(globalThis.__fontLog||[])].slice(0,25));

// ── 测速 ────────────────────────────────────────────────────────────────────
if (has('bench')) {
  const N = Number(arg('bench', 180));
  const frames = [];
  for (let i = 0; i < N; i++) frames.push(0.2 + (i / N) * (dur - 0.4));
  await KF.render(frames[0]); // 预热
  const b0 = performance.now();
  for (const t of frames) await KF.render(t);
  const ms = (performance.now() - b0) / N;
  console.log(`单帧 ${ms.toFixed(2)} ms → 单核 ${(1000 / ms).toFixed(0)} fps（${N} 帧 / ${((performance.now() - b0) / 1000).toFixed(2)}s）`);
}

// ── 无状态检查（分片并行的前提） ────────────────────────────────────────────
if (has('check')) {
  const t = Math.min(2.0, dur - 0.5);
  await KF.render(t);
  const a = canvas.toBuffer('image/png');
  await KF.render(t + 1.2);
  await KF.render(dur - 0.2);
  await KF.render(t);
  const b = canvas.toBuffer('image/png');
  console.log(`无状态检查：${a.equals(b) ? 'PASS（逐字节一致）' : `FAIL（${a.length} vs ${b.length} 字节）`}`);
}
