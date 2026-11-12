// film-kit 模板「换宿主」PoC：把 .motion 包的镜头代码直接跑在 @napi-rs/canvas 上（无浏览器）
//
//   node bench/motion-host/poc.mjs               # 默认渲染 comments 镜头三帧
//   node bench/motion-host/poc.mjs counter 1.0   # 指定镜头与时间
//
// 流程：解包 release.bin → 补 data/film.js → shim window/document → 注册中文字体别名 → 调镜头 draw()
//
// 为什么可行：模板的镜头是纯 Canvas2D（draw(c, t) 时间驱动，无 DOM），
// @napi-rs/canvas 提供同一套 API，所以不需要「蒸馏」重写，只需换宿主。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.resolve(HERE, '../..');
const PKG = path.join(REPO, 'templates/vendor/mac-desktop/package/content/release.bin');

const shotName = process.argv[2] || 'comments';
const at = Number(process.argv[3] || 1.2);

if (!fs.existsSync(PKG)) {
  console.error(`模板包不存在：${PKG}\n（templates/vendor 不入库，需本地下载）`);
  process.exit(1);
}

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-host-'));
execFileSync('unzip', ['-q', PKG, '-d', OUT], { stdio: 'inherit' });
const ENGINE = path.join(OUT, 'engine');

// ① 模板缺 data/film.js（由宿主生成）。这里给一份最小时间轴，够单镜头渲染。
fs.mkdirSync(path.join(ENGINE, 'data'), { recursive: true });
fs.writeFileSync(path.join(ENGINE, 'data', 'film.js'), `export const FILM = {
  fps: 60, width: 1440, height: 1080, end: 4, talkEnd: 4,
  ins: [], beats: [], globals: {}, presenter: { mode: 'video' },
  shots: [{ i: 0, type: '${shotName}', layer: 'main', t0: 0, t1: 3, beats: { wow: 0.55 },
            props: { name: '评论', label: '真实评论 · 示例', images: [] } }],
  custom: [],
};\n`);

// ② 模板在浏览器里跑，需要 window / document
globalThis.window = globalThis;
globalThis.window.FILMKIT = { version: 1, warnings: [] };
globalThis.document = {
  fonts: { add() {}, ready: Promise.resolve() },
  createElement: (t) => (t === 'canvas' ? createCanvas(1, 1) : {}),
  title: '',
};

// ③ 关键坑：模板 FAM.zh 首选 "PingFang SC"，而 Skia 不做族名回退。
//    模板自带的 Geist 是 woff2（@napi-rs/canvas 不吃），中文必须显式注册别名。
const CJK_DIR = path.join(REPO, 'assets/fonts');
for (const [file, alias] of [
  ['NotoSansSC-Medium.otf', 'PingFang SC'],
  ['NotoSansSC-Black.otf', 'PingFang SC Black'],
]) {
  const ok = GlobalFonts.registerFromPath(path.join(CJK_DIR, file), alias);
  if (!ok) console.warn(`字体别名注册失败：${file} -> ${alias}`);
}

// ④ 加载镜头模块并渲染
const mod = await import(pathToFileURL(path.join(ENGINE, 'shots', `${shotName}.js`)).href);
const make = mod.default;

// 每个镜头的 props 契约不同，但模板自带 meta.example.props 与 schema 默认值——
// 按「schema 默认 ← example 覆盖」拼出合法参数，否则只有窗口壳没有内容。
const schema = mod.meta?.props || {};
const defaults = {};
for (const [k, v] of Object.entries(schema)) {
  if (v && typeof v === 'object' && 'default' in v) defaults[k] = v.default;
  else if (v && typeof v === 'object' && v.type === 'array') defaults[k] = [];
  else if (v && typeof v === 'object' && v.type === 'string') defaults[k] = '';
}
const props = { ...defaults, ...(mod.meta?.example?.props || {}) };
console.log('props:', JSON.stringify(props).slice(0, 160));

const S = {
  i: 0, type: shotName, layer: 'main', t0: 0, t1: 3,
  beats: mod.meta?.beats || { wow: 0.55 },
  props,
};

const W = 1440, H = 1080;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext('2d');
const sc = make(S);

// 宿主职责（正式产线里由 desktop-kit 的壁纸层承担）：这里只铺一层底色
const bg = sc.wall === 'paper' ? '#E8E3D6' : '#0C183E';

for (const t of [at - 0.9, at, at + 1.2].map((x) => Math.max(0.05, +x.toFixed(2)))) {
  ctx.save();
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  sc.draw(ctx, t);
  ctx.restore();
  const out = path.join(HERE, 'out', `${shotName}-${String(t).replace('.', '_')}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, canvas.toBuffer('image/png'));
  console.log('wrote', out);
}

console.log('warnings:', JSON.stringify(window.FILMKIT.warnings));
fs.rmSync(OUT, { recursive: true, force: true });
