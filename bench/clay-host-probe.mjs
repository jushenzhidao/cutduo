// 换宿主探针：在 @napi-rs/canvas 上 boot native-clay.js，跑出一帧
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCanvas, DOMMatrix, DOMPoint, GlobalFonts } from '@napi-rs/canvas';

const PKG = 'refs/vendor/knowledge-explainer-clay/template.motion';
const TMP = '/tmp/clay-probe';
fs.mkdirSync(TMP, { recursive: true });

// 1) 从包里解出 release.bin（内层 ZIP）
const py = `
import zipfile, io, os, sys
zo = zipfile.ZipFile(${JSON.stringify(PKG)})
zi = zipfile.ZipFile(io.BytesIO(zo.read('content/release.bin')))
os.makedirs(${JSON.stringify(TMP)}, exist_ok=True)
zi.extract('native/native-clay.js', ${JSON.stringify(TMP)})
zi.extract('native/examples/recipes.json', ${JSON.stringify(TMP)})
for f in ('fonts/Inter.ttf','fonts/NotoSansSC.ttf'):
    zi.extract(f, ${JSON.stringify(TMP)})
print('extracted')
`;
execFileSync('python3', ['-c', py], { stdio: 'inherit' });

const src = fs.readFileSync(path.join(TMP, 'native/native-clay.js'), 'utf8');
const recipes = JSON.parse(fs.readFileSync(path.join(TMP, 'native/examples/recipes.json'), 'utf8')).recipes;

// 2) 造一个最小的 window/document
const win = {};
win.window = win;
win.location = { href: 'file:///clay/' };
const noop = () => {};
const doc = {
  createElement(tag) {
    if (tag === 'canvas') {
      const c = createCanvas(16, 16);
      return c;
    }
    return { style: {}, appendChild: noop, setAttribute: noop };
  },
  createElementNS: () => ({ style: {} }),
  body: { appendChild: noop, style: {} },
  fonts: {
    ready: Promise.resolve(),
    add: noop,
    [Symbol.iterator]: function* () {},
  },
  currentScript: null,
  baseURI: 'file:///clay/',
};
win.document = doc;
win.URL = URL;
win.Image = class {
  constructor() {
    this.width = 0;
    this.height = 0;
  }
  set src(v) {}
};
win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
win.performance = { now: () => 0 };

// 2.5) 注册字体：Clay 用 ClaySans / ClayKai / Inter，中文靠 NotoSansSC 兜
const FDIR = path.join(TMP, 'fonts');
for (const [file, names] of [
  ['Inter.ttf', ['Inter']],
  ['NotoSansSC.ttf', ['NotoSansSC', 'ClayKai', 'ClaySans']],
]) {
  const fp = path.join(FDIR, file);
  if (!fs.existsSync(fp)) { console.log('  字体缺失:', file); continue; }
  for (const nm of names) {
    try { GlobalFonts.registerFromPath(fp, nm); } catch (e) { console.log('  注册失败', nm, e.message.slice(0, 60)); }
  }
}
console.log('已注册字体:', GlobalFonts.families.filter(f => /Inter|Clay|Noto/i.test(f.family)).map(f => f.family).join(', '));

// 3) 加载
let bootErr = null;
try {
  new Function('window', 'document', 'location', 'URL', 'Image', 'requestAnimationFrame', 'performance', 'DOMMatrix', 'DOMPoint', src)(
    win, doc, win.location, URL, win.Image, win.requestAnimationFrame, win.performance, DOMMatrix, DOMPoint
  );
} catch (e) {
  bootErr = e;
}
const NC = win.NativeClay;
console.log('boot:', bootErr ? '✗ ' + bootErr.message.slice(0, 160) : '✓');
if (!NC) process.exit(1);
console.log('version:', NC.version, '| 导出:', Object.keys(NC).join(', '));
console.log('families:', Array.isArray(NC.catalog) ? NC.catalog.length : typeof NC.catalog);

// 4) 画
const W = 1920, H = 1080;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
const r = recipes.find((x) => x.mechanism === 'split-merge') || recipes[0];
console.log('recipe:', r.mechanism, '|', r.title);

for (const t of [1, 4, 7]) {
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  let err = null;
  try {
    NC.draw(ctx, r, t, { x: 0, y: 0, width: W, height: H });
  } catch (e) {
    err = e;
  }
  ctx.restore();
  if (err) {
    console.log(`  t=${t}s ✗ ${err.message.slice(0, 200)}`);
    break;
  }
  const out = `/tmp/clay-t${t}.png`;
  fs.writeFileSync(out, canvas.toBuffer('image/png'));
  console.log(`  t=${t}s ✓ ${out}  ${(fs.statSync(out).size / 1024).toFixed(0)}KB`);
}
