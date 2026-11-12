// knowledge-explainer-sketchnote 的 Skia 宿主（@napi-rs/canvas）。
//
// 模板的运行时是纯 Canvas2D：runtime/index.html 只挂一个 <canvas>，
// 渲染全在 film.js + native-sketchnote.js + diagrams.js。DOM 依赖只有
// querySelector('canvas') / createElement('canvas') / document.fonts / baseURI / currentScript。
//
// 三个宿主级修正（不改模板源码）：
//   ① 拆掉 @napi-rs/canvas 的 Chrome 参数个数 wrapper（每帧上万次绘制，占 34%）
//   ② getTransform 结果缓存成普通对象（模板每次绘制都 project()，占 63%）
//   ③ 字重吸附到已注册 face（Skia 不做合成粗体，请求 700 会整体 fallback 到系统黑体）
// 可选：noLedger 跳过模板的 instrument()（占 55% 帧时间，代价是失去 audit/碰撞检测）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCanvas, GlobalFonts, Path2D, ImageData, DOMMatrix, DOMPoint, DOMRect } from '@napi-rs/canvas';

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

export async function createHost({ engine, params, style, width, height, noLedger = false, cacheBg = false, onFont }) {
  const canvas = createCanvas(width, height);

  function wrapCtx(c) {
    if (!c || c.__fontPatched) return c;
    if (noLedger) c.__knowledgeInstrumented = true;

    // ① 原生方法直连
    const CTX = Object.getPrototypeOf(c);
    const nativeSym = Object.getOwnPropertySymbols(CTX).find((s) => {
      const v = CTX[s];
      return v && typeof v === 'object' && !Array.isArray(v);
    });
    if (nativeSym) {
      const stash = CTX[nativeSym];
      for (const k of Object.keys(stash)) if (typeof stash[k] === 'function') c[k] = stash[k];
    }

    // ② getTransform 缓存
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

    // ③ 字重吸附
    const proto = Object.getPrototypeOf(c);
    const d = Object.getOwnPropertyDescriptor(proto, 'font');
    if (d && d.set) {
      let last = '';
      Object.defineProperty(c, 'font', {
        configurable: true,
        get: () => last,
        set: (v) => { last = v; d.set.call(c, normFont(v)); },
      });
    }
    c.__fontPatched = true;
    return c;
  }

  function wrapCanvas(cv) {
    const orig = cv.getContext.bind(cv);
    cv.getContext = (type, opts) => wrapCtx(orig(type, opts));
    return cv;
  }
  wrapCanvas(canvas);

  // ── DOM shim ───────────────────────────────────────────────────────────────
  const INDEX = path.join(engine, 'runtime/index.html');
  const DOC_BASE = pathToFileURL(INDEX).href;

  class FontFaceShim {
    constructor(family, src, descriptors = {}) {
      this.family = family; this.src = String(src); this.descriptors = descriptors; this.status = 'unloaded';
      this._file = null;
      const m = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(this.src);
      if (m) {
        const u = m[1];
        this._file = u.startsWith('file:') ? fileURLToPath(u) : path.resolve(engine, 'runtime', u);
      }
    }
    async load() {
      if (this._file) {
        if (!fs.existsSync(this._file)) throw new Error('FONT_MISSING: ' + this._file);
        const ok = GlobalFonts.registerFromPath(this._file, this.family);
        if (!ok) throw new Error('FONT_REGISTER_FAILED: ' + this._file);
        onFont?.(this.family, this._file);
      }
      this.status = 'loaded';
      return this;
    }
  }

  const documentShim = {
    baseURI: DOC_BASE,
    title: '',
    currentScript: { src: pathToFileURL(path.join(engine, 'runtime/time-mark.js')).href },
    querySelector: (sel) => (sel === 'canvas' ? canvas : null),
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement(tag) {
      if (tag === 'canvas') return wrapCanvas(createCanvas(1, 1));
      throw new Error('NO_DOM_ELEMENT: ' + tag);
    },
    body: { append() {}, appendChild() {}, removeChild() {} },
    fonts: { add() {}, ready: Promise.resolve(), status: 'loaded', check: () => true, load: () => Promise.resolve([]) },
  };

  class ImageShim {
    constructor() { this.naturalWidth = 0; this.naturalHeight = 0; this.width = 0; this.height = 0; }
    set src(v) {
      this._src = v;
      this._ready = (async () => {
        const { loadImage } = await import('@napi-rs/canvas');
        const p = String(v).startsWith('file:') ? fileURLToPath(String(v)) : path.resolve(engine, String(v));
        const img = await loadImage(p);
        this._img = img; this.naturalWidth = this.width = img.width; this.naturalHeight = this.height = img.height;
      })();
    }
    get src() { return this._src; }
    async decode() { await this._ready; }
  }

  const fetchShim = async (input) => {
    const u = typeof input === 'string' ? input : input.url;
    const p = String(u).startsWith('file:') ? fileURLToPath(String(u)) : path.resolve(engine, 'runtime', String(u));
    if (!fs.existsSync(p)) {
      return { ok: false, status: 404, async text() { return ''; }, async json() { throw new Error('404 ' + p); } };
    }
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
  globalThis.devicePixelRatio = 1;
  if (!globalThis.requestAnimationFrame) {
    globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 0);
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  }

  for (const rel of ['../graphics/knowledge-icons.js', 'diagrams.js', '../native/native-sketchnote.js',
    'presenter-framing.js', 'time-mark.js', 'film.js']) {
    const p = path.resolve(engine, 'runtime', rel);
    vm.runInThisContext(fs.readFileSync(p, 'utf8'), { filename: p });
  }

  const film = window.KnowledgeFilm;
  if (!film) throw new Error('KnowledgeFilm 未挂载');

  // ④ 背景层缓存：drawBackground 是纯静态点阵（每帧 ~7000 次 arc+fill），
  //    而且这些调用同样会被 instrument() 逐条记账。缓存成位图后每帧只剩 1 次 drawImage。
  if (cacheBg) {
    const native = globalThis.NativeSketchnote;
    if (native && typeof native.drawBackground === 'function') {
      const orig = native.drawBackground.bind(native);
      let cv = null, key = '';
      native.drawBackground = (g, b) => {
        const k = `${b.x},${b.y},${b.width},${b.height}`;
        if (key !== k || !cv) {
          cv = createCanvas(Math.ceil(b.width), Math.ceil(b.height));
          orig(cv.getContext('2d'), { x: 0, y: 0, width: b.width, height: b.height });
          key = k;
        }
        g.drawImage(cv, b.x, b.y, b.width, b.height);
      };
    }
  }

  await film.initialize({ params, style, width, height });
  return { canvas, ctx: canvas.getContext('2d'), film, render: (t) => film.render(t) };
}
